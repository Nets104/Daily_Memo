const CACHE='harugyeol-v12';
const RESOURCES=['./index.html','./style.css?v=12','./app.js?v=12','./manifest.webmanifest','./supabase-config.js','./cloud.js?v=12','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(RESOURCES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  const path=new URL(event.request.url).pathname;
  if(path.endsWith('/')||path.endsWith('/index.html')){
    event.respondWith(fetch(event.request).then(response=>response).catch(()=>caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});