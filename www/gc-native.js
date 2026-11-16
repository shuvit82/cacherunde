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

  function browserPlugin(){
    return (cap.Plugins&&cap.Plugins.InAppBrowser)||(cap.registerPlugin&&cap.registerPlugin("InAppBrowser"));
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
    const IAB=browserPlugin();
    if(!IAB)return {ok:false,message:"In-App-Browser nicht verfügbar."};
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
    await IAB.openWebView({
      url:`${GC}/account/signin?returnUrl=${encodeURIComponent("/play")}`,
      title:"geocaching.com Anmeldung",
      toolbarType:"compact"
    });
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
        const save={url,totalFinds:p.totalFinds,firstFind:p.firstFind,yearly:p.yearly,savedAt:Date.now()};
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

  window.CR_NATIVE={gcLogin,gcStats,gcSearch,gcProfileName};
})();
