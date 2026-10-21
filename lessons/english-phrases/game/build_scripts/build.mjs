// Builds one English phrase lesson into <lesson>/build/: page, styles, code and data.js.
// This engine is shared by english-phrases-ru and english-phrases-en; each of them calls it from its lesson.json:
//   (cd ../english-phrases/game && npm ci) && node ../english-phrases/game/build_scripts/build.mjs .
//
// The lesson folder holds:
//   lesson.json — title and icon are reused for the page; it lists "uses": ["english-phrases"]
//   game.json   — { "mode": "to-russian" | "to-english" }:
//                 to-russian — hear an English phrase, say it in Russian (ru-RU recognition); the hint shows
//                              the translation and plays it (a browser voice reads it if there's no sound);
//                 to-english — read (or hear) a Russian phrase, say it in English (en-US recognition); the hint
//                              plays the English sound.
//
// The phrases live in this shared folder (lessons/english-phrases):
//   data/topics.tsv  — topic key, icon, name
//   data/phrases.tsv — topic key, phrase, translation, other translations (|-separated),
//                      other English variants (|-separated); the extra variants only widen the speech check
//   audio/<slug>.mp3 — made by tools/speak.py; a phrase without a sound is left out of the game
//   audio/ru/<slug>.mp3 — the Russian translation, made by tools/speak.py --ru; optional
// Sounds are not copied: the root build publishes the folder once as _site/english-phrases/, and the game loads
// them from ../english-phrases/ on the site or ../../english-phrases/ from a local <lesson>/build/.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
const shared = join(game, "..");
const SOURCE = basename(shared); // "english-phrases": folder name under lessons/ and on the site
if (!process.argv[2]) throw new Error("Укажите папку урока: node build_scripts/build.mjs ../../english-phrases-ru");
const lesson = resolve(process.argv[2]);
const out = join(lesson, "build");
const where = basename(lesson);

const readJson = (file) => {
  if (!existsSync(file)) throw new Error(`Нет ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
};

// ---------- Lesson settings ----------

const meta = readJson(join(lesson, "lesson.json"));
const settings = readJson(join(lesson, "game.json"));
const MODES = ["to-russian", "to-english"];
if (!MODES.includes(settings.mode)) throw new Error(`${where}/game.json: mode должен быть ${MODES.join(" или ")}, а не ${settings.mode}`);
if (!(meta.uses ?? []).includes(SOURCE)) throw new Error(`${where}/lesson.json: допишите "uses": ["${SOURCE}"] — оттуда берутся звуки`);

// ---------- Phrases ----------

/** File name for a phrase: «How are you?» → «how-are-you». Same as slug() in lessons/english/tools/common.py. */
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const list = (cell = "") => cell.split("|").map((x) => x.trim()).filter(Boolean);

function readLines(name) {
  const path = join(shared, "data", name);
  if (!existsSync(path)) throw new Error(`Нет lessons/${SOURCE}/data/${name} — это общий список фраз`);
  return readFileSync(path, "utf8").split("\n").slice(1).filter((line) => line.trim())
    .map((line) => line.split("\t").map((cell) => cell.trim()));
}

const topics = readLines("topics.tsv").map(([key, icon, name]) => ({ key, icon, name, phrases: [] }));
const seen = { slug: new Map(), ru: new Map() };
let total = 0;
for (const [topic, en, ru, ruAlt, enAlt] of readLines("phrases.tsv")) {
  const t = topics.find((x) => x.key === topic);
  if (!t) throw new Error(`Фраза «${en}»: темы «${topic}» нет в lessons/${SOURCE}/data/topics.tsv`);
  if (!ru) throw new Error(`Фраза «${en}»: нет перевода в lessons/${SOURCE}/data/phrases.tsv`);
  // A Russian prompt must point to one English phrase, and two phrases can't share a sound file
  const s = slug(en);
  const ruKey = ru.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const [kind, key] of [["slug", s], ["ru", ruKey]]) {
    if (seen[kind].has(key)) throw new Error(`lessons/${SOURCE}/data/phrases.tsv: «${en}» и «${seen[kind].get(key)}» — ` +
      (kind === "slug" ? `одинаковое имя файла ${s}.mp3` : `одинаковый перевод «${ru}»`));
    seen[kind].set(key, en);
  }
  total++;
  if (!existsSync(join(shared, "audio", `${s}.mp3`))) continue;
  const ruAudio = existsSync(join(shared, "audio", "ru", `${s}.mp3`));
  t.phrases.push({ en, ru, enAlt: list(enAlt), ruAlt: list(ruAlt), slug: s, ruAudio });
}

// ---------- Page ----------

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/main.js
execSync(`npx tsc --outDir "${out}"`, { cwd: game, stdio: "inherit" });

const page = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("{{title}}", meta.title)
  .replaceAll("{{icon}}", meta.icon ?? "💬")
  .replaceAll("{{mode}}", settings.mode);
writeFileSync(join(out, "index.html"), page);
cpSync(join(game, "style.css"), join(out, "style.css"));

// Phrases go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const data = { source: SOURCE, lesson: where, mode: settings.mode, topics: topics.filter((t) => t.phrases.length) };
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

const voiced = topics.reduce((sum, t) => sum + t.phrases.length, 0);
const voicedRu = topics.reduce((sum, t) => sum + t.phrases.filter((p) => p.ruAudio).length, 0);
console.log(`Готово: ${out}`);
console.log(`Режим: ${settings.mode}, тем: ${data.topics.length}, фраз: ${total}, со звуком: ${voiced}, с русским звуком: ${voicedRu}`);
if (voiced < total) console.log(`Не все фразы озвучены — python3 lessons/${SOURCE}/tools/speak.py (без звука фраза в игре не появится)`);
if (voicedRu < voiced) console.log(`Не все переводы озвучены — python3 lessons/${SOURCE}/tools/speak.py --ru (без звука перевод читает голос браузера)`);
