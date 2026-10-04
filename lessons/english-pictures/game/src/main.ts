// «Найди картинку» game: the speaker says an English word, the child finds its picture among four.

// The build (build_scripts/build.mjs) puts topics and words into data.js. Sounds and pictures stay in the
// shared folder lessons/english and are loaded from it (see findMediaBase).
interface WordData {
  word: string;
  ru: string;
  slug: string; // file name: audio/<slug>.mp3, images/<slug>.jpg
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
  similar: string[][]; // look-alike pictures that never share a round
};

const OPTIONS = 4;
const NEXT_DELAY_MS = 1400; // pause on the right picture before the next word
const MAX_SOUND_MS = 5000; // a word lasts about a second; don't hang if «ended» never comes
const NEW_WORD_CHANCE = 0.75; // how often to prefer a word that hasn't been found on the first try yet
const STORE = "english-pictures"; // localStorage key prefix

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

// ---------- Sounds and pictures from the shared folder ----------

let mediaBase = "";

/** On the site lessons and shared folders sit side by side (../english/); a local build lives in lessons/<lesson>/game/build/. */
function findMediaBase(source: string): string {
  return location.pathname.includes("/game/build/") ? `../../../${source}/` : `../${source}/`;
}

const audioUrl = (w: WordData) => `${mediaBase}audio/${w.slug}.mp3`;
const imageUrl = (w: WordData) => `${mediaBase}images/${w.slug}.jpg`;

// ---------- Game state ----------

let topics: TopicData[] = [];
let allWords: WordData[] = [];
let topicIndex = 0;
let target: WordData | null = null;
let options: WordData[] = [];
const wrong = new Set<WordData>(); // pictures already tapped wrong in this round
let solved = false;
let started = false; // the first tap on «Начать» unlocks sound in the browser
let score = load("score", 0);
const learned = new Set(load<string[]>("learned", [])); // words found on the first try at least once
const seen = new Map<string, Set<string>>(); // per topic: words asked since the last full cycle
const alike = new Map<string, Set<string>>(); // word -> words with a look-alike picture

const random = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const learnedIn = (topic: TopicData) => topic.words.filter((w) => learned.has(w.word)).length;
const looksAlike = (a: WordData, b: WordData) => alike.get(a.word)?.has(b.word) ?? false;

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Words in rotation: no repeats until the whole topic has been asked; new words come up more often. */
function pickTarget(): WordData {
  const topic = topics[topicIndex]!;
  const recent = seen.get(topic.key) ?? new Set<string>();
  seen.set(topic.key, recent);
  let fresh = topic.words.filter((w) => !recent.has(w.word) && w !== target);
  if (!fresh.length) {
    recent.clear();
    fresh = topic.words.filter((w) => w !== target);
  }
  if (!fresh.length) fresh = topic.words;
  const unlearned = fresh.filter((w) => !learned.has(w.word));
  const next = random(unlearned.length && Math.random() < NEW_WORD_CHANCE ? unlearned : fresh);
  recent.add(next.word);
  return next;
}

/** The right picture plus three from the same topic that don't look like it or like each other. */
function pickOptions(right: WordData): WordData[] {
  const chosen = [right];
  const add = (pool: WordData[]) => {
    for (const w of shuffle(pool)) {
      if (chosen.length === OPTIONS) return;
      if (!chosen.includes(w) && !chosen.some((c) => looksAlike(c, w))) chosen.push(w);
    }
  };
  add(topics[topicIndex]!.words);
  add(allWords); // a small topic may run out of different-looking pictures
  return shuffle(chosen);
}

function newRound() {
  target = pickTarget();
  options = pickOptions(target);
  wrong.clear();
  solved = false;
  render();
  if (started) say(target);
}

function setTopic(index: number) {
  topicIndex = index;
  save("topic", topics[index]!.key);
  newRound();
}

// ---------- Sound ----------

// One shared element: iOS lets it play by itself once it has played after a tap
const voice = new Audio();
let finishCurrent: ((completed: boolean) => void) | null = null;

/** Plays a file; resolves to false if another sound interrupted it. */
function play(url: string): Promise<boolean> {
  finishCurrent?.(false);
  return new Promise((resolve) => {
    let guard = 0;
    const finish = (completed: boolean) => {
      clearTimeout(guard);
      voice.onended = voice.onerror = null;
      finishCurrent = null;
      resolve(completed);
    };
    guard = setTimeout(() => finish(true), MAX_SOUND_MS);
    finishCurrent = finish;
    voice.onended = voice.onerror = () => finish(true);
    voice.src = url;
    voice.play().catch(() => finish(true));
  });
}

const say = (w: WordData) => play(audioUrl(w));

async function choose(w: WordData) {
  const round = target;
  if (!started || solved || !round || wrong.has(w)) return;

  if (w !== round) {
    // Name the picture that was tapped, then repeat the word to look for
    wrong.add(w);
    chime(false);
    render();
    if ((await say(w)) && target === round && !solved) {
      await sleep(350);
      if (target === round && !solved) say(round);
    }
    return;
  }

  solved = true;
  const firstTry = wrong.size === 0;
  const firstTime = firstTry && !learned.has(w.word);
  if (firstTry) {
    score++;
    save("score", score);
    learned.add(w.word);
    save("learned", [...learned]);
    bump($("score"));
    confetti();
  }
  chime(true);
  render();
  await say(w);
  await sleep(NEXT_DELAY_MS);
  if (target !== round) return; // the topic was changed meanwhile
  const topic = topics[topicIndex]!;
  if (firstTime && learnedIn(topic) === topic.words.length) showTopicDone();
  else newRound();
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
    gain.gain.exponentialRampToValueAtTime(ok ? 0.2 : 0.1, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (ok ? 0.35 : 0.3));
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

function confetti() {
  const layer = $("confetti");
  for (let i = 0; i < 24; i++) {
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

// ---------- Dialogs: start and "topic done" ----------

function showDialog(icon: string, title: string, text: string, button: string, onClick: () => void) {
  $("overlay-icon").textContent = icon;
  $("overlay-title").textContent = title;
  $("overlay-text").textContent = text;
  $("overlay-btn").textContent = button;
  $("overlay-btn").onclick = () => {
    $("overlay").hidden = true;
    onClick();
  };
  $("overlay").hidden = false;
  $("overlay-btn").focus();
}

function showTopicDone() {
  const topic = topics[topicIndex]!;
  showDialog(topic.icon, `Тема «${topic.name}» пройдена!`,
    `Все картинки найдены с первого раза — целых ${topic.words.length}. Молодец!`, "Дальше →",
    () => setTopic((topicIndex + 1) % topics.length));
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

function renderCards() {
  const box = $("cards");
  box.replaceChildren();
  options.forEach((w, i) => {
    const right = solved && w === target;
    const btn = document.createElement("button");
    btn.className = "option" + (wrong.has(w) ? " wrong" : "") + (right ? " right" : "") + (solved && !right ? " dim" : "");
    btn.title = `${i + 1}`;
    btn.disabled = !started || solved || wrong.has(w);
    // The word is revealed only after a tap: the child has to listen, not read
    const label = right ? `<b lang="en">${w.word}</b> — ${w.ru}` : wrong.has(w) ? `<b lang="en">${w.word}</b>` : "";
    btn.innerHTML = `<img src="${imageUrl(w)}" alt=""><span class="option-label">${label}</span>`;
    btn.onclick = () => choose(w);
    box.append(btn);
  });
}

function renderMessage() {
  const msg = $("message");
  msg.className = solved ? "ok" : wrong.size ? "miss" : "";
  msg.textContent = solved
    ? wrong.size ? "Правильно!" : random(["Правильно! +1", "Ура! +1", "Отлично! +1", "Здорово! +1", "Супер! +1"])
    : wrong.size ? "Не то. Послушай ещё раз!" : "Какая это картинка?";
  $<HTMLButtonElement>("listen").disabled = !started;
}

function render() {
  renderTopics();
  renderCards();
  renderMessage();
}

// ---------- Startup ----------

function main() {
  if (typeof GAME_DATA === "undefined") {
    $("message").textContent = "Нет data.js — соберите игру: npm run build";
    return;
  }
  mediaBase = findMediaBase(GAME_DATA.source);
  for (const group of GAME_DATA.similar) {
    for (const word of group) {
      const set = alike.get(word) ?? new Set<string>();
      group.forEach((other) => other !== word && set.add(other));
      alike.set(word, set);
    }
  }
  topics = [...GAME_DATA.topics];
  allWords = topics.flatMap((t) => t.words);
  topics.push({ key: "mix", icon: "🎲", name: "Вперемешку", words: allWords });
  topicIndex = Math.max(0, topics.findIndex((t) => t.key === load("topic", "")));

  $("listen").onclick = () => target && say(target);
  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (!$("overlay").hidden) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        $("overlay-btn").click();
      }
      return;
    }
    if (e.key === " ") {
      e.preventDefault(); // not a click on the focused button
      if (started && target) say(target);
    }
    const option = options[Number(e.key) - 1];
    if (option) choose(option);
  });

  newRound();
  showDialog("👂", "Найди картинку", "Послушай слово по-английски и нажми на картинку, которая подходит.", "Начать ▶", () => {
    started = true;
    render();
    if (target) say(target);
  });
}

main();
