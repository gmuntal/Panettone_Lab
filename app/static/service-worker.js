const CACHE='panettone-lab-v0.8.1';
const SHELL=[
  '/login',
  '/static/app.css?v=0.8.1',
  '/static/app.js?v=0.8.1',
  '/static/icons/apple-touch-icon.png?v=0.8.1',
  '/static/icons/favicon-32.png?v=0.8.1',
  '/static/icons/favicon.ico?v=0.8.1',
  '/static/icons/icon-192.png?v=0.8.1',
  '/static/icons/icon-512.png?v=0.8.1',
  '/static/icons/icon-maskable-512.png?v=0.8.1',
  '/manifest.webmanifest?v=0.8.1'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('panettone-lab-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/photos/'))return;
  const isShell=SHELL.some(path=>{const item=new URL(path,location.origin);return item.pathname===url.pathname&&item.search===url.search});
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok&&isShell){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}
    return response;
  }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match('/login'))));
});
