// Arithmetic drill: an example like «3 + 4 = ?» written in notebook cells, four answers below and a few
// seconds to pick one — too little to reach for a calculator. Counts right answers and the average time.
// One engine serves several lessons: each lesson's drill.json picks the operation (build_scripts/build.mjs).

// The build puts the lesson title and drill.json into data.js
declare const GAME_DATA: {
  title: string;
  icon: string;
  op: Op;
  from: number;
  to: number;
  seconds: number;
  count: number;
};

type Op = "add" | "sub" | "mul" | "div";

const CHOICES = 4; // answer buttons: one right, the rest wrong
const PAUSE_OK = 700; // ms a right answer stays on screen before the next example
const PAUSE_BAD = 1800; // ms the right answer is shown after a mistake or a timeout
const HURRY = 0.33; // share of time left when the timer turns red

const SIGNS: Record<Op, string> = { add: "+", sub: "−", mul: "×", div: "÷" };
const PRAISE = ["Верно!", "Молодец!", "Здорово!", "Точно!", "Отлично!"];

// ---------- Examples ----------

interface Example {
  a: number;
  b: number;
  answer: number;
}

const solve = (op: Op, x: number, y: number): Example | null => {
  switch (op) {
    case "add": return { a: x, b: y, answer: x + y };
    case "sub": return { a: x + y, b: y, answer: x }; // addition read backwards — never negative
    case "mul": return { a: x, b: y, answer: x * y };
    case "div": return y === 0 ? null : { a: x * y, b: y, answer: x }; // multiplication backwards — always whole
  }
};

/** Every example of the drill: x and y run over [from, to]. */
function allExamples(): Example[] {
  const list: Example[] = [];
  for (let x = GAME_DATA.from; x <= GAME_DATA.to; x++) {
    for (let y = GAME_DATA.from; y <= GAME_DATA.to; y++) {
      const e = solve(GAME_DATA.op, x, y);
      if (e) list.push(e);
    }
  }
  return list;
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

/** Wrong answers that look plausible: close numbers and typical slips (the neighbour in the table, the other operation). */
function wrongAnswers({ a, b, answer }: Example): number[] {
  const near = [1, 2, 3].flatMap((d) => [answer - d, answer + d]);
  const slips =
    GAME_DATA.op === "sub" ? [a + b] :
    GAME_DATA.op === "mul" ? [a * (b + 1), a * (b - 1), (a + 1) * b, (a - 1) * b, a + b] :
    GAME_DATA.op === "div" ? [b] :
    [];
  const fits = (n: number) => n >= 0 && n <= maxAnswer && n !== answer;
  const need = Math.min(CHOICES, maxAnswer + 1) - 1; // a tiny range may not have enough numbers
  const picked = shuffle([...new Set([...slips, ...near].filter(fits))]).slice(0, need);
  // Too few plausible ones — fill up with any numbers
  while (picked.length < need) {
    const n = Math.floor(Math.random() * (maxAnswer + 1));
    if (n !== answer && !picked.includes(n)) picked.push(n);
  }
  return picked;
}

// ---------- Game state ----------

let examples: Example[] = [];
let deck: Example[] = []; // examples don't repeat until all have been asked
let maxAnswer = 0;
let cols = 0; // notebook cells across the paper

let phase: "start" | "ask" | "show" | "done" = "start";
let example: Example = { a: 0, b: 0, answer: 0 };
let options: number[] = [];
let picked: number | null = null; // the chosen answer; null after a timeout
let asked = 0; // examples shown in this round
let right = 0;
let wrong = 0;
let times: number[] = []; // seconds spent on each right answer

let shownAt = 0; // performance.now() when the example appeared, shifted forward while the page is hidden
let hiddenAt = 0;
let frame = 0;

const elapsed = () => performance.now() - shownAt;
const average = () => (times.length ? times.reduce((s, t) => s + t, 0) / times.length : null);
const formatSeconds = (s: number) => `${s.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с`;

/** Russian plural: plural(3, ["секунда", "секунды", "секунд"]) → «секунды». */
function plural(n: number, forms: [string, string, string]): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return forms[0];
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return forms[1];
  return forms[2];
}

function startRound() {
  asked = right = wrong = 0;
  times = [];
  $("overlay").hidden = true;
  nextExample();
}

function nextExample() {
  if (asked === GAME_DATA.count) return finishRound();
  if (!deck.length) {
    deck = shuffle(examples);
    // The first card of a new deck must not repeat the last one asked
    if (deck.length > 1 && deck[deck.length - 1] === example) deck.reverse();
  }
  example = deck.pop()!;
  options = [example.answer, ...wrongAnswers(example)].sort((x, y) => x - y);
  picked = null;
  asked++;
  phase = "ask";
  shownAt = performance.now();
  render();
  frame = requestAnimationFrame(tick);
}

/** Runs every frame while waiting for an answer: drains the timer and ends the example when time is up. */
function tick() {
  if (phase !== "ask") return;
  const left = 1 - elapsed() / (GAME_DATA.seconds * 1000);
  renderTimer(left);
  if (left <= 0) choose(null);
  else frame = requestAnimationFrame(tick);
}

function choose(value: number | null) {
  if (phase !== "ask") return;
  cancelAnimationFrame(frame);
  const ok = value === example.answer;
  if (ok) {
    right++;
    times.push(elapsed() / 1000);
    if (right % 5 === 0) confetti(8);
  } else {
    wrong++;
  }
  picked = value;
  phase = "show";
  chime(ok);
  render();
  setTimeout(nextExample, ok ? PAUSE_OK : PAUSE_BAD);
}

/** The timer pauses while the page is hidden (another tab, a locked phone) — that time doesn't count. */
function onVisibility() {
  if (phase !== "ask") return;
  if (document.hidden) {
    hiddenAt = performance.now();
    cancelAnimationFrame(frame);
  } else {
    shownAt += performance.now() - hiddenAt;
    frame = requestAnimationFrame(tick);
  }
}

// ---------- Effects: right/wrong chime and confetti ----------

let effects: AudioContext | null = null;

/** A short synthesized tune — no extra sound files needed. */
function chime(ok: boolean) {
  effects ??= new AudioContext();
  const ctx = effects;
  const notes = ok ? [659, 784, 1047] : [330, 262]; // E-G-C / E-C
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime + i * (ok ? 0.07 : 0.18);
    osc.type = ok ? "triangle" : "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

function confetti(amount = 28) {
  const layer = $("confetti");
  for (let i = 0; i < amount; i++) {
    const bit = document.createElement("span");
    bit.textContent = random(["⭐", "✨", "🎉", "🌟", GAME_DATA.icon]);
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.animationDelay = `${Math.random() * 0.3}s`;
    bit.style.fontSize = `${20 + Math.random() * 22}px`;
    bit.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    layer.append(bit);
    setTimeout(() => bit.remove(), 2200);
  }
}

// ---------- Start and results dialogs ----------

function showDialog(icon: string, title: string, text: string, button: string) {
  $("overlay-icon").textContent = icon;
  $("overlay-title").textContent = title;
  $("overlay-text").textContent = text;
  $("overlay-btn").textContent = button;
  $("overlay").hidden = false;
}

function showStart() {
  const { count, seconds } = GAME_DATA;
  showDialog(
    GAME_DATA.icon,
    GAME_DATA.title,
    `${count} ${plural(count, ["пример", "примера", "примеров"])}, на каждый — ` +
      `${seconds} ${plural(seconds, ["секунда", "секунды", "секунд"])}. Нажимай на правильный ответ!`,
    "Начать",
  );
}

function finishRound() {
  phase = "done";
  render();
  const share = right / GAME_DATA.count;
  const [icon, title] =
    share >= 0.9 ? ["🏆", "Отлично!"] :
    share >= 0.7 ? ["⭐", "Молодец!"] :
    share >= 0.5 ? ["👍", "Хорошо!"] :
    ["💪", "Тренируемся дальше!"];
  const avg = average();
  showDialog(
    icon,
    title,
    `Верно: ${right} из ${GAME_DATA.count}.` + (avg === null ? "" : ` Среднее время ответа: ${formatSeconds(avg)}.`),
    "Ещё раз",
  );
  if (share >= 0.7) confetti();
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const digits = (n: number) => String(n).length;

function cell(text: string, col: number, span = 1, cls = "") {
  const el = document.createElement("span");
  el.className = `cell ${cls}`.trim();
  el.textContent = text;
  el.style.gridColumn = `${col} / span ${span}`;
  return el;
}

/**
 * The example in notebook cells: a cell per digit or sign, but a number's digits stay together so «11» doesn't
 * read as «1 1». Right-aligned so the answer box never moves.
 */
function renderPaper() {
  const paper = $("paper");
  const box = digits(maxAnswer);
  const { a, b, answer } = example;
  const parts = [String(a), SIGNS[GAME_DATA.op], String(b), "="];
  let col = cols - box - parts.join("").length; // one empty cell of margin on the right
  const ask = phase === "ask" || phase === "start";
  const result = picked === answer ? "ok" : "bad";
  paper.replaceChildren(
    ...parts.map((text) => {
      const el = cell(phase === "start" ? "" : text, col, text.length);
      col += text.length;
      return el;
    }),
    cell(ask ? "" : String(answer), cols - box, box, `answer ${ask ? "" : result}`),
  );
  paper.setAttribute("aria-label", phase === "start" ? "" : `${a} ${SIGNS[GAME_DATA.op]} ${b} равно`);
}

function renderTimer(left: number) {
  const fill = $("timer-fill");
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, left))})`;
  fill.classList.toggle("hurry", left < HURRY);
}

function renderOptions() {
  $("options").replaceChildren(
    ...options.map((n) => {
      const btn = document.createElement("button");
      btn.className = "option";
      btn.textContent = String(n);
      btn.disabled = phase !== "ask";
      if (phase === "show") {
        if (n === example.answer) btn.classList.add("ok");
        else if (n === picked) btn.classList.add("bad");
        else btn.classList.add("dim");
      }
      btn.onclick = () => choose(n);
      return btn;
    }),
  );
}

function renderScore() {
  $("progress").textContent = `${asked} / ${GAME_DATA.count}`;
  $("right").textContent = String(right);
  $("wrong").textContent = String(wrong);
  const avg = average();
  $("avg").textContent = avg === null ? "—" : formatSeconds(avg);
}

function renderMessage() {
  const msg = $("message");
  const { a, b, answer } = example;
  const full = `${a} ${SIGNS[GAME_DATA.op]} ${b} = ${answer}`;
  msg.className = phase === "show" ? (picked === answer ? "ok" : "bad") : "";
  msg.textContent =
    phase !== "show" ? "" :
    picked === answer ? random(PRAISE) :
    picked === null ? `⌛ Время вышло: ${full}` :
    `Запомни: ${full}`;
}

function render() {
  renderScore();
  renderPaper();
  renderOptions();
  renderMessage();
  if (phase === "start") renderTimer(1); // after an answer the timer stays where it stopped
}

// ---------- Startup ----------

function main() {
  if (typeof GAME_DATA === "undefined") {
    $("message").textContent = "Нет data.js — соберите урок (см. README.md)";
    return;
  }
  document.body.dataset.op = GAME_DATA.op;
  examples = allExamples();
  maxAnswer = Math.max(...examples.map((e) => e.answer));
  // Widest example + the answer box + a margin cell on each side
  const widest = Math.max(...examples.map((e) => digits(e.a) + digits(e.b))) + 2;
  cols = widest + digits(maxAnswer) + 2;
  document.body.style.setProperty("--cols", String(cols)); // sizes the paper and the timer under it

  $("overlay-btn").onclick = startRound;
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", (e) => {
    // A focused button handles Enter and Space by itself
    if (!$("overlay").hidden && document.activeElement !== $("overlay-btn") && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      $("overlay-btn").click();
    }
  });

  render();
  showStart();
}

main();
