/* CacheRunde Service Worker (seit 0.13.0)
 * - App-Dateien: zuerst Netz (damit Updates sofort ankommen), offline aus dem Cache
 * - Kartenkacheln und Leaflet: zuerst Cache, sonst Netz (und dann speichern)
 */
const VERSION="0.19.0";
const APP_CACHE="cacherunde-app-"+VERSION;
const TILE_CACHE="cacherunde-tiles";
const LIB_CACHE="cacherunde-libs";
const APP_FILES=["./","index.html","style.css","app.js","api-local.js","gc-native.js","sample.gpx","manifest.json","icon-192.png","icon-512.png"];

self.addEventListener("install",e=>{
  e.waitUntil(caches.open(APP_CACHE).then(c=>c.addAll(APP_FILES)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",e=>e.waitUntil((async()=>{
  const keep=[APP_CACHE,TILE_CACHE,LIB_CACHE];
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith("cacherunde-")&&!keep.includes(k)).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));

async function cacheFirst(cacheName,request){
  const c=await caches.open(cacheName);
  const hit=await c.match(request);
  if(hit)return hit;
  const res=await fetch(request);
  if(res.ok||res.type==="opaque")c.put(request,res.clone());
  return res;
}

async function networkFirst(request){
  const c=await caches.open(APP_CACHE);
  try{
    const res=await fetch(request,{cache:"no-store"});
    if(res.ok)c.put(request,res.clone());
    return res;
  }catch(e){
    const hit=await c.match(request,{ignoreSearch:true});
    if(hit)return hit;
    throw e;
  }
}

self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const u=new URL(e.request.url);
  if(u.hostname.endsWith("tile.openstreetmap.org")){
    e.respondWith(cacheFirst(TILE_CACHE,e.request).catch(()=>fetch(e.request)));
    return;
  }
  if(u.hostname==="unpkg.com"){
    e.respondWith(cacheFirst(LIB_CACHE,e.request));
    return;
  }
  if(u.origin===self.location.origin){
    e.respondWith(networkFirst(e.request));
  }
});
