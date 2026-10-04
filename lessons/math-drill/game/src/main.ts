// Arithmetic drill: an example like «3 + 4 = ?» written in notebook cells, four answers below and a few
// seconds to pick one — too little to reach for a calculator. Counts right answers and the average time.
// Levels go from easy to hard; a round asks every example of the level once (or `count` of them), and the best
// result of each level is kept in the browser as stars.
// One engine serves several lessons: each lesson's drill.json picks the operation and the levels (build_scripts/build.mjs);
// a mixed drill has several operations in one level, and in equations x stands for the first or the second number.

// The build puts the lesson title, settings and examples sorted into levels into data.js
declare const GAME_DATA: {
  slug: string; // lesson folder name
  title: string;
  icon: string;
  op: Op | "mix" | "eq"; // picks the page colour
  seconds: number;
  count: number | null; // examples in a round; null — all examples of the level
  levels: {
    name: string;
    hint: string;
    // One group per operation; an example is [a, b, c] for «a ○ b = c», plus 0 or 1 when x hides a or b
    groups: { op: Op; examples: [number, number, number, (0 | 1)?][] }[];
  }[];
};

type Op = "add" | "sub" | "mul" | "div";
type Slot = "a" | "b" | "c"; // a ○ b = c

const CHOICES = 4; // answer buttons: one right, the rest wrong
const PAUSE_OK = 700; // ms a right answer stays on screen before the next example
const PAUSE_BAD = 1800; // ms the right answer is shown after a mistake or a timeout
const HURRY = 0.33; // share of time left when the timer turns red
const STARS = [0.5, 0.7, 0.9]; // share of right answers for one, two and three stars
const NEXT_LEVEL_STARS = 2; // from this many stars the results dialog suggests the next level

const SIGNS: Record<Op, string> = { add: "+", sub: "−", mul: "×", div: "÷" };
const PRAISE = ["Верно!", "Молодец!", "Здорово!", "Точно!", "Отлично!"];

interface Example {
  op: Op;
  a: number;
  b: number;
  c: number;
  hide: Slot; // the number to find: c in «3 + 4 = ?», a in «x + 4 = 7»
  answer: number; // the hidden number
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
function wrongAnswers({ op, a, b, c, hide, answer }: Example): number[] {
  const near = [1, 2, 3].flatMap((d) => [answer - d, answer + d]);
  const other = hide === "a" ? b : a; // the visible number next to x
  const slips =
    hide !== "c" ? [
      // Equations: a visible number copied, or the inverse done the wrong way (adding instead of subtracting…)
      c,
      other,
      op === "add" ? c + other :
      op === "sub" ? (hide === "a" ? c - b : a + c) :
      op === "mul" ? c - other :
      hide === "a" ? c + b : a - c,
    ] :
    op === "sub" ? [a + b] :
    op === "mul" ? [a * (b + 1), a * (b - 1), (a + 1) * b, (a - 1) * b, a + b] :
    op === "div" ? [b] :
    [];
  const max = maxAnswers[op] ?? maxAnswer; // the largest answer this operation can have
  const fits = (n: number) => n >= 0 && n <= max && n !== answer;
  const need = Math.min(CHOICES, max + 1) - 1; // a tiny range may not have enough numbers
  const picked = shuffle([...new Set([...slips, ...near].filter(fits))]).slice(0, need);
  // Too few plausible ones — fill up with any numbers
  while (picked.length < need) {
    const n = Math.floor(Math.random() * (max + 1));
    if (n !== answer && !picked.includes(n)) picked.push(n);
  }
  return picked;
}

// ---------- Best results, kept in the browser ----------

interface Best {
  right: number;
  total: number;
  avg: number | null; // seconds per right answer
}

const bestKey = (i: number) => `math-drill:${GAME_DATA.slug}:${GAME_DATA.levels[i]!.name}`;
const starsFor = (r: Best) => STARS.filter((s) => r.right / r.total >= s).length;

// Storage can be missing or blocked (private mode, some file:// setups) — the drill works without it, just forgets
function loadBest(i: number): Best | null {
  try {
    const raw = localStorage.getItem(bestKey(i));
    return raw ? (JSON.parse(raw) as Best) : null;
  } catch {
    return null;
  }
}

/** Saves the result if it beats the best one: more right answers, or as many but faster. */
function saveBest(i: number, result: Best): boolean {
  const old = loadBest(i);
  const share = result.right / result.total;
  const oldShare = old ? old.right / old.total : -1;
  const faster = result.avg !== null && (old?.avg == null || result.avg < old.avg);
  if (old && (share < oldShare || (share === oldShare && !faster))) return false;
  try {
    localStorage.setItem(bestKey(i), JSON.stringify(result));
  } catch {
    // not saved — fine
  }
  return true;
}

// ---------- Game state ----------

let levels: Example[][][] = []; // level → operation → examples
let level = 0;
let queue: Example[] = []; // examples left in this round
let maxAnswer = 0;
const boxWidth: Record<Slot, number> = { a: 1, b: 1, c: 1 }; // cells for the box of a hidden number
const maxAnswers: Partial<Record<Op, number>> = {}; // the largest answer of each operation
let cols = 0; // notebook cells across the paper

let phase: "start" | "ask" | "show" | "done" = "start";
let example: Example = { op: "add", a: 0, b: 0, c: 0, hide: "c", answer: 0 };
let options: number[] = [];
let picked: number | null = null; // the chosen answer; null after a timeout
let asked = 0; // examples shown in this round
let right = 0;
let wrong = 0;
let times: number[] = []; // seconds spent on each right answer

let shownAt = 0; // performance.now() when the example appeared, shifted forward while the page is hidden
let hiddenAt = 0;
let frame = 0;
let pending = 0; // timeout that brings the next example

const levelSize = (i: number) => levels[i]!.reduce((n, group) => n + group.length, 0);
const roundSize = () => Math.min(GAME_DATA.count ?? Infinity, levelSize(level));
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

function resetScore() {
  asked = right = wrong = 0;
  times = [];
}

function stopRound() {
  cancelAnimationFrame(frame);
  clearTimeout(pending);
}

/** Picks a level and waits for «Начать»; a round in progress is dropped. */
function setLevel(i: number) {
  stopRound();
  level = i;
  phase = "start";
  resetScore();
  $("overlay").hidden = true;
  render();
}

/** Every example of the level, or `count` of them taken evenly from each operation. */
function pickRound(): Example[] {
  const groups = levels[level]!;
  if (GAME_DATA.count === null) return shuffle(groups.flat());
  const decks = groups.map(shuffle);
  const round: Example[] = [];
  for (let i = 0; round.length < roundSize(); i++) {
    const next = decks[i % decks.length]!.pop();
    if (next) round.push(next);
  }
  return shuffle(round);
}

function startRound() {
  stopRound();
  resetScore();
  queue = pickRound();
  $("overlay").hidden = true;
  nextExample();
}

function nextExample() {
  const next = queue.pop();
  if (!next) return finishRound();
  example = next;
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
  pending = setTimeout(nextExample, ok ? PAUSE_OK : PAUSE_BAD);
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

// ---------- Results dialog ----------

const RESULTS: [string, string][] = [
  ["💪", "Тренируемся дальше!"], // by stars: 0…3
  ["👍", "Хорошо!"],
  ["⭐", "Молодец!"],
  ["🏆", "Отлично!"],
];

function finishRound() {
  phase = "done";
  const avg = average();
  const result: Best = { right, total: roundSize(), avg };
  const hadBest = loadBest(level) !== null;
  const record = saveBest(level, result) && hadBest;
  const stars = starsFor(result);
  render();

  const [icon, title] = RESULTS[stars]!;
  $("overlay-icon").textContent = icon;
  $("overlay-title").textContent = title;
  $("overlay-stars").replaceChildren(...starIcons(stars));
  $("overlay-text").textContent =
    `Верно: ${right} из ${result.total}.` +
    (avg === null ? "" : ` Среднее время ответа: ${formatSeconds(avg)}.`) +
    (record ? " Новый рекорд!" : "");

  // A good result suggests the next level; «Ещё раз» is always there
  const next = GAME_DATA.levels[level + 1];
  const primary = $("overlay-btn");
  const again = $("overlay-again");
  if (next && stars >= NEXT_LEVEL_STARS) {
    primary.textContent = `Дальше: ${next.name} →`;
    primary.onclick = () => setLevel(level + 1);
    again.hidden = false;
  } else {
    primary.textContent = "Ещё раз";
    primary.onclick = startRound;
    again.hidden = true;
  }
  $("overlay").hidden = false;
  if (stars >= 2) confetti();
}

// ---------- Rendering ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const digits = (n: number) => String(n).length;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "") {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

/** Three stars, the first `n` of them lit. */
const starIcons = (n: number) => [0, 1, 2].map((i) => el("i", i < n ? "on" : "", "★"));

function renderLevels() {
  $("levels").replaceChildren(
    ...GAME_DATA.levels.map((lvl, i) => {
      const best = loadBest(i);
      const btn = el("button", "level" + (i === level ? " current" : ""));
      btn.title = lvl.hint + (best ? `. Лучший результат: ${best.right} из ${best.total}` : "");
      btn.setAttribute("aria-pressed", String(i === level));
      const stars = el("span", "stars");
      stars.replaceChildren(...starIcons(best ? starsFor(best) : 0));
      btn.append(el("span", "level-num", String(i + 1)), el("span", "level-name", lvl.name), stars);
      btn.onclick = () => setLevel(i);
      return btn;
    }),
  );
}

function cell(text: string, col: number, span = 1, cls = "") {
  const node = el("span", `cell ${cls}`.trim(), text);
  node.style.gridColumn = `${col} / span ${span}`;
  return node;
}

/** The parts of «a ○ b = c» and the cells each one takes: the hidden number gets a box as wide as its widest value. */
function layout(e: Example): { text: string; slot: Slot | null; span: number }[] {
  const parts: [string, Slot | null][] = [[String(e.a), "a"], [SIGNS[e.op], null], [String(e.b), "b"], ["=", null], [String(e.c), "c"]];
  return parts.map(([text, slot]) => ({ text, slot, span: slot && slot === e.hide ? boxWidth[slot] : text.length }));
}

/**
 * The example in notebook cells: a cell per digit or sign, but a number's digits stay together so «11» doesn't
 * read as «1 1». Right-aligned so the answer box of «3 + 4 = ?» never moves.
 */
function renderPaper() {
  const paper = $("paper");
  const parts = layout(example);
  let col = cols - parts.reduce((n, p) => n + p.span, 0); // one empty cell of margin on the right
  const shown = phase === "show" || phase === "done";
  const result = picked === example.answer ? "ok" : "bad";
  paper.replaceChildren(
    ...parts.map(({ text, slot, span }) => {
      const hidden = slot === example.hide;
      // The box shows x while an equation waits for the answer, then the answer itself
      const x = phase === "ask" && slot !== "c";
      const node = hidden
        ? cell(shown ? text : x ? "x" : "", col, span, `answer ${shown ? result : x ? "unknown" : ""}`)
        : cell(phase === "start" ? "" : text, col, span);
      col += span;
      return node;
    }),
  );
  const said = parts.map(({ text, slot }) => (slot === example.hide ? (slot === "c" ? "" : "икс") : text));
  paper.setAttribute("aria-label", phase === "start" ? "" : said.join(" ").replace("=", "равно"));
}

function renderTimer(left: number) {
  const fill = $("timer-fill");
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, left))})`;
  fill.classList.toggle("hurry", left < HURRY);
}

function renderOptions() {
  if (phase === "start") {
    const start = el("button", "btn primary start", "▶ Начать");
    start.onclick = startRound;
    $("options").replaceChildren(start);
    return;
  }
  $("options").replaceChildren(
    ...options.map((n) => {
      const btn = el("button", "option", String(n));
      btn.disabled = phase !== "ask";
      if (phase !== "ask") {
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
  $("progress").textContent = `${asked} / ${roundSize()}`;
  $("right").textContent = String(right);
  $("wrong").textContent = String(wrong);
  const avg = average();
  $("avg").textContent = avg === null ? "—" : formatSeconds(avg);
}

function renderMessage() {
  const msg = $("message");
  const { op, a, b, c, answer } = example;
  const full = `${a} ${SIGNS[op]} ${b} = ${c}`;
  const n = roundSize();
  const s = GAME_DATA.seconds;
  msg.className = phase === "start" ? "info" : picked === answer ? "ok" : "bad";
  msg.textContent =
    phase === "start" ? `${GAME_DATA.levels[level]!.hint}: ${n} ${plural(n, ["пример", "примера", "примеров"])}, ` +
      `на каждый — ${s} ${plural(s, ["секунда", "секунды", "секунд"])}` :
    phase === "ask" ? "" :
    picked === answer ? random(PRAISE) :
    picked === null ? `⌛ Время вышло: ${full}` :
    `Запомни: ${full}`;
}

function render() {
  renderLevels();
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
  levels = GAME_DATA.levels.map((lvl) =>
    lvl.groups.map(({ op, examples }) =>
      examples.map(([a, b, c, h]) => {
        const hide: Slot = h === 0 ? "a" : h === 1 ? "b" : "c";
        return { op, a, b, c, hide, answer: hide === "a" ? a : hide === "b" ? b : c };
      }),
    ),
  );
  const all = levels.flat(2);
  maxAnswer = Math.max(...all.map((e) => e.answer));
  for (const e of all) {
    maxAnswers[e.op] = Math.max(maxAnswers[e.op] ?? 0, e.answer);
    boxWidth[e.hide] = Math.max(boxWidth[e.hide], digits(e.answer));
  }
  // The widest example + a margin cell on each side
  cols = Math.max(...all.map((e) => layout(e).reduce((n, p) => n + p.span, 0))) + 2;
  // Before the first round the paper shows just the box, where it will be
  example = { ...all[0]!, hide: all.some((e) => e.hide !== "c") ? "a" : "c" };
  document.body.style.setProperty("--cols", String(cols)); // sizes the paper and the timer under it

  $("overlay-again").onclick = startRound;
  // A tap outside the results card closes it, back to the level's start
  $("overlay").onclick = (e) => {
    if (e.target === $("overlay")) setLevel(level);
  };
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (document.activeElement instanceof HTMLButtonElement) return; // a focused button handles them itself
    e.preventDefault();
    if (!$("overlay").hidden) $("overlay-btn").click();
    else if (phase === "start") startRound();
  });

  // Start from the first level that isn't mastered yet
  const open = GAME_DATA.levels.findIndex((_, i) => {
    const best = loadBest(i);
    return !best || starsFor(best) < STARS.length;
  });
  setLevel(open < 0 ? 0 : open);
}

main();
