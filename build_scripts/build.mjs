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
// Usage:
//   node build_scripts/build.mjs              # build everything
//   node build_scripts/build.mjs --no-build   # skip lesson builds, use what is already built

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const skipBuild = process.argv.includes("--no-build");

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
for (const file of readdirSync(join(root, "site"))) {
  if (file !== "index.html" && file !== ".DS_Store") cpSync(join(root, "site", file), join(out, file), { recursive: true });
}

console.log(`\nГотово: ${out}`);
console.log(`Уроков: ${lessons.length}, на главной: ${[...subjects.values()].flat().length}, разделов: ${subjects.size}`);
