/* CacheRunde – Offline-Karte
 *
 * Lädt eine Kartendatei (PMTiles, Protomaps-Basiskarte aus OpenStreetMap-Daten) aus der
 * GitHub-Release "maps" einmal auf das Handy und zeigt sie mit protomaps-leaflet an.
 * Die Datei wird stückweise (HTTP-Range) über den lokalen Capacitor-Server gelesen.
 * Nur in der Android-App; im Browser zeigt die Karte weiter die OSM-Kacheln.
 */
(function(){
  "use strict";

  const INDEX_URL="https://github.com/shuvit82/cacherunde/releases/download/maps/maps.json";
  const ASSET_BASE="https://github.com/shuvit82/cacherunde/releases/download/maps/";
  const STORE_KEY="cacherunde-offline-maps";
  const AUTO_KEY="cacherunde-offline-auto";
  const DIR="DATA";
  const LIB_LOCAL="vendor/protomaps-leaflet.js";
  const LIB_CDN="https://unpkg.com/protomaps-leaflet@5.1.0/dist/protomaps-leaflet.js";

  const $=s=>document.querySelector(s);
  const isNative=()=>!!(window.CR_API&&window.CR_API.isNative&&window.CR_API.isNative());

  let map=null, osmLayer=null, offLayer=null, offMeta=null, layerControl=null;
  let manualChoice=false, switching=false, busy=false, available=null;

  /* ---------- Speicher der installierten Karten ---------- */
  function installed(){
    try{return JSON.parse(localStorage.getItem(STORE_KEY)||"[]");}catch(e){return [];}
  }
  function saveInstalled(list){
    try{localStorage.setItem(STORE_KEY,JSON.stringify(list));}catch(e){}
  }
  function autoOn(){
    try{return localStorage.getItem(AUTO_KEY)!=="0";}catch(e){return true;}
  }

  /* ---------- Capacitor-Plugins ohne Bundler ansprechen ---------- */
  function plugin(name){
    const c=window.Capacitor;
    if(!c)return null;
    if(c.Plugins&&c.Plugins[name])return c.Plugins[name];
    if(typeof c.registerPlugin==="function"){try{return c.registerPlugin(name);}catch(e){}}
    if(typeof c.nativePromise!=="function")return null;
    return new Proxy({},{get:(_,method)=>{
      if(method==="then")return undefined;
      if(method==="addListener")return (eventName,cb)=>{
        const id=c.nativeCallback(name,"addListener",{eventName},cb);
        return Promise.resolve({remove:()=>c.nativePromise(name,"removeListener",{eventName,callbackId:id})});
      };
      return o=>c.nativePromise(name,method,o||{});
    }});
  }
  const FS=()=>plugin("Filesystem");
  const FT=()=>plugin("FileTransfer");

  async function fileUri(file){
    const r=await FS().getUri({directory:DIR,path:"maps/"+file});
    return r.uri;
  }
  function webUrl(uri){
    const c=window.Capacitor;
    return c&&typeof c.convertFileSrc==="function"?c.convertFileSrc(uri):uri;
  }

  /* ---------- Hilfen ---------- */
  function fmtSize(b){
    if(!b&&b!==0)return "?";
    return b>=1073741824?(b/1073741824).toFixed(2).replace(".",",")+" GB":Math.round(b/1048576)+" MB";
  }
  function fmtDate(d){
    return d&&/^\d{8}$/.test(d)?`${d.slice(6,8)}.${d.slice(4,6)}.${d.slice(0,4)}`:(d||"?");
  }
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function status(msg){const el=$("#offlineMapStatus");if(el)el.textContent=msg||"";}
  function progress(done,total,label){
    const box=$("#offlineMapProgress");
    if(!box)return;
    if(done==null){box.classList.add("hidden");return;}
    box.classList.remove("hidden");
    const pct=total?Math.min(100,done/total*100):0;
    $("#offlineMapBar").style.width=pct.toFixed(1)+"%";
    $("#offlineMapProgressText").textContent=label||(total?`${fmtSize(done)} / ${fmtSize(total)} (${Math.round(pct)} %)`:fmtSize(done));
  }

  function loadScript(src){
    return new Promise((res,rej)=>{
      const s=document.createElement("script");
      s.src=src;s.onload=()=>res();s.onerror=()=>rej(new Error("Laden fehlgeschlagen: "+src));
      document.head.appendChild(s);
    });
  }
  let libPromise=null;
  function loadLib(){
    if(window.protomapsL)return Promise.resolve();
    if(!libPromise){
      libPromise=loadScript(LIB_LOCAL).catch(()=>loadScript(LIB_CDN)).then(()=>{
        if(!window.protomapsL)throw new Error("Kartenbibliothek protomaps-leaflet nicht verfügbar.");
      });
      libPromise.catch(()=>{libPromise=null;});
    }
    return libPromise;
  }

  /* Prüft, ob die Datei stückweise gelesen werden kann (Voraussetzung für die Anzeige). */
  async function probe(url){
    const f=typeof window.CapacitorWebFetch==="function"?window.CapacitorWebFetch:fetch;
    const r=await f(url,{headers:{Range:"bytes=0-6"}});
    const len=Number(r.headers.get("content-length")||0);
    if(r.status!==206&&(len===0||len>64)){
      try{r.body&&r.body.cancel();}catch(e){}
      throw new Error("Lokaler Server liefert keine Teilstücke (HTTP "+r.status+").");
    }
    const buf=new Uint8Array(await r.arrayBuffer());
    const magic=String.fromCharCode(...buf.slice(0,7));
    if(magic!=="PMTiles")throw new Error(`Kartendatei unlesbar (HTTP ${r.status}, Kennung „${magic}“).`);
    return r.status;
  }

  /* ---------- Karte ---------- */
  function inBbox(m,ll){
    const b=m.bbox;
    return b&&ll.lng>=b[0]&&ll.lat>=b[1]&&ll.lng<=b[2]&&ll.lat<=b[3]&&
      (!m.radiusKm||map.distance([m.lat,m.lon],ll)<=m.radiusKm*1000*0.97);
  }
  function showLayer(which){
    if(!map||!offLayer)return;
    const want=which==="offline"?offLayer:osmLayer;
    const other=which==="offline"?osmLayer:offLayer;
    switching=true;
    try{
      if(map.hasLayer(other))map.removeLayer(other);
      if(!map.hasLayer(want)){want.addTo(map);want.bringToBack&&want.bringToBack();}
    }finally{switching=false;}
  }
  function autoSwitch(){
    if(!offLayer||manualChoice||!autoOn())return;
    showLayer(inBbox(offMeta,map.getCenter())?"offline":"online");
  }

  function onBaseChange(){if(!switching)manualChoice=true;}

  async function activate(){
    if(!map||!isNative())return;
    const m=installed()[0];
    if(layerControl){map.removeControl(layerControl);layerControl=null;}
    if(offLayer){if(map.hasLayer(offLayer))map.removeLayer(offLayer);offLayer=null;offMeta=null;}
    if(osmLayer&&!map.hasLayer(osmLayer))osmLayer.addTo(map);
    if(!m)return;
    try{
      await loadLib();
      const url=webUrl(await fileUri(m.file));
      await probe(url);
      offLayer=protomapsL.leafletLayer({
        url, flavor:"light", lang:"de", maxDataZoom:m.maxzoom||15, maxZoom:20,
        attribution:'© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>'
      });
      offMeta=m;
      layerControl=L.control.layers({"Offline-Karte":offLayer,"Online (OSM)":osmLayer},null,{position:"topright"}).addTo(map);
      map.off("baselayerchange",onBaseChange).on("baselayerchange",onBaseChange);
      if(autoOn()&&inBbox(m,map.getCenter()))showLayer("offline");
      status(`Offline-Karte aktiv: ${m.name}`);
    }catch(e){
      offLayer=null;offMeta=null;
      status("Offline-Karte konnte nicht angezeigt werden: "+(e.message||e));
    }
  }

  function attach(leafletMap,osm){
    map=leafletMap;osmLayer=osm;
    map.on("moveend",autoSwitch);
    activate();
  }

  /* ---------- Karten-Verwaltung (Karte „Ich“) ---------- */
  async function fetchIndex(){
    const r=await fetch(INDEX_URL+"?t="+Date.now(),{cache:"no-store"});
    if(!r.ok)throw new Error("Kartenliste nicht abrufbar (HTTP "+r.status+")");
    const j=await r.json();
    return Array.isArray(j.maps)?j.maps:[];
  }

  function render(){
    const host=$("#offlineMapList");
    if(!host)return;
    if(!isNative()){
      host.innerHTML='<span class="muted">Offline-Karten gibt es nur in der Android-App.</span>';
      return;
    }
    const inst=installed();
    const ids=new Set([...(available||[]).map(m=>m.id),...inst.map(m=>m.id)]);
    if(!ids.size){host.innerHTML='<span class="muted">Keine Karten gefunden. „Verfügbare Karten abrufen“ tippen.</span>';return;}
    host.innerHTML=[...ids].map(id=>{
      const a=(available||[]).find(m=>m.id===id);
      const i=inst.find(m=>m.id===id);
      const m=a||i;
      const newer=a&&i&&(a.osmDate!==i.osmDate||a.size!==i.size);
      const state=i?(newer?`gespeichert (Stand ${fmtDate(i.osmDate)}) – neuere Version verfügbar`:`gespeichert · Stand ${fmtDate(i.osmDate)}`):"nicht gespeichert";
      const btns=[];
      if(a&&(!i||newer))btns.push(`<button class="${i?"ghost":"primary"}" data-om-dl="${esc(id)}">${i?"Aktualisieren":"Herunterladen"} (${fmtSize(a.size)})</button>`);
      if(i)btns.push(`<button class="ghost" data-om-del="${esc(id)}">Löschen</button>`);
      return `<div class="offline-map-item"><div><strong>${esc(m.name)}</strong><div class="meta">${fmtSize(m.size)} · ${esc(state)}</div></div><div class="btns">${btns.join("")}</div></div>`;
    }).join("");
    host.querySelectorAll("[data-om-dl]").forEach(b=>b.onclick=()=>download(b.dataset.omDl));
    host.querySelectorAll("[data-om-del]").forEach(b=>b.onclick=()=>remove(b.dataset.omDel));
  }

  async function refresh(){
    if(!isNative()){render();return;}
    status("Rufe verfügbare Karten ab …");
    try{
      available=await fetchIndex();
      status(available.length?"":"Noch keine Karten veröffentlicht.");
    }catch(e){status(e.message||String(e));}
    render();
  }

  async function download(id){
    if(busy)return;
    const m=(available||[]).find(x=>x.id===id);
    if(!m)return;
    const fs=FS(), ft=FT();
    if(!fs||!ft){status("Download-Funktion fehlt in dieser App-Version (neue APK nötig).");return;}
    busy=true;
    let listener=null;
    const part=m.file+".part";
    try{
      try{await fs.mkdir({directory:DIR,path:"maps",recursive:true});}catch(e){}
      try{await fs.deleteFile({directory:DIR,path:"maps/"+part});}catch(e){}
      const path=await fileUri(part);
      progress(0,m.size);
      status(`Lade ${m.name} … bitte App geöffnet lassen.`);
      try{
        listener=await ft.addListener("progress",p=>{
          if(p&&typeof p.bytes==="number")progress(p.bytes,p.lengthComputable&&p.contentLength?p.contentLength:m.size);
        });
      }catch(e){}
      await ft.downloadFile({url:ASSET_BASE+encodeURIComponent(m.file),path,progress:true});
      const st=await fs.stat({directory:DIR,path:"maps/"+part});
      if(m.size&&Number(st.size)!==m.size)throw new Error(`Datei unvollständig (${fmtSize(Number(st.size))} von ${fmtSize(m.size)}).`);
      progress(m.size,m.size,"Prüfe Datei …");
      // alte Fassung ersetzen
      if(map&&offLayer&&map.hasLayer(offLayer))map.removeLayer(offLayer);
      try{await fs.deleteFile({directory:DIR,path:"maps/"+m.file});}catch(e){}
      await fs.rename({directory:DIR,from:"maps/"+part,toDirectory:DIR,to:"maps/"+m.file});
      await probe(webUrl(await fileUri(m.file)));
      // erst einmal nur eine Karte gleichzeitig verwenden
      for(const old of installed().filter(x=>x.id!==m.id&&x.file!==m.file)){
        try{await fs.deleteFile({directory:DIR,path:"maps/"+old.file});}catch(e){}
      }
      saveInstalled([{...m,installedAt:new Date().toISOString()}]);
      status(`${m.name} gespeichert (${fmtSize(m.size)}).`);
      manualChoice=false;
      await activate();
    }catch(e){
      try{await fs.deleteFile({directory:DIR,path:"maps/"+part});}catch(x){}
      status("Download fehlgeschlagen: "+(e.message||e));
    }finally{
      if(listener&&listener.remove)try{listener.remove();}catch(e){}
      progress(null);busy=false;render();
    }
  }

  async function remove(id){
    if(busy)return;
    const m=installed().find(x=>x.id===id);
    if(!m)return;
    if(!confirm(`Offline-Karte „${m.name}“ (${fmtSize(m.size)}) vom Handy löschen?`))return;
    try{await FS().deleteFile({directory:DIR,path:"maps/"+m.file});}catch(e){}
    saveInstalled(installed().filter(x=>x.id!==id));
    await activate();
    status("Offline-Karte gelöscht.");
    render();
  }

  function initCard(){
    const auto=$("#offlineMapAuto");
    if(auto){
      auto.checked=autoOn();
      auto.onchange=()=>{
        try{localStorage.setItem(AUTO_KEY,auto.checked?"1":"0");}catch(e){}
        manualChoice=false;
        if(auto.checked)autoSwitch();
      };
    }
    const btn=$("#offlineMapRefresh");
    if(btn)btn.onclick=refresh;
    render();
    if(isNative()&&installed().length)status(`Gespeichert: ${installed()[0].name}`);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initCard);
  else initCard();

  window.CR_OFFLINE_MAP={attach,refresh,installed,activate};
})();
