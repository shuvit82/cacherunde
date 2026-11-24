/* CacheRunde – geocaching.com-Zugriff in der Android-App (ab 0.14.0)
 *
 * Läuft nur in der App (Capacitor). Dort gehen Anfragen über CapacitorHttp an den
 * Browser-Beschränkungen vorbei und nutzen die Cookies des Logins, den der Nutzer
 * selbst im In-App-Browser durchführt. CacheRunde sieht oder speichert kein Passwort.
 *
 * Hinweis: Diese Zugriffe nutzen die normale Website von geocaching.com, nicht die
 * offizielle API, und sind laut Nutzungsbedingungen nicht vorgesehen. Daher sparsam:
 * Pausen zwischen Seitenabrufen, Ergebnis-Cache, harte Obergrenzen.
 */
(function(){
  "use strict";
  const cap=window.Capacitor;
  if(!(cap&&cap.isNativePlatform&&cap.isNativePlatform()))return;

  const GC="https://www.geocaching.com";
  const PAGE_SIZE=50;
  const PAGE_DELAY_MS=900;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  // Capacitor-Kern (registerPlugin) nachladen. Die Datei legt der Android-Build in die App.
  const coreReady=new Promise(resolve=>{
    if(cap.registerPlugin)return resolve(true);
    const s=document.createElement("script");
    s.src="capacitor.js";
    s.onload=()=>resolve(!!(window.Capacitor&&window.Capacitor.registerPlugin));
    s.onerror=()=>resolve(false);
    document.head.appendChild(s);
  });

  // Ersatz, falls der Kern fehlt: Plugin direkt über die native Brücke ansprechen.
  function bridgePlugin(name){
    const c=window.Capacitor;
    if(!c||typeof c.nativePromise!=="function")return null;
    return {
      openWebView:o=>c.nativePromise(name,"openWebView",o),
      close:o=>c.nativePromise(name,"close",o||{}),
      removeAllListeners:()=>c.nativePromise(name,"removeAllListeners",{}),
      addListener:(eventName,cb)=>{
        const id=c.nativeCallback(name,"addListener",{eventName},cb);
        return Promise.resolve({remove:()=>c.nativePromise(name,"removeListener",{eventName,callbackId:id})});
      }
    };
  }

  const PLUGIN_NAMES=["InAppBrowser","CapgoInAppBrowser"];
  let lastPluginInfo="";

  async function browserPlugin(){
    const coreOk=await coreReady;
    const c=window.Capacitor||cap;
    const avail=n=>{try{return typeof c.isPluginAvailable==="function"?c.isPluginAvailable(n):null;}catch(e){return null;}};
    lastPluginInfo=`Kern ${coreOk?"geladen":"fehlt"}, Brücke ${typeof c.nativePromise==="function"?"ok":"fehlt"}, `+
      PLUGIN_NAMES.map(n=>`${n}: ${avail(n)}`).join(", ");
    const name=PLUGIN_NAMES.find(n=>avail(n)===true)||PLUGIN_NAMES[0];
    if(c.Plugins&&c.Plugins[name])return c.Plugins[name];
    if(typeof c.registerPlugin==="function"){
      try{return c.registerPlugin(name);}catch(e){}
    }
    return bridgePlugin(name);
  }

  async function getHtml(url){
    const r=await fetch(url,{headers:{"Accept":"text/html,application/xhtml+xml","Accept-Language":"en-US,en;q=0.8,de;q=0.6"}});
    const html=await r.text();
    return {status:r.status,html};
  }

  function nextData(html){
    const m=/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html||"");
    if(!m)return null;
    try{return JSON.parse(m[1]);}catch(e){return null;}
  }

  function looksLoggedOut(html){
    return /account\/signin|must first log in|erst einloggen|Sign In<\/a>|Anmelden<\/a>/i.test(html||"")&&!/Sign out|Abmelden/i.test(html||"");
  }

  /* ---------- Login ---------- */

  async function gcLogin(){
    const IAB=await browserPlugin();
    if(!IAB)return {ok:false,message:`In-App-Browser nicht verfügbar [0.21.0 · ${lastPluginInfo}]`};
    try{await IAB.removeAllListeners();}catch(e){}
    let closedByUs=false;
    try{
      await IAB.addListener("urlChangeEvent",async ev=>{
        const u=String(ev&&ev.url||"");
        // Nach erfolgreichem Login leitet geocaching.com von /account/signin weg.
        if(/geocaching\.com\//.test(u)&&!/\/account\/(signin|login|join|oauth)/i.test(u)&&!closedByUs){
          closedByUs=true;
          await sleep(800);
          try{await IAB.close();}catch(e){}
        }
      });
      await IAB.addListener("closeEvent",()=>{
        window.dispatchEvent(new CustomEvent("cr-gc-login-closed"));
      });
    }catch(e){}
    try{
      await IAB.openWebView({
        url:`${GC}/account/signin?returnUrl=${encodeURIComponent("/play")}`,
        title:"geocaching.com Anmeldung",
        toolbarType:"compact"
      });
    }catch(e){
      return {ok:false,message:`Anmeldefenster ließ sich nicht öffnen: ${e&&e.message||e} [0.21.0 · ${lastPluginInfo}]`};
    }
    return {ok:true,browser:"In-App-Browser"};
  }

  /* ---------- Statistik ---------- */

  function statsUrl(profileUrl){
    let u=String(profileUrl||"").replace(/#.*$/,"");
    if(!/[?&]tab=stats/i.test(u))u+=(u.includes("?")?"&":"?")+"tab=stats";
    return u;
  }

  function parseStats(html){
    const out={loginRequired:false,statsHidden:false,totalFinds:null,firstFind:null,yearly:[]};
    const doc=new DOMParser().parseFromString(html,"text/html");
    const block=doc.querySelector('[id$="StatsChronologyControl1_YearlyBreakdown"]');
    if(block){
      for(const tr of block.querySelectorAll("tr")){
        const td=tr.querySelectorAll("td");
        if(td.length<2)continue;
        const y=parseInt(td[0].textContent.trim(),10);
        const c=parseInt(td[1].textContent.replace(/\D/g,""),10);
        if(y>1999&&Number.isFinite(c))out.yearly.push({year:y,count:c});
      }
      out.yearly.sort((a,b)=>a.year-b.year);
    }
    out.details=[];
    for(const row of doc.querySelectorAll(".ProfileDataRow, dl > div")){
      const dt=row.querySelector("dt"),dd=row.querySelector("dd");
      if(!dt||!dd)continue;
      const label=dt.textContent.replace(/\s+/g," ").trim();
      const value=dd.textContent.replace(/\s+/g," ").trim();
      if(label&&value&&!out.details.some(d=>d.label===label))out.details.push({label,value});
    }
    const basicPs=[...doc.querySelectorAll("#BasicFinds p")].map(p=>p.textContent.replace(/\s+/g," ").trim()).filter(Boolean);
    if(basicPs[1])out.habit=basicPs[1];
    const strong=doc.querySelectorAll("#BasicFinds strong");
    if(strong[0])out.totalFinds=parseInt(strong[0].textContent.replace(/\D/g,""),10)||null;
    if(strong[1])out.firstFind=strong[1].textContent.trim();
    if(!out.yearly.length){
      if(looksLoggedOut(html))out.loginRequired=true;
      else out.statsHidden=true;
    }
    return out;
  }

  const STATS_KEY="cacherunde-gcstats-cache";
  async function gcStats(profileUrl,force){
    if(!profileUrl)return {available:false,yearly:[],message:"Keine Geocaching-Profil-URL hinterlegt."};
    const url=statsUrl(profileUrl);
    try{
      const c=JSON.parse(localStorage.getItem(STATS_KEY)||"null");
      const ageH=c?(Date.now()-c.savedAt)/3600000:Infinity;
      if(!force&&c&&c.url===url&&ageH<12&&c.yearly&&c.yearly.length){
        return {...c,available:true,cached:true,cacheAgeHours:Math.floor(ageH),message:`Zwischengespeichert vor ${Math.floor(ageH)} Std.`};
      }
    }catch(e){}
    try{
      const {html}=await getHtml(url);
      const p=parseStats(html);
      if(p.yearly.length){
        const save={url,totalFinds:p.totalFinds,firstFind:p.firstFind,yearly:p.yearly,details:p.details||[],habit:p.habit||null,savedAt:Date.now()};
        try{localStorage.setItem(STATS_KEY,JSON.stringify(save));}catch(e){}
        return {...p,available:true,cached:false,message:"Live von geocaching.com abgerufen."};
      }
      return {...p,available:false,message:p.loginRequired?"Nicht bei geocaching.com angemeldet. Bitte „Bei geocaching.com anmelden“ nutzen.":"Profil geladen, aber keine Jahrestabelle gefunden."};
    }catch(e){
      return {available:false,yearly:[],message:e.message||String(e)};
    }
  }

  /* ---------- Cache-Suche ---------- */

  function simplify(r){
    return {
      code:r.code,id:r.id,name:r.name,
      type:r.geocacheType,container:r.containerType,
      difficulty:r.difficulty,terrain:r.terrain,
      premiumOnly:!!r.premiumOnly,status:r.cacheStatus,
      lat:r.postedCoordinates&&r.postedCoordinates.latitude,
      lon:r.postedCoordinates&&r.postedCoordinates.longitude,
      corrected:r.userCorrectedCoordinates?{lat:r.userCorrectedCoordinates.latitude,lon:r.userCorrectedCoordinates.longitude}:null,
      found:!!r.userFound,dnf:!!r.userDidNotFind,
      favorites:r.favoritePoints||0,
      lastFound:r.lastFoundDate||null,placed:r.placedDate||null,
      owner:r.owner&&r.owner.username||"",
      trackables:r.trackableCount||0,
      attributes:(r.attributes||[]).filter(a=>a.isApplicable).map(a=>a.id)
    };
  }

  async function gcSearch(q){
    const lat=parseFloat(q.get("lat")),lon=parseFloat(q.get("lon"));
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return {ok:false,message:"Kein Suchmittelpunkt."};
    const radius=Math.max(1,Math.min(50,parseFloat(q.get("radius"))||10));
    const hideFound=q.get("hideFound")!=="0";
    const max=Math.max(50,Math.min(2000,parseInt(q.get("max"),10)||1000));
    const results=[];
    let total=null,user=null,isBasic=null,skip=0,pages=0;
    while(results.length<max){
      const url=`${GC}/play/results?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&r=${radius}&sort=distance&asc=true&skip=${skip}${hideFound?"&hf=1":""}`;
      const {status,html}=await getHtml(url);
      const nd=nextData(html);
      const pp=nd&&nd.props&&nd.props.pageProps;
      if(!pp||!pp.gcUser){
        if(pages===0)return {ok:false,loginRequired:true,message:"Nicht bei geocaching.com angemeldet."};
        break;
      }
      if(!pp.searchResults){
        if(pages===0)return {ok:false,message:`Unerwartete Antwort von geocaching.com (HTTP ${status}).`};
        break;
      }
      user=pp.gcUser.username;isBasic=!!pp.isBasic;
      total=pp.searchResults.total;
      const batch=pp.searchResults.results||[];
      results.push(...batch.map(simplify));
      pages++;
      window.dispatchEvent(new CustomEvent("cr-gc-search-progress",{detail:{loaded:results.length,total}}));
      if(batch.length<PAGE_SIZE||results.length>=total)break;
      skip+=PAGE_SIZE;
      await sleep(PAGE_DELAY_MS);
    }
    return {ok:true,user,isBasic,total,pages,truncated:total!=null&&results.length<total,results:results.slice(0,max)};
  }

  async function gcProfileName(profileUrl){
    try{
      const {html}=await getHtml(String(profileUrl||"").replace(/#.*$/,""));
      const m=/Statistics for User:\s*([^<"]+)|Statistiken von\s*([^<"]+)/i.exec(html);
      const name=m?(m[1]||m[2]).trim():null;
      return name?{name}:{message:"Name nicht gefunden"};
    }catch(e){return {message:e.message};}
  }

  /* ---------- Entwürfe (Field Notes) hochladen ---------- */

  function utf16le(str){
    const out=new Uint8Array(2+str.length*2);
    out[0]=0xFF;out[1]=0xFE;
    for(let i=0;i<str.length;i++){const c=str.charCodeAt(i);out[2+2*i]=c&255;out[3+2*i]=c>>8;}
    return out;
  }

  async function gcUploadDrafts(text){
    if(!text||!text.trim())return {ok:false,message:"Keine Logs."};
    const file=new File([utf16le(text)],"geocache_visits.txt",{type:"text/plain"});
    const fd=new FormData();
    fd.append("file-0",file);
    let r,body="";
    try{
      r=await fetch(`${GC}/api/proxy/web/v1/LogDrafts/upload`,{
        method:"POST",
        headers:{"Accept":"application/json, text/javascript, */*; q=0.01","X-Requested-With":"XMLHttpRequest"},
        body:fd
      });
      body=await r.text();
    }catch(e){
      return {ok:false,message:"Netzwerkfehler: "+(e.message||e)};
    }
    if(r.status===401||r.status===403||/account\/signin/i.test(body)&&!/^\s*[\[{]/.test(body)){
      return {ok:false,loginRequired:true,message:"Nicht bei geocaching.com angemeldet."};
    }
    if(!r.ok){
      return {ok:false,message:`geocaching.com meldet HTTP ${r.status}: ${body.slice(0,200)}`};
    }
    let data=null,summary="";
    try{data=JSON.parse(body);}catch(e){}
    if(data&&typeof data==="object"){
      const n=["successCount","SuccessCount","uploadedCount","count","Count"].map(k=>data[k]).find(v=>typeof v==="number");
      if(typeof n==="number")summary=`geocaching.com bestätigt ${n}.`;
      const err=data.errorMessage||data.ErrorMessage||data.message||data.Message;
      if(data.success===false||data.Success===false)return {ok:false,message:err||"geocaching.com hat den Upload abgelehnt.",response:data};
    }
    return {ok:true,status:r.status,summary,response:data??body.slice(0,300)};
  }

  /* ---------- Seite von geocaching.com im In-App-Browser zeigen ---------- */

  async function gcOpenPage(url,title){
    const IAB=await browserPlugin();
    if(!IAB)throw new Error("In-App-Browser nicht verfügbar");
    try{await IAB.removeAllListeners();}catch(e){}
    await IAB.openWebView({url,title:title||"geocaching.com",toolbarType:"compact"});
    return {ok:true};
  }

  /* ---------- Cacherstats-Ranglisten ---------- */

  const CS="https://www.cacherstats.com/cgi-bin/";
  const CS_CACHE="cacherunde-cacherstats-cache";

  function csChallenge(html){
    return !html||/please wait while your request is being verified|checking your browser|challenge-platform|cf-chl|enable javascript and cookies/i.test(html);
  }
  function plainText(html){
    const d=new DOMParser().parseFromString(html||"","text/html");
    d.querySelectorAll("script,style").forEach(n=>n.remove());
    return (d.body?d.body.textContent:"").replace(/\s+/g," ").trim();
  }
  async function csGet(url){
    const r=await fetch(url,{headers:{"Accept":"text/html","Accept-Language":"en-US,en;q=0.8,de;q=0.6"}});
    return {status:r.status,html:await r.text(),url};
  }

  // Formular auf der Seite finden und mit dem Benutzernamen (bzw. GUID) ausfüllen.
  async function csSubmitForm(pageUrl,html,username,guid){
    const doc=new DOMParser().parseFromString(html,"text/html");
    const forms=[...doc.querySelectorAll("form")];
    const textInputs=f=>[...f.querySelectorAll("input")].filter(i=>["text","search",""].includes((i.getAttribute("type")||"").toLowerCase()));
    const form=forms.find(f=>/cacher|name/i.test(f.textContent)&&textInputs(f).length)||forms.find(f=>textInputs(f).length);
    if(!form)return {error:"kein Suchformular gefunden",fields:[]};
    const params=new URLSearchParams();
    for(const el of form.querySelectorAll("input,select")){
      const name=el.getAttribute("name");
      if(!name)continue;
      const type=(el.getAttribute("type")||"").toLowerCase();
      if(["submit","button","image","reset"].includes(type))continue;
      if((type==="checkbox"||type==="radio")&&!el.hasAttribute("checked"))continue;
      let value=el.tagName==="SELECT"?(el.querySelector("option[selected]")||el.querySelector("option"))?.getAttribute("value")||"":el.getAttribute("value")||"";
      params.set(name,value);
    }
    const inputs=textInputs(form);
    const guidField=inputs.find(i=>/guid/i.test(i.name));
    const nameField=inputs.find(i=>/cacher|name|user/i.test(i.name)&&!/guid/i.test(i.name))||inputs.find(i=>!/guid/i.test(i.name))||inputs[0];
    if(nameField)params.set(nameField.name,username);
    if(guid&&guidField)params.set(guidField.name,guid);
    for(const lang of ["Lang","Language"])if(params.has(lang))params.set(lang,"EN");
    const submit=form.querySelector("input[type=submit][name],button[type=submit][name]");
    if(submit)params.set(submit.getAttribute("name"),submit.getAttribute("value")||"");
    const action=new URL(form.getAttribute("action")||pageUrl,pageUrl).toString();
    const method=(form.getAttribute("method")||"get").toUpperCase();
    const fields=[...params.keys()];
    const r=method==="POST"
      ? await fetch(action,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"text/html"},body:params.toString()})
      : await fetch(action+(action.includes("?")?"&":"?")+params.toString(),{headers:{"Accept":"text/html"}});
    return {html:await r.text(),status:r.status,fields,method,action,nameField:nameField&&nameField.name};
  }

  const LOC_KEYS={World:"worldRank",Welt:"worldRank",Europe:"europeRank",Europa:"europeRank",Germany:"germanyRank",Deutschland:"germanyRank"};
  function parseLocations(html){
    const out={};
    // Links wie RankingList.pl?...Loc=Germany...&RANK=52364
    const re=/RankingList\.pl\?[^"'<>\s]*?Loc=([^&"'<>\s]+)[^"'<>\s]*?(?:RANK|Rank|rank|ROW|Row)=([0-9]+)/g;
    let m;
    while((m=re.exec(html))){
      const loc=decodeURIComponent(m[1].replace(/\+/g," "));
      const key=LOC_KEYS[loc];
      if(key&&!out[key])out[key]=+m[2];
    }
    // Tabellenzeilen: "World | 123,456" usw.
    const doc=new DOMParser().parseFromString(html,"text/html");
    for(const tr of doc.querySelectorAll("tr")){
      const cells=[...tr.querySelectorAll("td,th")].map(c=>c.textContent.replace(/\s+/g," ").trim());
      const locIdx=cells.findIndex(c=>LOC_KEYS[c]);
      if(locIdx<0)continue;
      const key=LOC_KEYS[cells[locIdx]];
      if(out[key])continue;
      const num=cells.slice(locIdx+1).map(c=>c.replace(/[.,\s]/g,"")).find(c=>/^#?\d{1,9}$/.test(c));
      if(num)out[key]=+num.replace("#","");
    }
    const t=plainText(html);
    const f=/Total\s+Finds\s*:?\s*([0-9][0-9,.]*)/i.exec(t);
    if(f)out.finds=+f[1].replace(/\D/g,"");
    return out;
  }

  // Rangliste einer Region nach dem Namen durchsuchen (Rückfall)
  async function csRankingList(loc,username){
    const base=`${CS}RankingList.pl?Lang=EN&Loc=${encodeURIComponent(loc)}&ROW=1`;
    const page=await csGet(base);
    if(csChallenge(page.html))return {blocked:true};
    const scan=html=>{
      const doc=new DOMParser().parseFromString(html,"text/html");
      for(const tr of doc.querySelectorAll("tr")){
        const hit=[...tr.querySelectorAll("a")].some(a=>a.textContent.trim().toLowerCase()===username.toLowerCase());
        if(!hit)continue;
        const nums=[...tr.querySelectorAll("td")].map(td=>td.textContent.replace(/[.,\s]/g,"")).filter(x=>/^\d{1,9}$/.test(x)).map(Number);
        if(nums.length>=2)return {rank:nums[0],finds:nums[nums.length>2?2:1]};
      }
      return null;
    };
    let hit=scan(page.html);
    if(hit)return hit;
    const sub=await csSubmitForm(base,page.html,username,null).catch(()=>null);
    if(sub&&sub.html&&!csChallenge(sub.html))hit=scan(sub.html);
    return hit||{};
  }

  async function cacherstats(q){
    const user=String(q.get("user")||"").trim();
    if(!user)return {matched:false,message:"Kein Cacherstats-Benutzername hinterlegt."};
    const force=q.get("force")==="1";
    try{
      const c=JSON.parse(localStorage.getItem(CS_CACHE)||"null");
      const ageDays=c?(Date.now()-c.savedAt)/86400000:Infinity;
      if(!force&&c&&c.user===user&&ageDays<1)return {...c,matched:true,cached:true,cacheAgeDays:Math.floor(ageDays),sourceMethod:"Zwischenspeicher"};
    }catch(e){}
    const guidM=/[?&]guid=([0-9a-f-]{36})/i.exec(q.get("profileUrl")||"");
    const guid=guidM?guidM[1]:null;
    const debug=[];
    let res={};
    try{
      const page=await csGet(`${CS}GeocacherLocations.pl`);
      if(csChallenge(page.html))return {matched:false,blocked:true,message:"Cacherstats verlangt eine Browser-Prüfung."};
      const sub=await csSubmitForm(page.url,page.html,user,guid);
      debug.push(`Formular: ${sub.method||"?"} ${sub.action||""} Felder [${(sub.fields||[]).join(", ")}] Name→${sub.nameField||"?"}${sub.error?" ("+sub.error+")":""}`);
      if(sub.html){
        if(csChallenge(sub.html))return {matched:false,blocked:true,message:"Cacherstats verlangt eine Browser-Prüfung."};
        res=parseLocations(sub.html);
        if(!res.worldRank&&!res.germanyRank)debug.push("Antwort: "+plainText(sub.html).slice(0,300));
      }
    }catch(e){debug.push("GeocacherLocations: "+(e.message||e));}
    let method="GeocacherLocations.pl";
    for(const [loc,key] of [["Germany","germanyRank"],["World","worldRank"]]){
      if(res[key])continue;
      try{
        const r=await csRankingList(loc,user);
        if(r.blocked)return {matched:false,blocked:true,message:"Cacherstats verlangt eine Browser-Prüfung."};
        if(r.rank){res[key]=r.rank;if(!res.finds&&r.finds)res.finds=r.finds;method+=` + RankingList ${loc}`;}
      }catch(e){debug.push(`RankingList ${loc}: `+(e.message||e));}
    }
    const matched=!!(res.worldRank||res.germanyRank||res.europeRank);
    if(!matched)return {matched:false,blocked:false,message:"Kein Treffer bei Cacherstats.",debug:debug.join(" | ")};
    const out={name:user,user,worldRank:res.worldRank||null,europeRank:res.europeRank||null,germanyRank:res.germanyRank||null,
      finds:res.finds||null,updated:new Date().toISOString().slice(0,10),savedAt:Date.now()};
    try{localStorage.setItem(CS_CACHE,JSON.stringify(out));}catch(e){}
    return {...out,matched:true,cached:false,sourceMethod:method,directLookup:method.startsWith("GeocacherLocations")};
  }

  window.CR_NATIVE={gcLogin,gcStats,gcSearch,gcProfileName,gcUploadDrafts,gcOpenPage,cacherstats};
})();
