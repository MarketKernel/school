// «Собери слово» engine: what both game modes share — words, syllable split, sounds, levels, effects and the word cells.
// One engine for several reading lessons: each lesson brings its words, pictures and story (game.json).
// The page loads data.js, then this file, then one mode: assemble.js (tiles) or aloud.js (reading aloud).
// These are classic scripts, not modules, so they share one global scope.

/** A level's end dialog from game.json; «{n}» in text is the number of words collected. */
interface Dialog {
  icon?: string;
  title: string;
  text: string;
  button: string;
}

// The build (build_scripts/build.mjs) puts words, sound lists and the lesson's story into data.js.
// Sounds (and pictures of a shared word list) stay in shared folders: they are not copied into the lesson.
declare const GAME_DATA: {
  lesson: string; // lesson folder name — the key prefix for saved progress
  source: string; // shared folder with the sounds: lessons/russian
  imageSource: string; // shared folder with the pictures, or "" when they are copied into the lesson
  words: string[]; // as written, names with a capital letter: «Гарри»
  syllables: Record<string, string>;
  letters: Record<string, string>;
  soft: Record<string, string>; // soft consonants «ть», «ль»…
  images: Record<string, string>; // word pictures: word -> images/….jpg
  story: {
    levels: { name: string; icon: string; done: Dialog }[];
    doneIcon: string; // on the button of a complete level
    confetti: string[];
  };
};

const VOWELS = "аеёиоуыэюя";
const SIGNS = "ьъ";
const ALPHABET = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";
const SOFTABLE = "бвгдзклмнпрстфх"; // consonants that have a soft pair
const PAUSE_BETWEEN_PARTS = 250; // ms between syllables when speaking a word

// ---------- Syllable split (same as russian/tools/syllables.py) ----------

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

const lower = (w: string) => w.toLowerCase();
const syllableCount = (w: string) => [...w].filter(isVowel).length;

// ---------- Shared folders ----------

/** On the site lessons and shared folders sit side by side (../russian/); a local build lives in lessons/<lesson>/build/. */
function sharedBase(folder: string): string {
  const local = /\/lessons\/[^/]+\/build\//.test(location.pathname);
  return `${local ? "../../" : "../"}${folder}/`;
}

// ---------- Sound ----------

let syllableFiles: Record<string, string> = {};
let letterFiles: Record<string, string> = {};
let softFiles: Record<string, string> = {};
let imageFiles: Record<string, string> = {};
let audioBase = "";
let imageBase = "";

/** Files for a word part: the whole syllable or soft consonant if recorded, otherwise each letter separately. */
function urlsFor(part: string): string[] {
  const whole = syllableFiles[part] ?? softFiles[part];
  if (whole) return [audioBase + whole];
  // «съ» sounds like a hard «с» — the letter name «твёрдый знак» is not spoken
  const letters = part.length > 1 && part.endsWith("ъ") ? part.slice(0, -1) : part;
  return [...letters].flatMap((ch) => (letterFiles[ch] ? [audioBase + letterFiles[ch]] : []));
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

/** Stops whatever is playing (the microphone must not hear the speaker). */
function stopSound() {
  playToken++;
  stopCurrent?.();
}

// ---------- Levels: names and dialogs come from the lesson (game.json) ----------

// Difficulty is the number of tiles to assemble: «до-мик» is easier than «с-т-ра-ш-но», though both have two syllables
interface Level {
  name: string;
  icon: string;
  done: Dialog;
  hint: string;
  fits: (tiles: number) => boolean;
}

const DIFFICULTY = [
  { hint: "слова из 2–3 частей", fits: (n: number) => n <= 3 },
  { hint: "слова из 4 частей", fits: (n: number) => n === 4 },
  { hint: "слова из 5 частей и больше", fits: (n: number) => n >= 5 },
];
let LEVELS: Level[] = [];
let doneIcon = "";
let confettiIcons: string[] = [];
const PIPS = 5; // pips under each level button
const WORDS_PER_PIP = 5; // words per pip — it glows brighter with each word
const WORDS_PER_LEVEL = PIPS * WORDS_PER_PIP; // words needed to complete a level

// ---------- Game state ----------

/** What a game mode adds to the shared part. */
interface Mode {
  newRound(): void; // a new word has been picked: entry, word and parts are set
  render(): void; // redraw the mode's own part of the page
  busy(): boolean; // true while the level must not change (a check is in progress)
}
let mode: Mode;

let wordsByLevel: string[][] = [];
let level = 0;
let progress: number[] = []; // words done on each level
let seen: Set<string>[] = []; // so words don't repeat until all have been used
let entry = ""; // the word as written in the lesson: «Гарри»
let word = ""; // the same in lower case — tiles and checks use it
let parts: string[] = [];

const random = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Only words with pictures (if the level has any), in rotation: no repeats until all have been shown. */
function pickWord(): string {
  const all = wordsByLevel[level]!;
  const withPicture = all.filter((w) => imageFiles[w]);
  const pool = withPicture.length ? withPicture : all;
  let fresh = pool.filter((w) => !seen[level]!.has(w) && w !== entry);
  if (!fresh.length) {
    seen[level]!.clear();
    fresh = pool.filter((w) => w !== entry);
  }
  const next = random(fresh.length ? fresh : pool);
  seen[level]!.add(next);
  return next;
}

function newRound() {
  entry = pickWord();
  word = lower(entry);
  parts = splitWord(word);
  mode.newRound();
  render();
}

function setLevel(index: number) {
  if (mode.busy()) return;
  level = index;
  newRound();
}

/** One more word done on the current level; the dialog comes when the level is complete. */
function addProgress() {
  progress[level] = Math.min(WORDS_PER_LEVEL, progress[level]! + 1);
  if (progress[level] === WORDS_PER_LEVEL) setTimeout(showLevelDone, 1200);
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
    bit.textContent = random(confettiIcons);
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.animationDelay = `${Math.random() * 0.3}s`;
    bit.style.fontSize = `${20 + Math.random() * 22}px`;
    bit.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    layer.append(bit);
    setTimeout(() => bit.remove(), 2200);
  }
}

// ---------- "Level complete" dialog ----------

function showLevelDone() {
  const last = level === LEVELS.length - 1;
  const lvl = LEVELS[level]!;
  $("overlay-icon").textContent = lvl.done.icon ?? lvl.icon;
  $("overlay-title").textContent = lvl.done.title;
  $("overlay-text").textContent = lvl.done.text.split("{n}").join(String(WORDS_PER_LEVEL));
  $("overlay-btn").textContent = lvl.done.button;
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
    btn.innerHTML = `<span class="level-icon">${done ? doneIcon : lvl.icon}</span>` +
      `<span class="level-name">${lvl.name}</span><span class="pips">${pips}</span>`;
    btn.onclick = () => setLevel(i);
    box.append(btn);
  });
  document.body.dataset.level = String(level);
}

function renderPicture() {
  const img = $<HTMLImageElement>("picture");
  const file = imageFiles[entry];
  img.hidden = !file;
  if (file && img.getAttribute("src") !== imageBase + file) img.src = imageBase + file;
}

/**
 * The word cells, grouped by parts with dots between them. `letters` fills them from the start;
 * `result` colours them: "ok" — a green wave, "bad" — wrong letters red.
 */
function renderWord(letters: string, result: "ok" | "bad" | null) {
  const box = $("word");
  box.replaceChildren();
  // Cell size adapts to the word length
  box.style.setProperty("--n", String(word.length + (parts.length - 1) * 0.5));

  let index = 0;
  parts.forEach((part, pi) => {
    if (pi > 0) box.append(Object.assign(document.createElement("span"), { className: "dot" }));
    const group = document.createElement("span");
    group.className = "group";
    for (const _ of part) {
      const cell = document.createElement("span");
      cell.className = "cell";
      const letter = letters[index] ?? "";
      cell.textContent = letter === word[index] ? entry[index]! : letter; // a right first letter of a name is capital
      if (letter) cell.classList.add("filled");
      if (result) cell.classList.add(letter === word[index] ? "ok" : "bad");
      if (result === "ok") cell.style.setProperty("--i", String(index)); // wave across the letters
      group.append(cell);
      index++;
    }
    box.append(group);
  });
}

function render() {
  renderLevels();
  renderPicture();
  mode.render();
}

// ---------- Startup ----------

/** Reads data.js and starts the game in the given mode. False if there is nothing to play. */
function startGame(gameMode: Mode): boolean {
  if (typeof GAME_DATA === "undefined") {
    $("message").textContent = "Нет data.js — соберите игру: npm run build";
    return false;
  }
  mode = gameMode;
  syllableFiles = GAME_DATA.syllables;
  letterFiles = GAME_DATA.letters;
  softFiles = GAME_DATA.soft ?? {};
  imageFiles = GAME_DATA.images ?? {};
  audioBase = sharedBase(GAME_DATA.source) + "audio/";
  imageBase = GAME_DATA.imageSource ? sharedBase(GAME_DATA.imageSource) : "";
  const story = GAME_DATA.story;
  LEVELS = story.levels.map((lvl, i) => ({ ...lvl, ...DIFFICULTY[i]! }));
  doneIcon = story.doneIcon;
  confettiIcons = story.confetti;
  progress = LEVELS.map(() => 0);
  seen = LEVELS.map(() => new Set<string>());
  // Only Russian words with at least two syllables (two vowels); split into levels by tile count
  const words = GAME_DATA.words.filter((w) => /^[а-яё]+$/.test(lower(w)) && syllableCount(lower(w)) >= 2);
  wordsByLevel = LEVELS.map((lvl) => words.filter((w) => lvl.fits(splitWord(lower(w)).length)));
  newRound();
  return true;
}
