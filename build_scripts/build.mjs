// Builds the whole site into _site/: the home page with the lesson list plus a folder per lesson.
// The GitHub Action runs this same script before publishing to GitHub Pages.
//
// A lesson is a folder lessons/<folder>/ with a lesson.json file:
//   title       — card title
//   description — one or two sentences on what the lesson does
//   subject     — section on the home page: «Чтение», «Математика»…
//   icon        — emoji for the card
//   order       — sort order (lower comes first), optional
//   build       — build command, run inside the lesson folder; optional
//   publish     — which lesson folder to publish (after the build); defaults to the lesson folder itself
//   hidden      — true to keep the lesson off the home page (draft)
//
// The site is also an installable app (PWA): every page gets the manifest, the icons and the
// service worker (site/sw.js) linked in, so a lesson needs nothing of its own for that.
//
// Usage:
//   node build_scripts/build.mjs              # build everything
//   node build_scripts/build.mjs --no-build   # skip lesson builds, use what is already built

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const skipBuild = process.argv.includes("--no-build");

// ---------- App (PWA) ----------

// Links the manifest, icons and service worker into a page; `up` leads from the page to the site root
const appHead = (up) => `
<link rel="manifest" href="${up}manifest.webmanifest">
<meta name="theme-color" content="#d7f0ff">
<link rel="apple-touch-icon" href="${up}apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Весёлая школа">
<script>
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("${up}sw.js").catch(() => {}));
</script>
`;

// Every lesson page gets a way back to the home page (the installed app has no browser back button at all).
// It sits in the bottom-left corner: leave ~70px free at the bottom of a lesson page (read-syllables keeps it for the grass).
// Wide screens show the label next to the house, phones only the house.
const homeButton = `
<a class="home-button" href="../" title="Все уроки" aria-label="Все уроки"><span aria-hidden="true">🏠</span><span class="home-button-text">Все уроки</span></a>
<style>
  .home-button {
    position: fixed;
    z-index: 5;
    bottom: calc(14px + env(safe-area-inset-bottom));
    left: calc(12px + env(safe-area-inset-left));
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 48px;
    height: 48px;
    padding: 0 16px 0 10px;
    border-radius: 999px;
    background: #fff;
    border: 3px solid #eadfcd;
    box-shadow: 0 3px 0 #eadfcd;
    color: #3d2b2f;
    font: 800 17px "Nunito", system-ui, sans-serif;
    line-height: 1;
    text-decoration: none;
    transition: transform 0.1s;
  }
  .home-button span:first-child { font-size: 22px; }
  .home-button:hover { transform: translateY(-2px); }
  .home-button:active { transform: translateY(2px); box-shadow: 0 1px 0 #eadfcd; }
  @media (max-width: 700px) {
    .home-button { width: 48px; padding: 0; }
    .home-button-text { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .home-button { transition: none; }
  }
</style>
`;

const injectApp = (file, up, extraBody = "") => {
  const html = readFileSync(file, "utf8");
  if (!html.includes("</head>") || !html.includes("</body>")) throw new Error(`В ${file} нет </head> или </body>`);
  writeFileSync(file, html.replace("</head>", `${appHead(up)}</head>`).replace("</body>", `${extraBody}</body>`));
};

// Every published file with a hash of its contents, for the service worker's cache
const listFiles = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`],
  );

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Lessons ----------

const lessonsDir = join(root, "lessons");
const lessons = readdirSync(lessonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(lessonsDir, d.name, "lesson.json")))
  .map((d) => ({ slug: d.name, ...JSON.parse(readFileSync(join(lessonsDir, d.name, "lesson.json"), "utf8")) }))
  .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.title.localeCompare(b.title, "ru"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

for (const lesson of lessons) {
  const dir = join(lessonsDir, lesson.slug);
  console.log(`\n== ${lesson.slug}: ${lesson.title}`);
  if (lesson.build && !skipBuild) execSync(lesson.build, { cwd: dir, stdio: "inherit", shell: "/bin/bash" });
  const publish = join(dir, lesson.publish ?? ".");
  if (!existsSync(join(publish, "index.html"))) throw new Error(`Нет ${join(publish, "index.html")} — урок не собрался?`);
  cpSync(publish, join(out, lesson.slug), {
    recursive: true,
    filter: (src) => !/(^|\/)(\.DS_Store|\.env|node_modules)$/.test(src),
  });
  injectApp(join(out, lesson.slug, "index.html"), "../", homeButton);
}

// ---------- Home page ----------

// Sections are ordered by their first lesson
const subjects = new Map();
for (const lesson of lessons.filter((l) => !l.hidden)) {
  if (!subjects.has(lesson.subject)) subjects.set(lesson.subject, []);
  subjects.get(lesson.subject).push(lesson);
}

const card = (l) => `
      <a class="card" href="${escape(l.slug)}/">
        <span class="card-icon" aria-hidden="true">${escape(l.icon ?? "📘")}</span>
        <span class="card-title">${escape(l.title)}</span>
        <span class="card-text">${escape(l.description ?? "")}</span>
      </a>`;

const sections = [...subjects]
  .map(([subject, list]) => `
    <section class="subject">
      <h2>${escape(subject)}</h2>
      <div class="cards">${list.map(card).join("")}
      </div>
    </section>`)
  .join("\n");

const template = readFileSync(join(root, "site", "index.html"), "utf8");
if (!template.includes("<!-- LESSONS -->")) throw new Error("В site/index.html нет метки <!-- LESSONS -->");
writeFileSync(join(out, "index.html"), template.replace("<!-- LESSONS -->", sections));
injectApp(join(out, "index.html"), "");
for (const file of readdirSync(join(root, "site"))) {
  if (!["index.html", "sw.js", ".DS_Store"].includes(file)) cpSync(join(root, "site", file), join(out, file), { recursive: true });
}

// ---------- Service worker ----------

const files = Object.fromEntries(
  listFiles(out).map((path) => [path, createHash("sha256").update(readFileSync(join(out, path))).digest("hex").slice(0, 12)]),
);
const worker = readFileSync(join(root, "site", "sw.js"), "utf8");
if (!worker.includes("/* FILES */ {}")) throw new Error("В site/sw.js нет метки /* FILES */ {}");
writeFileSync(join(out, "sw.js"), worker.replace("/* FILES */ {}", () => JSON.stringify(files)));

console.log(`\nГотово: ${out}`);
console.log(`Уроков: ${lessons.length}, на главной: ${[...subjects.values()].flat().length}, разделов: ${subjects.size}, ` +
  `файлов для офлайна: ${Object.keys(files).length}`);
