// Builds one English phrase lesson into <lesson>/build/: page, styles, code and data.js.
// This engine is shared by english-phrases-ru, english-phrases-en and english-phrases-assemble; each of them calls it
// from its lesson.json:
//   (cd ../english-phrases/game && npm ci) && node ../english-phrases/game/build_scripts/build.mjs .
//
// The lesson folder holds:
//   lesson.json — title and icon are reused for the page; it lists "uses": ["english-phrases"]
//   game.json   — { "mode": "to-russian" | "to-english" | "assemble" }:
//                 to-russian — hear an English phrase, say it in Russian (ru-RU recognition); the hint shows
//                              the translation and plays it (a browser voice reads it if there's no sound);
//                 to-english — read (or hear) a Russian phrase, say it in English (en-US recognition); the hint
//                              plays the English sound;
//                 assemble   — hear an English phrase, put it together from word cards; phrases of one word
//                              are left out;
//                 tenses-listen — hear a sentence, choose when it happens: yesterday, now or tomorrow;
//                 tenses-say    — see a sentence in one tense, say it in another (en-US recognition).
//                 The tenses modes take their sentences from lessons/english-tenses (see below), the others
//                 from this folder.
// The page's code is src/common.ts plus one file per mode (MODES below); the build keeps only the lesson's one.
//
// The phrases live in this shared folder (lessons/english-phrases):
//   data/topics.tsv  — topic key, icon, name
//   data/phrases.tsv — topic key, phrase, translation, other translations (|-separated),
//                      other English variants (|-separated); the extra variants only widen the speech check
//   audio/<slug>.mp3 — made by tools/speak.py; a phrase without a sound is left out of the game
//   audio/ru/<slug>.mp3 — the Russian translation, made by tools/speak.py --ru; optional
// lessons/english-tenses holds the tenses' sentences:
//   data/topics.tsv    — topic key, icon, name
//   data/sentences.tsv — topic key, the sentence yesterday / now / tomorrow, the same three in Russian
//   audio/<slug>.mp3   — made by its tools/speak.py; a sentence is in the game when all three forms are voiced
// Sounds are not copied: the root build publishes the shared folder once as _site/<folder>/, and the game loads
// them from ../<folder>/ on the site or ../../<folder>/ from a local <lesson>/build/.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
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
// mode → its code file (src/<code>.ts), its shared folder and whether the answer is spoken
const MODES = {
  "to-russian": { code: "speak", source: "english-phrases", mic: true },
  "to-english": { code: "speak", source: "english-phrases", mic: true },
  assemble: { code: "assemble", source: "english-phrases", mic: false },
  "tenses-listen": { code: "tenses", source: "english-tenses", mic: false },
  "tenses-say": { code: "tenses", source: "english-tenses", mic: true },
};
const setup = MODES[settings.mode];
if (!setup) throw new Error(`${where}/game.json: mode должен быть ${Object.keys(MODES).join(", ")}, а не ${settings.mode}`);
const { code, mic } = setup;
const SOURCE = setup.source; // folder name under lessons/ and on the site
const shared = join(game, "..", "..", SOURCE);
if (!(meta.uses ?? []).includes(SOURCE)) throw new Error(`${where}/lesson.json: допишите "uses": ["${SOURCE}"] — оттуда берутся звуки`);

// ---------- Phrases or sentences ----------

/** File name for a phrase: «How are you?» → «how-are-you». Same as slug() in lessons/english/tools/common.py. */
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const list = (cell = "") => cell.split("|").map((x) => x.trim()).filter(Boolean);
const voiced = (s) => existsSync(join(shared, "audio", `${s}.mp3`));

function readLines(name) {
  const path = join(shared, "data", name);
  if (!existsSync(path)) throw new Error(`Нет lessons/${SOURCE}/data/${name}`);
  return readFileSync(path, "utf8").split("\n").slice(1).filter((line) => line.trim())
    .map((line) => line.split("\t").map((cell) => cell.trim()));
}

const topics = readLines("topics.tsv").map(([key, icon, name]) => ({ key, icon, name, items: [] }));
const topicOf = (key, what) => {
  const t = topics.find((x) => x.key === key);
  if (!t) throw new Error(`${what}: темы «${key}» нет в lessons/${SOURCE}/data/topics.tsv`);
  return t;
};
const words = (text) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
let total = 0;
let unvoiced = 0;

function readPhrases() {
  const seen = { slug: new Map(), ru: new Map() };
  for (const [topic, en, ru, ruAlt, enAlt] of readLines("phrases.tsv")) {
    const t = topicOf(topic, `Фраза «${en}»`);
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
    if (!voiced(s)) {
      unvoiced++;
      continue;
    }
    if (settings.mode === "assemble" && words(en) < 2) continue; // nothing to put in order
    const ruAudio = existsSync(join(shared, "audio", "ru", `${s}.mp3`));
    t.items.push({ en, ru, enAlt: list(enAlt), ruAlt: list(ruAlt), slug: s, ruAudio });
  }
}

/** Every sentence form is an item; it carries all three forms of its verb. */
function readTenses() {
  const TENSES = ["past", "now", "future"];
  const seen = new Map();
  for (const [topic, ...cells] of readLines("sentences.tsv")) {
    const t = topicOf(topic, `Предложение «${cells[0]}»`);
    if (cells.length < 6 || cells.some((c) => !c)) throw new Error(`lessons/${SOURCE}/data/sentences.tsv: у «${cells[0]}» нужны 3 английских и 3 русских предложения`);
    const forms = Object.fromEntries(TENSES.map((tense, i) => [tense, { en: cells[i], ru: cells[i + 3], slug: slug(cells[i]) }]));
    for (const f of Object.values(forms)) {
      if (seen.has(f.slug)) throw new Error(`lessons/${SOURCE}/data/sentences.tsv: «${f.en}» и «${seen.get(f.slug)}» — одинаковое имя файла ${f.slug}.mp3`);
      seen.set(f.slug, f.en);
    }
    total += 3;
    if (!Object.values(forms).every((f) => voiced(f.slug))) {
      unvoiced += 3;
      continue;
    }
    for (const tense of TENSES) t.items.push({ slug: forms[tense].slug, tense, topic, forms });
  }
}

if (SOURCE === "english-tenses") readTenses();
else readPhrases();

// ---------- Page ----------

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/common.js + one file per mode; only the lesson's mode stays
execSync(`npx tsc --outDir "${out}"`, { cwd: game, stdio: "inherit" });
for (const other of new Set(Object.values(MODES).map((m) => m.code))) if (other !== code) rmSync(join(out, `${other}.js`));

const page = readFileSync(join(game, "index.html"), "utf8")
  .replaceAll("{{title}}", meta.title)
  .replaceAll("{{icon}}", meta.icon ?? "💬")
  .replaceAll("{{mode}}", settings.mode)
  .replaceAll("{{code}}", code)
  .replaceAll("{{mic}}", mic ? " data-mic" : "");
writeFileSync(join(out, "index.html"), page);
cpSync(join(game, "style.css"), join(out, "style.css"));

// Phrases go into data.js so no fetch is needed (fetch fails when the file is opened directly)
const data = { source: SOURCE, lesson: where, mode: settings.mode, topics: topics.filter((t) => t.items.length) };
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

const inGame = topics.reduce((sum, t) => sum + t.items.length, 0);
console.log(`Готово: ${out}`);
if (SOURCE === "english-tenses") {
  console.log(`Режим: ${settings.mode}, тем: ${data.topics.length}, предложений: ${total}, в игре: ${inGame}`);
  if (unvoiced) console.log(`Не все предложения озвучены — python3 lessons/${SOURCE}/tools/speak.py (глагол без всех трёх звуков в игре не появится)`);
} else {
  const voicedRu = topics.reduce((sum, t) => sum + t.items.filter((p) => p.ruAudio).length, 0);
  console.log(`Режим: ${settings.mode}, тем: ${data.topics.length}, фраз: ${total}, в игре: ${inGame}, с русским звуком: ${voicedRu}`);
  if (unvoiced) console.log(`Не все фразы озвучены — python3 lessons/${SOURCE}/tools/speak.py (без звука фраза в игре не появится)`);
  if (voicedRu < inGame) console.log(`Не все переводы озвучены — python3 lessons/${SOURCE}/tools/speak.py --ru (без звука перевод читает голос браузера)`);
}
