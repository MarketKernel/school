// Builds one «Собери слово» reading lesson into <lesson>/build/: page, styles, code, words and pictures.
// This engine is shared by read-syllables, read-potter, read-potter-aloud…; each of them calls it from its lesson.json:
//   (cd ../read-game/game && npm ci) && node ../read-game/game/build_scripts/build.mjs .
//
// The lesson folder holds:
//   lesson.json     — title and icon are reused for the page; it lists "uses": ["russian"]
//   game.json       — the lesson's story: levels, dialogs, confetti (see below)
//   data/words.txt  — words: "count<TAB>word" (tools/words.py) or one word per line.
//                     Without it the words are the ones in data/pictures.tsv. Same rule as read_words()
//                     in russian/tools/syllables.py. Names keep their capital letter: «Гарри».
//   data/pictures.tsv, images/, images.json — word pictures made by tools/draw.py; optional
//   data/riddles.json, audio/ — riddle lessons only (mode "riddle", see below)
//   theme.css       — optional: colours and decorations on top of the engine's style.css
// Words and pictures used by several lessons live in a shared folder instead (lessons/potter): the same data/,
// images/ and images.json, plus shared.json. The lesson then names it in game.json "words" and in lesson.json
// "uses"; its pictures are not copied, the game loads them from that folder like the sounds.
//
// game.json:
//   mode         — "assemble" (default): build the word from tiles; "aloud": read the shown word aloud,
//                  browser speech recognition checks it. "aloud" shows no picture and plays no sound — the child
//                  must read, not guess or repeat — so it loads nothing from shared folders and needs no "uses".
//                  "riddle": the big speaker plays a riddle, the child assembles its answer from tiles (the
//                  "assemble" code). Riddles come from the lesson's data/riddles.json ({ id, answer } each, made by
//                  the lesson's tools), their sounds from its audio/<id>.mp3; a riddle without a sound is left out.
//                  Every answer is played once, a level is complete when all its riddles are solved.
//   words        — optional: shared folder with the words and pictures, e.g. "potter"
//   levels       — exactly three, by tile count: 2–3, 4, 5 and more. Each is { name, icon, done }:
//     name, icon — label and emoji of the level button
//     done       — dialog when the level is complete: { icon?, title, text, button } («{n}» in text is the
//                  number of words collected); the last level's dialog ends the game, its button starts over
//   doneIcon     — emoji on the button of a complete level
//   confetti     — emoji that rain down on a right answer
//   pictureStyle — shared style prompt for tools/draw.py, so all the pictures look like one book
//                  (a shared word folder keeps it in its shared.json)
//
// Sounds of letters and syllables are not copied: they live in the shared folder lessons/russian, which the
// root build publishes once as _site/russian/. data.js lists them, and the game loads them from ../russian/
// on the site or ../../russian/ from a local <lesson>/build/.
//
// The result opens by double-clicking build/index.html or can be served from any static host.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "russian"; // shared folder with the sounds, under lessons/ and on the site
const sounds = join(game, "..", "..", SOURCE, "audio");
if (!process.argv[2]) throw new Error("Укажите папку урока: node build_scripts/build.mjs ../../read-syllables");
const lesson = resolve(process.argv[2]);
const out = join(lesson, "build");
const where = basename(lesson);

const readJson = (file, fallback) => {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Нет ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
};
const fail = (text) => {
  throw new Error(`${where}/game.json: ${text}`);
};

// ---------- Lesson settings ----------

const meta = readJson(join(lesson, "lesson.json"));
const story = readJson(join(lesson, "game.json"));
const MODES = ["assemble", "aloud", "riddle"];
const mode = story.mode ?? "assemble";
if (!MODES.includes(mode)) fail(`mode должен быть ${MODES.join(", ")}, а не ${mode}`);
const riddle = mode === "riddle";
// The page's code: a riddle lesson is "assemble" with the riddle's sound instead of the word's
const code = riddle ? "assemble" : mode;
const CODES = ["assemble", "aloud"];
// Pictures and syllable sounds are only for "assemble" and "riddle"; "aloud" takes just the word list
const media = mode !== "aloud";
if (riddle && story.words !== undefined) fail("у загадок слова свои — data/riddles.json, words не нужен");
const needUses = (folder, what) => {
  if (!(meta.uses ?? []).includes(folder)) throw new Error(`${where}/lesson.json: добавьте "${folder}" в "uses" — оттуда ${what}`);
};
if (story.words !== undefined) {
  if (!existsSync(join(lesson, "..", story.words, "shared.json"))) fail(`words: нет общей папки lessons/${story.words} с shared.json`);
  if (media) needUses(story.words, "картинки");
}
if (media) needUses(SOURCE, "звуки");
if (!Array.isArray(story.levels) || story.levels.length !== 3) fail("нужно ровно три уровня levels: 2–3, 4 и 5+ карточек");
for (const level of story.levels) {
  const done = level.done ?? {};
  if (!level.name || !level.icon || !done.title || !done.text || !done.button) {
    fail(`у уровня ${JSON.stringify(level)} должны быть name, icon и done: { title, text, button }`);
  }
}
if (!story.doneIcon) fail("нужен doneIcon — значок пройденного уровня");
if (!Array.isArray(story.confetti) || !story.confetti.length) fail("нужен список значков confetti");

// ---------- Words and pictures ----------

const wordsDir = story.words ? join(lesson, "..", story.words) : lesson;
const wordsFile = join(wordsDir, "data", "words.txt");
const picturesFile = join(wordsDir, "data", "pictures.tsv");
const riddlesFile = join(wordsDir, "data", "riddles.json");
let words;
let riddles; // answer -> audio/<id>.mp3
if (riddle) {
  const list = readJson(riddlesFile);
  const voiced = list.filter((r) => existsSync(join(lesson, "audio", `${r.id}.mp3`)));
  if (!voiced.length) throw new Error(`${where}: нет звуков загадок в audio/ — сначала озвучьте их`);
  if (voiced.length < list.length) {
    console.warn(`Без звука, пропущены: ${list.filter((r) => !voiced.includes(r)).map((r) => r.id).join(", ")}`);
  }
  riddles = Object.fromEntries(voiced.map((r) => [r.answer, `audio/${r.id}.mp3`]));
  words = Object.keys(riddles);
} else if (existsSync(wordsFile)) {
  words = readFileSync(wordsFile, "utf8").split("\n").map((line) => (line.split("\t").pop() ?? "").trim());
} else if (existsSync(picturesFile)) {
  words = readFileSync(picturesFile, "utf8").split("\n").slice(1).map((line) => (line.split("\t")[1] ?? "").trim());
} else {
  throw new Error(`Нет ни ${wordsFile}, ни ${picturesFile} — откуда брать слова?`);
}
words = [...new Set(words.filter(Boolean))];

const images = media ? readJson(join(wordsDir, "images.json"), {}) : {};

// ---------- Sounds (lessons/russian) ----------

for (const name of media ? ["syllables.json", "letters.json"] : []) {
  if (!existsSync(join(sounds, name))) throw new Error(`Нет lessons/${SOURCE}/audio/${name} — сначала озвучьте: python3 lessons/${SOURCE}/tools/speak.py`);
}
const soundList = (name) => (media ? readJson(join(sounds, name), {}) : {});

// ---------- Output ----------

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/common.js and one file per mode; the page needs only its own mode
execSync(`npx tsc --outDir "${out}"`, { cwd: game, stdio: "inherit" });
for (const other of CODES.filter((m) => m !== code)) rmSync(join(out, `${other}.js`));

// The page takes its title and favicon from lesson.json
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("__TITLE__", escape(meta.title))
  .replaceAll("__ICON__", escape(meta.icon ?? "📖"))
  .replaceAll("__MODE__", code);
writeFileSync(join(out, "index.html"), html);
cpSync(join(game, "style.css"), join(out, "style.css"));
const theme = join(lesson, "theme.css");
writeFileSync(join(out, "theme.css"), existsSync(theme) ? readFileSync(theme, "utf8") : "/* no theme.css in the lesson */\n");
// The lesson's own pictures are copied; those of a shared word folder are loaded from it
if (media && !story.words && existsSync(join(lesson, "images"))) cpSync(join(lesson, "images"), join(out, "images"), { recursive: true });
// Riddle sounds belong to the lesson: only the ones in the game are copied
for (const file of Object.values(riddles ?? {})) cpSync(join(lesson, file), join(out, file));

// Words and sound lists go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const data = {
  lesson: where,
  source: SOURCE,
  imageSource: media ? story.words ?? "" : "",
  words,
  ...(riddles && { riddles }),
  syllables: soundList("syllables.json"),
  letters: soundList("letters.json"),
  soft: soundList("soft.json"), // soft consonants «ть», «ль»…, if already voiced
  images,
  story: { levels: story.levels, doneIcon: story.doneIcon, confetti: story.confetti },
};
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

console.log(`Готово: ${out}`);
console.log(`Режим: ${mode}${story.words ? `, слова${media ? " и картинки" : ""} из lessons/${story.words}` : ""}` +
  (media ? "" : " (без картинок и звуков)"));
console.log(`${riddle ? "Загадок" : "Слов"}: ${words.length}` + (media ? `, картинок: ${Object.keys(images).length}, ` +
  `звуков из lessons/${SOURCE}: слогов ${Object.keys(data.syllables).length}, букв ${Object.keys(data.letters).length}, ` +
  `мягких ${Object.keys(data.soft).length}` : ""));
