// «Собери слово» game: the word is split into syllables and the child assembles it from the tiles below.

// The build (build_scripts/build.mjs) puts words and sound lists into data.js and the sounds into audio/
declare const GAME_DATA: {
  words: string[];
  syllables: Record<string, string>;
  letters: Record<string, string>;
  soft: Record<string, string>; // soft consonants «ть», «ль»…
  images: Record<string, string>; // word pictures: word -> images/….jpg
};

const VOWELS = "аеёиоуыэюя";
const SIGNS = "ьъ";
const ALPHABET = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";
const SOFTABLE = "бвгдзклмнпрстфх"; // consonants that have a soft pair
const PAUSE_BETWEEN_PARTS = 250; // ms between syllables when speaking a word

// ---------- Syllable split (same as tools/syllables.py) ----------

const isVowel = (ch: string) => ch !== "" && VOWELS.includes(ch);
const isSign = (ch: string) => ch !== "" && SIGNS.includes(ch);
const isConsonant = (ch: string) => ALPHABET.includes(ch) && !isVowel(ch) && !isSign(ch);
const isSyllable = (part: string) => part.length === 2 && isConsonant(part[0]!) && isVowel(part[1]!);

/** Splits a word into parts: consonant + vowel pairs and single letters. ь/ъ attach to the previous part. */
function splitWord(word: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    const next = word[i + 1] ?? "";
    if (isConsonant(ch) && isVowel(next)) {
      parts.push(ch + next);
      i++;
    } else if (isSign(ch) && parts.length) {
      parts[parts.length - 1] += ch;
    } else {
      parts.push(ch);
    }
  }
  return parts;
}

// ---------- Sound ----------

let syllableFiles: Record<string, string> = {};
let letterFiles: Record<string, string> = {};
let softFiles: Record<string, string> = {};
let imageFiles: Record<string, string> = {};

/** Files for a word part: the whole syllable or soft consonant if recorded, otherwise each letter separately. */
function urlsFor(part: string): string[] {
  const whole = syllableFiles[part] ?? softFiles[part];
  if (whole) return [`audio/${whole}`];
  // «съ» sounds like a hard «с» — the letter name «твёрдый знак» is not spoken
  const letters = part.length > 1 && part.endsWith("ъ") ? part.slice(0, -1) : part;
  return [...letters].flatMap((ch) => (letterFiles[ch] ? [`audio/${letterFiles[ch]}`] : []));
}

const audioCache = new Map<string, HTMLAudioElement>();
let playToken = 0;
let stopCurrent: (() => void) | null = null;

function playOne(url: string): Promise<void> {
  return new Promise((resolve) => {
    let audio = audioCache.get(url);
    if (!audio) {
      audio = new Audio(url);
      audioCache.set(url, audio);
    }
    const a = audio;
    const done = () => {
      a.onended = a.onerror = null;
      stopCurrent = null;
      resolve();
    };
    stopCurrent = () => {
      a.pause();
      done();
    };
    a.onended = a.onerror = done;
    a.currentTime = 0;
    a.play().catch(done);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plays the parts one after another. A new call interrupts the previous one. */
async function playParts(parts: string[]): Promise<void> {
  const token = ++playToken;
  stopCurrent?.();
  for (const [i, part] of parts.entries()) {
    for (const url of urlsFor(part)) {
      await playOne(url);
      if (token !== playToken) return;
    }
    if (i < parts.length - 1) await sleep(PAUSE_BETWEEN_PARTS);
    if (token !== playToken) return;
  }
}

// ---------- Levels: the three houses from the tale ----------

// Difficulty is the number of tiles to assemble: «до-мик» is easier than «с-т-ра-ш-но», though both have two syllables
interface Level {
  name: string;
  icon: string;
  done: string; // message shown when the level is complete
  hint: string;
  fits: (tiles: number) => boolean;
}

const LEVELS: Level[] = [
  { name: "Соломенный домик", icon: "🌾", done: "Соломенный домик построен!", hint: "слова из 2–3 частей",
    fits: (n) => n <= 3 },
  { name: "Домик из веток", icon: "🪵", done: "Домик из веток построен!", hint: "слова из 4 частей",
    fits: (n) => n === 4 },
  { name: "Каменный дом", icon: "🧱", done: "Каменный дом построен!", hint: "слова из 5 частей и больше",
    fits: (n) => n >= 5 },
];
const PIPS = 5; // pips under each house
const WORDS_PER_PIP = 5; // words per pip — it glows brighter with each word
const WORDS_PER_LEVEL = PIPS * WORDS_PER_PIP; // words needed to build a house

const syllableCount = (w: string) => [...w].filter(isVowel).length;

// ---------- Game state ----------

interface Tile {
  id: number;
  text: string;
  used: boolean;
}

let wordsByLevel: string[][] = [];
let level = 0;
let progress = LEVELS.map(() => 0); // words collected on each level
let seen = LEVELS.map(() => new Set<string>()); // so words don't repeat until all have been used
let word = "";
let parts: string[] = [];
let tiles: Tile[] = [];
let placed: Tile[] = [];
let result: "ok" | "bad" | null = null;
let busy = false; // a check is in progress — tiles are locked

const placedText = () => placed.map((t) => t.text).join("");
const isFull = () => placedText().length === word.length;

const random = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Decoy tiles: one look-alike per correct tile (a syllable for a syllable, a letter for a letter). */
function decoys(correct: string[]): string[] {
  const taken = new Set(correct);
  const syllablePool = Object.keys(syllableFiles);
  const letterPool = [...ALPHABET].filter((c) => !isSign(c));
  return correct.map((part) => {
    let pool: string[];
    if (isSyllable(part)) pool = syllablePool;
    else if (part.length === 1) pool = letterPool;
    else pool = [...SOFTABLE].map((c) => c + part.slice(1)); // «ть» → «нь», «сь»…
    const options = pool.filter((x) => !taken.has(x));
    const pick = options.length ? random(options) : random(pool);
    taken.add(pick);
    return pick;
  });
}

/** Only words with pictures (if the level has any), in rotation: no repeats until all have been shown. */
function pickWord(): string {
  const all = wordsByLevel[level]!;
  const withPicture = all.filter((w) => imageFiles[w]);
  const pool = withPicture.length ? withPicture : all;
  let fresh = pool.filter((w) => !seen[level]!.has(w) && w !== word);
  if (!fresh.length) {
    seen[level]!.clear();
    fresh = pool.filter((w) => w !== word);
  }
  const next = random(fresh.length ? fresh : pool);
  seen[level]!.add(next);
  return next;
}

function newRound() {
  word = pickWord();
  parts = splitWord(word);
  tiles = shuffle([...parts, ...decoys(parts)]).map((text, id) => ({ id, text, used: false }));
  placed = [];
  result = null;
  render();
}

function setLevel(index: number) {
  if (busy) return;
  level = index;
  newRound();
}

function place(tile: Tile, el: HTMLElement) {
  if (busy || result === "ok" || tile.used) return;
  if (placedText().length + tile.text.length > word.length) {
    shake(el); // doesn't fit into the remaining cells
    return;
  }
  tile.used = true;
  placed.push(tile);
  result = null;
  render();
  playParts([tile.text]);
}

function erase() {
  if (busy || result === "ok") return;
  const tile = placed.pop();
  if (!tile) return;
  tile.used = false;
  result = null;
  render();
}

async function check() {
  if (busy || !isFull() || result === "ok") return;
  busy = true;
  render();
  await playParts(placed.map((t) => t.text));
  result = placedText() === word ? "ok" : "bad";
  busy = false;
  if (result === "ok") {
    progress[level] = Math.min(WORDS_PER_LEVEL, progress[level]! + 1);
    chime(true);
    confetti();
  } else {
    chime(false);
    shake($("word"));
  }
  render();
  if (result === "ok" && progress[level] === WORDS_PER_LEVEL) setTimeout(showLevelDone, 1200);
}

function next() {
  if (busy) return;
  newRound();
}

// ---------- Effects: right/wrong chime and confetti ----------

let effects: AudioContext | null = null;

/** A short synthesized tune — no extra sound files needed. */
function chime(ok: boolean) {
  effects ??= new AudioContext();
  const ctx = effects;
  const notes = ok ? [523, 659, 784, 1047] : [330, 262]; // C-E-G-C / E-C
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime + i * (ok ? 0.09 : 0.18);
    osc.type = ok ? "triangle" : "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (ok ? 0.35 : 0.3));
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

function confetti() {
  const layer = $("confetti");
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement("span");
    bit.textContent = random(["⭐", "✨", "🐷", "🎉", "🌟"]);
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.animationDelay = `${Math.random() * 0.3}s`;
    bit.style.fontSize = `${20 + Math.random() * 22}px`;
    bit.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    layer.append(bit);
    setTimeout(() => bit.remove(), 2200);
  }
}

// ---------- "House built" dialog ----------

function showLevelDone() {
  const last = level === LEVELS.length - 1;
  const lvl = LEVELS[level]!;
  $("overlay-icon").textContent = last ? "🐷🐷🐷" : lvl.icon;
  $("overlay-title").textContent = last ? "Все домики построены!" : lvl.done;
  $("overlay-text").textContent = last
    ? "Теперь волку поросят не достать. Молодец!"
    : `Ты собрал ${WORDS_PER_LEVEL} слов. Дальше — ${LEVELS[level + 1]!.name.toLowerCase()}.`;
  $("overlay-btn").textContent = last ? "Играть снова" : "Строить дальше →";
  $("overlay-btn").onclick = () => {
    $("overlay").hidden = true;
    if (last) {
      progress = LEVELS.map(() => 0);
      setLevel(0);
    } else {
      setLevel(level + 1);
    }
  };
  $("overlay").hidden = false;
  confetti();
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>' +
  '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round"/></svg>';

function shake(el: HTMLElement) {
  el.classList.remove("shake");
  void el.offsetWidth; // restart the animation
  el.classList.add("shake");
}

function renderLevels() {
  const box = $("levels");
  box.replaceChildren();
  LEVELS.forEach((lvl, i) => {
    const btn = document.createElement("button");
    const done = progress[i] === WORDS_PER_LEVEL;
    btn.className = "level" + (i === level ? " current" : "") + (done ? " done" : "");
    btn.title = `${lvl.name}: ${lvl.hint}`;
    const pips = Array.from({ length: PIPS }, (_, k) => {
      const fill = Math.max(0, Math.min(1, (progress[i]! - k * WORDS_PER_PIP) / WORDS_PER_PIP));
      return `<i class="${fill === 1 ? "full" : ""}" style="--fill:${fill}"></i>`;
    }).join("");
    btn.innerHTML = `<span class="level-icon">${done ? "🏠" : lvl.icon}</span>` +
      `<span class="level-name">${lvl.name}</span><span class="pips">${pips}</span>`;
    btn.onclick = () => setLevel(i);
    box.append(btn);
  });
  document.body.dataset.level = String(level);
}

function renderPicture() {
  const img = $<HTMLImageElement>("picture");
  const file = imageFiles[word];
  img.hidden = !file;
  if (file && img.getAttribute("src") !== file) img.src = file;
}

function renderWord() {
  const box = $("word");
  box.replaceChildren();
  // Cell size adapts to the word length
  box.style.setProperty("--n", String(word.length + (parts.length - 1) * 0.5));

  const letters = placedText();
  let index = 0;
  parts.forEach((part, pi) => {
    if (pi > 0) box.append(Object.assign(document.createElement("span"), { className: "dot" }));
    const group = document.createElement("span");
    group.className = "group";
    for (const _ of part) {
      const cell = document.createElement("span");
      cell.className = "cell";
      const letter = letters[index] ?? "";
      cell.textContent = letter;
      if (letter) cell.classList.add("filled");
      if (result) cell.classList.add(letter === word[index] ? "ok" : "bad");
      if (result === "ok") cell.style.setProperty("--i", String(index)); // wave across the letters
      group.append(cell);
      index++;
    }
    box.append(group);
  });
}

function renderTiles() {
  const box = $("tiles");
  box.replaceChildren();
  for (const tile of tiles) {
    const el = document.createElement("div");
    el.className = "tile" + (tile.used ? " used" : "");

    const text = document.createElement("button");
    text.className = "tile-text";
    text.textContent = tile.text;
    text.disabled = tile.used || busy || result === "ok";
    text.onclick = () => place(tile, el);

    const speaker = document.createElement("button");
    speaker.className = "speaker small";
    speaker.title = "Послушать";
    speaker.innerHTML = SPEAKER_SVG;
    speaker.disabled = tile.used;
    speaker.onclick = () => playParts([tile.text]);

    el.append(text, speaker);
    box.append(el);
  }
}

function renderControls() {
  ($("erase") as HTMLButtonElement).disabled = busy || !placed.length || result === "ok";
  ($("check") as HTMLButtonElement).disabled = busy || !isFull() || result === "ok";
  $("check").hidden = result === "ok";
  $("next").classList.toggle("primary", result === "ok");
  $("next").textContent = result === "ok" ? "Следующее слово →" : "Другое слово";

  const message = $("message");
  message.className = result ?? "";
  message.textContent =
    result === "ok" ? random(["Правильно! Молодец!", "Ура! Получилось!", "Отлично!", "Здорово!"]) :
    result === "bad" ? "Не так. Сотри и попробуй ещё раз" :
    busy ? "Слушаем…" :
    "";
}

function render() {
  renderLevels();
  renderPicture();
  renderWord();
  renderTiles();
  renderControls();
}

// ---------- Startup ----------

function main() {
  if (typeof GAME_DATA === "undefined") {
    $("message").textContent = "Нет data.js — соберите игру: npm run build";
    return;
  }
  syllableFiles = GAME_DATA.syllables;
  letterFiles = GAME_DATA.letters;
  softFiles = GAME_DATA.soft ?? {};
  imageFiles = GAME_DATA.images ?? {};
  // Only Russian words with at least two syllables (two vowels); split into levels by tile count
  const words = GAME_DATA.words.filter((w) => /^[а-яё]+$/.test(w) && syllableCount(w) >= 2);
  wordsByLevel = LEVELS.map((lvl) => words.filter((w) => lvl.fits(splitWord(w).length)));

  $("say-word").innerHTML = SPEAKER_SVG;
  $("say-word").onclick = () => playParts(parts);
  $("erase").onclick = erase;
  $("check").onclick = check;
  $("next").onclick = next;
  document.addEventListener("keydown", (e) => {
    if (!$("overlay").hidden) {
      if (e.key === "Enter") $("overlay-btn").click();
      return;
    }
    if (e.key === "Backspace") erase();
    if (e.key === "Enter") (result === "ok" ? next : check)();
  });

  newRound();
}

main();
