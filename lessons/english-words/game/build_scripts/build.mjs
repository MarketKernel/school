// Builds the game into build/: page, styles, code and data.js.
// The words, sounds and pictures live in the shared folder lessons/english (see english/words.mjs):
// data.js lists the words, and the game loads the files from that folder — nothing is copied.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOLDER, readEnglish } from "../../../english/words.mjs";

const game = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(game, "build");

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

// TypeScript -> build/main.js
execSync("npx tsc --outDir build", { cwd: game, stdio: "inherit" });

for (const file of ["index.html", "style.css"]) cpSync(join(game, file), join(out, file));

// Only words with a sound make it into the game; a missing picture is replaced by the topic icon
const { topics } = readEnglish();
const total = topics.reduce((sum, t) => sum + t.words.length, 0);
const data = {
  source: FOLDER,
  topics: topics.map(({ key, icon, name, words }) => ({
    key,
    icon,
    name,
    words: words.filter((w) => w.audio).map(({ word, ru, accept, slug, image }) => ({ word, ru, accept, slug, image })),
  })),
};

// Words go into data.js so no fetch is needed (fetch fails when the file is opened directly)
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

const voiced = data.topics.reduce((sum, t) => sum + t.words.length, 0);
const pictured = data.topics.reduce((sum, t) => sum + t.words.filter((w) => w.image).length, 0);
console.log(`Готово: ${out}`);
console.log(`Тем: ${topics.length}, слов: ${total}, со звуком: ${voiced}, с картинкой: ${pictured}`);
if (voiced < total) console.log(`Не все слова озвучены — python3 lessons/${FOLDER}/tools/speak.py (без звука слово в игре не появится)`);
