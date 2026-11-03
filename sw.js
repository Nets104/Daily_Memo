const CACHE='harugyeol-v80';
const RESOURCES=['./index.html','./style.css?v=13','./vintage.css?v=77','./app.js?v=80','./assets/vintage-flowers.svg','./assets/ridibatang-Regular.woff2','./icons/menu-notebook-clean.png','./manifest.webmanifest?v=39','./supabase-config.js?v=2','./cloud.js?v=20','./icons/icon-192.png?v=39','./icons/icon-512.png?v=39'];
self.addEventListener('install',event=>{
  // Keep the previous app running until the user chooses "업데이트".
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(RESOURCES)));
});
self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  if(event.request.url==='https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'){
    event.respondWith(caches.open(CACHE).then(async cache=>{
      const stored=await cache.match(event.request);
      if(stored)return stored;
      const response=await fetch(event.request);
      if(response.ok||response.type==='opaque')
        cache.put(event.request,response.clone()).catch(()=>{});
      return response;
    }));
    return;
  }
  if(new URL(event.request.url).origin!==self.location.origin)return;
  const path=new URL(event.request.url).pathname;
  if(path.endsWith('/')||path.endsWith('/index.html')){
    event.respondWith(fetch(event.request).then(response=>response).catch(()=>caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});