// Builds one physics scene lesson into <lesson>/build/: page, styles, the shared code and the scene's own code.
// This engine is shared by physics-billiard, physics-lorenz, physics-black-hole…; each of them calls it from its
// lesson.json:
//   (cd ../physics/game && npm ci) && node ../physics/game/build_scripts/build.mjs .
//
// The lesson folder holds lesson.json (title and icon are reused for the page) and scene.json:
//   scene    — which simulation to show: the name of a file in src/ without .ts, e.g. "billiard"
//   question — one line for the child at the top of the screen, a riddle about what they see
//   about    — paragraphs of the «Что тут происходит?» card: what it is, in simple words
//
// Only common.ts and the scene's file are compiled (each scene is a namespace in src/<scene>.ts), so one lesson builds
// even while another scene doesn't compile; `npm run check` in this folder type-checks all of them.
//
// The result opens by double-clicking build/index.html or can be served from any static host.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Укажите папку урока: node build_scripts/build.mjs ../../physics-billiard");
const lesson = resolve(process.argv[2]);
const where = basename(lesson);
const out = join(lesson, "build");

const readJson = (name) => {
  const file = join(lesson, name);
  if (!existsSync(file)) throw new Error(`Нет ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
};
const meta = readJson("lesson.json");
const scene = readJson("scene.json");
const fail = (text) => {
  throw new Error(`${where}/scene.json: ${text}`);
};
if (typeof scene.scene !== "string" || !/^[a-z0-9-]+$/.test(scene.scene)) fail('нужно поле "scene" — имя файла сцены в lessons/physics/game/src/');
const source = join(game, "src", `${scene.scene}.ts`);
if (!existsSync(source)) fail(`нет сцены ${scene.scene}: файла lessons/physics/game/src/${scene.scene}.ts`);
if (typeof scene.question !== "string" || !scene.question) fail('нужно поле "question" — строчка-загадка для ребёнка');
if (!Array.isArray(scene.about) || !scene.about.length || !scene.about.every((p) => typeof p === "string" && p))
  fail('нужно поле "about" — список абзацев для карточки «Что тут происходит?»');

// ---------- Output ----------

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/common.js and build/<scene>.js, through a throwaway config next to the output
const config = join(out, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(game, "tsconfig.json"),
  include: [join(game, "src", "common.ts"), source],
  compilerOptions: { outDir: out },
}));
try {
  execSync(`npx tsc -p "${config}"`, { cwd: game, stdio: "inherit" });
} finally {
  rmSync(config, { force: true });
}

// The page takes its title and favicon from lesson.json
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("__TITLE__", escape(meta.title))
  .replaceAll("__ICON__", escape(meta.icon ?? "✨"))
  .replaceAll("__SCENE__", scene.scene);
writeFileSync(join(out, "index.html"), html);
cpSync(join(game, "style.css"), join(out, "style.css"));

// Texts go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const data = { lesson: where, scene: scene.scene, question: scene.question, about: scene.about };
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

console.log(`Готово: ${out}`);
console.log(`Сцена: ${scene.scene}, абзацев в «Что тут происходит?»: ${scene.about.length}`);
