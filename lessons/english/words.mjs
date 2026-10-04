// Reads the English materials for the lesson builds (english-words, english-pictures).
// The sounds and pictures are not copied into lessons: the root build publishes them once as _site/english/,
// and a game loads them from ../english/ (site) or ../../../english/ (a local lessons/<lesson>/game/build/).
//
//   data/topics.tsv  — topic key, icon, name
//   data/words.tsv   — topic key, word, translation, picture description, other accepted answers (comma-separated)
//   data/similar.tsv — look-alike pictures, comma-separated: at most one of a line is shown at a time
//   audio/<slug>.mp3, images/<slug>.jpg — made by tools/speak.py and tools/draw.py

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FOLDER = "english"; // folder name under lessons/ and on the site
const here = dirname(fileURLToPath(import.meta.url));

/** File name for a word: «T-shirt» → «t-shirt», «ice cream» → «ice-cream». Same as slug() in tools/common.py. */
export const slug = (word) => word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Lines of a data file without the header line. */
function readLines(name) {
  const path = join(here, "data", name);
  if (!existsSync(path)) throw new Error(`Нет lessons/${FOLDER}/data/${name} — это общий список английских слов`);
  return readFileSync(path, "utf8").split("\n").slice(1).filter((line) => line.trim());
}

/**
 * Topics with their words: { key, icon, name, words: [{ word, ru, accept, slug, audio, image }] },
 * where audio/image tell whether the file exists. Plus similar: look-alike groups (words).
 */
export function readEnglish() {
  const topics = readLines("topics.tsv")
    .map((line) => line.split("\t").map((cell) => cell.trim()))
    .map(([key, icon, name]) => ({ key, icon, name, words: [] }));
  const known = new Set();
  for (const line of readLines("words.tsv")) {
    const [topic, word, ru, , accept = ""] = line.split("\t").map((cell) => cell.trim());
    const t = topics.find((x) => x.key === topic);
    if (!t) throw new Error(`Слово «${word}»: темы «${topic}» нет в lessons/${FOLDER}/data/topics.tsv`);
    const s = slug(word);
    known.add(word);
    t.words.push({
      word,
      ru,
      accept: accept.split(",").map((a) => a.trim()).filter(Boolean),
      slug: s,
      audio: existsSync(join(here, "audio", `${s}.mp3`)),
      image: existsSync(join(here, "images", `${s}.jpg`)),
    });
  }

  const similar = readLines("similar.tsv").map((line) => line.split(",").map((w) => w.trim()).filter(Boolean));
  const unknown = similar.flat().filter((w) => !known.has(w));
  if (unknown.length) throw new Error(`lessons/${FOLDER}/data/similar.tsv: таких слов нет в words.tsv: ${unknown.join(", ")}`);

  return { topics, similar };
}
