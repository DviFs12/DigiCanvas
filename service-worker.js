const V = 'dc-v1';
const ASSETS = ['./celular.html','./css/shared.css','./css/mobile.css',
  './js/firebase-config.js','./js/signaling.js','./js/webrtc.js',
  './js/viewport.js','./js/utils.js','./js/mobile.js','./manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('firebase')||url.hostname.includes('gstatic')||url.hostname.includes('cdnjs')) return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
    if(res.ok&&e.request.method==='GET'){
      const c=res.clone();
      caches.open(V).then(cache=>cache.put(e.request,c));
    }
    return res;
  }).catch(()=>e.request.destination==='document'?caches.match('./celular.html'):new Response('',{status:408}))));
});
