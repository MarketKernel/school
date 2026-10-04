// Builds one arithmetic drill lesson into <lesson>/build/: page, styles, code and the drill's examples.
// This engine is shared by math-addition, math-subtraction, math-multiplication, math-division…;
// each of them calls it from its lesson.json:
//   (cd ../math-drill/game && npm ci) && node ../math-drill/game/build_scripts/build.mjs .
//
// The lesson folder holds lesson.json (title and icon are reused for the page) and drill.json:
//   op      — "add", "sub", "mul" or "div"
//   from    — smallest number, e.g. 0
//   to      — largest number, e.g. 9
//   seconds — time to answer one example
//   levels  — from easy to hard; each one is { name, hint, upTo } for add/sub or { name, hint, tables } for mul/div:
//     name   — short label on the level button: «до 5», «на 2 и 5»
//     hint   — one line on what the level is about, shown before the round
//     upTo   — add/sub: the level takes examples whose sum x + y is at most upTo
//     tables — mul/div: the level takes examples where x or y is one of these numbers
//   Every example goes to the first level that takes it, and a round of a level asks all its examples once.
//
// Examples are built from pairs x, y in [from, to]: add asks x + y, mul asks x × y, and sub and div are them read
// backwards — (x + y) − y and (x × y) ÷ y (y ≠ 0) — so answers are never negative or fractional.
//
// The result opens by double-clicking build/index.html or can be served from any static host.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
if (!(drill.seconds > 0)) throw new Error("drill.json: seconds должно быть больше 0");
const byTables = drill.op === "mul" || drill.op === "div";
const key = byTables ? "tables" : "upTo";
if (!Array.isArray(drill.levels) || !drill.levels.length) throw new Error("drill.json: нужен список уровней levels");
for (const level of drill.levels) {
  const ok = byTables ? Array.isArray(level.tables) && level.tables.every(isInt) : isInt(level.upTo);
  if (!level.name || !level.hint || !ok) {
    throw new Error(`drill.json: у уровня ${JSON.stringify(level)} должны быть name, hint и ${key}`);
  }
}

// Every example as [a, b, answer], sorted into levels
const solve = (x, y) => {
  switch (drill.op) {
    case "add": return [x, y, x + y];
    case "sub": return [x + y, y, x];
    case "mul": return [x, y, x * y];
    case "div": return y === 0 ? null : [x * y, y, x];
  }
};
const takes = (level, x, y) => (byTables ? level.tables.includes(x) || level.tables.includes(y) : x + y <= level.upTo);
const levels = drill.levels.map((level) => ({ name: level.name, hint: level.hint, examples: [] }));
let unused = 0;
for (let x = drill.from; x <= drill.to; x++) {
  for (let y = drill.from; y <= drill.to; y++) {
    const example = solve(x, y);
    if (!example) continue;
    const i = drill.levels.findIndex((level) => takes(level, x, y));
    if (i < 0) unused++;
    else levels[i].examples.push(example);
  }
}
const empty = levels.find((level) => !level.examples.length);
if (empty) throw new Error(`drill.json: в уровень «${empty.name}» не попал ни один пример — проверьте ${key}`);

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

// Settings and examples go into data.js so no fetch is needed (fetch fails when the file is opened directly);
// the lesson folder name keys the best results saved in the browser
const data = { slug: basename(lesson), title: meta.title, icon: meta.icon ?? "🔢", op: drill.op, seconds: drill.seconds, levels };
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

console.log(`Готово: ${out}`);
console.log(`Действие: ${drill.op}, числа ${drill.from}–${drill.to}, ${drill.seconds} с на пример. Уровни: ` +
  levels.map((level) => `${level.name} — ${level.examples.length}`).join(", ") + (unused ? `. Не попали ни в один уровень: ${unused}` : ""));
