// Builds the game into build/: page, styles, code, words and sounds.
// The result opens by double-clicking build/index.html or can be served from any static host.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = join(game, "..");
const out = join(game, "build");

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/main.js
execSync("npx tsc --outDir build", { cwd: game, stdio: "inherit" });

for (const file of ["index.html", "style.css"]) cpSync(join(game, file), join(out, file));

// Sounds
const audio = join(read, "audio");
for (const name of ["syllables.json", "letters.json"]) {
  if (!existsSync(join(audio, name))) throw new Error(`Нет ${name} — сначала озвучьте: python3 tools/speak.py`);
}
for (const kind of ["syllables", "letters", "soft"]) {
  if (existsSync(join(audio, kind))) cpSync(join(audio, kind), join(out, "audio", kind), { recursive: true });
}
const readJson = (name) => (existsSync(join(audio, name)) ? JSON.parse(readFileSync(join(audio, name), "utf8")) : {});

// Word pictures (tools/draw.py), if already drawn
const images = existsSync(join(read, "images.json")) ? JSON.parse(readFileSync(join(read, "images.json"), "utf8")) : {};
if (existsSync(join(read, "images"))) cpSync(join(read, "images"), join(out, "images"), { recursive: true });

// Words and sound lists go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const words = readFileSync(join(read, "data", "words.txt"), "utf8")
  .split("\n")
  .map((line) => (line.split("\t").pop() ?? "").trim().toLowerCase())
  .filter(Boolean);
const data = {
  words,
  syllables: readJson("syllables.json"),
  letters: readJson("letters.json"),
  soft: readJson("soft.json"), // soft consonants «ть», «ль»…, if already voiced
  images,
};
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

console.log(`Готово: ${out}`);
console.log(`Слов: ${words.length}, слогов со звуком: ${Object.keys(data.syllables).length}, ` +
  `букв: ${Object.keys(data.letters).length}, мягких: ${Object.keys(data.soft).length}, картинок: ${Object.keys(images).length}`);
