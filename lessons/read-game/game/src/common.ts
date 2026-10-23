// «Собери слово» engine: what the game modes share — words, syllable split, sounds, levels, effects, the word cells
// and speech recognition. One engine for several reading lessons: each lesson brings its words, pictures and story (game.json).
// The page loads data.js, then this file, then one mode: assemble.js (tiles; riddle lessons too), aloud.js (reading
// a word aloud) or sentence.js (reading a sentence aloud, a voiced text as the prize).
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
  words: string[]; // as written, names with a capital letter: «Гарри»; a riddle answer may be several words
  riddles?: Record<string, string>; // riddle lessons only: answer -> the riddle's sound, audio/….mp3 next to the page
  // sentence lessons only: sentence to read -> the prize, its text and sound (audio/….mp3 next to the page)
  rewards?: Record<string, { text: string; audio: string }>;
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

/** Plays one sound file (a riddle, a prize). Like playParts, it interrupts what is playing and is interrupted by the next call. */
async function playFile(url: string): Promise<void> {
  stopSounds();
  await playOne(url);
}

/** Stops whatever is playing. */
function stopSounds() {
  ++playToken;
  stopCurrent?.();
}

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

// ---------- Levels: names and dialogs come from the lesson (game.json) ----------

/** Which words (or sentences) go to a level; hint is the tooltip of its button. */
interface Difficulty {
  hint: string;
  fits: (entry: string) => boolean;
}

interface Level extends Difficulty {
  name: string;
  icon: string;
  done: Dialog;
}

// Difficulty is the number of tiles to assemble: «до-мик» is easier than «с-т-ра-ш-но», though both have two syllables
const tileCount = (entry: string) => splitPhrase(entry).parts.length;
const DIFFICULTY: Difficulty[] = [
  { hint: "слова из 2–3 частей", fits: (w) => tileCount(w) <= 3 },
  { hint: "слова из 4 частей", fits: (w) => tileCount(w) === 4 },
  { hint: "слова из 5 частей и больше", fits: (w) => tileCount(w) >= 5 },
];
let LEVELS: Level[] = [];
let doneIcon = "";
let confettiIcons: string[] = [];
const PIPS = 5; // pips under each level button; each glows brighter with each word
const WORDS_PER_LEVEL = 25; // words needed to complete a level (5 per pip)
let goals: number[] = []; // per level: WORDS_PER_LEVEL, or every word of it when each word is played once

// ---------- Game state ----------

/** What a game mode adds to the shared part. */
interface Mode {
  newRound(): void; // a new word has been picked: entry, word and parts are set
  render(): void; // redraw the mode's own part of the page
  busy(): boolean; // true while the level must not change (a check is in progress)
  // Riddles: every word (answer) is played once, and a level is complete when all of its words are done.
  // Such a lesson keeps all its words, even one-syllable ones («Мел») and phrases («Дни недели»).
  everyWord?: boolean;
  // Sentences: the mode's own levels instead of the tile counts; every entry is kept as it is
  difficulty?: Difficulty[];
}
let mode: Mode;

let wordsByLevel: string[][] = [];
let level = 0;
let progress: number[] = []; // words done on each level
let seen: Set<string>[] = []; // so words don't repeat until all have been used
let solved: Set<string>[] = []; // words done on each level (counted once when everyWord)
let entry = ""; // the word as written in the lesson: «Гарри», «Дни недели»
let word = ""; // its letters in lower case, without spaces — tiles and checks use it
let letters = ""; // its letters as written, without spaces: a right letter is shown in the word's own case
let parts: string[] = [];
let wordStarts = new Set<number>(); // indexes in parts where the second, third… word of a phrase begins

/** Parts of a phrase: each word is split on its own («дни недели» → д-ни | не-де-ли). */
function splitPhrase(phrase: string): { parts: string[]; starts: Set<number> } {
  const parts: string[] = [];
  const starts = new Set<number>();
  for (const w of lower(phrase).split(/\s+/).filter(Boolean)) {
    if (parts.length) starts.add(parts.length);
    parts.push(...splitWord(w));
  }
  return { parts, starts };
}

const random = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Only words with pictures (if the level has any), in rotation: no repeats until all have been shown.
 * With everyWord, only the words not done yet, while there are any.
 */
function pickWord(): string {
  const all = wordsByLevel[level]!;
  const withPicture = all.filter((w) => imageFiles[w]);
  let pool = withPicture.length ? withPicture : all;
  const todo = pool.filter((w) => !solved[level]!.has(w));
  if (mode.everyWord && todo.length) pool = todo;
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
  letters = entry.replace(/\s+/g, "");
  word = lower(letters);
  ({ parts, starts: wordStarts } = splitPhrase(entry));
  mode.newRound();
  render();
}

function setLevel(index: number) {
  if (mode.busy()) return;
  level = index;
  newRound();
}

/**
 * One more word done on the current level. Returns true when this completes the level;
 * the dialog then comes by itself, unless `announce` is false (the mode shows it later with showLevelDone).
 */
function addProgress(announce = true): boolean {
  const again = solved[level]!.has(entry);
  solved[level]!.add(entry);
  if (mode.everyWord && again) return false; // a riddle solved before doesn't count twice
  const goal = goals[level]!;
  progress[level] = Math.min(goal, progress[level]! + 1);
  const complete = progress[level] === goal;
  if (complete && announce) setTimeout(showLevelDone, 1200);
  return complete;
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
  $("overlay-text").textContent = lvl.done.text.split("{n}").join(String(goals[level]));
  $("overlay-btn").textContent = lvl.done.button;
  $("overlay-btn").onclick = () => {
    $("overlay").hidden = true;
    if (last) {
      progress = LEVELS.map(() => 0);
      solved = LEVELS.map(() => new Set<string>());
      setLevel(0);
    } else {
      setLevel(level + 1);
    }
  };
  $("overlay").hidden = false;
  confetti();
}

// ---------- Reading aloud: speech recognition (Web Speech API, ru-RU) for "aloud" and "sentence" ----------

// Not in the TypeScript DOM lib
interface RecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: { transcript: string };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { results: { readonly length: number; [index: number]: RecognitionResult } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const speechApi = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
const Recognizer = speechApi.SpeechRecognition ?? speechApi.webkitSpeechRecognition ?? null;

let recognition: Recognition | null = null;
let listenTimer = 0;
let quietTimer = 0;
let micBlocked = false; // no permission or no microphone — only the manual button is left
let lastError = ""; // recognizer error of the last attempt: no-speech, network…

const canSpeak = () => Recognizer !== null && !micBlocked;
// Without recognition (or offline) an adult listens and presses «Получилось»
const manualMode = () => !canSpeak() || lastError === "network";

/** How long to listen: `listen` at most in all, `quiet` of silence after something was heard ends the attempt. */
interface ListenTiming {
  listen: number;
  quiet: number;
}

/**
 * Turns the mic on. `matches` is asked about every alternative and about everything heard so far
 * (a word read by syllables or a sentence may come as several results); the first match ends the attempt.
 * onHeard gets the best guess while the child reads, onEnd the verdict. False if listening could not start.
 */
function startRecognition(matches: (text: string) => boolean, onHeard: (text: string) => void,
  onEnd: (matched: boolean, error: string) => void, timing: ListenTiming): boolean {
  if (!Recognizer || micBlocked) return false;
  stopSounds(); // the mic must not hear the speaker
  stopRecognition();

  const rec = new Recognizer();
  rec.lang = "ru-RU";
  rec.interimResults = true; // show what is heard while the child reads
  rec.maxAlternatives = 5; // the right answer is often not the first guess for a child's voice
  rec.continuous = true; // a pause between syllables or words must not end the attempt
  let matched = false;
  let error = "";
  rec.onresult = (e) => {
    const best: string[] = [];
    for (let i = 0; i < e.results.length; i++) {
      const result = e.results[i]!;
      best.push(result[0]?.transcript ?? "");
      for (let j = 0; j < result.length; j++) if (matches(result[j]!.transcript)) matched = true;
    }
    const heard = best.join(" ").replace(/\s+/g, " ").trim();
    if (matches(heard)) matched = true; // syllables may come as separate results: «га» + «ри»
    onHeard(heard);
    clearTimeout(quietTimer);
    if (matched) rec.stop();
    else if (heard) quietTimer = setTimeout(() => rec.stop(), timing.quiet);
  };
  rec.onerror = (e) => {
    error = e.error;
  };
  rec.onend = () => {
    clearTimeout(listenTimer);
    clearTimeout(quietTimer);
    if (recognition !== rec) return; // stopped on purpose: another word or another attempt
    recognition = null;
    lastError = matched ? "" : error;
    if (["not-allowed", "service-not-allowed", "audio-capture"].includes(error)) micBlocked = true;
    onEnd(matched, error);
  };

  recognition = rec;
  lastError = "";
  try {
    rec.start();
  } catch {
    recognition = null;
    return false;
  }
  listenTimer = setTimeout(() => rec.stop(), timing.listen);
  return true;
}

/** Turns the mic off without a verdict (another word, another attempt). */
function stopRecognition() {
  const rec = recognition;
  recognition = null;
  clearTimeout(listenTimer);
  clearTimeout(quietTimer);
  rec?.abort();
}

/** 🎤 pressed while listening: the child has finished reading — check what was heard. */
function finishRecognition() {
  recognition?.stop();
}

/** The note under the buttons when reading can't be checked by voice. */
function micNote(): string {
  if (!Recognizer) return "Этот браузер не умеет распознавать речь (подойдут Chrome, Edge или Safari). Пусть взрослый послушает и нажмёт «Получилось».";
  if (micBlocked) return "Разрешите микрофон в настройках браузера и обновите страницу. А пока взрослый может нажимать «Получилось».";
  return "Распознавание речи работает только с интернетом. Пока взрослый может нажимать «Получилось».";
}

/** Only the letters: «Гар-ри!» → «гарри»; «ё» counts as «е» (recognizers often drop the dots). */
const lettersOf = (text: string) => text.toLowerCase().replace(/ё/g, "е").replace(/[^а-я]/g, "");

/** Edit distance from `want` to the closest piece of `said`: the word may sit inside a longer phrase. */
function closest(said: string, want: string): number {
  let prev: number[] = Array.from({ length: said.length + 1 }, () => 0);
  for (let i = 1; i <= want.length; i++) {
    const row = [i];
    for (let j = 1; j <= said.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (want[i - 1] === said[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return Math.min(...prev);
}

// ---------- Saved score (⭐ of the reading-aloud modes) ----------

const scoreKey = () => `read-game:${GAME_DATA.lesson}:score`;

function loadScore(): number {
  try {
    return Number(localStorage.getItem(scoreKey())) || 0;
  } catch {
    return 0;
  }
}

function saveScore(score: number) {
  try {
    localStorage.setItem(scoreKey(), String(score));
  } catch {
    // Private mode or blocked storage: the score lives until the page is closed
  }
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function bump(el: HTMLElement) {
  el.classList.remove("bump");
  void el.offsetWidth; // restart the animation
  el.classList.add("bump");
}

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
    const done = progress[i] === goals[i];
    btn.className = "level" + (i === level ? " current" : "") + (done ? " done" : "");
    btn.title = `${lvl.name}: ${lvl.hint}`;
    const perPip = goals[i]! / PIPS;
    const pips = Array.from({ length: PIPS }, (_, k) => {
      const fill = Math.max(0, Math.min(1, (progress[i]! - k * perPip) / perPip));
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
 * The word cells, grouped by parts with dots between them. Each word of a phrase («Дни недели») is its own block,
 * so a long phrase wraps between words, never inside one.
 * `typed` fills the cells from the start; `result` colours them: "ok" — a green wave, "bad" — wrong letters red.
 */
function renderWord(typed: string, result: "ok" | "bad" | null) {
  const box = $("word");
  box.replaceChildren();
  const words: string[][] = [];
  parts.forEach((part, pi) => {
    if (pi === 0 || wordStarts.has(pi)) words.push([]);
    words[words.length - 1]!.push(part);
  });
  // Cell size adapts to the length of the longest word: letters + room for the dots
  const size = (w: string[]) => w.join("").length + (w.length - 1) * 0.5;
  box.style.setProperty("--n", String(Math.max(...words.map(size))));
  box.classList.toggle("phrase", words.length > 1);

  let index = 0;
  for (const w of words) {
    const holder = words.length > 1 ? box.appendChild(Object.assign(document.createElement("span"), { className: "phrase-word" })) : box;
    w.forEach((part, pi) => {
      if (pi > 0) holder.append(Object.assign(document.createElement("span"), { className: "dot" }));
      const group = document.createElement("span");
      group.className = "group";
      for (const _ of part) {
        const cell = document.createElement("span");
        cell.className = "cell";
        const letter = typed[index] ?? "";
        cell.textContent = letter === word[index] ? letters[index]! : letter; // a right first letter of a name is capital
        if (letter) cell.classList.add("filled");
        if (result) cell.classList.add(letter === word[index] ? "ok" : "bad");
        if (result === "ok") cell.style.setProperty("--i", String(index)); // wave across the letters
        group.append(cell);
        index++;
      }
      holder.append(group);
    });
  }
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
  const difficulty = gameMode.difficulty ?? DIFFICULTY;
  LEVELS = story.levels.map((lvl, i) => ({ ...lvl, ...difficulty[i]! }));
  doneIcon = story.doneIcon;
  confettiIcons = story.confetti;
  progress = LEVELS.map(() => 0);
  seen = LEVELS.map(() => new Set<string>());
  solved = LEVELS.map(() => new Set<string>());
  // Only Russian words with at least two syllables (two vowels); riddle answers are all kept (everyWord),
  // sentences too. Split into levels by tile count, or by the mode's own difficulty
  const words = gameMode.difficulty
    ? GAME_DATA.words
    : gameMode.everyWord
      ? GAME_DATA.words.filter((w) => /^[а-яё]+( [а-яё]+)*$/.test(lower(w)))
      : GAME_DATA.words.filter((w) => /^[а-яё]+$/.test(lower(w)) && syllableCount(lower(w)) >= 2);
  wordsByLevel = LEVELS.map((lvl) => words.filter(lvl.fits));
  goals = wordsByLevel.map((list) => (gameMode.everyWord ? list.length : WORDS_PER_LEVEL));
  newRound();
  return true;
}
