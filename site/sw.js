// Service worker: lets the site be installed as an app and work offline.
// build_scripts/build.mjs copies this file to _site/sw.js and fills FILES with every
// published file and a hash of its contents.
//
// - The home page and the other root files are cached on install.
// - A lesson is cached as a whole the first time its page is opened, so afterwards it plays offline.
// - Files are served from the cache first. A cache entry is keyed by the file's hash, so after
//   a deploy only changed files are downloaded again and stale ones are dropped.
// - Google Fonts are cached too, so Nunito survives offline.
//
// A deploy reaches an open app one reload late: the first load after it still uses the old
// worker, which meanwhile installs the new one.

const FILES = /* FILES */ {};
const CACHE = "school";
const FONTS = "school-fonts";
const ROOT = new URL("./", self.location.href);

// Site path of a URL: "read-syllables/" → "read-syllables/index.html"; null outside the site
function sitePath(url) {
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(ROOT.pathname.length));
  } catch {
    return null;
  }
  return path === "" || path.endsWith("/") ? path + "index.html" : path;
}

const known = (path) => path !== null && Object.hasOwn(FILES, path);
const cacheKey = (path) => `${new URL(path, ROOT).href}?v=${FILES[path]}`;
const lessonOf = (path) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : null);
const lessonFiles = (lesson) => Object.keys(FILES).filter((path) => path.startsWith(lesson + "/"));

// Downloads the files that are not in the cache yet (in their current version)
async function precache(paths) {
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((request) => request.url));
  const results = await Promise.allSettled(
    paths
      .filter((path) => !have.has(cacheKey(path)))
      .map(async (path) => {
        const response = await fetch(new URL(path, ROOT), { cache: "no-cache" });
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        await cache.put(cacheKey(path), response);
      }),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) throw new Error(`Not cached: ${failed.length} of ${results.length}`);
}

// Lessons that already have something in the cache (they were opened before)
async function cachedLessons() {
  const cache = await caches.open(CACHE);
  const lessons = new Set();
  for (const request of await cache.keys()) {
    const lesson = lessonOf(sitePath(new URL(request.url)) ?? "");
    if (lesson && lessonFiles(lesson).length) lessons.add(lesson);
  }
  return [...lessons];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precache(Object.keys(FILES).filter((path) => !path.includes("/")));
      // Lessons that were available offline stay complete after the update
      await Promise.allSettled((await cachedLessons()).map((lesson) => precache(lessonFiles(lesson))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE && name !== FONTS) await caches.delete(name);
      }
      const wanted = new Set(Object.keys(FILES).map(cacheKey));
      const cache = await caches.open(CACHE);
      for (const request of await cache.keys()) {
        if (!wanted.has(request.url)) await cache.delete(request);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(fromFontCache(url.href));
    return;
  }
  const path = sitePath(url);
  if (!known(path)) return;
  event.respondWith(fromCache(request, path));
  const lesson = lessonOf(path);
  if (request.mode === "navigate" && lesson) event.waitUntil(precache(lessonFiles(lesson)).catch(() => {}));
});

async function fromCache(request, path) {
  const cache = await caches.open(CACHE);
  let response = await cache.match(cacheKey(path));
  if (!response) {
    response = await fetch(new URL(path, ROOT), { cache: "no-cache" });
    if (response.ok) await cache.put(cacheKey(path), response.clone());
  }
  const range = request.headers.get("range");
  return range && response.ok ? sliceRange(response, range) : response;
}

// <audio> asks for byte ranges; Safari will not play a file from the cache without a 206 answer
async function sliceRange(response, range) {
  const blob = await response.blob();
  const size = blob.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = NaN;
  let end = NaN;
  if (match && match[1] !== "") {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  } else if (match && match[2] !== "") {
    start = Math.max(0, size - Number(match[2])); // "bytes=-500": the last 500 bytes
    end = size - 1;
  }
  if (!(start <= end)) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

// The font CSS is requested without CORS; fetch it with CORS so the cached copy is not opaque
async function fromFontCache(url) {
  const cache = await caches.open(FONTS);
  const cached = await cache.match(url);
  if (cached) return cached;
  const response = await fetch(url, { mode: "cors" });
  if (response.ok) await cache.put(url, response.clone());
  return response;
}
