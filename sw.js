// 撸货记账 · 离线缓存（v46 起）
// 策略：**网络优先**——有网时永远取线上最新文件（顺手把这份存进缓存），断网时才用缓存里的上一份。
// 只管同源的 GET 静态文件（html/js/css/图标/manifest）与页面导航；跨域请求（同步 Worker）、
// 非 GET 请求（同步的 /save 等）、其它同源路径一律**不拦截**，浏览器照原样直连。
// 本文件不读也不写 localStorage，碰不到账本、同步码或任何业务数据；不弹「有新版本」之类的提示。
//
// 发版纪律：每次发版把下面的 CACHE 改成新版本号（如 luhuo-v47），并把本文件同步到 site-repo/。
// 新 SW 激活时只删**以 luhuo- 开头的旧缓存**——GitHub Pages 上同一账号的其他站点与本站同源，
// Cache Storage 是共用的，别人的缓存一个都不碰。
// 出问题时的应急办法：用 docs/sw-自我注销版.js 替换本文件上线（见 docs/v46-离线缓存说明.md）。

const CACHE = "luhuo-v46";
const PREFIX = "luhuo-";
const STATIC_RE = /\.(?:html|js|css|png|svg|ico|webmanifest)$/i;

// 安装：先把首页与它引用的文件放进新缓存（失败也不拦安装——之后在线访问时会逐个补进来）。
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      const index = new URL("./index.html", self.registration.scope).href;
      const res = await fetch(index, { cache: "no-cache" });
      if (res && res.ok) {
        const html = await res.clone().text();
        await cache.put(index, res);
        const refs = new Set();
        html.replace(/(?:href|src)="(\.\/[^"#]+)"/g, (_, ref) => { refs.add(new URL(ref, index).href); return ""; });
        await Promise.all([...refs].map(async (url) => {
          try {
            const r = await fetch(url, { cache: "no-cache" });
            if (r && r.ok) await cache.put(url, r);
          } catch { /* 单个文件取不到不影响安装 */ }
        }));
      }
    } catch { /* 预存失败不影响安装 */ }
    await self.skipWaiting();
  })());
});

// 激活：删掉本站自己的旧版本缓存（只认 luhuo- 前缀），然后接管已打开的页面。
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    } catch { /* 清不掉旧缓存不影响使用 */ }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                          // 非 GET：不拦截
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;           // 跨域（同步 Worker 等）：不拦截
  if (!url.href.startsWith(self.registration.scope)) return; // 不在本站目录下：不拦截
  const nav = req.mode === "navigate";
  if (!nav && !STATIC_RE.test(url.pathname)) return;         // 其它同源路径（接口等）：不拦截
  event.respondWith(networkFirst(req, nav));
});

async function networkFirst(req, nav) {
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    if (nav) {
      const page = await cache.match(new URL("./index.html", self.registration.scope).href)
        || await cache.match(self.registration.scope);
      if (page) return page;
    }
    throw err;
  }
}
