// เก็บไฟล์หน้าเว็บไว้ในเครื่อง เปิดได้เร็ว/ออฟไลน์ได้ ส่วนข้อมูลดึงใหม่ก่อนเสมอ
const CACHE = "twm-v3";
const SHELL = ["./", "index.html", "style.css", "app.js", "report.js", "provinces.json", "districts.json", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // network-first: ได้ของใหม่ถ้ามีเน็ต ไม่มีเน็ตใช้ของที่เก็บไว้
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
