// «Скажи по-английски» game: the child listens to an English word, repeats it, and speech recognition checks it.

// The build (build_scripts/build.mjs) puts topics and words into data.js. Sounds and pictures stay in the
// shared folder lessons/english and are loaded from it (see findMediaBase); only words with a sound get here.
interface WordData {
  word: string;
  ru: string;
  accept: string[]; // other recognizer answers that count: homophones («two» → «to», «too»), plurals
  slug: string; // file name: audio/<slug>.mp3, images/<slug>.jpg
  image: boolean; // has a picture
}
interface TopicData {
  key: string;
  icon: string;
  name: string;
  words: WordData[];
}
declare const GAME_DATA: {
  source: string; // shared folder with the sounds and pictures
  topics: TopicData[];
};

const LANG = "en-US";
const LISTEN_MS = 6000; // stop listening after this long even if the child keeps quiet
const MAX_SOUND_MS = 5000;
const NEW_WORD_CHANCE = 0.75; // how often to prefer a word that hasn't been said right yet
const STORE = "english-words"; // localStorage key prefix

// ---------- Speech recognition (Web Speech API — not in the TypeScript DOM lib) ----------

interface RecognitionResult {
  readonly length: number;
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

const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** «It's a T-shirt!» → ["its", "a", "t", "shirt"]; digits become words: «2» → «two». */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\d+/g, (d) => NUMBERS[Number(d)] ?? d)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Lenient on purpose: a plural counts, and so does one wrong letter in a long word («girafe»). */
function sameWord(said: string, want: string): boolean {
  if (said === want || said === want + "s" || said === want + "es" || said + "s" === want) return true;
  return want.length >= 5 && editDistance(said, want) <= 1;
}

/** True if the word (or one of its accepted variants) appears anywhere in what was heard: «a cat» counts for «cat». */
function matches(transcript: string, word: WordData): boolean {
  const said = tokens(transcript);
  return [word.word, ...word.accept].some((variant) => {
    const want = tokens(variant);
    for (let i = 0; want.length && i + want.length <= said.length; i++) {
      if (want.every((t, k) => sameWord(said[i + k]!, t))) return true;
    }
    return false;
  });
}

// ---------- Sounds and pictures from the shared folder ----------

let mediaBase = "";

/** On the site lessons and shared folders sit side by side (../english/); a local build lives in lessons/<lesson>/game/build/. */
function findMediaBase(source: string): string {
  return location.pathname.includes("/game/build/") ? `../../../${source}/` : `../${source}/`;
}

const audioUrl = (w: WordData) => `${mediaBase}audio/${w.slug}.mp3`;
const imageUrl = (w: WordData) => `${mediaBase}images/${w.slug}.jpg`;

// ---------- Saved progress ----------

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${STORE}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`${STORE}:${key}`, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: progress lives until the page is closed
  }
}

// ---------- Game state ----------

// idle — waiting for 🔊; listening — the mic is on; ok — said right; miss — try again
type Phase = "idle" | "listening" | "ok" | "miss";

let topics: TopicData[] = [];
let topicIndex = 0;
let current: WordData | null = null;
let phase: Phase = "idle";
let playing = false; // the word is being played
let heard = ""; // what the recognizer heard on the last attempt
let lastError = ""; // recognizer error of the last attempt: no-speech, network…
let micBlocked = false; // no permission or no microphone — only the manual button is left
let score = load("score", 0);
const learned = new Set(load<string[]>("learned", [])); // words said right at least once
const seen = new Map<string, Set<string>>(); // per topic: words shown since the last full cycle

const canSpeak = () => Recognizer !== null && !micBlocked;
// Without recognition (or offline) an adult listens and presses «Получилось»
const manualMode = () => !canSpeak() || lastError === "network";

const random = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;
const learnedIn = (topic: TopicData) => topic.words.filter((w) => learned.has(w.word)).length;

/** Words in rotation: no repeats until the whole topic has been shown; new words come up more often. */
function pickWord(): WordData {
  const topic = topics[topicIndex]!;
  const recent = seen.get(topic.key) ?? new Set<string>();
  seen.set(topic.key, recent);
  let fresh = topic.words.filter((w) => !recent.has(w.word) && w !== current);
  if (!fresh.length) {
    recent.clear();
    fresh = topic.words.filter((w) => w !== current);
  }
  if (!fresh.length) fresh = topic.words;
  const unlearned = fresh.filter((w) => !learned.has(w.word));
  const next = random(unlearned.length && Math.random() < NEW_WORD_CHANCE ? unlearned : fresh);
  recent.add(next.word);
  return next;
}

function newRound() {
  stopAudio();
  stopListening();
  current = pickWord();
  phase = "idle";
  heard = "";
  lastError = lastError === "network" ? lastError : "";
  audioFor(audioUrl(current)).load(); // fetch the sound before the button is pressed
  render();
}

function setTopic(index: number) {
  topicIndex = index;
  save("topic", topics[index]!.key);
  newRound();
}

// ---------- Sound ----------

const audioCache = new Map<string, HTMLAudioElement>();
let stopCurrent: (() => void) | null = null;

function audioFor(url: string): HTMLAudioElement {
  let audio = audioCache.get(url);
  if (!audio) {
    audio = new Audio(url);
    audio.preload = "auto";
    audioCache.set(url, audio);
  }
  return audio;
}

function play(url: string): Promise<void> {
  stopAudio();
  return new Promise((resolve) => {
    const a = audioFor(url);
    // A word lasts about a second; if «ended» never comes (stalled load), don't leave the game hanging
    const guard = setTimeout(() => stopCurrent?.(), MAX_SOUND_MS);
    const done = () => {
      clearTimeout(guard);
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

function stopAudio() {
  stopCurrent?.();
}

/** 🔊: plays the word, then turns the mic on by itself — the child just repeats. */
async function listenToWord() {
  const word = current;
  if (!word || playing) return;
  stopListening();
  playing = true;
  render();
  await play(audioUrl(word));
  playing = false;
  // Another word may have been picked while playing — then just redraw
  if (current === word && phase !== "ok" && canSpeak()) startListening();
  else render();
}

// ---------- Listening ----------

let recognition: Recognition | null = null;
let listenTimer = 0;

function startListening() {
  const word = current;
  if (!Recognizer || !word || micBlocked || playing) return;
  stopAudio(); // the mic must not hear the speaker
  stopListening();

  const rec = new Recognizer();
  rec.lang = LANG;
  rec.interimResults = true; // react as soon as the word is heard, without waiting for the pause
  rec.maxAlternatives = 5; // the right word is often not the first guess for a child's voice
  rec.continuous = false;
  let matched = false;
  let error = "";
  rec.onresult = (e) => {
    const best: string[] = [];
    for (let i = 0; i < e.results.length; i++) {
      const result = e.results[i]!;
      best.push(result[0]?.transcript ?? "");
      for (let j = 0; j < result.length; j++) if (matches(result[j]!.transcript, word)) matched = true;
    }
    heard = best.join(" ").trim();
    if (matched) rec.stop();
  };
  rec.onerror = (e) => {
    error = e.error;
  };
  rec.onend = () => {
    clearTimeout(listenTimer);
    if (recognition !== rec) return; // stopped on purpose: another word or another attempt
    recognition = null;
    finishListening(matched, error);
  };

  recognition = rec;
  heard = "";
  lastError = "";
  phase = "listening";
  render();
  try {
    rec.start();
  } catch {
    recognition = null;
    phase = "idle";
    render();
    return;
  }
  listenTimer = setTimeout(() => rec.stop(), LISTEN_MS);
}

function stopListening() {
  const rec = recognition;
  recognition = null;
  clearTimeout(listenTimer);
  rec?.abort();
  if (phase === "listening") phase = "idle";
}

function finishListening(matched: boolean, error: string) {
  if (matched) {
    success();
    return;
  }
  lastError = error;
  if (["not-allowed", "service-not-allowed", "audio-capture"].includes(error)) micBlocked = true;
  phase = error === "aborted" ? "idle" : "miss";
  if (phase === "miss") chime(false);
  render();
}

function success() {
  const word = current;
  if (!word || phase === "ok") return;
  stopListening();
  phase = "ok";
  score++;
  save("score", score);
  const firstTime = !learned.has(word.word);
  learned.add(word.word);
  save("learned", [...learned]);
  chime(true);
  confetti();
  bump($("score"));
  render();
  const topic = topics[topicIndex]!;
  if (firstTime && learnedIn(topic) === topic.words.length) setTimeout(showTopicDone, 1200);
}

function next() {
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
    gain.gain.exponentialRampToValueAtTime(ok ? 0.25 : 0.12, t + 0.02);
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
    bit.textContent = random(["⭐", "✨", "🎉", "🌟", topics[topicIndex]!.icon]);
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.animationDelay = `${Math.random() * 0.3}s`;
    bit.style.fontSize = `${20 + Math.random() * 22}px`;
    bit.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    layer.append(bit);
    setTimeout(() => bit.remove(), 2200);
  }
}

// ---------- "Topic done" dialog ----------

function showTopicDone() {
  const topic = topics[topicIndex]!;
  $("overlay-icon").textContent = topic.icon;
  $("overlay-title").textContent = `Тема «${topic.name}» пройдена!`;
  $("overlay-text").textContent = `Все слова получились — целых ${topic.words.length}. Молодец!`;
  $("overlay-btn").onclick = () => {
    $("overlay").hidden = true;
    setTopic((topicIndex + 1) % topics.length);
  };
  $("overlay").hidden = false;
  confetti();
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function bump(el: HTMLElement) {
  el.classList.remove("bump");
  void el.offsetWidth; // restart the animation
  el.classList.add("bump");
}

function renderTopics() {
  const box = $("topics");
  box.replaceChildren();
  topics.forEach((topic, i) => {
    const btn = document.createElement("button");
    const done = learnedIn(topic);
    btn.className = "topic" + (i === topicIndex ? " current" : "") + (done === topic.words.length ? " done" : "");
    btn.title = topic.name;
    btn.innerHTML = `<span class="topic-icon">${topic.icon}</span><span class="topic-name">${topic.name}</span>` +
      `<span class="topic-count">${done}/${topic.words.length}</span>`;
    btn.onclick = () => setTopic(i);
    box.append(btn);
  });
  $("score").textContent = `⭐ ${score}`;
}

function renderBoard() {
  const word = current!;
  const img = $<HTMLImageElement>("picture");
  img.hidden = !word.image;
  if (word.image && img.getAttribute("src") !== imageUrl(word)) img.src = imageUrl(word);
  const stub = $("picture-stub");
  stub.hidden = Boolean(word.image);
  stub.textContent = topics[topicIndex]!.icon;
  $("word").textContent = word.word;
  $("word").classList.toggle("ok", phase === "ok");
  $("translation").textContent = word.ru;
}

function renderActions() {
  const listen = $<HTMLButtonElement>("listen");
  listen.disabled = !current;
  listen.classList.toggle("active", playing);
  listen.classList.toggle("hint", phase === "idle" && !playing);

  const speak = $<HTMLButtonElement>("speak");
  speak.hidden = !canSpeak();
  speak.disabled = playing || phase === "ok";
  speak.classList.toggle("active", phase === "listening");
  speak.classList.toggle("hint", phase === "miss");
}

function message(): string {
  if (playing) return "Слушай…";
  switch (phase) {
    case "listening":
      return "Говори! 🎤";
    case "ok":
      return random(["Правильно! +1", "Ура! Получилось! +1", "Отлично! +1", "Здорово! +1", "Супер! +1"]);
    case "miss":
      if (lastError === "network") return "Нет интернета — проверить не получится";
      if (micBlocked) return "Нет доступа к микрофону";
      if (heard) return `Похоже на «${heard}». Попробуй ещё раз!`;
      return "Ничего не слышно. Скажи погромче!";
    default:
      return manualMode() ? "Послушай 🔊 и повтори вслух" : "Нажми 🔊, послушай и повтори";
  }
}

function renderControls() {
  const msg = $("message");
  msg.className = phase === "ok" ? "ok" : phase === "miss" ? "miss" : "";
  msg.textContent = message();

  $("manual-ok").hidden = !manualMode() || phase === "ok";
  $("next").classList.toggle("primary", phase === "ok");
  $("next").textContent = phase === "ok" ? "Следующее слово →" : "Другое слово";

  const note = $("note");
  note.hidden = !manualMode();
  note.textContent = !Recognizer
    ? "Этот браузер не умеет распознавать речь (подойдут Chrome, Edge или Safari). Пусть взрослый послушает и нажмёт «Получилось»."
    : micBlocked
      ? "Разрешите микрофон в настройках браузера и обновите страницу. А пока взрослый может нажимать «Получилось»."
      : "Распознавание речи работает только с интернетом. Пока взрослый может нажимать «Получилось».";
}

function render() {
  renderTopics();
  renderBoard();
  renderActions();
  renderControls();
}

// ---------- Startup ----------

function main() {
  if (typeof GAME_DATA === "undefined") {
    $("message").textContent = "Нет data.js — соберите игру: npm run build";
    return;
  }
  // Only words that have a sound; plus a topic with every word
  mediaBase = findMediaBase(GAME_DATA.source);
  topics = GAME_DATA.topics.filter((t) => t.words.length);
  if (!topics.length) {
    $("message").textContent = "Слова ещё не озвучены — python3 lessons/english/tools/speak.py";
    return;
  }
  topics.push({ key: "mix", icon: "🎲", name: "Вперемешку", words: topics.flatMap((t) => t.words) });
  topicIndex = Math.max(0, topics.findIndex((t) => t.key === load("topic", "")));

  $("listen").onclick = listenToWord;
  $("speak").onclick = startListening;
  $("manual-ok").onclick = success;
  $("next").onclick = next;
  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (!$("overlay").hidden) {
      if (e.key === "Enter") $("overlay-btn").click();
      return;
    }
    if (e.key === " ") {
      e.preventDefault(); // not a click on the focused button
      listenToWord();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (phase === "ok") next();
      else startListening();
    }
  });

  newRound();
}

main();
