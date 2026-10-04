// Builds one arithmetic drill lesson into <lesson>/build/: page, styles, code and the drill settings.
// This engine is shared by math-addition, math-subtraction, math-multiplication, math-division…;
// each of them calls it from its lesson.json:
//   (cd ../math-drill/game && npm ci) && node ../math-drill/game/build_scripts/build.mjs .
//
// The lesson folder holds lesson.json (title and icon are reused for the page) and drill.json:
//   op      — "add", "sub", "mul" or "div"
//   from    — smallest operand, e.g. 0
//   to      — largest operand, e.g. 9
//   seconds — time to answer one example
//   count   — examples in one round
// sub and div are add and mul read backwards: (a + b) − b and (a × b) ÷ b with a, b in [from, to],
// so answers are never negative or fractional.
//
// The result opens by double-clicking build/index.html or can be served from any static host.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Укажите папку урока: node build_scripts/build.mjs ../../math-addition");
const lesson = resolve(process.argv[2]);
const out = join(lesson, "build");

const readJson = (name) => {
  const file = join(lesson, name);
  if (!existsSync(file)) throw new Error(`Нет ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
};
const meta = readJson("lesson.json");
const drill = readJson("drill.json");

const isInt = (n) => Number.isInteger(n) && n >= 0;
if (!["add", "sub", "mul", "div"].includes(drill.op)) throw new Error(`drill.json: op должен быть add, sub, mul или div, а не ${drill.op}`);
if (!isInt(drill.from) || !isInt(drill.to) || drill.from > drill.to) throw new Error("drill.json: from и to — целые числа от 0, from ≤ to");
if (drill.op === "div" && drill.to === 0) throw new Error("drill.json: для деления нужен делитель больше 0 — увеличьте to");
if (!(drill.seconds > 0) || !isInt(drill.count) || drill.count === 0) throw new Error("drill.json: seconds и count должны быть больше 0");

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/main.js
execSync(`npx tsc --outDir "${out}"`, { cwd: game, stdio: "inherit" });

// The page takes its title and favicon from lesson.json
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("__TITLE__", escape(meta.title))
  .replaceAll("__ICON__", escape(meta.icon ?? "🔢"));
writeFileSync(join(out, "index.html"), html);
cpSync(join(game, "style.css"), join(out, "style.css"));

// Settings go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const data = { title: meta.title, icon: meta.icon ?? "🔢", ...drill };
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

console.log(`Готово: ${out}`);
console.log(`Действие: ${drill.op}, числа ${drill.from}–${drill.to}, ${drill.seconds} с на пример, ${drill.count} примеров в раунде`);
