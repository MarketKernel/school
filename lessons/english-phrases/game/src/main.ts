// English phrase lessons: the child translates a phrase aloud, speech recognition checks it.
//   to-russian — hear an English phrase (🔊), say it in Russian; 💡 shows the translation and plays it.
//   to-english — read or hear (🔊) a Russian phrase, say it in English; 💡 plays the English phrase.

// The build (build_scripts/build.mjs) puts topics and phrases into data.js. Sounds stay in the shared folder
// lessons/english-phrases and are loaded from it (see sharedBase); only phrases with a sound get here.
interface PhraseData {
  en: string;
  ru: string;
  enAlt: string[]; // other English answers that count («Hi» for «Hello!»)
  ruAlt: string[]; // other Russian translations that count
  slug: string; // file name: audio/<slug>.mp3
  ruAudio: boolean; // the translation is voiced too: audio/ru/<slug>.mp3
}
interface TopicData {
  key: string;
  icon: string;
  name: string;
  phrases: PhraseData[];
}
type Mode = "to-russian" | "to-english";
declare const GAME_DATA: {
  source: string; // shared folder with the sounds
  lesson: string; // lesson folder: keeps the progress of the two lessons apart
  mode: Mode;
  topics: TopicData[];
};

const LISTEN_MS = 12000; // stop listening after this long anyway: the child may think before answering
const QUIET_MS = 2200; // after something was heard, this much silence ends the attempt
const MAX_SOUND_MS = 8000;
const NEW_PHRASE_CHANCE = 0.75; // how often to prefer a phrase that hasn't been translated yet
const HINT_AFTER_MISSES = 2; // nudge towards 💡 after this many tries

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

// ---------- Checking the answer ----------

type Lang = "en" | "ru";

const NUMBERS: Record<Lang, string[]> = {
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"],
  ru: ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять",
    "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать",
    "восемнадцать", "девятнадцать", "двадцать"],
};
// Words that flip the meaning: they can never be skipped or added («I like it» ≠ «I don't like it»)
const NEGATIONS = new Set(["not", "no", "не", "нет", "ни"]);
// Dropped before comparing: articles and fillers
const SKIP: Record<Lang, Set<string>> = {
  en: new Set(["a", "an", "the", "um", "umm", "uh", "er", "hmm"]),
  ru: new Set(["ну", "э", "ээ", "эээ", "эм", "мм", "ммм"]),
};
// Small words a long answer may miss: «я хочу игрушку» for «я хочу эту игрушку», «у меня кошка» for «у меня есть кошка»
const OPTIONAL: Record<Lang, Set<string>> = {
  en: new Set(["please", "my", "your", "is", "are", "am", "it", "this", "that", "to", "do", "so", "very", "now",
    "some", "of", "for", "in", "on", "at", "here", "there", "too", "really"]),
  ru: new Set(["пожалуйста", "это", "эту", "этот", "эта", "мне", "меня", "мой", "моя", "моё", "мою", "свою",
    "свой", "своё", "твой", "твою", "же", "вот", "уже", "очень", "сейчас", "так", "а", "и", "в", "на", "с", "у",
    "за", "по", "к", "тебе", "тебя", "вам", "вас"]),
};

/** «I'm» and «I am» must compare equal, so contractions are expanded on both sides. */
function expandEnglish(text: string): string {
  return text
    .replace(/[’‘`]/g, "'")
    .replace(/\bcan't\b/g, "can not").replace(/\bcannot\b/g, "can not").replace(/\bwon't\b/g, "will not")
    .replace(/\blet's\b/g, "let us").replace(/\bwanna\b/g, "want to").replace(/\bgonna\b/g, "going to")
    .replace(/n't\b/g, " not").replace(/'re\b/g, " are").replace(/'m\b/g, " am").replace(/'s\b/g, " is")
    .replace(/'ve\b/g, " have").replace(/'ll\b/g, " will").replace(/'d\b/g, " would")
    .replace(/\bok\b/g, "okay").replace(/\balright\b/g, "all right")
    .replace(/'/g, "");
}

/** «Привет, как дела?» → ["привет", "как", "дела"]; «ё» = «е», digits become words: «7» → «семь». */
function tokens(text: string, lang: Lang): string[] {
  let t = text.toLowerCase().replace(/ё/g, "е");
  if (lang === "en") t = expandEnglish(t).replace(/\b(\d+):00\b/g, "$1 oclock"); // «3:00» = «three o'clock»
  else t = t.replace(/\b(\d+):00\b/g, "$1");
  return t
    .replace(/\d+/g, (d) => ` ${NUMBERS[lang][Number(d)] ?? d} `)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !SKIP[lang].has(w));
}

// British spellings and words the recognizer may write instead of the American ones in the list
const SPELLING: Record<string, string> = {
  colour: "color", favourite: "favorite", favour: "favor", grey: "gray", mum: "mom", mummy: "mommy",
};

/**
 * Lenient where it's safe, strict where another word would pass. The recognizer writes real words, so a
 * different letter means a different word («light» ≠ «right», «прочтите» ≠ «простите»). English: plurals
 * count («cats» for «cat»). Russian: the ending may differ («собаку» for «собака», «рада» for «рад»,
 * «поиграем» for «поиграть») — at least 3 letters and 70% of the word in common: «так» ≠ «там»,
 * «скучаю» ≠ «скучно», «пока» ≠ «покажи».
 */
function sameWord(said: string, want: string, lang: Lang): boolean {
  if (said === want) return true;
  if (NEGATIONS.has(said) || NEGATIONS.has(want)) return false; // «не» must not pass for «на»
  if (lang === "en") {
    const a = SPELLING[said] ?? said;
    const b = SPELLING[want] ?? want;
    return a === b || a === b + "s" || a === b + "es" || a + "s" === b || a + "es" === b;
  }
  const shorter = Math.min(said.length, want.length);
  const longer = Math.max(said.length, want.length);
  let prefix = 0;
  while (prefix < shorter && said[prefix] === want[prefix]) prefix++;
  return prefix >= 3 && prefix >= longer * 0.7 && shorter - prefix <= 2 && longer - prefix <= (shorter <= 4 ? 1 : 3);
}

/**
 * Every word of the answer has to be heard, in any order. An answer of 4+ words may miss a small word
 * (OPTIONAL), one in four, but not swap it for another one: «my turn» is not «your turn». Extra words may
 * only be small ones too («а как тебя зовут?»), so a short answer can't hide inside a different phrase:
 * «how old are you» is not «how are you». An extra or missing «не» never passes.
 */
function matchesVariant(saidText: string, wantText: string, lang: Lang): boolean {
  const said = tokens(saidText, lang);
  const want = tokens(wantText, lang);
  if (!want.length || !said.length) return false;
  if (said.some((w) => NEGATIONS.has(w)) !== want.some((w) => NEGATIONS.has(w))) return false;
  if (said.join("") === want.join("")) return true; // split or joined words: «не честно», «lunch time»
  const used = said.map(() => false);
  let misses = 0;
  for (const w of want) {
    const i = said.findIndex((s, k) => !used[k] && sameWord(s, w, lang));
    if (i >= 0) used[i] = true;
    else if (OPTIONAL[lang].has(w)) misses++;
    else return false;
  }
  // A repeated word is not extra: «привет, привет»
  const extra = said.filter((s, k) => !used[k] && !want.some((w) => sameWord(s, w, lang)));
  if (extra.some((s) => !OPTIONAL[lang].has(s))) return false;
  if (misses) return misses <= Math.floor(want.length / 4) && extra.length === 0;
  return extra.length <= 2;
}

const answerLang = (): Lang => (mode === "to-russian" ? "ru" : "en");
const answers = (p: PhraseData) => (mode === "to-russian" ? [p.ru, ...p.ruAlt] : [p.en, ...p.enAlt]);
const matches = (transcript: string, p: PhraseData) => answers(p).some((a) => matchesVariant(transcript, a, answerLang()));

// ---------- Saved progress ----------

let store = "";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${store}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`${store}:${key}`, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: progress lives until the page is closed
  }
}

// ---------- Game state ----------

// idle — waiting; listening — the mic is on; ok — translated right; miss — try again
type Phase = "idle" | "listening" | "ok" | "miss";

let mode: Mode = "to-russian";
let mediaBase = "";
let topics: TopicData[] = [];
let topicIndex = 0;
let current: PhraseData | null = null;
let phase: Phase = "idle";
let playing: "" | "phrase" | "hint" = ""; // what is playing: the phrase (🔊) or the hint (💡)
let hinted = false; // 💡 was used for this phrase: then it doesn't count as learned
let misses = 0; // tries on this phrase
let heard = ""; // what the recognizer heard on the last attempt
let lastError = ""; // recognizer error of the last attempt: no-speech, network…
let micBlocked = false; // no permission or no microphone — only the manual button is left
let touched = false; // the page got a click or a key: from now on sounds may start by themselves
let score = 0;
let learned = new Set<string>(); // phrases translated without a hint at least once (slugs)
const seen = new Map<string, Set<string>>(); // per topic: phrases shown since the last full cycle

const canSpeak = () => Recognizer !== null && !micBlocked;
// Without recognition (or offline) an adult listens and presses «Получилось»
const manualMode = () => !canSpeak() || lastError === "network";

const random = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;
const learnedIn = (topic: TopicData) => topic.phrases.filter((p) => learned.has(p.slug)).length;

/** On the site lessons and shared folders sit side by side (../english-phrases/); a local build lives in lessons/<lesson>/build/. */
function sharedBase(folder: string): string {
  const local = /\/lessons\/[^/]+\/build\//.test(location.pathname);
  return `${local ? "../../" : "../"}${folder}/`;
}
const audioUrl = (p: PhraseData) => `${mediaBase}audio/${p.slug}.mp3`;
const ruAudioUrl = (p: PhraseData) => `${mediaBase}audio/ru/${p.slug}.mp3`;
// The sound of the task: the English phrase, or the Russian one in to-english (if it's voiced)
const promptUrl = (p: PhraseData) => (mode === "to-russian" ? audioUrl(p) : p.ruAudio ? ruAudioUrl(p) : "");

/** Phrases in rotation: no repeats until the whole topic has been shown; new phrases come up more often. */
function pickPhrase(): PhraseData {
  const topic = topics[topicIndex]!;
  const recent = seen.get(topic.key) ?? new Set<string>();
  seen.set(topic.key, recent);
  let fresh = topic.phrases.filter((p) => !recent.has(p.slug) && p !== current);
  if (!fresh.length) {
    recent.clear();
    fresh = topic.phrases.filter((p) => p !== current);
  }
  if (!fresh.length) fresh = topic.phrases;
  const unlearned = fresh.filter((p) => !learned.has(p.slug));
  const next = random(unlearned.length && Math.random() < NEW_PHRASE_CHANCE ? unlearned : fresh);
  recent.add(next.slug);
  return next;
}

function newRound() {
  stopSounds();
  stopListening();
  current = pickPhrase();
  phase = "idle";
  hinted = false;
  misses = 0;
  heard = "";
  lastError = lastError === "network" ? lastError : "";
  // Fetch the sounds before they are needed
  audioFor(audioUrl(current)).load();
  if (current.ruAudio) audioFor(ruAudioUrl(current)).load();
  render();
  // Play the task right away once the browser allows sound
  if (touched && promptUrl(current)) listenToPhrase();
}

function setTopic(index: number) {
  topicIndex = index;
  save("topic", topics[index]!.key);
  newRound();
}

// ---------- Sound: the English phrase and the Russian hint ----------

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
  stopSounds();
  return new Promise((resolve) => {
    const a = audioFor(url);
    // A phrase lasts a couple of seconds; if «ended» never comes (stalled load), don't leave the game hanging
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

const synth = window.speechSynthesis ?? null;
let russianVoice: SpeechSynthesisVoice | null = null;

function findRussianVoice() {
  russianVoice = synth?.getVoices().find((v) => v.lang.replace("_", "-").toLowerCase().startsWith("ru")) ?? null;
}

/** Reads the Russian translation with a system voice when it has no sound; without a Russian voice the hint is text only. */
function sayRussian(text: string): Promise<void> {
  if (!synth || !russianVoice) return Promise.resolve();
  stopSounds();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = russianVoice;
    u.lang = russianVoice!.lang;
    u.rate = 0.9;
    const guard = setTimeout(() => stopCurrent?.(), MAX_SOUND_MS);
    const done = () => {
      clearTimeout(guard);
      u.onend = u.onerror = null;
      stopCurrent = null;
      resolve();
    };
    stopCurrent = () => {
      synth.cancel();
      done();
    };
    u.onend = u.onerror = done;
    synth.speak(u);
  });
}

function stopSounds() {
  stopCurrent?.();
}

/** Plays a sound, then turns the mic on by itself — the child just answers. */
async function playThenListen(kind: "phrase" | "hint", sound: () => Promise<void>) {
  const phrase = current;
  if (!phrase || playing) return;
  stopListening();
  playing = kind;
  render();
  await sound();
  playing = "";
  // Another phrase may have been picked while playing — then just redraw
  if (current === phrase && phase !== "ok" && canSpeak()) startListening();
  else render();
}

/** 🔊: the task — the English phrase (to-russian) or the Russian one (to-english). */
function listenToPhrase() {
  const url = current && promptUrl(current);
  if (url) playThenListen("phrase", () => play(url));
}

/** The translation: its sound, or a system voice if it isn't voiced. */
function playRussian(p: PhraseData): Promise<void> {
  return p.ruAudio ? play(ruAudioUrl(p)) : sayRussian(p.ru);
}

/** 💡: to-russian — the translation, shown and played; to-english — the English phrase, shown and played. */
function showHint() {
  const phrase = current;
  if (!phrase || phase === "ok") return;
  hinted = true;
  playThenListen("hint", () => (mode === "to-russian" ? playRussian(phrase) : play(audioUrl(phrase))));
}

// ---------- Listening ----------

let recognition: Recognition | null = null;
let listenTimer = 0;
let quietTimer = 0;

function startListening() {
  const phrase = current;
  if (!Recognizer || !phrase || micBlocked || playing || phase === "ok") return;
  stopSounds(); // the mic must not hear the speaker
  stopListening();

  const rec = new Recognizer();
  rec.lang = mode === "to-russian" ? "ru-RU" : "en-US";
  rec.interimResults = true; // show what is heard while the child speaks
  rec.maxAlternatives = 5; // the right phrase is often not the first guess for a child's voice
  rec.continuous = true; // a pause in the middle of a phrase must not end the attempt
  let matched = false;
  let error = "";
  rec.onresult = (e) => {
    const best: string[] = [];
    for (let i = 0; i < e.results.length; i++) {
      const result = e.results[i]!;
      best.push(result[0]?.transcript ?? "");
      for (let j = 0; j < result.length; j++) if (matches(result[j]!.transcript, phrase)) matched = true;
    }
    heard = best.join(" ").replace(/\s+/g, " ").trim();
    if (matches(heard, phrase)) matched = true; // a phrase may come as several results
    render();
    clearTimeout(quietTimer);
    if (matched) rec.stop();
    else if (heard) quietTimer = setTimeout(() => rec.stop(), QUIET_MS);
  };
  rec.onerror = (e) => {
    error = e.error;
  };
  rec.onend = () => {
    clearTimeout(listenTimer);
    clearTimeout(quietTimer);
    if (recognition !== rec) return; // stopped on purpose: another phrase or another attempt
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
  clearTimeout(quietTimer);
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
  if (phase === "miss") {
    misses++;
    chime(false);
  }
  render();
}

/** 🎤: starts listening; pressed while listening — the child has finished. */
function toggleListening() {
  if (recognition) recognition.stop();
  else startListening();
}

function success() {
  const phrase = current;
  if (!phrase || phase === "ok") return;
  stopListening();
  phase = "ok";
  score++;
  save("score", score);
  const firstTime = !hinted && !learned.has(phrase.slug);
  if (firstTime) {
    learned.add(phrase.slug);
    save("learned", [...learned]);
  }
  chime(true);
  confetti();
  bump($("score"));
  render();
  // Reading Russian, the child said the English phrase: now let them hear how it really sounds
  if (mode === "to-english") setTimeout(() => current === phrase && play(audioUrl(phrase)), 600);
  const topic = topics[topicIndex]!;
  if (firstTime && learnedIn(topic) === topic.phrases.length) setTimeout(showTopicDone, 1800);
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
    bit.textContent = random(["⭐", "✨", "🎉", "🌟", "💬", topics[topicIndex]!.icon]);
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
  $("overlay-text").textContent = `Все фразы переведены без подсказки — целых ${topic.phrases.length}. Молодец!`;
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
    btn.className = "topic" + (i === topicIndex ? " current" : "") + (done === topic.phrases.length ? " done" : "");
    btn.title = topic.name;
    btn.innerHTML = `<span class="topic-icon">${topic.icon}</span><span class="topic-name">${topic.name}</span>` +
      `<span class="topic-count">${done}/${topic.phrases.length}</span>`;
    btn.onclick = () => setTopic(i);
    box.append(btn);
  });
  $("score").textContent = `⭐ ${score}`;
}

function renderBoard() {
  const phrase = current!;
  const toRussian = mode === "to-russian";
  $("task").textContent = `${topics[topicIndex]!.icon} ` + (toRussian ? "Как это сказать по-русски?" : "Как это сказать по-английски?");
  const question = $("question");
  question.textContent = toRussian ? phrase.en : phrase.ru;
  question.lang = toRussian ? "en" : "ru";

  // The answer opens with the hint or after a right answer
  const answer = $("answer");
  answer.hidden = !hinted && phase !== "ok";
  answer.textContent = toRussian ? phrase.ru : phrase.en;
  answer.lang = toRussian ? "ru" : "en";
  answer.classList.toggle("ok", phase === "ok");

  const shown = phase === "listening" || (phase === "miss" && heard) ? heard : "";
  $("heard").textContent = shown ? `Я услышал: «${shown}»` : "";
}

function renderActions() {
  const listen = $<HTMLButtonElement>("listen");
  listen.hidden = !promptUrl(current!);
  listen.classList.toggle("active", playing === "phrase");
  listen.classList.toggle("hint", mode === "to-russian" && phase === "idle" && !playing);

  const speak = $<HTMLButtonElement>("speak");
  speak.hidden = !canSpeak();
  speak.disabled = playing !== "" || phase === "ok";
  speak.classList.toggle("active", phase === "listening");
  speak.classList.toggle("hint", phase === "miss" || (mode === "to-english" && phase === "idle" && !playing));
  $("speak-label").textContent = phase === "listening" ? "Готово" : mode === "to-russian" ? "По-русски" : "По-английски";

  const hint = $<HTMLButtonElement>("hint");
  hint.disabled = phase === "ok" || playing === "phrase";
  hint.classList.toggle("active", playing === "hint");
  hint.classList.toggle("hint", phase === "miss" && misses >= HINT_AFTER_MISSES && !hinted);
}

function message(): string {
  if (playing) return playing === "hint" ? "Подсказка…" : "Слушай…";
  switch (phase) {
    case "listening":
      return mode === "to-russian" ? "Говори по-русски! 🎤" : "Говори по-английски! 🎤";
    case "ok":
      return hinted
        ? random(["Правильно! +1", "Получилось! +1"]) + " А потом — без подсказки 😉"
        : random(["Правильно! +1", "Ура! Получилось! +1", "Отлично! +1", "Здорово! +1", "Супер! +1"]);
    case "miss":
      if (lastError === "network") return "Нет интернета — проверить не получится";
      if (micBlocked) return "Нет доступа к микрофону";
      if (!heard) return "Ничего не слышно. Скажи погромче!";
      return misses >= HINT_AFTER_MISSES && !hinted ? "Не совсем. Возьми подсказку 💡" : "Не совсем. Попробуй ещё раз!";
    default:
      if (mode === "to-russian") return manualMode() ? "Послушай 🔊 и скажи по-русски" : "Нажми 🔊, послушай и скажи по-русски";
      return manualMode() ? "Скажи это по-английски" : "Скажи по-английски — нажми 🎤";
  }
}

function renderControls() {
  const msg = $("message");
  msg.className = phase === "ok" ? "ok" : phase === "miss" ? "miss" : "";
  msg.textContent = message();

  $("manual-ok").hidden = !manualMode() || phase === "ok";
  $("next").classList.toggle("primary", phase === "ok");
  $("next").textContent = phase === "ok" ? "Следующая фраза →" : "Другая фраза";

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
    $("message").textContent = "Нет data.js — соберите урок: npm run build";
    return;
  }
  mode = GAME_DATA.mode;
  store = `english-phrases:${GAME_DATA.lesson}`;
  mediaBase = sharedBase(GAME_DATA.source);
  topics = GAME_DATA.topics.filter((t) => t.phrases.length);
  if (!topics.length) {
    $("message").textContent = "Фразы ещё не озвучены — python3 lessons/english-phrases/tools/speak.py";
    return;
  }
  // Plus a topic with every phrase
  topics.push({ key: "mix", icon: "🎲", name: "Вперемешку", phrases: topics.flatMap((t) => t.phrases) });
  score = load("score", 0);
  learned = new Set(load<string[]>("learned", []));
  topicIndex = Math.max(0, topics.findIndex((t) => t.key === load("topic", "")));

  // Voices load asynchronously in Chrome
  findRussianVoice();
  synth?.addEventListener?.("voiceschanged", findRussianVoice);

  const touch = () => {
    touched = true;
  };
  document.addEventListener("pointerdown", touch, { capture: true });
  $("listen").onclick = listenToPhrase;
  $("speak").onclick = toggleListening;
  $("hint").onclick = showHint;
  $("manual-ok").onclick = success;
  $("next").onclick = newRound;
  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    touch();
    if (!$("overlay").hidden) {
      if (e.key === "Enter") $("overlay-btn").click();
      return;
    }
    if (e.key === " ") {
      e.preventDefault(); // not a click on the focused button
      if (promptUrl(current!)) listenToPhrase();
      else showHint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (phase === "ok") newRound();
      else toggleListening();
    } else if (e.key === "h" || e.key === "р") {
      showHint();
    }
  });

  newRound();
}

main();
