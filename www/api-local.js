/* CacheRunde – lokale API (ab 0.13.0)
 *
 * Ersetzt den früheren PowerShell-Server. Alle Aufrufe der App an "/api/..."
 * werden hier abgefangen und direkt im Browser bzw. in der App beantwortet –
 * im selben Antwortformat wie zuvor der Server.
 *
 * - Offene Dienste (OSRM-Routing, Nominatim, Overpass, Open-Meteo) werden direkt aufgerufen.
 * - Dienste, die normale Webseiten nicht abfragen dürfen (geocaching.com, Cacherstats),
 *   stehen nur in der Android-App zur Verfügung (siehe CR_NATIVE).
 */
(function(){
  "use strict";

  const VERSION="0.14.1";
  const TILE_CACHE="cacherunde-tiles";
  const nativeFetch=window.fetch.bind(window);

  const OVERPASS_ENDPOINTS=[
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ];

  // Wird in der Android-App durch native Implementierungen ergänzt.
  const native=()=>window.CR_NATIVE||null;
  const isNative=()=>!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());

  /* ---------- Hilfsfunktionen ---------- */

  function json(obj,status=200){
    return new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json; charset=utf-8"}});
  }
  function text(msg,status=200){
    return new Response(String(msg),{status,headers:{"Content-Type":"text/plain; charset=utf-8"}});
  }
  async function fetchWithTimeout(url,init={},ms=30000){
    const ctrl=new AbortController();
    const t=setTimeout(()=>ctrl.abort(),ms);
    try{
      return await nativeFetch(url,{...init,signal:ctrl.signal});
    }finally{
      clearTimeout(t);
    }
  }
  async function getJson(url,ms=30000){
    const r=await fetchWithTimeout(url,{headers:{"Accept":"application/json"}},ms);
    if(!r.ok)throw new Error(`HTTP ${r.status} von ${new URL(url).hostname}`);
    return r.json();
  }
  // Weiterleiten wie früher Proxy-Get: Statuscode und Inhalt 1:1 an die App.
  async function passThrough(url,ms=45000){
    try{
      const r=await fetchWithTimeout(url,{headers:{"Accept":"application/json"}},ms);
      const body=await r.text();
      return new Response(body,{status:r.ok?200:502,headers:{"Content-Type":"application/json; charset=utf-8"}});
    }catch(e){
      return text(e.message||String(e),502);
    }
  }
  async function overpass(query){
    const errors=[];
    for(const ep of OVERPASS_ENDPOINTS){
      try{
        const r=await fetchWithTimeout(ep,{
          method:"POST",
          headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8","Accept":"application/json"},
          body:"data="+encodeURIComponent(query)
        },15000);
        if(r.ok)return await r.json();
        errors.push(`${ep} → HTTP ${r.status}`);
      }catch(e){
        errors.push(`${ep} → ${e.name==="AbortError"?"Zeitüberschreitung":e.message}`);
      }
    }
    throw new Error("Alle Overpass-Server fehlgeschlagen: "+errors.join(" | "));
  }
  function num(v){const n=parseFloat(v);return Number.isFinite(n)?n:null;}
  function bbox(lat,lon,dLat,dLon){
    return `${lon-dLon},${lat+dLat},${lon+dLon},${lat-dLat}`; // left,top,right,bottom
  }
  async function readBody(init){
    const b=init&&init.body;
    if(b==null)return "";
    if(typeof b==="string")return b;
    try{return await new Response(b).text();}catch(e){return "";}
  }
  function notInBrowser(what){
    return `${what} ist im Browser nicht möglich (die Seite blockiert Zugriffe von anderen Webseiten). In der Android-App funktioniert es.`;
  }

  /* ---------- Endpunkte ---------- */

  const routes={

    async "/api/foot"(q){
      const coords=q.get("coords");
      if(!coords)return text("coords fehlt",400);
      const steps=q.get("steps")||"false";
      return passThrough(`https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=${steps}`);
    },

    async "/api/car"(q){
      const coords=q.get("coords");
      if(!coords)return text("coords fehlt",400);
      return passThrough(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`);
    },

    async "/api/elevation"(q){
      const lat=q.get("lat"),lon=q.get("lon");
      if(!lat||!lon)return text("lat/lon fehlt",400);
      return passThrough(`https://api.open-meteo.com/v1/elevation?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`);
    },

    async "/api/reverse"(q){
      const lat=q.get("lat"),lon=q.get("lon");
      if(!lat||!lon)return text("lat/lon fehlt",400);
      return passThrough(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    },

    async "/api/geocode"(q){
      const query=q.get("q");
      if(!query)return text("q fehlt",400);
      const limit=q.get("limit")||"10";
      let url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${encodeURIComponent(limit)}&addressdetails=1&q=${encodeURIComponent(query)}`;
      const la=num(q.get("lat")),lo=num(q.get("lon"));
      if(la!=null&&lo!=null)url+=`&viewbox=${bbox(la,lo,2.0,2.5)}`;
      try{
        const arr=await getJson(url);
        const results=(arr||[]).map(i=>{
          const a=i.address||{};
          return {lat:i.lat,lon:i.lon,name:a.village||a.town||a.city||i.display_name,display_name:i.display_name};
        });
        return json({results});
      }catch(e){return text(e.message,502);}
    },

    async "/api/parking"(q){
      const lat=num(q.get("lat")),lon=num(q.get("lon"));
      if(lat==null||lon==null)return text("lat/lon fehlt",400);
      const r=num(q.get("radius"))||2500;
      const dLat=r/111320;
      const dLon=r/(111320*Math.max(0.1,Math.abs(Math.cos(lat*Math.PI/180))));
      const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=30&bounded=1&layer=poi&amenity=parking&viewbox=${bbox(lat,lon,dLat,dLon)}&addressdetails=1&extratags=1`;
      try{
        const arr=await getJson(url);
        const results=(arr||[]).map(i=>{
          const x=i.extratags||{};
          return {
            lat:i.lat,lon:i.lon,name:i.name||i.display_name,display_name:i.display_name,
            osm_type:i.osm_type,osm_id:i.osm_id,
            access:x.access||"",parking:x.parking||"",fee:x.fee||"",capacity:x.capacity||0,
            hiking:x.hiking||"",surface:x.surface||"",lit:x.lit||"",maxstay:x.maxstay||"",
            source:"Nominatim"
          };
        });
        return json({results});
      }catch(e){return text(e.message,502);}
    },

    async "/api/parking-fallback"(q){
      const lat=num(q.get("lat")),lon=num(q.get("lon"));
      if(lat==null||lon==null)return text("lat/lon fehlt",400);
      const vb=bbox(lat,lon,0.018,0.025);
      const all=[];
      for(const term of ["parking","Parkplatz","Wanderparkplatz"]){
        try{
          const arr=await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&bounded=1&viewbox=${vb}&q=${encodeURIComponent(term)}`);
          for(const i of arr||[])all.push({lat:i.lat,lon:i.lon,name:i.display_name,osm_id:i.osm_id});
        }catch(e){}
        if(all.length>=8)break;
        await new Promise(r=>setTimeout(r,1100)); // Nominatim: max. 1 Anfrage/Sekunde
      }
      const seen=new Set();
      const results=all.filter(i=>{const k=`${i.lat},${i.lon}`;if(seen.has(k))return false;seen.add(k);return true;}).slice(0,8);
      return json({results});
    },

    async "/api/roadside-parking"(q){
      const lat=num(q.get("lat")),lon=num(q.get("lon"));
      if(lat==null||lon==null)return text("lat/lon fehlt",400);
      const r=Math.max(500,Math.min(4000,num(q.get("radius"))||2500));
      const query=`[out:json][timeout:12];way(around:${r},${lat},${lon})["highway"~"^(residential|living_street|unclassified)$"]["access"!~"^(private|no)$"]["motor_vehicle"!~"^(private|no)$"];out tags geom 50;`;
      try{
        const data=await overpass(query);
        const results=[];
        for(const e of data.elements||[]){
          const t=e.tags,g=e.geometry;
          if(!t||!g||g.length<2)continue;
          const pb=t["parking:both"]||"",pl=t["parking:left"]||"",pr=t["parking:right"]||"",restr=t["parking:both:restriction"]||"";
          if(pb==="no"||(pl==="no"&&pr==="no")||/no_parking|no_stopping/.test(restr))continue;
          const mid=g[Math.floor((g.length-1)/2)];
          if(!mid)continue;
          const roadName=t.name||"Wohnstraße";
          results.push({
            lat:mid.lat,lon:mid.lon,name:"Straßenrand · "+roadName,roadName,roadType:t.highway||"",
            access:t.access||"",parking:"roadside_candidate",fee:"",capacity:0,
            source:"OSM Straße (Fallback)",osm_type:"way",osm_id:e.id
          });
          if(results.length>=16)break;
        }
        return json({results});
      }catch(e){return json({results:[]});}
    },

    async "/api/lodging"(q){
      const lat=num(q.get("lat")),lon=num(q.get("lon"));
      if(lat==null||lon==null)return text("lat/lon fehlt",400);
      const type=q.get("type")||"";
      const r=num(q.get("radius"))||20000;
      const kinds={
        camping:["camp_site"],camper:["caravan_site"],
        hotel:["hotel","guest_house","hostel","motel"],apartment:["apartment","chalet"],
        any:["camp_site","caravan_site","hotel","guest_house","hostel","motel","apartment","chalet"]
      }[type]||["hotel","camp_site"];
      const parts=kinds.map(k=>`nwr["tourism"="${k}"](around:${r},${lat},${lon});`).join("");
      try{
        const data=await overpass(`[out:json][timeout:15];(${parts});out center tags;`);
        const results=[];
        for(const e of data.elements||[]){
          const elat=e.lat??e.center?.lat,elon=e.lon??e.center?.lon;
          if(elat==null||elon==null)continue;
          const t=e.tags||{};
          results.push({
            lat:elat,lon:elon,name:t.name||"Unterkunft",type:t.tourism||type,
            address:t["addr:city"]||"",website:t.website||t["contact:website"]||"",
            rating:t.stars||null,reviewCount:null,osmId:e.id
          });
          if(results.length>=40)break;
        }
        return json({results});
      }catch(e){return text(e.message,502);}
    },

    async "/api/landcover"(q,init){
      try{
        const o=JSON.parse(await readBody(init)||"{}");
        const pts=o.points||[];
        if(!pts.length)throw new Error("Keine Punkte");
        const lats=pts.map(p=>+p.lat),lons=pts.map(p=>+p.lon);
        const s=Math.min(...lats)-0.001,n=Math.max(...lats)+0.001,w=Math.min(...lons)-0.001,e=Math.max(...lons)+0.001;
        const bb=`(${s},${w},${n},${e})`;
        let share=0;
        try{
          const data=await overpass(`[out:json][timeout:12];(way["natural"="wood"]${bb};way["landuse"="forest"]${bb};relation["natural"="wood"]${bb};relation["landuse"="forest"]${bb};);out center;`);
          const count=(data.elements||[]).length;
          if(count>0)share=Math.min(0.95,0.15+Math.log10(count+1)*0.25);
        }catch(err){}
        return json({forestShare:share});
      }catch(e){return text(e.message,500);}
    },

    async "/api/overpass"(q,init){
      try{
        const body=await readBody(init);
        const query=decodeURIComponent((body.startsWith("data=")?body.slice(5):body).replace(/\+/g," "));
        return json(await overpass(query));
      }catch(e){return text(e.message,502);}
    },

    async "/api/google-places-test"(q,init){
      let o={};try{o=JSON.parse(await readBody(init)||"{}");}catch(e){}
      if(!o.key)return json({ok:false,message:"API-Key fehlt"},400);
      try{
        const r=await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText",{
          method:"POST",
          headers:{"Content-Type":"application/json","X-Goog-Api-Key":o.key,"X-Goog-FieldMask":"places.id"},
          body:JSON.stringify({textQuery:"Brandenburg Gate Berlin",maxResultCount:1})
        },20000);
        if(!r.ok){
          let msg=`HTTP ${r.status}`;
          try{msg=(await r.json()).error?.message||msg;}catch(e){}
          return json({ok:false,message:msg},502);
        }
        return json({ok:true});
      }catch(e){return json({ok:false,message:e.message},502);}
    },

    async "/api/google-place-rating"(q,init){
      let o={};try{o=JSON.parse(await readBody(init)||"{}");}catch(e){}
      if(!o.key||!o.name)return json({matched:false},400);
      const lat=+o.lat,lon=+o.lon;
      try{
        const r=await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText",{
          method:"POST",
          headers:{
            "Content-Type":"application/json","X-Goog-Api-Key":o.key,
            "X-Goog-FieldMask":"places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.googleMapsUri"
          },
          body:JSON.stringify({textQuery:o.name,maxResultCount:5,locationBias:{circle:{center:{latitude:lat,longitude:lon},radius:3000}}})
        },20000);
        if(!r.ok)return json({matched:false},502);
        const data=await r.json();
        let best=null,bestDist=Infinity;
        for(const p of data.places||[]){
          if(!p.location)continue;
          const d=Math.hypot(p.location.latitude-lat,p.location.longitude-lon);
          if(d<bestDist){bestDist=d;best=p;}
        }
        if(!best)return json({matched:false});
        return json({matched:true,placeId:best.id,rating:best.rating,userRatingCount:best.userRatingCount,googleMapsUri:best.googleMapsUri});
      }catch(e){return json({matched:false},502);}
    },

    async "/api/status"(){
      let tileCount=0;
      try{
        if("caches" in window){
          const c=await caches.open(TILE_CACHE);
          tileCount=(await c.keys()).length;
        }
      }catch(e){}
      return json({ok:true,version:VERSION,tileCount,native:isNative()});
    },

    async "/api/offline-clear"(){
      try{if("caches" in window)await caches.delete(TILE_CACHE);}catch(e){}
      return json({ok:true});
    },

    /* --- nur in der Android-App --- */

    async "/api/gc-stats"(q){
      if(native()&&native().gcStats)return json(await native().gcStats(q.get("url"),q.get("force")==="1"));
      return json({available:false,yearly:[],message:"Direkter Abruf von geocaching.com geht nur in der Android-App. Im Browser: „My Finds“ importieren."});
    },

    async "/api/gc-login"(q){
      if(native()&&native().gcLogin)return json(await native().gcLogin(q.get("url")));
      return json({ok:false,message:"Die Anmeldung bei geocaching.com ist nur in der Android-App verfügbar."});
    },

    async "/api/geocaching-profile-public"(q){
      if(native()&&native().gcProfileName)return json(await native().gcProfileName(q.get("url")));
      return json({message:notInBrowser("Das Auslesen des Profilnamens")},501);
    },

    async "/api/gc-search"(q){
      if(native()&&native().gcSearch){
        try{return json(await native().gcSearch(q));}
        catch(e){return json({ok:false,message:e.message||String(e)},502);}
      }
      return json({ok:false,message:"Die Cache-Suche über geocaching.com geht nur in der Android-App. Im Browser: Pocket Query als GPX importieren."});
    },

    async "/api/cacherstats"(q){
      if(native()&&native().cacherstats)return json(await native().cacherstats(q));
      return json({matched:false,blocked:true,message:notInBrowser("Die Cacherstats-Abfrage")});
    }
  };

  /* ---------- fetch abfangen ---------- */

  window.fetch=async function(input,init){
    try{
      const url=new URL(typeof input==="string"?input:input.url,location.href);
      if(url.origin===location.origin&&url.pathname.startsWith("/api/")){
        const handler=routes[url.pathname];
        if(!handler)return text("Unbekannter Endpunkt: "+url.pathname,404);
        if(!init&&typeof input!=="string"){
          init={method:input.method,body:input.method!=="GET"&&input.method!=="HEAD"?await input.clone().text():undefined};
        }
        return await handler(url.searchParams,init||{});
      }
    }catch(e){
      return text(e.message||String(e),500);
    }
    return nativeFetch(input,init);
  };

  window.CR_API={VERSION,routes,isNative,TILE_CACHE};

  /* ---------- Service Worker (App offline + Kartenkacheln) ---------- */
  const secure=location.protocol==="https:"||location.hostname==="localhost"||location.hostname==="127.0.0.1";
  if("serviceWorker" in navigator&&secure&&!isNative()){
    window.addEventListener("load",()=>{
      navigator.serviceWorker.register("sw.js").catch(e=>console.warn("Service Worker nicht registriert:",e));
    });
  }
})();
