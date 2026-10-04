// Builds the game into build/: page, styles, code and data.js.
// The words, sounds and pictures live in the shared folder lessons/english (see english/words.mjs):
// data.js lists the words, and the game loads the files from that folder — nothing is copied.
// Only words that have both a sound and a picture are used.

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

const { topics, similar } = readEnglish();
const all = topics.flatMap((t) => t.words);
const data = {
  source: FOLDER,
  topics: topics
    .map(({ key, icon, name, words }) => ({
      key,
      icon,
      name,
      words: words.filter((w) => w.audio && w.image).map(({ word, ru, slug }) => ({ word, ru, slug })),
    }))
    .filter((t) => t.words.length >= 4),
  similar,
};

// Words go into data.js so no fetch is needed (fetch fails when the file is opened directly)
writeFileSync(join(out, "data.js"), `const GAME_DATA = ${JSON.stringify(data)};\n`);

const used = data.topics.reduce((sum, t) => sum + t.words.length, 0);
console.log(`Готово: ${out}`);
console.log(`Тем: ${data.topics.length}, слов: ${used}, групп похожих картинок: ${similar.length}` +
  (used < all.length ? `, пропущено без звука или картинки: ${all.length - used}` : ""));
