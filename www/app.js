const FOOT_ROUTER="/api/foot";
const CAR_ROUTER="/api/car";
const OVERPASS="/api/overpass";
const ELEVATION="/api/elevation";
const LANDCOVER="/api/landcover";
const ROUTER_DELAY_MS=1100;
const APP_VERSION="0.21.0";
const DATA_VERSION=1;
const DEFAULT_APP_SETTINGS={
  radius:10,
  maxGap:15,
  maxTime:240,
  speed:4.5,
  stopTime:5,
  minCaches:0
};

const state = {
  caches: [],
  gpxImportStats:{waypoints:0,caches:0,ignoredWaypoints:0},
  profile: {gcUsername:"",csUsername:"",profileUrl:"https://www.geocaching.com/p/default.aspx?guid=363b1243-156e-4600-ade9-81c58d8b57b4"},
  pendingLogs:[],
  savedTours:[],
  activeTour:null,
  tripOrigin:null,
  savedTrips:[],
  currentTripPlan:null,
  tripCandidatePool:[],
  lodgingCandidates:[],
  selectedLodging:null,
  googlePlaces:{enabled:false,key:""},
  appSettings:{...DEFAULT_APP_SETTINGS},
  searchLocation:null,
  originExplicit: false,
  cacheCentroid: null,
  routes: [],
  selectedRoute: null,
  routeEditBusy:false,
  parkingPickLockSequence:false,
  mapPlanner:{active:false,selectedIds:new Set(),sourceRoute:null},
  map: null,
  layers: {caches:null, route:null},
  deferredPrompt: null
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function haversine(a,b){
  const R=6371, toR=x=>x*Math.PI/180;
  const dLat=toR(b.lat-a.lat), dLon=toR(b.lon-a.lon);
  const la1=toR(a.lat), la2=toR(b.lat);
  const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

function normalizeType(raw=""){
  const s=raw.toLowerCase();
  if(s.includes("multi")) return "Multi";
  if(s.includes("unknown")||s.includes("mystery")||s.includes("puzzle")) return "Mystery";
  if(s.includes("traditional")) return "Traditional";
  return raw || "Unknown";
}

function xmlText(el, selector){
  const n=el.querySelector(selector);
  return n ? n.textContent.trim() : "";
}

function parseGPX(text){
  const xml=new DOMParser().parseFromString(text,"application/xml");
  const allWpts=[...xml.querySelectorAll("wpt")];

  function directCacheNode(w){
    // Only true cache waypoints contain a Groundspeak <cache> child.
    // Parking, trailhead, reference and stage waypoints are auxiliary and
    // intentionally excluded from round planning.
    return [...w.children].find(el=>el.localName==="cache") || null;
  }

  function childTextByLocalName(root,name){
    if(!root)return "";
    const n=[...root.children].find(el=>el.localName===name);
    return n?n.textContent.trim():"";
  }

  const cacheWpts=allWpts.filter(w=>!!directCacheNode(w));
  state.gpxImportStats={
    waypoints:allWpts.length,
    caches:cacheWpts.length,
    ignoredWaypoints:Math.max(0,allWpts.length-cacheWpts.length)
  };

  return cacheWpts.map((w,i)=>{
    const lat=parseFloat(w.getAttribute("lat"));
    const lon=parseFloat(w.getAttribute("lon"));
    const name=xmlText(w,"name")||`GC-${i+1}`;
    const sym=xmlText(w,"sym");
    const cacheNode=directCacheNode(w);

    const cacheTypeRaw=childTextByLocalName(cacheNode,"type");
    const type=normalizeType(cacheTypeRaw);

    const correctedTags=["corrected","final","corrected_coordinates","final_coordinates"];
    const corrected=correctedTags.some(t=>
      [...w.getElementsByTagNameNS("*",t)].some(n=>/true|1|yes/i.test(n.textContent))
    );

    const explicitFound=[...w.getElementsByTagNameNS("*","found")]
      .some(n=>/true|1|yes/i.test(n.textContent));
    const found=explicitFound || /geocache found/i.test(sym);

    const ele=parseFloat(xmlText(w,"ele"));
    const difficulty=parseFloat(childTextByLocalName(cacheNode,"difficulty"));
    const terrain=parseFloat(childTextByLocalName(cacheNode,"terrain"));
    const cacheName=childTextByLocalName(cacheNode,"name") || xmlText(w,"desc") || name;

    const logs=[...w.getElementsByTagNameNS("*","log")].map(log=>{
      const finder=[...log.getElementsByTagNameNS("*","finder")][0]?.textContent?.trim()||"";
      const logType=[...log.getElementsByTagNameNS("*","type")][0]?.textContent?.trim()||"";
      const date=[...log.getElementsByTagNameNS("*","date")][0]?.textContent?.trim()||"";
      return {finder,type:logType,date};
    });

    return {
      id:name,
      name:cacheName,
      lat,lon,
      type,
      rawCacheType:cacheTypeRaw || "(kein Cachetyp erkannt)",
      found,
      corrected,
      logs,
      ele:Number.isFinite(ele)?ele:null,
      difficulty:Number.isFinite(difficulty)?difficulty:null,
      terrain:Number.isFinite(terrain)?terrain:null
    };
  }).filter(c=>Number.isFinite(c.lat)&&Number.isFinite(c.lon));
}

function parseLogDate(value){
  const d=value?new Date(value):null;
  return d && Number.isFinite(d.getTime())?d:null;
}

function cacheHealth(cache){
  const logs=Array.isArray(cache.logs)?cache.logs:[];
  let lastFound=null,lastDnf=null;
  for(const log of logs){
    const d=parseLogDate(log.date);
    const t=(log.type||"").toLowerCase();
    if(!d)continue;
    if(t.includes("found it")){
      if(!lastFound || d>lastFound)lastFound=d;
    }
    if(t.includes("didn't find") || t.includes("did not find") || t==="dnf"){
      if(!lastDnf || d>lastDnf)lastDnf=d;
    }
  }

  const unresolvedDnf=!!lastDnf && (!lastFound || lastDnf>lastFound);
  const ageDays=lastFound?Math.floor((Date.now()-lastFound.getTime())/86400000):null;
  const staleFound=ageDays!=null && ageDays>=60;
  const reasons=[];

  if(unresolvedDnf){
    reasons.push(`DNF vom ${lastDnf.toLocaleDateString("de-DE")}`);
  }
  if(staleFound){
    reasons.push(`letzter Found-Log vor ${ageDays} Tagen`);
  }

  return {
    warn:reasons.length>0,
    unresolvedDnf,
    staleFound,
    reasons,
    lastFound,
    lastDnf,
    ageDays
  };
}

function routeHealthWarnings(route){
  const seq=route.real?.finalSequence || cacheSequence(route);
  const seen=new Set();
  return seq.filter(c=>{
    if(seen.has(c.id))return false;
    seen.add(c.id);
    return cacheHealth(c).warn;
  }).map(c=>({cache:c,health:cacheHealth(c)}));
}

function routeHealthHtml(route){
  const warnings=routeHealthWarnings(route);
  if(!warnings.length)return "";
  const items=warnings.slice(0,5).map(x=>
    `${escapeHtml(x.cache.id)}: ${x.health.reasons.map(escapeHtml).join(" · ")}`
  );
  const more=warnings.length>5?` · +${warnings.length-5} weitere`:"";
  return `<div class="route-health-box"><strong>⚠ ${warnings.length} Cache(s) mit Hinweis</strong>${items.join("<br>")}${more}</div>`;
}

function filteredCaches(opts){
  const start=opts.start;
  return state.caches.filter(c=>{
    if(haversine(start,c)>opts.radius) return false;
    if(opts.excludeFound && c.found) return false;
    if(c.type==="Traditional" && !opts.tradis) return false;
    if(c.type==="Multi" && !opts.multis) return false;
    if(c.type==="Mystery" && (!opts.mysteries || !c.corrected)) return false;
    if(c.type==="Lab" && opts.labs===false) return false;
    if(!["Traditional","Mystery","Multi","Lab"].includes(c.type)) return false;
    return true;
  });
}

function routeStats(points, opts){
  let km=0, gain=0, loss=0;
  for(let i=1;i<points.length;i++){
    const direct=haversine(points[i-1],points[i]);
    km += direct*1.15; // prototype trail factor
    const e1=points[i-1].ele, e2=points[i].ele;
    if(Number.isFinite(e1)&&Number.isFinite(e2)){
      const d=e2-e1; if(d>0) gain+=d; else loss+=Math.abs(d);
    }
  }
  const cachePoints=points.filter(p=>p && p.id);
  const uniqueCacheIds=new Set(cachePoints.map(p=>p.id));
  const cacheCount=uniqueCacheIds.size;
  const walkMin=km/opts.speed*60;
  const totalMin=walkMin + cacheCount*opts.stopTime;
  return {km,gain,loss,cacheCount,walkMin,totalMin};
}

function cacheTravelMinutes(a,b,opts){
  return haversine(a,b)*1.15/opts.speed*60;
}

function buildGraph(candidates,opts){
  const graph=new Map(candidates.map(c=>[c,[]]));
  let edges=0;
  for(let i=0;i<candidates.length;i++){
    for(let j=i+1;j<candidates.length;j++){
      const min=cacheTravelMinutes(candidates[i],candidates[j],opts);
      if(min<=opts.maxGap){
        graph.get(candidates[i]).push({c:candidates[j],min});
        graph.get(candidates[j]).push({c:candidates[i],min});
        edges++;
      }
    }
  }
  return {graph,edges};
}

function connectedComponents(candidates,graph){
  const seen=new Set(), comps=[];
  for(const start of candidates){
    if(seen.has(start)) continue;
    const comp=[], stack=[start]; seen.add(start);
    while(stack.length){
      const cur=stack.pop(); comp.push(cur);
      for(const n of graph.get(cur)||[]){
        if(!seen.has(n.c)){seen.add(n.c);stack.push(n.c);}
      }
    }
    comps.push(comp);
  }
  return comps.sort((a,b)=>b.length-a.length);
}

function makeRouteFromSeed(seed,component,graph,opts,variant=0){
  const componentSet=new Set(component);
  const path=[seed];
  const used=new Set([seed]);
  let current=seed;

  while(true){
    const choices=(graph.get(current)||[])
      .filter(x=>componentSet.has(x.c) && !used.has(x.c))
      .map(x=>{
        const onward=(graph.get(x.c)||[]).filter(n=>componentSet.has(n.c) && !used.has(n.c)).length;
        return {...x,onward};
      })
      .sort((a,b)=>{
        const sa=a.min-a.onward*0.35;
        const sb=b.min-b.onward*0.35;
        return sa-sb;
      });

    if(!choices.length)break;

    const pick=choices[Math.min(variant%Math.min(4,choices.length),choices.length-1)].c;

    // Preliminary planning is an OPEN cache chain. The return to parking is
    // only added during real routing and does not need to contain more caches.
    const trial=[...path,pick];
    const st=routeStats(trial,opts);
    if(st.totalMin>opts.maxTime)break;

    path.push(pick);
    used.add(pick);
    current=pick;
    if(path.length>=80)break;
  }

  if(path.length<2)return null;

  const stats=routeStats(path,opts);
  if(stats.totalMin>opts.maxTime*1.03)return null;
  return path;
}

/* Zu-Fuß-Modus (seit 0.17.0): kein Parkplatz, Runde beginnt und endet am Ausgangspunkt. */
function isWalkFromStart(opts){return (opts&&opts.parkingMode)==="none";}
function walkStartPoint(opts){
  return {lat:opts.start.lat,lon:opts.start.lon,name:"Dein Standort (zu Fuß)",parkingScore:null,fee:"",capacity:0,walkStart:true};
}

/* "Geeignet" sofort aktualisieren (seit 0.20.3), nicht erst bei der Tourensuche */
function updateSuitableCount(){
  try{
    const opts=getOpts(true);
    if(!Number.isFinite(opts.start.lat))return;
    const all=state.caches||[];
    const inRadius=all.filter(c=>haversine(opts.start,c)<=opts.radius);
    const ok=filteredCaches(opts);
    $("#miniCandidateCount").textContent=ok.length;
    const el=$("#suitableBreakdown");
    if(!el)return;
    if(!all.length){el.textContent="";return;}
    const n=t=>inRadius.filter(t).length;
    const parts=[
      `${inRadius.length} von ${all.length} im Radius ${opts.radius} km`,
      `${n(c=>c.type==="Traditional"&&!c.found)} Traditionals`,
      `${n(c=>c.type==="Mystery"&&c.corrected&&!c.found)} gelöste Mysterys`,
      n(c=>c.type==="Lab")?`${n(c=>c.type==="Lab"&&!c.found)} Lab-Stationen`:null,
      n(c=>c.type==="Mystery"&&!c.corrected)?`${n(c=>c.type==="Mystery"&&!c.corrected)} ungelöste Mysterys ausgelassen`:null,
      n(c=>c.type==="Multi")?`${n(c=>c.type==="Multi")} Multis ${opts.multis?"":"ausgelassen"}`.trim():null,
      n(c=>!["Traditional","Mystery","Multi","Lab"].includes(c.type))?`${n(c=>!["Traditional","Mystery","Multi","Lab"].includes(c.type))} andere Typen ausgelassen`:null,
      n(c=>c.found)?`${n(c=>c.found)} schon gefunden`:null
    ].filter(Boolean);
    el.textContent=parts.join(" · ");
  }catch(e){}
}

function buildRoutes(opts){
  const candidates=filteredCaches(opts);
  $("#miniCandidateCount").textContent=candidates.length;
  const dbg=document.getElementById("searchDebug");
  if(dbg) dbg.textContent=`Geeignet im Radius: ${candidates.length}`;

  const {graph,edges}=buildGraph(candidates,opts);
  const components=connectedComponents(candidates,graph);
  const linkedCandidates=candidates.filter(c=>(graph.get(c)||[]).length>0).length;

  const rawInRadius=state.caches.filter(c=>haversine(opts.start,c)<=opts.radius);
  const typeCounts={};
  const rawTypeCounts={};
  rawInRadius.forEach(c=>{
    typeCounts[c.type]=(typeCounts[c.type]||0)+1;
    rawTypeCounts[c.rawCacheType||"(leer)"]=(rawTypeCounts[c.rawCacheType||"(leer)"]||0)+1;
  });

  const diagnostics = {
    imported: state.caches.length,
    rawInRadius: rawInRadius.length,
    typeCounts,
    rawTypeCounts,
    nearestKm: state.caches.length ? Math.min(...state.caches.map(c=>haversine(opts.start,c))) : null,
    foundExcluded: state.caches.filter(c=>opts.excludeFound && c.found && haversine(opts.start,c)<=opts.radius).length,
    mysteryWithoutFinal: state.caches.filter(c=>c.type==="Mystery" && !c.corrected && haversine(opts.start,c)<=opts.radius).length,
    multiExcluded: state.caches.filter(c=>c.type==="Multi" && !opts.multis && haversine(opts.start,c)<=opts.radius).length,
    candidates: candidates.length,
    linkedCandidates,
    edges,
    components: components.length,
    largestComponent: components[0]?.length||0
  };
  state.lastDiagnostics=diagnostics;

  const routes=[];
  if(candidates.length<2) return routes;

  // Search the largest useful cache clusters first. The search center is NOT included
  // in walking time; it is only used to rank how far the found round is from the user.
  for(const comp of components.filter(c=>c.length>=2).slice(0,20)){
    const seeds=[...comp].sort((a,b)=>haversine(opts.start,a)-haversine(opts.start,b)).slice(0,Math.min(20,comp.length));
    seeds.forEach((seed,seedIndex)=>{
      for(let variant=0;variant<5;variant++){
        const cycle=makeRouteFromSeed(seed,comp,graph,opts,seedIndex+variant);
        if(!cycle) continue;
        const stats=routeStats(cycle,opts);
        const centroid={
          lat:cycle.reduce((s,c)=>s+c.lat,0)/cycle.length,
          lon:cycle.reduce((s,c)=>s+c.lon,0)/cycle.length
        };
        let dist=haversine(opts.start,centroid);
        let walkFromStart=false;
        if(isWalkFromStart(opts)){
          // Hin- und Rückweg vom Standort grob schätzen (Luftlinie × 1,3, beide Richtungen)
          const nearest=Math.min(...cycle.map(c=>haversine(opts.start,c)));
          const accessKm=nearest*1.3*2;
          const accessMin=accessKm/opts.speed*60;
          stats.km=+(stats.km+accessKm).toFixed(2);
          stats.totalMin=Math.round(stats.totalMin+accessMin);
          stats.accessKm=+accessKm.toFixed(2);
          if(stats.totalMin>opts.maxTime*1.05) continue;
          dist=nearest;
          walkFromStart=true;
        }
        routes.push({
          walkFromStart,
          id:`r-${routes.length}-${Date.now()}`,
          name:["Beste Runde","Cache-Kompakt","Wald & Panorama","Feierabendrunde","Höhenrunde"][routes.length%5],
          points:cycle,
          stats,
          startDistance:dist,
          score:Math.round(stats.cacheCount*100/Math.max(1,stats.totalMin))
        });
      }
    });
  }

  const unique=[];
  const sigs=new Set();
  for(const r of routes){
    // preserve direction-independent membership uniqueness for prototype
    const sig=r.points.map(p=>p.id).sort().join("|");
    if(!sigs.has(sig)){sigs.add(sig);unique.push(r);}
  }

  // Candidate selection is quality-first. Distance remains an explicit sort option,
  // but no longer decides which 12 candidates survive the initial search.
  const minCaches=opts.minCaches||0;
  const filteredByCount=minCaches>0 ? unique.filter(r=>(r.stats?.cacheCount||0)>=minCaches) : unique;
  return sortRoutes(filteredByCount,"quality").slice(0,12);
}

function diagnosticsHtml(){
  const d=state.lastDiagnostics||{};
  const tips=[];
  if((d.rawInRadius||0)===0){
    tips.push(`Kein importierter Cache liegt im gewählten Suchradius. Der Suchpunkt liegt vermutlich außerhalb des Cachegebiets. Nutze „Zum Cachegebiet“ oder erhöhe den Radius.`);
  } else if((d.candidates||0)===0){
    if((d.foundExcluded||0)>0) tips.push(`${d.foundExcluded} bereits gefundene Caches wurden ausgeschlossen.`);
    if((d.mysteryWithoutFinal||0)>0) tips.push(`${d.mysteryWithoutFinal} Mysterys haben kein erkanntes Final.`);
    if((d.multiExcluded||0)>0) tips.push(`${d.multiExcluded} Multis sind derzeit ausgeschlossen.`);
  } else if((d.linkedCandidates||0)<3){
    tips.push(`Nur ${d.linkedCandidates||0} geeignete Caches besitzen überhaupt einen weiteren Cache innerhalb von ${$("#maxGap")?.value||15} Minuten.`);
  } else if((d.largestComponent||0)<3){
    tips.push("Es gibt keinen zusammenhängenden Cluster aus mindestens drei geeigneten Caches.");
  } else {
    tips.push(`Größter zusammenhängender Cache-Cluster: ${d.largestComponent} Caches. Es wurde aber keine Route innerhalb der Zeitgrenze aufgebaut.`);
  }
  return `<div class="diag">
    <strong>Suchdiagnose</strong>
    <div>Importiert: ${d.imported||0} · <strong>Im Suchradius vor Filtern: ${d.rawInRadius||0}</strong> · Geeignet danach: ${d.candidates||0}</div>
    <div>Nächster importierter Cache: ${d.nearestKm==null?"—":d.nearestKm.toFixed(1)+" km"} · Erkannte Cachetypen: ${Object.entries(d.typeCounts||{}).map(([k,v])=>`${k}: ${v}`).join(" · ")||"—"}</div>
    <div>Rohwerte aus groundspeak:cache/type: ${Object.entries(d.rawTypeCounts||{}).slice(0,12).map(([k,v])=>`${k}: ${v}`).join(" · ")||"—"}</div>
    <div>Mit 15-Min.-Nachbar: ${d.linkedCandidates||0}</div>
    <div>Verbindungen: ${d.edges||0} · Cluster: ${d.components||0} · größter Cluster: ${d.largestComponent||0}</div>
    <div>Gefunden ausgeschlossen: ${d.foundExcluded||0} · Mystery ohne Final: ${d.mysteryWithoutFinal||0} · Multis ausgeschlossen: ${d.multiExcluded||0}</div>
    ${tips.map(t=>`<div><strong>Hinweis:</strong> ${t}</div>`).join("")}
  </div>`;
}

function getOpts(quick=false){
  const start={lat:parseFloat($("#startLat").value),lon:parseFloat($("#startLon").value),ele:null};
  return quick ? {
    start, radius:+$("#quickRadius").value, maxGap:+$("#quickGap").value, maxTime:+$("#quickMaxTime").value,
    speed:4.5, stopTime:5, excludeFound:true, tradis:true, mysteries:true, multis:false, labs:true,
    minCaches:+($("#quickMinCaches")?.value||0),
    parkingMode:$("#quickParkingMode")?.value||"fallback"
  } : {
    start, radius:+$("#radius").value, maxGap:+$("#maxGap").value, maxTime:+$("#maxTime").value,
    speed:+$("#speed").value, stopTime:+$("#stopTime").value,
    excludeFound:$("#excludeFound").checked, tradis:$("#tradis").checked, labs:$("#labs")?$("#labs").checked:true,
    mysteries:$("#mysteries").checked, multis:$("#multis").checked,
    minCaches:+($("#minCaches")?.value||0),
    parkingMode:$("#parkingMode")?.value||"fallback"
  };
}

function routeCacheRate(route){
  const s=previewStats(route);
  return s.totalMin>0 ? s.cacheCount/(s.totalMin/60) : 0;
}

function routeQualityScore(route){
  const s=previewStats(route);
  const rate=routeCacheRate(route);
  const sizeBonus=Math.sqrt(Math.max(0,s.cacheCount))*5;
  const usefulLength=Math.min(12,Math.max(0,s.km))*0.35;
  const violations=(route.real?.violations ?? route.precheck?.violations ?? 0);
  const overlap=(route.real?.overlapRatio ?? route.precheck?.overlapRatio ?? 0);
  const accessPenalty=route.walkFromStart?Math.max(0,(route.startDistance||0)-0.3)*10:0;
  return rate*10 + sizeBonus + usefulLength - violations*18 - overlap*8 - accessPenalty;
}

function sortRoutes(routes, mode="quality"){
  const r=[...routes];
  if(mode==="quality"){
    r.sort((a,b)=>routeQualityScore(b)-routeQualityScore(a) || routeCacheRate(b)-routeCacheRate(a));
  }else if(mode==="cacheRate"){
    r.sort((a,b)=>routeCacheRate(b)-routeCacheRate(a) || previewStats(b).cacheCount-previewStats(a).cacheCount);
  }else if(mode==="roundSize"){
    r.sort((a,b)=>previewStats(b).cacheCount-previewStats(a).cacheCount || previewStats(b).km-previewStats(a).km);
  }else if(mode==="duration"){
    r.sort((a,b)=>previewStats(a).totalMin-previewStats(b).totalMin);
  }else if(mode==="caches"){
    r.sort((a,b)=>previewStats(b).cacheCount-previewStats(a).cacheCount);
  }else if(mode==="length"){
    r.sort((a,b)=>previewStats(a).km-previewStats(b).km);
  }else if(mode==="elevation"){
    r.sort((a,b)=>previewStats(a).gain-previewStats(b).gain);
  }else{
    r.sort((a,b)=>a.startDistance-b.startDistance);
  }
  return r;
}

function fmtMin(m){ const h=Math.floor(m/60), mm=Math.round(m%60); return h?`${h} h ${String(mm).padStart(2,"0")} min`:`${mm} min`; }


function sleep(ms){return new Promise(r=>setTimeout(r,ms));}


let toastTimer=null;
function showToast(message,type="info",timeout=3200){
  const t=$("#toast");
  if(!t)return;
  clearTimeout(toastTimer);
  t.textContent=message;
  t.className=`toast ${type}`;
  toastTimer=setTimeout(()=>t.classList.add("hidden"),timeout);
}

function safeJsonParse(raw,fallback){
  try{return JSON.parse(raw);}catch(e){return fallback;}
}

function storageSummary(){
  const keys=["cacherunde-saved-tours","cacherunde-saved-trips","cacherunde-pending-logs","cacherunde-active-tour","cacherunde-profile","cacherunde-app-settings"];
  let chars=0;
  keys.forEach(k=>chars+=(localStorage.getItem(k)||"").length);
  return {kb:chars*2/1024};
}

function loadAppSettings(){
  const cfg=safeJsonParse(localStorage.getItem("cacherunde-app-settings"),{});
  state.appSettings={...DEFAULT_APP_SETTINGS,...cfg};
  const map={
    settingsRadius:"radius",settingsMaxGap:"maxGap",settingsMaxTime:"maxTime",
    settingsSpeed:"speed",settingsStopTime:"stopTime",settingsMinCaches:"minCaches"
  };
  Object.entries(map).forEach(([id,key])=>{const el=$("#"+id);if(el)el.value=String(state.appSettings[key]);});
  applySettingsToSearchForms();
}

function applySettingsToSearchForms(){
  const s=state.appSettings;
  const set=(id,v)=>{const el=$("#"+id);if(el)el.value=String(v);};
  set("radius",s.radius);set("quickRadius",s.radius);
  set("maxGap",s.maxGap);set("quickGap",s.maxGap);
  set("maxTime",s.maxTime);set("quickMaxTime",s.maxTime);
  set("speed",s.speed);set("stopTime",s.stopTime);
  set("minCaches",s.minCaches);set("quickMinCaches",s.minCaches);
}

function saveAppSettings(){
  state.appSettings={
    radius:+$("#settingsRadius").value,
    maxGap:+$("#settingsMaxGap").value,
    maxTime:+$("#settingsMaxTime").value,
    speed:+$("#settingsSpeed").value,
    stopTime:+$("#settingsStopTime").value,
    minCaches:+$("#settingsMinCaches").value
  };
  localStorage.setItem("cacherunde-app-settings",JSON.stringify(state.appSettings));
  localStorage.setItem("cacherunde-data-version",String(DATA_VERSION));
  applySettingsToSearchForms();
  $("#settingsStatus").textContent=`Datenformat v${DATA_VERSION} · Standardwerte gespeichert.`;
  showToast("Standardwerte gespeichert.","success");
}

function migrateLocalData(){
  const current=+(localStorage.getItem("cacherunde-data-version")||0);
  if(current<1){
    localStorage.setItem("cacherunde-data-version","1");
  }
}

function buildBackup(){
  return {
    app:"CacheRunde",
    appVersion:APP_VERSION,
    dataVersion:DATA_VERSION,
    exportedAt:new Date().toISOString(),
    profile:safeJsonParse(localStorage.getItem("cacherunde-profile"),{}),
    appSettings:safeJsonParse(localStorage.getItem("cacherunde-app-settings"),DEFAULT_APP_SETTINGS),
    googlePlaces:safeJsonParse(localStorage.getItem("cacherunde-google-places"),{}),
    savedTours:state.savedTours,
    savedTrips:state.savedTrips,
    pendingLogs:state.pendingLogs,
    activeTour:state.activeTour
  };
}

function exportBackup(){
  const text=JSON.stringify(buildBackup(),null,2);
  const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));
  const a=document.createElement("a");
  a.href=url;a.download=`cacherunde-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();
  URL.revokeObjectURL(url);
  showToast("Backup exportiert.","success");
}

async function importBackupFile(file){
  try{
    const data=JSON.parse(await file.text());
    if(data.app!=="CacheRunde")throw new Error("Kein CacheRunde-Backup.");
    if(data.dataVersion>DATA_VERSION)throw new Error("Backup stammt aus einer neueren Datenversion.");
    if(data.profile)localStorage.setItem("cacherunde-profile",JSON.stringify(data.profile));
    if(data.appSettings)localStorage.setItem("cacherunde-app-settings",JSON.stringify(data.appSettings));
    if(data.googlePlaces)localStorage.setItem("cacherunde-google-places",JSON.stringify(data.googlePlaces));
    state.savedTours=Array.isArray(data.savedTours)?data.savedTours:[];
    state.savedTrips=Array.isArray(data.savedTrips)?data.savedTrips:[];
    state.pendingLogs=Array.isArray(data.pendingLogs)?data.pendingLogs:[];
    state.activeTour=data.activeTour||null;
    persistTourState();
    migrateLocalData();
    loadProfile();
    loadGooglePlacesSettings();
    loadAppSettings();
    renderSavedTours();renderSavedTrips();renderActiveTour();updateLogQueueStatus();
    showToast("Backup erfolgreich importiert.","success");
  }catch(e){
    showToast(`Backup konnte nicht importiert werden: ${e.message}`,"error",5000);
  }
}

function renameSavedTour(t){
  const name=prompt("Neuer Name der Tour:",t.displayName||t.name||"");
  if(!name?.trim())return;
  t.displayName=name.trim();t.name=name.trim();persistTourState();renderSavedTours();
}
function duplicateSavedTour(t){
  const copy=JSON.parse(JSON.stringify(t));
  copy.id=`saved-${Date.now()}`;
  copy.displayName=`${t.displayName||t.name} · Kopie`;
  copy.savedAt=new Date().toISOString();
  state.savedTours.unshift(copy);persistTourState();renderSavedTours();
}
function renameSavedTrip(t){
  const name=prompt("Neuer Name der Reise:",t.name||"");
  if(!name?.trim())return;
  t.name=name.trim();persistTourState();renderSavedTrips();
}
function duplicateSavedTrip(t){
  const copy=JSON.parse(JSON.stringify(t));
  copy.id=`trip-${Date.now()}`;copy.name=`${t.name} · Kopie`;copy.createdAt=new Date().toISOString();
  state.savedTrips.unshift(copy);persistTourState();renderSavedTrips();
}

async function refreshSystemStatus(){
  const setText=(selector,text)=>{const el=$(selector);if(el)el.textContent=text;};
  const setClass=(selector,value)=>{const el=$(selector);if(el)el.className=value;};
  const online=navigator.onLine;

  setText("#systemNetwork",online?"Online":"Offline");
  setText("#networkBadge",online?"Netz: online":"Netz: offline");
  setClass("#networkBadge",`status-chip ${online?"ok":"warn"}`);
  setText("#systemRouting",online?"bereit":"offline");
  setText("#systemGoogle",state.googlePlaces.enabled&&state.googlePlaces.key?"aktiv":"optional");
  setText("#systemGc",isNativeApp()?"per Login":"nur in der App");
  const storage=storageSummary();
  setText("#systemStorage",`${storage.kb.toFixed(0)} KB`);

  try{
    const r=await fetch("/api/status",{cache:"no-store"});
    const d=await r.json();
    setText("#systemMaps",`${d.tileCount||0} Kacheln`);
    setText("#offlineBadge",`Offline: ${d.tileCount||0} Kacheln`);
    setClass("#offlineBadge","status-chip ok");
  }catch(e){
    setText("#systemMaps","unbekannt");
    setText("#offlineBadge","Offline: ?");
    setClass("#offlineBadge","status-chip warn");
  }
}

function updateNetworkStatus(){
  const online=navigator.onLine;
  const badge=$("#networkBadge");
  if(badge){
    badge.textContent=online?"Netz: online":"Netz: offline";
    badge.className=`status-chip ${online?"ok":"warn"}`;
  }
  if(!online)showToast("Offline: Routing, Ortsuche und neue Unterkunftsdaten benötigen Internet.","warn",5000);
  refreshSystemStatus().catch(()=>{});
}

function setProgress(percent,text,title="CacheRunde arbeitet …"){
  const box=$("#globalProgress");
  if(!box)return;
  box.classList.remove("hidden");
  $("#progressTitle").textContent=title;
  $("#progressPercent").textContent=`${Math.max(0,Math.min(100,Math.round(percent)))} %`;
  $("#progressBar").style.width=`${Math.max(0,Math.min(100,percent))}%`;
  $("#progressText").textContent=text||"";
}
function finishProgress(text="Fertig."){
  setProgress(100,text,"Fertig");
  setTimeout(()=>$("#globalProgress")?.classList.add("hidden"),2200);
}
function failProgress(text){
  setProgress(100,text||"Fehler","Vorgang beendet");
  setTimeout(()=>$("#globalProgress")?.classList.add("hidden"),4500);
}


function cacheSequence(route){
  const pts=route.points.filter(p=>p && p.id);
  if(pts.length>1 && pts[0].id===pts[pts.length-1].id) return pts.slice(0,-1);
  return pts;
}

function validRoutingPoint(p){
  return !!p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon);
}
function zeroWalkingRoute(point){
  return {
    distance:0,duration:0,legs:[],
    geometry:{type:"LineString",coordinates:[[+point.lon,+point.lat]]}
  };
}
async function footRouteRequest(points, steps=false){
  if(!Array.isArray(points) || points.length<2 || points.some(p=>!validRoutingPoint(p))){
    throw new Error("Ungültige Koordinaten für Fußrouting.");
  }
  const coords=points.map(p=>`${p.lon},${p.lat}`).join(";");
  const url=`${FOOT_ROUTER}?coords=${encodeURIComponent(coords)}&steps=${steps?"true":"false"}`;
  const res=await fetch(url,{cache:"no-store"});
  if(!res.ok){
    const detail=await res.text().catch(()=> "");
    throw new Error(`Fußrouting HTTP ${res.status}${detail?": "+detail.slice(0,180):""}`);
  }
  const data=await res.json();
  const route=data?.routes?.[0];
  if(data?.code!=="Ok" || !route)throw new Error(data?.message||data?.code||"Keine Fußroute");
  if(!route.geometry || !Array.isArray(route.geometry.coordinates)){
    throw new Error("Fußrouting lieferte keine gültige Geometrie.");
  }
  return route;
}
async function connectorRoute(a,b){
  if(!validRoutingPoint(a) || !validRoutingPoint(b)){
    throw new Error("Start/Ziel für Parkplatz-Verbindung fehlt.");
  }
  if(haversine(a,b)<0.003)return zeroWalkingRoute(a);
  const r=await footRouteRequest([a,b],false);
  if(!r)throw new Error("Parkplatz-Verbindung lieferte kein Ergebnis.");
  return r;
}

async function footRouteSequence(points){
  const CHUNK=20;
  let totalDistance=0,totalDuration=0,legDurations=[],coordinates=[];
  for(let start=0;start<points.length-1;start+=CHUNK-1){
    const chunk=points.slice(start,Math.min(points.length,start+CHUNK));
    if(chunk.length<2) break;
    const r=await footRouteRequest(chunk,false);
    if(!r)throw new Error("Fußrouting lieferte ein leeres Routenergebnis.");
    totalDistance+=r.distance||0;
    totalDuration+=r.duration||0;
    legDurations.push(...(r.legs||[]).map(l=>l?.duration||0));
    const g=r.geometry?.coordinates||[];
    if(coordinates.length && g.length) coordinates.push(...g.slice(1)); else coordinates.push(...g);
    if(start+CHUNK < points.length) await sleep(ROUTER_DELAY_MS);
  }
  return {distance:totalDistance,duration:totalDuration,legDurations,geometry:{type:"LineString",coordinates}};
}

async function findParkingCandidates(first,last,sequence=null,parkingMode="fallback"){
  const pts=sequence?.length?sequence:[first,last];
  const center=pts.reduce((a,p)=>({lat:a.lat+p.lat/pts.length,lon:a.lon+p.lon/pts.length}),{lat:0,lon:0});
  const spreadKm=Math.max(0,...pts.map(p=>haversine(center,p)));
  const radius=Math.round(Math.max(2500,Math.min(7500,(spreadKm+1.3)*1000)));

  async function fetchJson(url){
    const res=await fetch(url,{cache:"no-store"});
    if(!res.ok){
      const detail=await res.text().catch(()=> "");
      throw new Error(`Parkplatzsuche HTTP ${res.status}${detail?": "+detail.slice(0,180):""}`);
    }
    return res.json();
  }

  let designated=[];
  try{
    const d=await fetchJson(`/api/parking?lat=${encodeURIComponent(center.lat)}&lon=${encodeURIComponent(center.lon)}&radius=${radius}`);
    designated=d.results||[];
  }catch(e){
    if(parkingMode==="designated")throw e;
  }

  let roadside=[];
  const needRoadside=parkingMode==="roadside" || (parkingMode==="fallback" && designated.length<3);
  if(needRoadside){
    try{
      const d=await fetchJson(`/api/roadside-parking?lat=${encodeURIComponent(center.lat)}&lon=${encodeURIComponent(center.lon)}&radius=${Math.min(radius,4000)}`);
      roadside=d.results||[];
    }catch(e){
      console.warn("Straßenrand-Fallback nicht verfügbar",e);
    }
  }

  const combined=[
    ...designated.map(x=>({...x,roadside:false})),
    ...roadside.map(x=>({...x,roadside:true}))
  ];

  return combined.map(p=>({
      lat:+p.lat,lon:+p.lon,
      name:p.name||p.display_name||(p.roadside?"Straßenrand":"Parkplatz"),
      access:p.access||"",
      parking:p.parking||"",
      fee:p.fee||"",
      capacity:+p.capacity||0,
      hiking:p.hiking||"",
      surface:p.surface||"",
      lit:p.lit||"",
      maxstay:p.maxstay||"",
      source:p.source||(p.roadside?"OSM Straße":"Nominatim"),
      osmType:p.osm_type||"",
      osmId:p.osm_id||null,
      roadside:!!p.roadside,
      roadType:p.roadType||p.highway||"",
      roadName:p.roadName||""
    }))
    .filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&!["private","no","customers","permit"].includes(p.access))
    .map(p=>{
      const nearestRouteKm=Math.min(...pts.map(c=>haversine(p,c)));
      let meta=0;
      if(/wander|hiking|trail/i.test(p.name))meta-=0.35;
      if(p.fee==="yes")meta+=0.25;
      if(p.capacity>=10)meta-=0.10;
      if(p.roadside)meta+=parkingMode==="roadside"?0.30:0.65;
      return {...p,nearestRouteKm,parkingScore:nearestRouteKm+meta};
    })
    .sort((a,b)=>a.parkingScore-b.parkingScore)
    .slice(0,16);
}

function rotateRoundSequence(seq,startIndex,direction=1){
  const n=seq.length;
  if(!n)return [];
  const out=[];
  for(let step=0;step<n;step++){
    const idx=(startIndex+direction*step+n*10)%n;
    out.push(seq[idx]);
  }
  return out;
}

function sequenceSame(a,b){
  return a.length===b.length && a.every((x,i)=>x.id===b[i].id);
}

function approxSequenceKm(seq){
  let km=0;
  for(let i=1;i<seq.length;i++)km+=haversine(seq[i-1],seq[i]);
  return km;
}

async function optimizeParkingAndEntry(baseSeq,parkings,opts,status,baseCacheReal=null,maxRealTests=6,allowGapViolations=false){
  if(!baseSeq?.length || !parkings?.length)return null;
  const approx=[];

  for(const parking of parkings.slice(0,8)){
    const nearest=[...baseSeq.keys()]
      .sort((a,b)=>haversine(parking,baseSeq[a])-haversine(parking,baseSeq[b]))
      .slice(0,3);
    if(!nearest.includes(0))nearest.push(0);

    for(const startIndex of nearest){
      for(const direction of [1,-1]){
        const seq=rotateRoundSequence(baseSeq,startIndex,direction);
        const connectorKm=haversine(parking,seq[0])+haversine(seq[seq.length-1],parking);
        const cacheKm=approxSequenceKm(seq);
        const metaKm=Math.max(-0.25,Math.min(0.45,(parking.parkingScore||0)*0.08));
        approx.push({parking,seq,startIndex,direction,approxKm:connectorKm+cacheKm+metaKm});
      }
    }
  }

  approx.sort((a,b)=>a.approxKm-b.approxKm);

  // Keep the real-routing workload bounded while still testing multiple
  // parking/entry/direction combinations.
  const realTests=[];
  const seen=new Set();
  for(const c of approx){
    const key=`${c.parking.osmId||`${c.parking.lat.toFixed(5)},${c.parking.lon.toFixed(5)}`}|${c.seq[0].id}|${c.direction}`;
    if(seen.has(key))continue;
    seen.add(key);
    realTests.push(c);
    if(realTests.length>=maxRealTests)break;
  }

  let best=null;
  for(let i=0;i<realTests.length;i++){
    const c=realTests[i];
    if(status)status.textContent=`Optimiere Parkplatz und Einstieg ${i+1}/${realTests.length}: ${c.parking.name} → ${c.seq[0].id} …`;

    let cacheReal;
    try{
      cacheReal=(baseCacheReal && sequenceSame(c.seq,baseSeq))
        ? baseCacheReal
        : await footRouteSequence(c.seq);
    }catch(e){
      continue;
    }

    // Normal mode rejects cache-to-cache gaps above the configured maximum.
    // A user-confirmed fixed map selection may explicitly keep such gaps.
    if(!allowGapViolations && (cacheReal.legDurations||[]).some(sec=>sec>opts.maxGap*60))continue;

    let toFirst,fromLast;
    try{
      toFirst=await connectorRoute(c.parking,c.seq[0]);
      fromLast=await connectorRoute(c.seq[c.seq.length-1],c.parking);
    }catch(e){
      continue;
    }

    const geometry={type:"LineString",coordinates:mergeGeometries(toFirst.geometry,cacheReal.geometry,fromLast.geometry)};
    const walkingDistance=(toFirst.distance||0)+(cacheReal.distance||0)+(fromLast.distance||0);
    const walkingDuration=(toFirst.duration||0)+(cacheReal.duration||0)+(fromLast.duration||0);
    const overlap=overlapRatio(geometry.coordinates);

    // Total walking distance is the primary criterion.
    // Repeated path and parking metadata only act as small tie-breakers.
    const scoreMeters=walkingDistance + overlap*450 + Math.max(-150,Math.min(250,(c.parking.parkingScore||0)*90));
    const result={
      parking:c.parking,
      seq:c.seq,
      cacheReal,
      toFirst,
      fromLast,
      walkingDistance,
      walkingDuration,
      geometry,
      overlap,
      scoreMeters,
      entryCacheId:c.seq[0]?.id||null,
      direction:c.direction===1?"vorwärts":"rückwärts",
      tested:realTests.length
    };
    if(!best || result.scoreMeters<best.scoreMeters)best=result;

    if(i<realTests.length-1)await sleep(500);
  }

  return best;
}

async function carRoute(origin,dest){
  const coords=`${origin.lon},${origin.lat};${dest.lon},${dest.lat}`;
  const url=`${CAR_ROUTER}?coords=${encodeURIComponent(coords)}`;
  const res=await fetch(url,{cache:"no-store"});
  if(!res.ok){const detail=await res.text().catch(()=> "");throw new Error(`Anfahrtsrouting HTTP ${res.status}${detail?": "+detail.slice(0,180):""}`);}
  const data=await res.json();
  const r=data.routes?.[0];
  if(!r) throw new Error("Keine Anfahrtsroute");
  return {distance:r.distance||0,duration:r.duration||0};
}


function sampleGeometry(coords,maxPoints=100){
  if(!coords?.length) return [];
  if(coords.length<=maxPoints) return coords;
  const out=[];
  for(let i=0;i<maxPoints;i++){
    const idx=Math.round(i*(coords.length-1)/(maxPoints-1));
    out.push(coords[idx]);
  }
  return out;
}

async function fetchElevationForGeometry(coords){
  const sampled=sampleGeometry(coords,100);
  if(!sampled.length) return null;
  const lats=sampled.map(c=>c[1]).join(",");
  const lons=sampled.map(c=>c[0]).join(",");
  const res=await fetch(`${ELEVATION}?lat=${encodeURIComponent(lats)}&lon=${encodeURIComponent(lons)}`,{cache:"no-store"});
  if(!res.ok){const t=await res.text().catch(()=> "");throw new Error(`Höhenprofil HTTP ${res.status}${t?": "+t.slice(0,120):""}`)}
  const data=await res.json();
  const ele=data.elevation||[];
  if(!ele.length) return null;

  // Light smoothing to reduce DEM stair-step noise.
  const smooth=ele.map((v,i)=>{
    const vals=[];
    for(let j=Math.max(0,i-1);j<=Math.min(ele.length-1,i+1);j++) vals.push(+ele[j]);
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  });
  let gain=0,loss=0;
  for(let i=1;i<smooth.length;i++){
    const d=smooth[i]-smooth[i-1];
    if(Math.abs(d)<1.5) continue;
    if(d>0) gain+=d; else loss+=Math.abs(d);
  }
  return {
    elevations:smooth,
    gain,loss,
    min:Math.min(...smooth),
    max:Math.max(...smooth),
    samples:sampled
  };
}

function elevationSvg(profile){
  if(!profile?.elevations?.length) return "";
  const vals=profile.elevations,w=300,h=64,pad=4;
  const min=Math.min(...vals),max=Math.max(...vals),range=Math.max(1,max-min);
  const pts=vals.map((v,i)=>{
    const x=pad+i*(w-2*pad)/Math.max(1,vals.length-1);
    const y=h-pad-(v-min)*(h-2*pad)/range;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<div class="elevation-profile"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2"/></svg><div class="elevation-caption"><span>${Math.round(min)} m</span><span>↑ ${Math.round(profile.gain)} m · ↓ ${Math.round(profile.loss)} m</span><span>${Math.round(max)} m</span></div></div>`;
}

async function tryPreserveAllCachesByChangingBreak(seq,result,opts,status){
  const bad=(result.legDurations||[])
    .map((sec,i)=>({sec,i}))
    .filter(x=>x.sec>opts.maxGap*60)
    .sort((a,b)=>b.sec-a.sec);

  if(!bad.length)return null;

  // A round does not need a cache-to-cache connection across the parking break.
  // Therefore a bad real walking leg can often be moved to "last cache -> parking -> first cache"
  // simply by rotating the sequence instead of deleting a cache.
  const trials=[];
  const seen=new Set();

  for(const b of bad.slice(0,3)){
    const starts=[b.i+1,b.i];
    for(const start of starts){
      for(const direction of [1,-1]){
        const cand=rotateRoundSequence(seq,(start+seq.length)%seq.length,direction);
        const key=cand.map(c=>c.id).join(">");
        if(seen.has(key) || sequenceSame(cand,seq))continue;
        seen.add(key);
        trials.push(cand);
      }
    }
  }

  let best=null;
  const limit=Math.min(6,trials.length);
  for(let i=0;i<limit;i++){
    const cand=trials[i];
    if(status)status.textContent=`Cachefolge erhalten: prüfe alternativen Einstieg ${i+1}/${limit} (${cand[0].id}) …`;
    try{
      const real=await footRouteSequence(cand);
      const violations=(real.legDurations||[]).filter(sec=>sec>opts.maxGap*60).length;
      if(violations===0){
        if(!best || real.distance<best.result.distance){
          best={seq:cand,result:real,reordered:true,reason:"parking-break"};
        }
      }
    }catch(e){}
    if(i<limit-1)await sleep(350);
  }
  return best;
}

function violationDetailsForSequence(seq,legDurations,opts){
  return (legDurations||[]).map((sec,i)=>({
    from:seq[i]?.id||"?",
    to:seq[i+1]?.id||"?",
    sec,
    min:sec/60,
    over:sec>opts.maxGap*60
  })).filter(x=>x.over);
}


function lockedSelectionIds(route){
  return Array.isArray(route?.manualLockedCacheIds) ? route.manualLockedCacheIds.filter(Boolean) : [];
}

function sequenceForLockedSelection(route,fallbackSeq){
  const ids=lockedSelectionIds(route);
  if(!ids.length)return [...fallbackSeq];
  const wanted=new Set(ids);
  const pool=new Map();
  [...fallbackSeq,...state.caches].forEach(c=>{if(c?.id && !pool.has(c.id))pool.set(c.id,c);});
  const ordered=[];
  fallbackSeq.forEach(c=>{if(wanted.has(c.id) && !ordered.some(x=>x.id===c.id))ordered.push(c);});
  ids.forEach(id=>{if(!ordered.some(c=>c.id===id) && pool.has(id))ordered.push(pool.get(id));});
  return ordered;
}

function missingLockedCaches(route,seq){
  const present=new Set((seq||[]).map(c=>c.id));
  return lockedSelectionIds(route).filter(id=>!present.has(id));
}

function lockedSelectionHtml(route){
  const ids=lockedSelectionIds(route);
  if(!ids.length)return "";
  const finalSeq=route.real?.finalSequence||cacheSequence(route);
  const missing=missingLockedCaches(route,finalSeq);
  if(missing.length){
    return `<div class="locked-selection-note warn">⚠ Fixierte Kartenauswahl unvollständig: ${missing.map(escapeHtml).join(", ")}</div>`;
  }
  return `<div class="locked-selection-note">🔒 Kartenauswahl fixiert: ${ids.length}/${ids.length} ausgewählte Caches enthalten.</div>`;
}

async function routeAndRepairSequence(originalSeq,opts,status,config={}){
  let seq=[...originalSeq];
  const removed=[];
  let result=null;
  let reordered=false;
  const allowViolations=!!config.allowViolations;

  for(let attempt=0;attempt<6;attempt++){
    result=await footRouteSequence(seq);
    const bad=result.legDurations
      .map((sec,i)=>({sec,i}))
      .filter(x=>x.sec>opts.maxGap*60)
      .sort((a,b)=>b.sec-a.sec);

    if(!bad.length){
      return {seq,result,removed,violations:0,reordered,violationDetails:[]};
    }

    if(allowViolations){
      return {
        seq,result,removed,
        violations:bad.length,
        reordered,
        manualOverride:true,
        violationDetails:violationDetailsForSequence(seq,result.legDurations,opts)
      };
    }

    const preserved=await tryPreserveAllCachesByChangingBreak(seq,result,opts,status);
    if(preserved){
      return {
        seq:preserved.seq,
        result:preserved.result,
        removed,
        violations:0,
        reordered:true,
        preservedAllCaches:true,
        violationDetails:[]
      };
    }

    if(seq.length<=2){
      return {
        seq,result,removed,
        violations:bad.length,
        reordered,
        violationDetails:violationDetailsForSequence(seq,result.legDurations,opts)
      };
    }

    const worst=bad[0].i;
    const candidates=[];
    for(const removeIndex of [worst,worst+1]){
      if(removeIndex<0 || removeIndex>=seq.length)continue;
      const trial=seq.filter((_,i)=>i!==removeIndex);
      if(trial.length<1)continue;
      let localCost=0;
      if(removeIndex>0 && removeIndex<trial.length){
        localCost=haversine(trial[removeIndex-1],trial[removeIndex]);
      }else{
        localCost=999;
      }
      candidates.push({removeIndex,localCost});
    }
    candidates.sort((a,b)=>a.localCost-b.localCost);
    const chosen=candidates[0];
    if(!chosen){
      return {
        seq,result,removed,
        violations:bad.length,
        reordered,
        violationDetails:violationDetailsForSequence(seq,result.legDurations,opts)
      };
    }

    const [gone]=seq.splice(chosen.removeIndex,1);
    removed.push(gone);
    if(status){
      status.textContent=`Echter Fußweg > ${opts.maxGap} min. Entferne ${gone.id} und prüfe erneut …`;
    }
    await sleep(ROUTER_DELAY_MS);
  }

  const details=violationDetailsForSequence(seq,result.legDurations,opts);
  return {seq,result,removed,violations:details.length,reordered,violationDetails:details};
}

function segmentKey(a,b,precision=4){
  const p1=`${a[0].toFixed(precision)},${a[1].toFixed(precision)}`;
  const p2=`${b[0].toFixed(precision)},${b[1].toFixed(precision)}`;
  return p1<p2?`${p1}|${p2}`:`${p2}|${p1}`;
}

function overlapRatio(coords){
  if(!coords?.length || coords.length<2) return 0;
  const seen=new Set();
  let total=0,repeated=0;
  for(let i=1;i<coords.length;i++){
    const a=coords[i-1],b=coords[i];
    const km=haversine({lat:a[1],lon:a[0]},{lat:b[1],lon:b[0]});
    total+=km;
    const key=segmentKey(a,b,4);
    if(seen.has(key)) repeated+=km;
    seen.add(key);
  }
  return total>0?repeated/total:0;
}

function mergeGeometries(...geoms){
  const out=[];
  geoms.forEach(g=>{
    const arr=g?.coordinates||[];
    if(!arr.length) return;
    if(out.length) out.push(...arr.slice(1)); else out.push(...arr);
  });
  return out;
}

async function alternativeReturnRoute(last,parking,forwardGeometry){
  const midLat=(last.lat+parking.lat)/2, midLon=(last.lon+parking.lon)/2;
  const offsets=[
    [0.0035,0],[ -0.0035,0],[0,0.005],[0,-0.005],
    [0.003,0.004],[-0.003,-0.004]
  ];
  const candidates=[];
  for(const [dLat,dLon] of offsets){
    try{
      const via={lat:midLat+dLat,lon:midLon+dLon};
      const r=await footRouteRequest([last,via,parking],false);
      const merged=mergeGeometries({coordinates:forwardGeometry},r.geometry);
      candidates.push({route:r,overlap:overlapRatio(merged)});
      await sleep(ROUTER_DELAY_MS);
    }catch(e){}
  }
  if(!candidates.length) return null;
  candidates.sort((a,b)=>a.overlap-b.overlap || a.route.distance-b.route.distance);
  return candidates[0];
}


async function estimateForestShare(coords){
  const sampled=sampleGeometry(coords,18);
  if(!sampled.length)return null;
  const res=await fetch(LANDCOVER,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({points:sampled.map(c=>({lat:c[1],lon:c[0]}))})});
  if(!res.ok)return null;
  const d=await res.json();return d.forestShare??null;
}
function gpxTextForRoute(r){
  const esc=s=>String(s).replace(/[<>&'"]/g,ch=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[ch]));
  const seq=r.real?.finalSequence||cacheSequence(r);
  const pts=r.real?.geometry?.coordinates?.length?r.real.geometry.coordinates.map(c=>({lon:c[0],lat:c[1]})):r.points;
  const trk=pts.map(p=>`<trkpt lat="${p.lat}" lon="${p.lon}"></trkpt>`).join("");
  const wp=seq.map(p=>`<wpt lat="${p.lat}" lon="${p.lon}"><name>${esc(p.id)}</name><desc>${esc(p.name)}</desc></wpt>`).join("");
  const park=(r.real && validRoutingPoint(r.real.parking))
    ? `<wpt lat="${r.real.parking.lat}" lon="${r.real.parking.lon}"><name>Parking</name><desc>${esc(r.real.parking?.name||"Startpunkt")}</desc></wpt>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="CacheRunde 0.4.0" xmlns="http://www.topografix.com/GPX/1/1">${park}${wp}<trk><name>${esc(r.displayName||r.name)}</name><trkseg>${trk}</trkseg></trk></gpx>`;
}
async function shareRouteGPX(r){
  const text=gpxTextForRoute(r),filename=`${(r.displayName||r.name).replace(/\W+/g,"-").toLowerCase()}.gpx`;
  const file=new File([text],filename,{type:"application/gpx+xml"});
  try{
    if(navigator.canShare?.({files:[file]})){await navigator.share({title:r.displayName||r.name,text:"CacheRunde GPX",files:[file]});return;}
  }catch(e){if(e.name==="AbortError")return;}
  const u=URL.createObjectURL(new Blob([text],{type:"application/gpx+xml"}));const a=document.createElement("a");a.href=u;a.download=filename;a.click();URL.revokeObjectURL(u);
}


function chooseManualParking(route,lockSequence=false){
  if(!route){
    showToast("Keine Route gewählt. Berechne oder öffne zuerst eine Route.","warn",4500);
    return;
  }
  state.parkingPickRoute=route;
  state.parkingPickLockSequence=!!lockSequence;
  switchTab("karte");
  $("#map")?.classList.add("map-pick-active");
  $("#mapInfo").innerHTML=`<div style="width:100%">
    <strong>🅿 Parkplatz ${route.real?.parking?"verschieben":"manuell setzen"}</strong>
    <span>Klicke auf die gewünschte Stelle der Karte.</span>
    <div class="parking-move-note">
      <strong>${lockSequence?"Cachefolge bleibt fix":"Route wird anschließend neu geprüft"}</strong>
      ${lockSequence
        ?"Bei der freien/manuell bearbeiteten Planung bleibt die aktuelle Cache-Reihenfolge erhalten. Neu berechnet werden Parkplatz→erster Cache, letzter Cache→Parkplatz, Gesamtdistanz und Gesamtzeit."
        :"Der gewählte Punkt wird als manueller Parkplatz verwendet und die Echtroute anschließend neu berechnet."}
    </div>
  </div>`;
}

async function applyManualParking(route,lat,lon,lockSequence=false){
  if(!route)return;
  route.manualParking={
    lat:+lat,lon:+lon,
    name:"Manuell gewählter Parkplatz",
    parkingScore:0,
    fee:"",
    capacity:0,
    source:"Manuell",
    roadside:false
  };
  route.manualParkingLockSequence=!!lockSequence;

  if(lockSequence){
    // Freeze the current displayed cache order exactly as it is.
    const currentSeq=route.real?.finalSequence || cacheSequence(route);
    route.points=[...currentSeq];
    if(route.manualSelectionLocked){
      route.manualLockedCacheIds=currentSeq.map(c=>c.id);
    }
  }

  const fakeButton={textContent:"Echtroute neu prüfen",disabled:false};
  const result=await refineRoute(route,fakeButton);
  if(result){
    showToast(
      lockSequence
        ? "Parkplatz verschoben. Cachefolge blieb unverändert; Hin-/Rückweg wurden neu berechnet."
        : "Manueller Parkplatz übernommen und Echtroute neu berechnet.",
      "success",5500
    );
  }
}

async function refineRoute(route,button){
  const status=$("#routingStatus");
  const lockedIds=lockedSelectionIds(route);
  const parkingOrderLocked=!!route.manualParkingLockSequence;
  const pre=(lockedIds.length || parkingOrderLocked) ? null : (route.precheck?.full?route.precheck:null);
  const baseSeq=parkingOrderLocked && route.real?.finalSequence?.length
    ? [...route.real.finalSequence]
    : (pre?.finalSequence?.length ? [...pre.finalSequence] : cacheSequence(route));
  const seq=parkingOrderLocked
    ? [...baseSeq]
    : (lockedIds.length ? sequenceForLockedSelection(route,baseSeq) : baseSeq);
  const preliminary=pre ? {
    cacheCount:pre.cacheCount,
    km:(pre.walkingDistance||0)/1000,
    totalMin:(pre.totalDuration||0)/60,
    source:"realistic-precheck"
  } : {
    cacheCount:route.stats?.cacheCount||seq.length,
    km:route.stats?.km||0,
    totalMin:route.stats?.totalMin||0,
    source:"estimate"
  };
  if(seq.length<1){alert("Keine Cachepunkte für Echtrouting.");return;}

  const oldText=button.textContent;
  setProgress(5,"Bereite Echtrouting vor …","Echtroute");
  button.disabled=true;
  button.textContent="Prüfe Fußwege …";
  if(status) status.textContent=`Prüfe ${seq.length} Caches über echte Fußwege …`;

  let routingStage="Start";
  try{
    const opts=getOpts(false);
    routingStage="Cachefolge prüfen";
    setProgress(15,"Prüfe Cachefolge über echte Fußwege …","Echtroute");
    const repaired=await routeAndRepairSequence(seq,opts,status,{
      // A fixed map selection must never be silently repaired by deleting caches.
      // If it contains long gaps, keep them and surface them as rule deviations.
      allowViolations:!!route.manualAllowGapViolations || lockedIds.length>0 || parkingOrderLocked
    });
    let finalSeq=repaired?.seq||[];
    let cacheReal=repaired?.result||null;
    if(!finalSeq.length)throw new Error("Cachefolge ist nach der Prüfung leer.");
    if(!cacheReal)throw new Error("Cache-Fußrouting lieferte kein Ergebnis.");
    let maxCacheLegSec=Math.max(0,...(cacheReal.legDurations||[]));
    const violations=repaired.violations;

    const repairText=repaired.removed.length
      ? ` · ${repaired.removed.length} Cache(s) entfernt`
      : repaired.reordered
        ? " · Einstieg/Reihenfolge angepasst, alle Caches behalten"
        : "";
    setProgress(35,`Cachefolge geprüft${repairText}. Suche Parkplatz …`,"Echtroute");
    if(status)status.textContent=`Echte Cachekette: ${(cacheReal.distance/1000).toFixed(1)} km${repairText}. Suche Parkplatz …`;
    await sleep(ROUTER_DELAY_MS);

    routingStage="Parkplatz suchen";
    let parkings=[];
    let parking=null;
    let parkingAutomatic=true;

    if(route.manualParking){
      parking=route.manualParking;
      parkings=[parking];
      parkingAutomatic=false;
      setProgress(45,"Manuell gewählten Parkplatz prüfen …","Echtroute");
      if(status) status.textContent="Manuell gewählten Parkplatz prüfen …";
    }else{
      try{
        const parkingPromise=isWalkFromStart(opts)
          ? Promise.resolve([walkStartPoint(opts)])
          : findParkingCandidates(finalSeq[0],finalSeq[finalSeq.length-1],finalSeq,opts.parkingMode||"fallback");
        const timeoutPromise=new Promise((_,reject)=>setTimeout(()=>reject(new Error("timeout")),10000));
        parkings=await Promise.race([parkingPromise,timeoutPromise]);
        if(pre?.parking && !pre.parking.previewFallback){
          const idx=parkings.findIndex(p=>
            (pre.parking.osmId && p.osmId===pre.parking.osmId) ||
            (Math.abs(p.lat-pre.parking.lat)<0.00002 && Math.abs(p.lon-pre.parking.lon)<0.00002)
          );
          if(idx>0){
            const [preferred]=parkings.splice(idx,1);
            parkings.unshift(preferred);
          }
        }
        if(parkings.length) parking=parkings[0];
      }catch(e){}
    }

    if(!parking){
      parking={...finalSeq[0],name:"Kein Parkplatz automatisch gefunden",parkingScore:null,fee:"",capacity:0};
      parkingAutomatic=false;
      setProgress(50,"Kein Parkplatz automatisch gefunden. Nutze vorläufig ersten Cache als Start …","Echtroute");
      if(status) status.textContent="Kein Parkplatz automatisch gefunden. Route wird trotzdem fertiggestellt.";
    }else if(status){
      setProgress(50,`${parkings.length} Parkplatz-Kandidat(en) gefunden. Prüfe Fußwege …`,"Echtroute");
      status.textContent=`${parkings.length} Parkplatz-Kandidat(en) gefunden. Prüfe Fußwege zum Parkplatz …`;
    }

    await sleep(ROUTER_DELAY_MS);

    let parkingPlan=null;
    if(parkings.length && !parkingOrderLocked){
      setProgress(54,"Optimiere Parkplatz, Einstieg und Laufrichtung nach Gesamtweg …","Echtroute");
      parkingPlan=await optimizeParkingAndEntry(
        finalSeq,parkings,opts,status,cacheReal,6,
        !!route.manualAllowGapViolations || lockedIds.length>0
      );
    }else if(parkingOrderLocked && status){
      setProgress(54,"Manuellen Parkplatz anbinden · Cachefolge bleibt unverändert …","Echtroute");
      status.textContent="Manueller Parkplatz: Cache-Reihenfolge bleibt fix. Berechne nur Hin- und Rückweg.";
    }

    let toFirst,fromLast;
    let entryCacheId=finalSeq[0]?.id||null;
    let walkingDirection="vorwärts";
    let parkingVariantsTested=parkingPlan?.tested||0;

    routingStage="Parkplatz-Verbindungen berechnen";
    if(parkingPlan?.parking && parkingPlan?.cacheReal && parkingPlan?.toFirst && parkingPlan?.fromLast){
      parking=parkingPlan.parking;
      finalSeq=parkingPlan.seq||finalSeq;
      cacheReal=parkingPlan.cacheReal;
      maxCacheLegSec=Math.max(0,...(cacheReal.legDurations||[]));
      toFirst=parkingPlan.toFirst;
      fromLast=parkingPlan.fromLast;
      entryCacheId=parkingPlan.entryCacheId;
      walkingDirection=parkingPlan.direction;
    }else{
      if(!parking)parking={...finalSeq[0],name:"Start am ersten Cache",parkingScore:null,fee:"",capacity:0};
      toFirst=await connectorRoute(parking,finalSeq[0]);
      await sleep(ROUTER_DELAY_MS);
      fromLast=await connectorRoute(finalSeq[finalSeq.length-1],parking);
    }
    if(!toFirst || !fromLast || !cacheReal){
      throw new Error("Eine der Fußweg-Komponenten ist leer geblieben.");
    }

    routingStage="Fixierte Cacheauswahl prüfen";
    const missingLocked=missingLockedCaches(route,finalSeq);
    if(missingLocked.length){
      throw new Error(`Fixierte Kartenauswahl verletzt: Folgende ausgewählte Caches würden fehlen: ${missingLocked.join(", ")}. Die Route wurde deshalb nicht stillschweigend verändert.`);
    }

    routingStage="Wandergeometrie zusammensetzen";
    const forwardGeometry=mergeGeometries(toFirst?.geometry,cacheReal?.geometry);
    const directGeometry=mergeGeometries({coordinates:forwardGeometry},fromLast.geometry);
    const directOverlap=overlapRatio(directGeometry);
    let chosenReturnMode="direkt";

    if(directOverlap>0.12){
      if(status) status.textContent=`Rückweg überschneidet sich zu ${Math.round(directOverlap*100)} %. Suche Alternative …`;
      routingStage="Alternativen Rückweg prüfen";
      const alt=await alternativeReturnRoute(finalSeq[finalSeq.length-1],parking,forwardGeometry);
      if(alt && alt.overlap <= directOverlap-0.03 && alt.route.distance <= fromLast.distance*1.45){
        fromLast=alt.route;
        chosenReturnMode="alternativ";
      }
    }

    routingStage="Anfahrt berechnen";
    setProgress(65,"Hin- und Rückweg zum Parkplatz werden berechnet …","Echtroute");
    let drive=null;
    if(!isWalkFromStart(opts)){try{drive=await carRoute(opts.start,parking);}catch(e){}}

    const walkingDistance=(toFirst?.distance||0)+(cacheReal?.distance||0)+(fromLast?.distance||0);
    const walkingDuration=(toFirst?.duration||0)+(cacheReal?.duration||0)+(fromLast?.duration||0);
    const totalSec=walkingDuration + finalSeq.length*opts.stopTime*60;

    const realGeometry={
      type:"LineString",
      coordinates:mergeGeometries(toFirst.geometry,cacheReal.geometry,fromLast.geometry)
    };
    const routeOverlap=overlapRatio(realGeometry.coordinates);

    routingStage="Höhenprofil berechnen";
    setProgress(78,"Berechne Höhenprofil …","Echtroute");
    if(status) status.textContent="Echtroute steht. Berechne Höhenprofil …";
    let elevation=null;
    let elevationError=null;
    try{
      elevation=await fetchElevationForGeometry(realGeometry.coordinates);
      if(status && elevation) status.textContent="Höhenprofil geladen. Finalisiere Tour …";
    }catch(e){
      elevationError=e.message||String(e);
      console.warn(e);
      if(status) status.textContent=`Echtroute steht, Höhenprofil konnte nicht geladen werden: ${elevationError}`;
    }

    // Waldanalyse darf das Echtrouting nicht blockieren.
    // Sie wird nach Abschluss der Route im Hintergrund nachgeladen.
    let forestShare=null;
    routingStage="Ergebnis finalisieren";
    route.real={
      parking,
      parkingCandidates:parkings.length,
      parkingAutomatic,
      parkingScore:parking?.parkingScore??null,
      parkingOptimizationKm:walkingDistance/1000,
      entryCacheId,
      walkingDirection,
      parkingVariantsTested,
      manualParkingSequenceLocked:parkingOrderLocked,
      cacheFreeReturn:true,
      removedCaches:repaired.removed,
      repairReordered:!!repaired.reordered,
      preservedAllCaches:!!repaired.preservedAllCaches,
      preliminary,
      finalSequence:finalSeq,
      elevation,
      elevationError,
      forestShare,
      cacheDistance:cacheReal?.distance||0,
      walkingDistance,
      walkingDuration,
      totalDuration:totalSec,
      maxCacheLegSec,
      violations,
      violationDetails:repaired.violationDetails||[],
      manualGapOverride:!!repaired.manualOverride,
      lockedSelection:lockedIds.length>0,
      lockedSelectionIds:[...lockedIds],
      drive,
      geometry:realGeometry,
      overlapRatio:routeOverlap,
      returnMode:chosenReturnMode,
      checkedAt:new Date().toISOString()
    };

    route.stats.km=walkingDistance/1000;
    route.stats.walkMin=walkingDuration/60;
    route.stats.totalMin=totalSec/60;
    route.stats.cacheCount=finalSeq.length;
    if(elevation){
      route.stats.gain=elevation.gain;
      route.stats.loss=elevation.loss;
    }

    if(status){
      status.textContent=violations
        ? `${lockedIds.length?`Fixierte Auswahl mit ${lockedIds.length} Caches beibehalten. `:""}Echtroute mit ${violations} Regelabweichung(en): Cache→Cache länger als ${opts.maxGap} Minuten.`
        : `${lockedIds.length?`Fixierte Auswahl mit ${lockedIds.length} Caches vollständig enthalten. `:""}Echtroute geprüft: alle Cache→Cache-Abstände ≤ ${opts.maxGap} Minuten.`;
    }

    renderRoutes("#advancedResults",state.routes,$("#sortBy").value);
    showRouteOnMap(route);
    finishProgress("Echtroute fertig berechnet.");

    // Non-blocking forest analysis
    estimateForestShare(realGeometry.coordinates).then(v=>{
      if(v==null)return;
      route.real.forestShare=v;
      renderRoutes("#advancedResults",state.routes,$("#sortBy").value);
      if(state.selectedRoute===route) showRouteOnMap(route);
    }).catch(()=>{});
    return route;
  }catch(e){
    const raw=e?.message||String(e)||"Unbekannter Fehler";
    const msg=`${routingStage}: ${raw}`;
    failProgress(msg);
    console.error("Echtrouting fehlgeschlagen",{stage:routingStage,error:e});
    if(status)status.textContent=`Echtrouting fehlgeschlagen in „${routingStage}“: ${raw}`;
    alert(`Echtrouting fehlgeschlagen in „${routingStage}“:\n${raw}`);
    return null;
  }finally{
    button.disabled=false;
    button.textContent=oldText;
  }
}


const placeNameCache=new Map();
function routeCenter(r){
  const pts=(r.real?.finalSequence || cacheSequence(r));
  if(!pts.length)return null;
  return {lat:pts.reduce((a,p)=>a+p.lat,0)/pts.length,lon:pts.reduce((a,p)=>a+p.lon,0)/pts.length};
}
function routeDescriptor(r,routes){
  const same=routes.filter(x=>x.placeName===r.placeName);
  if(same.length<=1)return "Cache-Runde";
  const kms=same.map(x=>x.stats.km).sort((a,b)=>a-b), mid=kms[Math.floor(kms.length/2)];
  const gains=same.map(x=>x.stats.gain||0).sort((a,b)=>a-b), high=gains[Math.floor(gains.length*.75)];
  if((r.stats.gain||0)>=high && high>150)return "Höhenrunde";
  if(r.stats.km<=mid*.9)return "Kompakte Runde";
  if(r.stats.km>=mid*1.15)return "Große Runde";
  return "Cache-Runde";
}
async function reversePlaceName(lat,lon){
  const key=`${lat.toFixed(3)},${lon.toFixed(3)}`;
  if(placeNameCache.has(key))return placeNameCache.get(key);
  try{
    const res=await fetch(`/api/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,{cache:"no-store"});
    if(!res.ok)throw new Error();
    const d=await res.json(),a=d.address||{};
    const name=a.village||a.town||a.city||a.municipality||a.suburb||a.hamlet||a.county||d.name||"Cachegebiet";
    placeNameCache.set(key,name);return name;
  }catch(e){return "Cachegebiet";}
}
async function enrichRouteNames(routes){
  await Promise.all(routes.map(async r=>{const c=routeCenter(r);r.placeName=c?await reversePlaceName(c.lat,c.lon):"Cachegebiet";}));
  routes.forEach(r=>r.displayName=`${r.placeName} · ${routeDescriptor(r,routes)}`);
}

function searchInfoHtml(){
  const i=state.lastSearchInfo;
  if(!i)return "";
  return `<div class="muted search-info">Gesucht um <strong>${escapeHtmlText(String(i.place).split(",")[0])}</strong> · Radius ${i.radius} km · ${i.inRadius} passende Cache(s) im Radius</div>`;
}

function renderRoutes(container, routes, sortMode="distance"){
  const host=$(container); host.innerHTML="";
  const sorted=sortRoutes(routes,sortMode);
  if(!sorted.length){
    const none=state.lastSearchInfo&&state.lastSearchInfo.inRadius===0;
    const hint=none
      ? (isNativeApp()
          ? "Um diesen Suchort sind keine passenden Caches geladen. Tippe auf „Caches von geocaching.com laden“ oder vergrößere den Radius."
          : "Um diesen Suchort sind keine passenden Caches im importierten GPX. Importiere eine Pocket Query für dieses Gebiet oder vergrößere den Radius.")
      : "Versuche einen größeren Radius, mehr Wanderzeit oder einen größeren Cache-Abstand. Du kannst in „Touren“ testweise auch „Gefundene ausschließen“ deaktivieren.";
    host.innerHTML=`<div class="card"><strong>Keine passende Runde gefunden.</strong>${searchInfoHtml()}<p class="muted">${hint}</p>${diagnosticsHtml()}</div>`;
    return;
  }
  host.insertAdjacentHTML("beforeend",searchInfoHtml());
  sorted.forEach((r,i)=>{
    const node=$("#routeTemplate").content.cloneNode(true);
    node.querySelector(".rank").textContent=`Vorschlag ${i+1}`;
    node.querySelector(".route-name").textContent=r.displayName||r.name;
    const quality=routeQualityScore(r);
    const cacheRate=routeCacheRate(r);
    node.querySelector(".score").textContent=`Qualität ${quality.toFixed(1)}`;
    const m=node.querySelector(".route-metrics");
    const ds=previewStats(r);
    m.innerHTML=`
      <div class="metric"><strong>${ds.km.toFixed(1)} km</strong><span>${r.real?"Echte Wanderstrecke":r.precheck?.full?"Vorprüfung inkl. Parkplatz":"Schätzung"}</span></div>
      <div class="metric"><strong>${fmtMin(ds.totalMin)}</strong><span>inkl. Cachezeit</span></div>
      <div class="metric"><strong>${ds.cacheCount}</strong><span>ungefundene Caches</span></div>
      <div class="metric"><strong>↑ ${Math.round(ds.gain)} m · ↓ ${Math.round(ds.loss)} m</strong><span>Höhenmeter</span></div>`;
    m.insertAdjacentHTML("afterend",`<div class="quality-detail"><span><strong>${cacheRate.toFixed(1)}</strong> Caches/h</span><span><strong>${ds.cacheCount}</strong> Caches</span><span>${ds.km.toFixed(1)} km Rundengröße</span><span>${r.startDistance.toFixed(1)} km vom Ausgangspunkt</span></div>`);
    if(r.real){
      const driveTxt=r.real.drive?` · 🚗 ${fmtMin(r.real.drive.duration/60)} Anfahrt`:"";
      const violationText=(r.real.violationDetails||[]).slice(0,3)
        .map(v=>`${v.from}→${v.to}: ${fmtMin(v.min)}`).join(" · ");
      const ruleTxt=r.real.violations===0
        ? `<span class="pill real-badge">${getOpts(false).maxGap}-Min.-Regel ✓</span>`
        : `<span class="pill warn-badge">${r.real.violations} Überschreitung(en)</span>`;
      node.querySelector(".cache-line").innerHTML=
        `${ruleTxt}<div class="real-details"><strong>${r.real.parking?.walkStart?"🚶":"🅿"} ${r.real.parking?.name||"Startpunkt"}</strong><br>`+
        `Echte Wanderstrecke: ${(r.real.walkingDistance/1000).toFixed(1)} km · `+
        `max. Cache→Cache: ${fmtMin(r.real.maxCacheLegSec/60)}${driveTxt}<br>`+
        `${r.real.parkingAutomatic
          ? `<span class="parking-score">Gesamtweg-optimiert${r.real.entryCacheId?` · Einstieg ${r.real.entryCacheId}`:""}${r.real.walkingDirection?` · ${r.real.walkingDirection}`:""}${r.real.parkingVariantsTested?` · ${r.real.parkingVariantsTested} Varianten geprüft`:""}</span>`
          : `<span class="pill warn-badge">${r.manualParking?"Manueller Parkplatz":"Kein Parkplatz automatisch gefunden"}</span>`}`+
        `${r.real.parking?.roadside?`<br><span class="roadside-badge">🚗 Straßenrand-Fallback</span>`:""}`+
        `${r.real.parking?.source?` · Quelle: ${r.real.parking.source}`:""}${r.real.parking?.fee==="yes"?" · gebührenpflichtig":""}${r.real.parking?.capacity?` · ca. ${r.real.parking.capacity} Plätze`:""}<br>`+
        `${r.real.parking?.roadside?`<div class="roadside-note"><strong>Straßenrand-Parken:</strong> möglicher Startpunkt, keine Parkfreigabe. Beschilderung, Halte-/Parkverbote, Zufahrten und ausreichende Restfahrbahnbreite vor Ort prüfen.</div>`:""}`+
        `Doppelweg-Anteil: ${Math.round((r.real.overlapRatio||0)*100)} % · Rückweg: ${r.real.returnMode==="alternativ"?"Alternative gewählt":"direkt"}<br>`+
        `<div class="open-chain-note"><strong>Cachefreier Rückweg erlaubt</strong>Nach dem letzten Cache darf die Route direkt zum Parkplatz zurückführen. Es müssen auf diesem Abschnitt keine weiteren Caches liegen.</div>`+
        `${r.real.forestShare!=null?`<span class="pill forest-badge">🌳 Waldnähe ca. ${Math.round(r.real.forestShare*100)} %</span><br>`:""}`+
        `Gesamtzeit inkl. ${r.stats.cacheCount} × ${getOpts(false).stopTime} min Cachezeit: ${fmtMin(r.real.totalDuration/60)}`+
        `${r.real.manualGapOverride?`<div class="manual-override">Manuell übersteuert: ${violationText||`mindestens eine Cache→Cache-Verbindung über ${getOpts(false).maxGap} Minuten`}.</div>`:""}`+
        `${r.real.preservedAllCaches?`<div class="repair-note">Cachefolge erhalten: problematische Verbindung wurde an den Parkplatz-Schnitt gelegt; alle Caches bleiben in der Runde.</div>`:""}`+
        `${r.real.removedCaches?.length?`<div class="repair-note">Auto-Reparatur erst nach Alternativprüfung: ${r.real.removedCaches.length} Cache(s) entfernt (${r.real.removedCaches.map(c=>c.id).join(", ")}). Vorprüfung: ${r.real.preliminary?.cacheCount??"—"} Caches / ca. ${r.real.preliminary?.km?.toFixed?.(1)??"—"} km → Echtroute: ${r.stats.cacheCount} Caches / ${r.stats.km.toFixed(1)} km.</div>`:""}`+
        `${routeHealthHtml(r)}`+
        `${lockedSelectionHtml(r)}`+
        `${r.real.elevation?elevationSvg(r.real.elevation):`<div class="repair-note">Höhenprofil nicht verfügbar${r.real.elevationError?": "+r.real.elevationError:""}</div>`}</div>`;
      node.querySelector(".refine-route").textContent="Echtroute neu prüfen";
    }else{
      const ds=previewStats(r);
      node.querySelector(".cache-line").innerHTML=`<strong>${r.placeName||"Cachegebiet"}</strong> · ca. ${r.startDistance.toFixed(1)} km vom Ausgangspunkt<br>${r.precheck?.full
        ? `<span class="muted">Die Hauptwerte oben stammen bereits aus echten Fußwegen einschließlich provisorischem Parkplatz und Rückweg.</span>`
        : `<span class="muted">Noch Schnellschätzung; Parkplatz/Rückweg noch nicht vollständig geprüft.</span>`}${minCacheCheckHtml(r)}${precheckHtml(r,getOpts(false))}${routeHealthHtml(r)}`;
    }
    node.querySelector(".refine-route").onclick=(e)=>refineRoute(r,e.currentTarget);
    node.querySelector(".view-route").onclick=()=>showRouteOnMap(r);
    node.querySelector(".download-gpx").onclick=()=>downloadRouteGPX(r);
    node.querySelector(".share-gpx").onclick=()=>shareRouteGPX(r);
    node.querySelector(".manual-parking").onclick=()=>chooseManualParking(r,false);
    node.querySelector(".save-tour").onclick=()=>saveTour(r);
    node.querySelector(".start-tour").onclick=()=>startTour(r);
    host.appendChild(node);
  });
}

function initMap(){
  if(typeof L==="undefined")throw new Error("Leaflet/Kartenbibliothek nicht geladen.");
  state.layers={caches:L.layerGroup(),route:L.layerGroup()};
  state.map=L.map("map").setView([49.39875,8.672434],12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
    maxZoom:19, attribution:"© OpenStreetMap"
  }).addTo(state.map);
  state.layers.caches.addTo(state.map);
  state.layers.route.addTo(state.map);
}


function mapPlannerSelectedCaches(){
  return [...state.mapPlanner.selectedIds]
    .map(id=>state.caches.find(c=>c.id===id))
    .filter(Boolean);
}

function updateMapPlannerPanel(){
  const panel=$("#mapPlannerPanel");
  if(!panel)return;
  panel.classList.toggle("hidden",!state.mapPlanner.active);
  panel.classList.toggle("active",state.mapPlanner.active);
  const caches=mapPlannerSelectedCaches();
  $("#mapPlannerCount").textContent=`${caches.length} ausgewählt`;
  const host=$("#mapPlannerSelection");
  if(host){
    host.innerHTML=caches.length
      ? caches.map(c=>`<span class="map-plan-chip">${escapeHtml(c.id)} · ${escapeHtml(c.name)}</span>`).join("")
      : "Noch keine Caches ausgewählt.";
  }
  const calc=$("#mapPlanCalculate");
  if(calc)calc.disabled=caches.length===0;
}

function startMapPlanner(seedCurrent=false){
  state.mapPlanner.active=true;
  state.mapPlanner.selectedIds=new Set();
  state.mapPlanner.sourceRoute=null;

  if(seedCurrent && state.selectedRoute){
    state.mapPlanner.sourceRoute=state.selectedRoute;
    const seq=state.selectedRoute.real?.finalSequence || cacheSequence(state.selectedRoute);
    seq.forEach(c=>state.mapPlanner.selectedIds.add(c.id));
  }

  updateMapPlannerPanel();
  refreshCacheLayer();
  switchTab("karte");
  showToast(
    seedCurrent && state.selectedRoute
      ? "Aktuelle Route übernommen. Jetzt mehrere Caches an- oder abwählen; berechnet wird erst am Ende."
      : "Freie Kartenplanung gestartet. Tippe mehrere Cachemarker an und berechne anschließend einmal.",
    "success",6000
  );
}

function cancelMapPlanner(){
  state.mapPlanner.active=false;
  state.mapPlanner.selectedIds=new Set();
  state.mapPlanner.sourceRoute=null;
  updateMapPlannerPanel();
  refreshCacheLayer();
}

function clearMapPlanner(){
  state.mapPlanner.selectedIds=new Set();
  updateMapPlannerPanel();
  refreshCacheLayer();
}

function toggleMapPlannerCache(cacheId){
  if(!state.mapPlanner.active)return;
  const cache=state.caches.find(c=>c.id===cacheId);
  if(!cache)return;

  if(state.mapPlanner.selectedIds.has(cacheId)){
    state.mapPlanner.selectedIds.delete(cacheId);
  }else{
    const eligibility=cacheEligibleForManualRoute(cache);
    if(!eligibility.ok){
      showToast(`${cacheId} nicht auswählbar: ${eligibility.reason}.`,"warn",4500);
      return;
    }
    state.mapPlanner.selectedIds.add(cacheId);
  }
  updateMapPlannerPanel();
  refreshCacheLayer();
}

function approximateOpenChainDistance(seq){
  let km=0;
  for(let i=1;i<seq.length;i++)km+=haversine(seq[i-1],seq[i]);
  return km;
}

function nearestNeighborChain(caches,startIndex){
  const remaining=new Set(caches);
  const seq=[];
  let current=caches[startIndex];
  seq.push(current);
  remaining.delete(current);
  while(remaining.size){
    const next=[...remaining].sort((a,b)=>haversine(current,a)-haversine(current,b))[0];
    seq.push(next);
    remaining.delete(next);
    current=next;
  }
  return seq;
}

function twoOptOpenChain(seq){
  let best=[...seq];
  let bestDist=approximateOpenChainDistance(best);
  let improved=true;
  let passes=0;
  while(improved && passes<5){
    improved=false;
    passes++;
    for(let i=1;i<best.length-1;i++){
      for(let j=i+1;j<best.length;j++){
        const trial=[...best.slice(0,i),...best.slice(i,j+1).reverse(),...best.slice(j+1)];
        const d=approximateOpenChainDistance(trial);
        if(d+0.001<bestDist){
          best=trial;
          bestDist=d;
          improved=true;
        }
      }
    }
  }
  return best;
}

async function optimizeSelectedCacheOrder(caches,opts){
  if(caches.length<=2)return {seq:[...caches],violations:0,result:await footRouteSequence(caches)};

  const approx=[];
  const seedIndices=[...caches.keys()];
  for(const seed of seedIndices){
    const seq=twoOptOpenChain(nearestNeighborChain(caches,seed));
    const key=seq.map(c=>c.id).join(">");
    if(!approx.some(x=>x.key===key)){
      approx.push({key,seq,km:approximateOpenChainDistance(seq)});
      const rev=[...seq].reverse();
      approx.push({key:rev.map(c=>c.id).join(">"),seq:rev,km:approximateOpenChainDistance(rev)});
    }
  }
  approx.sort((a,b)=>a.km-b.km);

  let best=null;
  const tests=approx.slice(0,Math.min(6,approx.length));
  for(let i=0;i<tests.length;i++){
    setProgress(15+35*(i/Math.max(1,tests.length)),
      `Optimiere Cache-Reihenfolge ${i+1}/${tests.length} über echte Fußwege …`,
      "Freie Kartenplanung");
    try{
      const result=await footRouteSequence(tests[i].seq);
      const violations=violationDetailsForSequence(tests[i].seq,result.legDurations,opts);
      const score=violations.length*100000+(result.distance||0);
      if(!best || score<best.score){
        best={seq:tests[i].seq,result,violations:violations.length,violationDetails:violations,score};
      }
    }catch(e){}
    if(i<tests.length-1)await sleep(250);
  }
  return best;
}

async function calculateMapPlanner(){
  if(!state.mapPlanner.active || state.routeEditBusy)return;
  const caches=mapPlannerSelectedCaches();
  if(!caches.length){
    showToast("Wähle mindestens einen Cache aus.","warn");
    return;
  }

  const opts=getOpts(false);
  state.routeEditBusy=true;
  setProgress(8,`${caches.length} ausgewählte Caches werden optimiert …`,"Freie Kartenplanung");

  try{
    const optimized=await optimizeSelectedCacheOrder(caches,opts);
    if(!optimized)throw new Error("Für die Auswahl konnte keine Fußweg-Reihenfolge berechnet werden.");

    let allowViolations=false;
    if(optimized.violations>0){
      const details=optimized.violationDetails.slice(0,4)
        .map(v=>`${v.from} → ${v.to}: ${fmtMin(v.min)}`)
        .join("\n");
      allowViolations=confirm(
        `Die beste Reihenfolge enthält ${optimized.violations} Verbindung(en) über ${opts.maxGap} Minuten:\n\n${details}\n\n`+
        `OK = alle ausgewählten Caches trotzdem behalten.\nAbbrechen = automatische Reparatur darf unpassende Caches entfernen.`
      );
    }

    let route=state.mapPlanner.sourceRoute;
    if(!route){
      const centroid={
        lat:caches.reduce((a,c)=>a+c.lat,0)/caches.length,
        lon:caches.reduce((a,c)=>a+c.lon,0)/caches.length
      };
      route={
        id:`manual-map-${Date.now()}`,
        name:"Freie Kartenplanung",
        displayName:`Freie Runde · ${caches.length} Caches`,
        points:[...optimized.seq],
        stats:routeStats(optimized.seq,opts),
        startDistance:haversine(opts.start,centroid),
        score:0
      };
      state.routes.unshift(route);
    }else{
      route.points=[...optimized.seq];
      route.stats=routeStats(route.points,opts);
      route.real=null;
      route.manualParking=null;
      route.precheck=null;
      route.displayName=route.displayName||`Bearbeitete Runde · ${caches.length} Caches`;
    }

    route.manualAllowGapViolations=allowViolations;
    route.manualSelectionLocked=true;
    route.manualLockedCacheIds=caches.map(c=>c.id);
    state.selectedRoute=route;

    // Stop selection mode before drawing the result so normal cache popups return.
    state.mapPlanner.active=false;
    state.mapPlanner.selectedIds=new Set();
    state.mapPlanner.sourceRoute=null;
    updateMapPlannerPanel();
    refreshCacheLayer();

    const fakeButton={textContent:"Echtroute neu prüfen",disabled:false};
    const result=await refineRoute(route,fakeButton);
    if(result){
      const missing=missingLockedCaches(result,result.real?.finalSequence||cacheSequence(result));
      if(missing.length){
        showToast(`Fehler: ${missing.length} fixierte Cache(s) fehlen. Ergebnis wurde nicht als gültig bestätigt.`,"error",7000);
      }else{
        showToast(`Kartenplanung berechnet: alle ${caches.length} ausgewählten Caches enthalten · ${result.stats.km.toFixed(1)} km.`,"success",6000);
      }
    }
  }catch(e){
    failProgress(e.message||"Kartenplanung fehlgeschlagen");
    showToast(`Kartenplanung fehlgeschlagen: ${e.message}`,"error",6000);
  }finally{
    state.routeEditBusy=false;
  }
}

function refreshCacheLayer(){
  if(!state.map)return;
  state.layers.caches.clearLayers();

  state.caches.forEach(c=>{
    const health=cacheHealth(c);
    const selected=state.mapPlanner.active && state.mapPlanner.selectedIds.has(c.id);
    const color=selected
      ? "#17603f"
      : health.warn
        ? "#b42318"
        : c.found
          ? "#87968f"
          : c.type==="Lab"
            ? "#d97706"
          : c.type==="Mystery"
            ? "#7c3aed"
            : c.type==="Multi"
              ? "#2563eb"
              : "#16a34a";

    const marker=L.circleMarker([c.lat,c.lon],{
      radius:selected?10:(health.warn?8:6),
      color,
      fillColor:color,
      fillOpacity:selected?1:.85,
      weight:selected?4:(health.warn?3:2)
    });

    if(state.mapPlanner.active){
      marker.on("click",()=>{
        toggleMapPlannerCache(c.id);
      });
      marker.bindTooltip(selected?"✓":"+",{
        permanent:true,
        direction:"center",
        className:selected?"map-plan-selected-tooltip":"cache-warning-tooltip",
        offset:[0,0]
      });
    }else{
      marker.bindPopup(cachePopupHtml(c));
      if(health.warn){
        marker.bindTooltip("!",{permanent:true,direction:"center",className:"cache-warning-tooltip",offset:[0,0]});
      }
    }
    marker.addTo(state.layers.caches);
  });
}

function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g,ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function routeSequenceHtml(r,seq){
  const park=r.real?.parking;
  const items=[];
  if(park){
    items.push(`<div class="route-sequence-item route-sequence-parking">
      <div class="route-sequence-no">P</div>
      <div class="route-sequence-main"><strong>${escapeHtml(park.name||"Parkplatz")}</strong><span>${park.roadside?"Straßenrand-Fallback · Beschilderung prüfen":"Start der Runde"}</span>
        <div class="route-sequence-actions parking-move-action"><button class="ghost" onclick="window.cacheRundeMoveParking()">🅿 Parkplatz verschieben</button></div>
      </div>
      <div class="route-sequence-type">${park.roadside?"Straßenrand":"Parken"}</div>
    </div>`);
  }

  seq.forEach((c,i)=>{
    const health=cacheHealth(c);
    const warning=health.warn
      ? `<span class="route-sequence-warning">⚠ ${health.reasons.map(escapeHtml).join(" · ")}</span>`
      : "";
    const removeAction=seq.length>1
      ? `<div class="route-sequence-actions"><button class="ghost" onclick="window.cacheRundeRemoveFromRoute('${String(c.id).replace(/'/g,"\\'")}')">− Entfernen</button></div>`
      : "";
    items.push(`<div class="route-sequence-item">
      <div class="route-sequence-no">${health.warn?"!":i+1}</div>
      <div class="route-sequence-main"><strong>${i+1}. ${escapeHtml(c.id)} · ${escapeHtml(c.name)}</strong><span>D ${c.difficulty??"—"} · T ${c.terrain??"—"}${c.corrected?" · Final ✓":""}</span>${warning}${removeAction}</div>
      <div class="route-sequence-type">${escapeHtml(c.type||"Cache")}</div>
    </div>`);
  });

  if(park){
    items.push(`<div class="route-sequence-item route-sequence-parking">
      <div class="route-sequence-no">P</div>
      <div class="route-sequence-main"><strong>${escapeHtml(park.name||"Parkplatz")}</strong><span>Zurück zum Parkplatz</span></div>
      <div class="route-sequence-type">Ziel</div>
    </div>`);
  }

  return `<div class="route-sequence-panel">
    <div class="route-sequence-title"><strong>Reihenfolge für manuelle Navigation</strong><span class="pill">${seq.length} Caches</span></div>
    <div class="route-sequence-list">${items.join("")}</div>
    ${lockedSelectionHtml(r)}
    ${r.real?.manualParkingSequenceLocked?`<div class="parking-move-note"><strong>🅿 Manueller Parkplatz</strong>Der Parkplatz wurde manuell gesetzt; die Cache-Reihenfolge blieb beim Neuberechnen unverändert.</div>`:""}
    <div class="route-edit-hint"><strong>Route auf der Karte bearbeiten</strong>Andere Cachemarker können hinzugefügt, vorhandene über den roten „Entfernen“-Button oder direkt hier aus der Liste entfernt werden. Eine bestätigte Mehrfachauswahl wird als fixierte Auswahl behandelt: CacheRunde darf keinen ausgewählten Cache still entfernen.</div>
  </div>`;
}

function routeChangeHtml(r){
  if(!r.real?.preliminary)return "";
  const p=r.real.preliminary;
  const finalCount=r.stats?.cacheCount||0;
  const finalKm=r.stats?.km||0;
  const countChanged=p.cacheCount!==finalCount;
  const kmDiff=Math.abs((p.km||0)-finalKm);
  if(!countChanged && kmDiff<0.35){
    if(r.real.preservedAllCaches || r.real.repairReordered){
      return `<div class="route-change-note good">Echtrouting: alle ${finalCount} Caches behalten; Einstieg/Reihenfolge wurde an echte Fußwege angepasst.</div>`;
    }
    return "";
  }
  const removed=r.real.removedCaches?.length
    ? ` Entfernt: ${r.real.removedCaches.map(c=>escapeHtml(c.id)).join(", ")}.`
    : "";
  const label=p.source==="realistic-precheck"?"realistischen Vorprüfung":"Vorprüfung";
  return `<div class="route-change-note"><strong>Abweichung zur ${label}:</strong> ${p.cacheCount} Caches / ${p.km.toFixed(1)} km → ${finalCount} Caches / ${finalKm.toFixed(1)} km.${removed}</div>`;
}

function showRouteOnMap(r){
  state.selectedRoute=r;
  state.layers.route.clearLayers();
  let latlngs;
  if(r.real?.geometry?.coordinates?.length){
    latlngs=r.real.geometry.coordinates.map(c=>[c[1],c[0]]);
    L.polyline(latlngs,{weight:5}).addTo(state.layers.route);
    if(validRoutingPoint(r.real?.parking)){
      L.marker([r.real.parking.lat,r.real.parking.lon],{title:"Parkplatz"})
        .bindPopup(`<strong>${r.real.parking?.walkStart?"🚶":"🅿"} ${r.real.parking?.name||"Startpunkt"}</strong><br>Start und Ende der Wanderung${r.real.parking?.roadside?`<br><strong>⚠ Straßenrand-Fallback:</strong> Beschilderung und örtliche Parkregeln prüfen.`:""}`)
        .addTo(state.layers.route);
    }
  }else{
    latlngs=r.points.map(p=>[p.lat,p.lon]);
    L.polyline(latlngs,{weight:5,dashArray:"8,8"}).addTo(state.layers.route);
  }
  const seq=r.real?.finalSequence || cacheSequence(r);
  seq.forEach((p,i)=>{
    const health=cacheHealth(p);
    const icon=L.divIcon({
      className:`numbered-cache-marker${health.warn?" warning":""}`,
      html:`<div>${health.warn?"!":i+1}</div>`,
      iconSize:[28,28],
      iconAnchor:[14,14],
      popupAnchor:[0,-14]
    });
    L.marker([p.lat,p.lon],{title:`${i+1}. ${p.name}`,icon})
      .bindPopup(cachePopupHtml(p,i))
      .addTo(state.layers.route);
  });
  const b=L.latLngBounds(latlngs); state.map.fitBounds(b.pad(.2));
  const mode=r.real?"Echtroute":"Vorprüfung";
  const elevationBlock=r.real?.elevation
    ? `<div style="width:100%;margin-top:8px"><div class="pill real-badge">Höhenprofil verfügbar</div>${elevationSvg(r.real.elevation)}</div>`
    : `<div style="width:100%;margin-top:8px"><span class="pill warn-badge">Noch kein echtes Höhenprofil</span></div>`;
  $("#mapInfo").innerHTML=`<div style="width:100%"><strong>${escapeHtml(r.displayName||r.name)} · ${mode}</strong><br><span>${r.stats.km.toFixed(1)} km · ${fmtMin(r.stats.totalMin)} · ${r.stats.cacheCount} Caches · ↑ ${Math.round(r.stats.gain)} m · ↓ ${Math.round(r.stats.loss)} m</span><div class="rule-explain"><strong>Cache-Abstandsregel:</strong> ${getOpts(false).maxGap} Minuten gelten nur zwischen zwei aufeinanderfolgenden Caches. Parkplatz→erster Cache und letzter Cache→Parkplatz sind davon ausgenommen. Der Rückweg nach dem letzten Cache darf vollständig ohne weitere Caches zum Parkplatz führen. Manuell bearbeitete Routen können die Regel auf Wunsch übersteuern.</div>${routeChangeHtml(r)}${routeHealthHtml(r)}${elevationBlock}${routeSequenceHtml(r,seq)}</div>`;
  refreshCacheLayer();
  switchTab("karte");
}

function downloadRouteGPX(r){
  const esc=s=>String(s).replace(/[<>&'"]/g,ch=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[ch]));
  const seq=r.real?.finalSequence || cacheSequence(r);
  let trackPoints;
  if(r.real?.geometry?.coordinates?.length){
    trackPoints=r.real.geometry.coordinates.map(c=>({lon:c[0],lat:c[1]}));
  }else{
    trackPoints=r.points;
  }
  const trkpts=trackPoints.map(p=>`<trkpt lat="${p.lat}" lon="${p.lon}">${Number.isFinite(p.ele)?`<ele>${p.ele}</ele>`:""}</trkpt>`).join("");
  const cacheWpts=seq.map(p=>`<wpt lat="${p.lat}" lon="${p.lon}"><name>${esc(p.id)}</name><desc>${esc(p.name)}</desc><type>${esc(p.type)}</type></wpt>`).join("");
  const parkingWpt=(r.real && validRoutingPoint(r.real.parking))
    ? `<wpt lat="${r.real.parking.lat}" lon="${r.real.parking.lon}"><name>Parking</name><desc>${esc(r.real.parking?.name||"Startpunkt")}</desc><type>Parking Area</type></wpt>`
    : "";
  const gpx=`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="CacheRunde Prototype 0.2.0" xmlns="http://www.topografix.com/GPX/1/1">${parkingWpt}${cacheWpts}<trk><name>${esc(r.name)}</name><trkseg>${trkpts}</trkseg></trk></gpx>`;
  const blob=new Blob([gpx],{type:"application/gpx+xml"}); const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=`${r.name.replace(/\W+/g,"-").toLowerCase()}${r.real?"-echtroute":""}.gpx`; a.click(); URL.revokeObjectURL(url);
}

async function search(quick=false){
  const host=$(quick?"#quickResults":"#advancedResults");
  // Läuft noch ein Laden von geocaching.com, erst darauf warten (sonst wird mit alten Caches gesucht).
  if(state.gcLoading){
    host.innerHTML='<div class="card"><strong>Warte, bis die Caches von geocaching.com geladen sind …</strong></div>';
    try{await state.gcLoading;}catch(e){}
  }
  setProgress(10,"Filter werden angewendet …","Tourensuche");
  let opts=getOpts(quick);
  // Keine geladenen Caches um den Suchort? In der App automatisch von geocaching.com nachladen.
  if(isNativeApp()&&Number.isFinite(opts.start.lat)&&filteredCaches({...opts,excludeFound:false,tradis:true,mysteries:true,multis:true,labs:true}).length===0){
    host.innerHTML='<div class="card"><strong>Um den Suchort sind noch keine Caches geladen – lade sie von geocaching.com …</strong></div>';
    try{await loadCachesFromGeocaching();}catch(e){}
    opts=getOpts(quick);
  }
  state.routes=buildRoutes(opts);
  state.lastSearchInfo={
    place:($("#placeStatus")?.textContent||"").replace(/^Suchort:\s*/,"")||"Ausgangspunkt",
    radius:opts.radius,
    inRadius:filteredCaches(opts).length
  };

  if(state.routes.length && (opts.minCaches||0)>0){
    host.innerHTML=`<div class="card"><strong>Prüfe Mindestzahl ${opts.minCaches} mit echten Fußwegen …</strong><p class="muted">Nur Routen, bei denen nach realer Cacheketten-Prüfung mindestens ${opts.minCaches} Caches übrig bleiben, werden angezeigt.</p></div>`;
    state.routes=await validateMinimumCacheCount(state.routes,opts);
  }

  if(state.routes.length){
    host.innerHTML='<div class="card"><strong>Prüfe die besten Vorschläge vollständig: Fußwege + Parkplatz …</strong></div>';
    await precheckTopRoutes(state.routes,opts,4);
  }

  // Safety net: after any full preview, enforce the requested minimum once more.
  if((opts.minCaches||0)>0){
    state.routes=state.routes.filter(r=>{
      const count=r.precheck?.full
        ? (r.precheck.cacheCount||0)
        : (r.minCacheCheck?.finalCount||r.stats?.cacheCount||0);
      return count>=opts.minCaches;
    });
  }

  setProgress(80,`${state.routes.length} Routenkandidat(en) vorbereitet. Ermittle Ortsnamen …`,"Tourensuche");
  if(state.routes.length)host.innerHTML='<div class="card"><strong>Ermittle Ortsnamen …</strong></div>';
  await enrichRouteNames(state.routes);
  setProgress(90,"Ergebnisliste wird aufgebaut …","Tourensuche");
  renderRoutes(
    quick?"#quickResults":"#advancedResults",
    state.routes,
    quick?($("#quickSort")?.value||"quality"):($("#sortBy")?.value||"quality")
  );
  finishProgress(
    state.routes.length
      ? `${state.routes.length} Routenvorschlag/-vorschläge bereit.`
      : ((opts.minCaches||0)>0
          ? `Keine Route erfüllt nach echter Fußwegprüfung die Mindestzahl ${opts.minCaches}.`
          : "Keine passende Route gefunden.")
  );
}

function switchTab(name){
  $$(".tab").forEach(t=>t.classList.toggle("active",t.id===`tab-${name}`));
  $$(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));
  if(name==="karte" && state.map) setTimeout(()=>state.map?.invalidateSize(),60);
}

async function loadGPXFile(file){
  if(!file)return;
  setProgress(5,`Lese ${file.name} …`,"GPX-Import");
  try{
    const text=await file.text();
    if(!text || !/<gpx[\s>]/i.test(text)){
      throw new Error("Die gewählte Datei scheint keine gültige GPX-Datei zu sein.");
    }

    const parsed=parseGPX(text);
    if(!Array.isArray(parsed)){
      throw new Error("GPX-Datei konnte nicht ausgewertet werden.");
    }
    if(parsed.length===0){
      const xmlCheck=new DOMParser().parseFromString(text,"application/xml");
      if(xmlCheck.querySelector("parsererror")){
        throw new Error("Die GPX-Datei enthält ungültiges XML.");
      }
    }

    state.caches=mergeLabStations(parsed);
    setProgress(55,`${state.caches.length} Caches erkannt …`,"GPX-Import");
    const ignoredImportWaypoints=state.gpxImportStats?.ignoredWaypoints||0;
    $("#gpxStatus").textContent=ignoredImportWaypoints
      ? `${state.caches.length} Caches geladen · ${ignoredImportWaypoints} Zusatzwegpunkt(e) ignoriert`
      : `${state.caches.length} Caches geladen`;
    $("#miniCacheCount").textContent=state.caches.length;

    if(state.caches.length){
      const avg=state.caches.reduce(
        (a,c)=>({lat:a.lat+c.lat/state.caches.length,lon:a.lon+c.lon/state.caches.length}),
        {lat:0,lon:0}
      );
      state.cacheCentroid=avg;
      if(state.map){
        state.map.setView([avg.lat,avg.lon],13);
      }
      if(!state.originExplicit){
        setOrigin(avg.lat,avg.lon,"Automatisch: Mittelpunkt des importierten Cachegebiets",false);
      }
    }

    refreshCacheLayer();
    populateLogCacheSelect();
    updateTripDataStatus();
    try{refreshPersonalStats();}catch(e){}
    finishProgress(
      ignoredImportWaypoints
        ? `${state.caches.length} Caches importiert · ${ignoredImportWaypoints} Zusatzwegpunkt(e) verworfen.`
        : `${state.caches.length} Caches importiert.`
    );
    showToast(
      ignoredImportWaypoints
        ? `${state.caches.length} echte Caches importiert; ${ignoredImportWaypoints} Park-/Referenz-/Zusatzwegpunkt(e) ignoriert.`
        : `${state.caches.length} Caches erfolgreich importiert.`,
      "success",
      ignoredImportWaypoints?5200:3200
    );
  }catch(e){
    console.error("GPX import failed",e);
    $("#gpxStatus").textContent="GPX-Import fehlgeschlagen";
    failProgress(e.message||"GPX-Import fehlgeschlagen");
    showToast(`GPX-Import fehlgeschlagen: ${e.message||e}`,"error",6000);
  }
}

const ORIGIN_KEY="cacherunde-origin";
function setOrigin(lat,lon,label="Gewählter Punkt",explicit=true){
  $("#startLat").value=Number(lat).toFixed(6);
  $("#startLon").value=Number(lon).toFixed(6);
  $("#originStatus").textContent=`Ausgangspunkt: ${label}`;
  if(explicit)state.originExplicit=true;
  // Ein gemeinsamer Suchort für Tourensuche und geocaching.com (seit 0.20.1)
  const isDevice=/^Mein Standort/.test(label);
  try{
    if(explicit&&isDevice)localStorage.removeItem(ORIGIN_KEY);
    else if(explicit)localStorage.setItem(ORIGIN_KEY,JSON.stringify({lat:+lat,lon:+lon,label}));
  }catch(e){}
  const ps=$("#placeStatus");
  if(ps)ps.textContent=isDevice?`Suchort: dein Standort`:`Suchort: ${label}`;
  setTimeout(updateSuitableCount,0);
  const short=isDevice?"":String(label).split(",")[0];
  for(const id of ["#gcSearchPlace","#originSearch"]){
    const el=$(id);
    if(el&&document.activeElement!==el)el.value=short;
  }
  if(state.map && typeof L!=="undefined"){
    state.map.setView([lat,lon],13);
    if(state.originMarker)state.map.removeLayer(state.originMarker);
    state.originMarker=L.marker([lat,lon],{title:"Ausgangspunkt"}).addTo(state.map).bindPopup(`<strong>Ausgangspunkt</strong><br>${label}`);
  }
}

function useCacheAreaOrigin(){
  if(!state.cacheCentroid){alert("Noch keine GPX-Daten geladen.");return;}
  setOrigin(state.cacheCentroid.lat,state.cacheCentroid.lon,"Mittelpunkt des importierten Cachegebiets");
}

async function searchOrigin(){
  const q=$("#originSearch").value.trim(); if(!q)return;
  const host=$("#originMatches"); host.innerHTML='<div class="muted">Suche …</div>';
  try{
    const res=await fetch(`/api/geocode?q=${encodeURIComponent(q)}&limit=6`,{cache:"no-store"});
    const data=await res.json(); host.innerHTML="";
    const items=data.results||[];
    if(!items.length){host.innerHTML='<div class="muted">Keine Treffer.</div>';return;}
    items.forEach(item=>{
      const b=document.createElement("button");b.type="button";b.className="origin-match";
      b.textContent=item.display_name||item.name;
      b.onclick=()=>{pickSearchPlace(item);host.innerHTML=""};
      host.appendChild(b);
    });
  }catch(e){
    host.innerHTML='<div class="muted">Ortsuche nicht erreichbar. Standort oder Karte verwenden.</div>';
    showToast("Ortsuche ist derzeit nicht erreichbar.","warn");
  }
}
function enableMapOriginPick(){
  state.originPick=true; switchTab("karte"); $("#map").classList.add("map-pick-active");
  $("#mapInfo").innerHTML="<strong>Ausgangspunkt wählen</strong><span>Auf die gewünschte Stelle der Karte klicken.</span>";
}
function useCurrentLocation(){
  if(!navigator.geolocation){alert("Dieses Gerät kann keinen Standort liefern.");return;}
  $("#originStatus").textContent="Ausgangspunkt: Standort wird ermittelt …";
  navigator.geolocation.getCurrentPosition(pos=>{
    setOrigin(pos.coords.latitude,pos.coords.longitude,"Mein Standort");
  },err=>{
    $("#originStatus").textContent="Ausgangspunkt: Standort nicht verfügbar";
    alert(err&&err.code===1
      ?"Standortzugriff wurde verweigert. Bitte in den App- bzw. Browser-Einstellungen erlauben."
      :"Standort konnte nicht gelesen werden.");
  },{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
}

// Beim Start den aktuellen Standort als Ausgangspunkt übernehmen (still, ohne Fehlermeldung).
function restoreSavedOrigin(){
  try{
    const o=JSON.parse(localStorage.getItem(ORIGIN_KEY)||"null");
    if(o&&Number.isFinite(+o.lat)&&Number.isFinite(+o.lon)){
      setOrigin(+o.lat,+o.lon,o.label||"Gewählter Ort");
      return true;
    }
  }catch(e){}
  return false;
}

function autoLocateOrigin(){
  if(restoreSavedOrigin())return;
  if(!navigator.geolocation||state.originExplicit)return;
  $("#originStatus").textContent="Ausgangspunkt: Standort wird ermittelt …";
  navigator.geolocation.getCurrentPosition(pos=>{
    if(state.originExplicit)return; // Nutzer hat inzwischen selbst gewählt
    setOrigin(pos.coords.latitude,pos.coords.longitude,"Mein Standort (automatisch)");
  },()=>{
    if(!state.originExplicit)$("#originStatus").textContent="Ausgangspunkt: Standort nicht verfügbar – bitte Ort suchen oder auf der Karte wählen";
  },{enableHighAccuracy:false,timeout:12000,maximumAge:5*60000});
}



function populateLogCacheSelect(){
  const sel=$("#logCacheSelect");
  if(!sel)return;
  sel.innerHTML="";
  state.caches.filter(c=>c.type!=="Lab").slice(0,500).forEach(c=>{
    const o=document.createElement("option");
    o.value=c.id;
    o.textContent=`${c.id} · ${c.name}`;
    sel.appendChild(o);
  });
}



/* ---- Logbuch der Tour (seit 0.15.0) ----
   Logs werden unterwegs mit Zeitstempel gesammelt und am Ende auf einmal
   als Entwürfe (früher "Field Notes") zu geocaching.com hochgeladen. */

const LOG_TYPES=["Found it","Didn't find it","Write note","Needs Maintenance"];
const LOG_TYPE_LABELS={"Found it":"Gefunden","Didn't find it":"Nicht gefunden","Write note":"Notiz","Needs Maintenance":"Wartung nötig"};

function normalizePendingLog(l){
  return {
    id:l.id||`log-${Date.parse(l.date)||Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    cacheId:l.cacheId,
    name:l.name||state.caches.find(c=>c.id===l.cacheId)?.name||"",
    type:LOG_TYPES.includes(l.type)?l.type:"Write note",
    text:l.text||"",
    date:l.date||new Date().toISOString(),
    uploadedAt:l.uploadedAt||null
  };
}

function openLogs(){return state.pendingLogs.filter(l=>!l.uploadedAt);}

function addPendingLog(cacheId,type,text=""){
  const cache=state.caches.find(c=>c.id===cacheId);
  const log=normalizePendingLog({cacheId,type,text,name:cache?.name||"",date:new Date().toISOString()});
  state.pendingLogs.push(log);
  if(type==="Found it"&&cache){
    cache.found=true;
    markCacheCompleted(cache.id);
    refreshCacheLayer();
  }
  persistTourState();
  renderLogList();
  return log;
}

function updateLogQueueStatus(){
  const el=$("#logQueueStatus");
  if(!el)return;
  const open=openLogs().length,done=state.pendingLogs.length-open;
  el.textContent=open
    ? `${open} Log(s) bereit zum Hochladen${done?` · ${done} bereits hochgeladen`:""}.`
    : (done?`Alle ${done} Log(s) hochgeladen.`:"Noch keine Logs auf dieser Tour.");
  const n=$("#logCountBadge");
  if(n){n.textContent=open;n.classList.toggle("hidden",!open);}
}

function escapeHtmlText(s){
  return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function renderLogList(){
  const host=$("#logList");
  updateLogQueueStatus();
  if(!host)return;
  if(!state.pendingLogs.length){host.innerHTML='<div class="muted">Tippe auf der Karte bei einem Cache auf „Found it“, „DNF“ oder „Notiz“ – oder wähle oben einen Cache aus.</div>';return;}
  const rows=[...state.pendingLogs].sort((a,b)=>a.date.localeCompare(b.date)).map(l=>{
    const t=new Date(l.date).toLocaleString("de-DE",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
    const opts=LOG_TYPES.map(x=>`<option value="${x}"${x===l.type?" selected":""}>${LOG_TYPE_LABELS[x]}</option>`).join("");
    const dis=l.uploadedAt?" disabled":"";
    return `<div class="log-item${l.uploadedAt?" log-uploaded":""}" data-log="${escapeHtmlText(l.id)}">
      <div class="log-head"><strong>${escapeHtmlText(l.cacheId)}</strong> · ${escapeHtmlText(l.name)}<span class="muted"> · ${t}</span>
        ${l.uploadedAt?'<span class="pill">hochgeladen ✓</span>':""}</div>
      <div class="log-row">
        <select class="log-type"${dis}>${opts}</select>
        <button class="ghost log-del" title="Log löschen">Löschen</button>
      </div>
      <textarea class="log-text" rows="2" placeholder="Logtext (optional, kann auch später auf geocaching.com ergänzt werden)"${dis}>${escapeHtmlText(l.text)}</textarea>
    </div>`;
  });
  host.innerHTML=rows.join("");
}

function onLogListEvent(e){
  const item=e.target.closest(".log-item");
  if(!item)return;
  const log=state.pendingLogs.find(l=>l.id===item.dataset.log);
  if(!log)return;
  if(e.target.classList.contains("log-del")&&e.type==="click"){
    if(!log.uploadedAt&&!confirm(`Log für ${log.cacheId} löschen?`))return;
    state.pendingLogs=state.pendingLogs.filter(l=>l!==log);
  }else if(e.target.classList.contains("log-type")&&e.type==="change"){
    log.type=e.target.value;
  }else if(e.target.classList.contains("log-text")&&e.type==="input"){
    log.text=e.target.value;
    persistTourState();updateLogQueueStatus();
    return; // kein Neuaufbau während des Tippens
  }else return;
  persistTourState();
  renderLogList();
}

function queueLog(){
  const cacheId=$("#logCacheSelect").value;
  if(!cacheId){alert("Bitte Cache wählen.");return;}
  addPendingLog(cacheId,$("#logType").value,$("#logText").value.trim());
  $("#logText").value="";
  showToast(`Log für ${cacheId} vorgemerkt.`,"success",3000);
}

/* Feldnotiz-Datei: eine Zeile pro Log, UTF-16LE mit BOM (Format der GPS-Geräte). */
function fieldNotesText(logs){
  return logs.map(l=>{
    const when=new Date(l.date).toISOString().slice(0,16)+"Z";
    const text=String(l.text||"").replace(/\r?\n/g," ").replace(/"/g,'""');
    return `${l.cacheId},${when},${l.type},"${text}"`;
  }).join("\r\n")+"\r\n";
}
function utf16leBytes(str){
  const out=new Uint8Array(2+str.length*2);
  out[0]=0xFF;out[1]=0xFE;
  for(let i=0;i<str.length;i++){const c=str.charCodeAt(i);out[2+2*i]=c&255;out[3+2*i]=c>>8;}
  return out;
}

function exportFieldNotes(){
  const logs=openLogs();
  if(!logs.length){showToast("Keine offenen Logs zum Exportieren.","warn",3500);return;}
  const blob=new Blob([utf16leBytes(fieldNotesText(logs))],{type:"text/plain"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="geocache_visits.txt";
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  showToast("Datei gespeichert. Auf geocaching.com unter Entwürfe → „Upload drafts“ hochladen.","success",8000);
}

async function uploadLogsAsDrafts(){
  const logs=openLogs();
  if(!logs.length){showToast("Keine offenen Logs zum Hochladen.","warn",3500);return;}
  if(!isNativeApp()){exportFieldNotes();return;}
  const found=logs.filter(l=>l.type==="Found it").length;
  if(!confirm(`${logs.length} Log(s) als Entwürfe zu geocaching.com hochladen (${found} × gefunden)?\n\nDie Entwürfe erscheinen in deinem Account unter „Entwürfe“ bzw. in der Geocaching-App und werden erst veröffentlicht, wenn du sie dort abschickst.`))return;
  try{
    setProgress(20,`Lade ${logs.length} Log(s) hoch …`,"Entwürfe hochladen");
    const res=await fetch("/api/gc-drafts-upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:fieldNotesText(logs)})});
    const d=await res.json();
    if(!d.ok){
      if(d.loginRequired){
        failProgress("Nicht bei geocaching.com angemeldet.");
        if(confirm("Für das Hochladen musst du bei geocaching.com angemeldet sein. Jetzt anmelden?"))gcLogin();
        return;
      }
      throw new Error(d.message||"Hochladen fehlgeschlagen");
    }
    const now=new Date().toISOString();
    logs.forEach(l=>l.uploadedAt=now);
    persistTourState();
    renderLogList();
    finishProgress(`${logs.length} Entwurf/Entwürfe hochgeladen.`);
    showToast(`${logs.length} Log(s) als Entwürfe hochgeladen.${d.summary?" "+d.summary:""} Jetzt in der Geocaching-App oder auf geocaching.com unter „Entwürfe“ prüfen und abschicken.`,"success",10000);
  }catch(e){
    failProgress(e.message||String(e));
    showToast(`Hochladen fehlgeschlagen: ${e.message||e}. Die Logs bleiben gespeichert.`,"error",9000);
  }
}

function clearUploadedLogs(){
  const n=state.pendingLogs.length-openLogs().length;
  if(!n){showToast("Keine hochgeladenen Logs vorhanden.","warn",3000);return;}
  state.pendingLogs=openLogs();
  persistTourState();
  renderLogList();
}

async function openDraftsPage(){
  const url="https://www.geocaching.com/account/drafts";
  if(isNativeApp()&&window.CR_NATIVE?.gcOpenPage){
    try{await window.CR_NATIVE.gcOpenPage(url,"Entwürfe");return;}catch(e){}
  }
  window.open(url,"_blank");
}

function persistTourState(){
  localStorage.setItem("cacherunde-data-version",String(DATA_VERSION));
  localStorage.setItem("cacherunde-saved-tours",JSON.stringify(state.savedTours));
  localStorage.setItem("cacherunde-pending-logs",JSON.stringify(state.pendingLogs));
  localStorage.setItem("cacherunde-active-tour",JSON.stringify(state.activeTour));
  localStorage.setItem("cacherunde-saved-trips",JSON.stringify(state.savedTrips));
}

function loadTourState(){
  state.savedTours=safeJsonParse(localStorage.getItem("cacherunde-saved-tours"),[]);
  state.pendingLogs=safeJsonParse(localStorage.getItem("cacherunde-pending-logs"),[]);
  state.activeTour=safeJsonParse(localStorage.getItem("cacherunde-active-tour"),null);
  state.savedTrips=safeJsonParse(localStorage.getItem("cacherunde-saved-trips"),[]);
  if(!Array.isArray(state.savedTours))state.savedTours=[];
  if(!Array.isArray(state.savedTrips))state.savedTrips=[];
  if(!Array.isArray(state.pendingLogs))state.pendingLogs=[];
  state.pendingLogs=state.pendingLogs.filter(l=>l&&l.cacheId).map(normalizePendingLog);
  renderLogList();
  renderSavedTours();
  renderSavedTrips();
  renderActiveTour();
}

function serializableTour(r){
  return {
    id:r.id||`saved-${Date.now()}`,
    name:r.name,
    displayName:r.displayName||r.name,
    stats:r.stats,
    points:r.points,
    real:r.real||null,
    manualAllowGapViolations:!!r.manualAllowGapViolations,
    manualSelectionLocked:!!r.manualSelectionLocked,
    manualLockedCacheIds:Array.isArray(r.manualLockedCacheIds)?[...r.manualLockedCacheIds]:[],
    savedAt:new Date().toISOString()
  };
}

function saveTour(r){
  const t=serializableTour(r);
  const idx=state.savedTours.findIndex(x=>x.id===t.id);
  if(idx>=0)state.savedTours[idx]=t;
  else state.savedTours.unshift(t);
  persistTourState();
  renderSavedTours();
  showToast("Tour gespeichert.","success");
}

function startTour(r){
  const t=serializableTour(r);
  const seq=t.real?.finalSequence || cacheSequence(t);
  state.activeTour={
    ...t,
    status:"active",
    startedAt:new Date().toISOString(),
    completedCacheIds:[],
    sequenceIds:seq.map(c=>c.id)
  };
  persistTourState();
  renderActiveTour();
  showRouteOnMap(t);
  switchTab("karte");
}

function activeSeq(){
  if(!state.activeTour)return [];
  return state.activeTour.real?.finalSequence || cacheSequence(state.activeTour);
}

function activeProgressStats(){
  const t=state.activeTour;
  if(!t)return {remainingCaches:0,remainingKm:0,remainingTime:0,found:0};
  const seq=activeSeq();
  const done=new Set(t.completedCacheIds||[]);
  const remainingCaches=seq.filter(c=>!done.has(c.id)).length;
  const ratio=seq.length?remainingCaches/seq.length:0;
  return {
    remainingCaches,
    remainingKm:(t.stats?.km||0)*ratio,
    remainingTime:(t.stats?.totalMin||0)*ratio,
    found:done.size
  };
}

function renderActiveTour(){
  const panel=$("#activeTourPanel");
  if(!panel)return;
  if(!state.activeTour){panel.classList.add("hidden");return;}
  panel.classList.remove("hidden");
  $("#activeTourName").textContent=state.activeTour.displayName||state.activeTour.name||"Aktive Tour";
  $("#activeTourState").textContent=state.activeTour.status||"active";
  const s=activeProgressStats();
  $("#activeRemainingCaches").textContent=s.remainingCaches;
  $("#activeRemainingKm").textContent=`${s.remainingKm.toFixed(1)} km`;
  $("#activeRemainingTime").textContent=fmtMin(s.remainingTime);
  $("#activeFoundCount").textContent=s.found;
}

function pauseTour(){
  if(!state.activeTour)return;
  state.activeTour.status="paused";
  persistTourState();
  renderActiveTour();
}

function resumeTour(){
  if(!state.activeTour)return;
  state.activeTour.status="active";
  persistTourState();
  renderActiveTour();
}

function finishTour(){
  if(!state.activeTour)return;
  state.activeTour.status="finished";
  persistTourState();
  renderActiveTour();
  setTimeout(()=>{
    state.activeTour=null;
    persistTourState();
    renderActiveTour();
  },700);
}

function renderSavedTours(){
  const host=$("#savedTours");
  if(!host)return;
  host.innerHTML="";
  const q=($("#savedTourSearch")?.value||"").trim().toLowerCase();
  const mode=$("#savedTourSort")?.value||"recent";
  let tours=[...state.savedTours].filter(t=>(t.displayName||t.name||"").toLowerCase().includes(q));
  tours.sort((a,b)=>{
    if(mode==="name")return (a.displayName||a.name||"").localeCompare(b.displayName||b.name||"");
    if(mode==="distance")return (a.stats?.km||0)-(b.stats?.km||0);
    if(mode==="caches")return (b.stats?.cacheCount||0)-(a.stats?.cacheCount||0);
    return new Date(b.savedAt||0)-new Date(a.savedAt||0);
  });
  if(!tours.length){
    host.innerHTML='<div class="muted">Keine gespeicherte Tour passend zur Auswahl.</div>';
    return;
  }
  tours.forEach(t=>{
    const card=document.createElement("article");
    card.className="route-card card";
    card.innerHTML=`<div class="route-head"><div><span class="rank">Gespeichert</span><h3>${t.displayName||t.name}</h3></div><span class="pill">${t.stats?.cacheCount||0} Caches</span></div>
      <div class="route-metrics">
        <div class="metric"><strong>${(t.stats?.km||0).toFixed(1)} km</strong><span>Strecke</span></div>
        <div class="metric"><strong>${fmtMin(t.stats?.totalMin||0)}</strong><span>Dauer</span></div>
      </div>
      <div class="route-actions">
        <button class="ghost saved-map">Karte</button>
        <button class="primary saved-start">Starten</button>
        <button class="ghost saved-rename">Umbenennen</button>
        <button class="ghost saved-copy">Duplizieren</button>
        <button class="ghost saved-delete">Löschen</button>
      </div>`;
    card.querySelector(".saved-map").onclick=()=>showRouteOnMap(t);
    card.querySelector(".saved-start").onclick=()=>startTour(t);
    card.querySelector(".saved-rename").onclick=()=>renameSavedTour(t);
    card.querySelector(".saved-copy").onclick=()=>duplicateSavedTour(t);
    card.querySelector(".saved-delete").onclick=()=>{
      state.savedTours=state.savedTours.filter(x=>x.id!==t.id);persistTourState();renderSavedTours();
    };
    host.appendChild(card);
  });
}

function markCacheCompleted(cacheId){
  if(!state.activeTour)return;
  const set=new Set(state.activeTour.completedCacheIds||[]);
  set.add(cacheId);
  state.activeTour.completedCacheIds=[...set];
  persistTourState();
  renderActiveTour();
}


function cacheEligibleForManualRoute(cache){
  if(!cache || cache.found)return {ok:false,reason:"bereits gefunden"};
  if(cache.type==="Multi")return {ok:false,reason:"Multicache ist standardmäßig ausgeschlossen"};
  if(cache.type==="Mystery" && !cache.corrected)return {ok:false,reason:"Mystery ohne erkanntes Final"};
  if(!["Traditional","Mystery","Lab"].includes(cache.type))return {ok:false,reason:"Cachetyp nicht für die Runde freigegeben"};
  return {ok:true,reason:""};
}

function routeContainsCache(route,cacheId){
  const seq=route?.real?.finalSequence || (route?cacheSequence(route):[]);
  return seq.some(c=>c.id===cacheId);
}

function bestInsertionIndex(seq,cache){
  if(seq.length<=1)return seq.length;
  let bestIndex=seq.length;
  let bestDelta=Infinity;

  // Treat the cache order as a round. Parking optimization can later choose
  // which edge becomes the break.
  for(let i=0;i<seq.length;i++){
    const a=seq[i],b=seq[(i+1)%seq.length];
    const delta=haversine(a,cache)+haversine(cache,b)-haversine(a,b);
    if(delta<bestDelta){
      bestDelta=delta;
      bestIndex=i+1;
    }
  }
  return bestIndex;
}


async function findBestRealInsertion(seq,cache,opts){
  if(!seq.length)return {seq:[cache],mode:"single",violations:0,score:0};

  let best=null;
  let bestFallback=null;
  const positions=[];
  positions.push({index:0,left:null,right:seq[0]});
  for(let i=1;i<seq.length;i++){
    positions.push({index:i,left:seq[i-1],right:seq[i]});
  }
  positions.push({index:seq.length,left:seq[seq.length-1],right:null});

  for(let pi=0;pi<positions.length;pi++){
    const pos=positions[pi];
    let leftSec=0,rightSec=0,leftOk=true,rightOk=true;
    try{
      if(pos.left){
        const r=await footRouteRequest([pos.left,cache],false);
        leftSec=r.duration||0;
        leftOk=leftSec<=opts.maxGap*60;
      }
      if(pos.right){
        const r=await footRouteRequest([cache,pos.right],false);
        rightSec=r.duration||0;
        rightOk=rightSec<=opts.maxGap*60;
      }
    }catch(e){
      continue;
    }

    const inserted=[...seq.slice(0,pos.index),cache,...seq.slice(pos.index)];
    const violations=(leftOk?0:1)+(rightOk?0:1);
    const score=leftSec+rightSec+violations*100000;
    const info={
      seq:inserted,
      mode:(pos.index===0||pos.index===seq.length)?"chain-end":"internal",
      violations,score,left:pos.left,right:pos.right,leftSec,rightSec
    };

    if(violations===0 && (!best||score<best.score))best=info;
    if(!bestFallback || Math.max(leftSec,rightSec)<Math.max(bestFallback.leftSec,bestFallback.rightSec)){
      bestFallback=info;
    }
    if(pi<positions.length-1)await sleep(250);
  }
  return best||bestFallback;
}

async function precheckCandidateRoute(route,opts){
  const originalSeq=cacheSequence(route);
  if(originalSeq.length<1)return route;

  try{
    // Use the SAME repair logic as the later Echtroute. This means cache count and
    // sequence should no longer change dramatically after the user clicks refine.
    let repaired;
    if(route.prevalidatedSequence?.length && route.prevalidatedResult){
      repaired={
        seq:route.prevalidatedSequence,
        result:route.prevalidatedResult,
        removed:route.minCacheCheck?.removedCaches||[],
        reordered:false,
        violations:0,
        violationDetails:[]
      };
    }else{
      repaired=await routeAndRepairSequence(originalSeq,opts,null,{allowViolations:false});
    }
    let finalSeq=repaired.seq;
    let cacheReal=repaired.result;
    if(!finalSeq?.length || !cacheReal)throw new Error("Keine belastbare Cachekette");

    let parkings=[];
    let parking=null;
    try{
      const parkingPromise=isWalkFromStart(opts)
        ? Promise.resolve([walkStartPoint(opts)])
        : findParkingCandidates(finalSeq[0],finalSeq[finalSeq.length-1],finalSeq,opts.parkingMode||"fallback");
      const timeoutPromise=new Promise((_,reject)=>setTimeout(()=>reject(new Error("preview-parking-timeout")),8500));
      parkings=await Promise.race([parkingPromise,timeoutPromise]);
      parking=parkings?.[0]||null;
    }catch(e){}

    if(!parking){
      parking={...finalSeq[0],name:"Vorläufig: Start am ersten Cache",parkingScore:null,previewFallback:true};
    }

    // Reuse the same parking/entry optimizer, just with fewer expensive real tests.
    let parkingPlan=null;
    if(parkings.length){
      parkingPlan=await optimizeParkingAndEntry(finalSeq,parkings,opts,null,cacheReal,3,false);
    }

    let toFirst,fromLast;
    let entryCacheId=finalSeq[0]?.id||null;
    let walkingDirection="vorwärts";

    if(parkingPlan){
      parking=parkingPlan.parking;
      finalSeq=parkingPlan.seq;
      cacheReal=parkingPlan.cacheReal;
      toFirst=parkingPlan.toFirst;
      fromLast=parkingPlan.fromLast;
      entryCacheId=parkingPlan.entryCacheId;
      walkingDirection=parkingPlan.direction;
    }else{
      toFirst=(parking.lat===finalSeq[0].lat && parking.lon===finalSeq[0].lon)
        ? {distance:0,duration:0,geometry:{coordinates:[[parking.lon,parking.lat]]}}
        : await footRouteRequest([parking,finalSeq[0]],false);
      fromLast=await footRouteRequest([finalSeq[finalSeq.length-1],parking],false);
    }

    const walkingDistance=(toFirst.distance||0)+(cacheReal.distance||0)+(fromLast.distance||0);
    const walkingDuration=(toFirst.duration||0)+(cacheReal.duration||0)+(fromLast.duration||0);
    const totalDuration=walkingDuration+finalSeq.length*opts.stopTime*60;
    const geometry={
      type:"LineString",
      coordinates:mergeGeometries(toFirst.geometry,cacheReal.geometry,fromLast.geometry)
    };

    route.precheck={
      checked:true,
      full:true,
      originalCacheCount:originalSeq.length,
      finalSequence:finalSeq,
      cacheCount:finalSeq.length,
      removedCaches:repaired.removed||[],
      reordered:!!repaired.reordered,
      cacheDistance:cacheReal.distance||0,
      cacheDuration:cacheReal.duration||0,
      walkingDistance,
      walkingDuration,
      totalDuration,
      parking,
      parkingAutomatic:parkings.length>0,
      parkingCandidates:parkings.length,
      entryCacheId,
      walkingDirection,
      maxCacheLegSec:Math.max(0,...(cacheReal.legDurations||[])),
      violations:repaired.violations||0,
      violationDetails:repaired.violationDetails||[],
      overlapRatio:overlapRatio(geometry.coordinates),
      geometry,
      checkedAt:new Date().toISOString()
    };
  }catch(e){
    route.precheck={checked:false,full:false,error:e.message||String(e)};
  }
  return route;
}


async function validateMinimumCacheCount(routes,opts){
  const minCaches=opts.minCaches||0;
  if(minCaches<=0)return routes;

  const kept=[];
  for(let i=0;i<routes.length;i++){
    const route=routes[i];
    setProgress(
      38+14*(i/Math.max(1,routes.length)),
      `Prüfe Mindestzahl ${minCaches}: Kandidat ${i+1}/${routes.length} über echte Fußwege …`,
      "Tourensuche"
    );

    try{
      const originalSeq=cacheSequence(route);
      const repaired=await routeAndRepairSequence(originalSeq,opts,null,{allowViolations:false});
      const finalCount=repaired.seq?.length||0;

      route.minCacheCheck={
        checked:true,
        requested:minCaches,
        originalCount:originalSeq.length,
        finalCount,
        removedCaches:repaired.removed||[],
        finalSequence:repaired.seq||[],
        result:repaired.result||null,
        passed:finalCount>=minCaches
      };

      if(finalCount>=minCaches){
        // Reuse the already repaired cache chain during the later full preview.
        route.prevalidatedSequence=repaired.seq;
        route.prevalidatedResult=repaired.result;
        kept.push(route);
      }
    }catch(e){
      route.minCacheCheck={
        checked:false,
        requested:minCaches,
        originalCount:cacheSequence(route).length,
        finalCount:0,
        passed:false,
        error:e.message||String(e)
      };
    }

    if(i<routes.length-1)await sleep(250);
  }
  return kept;
}

function minCacheCheckHtml(r){
  const c=r.minCacheCheck;
  if(!c)return "";
  if(c.passed){
    const changed=c.originalCount!==c.finalCount
      ? ` · reale Prüfung ${c.originalCount} → ${c.finalCount}`
      : "";
    return `<div class="min-cache-check">✓ Mindestzahl ${c.requested} verbindlich geprüft${changed}</div>`;
  }
  return "";
}

async function precheckTopRoutes(routes,opts,limit=4){
  const top=routes.slice(0,Math.min(limit,routes.length));
  for(let i=0;i<top.length;i++){
    setProgress(52+30*(i/Math.max(1,top.length)),
      `Berechne realistische Vorprüfung ${i+1}/${top.length}: Fußwege + Parkplatz …`,
      "Tourensuche");
    await precheckCandidateRoute(top[i],opts);
    if(i<top.length-1)await sleep(300);
  }

  // Full previews first, then fewest violations, then shortest real total walking route.
  routes.sort((a,b)=>{
    const af=a.precheck?.full?0:1, bf=b.precheck?.full?0:1;
    if(af!==bf)return af-bf;
    const av=a.precheck?.violations??999, bv=b.precheck?.violations??999;
    if(av!==bv)return av-bv;
    const ad=a.precheck?.walkingDistance??Infinity, bd=b.precheck?.walkingDistance??Infinity;
    if(ad!==bd)return ad-bd;
    return a.startDistance-b.startDistance;
  });
  return routes;
}

function previewStats(r){
  if(r.real){
    return {
      km:r.stats?.km||0,
      totalMin:r.stats?.totalMin||0,
      cacheCount:r.stats?.cacheCount||0,
      gain:r.stats?.gain||0,
      loss:r.stats?.loss||0
    };
  }
  const p=r.precheck;
  if(p?.full){
    return {
      km:(p.walkingDistance||0)/1000,
      totalMin:(p.totalDuration||0)/60,
      cacheCount:p.cacheCount||0,
      gain:r.stats?.gain||0,
      loss:r.stats?.loss||0
    };
  }
  return {
    km:r.stats?.km||0,
    totalMin:r.stats?.totalMin||0,
    cacheCount:r.stats?.cacheCount||0,
    gain:r.stats?.gain||0,
    loss:r.stats?.loss||0
  };
}

function precheckHtml(r,opts){
  const p=r.precheck;
  if(!p)return `<div class="route-precheck warn">Schnellschätzung – realistische Vorprüfung noch nicht durchgeführt.</div>`;
  if(!p.checked)return `<div class="route-precheck warn">Realistische Vorprüfung nicht verfügbar${p.error?`: ${escapeHtml(p.error)}`:""}.</div>`;

  if(p.full){
    const removed=p.removedCaches?.length
      ? `<br>⚠ ${p.removedCaches.length} Cache(s) bereits in der Vorprüfung entfernt: ${p.removedCaches.map(c=>escapeHtml(c.id)).join(", ")}`
      : "";
    const parking=p.parking?.previewFallback
      ? "vorläufiger Start am ersten Cache"
      : escapeHtml(p.parking?.name||"Parkplatz");
    return `<div class="preview-real-box${p.violations?" warn":""}">
      <strong>✓ Realistische Vorprüfung: ${p.cacheCount} Caches · ${(p.walkingDistance/1000).toFixed(1)} km · ${fmtMin(p.totalDuration/60)}</strong>
      Echte Fußwege + Hin-/Rückweg · Start: ${parking}<br>
      max. Cache→Cache: ${fmtMin(p.maxCacheLegSec/60)}${p.entryCacheId?` · Einstieg ${escapeHtml(p.entryCacheId)}`:""}${removed}
      <div class="preview-delta">Die Echtroute verwendet diese Cachefolge als Ausgangsbasis; größere Sprünge sollten nur noch durch genauere Parkplatzoptimierung oder alternative Rückwege entstehen.</div>
    </div>`;
  }

  if(p.violations===0){
    return `<div class="route-precheck">✓ Echte Cache→Cache-Wege vorgeprüft · max. ${fmtMin(p.maxCacheLegSec/60)} · Cachekette ${(p.cacheDistance/1000).toFixed(1)} km</div>`;
  }
  const detail=(p.violationDetails||[]).slice(0,2).map(v=>`${v.from}→${v.to}: ${fmtMin(v.min)}`).join(" · ");
  return `<div class="route-precheck warn">⚠ ${p.violations} reale Verbindung(en) über ${opts.maxGap} min${detail?` · ${detail}`:""}</div>`;
}

async function addCacheToSelectedRoute(cacheId){
  const route=state.selectedRoute;
  if(!route || state.routeEditBusy)return;
  const cache=state.caches.find(c=>c.id===cacheId);
  if(!cache)return;

  const eligibility=cacheEligibleForManualRoute(cache);
  if(!eligibility.ok){
    showToast(`Cache kann nicht eingefügt werden: ${eligibility.reason}.`,"warn",5000);
    return;
  }
  if(routeContainsCache(route,cacheId)){
    showToast(`${cacheId} ist bereits Teil der Runde.`,"warn");
    return;
  }

  const current=route.real?.finalSequence || cacheSequence(route);
  const opts=getOpts(false);
  state.routeEditBusy=true;
  showToast(`Prüfe alle möglichen Einfügepositionen für ${cacheId} mit echten Fußwegen …`,"info",5000);

  try{
    const insertion=await findBestRealInsertion(current,cache,opts);
    if(!insertion){
      showToast(`${cacheId}: Fußwege konnten nicht geprüft werden.`,"error",5000);
      return;
    }

    let allowViolations=false;
    if(insertion.violations>0){
      const leftText=insertion.left
        ? `${insertion.left.id} → ${cacheId}: ${fmtMin(insertion.leftSec/60)}`
        : `${cacheId} als erster Cache`;
      const rightText=insertion.right
        ? `${cacheId} → ${insertion.right.id}: ${fmtMin(insertion.rightSec/60)}`
        : `${cacheId} als letzter Cache`;
      const msg=`${cacheId} passt nach echter Fußwegprüfung in keine Position vollständig unter ${opts.maxGap} Minuten.\n\n`+
        `Beste gefundene Einfügung:\n${leftText}\n${rightText}\n\n`+
        `Trotzdem einfügen und die Cache-Abstandsregel für diese manuell bearbeitete Route übersteuern?`;
      allowViolations=confirm(msg);
      if(!allowViolations){
        showToast(`${cacheId} nicht eingefügt. Die genaue problematische Verbindung wurde angezeigt.`,"warn",5500);
        return;
      }
    }

    route.points=[...insertion.seq,insertion.seq[0]];
    route.real=null;
    route.manualParking=null;
    route.manualAllowGapViolations=allowViolations;
    route.manualSelectionLocked=true;
    route.manualLockedCacheIds=insertion.seq.map(c=>c.id);
    route.stats=routeStats(route.points,opts);

    refreshCacheLayer();
    showRouteOnMap(route);

    if(insertion.mode==="chain-end" && !allowViolations){
      showToast(`${cacheId} passt am Anfang/Ende der Cachekette. Der Rückweg zum Parkplatz darf cachefrei sein.`,"success",5500);
    }else if(allowViolations){
      showToast(`${cacheId} wird mit manueller Regelabweichung beibehalten. Echtroute wird neu berechnet …`,"warn",5500);
    }else{
      showToast(`${cacheId} passt nach echter Fußwegprüfung. Echtroute wird neu berechnet …`,"success",4500);
    }

    const fakeButton={textContent:"Echtroute neu prüfen",disabled:false};
    const result=await refineRoute(route,fakeButton);
    const stillIncluded=(route.real?.finalSequence||cacheSequence(route)).some(c=>c.id===cacheId);
    if(result && stillIncluded){
      showToast(`${cacheId} wurde in die Runde übernommen.`,"success",4500);
    }
  }finally{
    state.routeEditBusy=false;
    refreshCacheLayer();
  }
}

window.cacheRundeAddToRoute=(cacheId)=>addCacheToSelectedRoute(cacheId);

async function removeCacheFromSelectedRoute(cacheId){
  const route=state.selectedRoute;
  if(!route || state.routeEditBusy)return;

  const current=route.real?.finalSequence || cacheSequence(route);
  if(!current.some(c=>c.id===cacheId)){
    showToast(`${cacheId} ist nicht Teil der aktuellen Runde.`,"warn");
    return;
  }
  if(current.length<=1){
    showToast("Der letzte Cache kann nicht entfernt werden. Entferne stattdessen die gesamte Tour.","warn",5000);
    return;
  }

  const cache=current.find(c=>c.id===cacheId);
  const next=current.filter(c=>c.id!==cacheId);
  const ok=confirm(`${cacheId}${cache?.name?` · ${cache.name}`:""} aus der aktuellen Runde entfernen und neu berechnen?`);
  if(!ok)return;

  route.points=[...next,next[0]];
  route.real=null;
  route.manualParking=null;
  route.manualAllowGapViolations=false;
  if(Array.isArray(route.manualLockedCacheIds)){
    route.manualLockedCacheIds=route.manualLockedCacheIds.filter(id=>id!==cacheId);
    route.manualSelectionLocked=route.manualLockedCacheIds.length>0;
  }
  route.stats=routeStats(route.points,getOpts(false));

  state.routeEditBusy=true;
  refreshCacheLayer();
  showRouteOnMap(route);
  showToast(`${cacheId} entfernt. Route und Parkplatz werden neu berechnet …`,"success",4500);

  const fakeButton={textContent:"Echtroute neu prüfen",disabled:false};
  try{
    const result=await refineRoute(route,fakeButton);
    if(result){
      showToast(`${cacheId} entfernt und Echtroute neu berechnet.`,"success",4500);
    }
  }finally{
    state.routeEditBusy=false;
    refreshCacheLayer();
  }
}
window.cacheRundeRemoveFromRoute=(cacheId)=>removeCacheFromSelectedRoute(cacheId);


function correctedInfoHtml(cache){
  if(cache.correctedSource==="geocaching.com"&&Number.isFinite(+cache.postedLat)){
    const m=Math.round(haversine({lat:+cache.postedLat,lon:+cache.postedLon},cache)*1000);
    return `Gelöst ✓ <span class="muted">– deine korrigierten Koordinaten auf geocaching.com, ${m>=1000?(m/1000).toFixed(1)+" km":m+" m"} vom Listing · <a href="https://coord.info/${encodeURIComponent(cache.id)}" target="_blank" rel="noopener">Listing</a></span>`;
  }
  return `Final vorhanden ✓ <span class="muted">– aus der GPX-Datei</span>`;
}

function cachePopupHtml(cache,index=null){
  const isDone=state.activeTour?.completedCacheIds?.includes(cache.id);
  const safeId=String(cache.id).replace(/'/g,"\\'");
  const health=cacheHealth(cache);
  const warning=health.warn
    ? `<div class="cache-health-warning">⚠ ${health.reasons.map(escapeHtml).join(" · ")}</div>`
    : "";

  let routeEdit="";
  if(state.selectedRoute){
    const eligible=cacheEligibleForManualRoute(cache);
    const already=routeContainsCache(state.selectedRoute,cache.id);
    if(!already && eligible.ok){
      routeEdit=`<button class="cache-add-route" onclick="window.cacheRundeAddToRoute('${safeId}')">＋ Sofort hinzufügen & neu berechnen</button>`;
    }else if(already){
      const routeCount=(state.selectedRoute.real?.finalSequence || cacheSequence(state.selectedRoute)).length;
      routeEdit=`<div class="muted" style="margin-top:6px">✓ Bereits in der aktuellen Route</div>`+
        `${routeCount>1?`<button class="cache-remove-route route-edit-primary" onclick="window.cacheRundeRemoveFromRoute('${safeId}')">− Aus aktueller Route entfernen & neu berechnen</button>`:""}`;
    }else{
      routeEdit=`<div class="muted" style="margin-top:6px">Nicht einfügbar: ${escapeHtml(eligible.reason)}</div>`;
    }
  }

  return `<div class="cache-detail-card">
    <strong>${index!=null?`${index+1}. `:""}${escapeHtml(cache.name)}</strong><br>
    ${cache.type==="Lab"
      ? `Adventure-Lab-Station${cache.adventure?` · ${escapeHtml(cache.adventure)}`:""}<br><span class="muted">Loggen in der Adventure-Lab-App</span><br>`
      : `${escapeHtml(cache.id)} · ${escapeHtml(cache.type)}<br>D ${cache.difficulty??"—"} · T ${cache.terrain??"—"}<br>`}
    ${cache.corrected?correctedInfoHtml(cache):""}
    ${warning}
    ${routeEdit}
    ${cache.type==="Lab"?labPopupActions(cache):`<div class="cache-detail-actions">
      <button onclick="window.cacheRundeLog('${safeId}','Found it')">Found it</button>
      <button onclick="window.cacheRundeLog('${safeId}','Didn\\'t find it')">DNF</button>
      <button onclick="window.cacheRundeLog('${safeId}','Write note')">Notiz</button>
      <button onclick="window.cacheRundeDone('${safeId}')">${isDone?"Erledigt ✓":"Als erledigt markieren"}</button>
    </div>`}
  </div>`;
}

window.cacheRundeLog=(cacheId,type)=>{
  const dup=openLogs().find(l=>l.cacheId===cacheId&&l.type===type);
  if(dup&&!confirm(`Für ${cacheId} ist schon ein Log „${LOG_TYPE_LABELS[type]||type}“ vorgemerkt. Noch einen anlegen?`))return;
  addPendingLog(cacheId,type);
  try{state.map?.closePopup();}catch(e){}
  showToast(`${cacheId}: „${LOG_TYPE_LABELS[type]||type}“ um ${new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})} vorgemerkt. Text kannst du unter „Ich“ → Logbuch ergänzen.`,"success",5000);
};

window.cacheRundeDone=(cacheId)=>markCacheCompleted(cacheId);

window.cacheRundeMoveParking=()=>{
  if(!state.selectedRoute){
    showToast("Keine Route gewählt.","warn");
    return;
  }
  // For free/map-planned routes, preserve the exact current cache order.
  const lockSequence=!!state.selectedRoute.manualSelectionLocked ||
    String(state.selectedRoute.id||"").startsWith("manual-map-");
  chooseManualParking(state.selectedRoute,lockSequence);
};




function tripRadiusKm(){
  const drive=+($("#tripDrive")?.value||25);
  return Math.max(10,Math.min(50,drive*.8));
}

function cachesNearTripOrigin(radiusKm=tripRadiusKm()){
  if(!state.tripOrigin)return [];
  return state.caches.filter(c=>haversine(state.tripOrigin,c)<=radiusKm);
}

function updateTripDataStatus(){
  const text=$("#tripDataText");
  if(!text)return;
  if(!state.tripOrigin){
    text.textContent="Wähle zuerst einen Reise-Ausgangspunkt.";
    return;
  }
  const radius=tripRadiusKm();
  const nearby=cachesNearTripOrigin(radius);
  const suitable=nearby.filter(c=>!c.found && c.type!=="Multi" && (c.type!=="Mystery" || c.corrected));
  text.innerHTML=`Im Umkreis von ca. ${radius.toFixed(0)} km um <strong>${state.tripOrigin.name}</strong>: `+
    `<strong>${nearby.length}</strong> importierte Caches, davon <strong>${suitable.length}</strong> grundsätzlich geeignet.`;
}

function showTripAreaOnMap(){
  if(!state.tripOrigin){alert("Bitte zuerst Reise-Ausgangspunkt wählen.");return;}
  switchTab("karte");
  const r=tripRadiusKm();
  state.layers.route.clearLayers();
  L.circle([state.tripOrigin.lat,state.tripOrigin.lon],{radius:r*1000,weight:2,dashArray:"8,8",fillOpacity:.05}).addTo(state.layers.route);
  L.marker([state.tripOrigin.lat,state.tripOrigin.lon],{title:state.tripOrigin.name}).bindPopup(`<strong>${state.tripOrigin.name}</strong><br>Reise-Ausgangspunkt`).addTo(state.layers.route);
  state.map.setView([state.tripOrigin.lat,state.tripOrigin.lon],Math.max(9,Math.min(13,Math.round(13-Math.log2(r/10)))));
  $("#mapInfo").innerHTML=`<strong>Reisegebiet: ${state.tripOrigin.name}</strong><span>Planungsradius ca. ${r.toFixed(0)} km</span>`;
}

function tripImportHint(){
  if(!state.tripOrigin){alert("Bitte zuerst Reise-Ausgangspunkt wählen.");return;}
  const prep=+($("#tripPrepRadius")?.value||30);
  const txt=`Für ${state.tripOrigin.name} solltest du eine GPX-Datei mit Caches im Umkreis von etwa ${prep} km importieren. `+
    `Je dichter der Import, desto besser kann CacheRunde mehrere unterschiedliche Tagesrunden zusammenstellen. `+
    `Gefundene Caches werden später automatisch ausgeschlossen; gelöste Mysterys sollten Final-Koordinaten enthalten.`;
  alert(txt);
}


function debounce(fn,wait=350){
  let timer=null;
  return (...args)=>{
    clearTimeout(timer);
    timer=setTimeout(()=>fn(...args),wait);
  };
}


function getSearchReference(){
  if(state.searchLocation)return Promise.resolve(state.searchLocation);
  return new Promise(resolve=>{
    if(!navigator.geolocation){resolve(null);return;}
    navigator.geolocation.getCurrentPosition(
      pos=>{
        state.searchLocation={lat:pos.coords.latitude,lon:pos.coords.longitude,source:"Standort"};
        resolve(state.searchLocation);
      },
      ()=>resolve(null),
      {enableHighAccuracy:false,timeout:2500,maximumAge:300000}
    );
  });
}

function sortSuggestionsByDistance(items,ref){
  if(!ref)return items;
  return items.map(item=>{
    const d=haversine(ref,{lat:+item.lat,lon:+item.lon});
    return {...item,distanceKm:d};
  }).sort((a,b)=>a.distanceKm-b.distanceKm);
}

async function fetchLocationSuggestions(query){
  if(!query || query.trim().length<3)return [];
  try{
    const ref=await getSearchReference();
    const params=new URLSearchParams({q:query.trim(),limit:"12"});
    if(ref){params.set("lat",ref.lat);params.set("lon",ref.lon);}
    const res=await fetch(`/api/suggest?${params.toString()}`,{cache:"no-store"});
    if(!res.ok)return [];
    const data=await res.json();
    return sortSuggestionsByDistance(data.results||[],ref);
  }catch(e){
    return [];
  }
}

function renderLocationSuggestions(hostId,items,onPick){
  const host=$(hostId);
  if(!host)return;
  host.innerHTML="";
  if(!items.length){
    host.classList.add("hidden");
    return;
  }
  items.slice(0,5).forEach(item=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="search-suggestion";
    const title=item.name||item.display_name||"Treffer";
    const detail=item.display_name||"";
    const distance=Number.isFinite(item.distanceKm)?`${item.distanceKm.toFixed(item.distanceKm<10?1:0)} km entfernt`:"";
    b.innerHTML=`<strong>${title}</strong>${detail && detail!==title?`<span>${detail}</span>`:""}${distance?`<span>📍 ${distance}</span>`:""}`;
    b.onclick=()=>{
      host.classList.add("hidden");
      onPick(item);
    };
    host.appendChild(b);
  });
  host.classList.remove("hidden");
}

const suggestOrigin=debounce(async()=>{
  const q=$("#originSearch")?.value||"";
  if(q.trim().length<3){
    $("#originSuggestions")?.classList.add("hidden");
    return;
  }
  const items=await fetchLocationSuggestions(q);
  renderLocationSuggestions("#originSuggestions",items,item=>{
    pickSearchPlace(item);
    switchTab("touren");
  });
},350);

// Gewählter Ort gilt für alles: Tourensuche, Detailsuche und (in der App) das Laden von geocaching.com
function pickSearchPlace(item){
  const label=item.display_name||item.name||"Gewählter Ort";
  setOrigin(+item.lat,+item.lon,label);
  if(isNativeApp()){
    const loadedAt=(()=>{try{return JSON.parse(localStorage.getItem(GC_CACHE_KEY)||"null")?.center;}catch(e){return null;}})();
    const far=!loadedAt||haversine(loadedAt,{lat:+item.lat,lon:+item.lon})>1;
    if(far)loadCachesFromGeocaching();
  }else{
    showToast(`Suchort: ${String(label).split(",")[0]}. Die Tourensuche plant jetzt um diesen Ort.`,"success",4000);
  }
}

const suggestGcPlace=debounce(async()=>{
  const q=$("#gcSearchPlace")?.value||"";
  if(q.trim().length<3){
    $("#gcSuggestions")?.classList.add("hidden");
    return;
  }
  const items=await fetchLocationSuggestions(q);
  if(($("#gcSearchPlace")?.value||"")!==q)return; // inzwischen weitergetippt
  renderLocationSuggestions("#gcSuggestions",items,item=>{
    $("#gcPlaceMatches").innerHTML="";
    pickSearchPlace(item);
  });
},300);

const suggestTrip=debounce(async()=>{
  const q=$("#tripSearch")?.value||"";
  if(q.trim().length<3){
    $("#tripSuggestions")?.classList.add("hidden");
    return;
  }
  const items=await fetchLocationSuggestions(q);
  renderLocationSuggestions("#tripSuggestions",items,item=>{
    $("#tripSearch").value=item.display_name||item.name||q;
    state.tripOrigin={lat:+item.lat,lon:+item.lon,name:item.name||item.display_name||q};
    $("#tripOriginStatus").textContent=`Ausgangspunkt: ${state.tripOrigin.name}`;
    updateTripDataStatus();
  });
},350);

async function searchTripOrigin(){
  const q=$("#tripSearch").value.trim(); if(!q)return;
  $("#tripOriginStatus").textContent="Suche Ort …";
  try{
    const res=await fetch(`/api/geocode?q=${encodeURIComponent(q)}`,{cache:"no-store"});
    const d=await res.json(),first=d.results?.[0];
    if(!first){$("#tripOriginStatus").textContent="Kein Ort gefunden.";return;}
    state.tripOrigin={lat:+first.lat,lon:+first.lon,name:first.name||q};
    $("#tripOriginStatus").textContent=`Ausgangspunkt: ${state.tripOrigin.name}`;
    updateTripDataStatus();
  }catch(e){$("#tripOriginStatus").textContent="Ortssuche fehlgeschlagen.";}
}
function routeCacheIds(r){return new Set((r.real?.finalSequence||cacheSequence(r)).map(c=>c.id));}
function setOverlap(a,b){let n=0;a.forEach(x=>{if(b.has(x))n++});return Math.min(a.size,b.size)?n/Math.min(a.size,b.size):0;}



function tripDayAnchor(route){
  if(route.real?.parking)return {lat:route.real.parking.lat,lon:route.real.parking.lon};
  const seq=route.real?.finalSequence||cacheSequence(route);
  return seq.length?{lat:seq[0].lat,lon:seq[0].lon}:routeCenter(route);
}
function lodgingLabel(type){
  return {camping:"Campingplatz",camper:"Wohnmobilstellplatz",hotel:"Hotel / Pension",apartment:"Ferienwohnung / Apartment",any:"Unterkunft"}[type]||"Unterkunft";
}
function lodgingDistanceScore(lodging,routes){
  if(!routes?.length)return null;
  const distances=routes.map(r=>haversine(lodging,tripDayAnchor(r)));
  const avg=distances.reduce((a,b)=>a+b,0)/distances.length;
  const max=Math.max(...distances);
  const qualityWeight=+($("#lodgingQualityWeight")?.value||1);
  const rating=Number.isFinite(+lodging.rating)?+lodging.rating:null;
  const reviews=Number.isFinite(+lodging.reviewCount)?+lodging.reviewCount:0;
  let qualityBonus=0;
  if(rating!=null){
    qualityBonus=(rating-3.5)*0.9*qualityWeight;
    qualityBonus+=Math.min(0.8,Math.log10(reviews+1)*0.18*qualityWeight);
  }
  return {avgKm:avg,maxKm:max,score:avg+max*.35-qualityBonus,qualityBonus,rating,reviews};
}


function preferredReviewSource(l){
  const pref=$("#lodgingReviewSource")?.value||"auto";
  if(pref!=="auto")return pref;
  const t=(l.type||"").toLowerCase();
  if(["camp_site","caravan_site","camping","camper"].includes(t))return "campinginfo";
  return "googlemaps";
}
function reviewSourceLabel(source){
  return source==="campinginfo"?"camping.info":"Google Maps";
}
function lodgingReviewUrl(l){
  const source=preferredReviewSource(l);
  const place=`${l.name||"Unterkunft"} ${state.tripOrigin?.name||""}`.trim();
  if(source==="googlemaps" && l.googleMapsUri)return l.googleMapsUri;
  if(source==="campinginfo"){
    return `https://www.google.com/search?q=${encodeURIComponent("site:camping.info "+place)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

function lodgingAvailabilityUrl(l){
  if(l.website)return l.website;
  const ci=$("#lodgingCheckin")?.value||"";
  const co=$("#lodgingCheckout")?.value||"";
  const q=encodeURIComponent(`${l.name||"Unterkunft"} ${state.tripOrigin?.name||""} ${ci} ${co}`);
  return `https://www.google.com/search?q=${q}`;
}
function lodgingRatingText(l){
  if(Number.isFinite(+l.rating)){
    const reviews=Number.isFinite(+l.reviewCount)&&+l.reviewCount>0?` · ${l.reviewCount} Bewertungen`:"";
    const source=l.ratingSource?` · ${l.ratingSource}`:"";
    return `★ ${(+l.rating).toFixed(1)}${reviews}${source}`;
  }
  return state.googlePlaces.enabled && state.googlePlaces.key
    ? "Kein Google-Place eindeutig zugeordnet"
    : "Keine Bewertungsquelle verbunden";
}

async function findLodgingCandidates(){
  if(!state.tripOrigin){alert("Bitte zuerst Reise-Ausgangspunkt wählen.");return;}
  const type=$("#lodgingType").value;
  if(type==="none"){
    state.lodgingCandidates=[];state.selectedLodging=null;
    $("#lodgingStatus").textContent="Übernachtung wird nicht berücksichtigt.";
    $("#lodgingResults").innerHTML="";
    return;
  }
  setProgress(10,"Suche Unterkünfte im Reisegebiet …","Übernachtung");
  try{
    const radius=+$("#lodgingRadius").value;
    const res=await fetch(`/api/lodging?lat=${state.tripOrigin.lat}&lon=${state.tripOrigin.lon}&type=${encodeURIComponent(type)}&radius=${radius*1000}`,{cache:"no-store"});
    if(!res.ok)throw new Error(await res.text());
    const d=await res.json();
    state.lodgingCandidates=(d.results||[]).map(x=>({
      ...x,
      lat:+x.lat,lon:+x.lon,
      rating:x.rating==null?null:+x.rating,
      reviewCount:x.reviewCount==null?0:+x.reviewCount
    }));
    if(state.googlePlaces.enabled && state.googlePlaces.key){
      setProgress(55,"Lade Google-Bewertungen für Unterkünfte …","Übernachtung");
      const enriched=[];
      for(let i=0;i<Math.min(state.lodgingCandidates.length,10);i++){
        enriched.push(await enrichLodgingWithGoogle(state.lodgingCandidates[i]));
      }
      state.lodgingCandidates=[
        ...enriched,
        ...state.lodgingCandidates.slice(enriched.length)
      ];
    }
    if(state.currentTripPlan?.routes?.length){
      state.lodgingCandidates=state.lodgingCandidates.map(x=>({...x,fit:lodgingDistanceScore(x,state.currentTripPlan.routes)})).sort((a,b)=>(a.fit?.score??999)-(b.fit?.score??999));
    }
    renderLodgingResults();
    finishProgress(`${state.lodgingCandidates.length} Unterkunft/-künfte gefunden.`);
  }catch(e){
    failProgress(e.message||"Unterkunftssuche fehlgeschlagen");
  }
}
function renderLodgingResults(){
  const host=$("#lodgingResults"); if(!host)return;
  host.innerHTML="";
  if(!state.lodgingCandidates.length){$("#lodgingStatus").textContent="Keine passenden Unterkünfte gefunden.";return;}
  const withRating=state.lodgingCandidates.filter(x=>Number.isFinite(+x.rating)).length;
  $("#lodgingStatus").textContent=`${state.lodgingCandidates.length} passende Unterkunft/-künfte gefunden. ${withRating?withRating+" mit direkter Qualitätsangabe.":"Externe Bewertungsquellen können über „Bewertungen ansehen“ geöffnet werden."}`;
  const list=document.createElement("div");list.className="lodging-list";
  state.lodgingCandidates.slice(0,10).forEach(l=>{
    const card=document.createElement("div");
    card.className="lodging-card"+(state.selectedLodging?.osmId===l.osmId?" selected":"");
    card.innerHTML=`<strong>${l.name||lodgingLabel(l.type)}</strong>
      <div class="lodging-meta">${lodgingLabel(l.type)}${l.address?` · ${l.address}`:""}</div>
      <div class="lodging-rating">${lodgingRatingText(l)}</div>
      <div class="review-source-note">Bewertungen: ${reviewSourceLabel(preferredReviewSource(l))}</div>
      ${l.fit?`<div class="lodging-meta">Ø ${l.fit.avgKm.toFixed(1)} km · max. ${l.fit.maxKm.toFixed(1)} km zu den Tagesrunden</div><div class="quality-score">Gesamtscore: ${l.fit.score.toFixed(2)}</div>`:""}
      <div class="review-actions"><button class="ghost reviews">Bewertungen ansehen</button><button class="ghost availability">Verfügbarkeit prüfen</button></div>
      <div class="data-actions" style="margin-top:8px"><button class="ghost choose">Auswählen</button><button class="ghost map">Karte</button></div>`;
    card.querySelector(".choose").onclick=()=>{state.selectedLodging=l;if(state.currentTripPlan)state.currentTripPlan.lodging=l;renderLodgingResults();if(state.currentTripPlan?.routes)renderTripPlan(state.currentTripPlan.routes,state.currentTripPlan.routes.length);};
    card.querySelector(".map").onclick=()=>{switchTab("karte");state.layers.route.clearLayers();L.marker([l.lat,l.lon]).bindPopup(`<strong>${l.name||lodgingLabel(l.type)}</strong>`).addTo(state.layers.route);state.map.setView([l.lat,l.lon],13);};
    card.querySelector(".reviews").onclick=()=>window.open(lodgingReviewUrl(l),"_blank","noopener");
    card.querySelector(".availability").onclick=()=>window.open(lodgingAvailabilityUrl(l),"_blank","noopener");
    list.appendChild(card);
  });
  host.appendChild(list);
}
function autoSelectBestLodging(routes){
  if($("#lodgingType").value==="none"||!state.lodgingCandidates.length)return null;
  const rated=state.lodgingCandidates.map(x=>({...x,fit:lodgingDistanceScore(x,routes)})).filter(x=>x.fit).sort((a,b)=>a.fit.score-b.fit.score);
  if(!rated.length)return null;
  state.lodgingCandidates=rated;state.selectedLodging=rated[0];return rated[0];
}

function tripRealScore(r,priority="balanced"){
  const driveMin=(r.real?.drive?.duration||0)/60;
  const walkMin=r.stats?.totalMin||0;
  const caches=r.stats?.cacheCount||0;
  const overlap=(r.real?.overlapRatio||0)*100;
  let score=caches*4-driveMin*1.6-walkMin*.08-overlap*1.4;
  if(priority==="caches")score+=caches*4;
  if(priority==="drive")score-=driveMin*2.5;
  if(priority==="hike")score-=walkMin*.16;
  return score;
}

async function optimizeTripCandidate(route,origin,tripOpts,idx,total){
  setProgress(20+55*(idx/Math.max(1,total)),
    `Prüfe Kandidat ${idx+1} von ${total}: ${route.displayName||route.name} …`,
    "Reiseoptimierung");

  const seq=cacheSequence(route);
  if(seq.length<2)return null;

  const routeOpts={
    start:{lat:origin.lat,lon:origin.lon,ele:null},
    radius:tripOpts.radius,maxGap:15,maxTime:tripOpts.maxWalk,
    speed:4.5,stopTime:5,excludeFound:true,tradis:true,mysteries:true,multis:false,labs:true,minCaches:tripOpts.minCaches
  };

  try{
    const repaired=await routeAndRepairSequence(seq,routeOpts,null);
    let finalSeq=repaired.seq;
    let cacheReal=repaired.result;
    if(!finalSeq?.length || !cacheReal)return null;

    let parking=null,parkings=[];
    try{
      const timeout=new Promise((_,reject)=>setTimeout(()=>reject(new Error("parking-timeout")),9000));
      parkings=await Promise.race([findParkingCandidates(finalSeq[0],finalSeq[finalSeq.length-1],finalSeq,"fallback"),timeout]);
      parking=parkings?.[0]||null;
    }catch(e){}

    if(!parking){
      parking={...finalSeq[0],name:"Start am ersten Cache",parkingScore:null,fee:"",capacity:0,source:"Fallback"};
    }

    const parkingPlan=parkings.length
      ? await optimizeParkingAndEntry(finalSeq,parkings,routeOpts,null,cacheReal,3,false)
      : null;

    let toFirst,fromLast;
    let entryCacheId=finalSeq[0]?.id||null;
    let walkingDirection="vorwärts";
    let parkingVariantsTested=parkingPlan?.tested||0;

    if(parkingPlan){
      parking=parkingPlan.parking;
      finalSeq=parkingPlan.seq;
      cacheReal=parkingPlan.cacheReal;
      toFirst=parkingPlan.toFirst;
      fromLast=parkingPlan.fromLast;
      entryCacheId=parkingPlan.entryCacheId;
      walkingDirection=parkingPlan.direction;
    }else{
      toFirst=(parking.lat===finalSeq[0].lat && parking.lon===finalSeq[0].lon)
        ? {distance:0,duration:0,geometry:{coordinates:[[parking.lon,parking.lat]]}}
        : await footRouteRequest([parking,finalSeq[0]],false);
      fromLast=await footRouteRequest([finalSeq[finalSeq.length-1],parking],false);
    }

    const forwardGeometry=mergeGeometries(toFirst.geometry,cacheReal.geometry);
    const directGeometry=mergeGeometries({coordinates:forwardGeometry},fromLast.geometry);
    const directOverlap=overlapRatio(directGeometry);
    let returnMode="direkt";

    if(directOverlap>0.12){
      const alt=await alternativeReturnRoute(finalSeq[finalSeq.length-1],parking,forwardGeometry);
      if(alt && alt.overlap<=directOverlap-0.03 && alt.route.distance<=fromLast.distance*1.45){
        fromLast=alt.route;
        returnMode="alternativ";
      }
    }

    const geometry={type:"LineString",coordinates:mergeGeometries(toFirst.geometry,cacheReal.geometry,fromLast.geometry)};
    const walkingDistance=(toFirst.distance||0)+(cacheReal.distance||0)+(fromLast.distance||0);
    const walkingDuration=(toFirst.duration||0)+(cacheReal.duration||0)+(fromLast.duration||0);
    const totalDuration=walkingDuration+finalSeq.length*5*60;

    let drive=null;
    try{drive=await carRoute(origin,parking);}catch(e){}

    if(drive && drive.duration>tripOpts.maxDrive*60)return null;
    if(totalDuration>tripOpts.maxWalk*60*1.05)return null;
    if(finalSeq.length<tripOpts.minCaches)return null;

    let elevation=null;
    try{elevation=await fetchElevationForGeometry(geometry.coordinates);}catch(e){}

    route.real={
      parking,parkingCandidates:parkings.length,parkingAutomatic:parkings.length>0,
      parkingScore:parking.parkingScore,
      parkingOptimizationKm:walkingDistance/1000,
      entryCacheId,
      walkingDirection,
      parkingVariantsTested,
      finalSequence:finalSeq,
      removedCaches:repaired.removed,
      cacheDistance:cacheReal.distance,
      walkingDistance,walkingDuration,totalDuration,
      maxCacheLegSec:Math.max(0,...cacheReal.legDurations),
      violations:repaired.violations,
      drive,geometry,
      elevation,
      overlapRatio:overlapRatio(geometry.coordinates),
      returnMode,
      checkedAt:new Date().toISOString(),
      tripOptimized:true
    };
    route.stats.km=walkingDistance/1000;
    route.stats.walkMin=walkingDuration/60;
    route.stats.totalMin=totalDuration/60;
    route.stats.cacheCount=finalSeq.length;
    if(elevation){
      route.stats.gain=elevation.gain;
      route.stats.loss=elevation.loss;
    }
    route.tripScore=tripRealScore(route,tripOpts.priority);
    return route;
  }catch(e){
    console.warn("Trip candidate failed",e);
    return null;
  }
}

function chooseTripDays(candidates,days){
  const chosen=[];
  while(chosen.length<days){
    let best=null,bestScore=-Infinity;
    for(const r of candidates){
      if(chosen.includes(r))continue;
      const ids=routeCacheIds(r);
      let cacheOverlap=0;
      chosen.forEach(c=>cacheOverlap=Math.max(cacheOverlap,setOverlap(ids,routeCacheIds(c))));
      if(cacheOverlap>.35)continue;
      const score=(r.tripScore||0)-cacheOverlap*140;
      if(score>bestScore){bestScore=score;best=r;}
    }
    if(!best)break;
    chosen.push(best);
  }
  return chosen;
}

function tripTotals(routes){
  return routes.reduce((a,r)=>{
    a.caches+=(r.stats?.cacheCount||0);
    a.km+=(r.stats?.km||0);
    a.walkMin+=(r.stats?.totalMin||0);
    a.driveMin+=(r.real?.drive?.duration||0)/60;
    a.gain+=(r.stats?.gain||0);
    return a;
  },{caches:0,km:0,walkMin:0,driveMin:0,gain:0});
}

function saveCurrentTrip(){
  if(!state.currentTripPlan?.routes?.length){alert("Keine Reise zum Speichern.");return;}
  const t={
    id:`trip-${Date.now()}`,
    name:`${state.currentTripPlan.origin.name} · ${state.currentTripPlan.routes.length} Tage`,
    origin:state.currentTripPlan.origin,
    routes:state.currentTripPlan.routes.map(serializableTour),
    lodging:state.currentTripPlan.lodging||null,
    totals:tripTotals(state.currentTripPlan.routes),
    createdAt:new Date().toISOString()
  };
  state.savedTrips.unshift(t);
  persistTourState();
  renderSavedTrips();
  showToast("Reise gespeichert.","success");
}

function renderSavedTrips(){
  const host=$("#savedTrips");
  if(!host)return;
  host.innerHTML="";
  const q=($("#savedTripSearch")?.value||"").trim().toLowerCase();
  const mode=$("#savedTripSort")?.value||"recent";
  let trips=[...state.savedTrips].filter(t=>(t.name||"").toLowerCase().includes(q));
  trips.sort((a,b)=>{
    if(mode==="name")return (a.name||"").localeCompare(b.name||"");
    if(mode==="days")return (b.routes?.length||0)-(a.routes?.length||0);
    return new Date(b.createdAt||0)-new Date(a.createdAt||0);
  });
  if(!trips.length){
    host.innerHTML='<div class="muted">Keine gespeicherte Reise passend zur Auswahl.</div>';
    return;
  }
  trips.forEach(t=>{
    const div=document.createElement("div");
    div.className="saved-trip-card";
    div.innerHTML=`<strong>${t.name}</strong><br><span class="muted">${t.routes.length} Tage · ${Math.round(t.totals?.caches||0)} Caches · ${(t.totals?.km||0).toFixed(1)} km Wandern · ${fmtMin(t.totals?.driveMin||0)} Anfahrt gesamt${t.lodging?` · ${t.lodging.name||lodgingLabel(t.lodging.type)}`:""}</span>
      <div class="data-actions" style="margin-top:8px">
        <button class="ghost load">Öffnen</button>
        <button class="ghost rename">Umbenennen</button>
        <button class="ghost copy">Duplizieren</button>
        <button class="ghost del">Löschen</button>
      </div>`;
    div.querySelector(".load").onclick=()=>{
      state.currentTripPlan={origin:t.origin,routes:t.routes,lodging:t.lodging||null};
      state.selectedLodging=t.lodging||null;renderTripPlan(t.routes,t.routes.length,true);switchTab("reise");
    };
    div.querySelector(".rename").onclick=()=>renameSavedTrip(t);
    div.querySelector(".copy").onclick=()=>duplicateSavedTrip(t);
    div.querySelector(".del").onclick=()=>{state.savedTrips=state.savedTrips.filter(x=>x.id!==t.id);persistTourState();renderSavedTrips();};
    host.appendChild(div);
  });
}

function replaceTripDay(index){
  const plan=state.currentTripPlan;
  if(!plan)return;
  const others=plan.routes.filter((_,i)=>i!==index);
  const current=plan.routes[index];
  const usedIds=new Set(plan.routes.map(r=>r.id));
  let best=null,bestScore=-Infinity;
  for(const cand of state.tripCandidatePool){
    if(usedIds.has(cand.id))continue;
    let ov=0;
    others.forEach(r=>ov=Math.max(ov,setOverlap(routeCacheIds(cand),routeCacheIds(r))));
    if(ov>.35)continue;
    const s=(cand.tripScore||0)-ov*140;
    if(s>bestScore){bestScore=s;best=cand;}
  }
  if(!best){alert("Keine passende Alternative mit geringer Überschneidung gefunden.");return;}
  plan.routes[index]=best;
  renderTripPlan(plan.routes,plan.routes.length);
}

async function planMultiDayTrip(){
  if(!state.tripOrigin){alert("Bitte zuerst Reise-Ausgangspunkt suchen.");return;}
  const days=+$("#tripDays").value,maxWalk=+$("#tripWalk").value,minCaches=+$("#tripMinCaches").value,maxDrive=+$("#tripDrive").value,priority=$("#tripPriority").value;
  const mode=$("#tripDataMode").value;
  updateTripDataStatus();

  if(mode==="prepare"){
    const prep=+$("#tripPrepRadius").value;
    const nearby=state.caches.filter(c=>haversine(state.tripOrigin,c)<=prep);
    const host=$("#tripResults");
    host.innerHTML=`<div class="card"><strong>Reisegebiet vorbereitet</strong><p>Für <strong>${state.tripOrigin.name}</strong> sind aktuell ${nearby.length} importierte Caches im ${prep}-km-Umkreis vorhanden.</p><p class="muted">Für eine belastbare Mehrtagesplanung sollte dieser Bereich möglichst vollständig als GPX importiert sein.</p></div>`;
    finishProgress("Reisegebiet vorbereitet.");
    return;
  }

  const radius=Math.max(10,Math.min(50,maxDrive*.8));
  const imported=cachesNearTripOrigin(radius);
  if(!imported.length){
    $("#tripResults").innerHTML=`<div class="card"><strong>Keine importierten Caches im Reisegebiet.</strong><p class="muted">Im Planungsradius von ca. ${radius.toFixed(0)} km um ${state.tripOrigin.name} liegen keine Caches aus deinem aktuellen GPX-Bestand.</p></div>`;
    finishProgress("Keine lokalen Cache-Daten im Reisegebiet.");
    return;
  }

  setProgress(8,`Erzeuge Routenkandidaten aus ${imported.length} importierten Caches …`,"Mehrtagestour");
  const opts={start:{lat:state.tripOrigin.lat,lon:state.tripOrigin.lon,ele:null},radius,maxGap:15,maxTime:maxWalk,speed:4.5,stopTime:5,excludeFound:true,tradis:true,mysteries:true,multis:false,minCaches};
  let candidates=buildRoutes(opts);
  await enrichRouteNames(candidates);

  if(!candidates.length){
    $("#tripResults").innerHTML='<div class="card"><strong>Keine geeigneten Kandidaten gefunden.</strong><p class="muted">Filter lockern oder mehr Anfahrt/Wanderzeit zulassen.</p></div>';
    finishProgress("Keine Kandidaten.");
    return;
  }

  const depth=Math.min(+$("#tripOptimizeDepth").value||6,candidates.length);
  const preselected=[...candidates].sort((a,b)=>{
    let sa=(a.stats.cacheCount||0)*3-(a.startDistance||0)*2-(a.stats.km||0)*.2;
    let sb=(b.stats.cacheCount||0)*3-(b.startDistance||0)*2-(b.stats.km||0)*.2;
    if(priority==="caches"){sa+=(a.stats.cacheCount||0)*3;sb+=(b.stats.cacheCount||0)*3;}
    if(priority==="drive"){sa-=(a.startDistance||0)*3;sb-=(b.startDistance||0)*3;}
    if(priority==="hike"){sa-=(a.stats.km||0);sb-=(b.stats.km||0);}
    return sb-sa;
  }).slice(0,depth);

  setProgress(18,`${preselected.length} Kandidaten werden real geprüft …`,"Reiseoptimierung");
  const optimized=[];
  const tripOpts={maxWalk,maxDrive,minCaches,radius,priority};
  for(let i=0;i<preselected.length;i++){
    const r=await optimizeTripCandidate(preselected[i],state.tripOrigin,tripOpts,i,preselected.length);
    if(r)optimized.push(r);
    await sleep(350);
  }

  if(!optimized.length){
    $("#tripResults").innerHTML='<div class="card"><strong>Keine real geprüfte Tagesrunde erfüllt die Vorgaben.</strong><p class="muted">Die echte Fahrzeit, Wanderzeit oder Mindestzahl Caches war bei allen Kandidaten außerhalb deiner Grenzen.</p></div>';
    failProgress("Keine Tagesrunde bestand die reale Prüfung.");
    return;
  }

  state.tripCandidatePool=optimized;
  const chosen=chooseTripDays(optimized,days);
  state.currentTripPlan={origin:{...state.tripOrigin},routes:chosen,createdAt:new Date().toISOString()};
  if($("#lodgingType").value!=="none" && state.lodgingCandidates.length){
    const best=autoSelectBestLodging(chosen);
    if(best)state.currentTripPlan.lodging=best;
  }
  setProgress(92,"Stelle optimierte Reise zusammen …","Reiseoptimierung");
  renderTripPlan(chosen,days);
  finishProgress(`${chosen.length} von ${days} Tagen real optimiert.`);
}

function renderTripPlan(routes,days,loaded=false){
  const host=$("#tripResults");host.innerHTML="";
  if(!routes?.length){
    host.innerHTML='<div class="card"><strong>Keine geeigneten Tagesrunden gefunden.</strong></div>';
    return;
  }

  const totals=tripTotals(routes);
  const ov=routes.reduce((max,r)=>Math.max(max,(r.real?.overlapRatio||0)*100),0);

  const overview=document.createElement("div");
  overview.className="card trip-overview";
  overview.innerHTML=`<div class="section-head"><div><span class="eyebrow">REISEPLAN</span><h2 style="margin:4px 0">${state.currentTripPlan?.origin?.name||state.tripOrigin?.name||"Cache-Reise"} · ${routes.length} Tage</h2></div><button id="saveWholeTrip" class="primary">Reise speichern</button></div>
    <div class="profile-grid">
      <div><strong>${totals.caches}</strong><span>Cache-Slots</span></div>
      <div><strong>${totals.km.toFixed(1)} km</strong><span>Wandern gesamt</span></div>
      <div><strong>${fmtMin(totals.driveMin)}</strong><span>Anfahrt gesamt</span></div>
      <div><strong>↑ ${Math.round(totals.gain)} m</strong><span>Höhenmeter</span></div>
    </div>
    <p class="muted">Alle Tagesrunden wurden mit echter Fahrzeit und echtem Fußrouting geprüft. Größter Doppelweg-Anteil innerhalb eines Tages: ${Math.round(ov)} %.</p>${state.currentTripPlan?.lodging?`<div class="trip-lodging-summary"><strong>Übernachtung: ${state.currentTripPlan.lodging.name||lodgingLabel(state.currentTripPlan.lodging.type)}</strong><br>${state.currentTripPlan.lodging.fit?`Ø ${state.currentTripPlan.lodging.fit.avgKm.toFixed(1)} km · max. ${state.currentTripPlan.lodging.fit.maxKm.toFixed(1)} km zu den Tagesrunden`:""}</div>`:""}`;
  host.appendChild(overview);
  $("#saveWholeTrip").onclick=saveCurrentTrip;

  routes.forEach((r,i)=>{
    const driveMin=(r.real?.drive?.duration||0)/60;
    const card=document.createElement("article");
    card.className="card route-card";
    card.innerHTML=`<div class="route-head"><div><span class="rank">TAG ${i+1}</span><h3>${r.displayName||r.name}</h3></div><span class="pill">${r.stats.cacheCount} Caches</span></div>
      <div class="route-metrics">
        <div class="metric"><strong>${r.stats.km.toFixed(1)} km</strong><span>Echte Wanderstrecke</span></div>
        <div class="metric"><strong>${fmtMin(r.stats.totalMin)}</strong><span>Wanderzeit inkl. Cachezeit</span></div>
        <div class="metric"><strong>${r.real?.drive?fmtMin(driveMin):"—"}</strong><span>Echte Anfahrt</span></div>
        <div class="metric"><strong>↑ ${Math.round(r.stats.gain||0)} m</strong><span>Höhenmeter</span></div>
      </div>
      <div class="trip-day-real"><strong>🅿 ${r.real?.parking?.name||"Startpunkt"}</strong><br>
        Doppelweg: ${Math.round((r.real?.overlapRatio||0)*100)} % · Rückweg: ${r.real?.returnMode==="alternativ"?"Alternative":"direkt"}<br>
        Max. Cache→Cache: ${fmtMin((r.real?.maxCacheLegSec||0)/60)}${r.real?.removedCaches?.length?` · Auto-Reparatur: ${r.real.removedCaches.length} Cache(s) entfernt`:""}
      </div>
      <div class="trip-day-actions">
        <button class="ghost map">Karte</button>
        <button class="ghost save">Tour speichern</button>
        <button class="ghost alt">Alternative</button>
        <button class="primary start">Starten</button>
      </div>`;
    card.querySelector(".map").onclick=()=>showRouteOnMap(r);
    card.querySelector(".save").onclick=()=>saveTour(r);
    card.querySelector(".alt").onclick=()=>replaceTripDay(i);
    card.querySelector(".start").onclick=()=>startTour(r);
    host.appendChild(card);
  });

  if(routes.length<days){
    host.insertAdjacentHTML("beforeend",`<div class="card"><strong>Nur ${routes.length} unterschiedliche Tage erfüllen die realen Vorgaben.</strong><p class="muted">Weitere geprüfte Kandidaten überschneiden sich zu stark oder liegen außerhalb der Fahr-/Wanderzeit.</p></div>`);
  }
}


function loadGooglePlacesSettings(){
  try{
    const cfg=JSON.parse(localStorage.getItem("cacherunde-google-places")||"{}");
    state.googlePlaces={enabled:!!cfg.enabled,key:cfg.key||""};
    if($("#googlePlacesKey"))$("#googlePlacesKey").value=state.googlePlaces.key;
    if($("#googleRatingsEnabled"))$("#googleRatingsEnabled").checked=state.googlePlaces.enabled;
    updateGooglePlacesStatus();
  }catch(e){}
}

function saveGooglePlacesSettings(){
  state.googlePlaces={
    enabled:$("#googleRatingsEnabled")?.checked||false,
    key:$("#googlePlacesKey")?.value.trim()||""
  };
  localStorage.setItem("cacherunde-google-places",JSON.stringify(state.googlePlaces));
  updateGooglePlacesStatus();
}

function updateGooglePlacesStatus(text=null){
  const el=$("#googlePlacesStatus");
  if(!el)return;
  if(text){el.textContent=text;return;}
  if(!state.googlePlaces.key){
    el.textContent="Nicht konfiguriert. Ohne Key bleibt „Bewertungen ansehen“ als externer Link verfügbar.";
  }else if(state.googlePlaces.enabled){
    el.textContent="Google Ratings Provider aktiviert.";
  }else{
    el.textContent="API-Key gespeichert, direkte Google-Bewertungen aber deaktiviert.";
  }
}

async function testGooglePlacesConnection(){
  saveGooglePlacesSettings();
  if(!state.googlePlaces.key){updateGooglePlacesStatus("Bitte zuerst einen API-Key eintragen.");return;}
  setProgress(20,"Teste Google Places Provider …","Google Places");
  try{
    const res=await fetch("/api/google-places-test",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({key:state.googlePlaces.key})
    });
    const d=await res.json();
    if(!res.ok||!d.ok)throw new Error(d.message||"Test fehlgeschlagen");
    updateGooglePlacesStatus("Verbindung erfolgreich. Google Ratings Provider ist einsatzbereit.");
    finishProgress("Google Places Verbindung erfolgreich.");
  }catch(e){
    updateGooglePlacesStatus(`Verbindung fehlgeschlagen: ${e.message}`);
    failProgress(e.message);
  }
}

async function enrichLodgingWithGoogle(l){
  if(!state.googlePlaces.enabled || !state.googlePlaces.key)return l;
  try{
    const res=await fetch("/api/google-place-rating",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        key:state.googlePlaces.key,
        name:l.name||"",
        lat:l.lat,
        lon:l.lon
      })
    });
    if(!res.ok)return l;
    const d=await res.json();
    if(!d.matched)return l;
    return {
      ...l,
      rating:d.rating==null?l.rating:+d.rating,
      reviewCount:d.userRatingCount==null?l.reviewCount:+d.userRatingCount,
      googlePlaceId:d.placeId||null,
      googleMapsUri:d.googleMapsUri||null,
      ratingSource:"Google"
    };
  }catch(e){
    return l;
  }
}

function loadProfile(){
  try{
    const p=JSON.parse(localStorage.getItem("cacherunde-profile")||"{}");
    state.profile={
      gcUsername:p.gcUsername||"Knorbert",
      csUsername:p.csUsername||p.gcUsername||"Knorbert",
      profileUrl:p.profileUrl||"https://www.geocaching.com/p/default.aspx?guid=363b1243-156e-4600-ade9-81c58d8b57b4"
    };
    $("#gcUsername").value=state.profile.gcUsername;
    $("#csUsername").value=state.profile.csUsername;
    $("#gcProfileUrl").value=state.profile.profileUrl;
    $("#accountStatus").textContent=state.profile.gcUsername?`Profil: ${state.profile.gcUsername}`:"Noch kein persönliches Profil gespeichert.";
  }catch(e){}
}

function saveProfile(){
  state.profile={
    gcUsername:$("#gcUsername").value.trim(),
    csUsername:$("#csUsername").value.trim()||$("#gcUsername").value.trim(),
    profileUrl:$("#gcProfileUrl")?.value.trim()||""
  };
  localStorage.setItem("cacherunde-profile",JSON.stringify(state.profile));
  $("#accountStatus").textContent=state.profile.gcUsername?`Profil gespeichert: ${state.profile.gcUsername}`:"Profil gespeichert.";
  refreshPersonalStats();
}



function summarizeYearlyStats(rows,currentYear=new Date().getFullYear()){
  const r=(rows||[]).map(x=>({year:+x.year,count:+x.count||0}))
    .filter(x=>Number.isFinite(x.year)&&Number.isFinite(x.count)&&x.count>=0);
  const current=r.find(x=>x.year===currentYear)?.count||0;
  const past=r.filter(x=>x.year<currentYear);
  const previousBest=past.length?past.reduce((a,b)=>b.count>a.count?b:a):null;
  const bestOverall=r.length?r.reduce((a,b)=>b.count>a.count?b:a):null;
  const toRecord=previousBest?Math.max(0,previousBest.count-current+1):0;
  return {current,previousBest,bestOverall,toRecord,newRecord:!!previousBest&&current>previousBest.count};
}

/* ---- Jahresstatistik: Quellen (seit 0.12.1) ----
   1. geocaching.com Statistikseite über die eigene, angemeldete Browsersitzung
   2. importierte "My Finds"-Pocket-Query (lokal gespeichert)
   3. eigene Found-Logs im normalen GPX-Import */

async function fetchGcStats(profileUrl,force=false){
  if(!profileUrl)return null;
  try{
    const res=await fetch(`/api/gc-stats?url=${encodeURIComponent(profileUrl)}&force=${force?"1":"0"}`,{cache:"no-store"});
    let data=null;
    try{data=await res.json();}catch(e){}
    return data||{available:false,yearly:[],message:`HTTP ${res.status}`};
  }catch(e){
    return {available:false,yearly:[],message:e.message||String(e)};
  }
}

async function gcLogin(){
  const url=state.profile.profileUrl||$("#gcProfileUrl")?.value?.trim()||"";
  try{
    const res=await fetch(`/api/gc-login?url=${encodeURIComponent(url)}`,{cache:"no-store"});
    const d=await res.json();
    if(!d.ok)throw new Error(d.message||`HTTP ${res.status}`);
    showToast("Bitte bei geocaching.com anmelden. Nach dem Login schließt sich das Fenster automatisch.","success",8000);
    const src=$("#yearStatsSource");
    if(src)src.innerHTML="<strong>Anmeldung läuft</strong> · Nach dem Login schließt sich das Fenster und die Werte werden neu geladen.";
  }catch(e){
    showToast(`Anmeldefenster konnte nicht geöffnet werden: ${e.message}`,"error",6000);
  }
}

/* ---- Meine Statistik (seit 0.21.0): alles von geocaching.com, Ränge von Cacherstats ---- */
async function fetchCacherstatsRanks(force=false){
  const user=(state.profile.csUsername||state.profile.gcUsername||"").trim();
  if(!user)return {matched:false,message:"Kein Cacherstats-Name im Profil."};
  try{
    const res=await fetch(`/api/cacherstats?user=${encodeURIComponent(user)}&force=${force?"1":"0"}&profileUrl=${encodeURIComponent(state.profile.profileUrl||"")}`,{cache:"no-store"});
    return await res.json();
  }catch(e){return {matched:false,message:e.message||String(e)};}
}

function setStat(id,v){const el=$(id);if(el)el.textContent=(v===null||v===undefined||v==="")?"—":String(v);}

async function refreshPersonalStats(force=false){
  const src=$("#statsSourceStatus");
  if(!isNativeApp()){
    if(src)src.textContent="Die Statistik kommt direkt von geocaching.com und Cacherstats – das geht nur in der Android-App.";
    return;
  }
  setProgress(15,"Rufe Statistik von geocaching.com ab …","Meine Statistik");
  if(src)src.textContent="Lade Statistik …";
  const [gc,cs]=await Promise.all([fetchGcStats(state.profile.profileUrl,force),fetchCacherstatsRanks(force)]);

  const yearly=gc?.yearly||[];
  const sum=summarizeYearlyStats(yearly);
  setStat("#statTotalFinds",gc?.totalFinds);
  setStat("#statYearFinds",yearly.length?sum.current:null);
  setStat("#statBestYear",sum.bestOverall?`${sum.bestOverall.year} · ${sum.bestOverall.count}`:null);
  setStat("#statToNewRecord",yearly.length?(sum.newRecord||!sum.previousBest?"0 · Rekord!":sum.toRecord):null);
  setStat("#statWorldRank",cs?.worldRank?`#${cs.worldRank}`:null);
  setStat("#statGermanyRank",cs?.germanyRank?`#${cs.germanyRank}`:null);
  renderGcStatDetails(gc?.yearly?.length?gc:null);

  const parts=[];
  if(gc?.yearly?.length)parts.push(`geocaching.com: ${gc.cached?`Zwischenspeicher (${gc.cacheAgeHours} Std.)`:"live"}`);
  else parts.push(`geocaching.com: ${gc?.loginRequired?"nicht angemeldet":gc?.message||"keine Daten"}`);
  if(cs?.matched)parts.push(`Cacherstats: ${cs.cached?"Zwischenspeicher":"live"}${cs.updated?` · Stand ${cs.updated}`:""}`);
  else parts.push(`Cacherstats: ${cs?.blocked?"blockiert":cs?.message||"kein Treffer"}${cs?.debug?` (${cs.debug})`:""}`);
  if(src)src.textContent=parts.join(" · ");
  finishProgress("Statistik aktualisiert.");
}

// Kompatibilität: frühere Aufrufer
function testYearStats(){return refreshPersonalStats(true);}

/* ---- Caches direkt von geocaching.com (nur Android-App, seit 0.14.0) ---- */

const GC_TYPE_NAMES={
  2:"Traditional Cache",3:"Multi-cache",4:"Virtual Cache",5:"Letterbox Hybrid",6:"Event Cache",
  8:"Unknown Cache",11:"Webcam Cache",13:"Cache In Trash Out Event",137:"Earthcache",
  453:"Mega-Event Cache",1858:"Wherigo Cache",3653:"Community Celebration Event",7005:"Giga-Event Cache"
};
const GC_EVENT_TYPES=new Set([6,13,453,3653,7005]);
const GC_CACHE_KEY="cacherunde-gc-caches";

function isNativeApp(){
  return !!(window.CR_API&&window.CR_API.isNative());
}

function gcResultToCache(r){
  const raw=GC_TYPE_NAMES[r.type]||`Typ ${r.type}`;
  const pos=r.corrected||{lat:r.lat,lon:r.lon};
  const logs=[];
  if(r.lastFound)logs.push({finder:"",type:"Found it",date:r.lastFound});
  return {
    id:r.code,
    name:r.name,
    lat:+pos.lat,
    lon:+pos.lon,
    type:normalizeType(raw),
    rawCacheType:raw,
    found:!!r.found,
    corrected:!!r.corrected,
    correctedSource:r.corrected?"geocaching.com":null,
    logs,
    ele:null,
    difficulty:Number.isFinite(+r.difficulty)?+r.difficulty:null,
    terrain:Number.isFinite(+r.terrain)?+r.terrain:null,
    source:"geocaching.com",
    favorites:r.favorites||0,
    premiumOnly:!!r.premiumOnly,
    owner:r.owner||"",
    dnfByMe:!!r.dnf,
    postedLat:r.lat,postedLon:r.lon
  };
}

function applyLoadedCaches(caches,statusText){
  state.caches=mergeLabStations(caches);
  $("#gpxStatus").textContent=statusText;
  $("#miniCacheCount").textContent=caches.length;
  if(caches.length){
    const avg=caches.reduce((a,c)=>({lat:a.lat+c.lat/caches.length,lon:a.lon+c.lon/caches.length}),{lat:0,lon:0});
    state.cacheCentroid=avg;
  }
  refreshCacheLayer();
  populateLogCacheSelect();
  updateTripDataStatus();
  updateSuitableCount();
  try{refreshPersonalStats();}catch(e){}
}

function planningCenter(){
  const lat=parseFloat($("#startLat")?.value),lon=parseFloat($("#startLon")?.value);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}

async function loadCachesFromGeocaching(){
  if(state.gcLoading)return state.gcLoading;
  state.gcLoading=loadCachesFromGeocachingInner().finally(()=>{state.gcLoading=null;});
  return state.gcLoading;
}

async function loadCachesFromGeocachingInner(){
  if(!isNativeApp()){
    showToast("Die Cache-Suche über geocaching.com geht nur in der Android-App.","error",5000);
    return;
  }
  const center=planningCenter();
  if(!center){
    showToast("Bitte zuerst einen Ausgangspunkt wählen (Standort verwenden oder Ort suchen).","error",5000);
    return;
  }
  const radius=+($("#quickRadius")?.value||10);
  // Auswahl "die X nächsten Caches" (seit 0.18.0): großer Suchradius, nach Entfernung sortiert, danach kürzen
  const countSel=$("#gcCount")?.value||"all";
  const nearestN=countSel==="all"?0:Math.max(1,parseInt(countSel,10)||0);
  const searchRadius=nearestN?50:radius;
  const onlySolved=$("#gcOnlySolved")?$("#gcOnlySolved").checked:true;
  // Ungelöste Mysterys und Events fallen später weg – bei "X nächste" entsprechend mehr holen.
  const maxFetch=nearestN?Math.min(1000,Math.ceil(nearestN*(onlySolved?2:1.3)/50)*50):1000;
  const onProgress=e=>{
    const {loaded,total}=e.detail||{};
    const pct=total?Math.min(90,10+Math.round(80*loaded/total)):30;
    setProgress(pct,`${loaded}${total?` von ${total}`:""} Caches geladen …`,"geocaching.com");
  };
  window.addEventListener("cr-gc-search-progress",onProgress);
  try{
    setProgress(5,nearestN?`Suche die ${nearestN} nächsten Caches …`:`Suche Caches im Umkreis von ${radius} km …`,"geocaching.com");
    const r=await fetch(`/api/gc-search?lat=${center.lat}&lon=${center.lon}&radius=${searchRadius}&hideFound=1&max=${maxFetch}`,{cache:"no-store"});
    const d=await r.json();
    if(!d.ok){
      if(d.loginRequired){
        failProgress("Nicht bei geocaching.com angemeldet.");
        if(confirm("Du bist in CacheRunde noch nicht bei geocaching.com angemeldet. Jetzt anmelden?"))gcLogin();
        return;
      }
      throw new Error(d.message||"Suche fehlgeschlagen");
    }
    const me=(d.user||"").toLowerCase();
    let caches=(d.results||[])
      .filter(x=>x.status===0)
      .filter(x=>!GC_EVENT_TYPES.has(x.type))
      .filter(x=>!(me&&x.owner&&x.owner.toLowerCase()===me))
      .filter(x=>!(onlySolved&&x.type===8&&!x.corrected))
      .map(gcResultToCache)
      .filter(c=>Number.isFinite(c.lat)&&Number.isFinite(c.lon));
    let farthestKm=0;
    if(nearestN){
      caches.sort((a,b)=>haversine(center,a)-haversine(center,b));
      caches=caches.slice(0,nearestN);
      farthestKm=caches.length?haversine(center,caches[caches.length-1]):0;
    }
    const mysteries=caches.filter(c=>c.type==="Mystery");
    const solved=mysteries.filter(c=>c.corrected).length;
    const save={loadedAt:new Date().toISOString(),center,radius,user:d.user,total:d.total,truncated:!!d.truncated,caches};
    try{localStorage.setItem(GC_CACHE_KEY,JSON.stringify(save));}catch(e){}
    const status=nearestN
      ? `${caches.length} nächste Caches von geocaching.com · bis ${farthestKm.toFixed(1)} km`
      : `${caches.length} Caches von geocaching.com · ${radius} km`;
    applyLoadedCaches(caches,status);
    finishProgress(`${caches.length} Caches geladen.`);
    showToast(
      (onlySolved
        ? `${caches.length} Caches geladen (ohne gefundene, deaktivierte, Events und ungelöste Mysterys), davon ${solved} gelöste Mysterys.`
        : `${caches.length} Caches geladen (ohne gefundene, deaktivierte und Events). Mysterys mit gelöstem Final: ${solved} von ${mysteries.length}.`)+
      (nearestN
        ? ` Der entfernteste liegt ${farthestKm.toFixed(1)} km entfernt.`+(farthestKm>radius?` Für die Planung zählt dein Suchradius von ${radius} km – ggf. erhöhen.`:"")
        : (d.truncated?` Achtung: auf 1000 von ${d.total} begrenzt – Radius verkleinern.`:"")),
      "success",8000
    );
  }catch(e){
    failProgress(e.message||String(e));
    showToast(`Caches konnten nicht geladen werden: ${e.message||e}`,"error",7000);
  }finally{
    window.removeEventListener("cr-gc-search-progress",onProgress);
  }
}

/* Adresse/Ort als Mittelpunkt für die geocaching.com-Suche (seit 0.17.1) */
async function gcSearchByPlace(){
  const q=($("#gcSearchPlace")?.value||"").trim();
  const host=$("#gcPlaceMatches");
  if(!q){useCurrentLocation();return;}
  if(host)host.innerHTML='<div class="muted">Suche Adresse …</div>';
  try{
    const c=planningCenter();
    const bias=c?`&lat=${c.lat}&lon=${c.lon}`:"";
    const res=await fetch(`/api/geocode?q=${encodeURIComponent(q)}&limit=6${bias}`,{cache:"no-store"});
    const items=(await res.json()).results||[];
    if(!items.length){if(host)host.innerHTML='<div class="muted">Keine Treffer. Ort, Straße mit Ort oder PLZ versuchen.</div>';return;}
    const pick=item=>{
      if(host)host.innerHTML="";
      pickSearchPlace(item);
    };
    if(items.length===1){pick(items[0]);return;}
    host.innerHTML='<div class="muted">Welcher Ort ist gemeint?</div>';
    items.forEach(item=>{
      const b=document.createElement("button");
      b.type="button";b.className="origin-match";
      b.textContent=item.display_name||item.name;
      b.onclick=()=>pick(item);
      host.appendChild(b);
    });
  }catch(e){
    if(host)host.innerHTML='<div class="muted">Adresssuche nicht erreichbar.</div>';
  }
}

function updateGcCenterLabel(){
  const el=$("#gcCenterLabel");
  if(!el)return;
  const c=planningCenter();
  const name=($("#originStatus")?.textContent||"").replace(/^Ausgangspunkt:\s*/,"");
  el.textContent=c?`Caches werden um den Suchort geladen: ${name||`${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`}`:"Noch kein Suchort gewählt.";
}

function restoreGcCaches(){
  try{
    const s=JSON.parse(localStorage.getItem(GC_CACHE_KEY)||"null");
    if(!s||!Array.isArray(s.caches)||!s.caches.length)return;
    if(state.caches&&state.caches.length)return;
    const when=new Date(s.loadedAt).toLocaleString("de-DE",{dateStyle:"short",timeStyle:"short"});
    applyLoadedCaches(s.caches,`${s.caches.length} Caches von geocaching.com · Stand ${when}`);
  }catch(e){}
}

function initGcSearchUi(){
  const native=isNativeApp();
  $("#gcLoadCaches")?.classList.toggle("hidden",!native);
  $("#gcPlaceBox")?.classList.toggle("hidden",!native);
  $("#gcLoginBtnData")?.classList.toggle("hidden",!native);
  restoreGcCaches();
  if(loadLabStations().length)syncLabsIntoCaches();
  updateLabStatus();
}

/* ---- Adventure-Lab-Stationen (seit 0.16.0) ----
   Lab-Caches sind nicht über geocaching.com abrufbar. Stationen werden daher von Hand
   gesetzt (Tipp auf die Karte oder Koordinaten) und wie normale Caches mitgeplant.
   Geloggt wird in der Adventure-Lab-App. */

const LAB_KEY="cacherunde-lab-stations";
const LAB_APP_PACKAGE="com.groundspeak.react.adventures";

function loadLabStations(){
  try{
    const l=JSON.parse(localStorage.getItem(LAB_KEY)||"[]");
    return Array.isArray(l)?l.filter(c=>c&&Number.isFinite(+c.lat)&&Number.isFinite(+c.lon)):[];
  }catch(e){return [];}
}
function saveLabStations(list){
  try{localStorage.setItem(LAB_KEY,JSON.stringify(list));}catch(e){}
  updateLabStatus();
}
function mergeLabStations(list){
  return [...(list||[]).filter(c=>c.type!=="Lab"),...loadLabStations()];
}
function syncLabsIntoCaches(){
  state.caches=mergeLabStations(state.caches);
  $("#miniCacheCount")&&($("#miniCacheCount").textContent=state.caches.length);
  refreshCacheLayer();
  populateLogCacheSelect();
  updateLabStatus();
}
function updateLabStatus(){
  const el=$("#labStatus");
  if(!el)return;
  const labs=loadLabStations();
  const open=labs.filter(l=>!l.found).length;
  el.textContent=labs.length
    ? `${labs.length} Lab-Station(en) gespeichert, davon ${open} offen.`
    : "Noch keine Lab-Stationen. Koordinaten siehst du als Premium-Mitglied in der Adventure-Lab-App (Vorschau).";
}

/* Koordinaten in üblichen Schreibweisen lesen:
   "N 49° 48.123 E 008° 51.234", "N49 48.123 E8 51.234", "49.80205, 8.85390", "49,80205 8,85390" */
function parseCoordinates(input){
  const s=String(input||"").trim().toUpperCase().replace(/[′’']/g," ").replace(/[°º]/g," ");
  let m=/^([NS])\s*(\d{1,2})\s+(\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*([EOW])\s*(\d{1,3})\s+(\d{1,2}(?:[.,]\d+)?)$/.exec(s);
  if(m){
    const f=x=>parseFloat(x.replace(",","."));
    let lat=+m[2]+f(m[3])/60,lon=+m[5]+f(m[6])/60;
    if(m[1]==="S")lat=-lat;
    if(m[4]==="W")lon=-lon;
    return valid(lat,lon);
  }
  m=/^([NS])?\s*(-?\d{1,2}[.,]\d+)\s*[,;\s]\s*([EOW])?\s*(-?\d{1,3}[.,]\d+)$/.exec(s);
  if(m){
    let lat=parseFloat(m[2].replace(",",".")),lon=parseFloat(m[4].replace(",","."));
    if(m[1]==="S")lat=-Math.abs(lat);
    if(m[3]==="W")lon=-Math.abs(lon);
    return valid(lat,lon);
  }
  return null;
  function valid(lat,lon){return Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;}
}

function createLabStation(lat,lon){
  const labs=loadLabStations();
  const lastAdventure=labs.length?labs[labs.length-1].adventure||"":"";
  const name=prompt("Name der Lab-Station:",`Lab-Station ${labs.length+1}`);
  if(name===null)return null;
  const adventure=prompt("Name des Adventures (optional, für die Übersicht):",lastAdventure);
  const station={
    id:"LAB-"+Date.now().toString(36).toUpperCase(),
    name:(name||"").trim()||`Lab-Station ${labs.length+1}`,
    adventure:(adventure||"").trim(),
    lat:+lat,lon:+lon,
    type:"Lab",rawCacheType:"Lab Cache",
    found:false,corrected:false,logs:[],ele:null,
    difficulty:null,terrain:null,source:"manuell",
    createdAt:new Date().toISOString()
  };
  labs.push(station);
  saveLabStations(labs);
  syncLabsIntoCaches();
  showToast(`Lab-Station „${station.name}“ hinzugefügt. Sie wird bei der Planung wie ein Cache berücksichtigt.`,"success",5000);
  return station;
}

function startLabPick(){
  state.originPick=false;
  state.parkingPickRoute=null;
  state.labPick=true;
  switchTab("karte");
  $("#map")?.classList.add("map-pick-active");
  showToast("Tippe auf der Karte auf die Position der Lab-Station.","success",5000);
}

function addLabByCoordinates(){
  const txt=prompt("Koordinaten der Lab-Station (z. B. N 49° 48.123 E 008° 51.234):","");
  if(txt===null)return;
  const p=parseCoordinates(txt);
  if(!p){alert("Diese Koordinaten konnte ich nicht lesen. Beispiel: N 49° 48.123 E 008° 51.234 oder 49.80205, 8.85390");return;}
  const st=createLabStation(p.lat,p.lon);
  if(st&&state.map)state.map.setView([st.lat,st.lon],Math.max(state.map.getZoom(),14));
}

function removeLabStation(id){
  const labs=loadLabStations();
  const st=labs.find(l=>l.id===id);
  if(!st||!confirm(`Lab-Station „${st.name}“ löschen?`))return;
  saveLabStations(labs.filter(l=>l.id!==id));
  state.caches=state.caches.filter(c=>c.id!==id);
  try{state.map?.closePopup();}catch(e){}
  syncLabsIntoCaches();
}

function clearLabStations(){
  const labs=loadLabStations();
  if(!labs.length)return;
  if(!confirm(`Alle ${labs.length} Lab-Station(en) löschen?`))return;
  saveLabStations([]);
  state.caches=state.caches.filter(c=>c.type!=="Lab");
  syncLabsIntoCaches();
}

function markLabFound(id){
  const labs=loadLabStations();
  const st=labs.find(l=>l.id===id);
  if(!st)return;
  st.found=!st.found;
  saveLabStations(labs);
  const c=state.caches.find(x=>x.id===id);
  if(c)c.found=st.found;
  if(st.found)markCacheCompleted(id);
  try{state.map?.closePopup();}catch(e){}
  refreshCacheLayer();
  showToast(st.found?`„${st.name}“ als gefunden markiert. Das Loggen selbst passiert in der Adventure-Lab-App.`:`„${st.name}“ wieder als offen markiert.`,"success",5000);
}

async function openAdventureLabApp(){
  if(!isNativeApp()){
    window.open("https://labs.geocaching.com/","_blank");
    return;
  }
  const c=window.Capacitor||{};
  let launcher=null;
  try{launcher=(c.Plugins&&c.Plugins.AppLauncher)||(typeof c.registerPlugin==="function"?c.registerPlugin("AppLauncher"):null);}catch(e){}
  if(!launcher&&typeof c.nativePromise==="function"){
    launcher={openUrl:o=>c.nativePromise("AppLauncher","openUrl",o)};
  }
  try{
    if(launcher){
      const r=await launcher.openUrl({url:LAB_APP_PACKAGE});
      if(!r||r.completed!==false)return;
    }
  }catch(e){
    console.warn("Adventure-Lab-App ließ sich nicht direkt öffnen",e);
  }
  // Rückfall: Play-Store-Seite der App (dort „Öffnen“ bzw. „Installieren“)
  location.href=`https://play.google.com/store/apps/details?id=${LAB_APP_PACKAGE}`;
}

function labPopupActions(cache){
  const safeId=String(cache.id).replace(/'/g,"\\'");
  return `<div class="cache-detail-actions">
      <button onclick="window.cacheRundeOpenLabApp()">In Adventure Lab öffnen</button>
      <button onclick="window.cacheRundeLabFound('${safeId}')">${cache.found?"Gefunden ✓ (zurücksetzen)":"Als gefunden markieren"}</button>
      <button onclick="window.cacheRundeRemoveLab('${safeId}')">Station löschen</button>
    </div>`;
}

window.cacheRundeOpenLabApp=()=>openAdventureLabApp();
window.cacheRundeLabFound=id=>markLabFound(id);
window.cacheRundeRemoveLab=id=>removeLabStation(id);

/* ---- Update-Prüfung (seit 0.19.0) ----
   Der Android-Build legt build-info.json in die App und veröffentlicht version.json
   neben der APK. Die App vergleicht beide Build-Nummern. */

const UPDATE_SOURCES=[
  // öffentliches Release-Repository (für den Fall, dass der Code privat ist)
  "https://github.com/shuvit82/cacherunde-releases/releases/latest/download/version.json",
  // Release im Code-Repository (solange es öffentlich ist)
  "https://github.com/shuvit82/cacherunde/releases/download/android-latest/version.json"
];
const UPDATE_CHECK_KEY="cacherunde-update-check";
let localBuildCache;

async function localBuildInfo(){
  if(localBuildCache!==undefined)return localBuildCache;
  try{
    const r=await fetch("build-info.json",{cache:"no-store"});
    localBuildCache=r.ok?await r.json():null;
  }catch(e){localBuildCache=null;}
  return localBuildCache;
}

async function fetchRemoteVersion(){
  const found=[];
  for(const url of UPDATE_SOURCES){
    try{
      const r=await fetch(url+(url.includes("?")?"&":"?")+"t="+Date.now(),{cache:"no-store",headers:{"Accept":"application/json"}});
      if(!r.ok)continue;
      const v=JSON.parse(await r.text());
      if(v&&Number.isFinite(+v.build)&&v.apk)found.push({...v,build:+v.build,source:url});
    }catch(e){}
  }
  found.sort((a,b)=>b.build-a.build);
  return found[0]||null;
}

function showUpdateBanner(remote){
  let el=$("#updateBanner");
  if(!el){
    el=document.createElement("div");
    el.id="updateBanner";
    el.className="update-banner";
    document.querySelector(".topbar")?.insertAdjacentElement("afterend",el);
  }
  el.innerHTML=`<span>Neue Version <strong>${escapeHtmlText(remote.version)} (Build ${remote.build})</strong> verfügbar.</span>
    <button id="updateDownload" class="primary">Herunterladen</button>
    <button id="updateLater" class="ghost">Später</button>`;
  el.classList.remove("hidden");
  $("#updateDownload").onclick=()=>downloadUpdate(remote);
  $("#updateLater").onclick=()=>el.classList.add("hidden");
}

function downloadUpdate(remote){
  showToast("Der Download startet im Browser. Danach die APK öffnen und über die vorhandene App installieren.","success",9000);
  // Externe Adresse: Android übergibt sie an den Browser, der die APK herunterlädt.
  location.href=remote.apk;
}

async function checkForUpdate(manual=false){
  const status=$("#updateStatus");
  const local=await localBuildInfo();
  if(!isNativeApp()||!local){
    if(manual&&status)status.textContent="Die Update-Prüfung gibt es nur in der Android-App.";
    return null;
  }
  if(status)status.textContent="Suche nach Updates …";
  const remote=await fetchRemoteVersion();
  try{localStorage.setItem(UPDATE_CHECK_KEY,String(Date.now()));}catch(e){}
  if(!remote){
    if(status)status.textContent="Update-Server nicht erreichbar. Später erneut versuchen.";
    if(manual)showToast("Keine Verbindung zum Update-Server.","warn",4000);
    return null;
  }
  const when=new Date().toLocaleString("de-DE",{dateStyle:"short",timeStyle:"short"});
  if(remote.build>(+local.build||0)){
    if(status)status.textContent=`Neue Version ${remote.version} (Build ${remote.build}) verfügbar · geprüft ${when}`;
    showUpdateBanner(remote);
  }else{
    if(status)status.textContent=`Du hast die neueste Version · geprüft ${when}`;
    if(manual)showToast("CacheRunde ist auf dem neuesten Stand.","success",3500);
  }
  return remote;
}

async function initUpdateUi(){
  const local=await localBuildInfo();
  const v=$("#installedVersion");
  if(v){
    v.textContent=local
      ? `${local.version} (Build ${local.build}) · ${new Date(local.date).toLocaleDateString("de-DE")}`
      : `${APP_VERSION} (Web-Version)`;
  }
  if(local&&$("#buildPill"))$("#buildPill").textContent=`Build ${local.version} · ${local.build}`;
  // automatisch höchstens alle 12 Stunden
  let last=0;
  try{last=+localStorage.getItem(UPDATE_CHECK_KEY)||0;}catch(e){}
  if(isNativeApp()&&local&&Date.now()-last>12*3600*1000){
    setTimeout(()=>checkForUpdate(false),4000);
  }
}



















const GC_DETAIL_LABELS={
  "Find Rate":"Fundrate","Longest Streak":"Längste Serie","Longest Slump":"Längste Pause",
  "Current Streak":"Aktuelle Serie","Current Slump":"Aktuelle Pause","Best Day":"Bester Tag",
  "Best Month":"Bester Monat","Best Year":"Bestes Jahr"
};
const EN_DE_WORDS={January:"Januar",February:"Februar",March:"März",April:"April",May:"Mai",June:"Juni",July:"Juli",August:"August",September:"September",October:"Oktober",November:"November",December:"Dezember",
  Monday:"Montag",Tuesday:"Dienstag",Wednesday:"Mittwoch",Thursday:"Donnerstag",Friday:"Freitag",Saturday:"Samstag",Sunday:"Sonntag"};
function deDatesAndNames(v){
  return String(v)
    .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,(m,mo,d,y)=>`${d.padStart(2,"0")}.${mo.padStart(2,"0")}.${y}`)
    .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g,w=>EN_DE_WORDS[w]);
}
function translateGcHabit(v){
  const m=/most caches in (\w+) and usually on (\w+)/i.exec(String(v||""));
  return m?`Die meisten Funde im ${EN_DE_WORDS[m[1]]||m[1]}, meist an einem ${EN_DE_WORDS[m[2]]||m[2]}.`:String(v||"");
}
function translateGcDetail(v){
  return deDatesAndNames(v)
    .replace(/caches\/day/g,"Caches/Tag").replace(/consecutive days with finds/g,"Tage in Folge mit Funden")
    .replace(/consecutive days without a find/g,"Tage in Folge ohne Fund").replace(/caches in one day on/g,"Caches an einem Tag, am")
    .replace(/ caches in /g," Caches im ").replace(/ from /g," vom ").replace(/ to /g," bis ").replace(/ since /g," seit ").replace(/ of /g," ");
}
function renderGcStatDetails(detail){
  const host=$("#gcStatDetails");
  if(!host)return;
  const d=detail&&(detail.details?detail:null);
  if(!d||!d.details?.length){host.innerHTML="";return;}
  const rows=d.details.map(x=>`<div><span>${escapeHtmlText(GC_DETAIL_LABELS[x.label]||x.label)}</span><strong>${escapeHtmlText(translateGcDetail(x.value))}</strong></div>`).join("");
  const habit=d.habit?`<p class="muted" style="margin:6px 0 0">${escapeHtmlText(translateGcHabit(d.habit))}</p>`:"";
  const first=d.firstFind?`<div><span>Erster Fund</span><strong>${escapeHtmlText(deDatesAndNames(d.firstFind))}</strong></div>`:"";
  host.innerHTML=`<h3 style="margin:14px 0 6px;font-size:15px">Von geocaching.com</h3><div class="gc-detail-list">${first}${rows}</div>${habit}`;
}


window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  state.deferredPrompt=e;
  $("#installBtn")?.classList.remove("hidden");
});

/* Core startup first: map + GPX import must work even if optional modules fail. */
try{
  initMap();
  state.map.on("click",e=>{
    if(state.labPick){
      state.labPick=false;
      $("#map")?.classList.remove("map-pick-active");
      createLabStation(e.latlng.lat,e.latlng.lng);
      return;
    }
    if(state.parkingPickRoute){
      const r=state.parkingPickRoute;
      const lockSequence=!!state.parkingPickLockSequence;
      state.parkingPickRoute=null;
      state.parkingPickLockSequence=false;
      $("#map")?.classList.remove("map-pick-active");
      applyManualParking(r,e.latlng.lat,e.latlng.lng,lockSequence);
      return;
    }
    if(!state.originPick)return;
    state.originPick=false;
    $("#map")?.classList.remove("map-pick-active");
    setOrigin(e.latlng.lat,e.latlng.lng,"Auf Karte gewählter Punkt");
    switchTab("touren");
  });
}catch(e){
  console.error("Map init failed",e);
  showToast("Karte konnte nicht initialisiert werden. GPX-Import bleibt verfügbar.","warn",6000);
}

const gpxInput=$("#gpxInput");
if(gpxInput){
  gpxInput.addEventListener("change",async e=>{
    const file=e.target.files?.[0];
    if(file)await loadGPXFile(file);
  });
}

/* Remaining UI bindings. A missing optional control should not stop core functions. */
function bindOptional(selector,event,handler){
  const el=$(selector);
  if(el)el.addEventListener(event,handler);
}

bindOptional("#installBtn","click",async()=>{
  if(state.deferredPrompt){
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt=null;
    $("#installBtn")?.classList.add("hidden");
  }
});

$$(".nav-btn").forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
bindOptional("#quickSearch","click",()=>search(true));
bindOptional("#advancedSearch","click",()=>search(false));
bindOptional("#sortBy","change",()=>renderRoutes("#advancedResults",state.routes,$("#sortBy")?.value||"quality"));
bindOptional("#quickSort","change",()=>renderRoutes("#quickResults",state.routes,$("#quickSort")?.value||"quality"));
bindOptional("#loadDemo","click",async()=>{
  try{
    const r=await fetch("sample.gpx");
    const t=await r.text();
    state.caches=mergeLabStations(parseGPX(t));
    const ignoredDemoWaypoints=state.gpxImportStats?.ignoredWaypoints||0;
    $("#gpxStatus").textContent=ignoredDemoWaypoints
      ? `${state.caches.length} Demo-Caches · ${ignoredDemoWaypoints} Zusatzwegpunkt(e) ignoriert`
      : `${state.caches.length} Demo-Caches geladen`;
    $("#miniCacheCount").textContent=state.caches.length;
    if(state.caches.length){
      const avg=state.caches.reduce((a,c)=>({lat:a.lat+c.lat/state.caches.length,lon:a.lon+c.lon/state.caches.length}),{lat:0,lon:0});
      state.cacheCentroid=avg;
      if(!state.originExplicit)setOrigin(avg.lat,avg.lon,"Automatisch: Mittelpunkt des Demo-Cachegebiets",false);
    }
    refreshCacheLayer();
    populateLogCacheSelect();
    updateTripDataStatus();
    showToast("Demo-Daten geladen.","success");
  }catch(e){
    showToast(`Demo konnte nicht geladen werden: ${e.message}`,"error");
  }
});

bindOptional("#originSearchBtn","click",searchOrigin);
bindOptional("#originSearch","input",suggestOrigin);
bindOptional("#gcSearchPlace","input",suggestGcPlace);
bindOptional("#originSearch","keydown",e=>{if(e.key==="Enter"){e.preventDefault();searchOrigin();}});
bindOptional("#originLocationBtn","click",useCurrentLocation);
bindOptional("#originMapBtn","click",enableMapOriginPick);
bindOptional("#originCacheAreaBtn","click",useCacheAreaOrigin);
bindOptional("#useLocation","click",useCurrentLocation);
["#quickRadius","#quickGap","#quickMaxTime","#quickMinCaches","#quickParkingMode"].forEach(id=>bindOptional(id,"change",updateSuitableCount));
for(const [a,b] of [["#quickParkingMode","#parkingMode"],["#parkingMode","#quickParkingMode"]]){
  bindOptional(a,"change",()=>{
    const v=$(a).value;
    if($(b)&&$(b).value!==v)$(b).value=v;
    try{localStorage.setItem("cacherunde-parking-mode",v);}catch(e){}
  });
}
try{
  const pm=localStorage.getItem("cacherunde-parking-mode");
  if(pm){["#quickParkingMode","#parkingMode"].forEach(id=>{if($(id))$(id).value=pm;});}
}catch(e){}
setTimeout(()=>{try{autoLocateOrigin();}catch(e){console.warn(e);}},600);
bindOptional("#mapPlanNew","click",()=>startMapPlanner(false));
bindOptional("#mapPlanEdit","click",()=>{
  if(!state.selectedRoute){
    showToast("Wähle zuerst eine bestehende Route auf der Karte oder starte die freie Planung.","warn",4500);
    return;
  }
  startMapPlanner(true);
});
bindOptional("#mapMoveParking","click",()=>{
  if(!state.selectedRoute){
    showToast("Wähle oder berechne zuerst eine Route.","warn",4500);
    return;
  }
  const lockSequence=!!state.selectedRoute.manualSelectionLocked ||
    String(state.selectedRoute.id||"").startsWith("manual-map-");
  chooseManualParking(state.selectedRoute,lockSequence);
});
bindOptional("#mapPlanCalculate","click",calculateMapPlanner);
bindOptional("#mapPlanClear","click",clearMapPlanner);
bindOptional("#mapPlanCancel","click",cancelMapPlanner);

bindOptional("#fitMap","click",()=>{
  if(state.selectedRoute)showRouteOnMap(state.selectedRoute);
  else if(state.caches.length&&state.map){
    const b=L.latLngBounds(state.caches.map(c=>[c.lat,c.lon]));
    state.map.fitBounds(b.pad(.2));
  }
});
bindOptional("#offlineCurrent","click",()=>alert("Angezeigte Kartenausschnitte werden automatisch auf dem Gerät gespeichert und sind danach auch offline verfügbar."));
bindOptional("#offlineClear","click",async()=>{await fetch("/api/offline-clear",{method:"POST"});showToast("Offline-Karten gelöscht.","success");});

bindOptional("#saveProfile","click",saveProfile);
bindOptional("#saveAppSettings","click",saveAppSettings);
bindOptional("#refreshSystemStatus","click",refreshSystemStatus);
bindOptional("#exportBackup","click",exportBackup);
bindOptional("#importBackup","change",e=>e.target.files?.[0]&&importBackupFile(e.target.files[0]));
bindOptional("#savedTourSearch","input",renderSavedTours);
bindOptional("#savedTourSort","change",renderSavedTours);
bindOptional("#savedTripSearch","input",renderSavedTrips);
bindOptional("#savedTripSort","change",renderSavedTrips);
bindOptional("#saveGooglePlaces","click",saveGooglePlacesSettings);
bindOptional("#testGooglePlaces","click",testGooglePlacesConnection);
bindOptional("#refreshStats","click",()=>refreshPersonalStats(true));
bindOptional("#gcLoginBtn","click",gcLogin);
bindOptional("#gcLoginBtnData","click",gcLogin);
bindOptional("#gcLoadCaches","click",loadCachesFromGeocaching);
bindOptional("#placeUseLocation","click",()=>{ $("#gcSearchPlace").value=""; $("#gcPlaceMatches").innerHTML=""; useCurrentLocation(); });
bindOptional("#checkUpdate","click",()=>checkForUpdate(true));
setTimeout(()=>{try{initUpdateUi();}catch(e){console.warn(e);}},500);
bindOptional("#gcCount","change",()=>{try{localStorage.setItem("cacherunde-gc-count",$("#gcCount").value);}catch(e){}});
bindOptional("#gcOnlySolved","change",()=>{try{localStorage.setItem("cacherunde-gc-only-solved",$("#gcOnlySolved").checked?"1":"0");}catch(e){}});
try{const os=localStorage.getItem("cacherunde-gc-only-solved");if(os!==null&&$("#gcOnlySolved"))$("#gcOnlySolved").checked=os==="1";}catch(e){}
try{const gcN=localStorage.getItem("cacherunde-gc-count");if(gcN&&$("#gcCount"))$("#gcCount").value=gcN;}catch(e){}
bindOptional("#gcSearchPlace","keydown",e=>{if(e.key==="Enter"){e.preventDefault();gcSearchByPlace();}});
bindOptional("#gcSearchPlace","focus",updateGcCenterLabel);
setInterval(()=>{try{updateGcCenterLabel();}catch(e){}},3000);
bindOptional("#labAddMap","click",startLabPick);
bindOptional("#labAddMapData","click",startLabPick);
bindOptional("#labAddCoords","click",addLabByCoordinates);
bindOptional("#labClear","click",clearLabStations);
bindOptional("#labOpenApp","click",openAdventureLabApp);
window.addEventListener("cr-gc-login-closed",()=>{
  showToast("Anmeldefenster geschlossen. Lade Statistik neu …","success",3000);
  try{testYearStats();}catch(e){}
});
setTimeout(()=>{try{initGcSearchUi();}catch(e){console.warn(e);}},300);
if(!(window.CR_API&&window.CR_API.isNative())){$("#gcLoginBtn")?.classList.add("hidden");}

bindOptional("#queueLog","click",queueLog);
bindOptional("#sendLogs","click",uploadLogsAsDrafts);
bindOptional("#exportLogs","click",exportFieldNotes);
bindOptional("#clearUploadedLogs","click",clearUploadedLogs);
bindOptional("#openDrafts","click",openDraftsPage);
bindOptional("#logList","click",onLogListEvent);
bindOptional("#logList","change",onLogListEvent);
bindOptional("#logList","input",onLogListEvent);
setTimeout(()=>{try{
  const native=isNativeApp();
  $("#sendLogs").textContent=native?"Als Entwürfe hochladen":"Als Feldnotiz-Datei speichern";
  $("#exportLogs")?.classList.toggle("hidden",!native);
}catch(e){}},300);

bindOptional("#tripSearchBtn","click",searchTripOrigin);
bindOptional("#tripSearch","input",suggestTrip);
bindOptional("#tripSearch","keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("#tripSuggestions")?.classList.add("hidden");searchTripOrigin();}});
bindOptional("#planTrip","click",planMultiDayTrip);
bindOptional("#findLodging","click",findLodgingCandidates);
bindOptional("#lodgingQualityWeight","change",()=>{
  if(state.currentTripPlan?.routes?.length&&state.lodgingCandidates.length){
    state.lodgingCandidates=state.lodgingCandidates
      .map(x=>({...x,fit:lodgingDistanceScore(x,state.currentTripPlan.routes)}))
      .sort((a,b)=>a.fit.score-b.fit.score);
    renderLodgingResults();
  }
});
bindOptional("#lodgingReviewSource","change",renderLodgingResults);
bindOptional("#showTripArea","click",showTripAreaOnMap);
bindOptional("#tripImportHint","click",tripImportHint);
bindOptional("#tripDrive","change",updateTripDataStatus);
bindOptional("#tripDataMode","change",updateTripDataStatus);
bindOptional("#pauseTour","click",pauseTour);
bindOptional("#resumeTour","click",resumeTour);
bindOptional("#finishTour","click",finishTour);
bindOptional("#clearSavedTours","click",()=>{
  if(confirm("Alle gespeicherten Touren löschen?")){
    state.savedTours=[];
    persistTourState();
    renderSavedTours();
    showToast("Gespeicherte Touren gelöscht.","success");
  }
});
bindOptional("#clearSavedTrips","click",()=>{
  if(confirm("Alle gespeicherten Reisen löschen?")){
    state.savedTrips=[];
    persistTourState();
    renderSavedTrips();
    showToast("Gespeicherte Reisen gelöscht.","success");
  }
});

/* Optional state modules are initialized defensively. */
try{migrateLocalData();}catch(e){console.warn(e);}
try{loadProfile();}catch(e){console.warn(e);}

try{loadGooglePlacesSettings();}catch(e){console.warn(e);}
try{loadAppSettings();}catch(e){console.warn(e);}
try{loadTourState();}catch(e){console.warn(e);}
refreshSystemStatus().catch(e=>console.warn(e));

window.addEventListener("online",updateNetworkStatus);
window.addEventListener("offline",updateNetworkStatus);


document.addEventListener("click",e=>{
  if(!e.target.closest("#gcSearchPlace") && !e.target.closest("#gcSuggestions")){
    $("#gcSuggestions")?.classList.add("hidden");
  }
  if(!e.target.closest("#originSearch") && !e.target.closest("#originSuggestions")){
    $("#originSuggestions")?.classList.add("hidden");
  }
  if(!e.target.closest("#tripSearch") && !e.target.closest("#tripSuggestions")){
    $("#tripSuggestions")?.classList.add("hidden");
  }
});
