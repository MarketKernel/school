// Arithmetic drill: an example like «3 + 4 = ?» written in notebook cells, four answers below and a few
// seconds to pick one — too little to reach for a calculator. Counts right answers and the average time.
// Levels go from easy to hard; a round asks every example of the level once (or `count` of them), and the best
// result of each level is kept in the browser as stars.
// One engine serves several lessons: each lesson's drill.json picks the operation and the levels (build_scripts/build.mjs);
// a mixed drill has several operations in one level, and in equations x stands for the first or the second number.
// Numbers may be fractions: they are written the school way, numerator above the bar and denominator below.

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
    groups: { op: Op; examples: [Raw, Raw, Raw, (0 | 1)?][] }[];
  }[];
};

type Op = "add" | "sub" | "mul" | "div";
type Raw = number | string; // a number in data.js: 7 or "7/6"
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
  a: Num;
  b: Num;
  c: Num;
  hide: Slot; // the number to find: c in «3 + 4 = ?», a in «x + 4 = 7»
  answer: Num; // the hidden number
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

// ---------- Numbers and fractions ----------

/** A reduced fraction n/d with d > 0; a whole number has d = 1. */
interface Num {
  n: number;
  d: number;
}

const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : Math.abs(x));

/** n/d reduced; d = 0 gives an invalid number that `valid` filters out. */
function frac(n: number, d: number): Num {
  const g = gcd(n, d) || 1;
  return d < 0 ? { n: -n / g, d: -d / g } : { n: n / g, d: d / g };
}

const whole = (n: number): Num => ({ n, d: 1 });
const parse = (raw: Raw): Num => (typeof raw === "number" ? whole(raw) : frac(Number(raw.split("/")[0]), Number(raw.split("/")[1])));
const same = (x: Num, y: Num) => x.n === y.n && x.d === y.d;
const value = (x: Num) => x.n / x.d;
const show = (x: Num) => (x.d === 1 ? String(x.n) : `${x.n}/${x.d}`);
const sum = (x: Num, y: Num) => frac(x.n * y.d + y.n * x.d, x.d * y.d);
const diff = (x: Num, y: Num) => frac(x.n * y.d - y.n * x.d, x.d * y.d);
const product = (x: Num, y: Num) => frac(x.n * y.n, x.d * y.d);
const quotient = (x: Num, y: Num) => frac(x.n * y.d, x.d * y.n);

// ---------- Wrong answers ----------

/** Wrong answers that look plausible: close numbers and typical slips. */
function wrongAnswers(e: Example): Num[] {
  return [e.a, e.b, e.c].every((x) => x.d === 1) ? wholeWrongAnswers(e).map(whole) : fractionWrongAnswers(e);
}

/** Whole numbers: close ones, the neighbour in the table, the other operation. */
function wholeWrongAnswers(e: Example): number[] {
  const { op, hide } = e;
  const [a, b, c, answer] = [e.a.n, e.b.n, e.c.n, e.answer.n];
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

/** Fractions: the classic mistakes — numerators and denominators added separately, the wrong fraction flipped… */
function fractionWrongAnswers({ op, a, b, c, hide, answer }: Example): Num[] {
  const other = hide === "a" ? b : a; // the visible number next to x
  const slips =
    // Equations: a visible number copied, or the inverse done with the wrong operation
    hide !== "c" ? [c, other, sum(c, other), diff(c, other), product(c, other), quotient(c, other)] :
    op === "add" ? [frac(a.n + b.n, a.d + b.d), frac(a.n + b.n, a.d * b.d), frac(a.n + b.n, Math.max(a.d, b.d))] :
    op === "sub" ? [frac(a.n - b.n, a.d - b.d), frac(a.n - b.n, a.d * b.d), sum(a, b)] :
    op === "mul" ? [frac(a.n * b.n, a.d + b.d), quotient(a, b), frac(a.n + b.n, a.d * b.d)] :
    [product(a, b), quotient(b, a)];
  const near = [frac(answer.n + 1, answer.d), frac(answer.n - 1, answer.d), frac(answer.n, answer.d + 1), frac(answer.n, answer.d - 1)];
  // Positive, not the answer, and no bigger than the numbers the drill has
  const valid = (x: Num) => x.d > 0 && x.n > 0 && x.n <= maxPart && x.d <= maxPart && !same(x, answer);
  const unique = new Map([...slips, ...near].filter(valid).map((x) => [show(x), x]));
  const picked = shuffle([...unique.values()]).slice(0, CHOICES - 1);
  // Too few — fill up with answers of other examples
  for (let tries = 0; picked.length < CHOICES - 1 && tries < 200; tries++) {
    const x = random(answerPool);
    if (!same(x, answer) && !picked.some((p) => same(p, x))) picked.push(x);
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
let maxPart = 0; // the largest numerator or denominator in the drill — wrong fractions stay within it
let answerPool: Num[] = []; // every distinct answer, a fallback for wrong ones
let tall = false; // the drill has fractions: the paper gets a row for the denominators
const boxWidth: Record<Slot, number> = { a: 1, b: 1, c: 1 }; // cells for the box of a hidden number
const maxAnswers: Partial<Record<Op, number>> = {}; // the largest answer of each operation
let cols = 0; // notebook cells across the paper

let phase: "start" | "ask" | "show" | "done" = "start";
let example: Example = { op: "add", a: whole(0), b: whole(0), c: whole(0), hide: "c", answer: whole(0) };
let options: Num[] = [];
let picked: Num | null = null; // the chosen answer; null after a timeout
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
const isRight = () => picked !== null && same(picked, example.answer);
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
  options = [example.answer, ...wrongAnswers(example)].sort((x, y) => value(x) - value(y));
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

function choose(answer: Num | null) {
  if (phase !== "ask") return;
  cancelAnimationFrame(frame);
  picked = answer;
  const ok = isRight();
  if (ok) {
    right++;
    times.push(elapsed() / 1000);
    if (right % 5 === 0) confetti(8);
  } else {
    wrong++;
  }
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

/** A number as it is written: whole numbers as text, fractions stacked — numerator, bar, denominator. */
function numberNode(x: Num): HTMLElement {
  if (x.d === 1) return el("span", "", String(x.n));
  const node = el("span", "frac");
  node.append(el("span", "", String(x.n)), el("span", "", String(x.d)));
  return node;
}

/** Cells taken by a number: its longest line of digits. */
const width = (x: Num) => Math.max(digits(x.n), x.d === 1 ? 0 : digits(x.d));

/** A cell of the paper: one row, or two in a drill with fractions — signs then sit on the grid line, like the bar. */
function cell(content: string | HTMLElement, col: number, span = 1, cls = "") {
  const node = el("span", `cell ${cls}`.trim());
  node.append(content);
  node.style.gridColumn = `${col} / span ${span}`;
  node.style.gridRow = tall ? "2 / span 2" : "2";
  return node;
}

/** The parts of «a ○ b = c» and the cells each one takes: the hidden number gets a box as wide as its widest value. */
function layout(e: Example): { num: Num | null; text: string; slot: Slot | null; span: number }[] {
  const parts: [Num | null, string, Slot | null][] = [
    [e.a, "", "a"], [null, SIGNS[e.op], null], [e.b, "", "b"], [null, "=", null], [e.c, "", "c"],
  ];
  return parts.map(([num, text, slot]) => ({
    num,
    text,
    slot,
    span: slot && slot === e.hide ? boxWidth[slot] : num ? width(num) : 1,
  }));
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
  const result = isRight() ? "ok" : "bad";
  paper.replaceChildren(
    ...parts.map(({ num, text, slot, span }) => {
      const blank = phase === "start";
      let node: HTMLElement;
      if (slot && slot === example.hide) {
        // The box shows x while an equation waits for the answer, then the answer itself
        const x = phase === "ask" && slot !== "c";
        node = cell(shown ? numberNode(num!) : x ? "x" : "", col, span, `answer ${shown ? result : x ? "unknown" : ""}`);
      } else {
        node = cell(blank ? "" : num ? numberNode(num) : text, col, span);
      }
      col += span;
      return node;
    }),
  );
  const said = parts.map(({ num, text, slot }) =>
    slot === example.hide ? (slot === "c" ? "" : "икс") : num ? show(num) : text === "=" ? "равно" : text,
  );
  paper.setAttribute("aria-label", phase === "start" ? "" : said.join(" "));
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
      const btn = el("button", "option");
      btn.append(numberNode(n));
      btn.setAttribute("aria-label", show(n));
      btn.disabled = phase !== "ask";
      if (phase !== "ask") {
        if (same(n, example.answer)) btn.classList.add("ok");
        else if (picked && same(n, picked)) btn.classList.add("bad");
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
  const { op, a, b, c } = example;
  const full = `${show(a)} ${SIGNS[op]} ${show(b)} = ${show(c)}`;
  const n = roundSize();
  const s = GAME_DATA.seconds;
  msg.className = phase === "start" ? "info" : isRight() ? "ok" : "bad";
  msg.textContent =
    phase === "start" ? `${GAME_DATA.levels[level]!.hint}: ${n} ${plural(n, ["пример", "примера", "примеров"])}, ` +
      `на каждый — ${s} ${plural(s, ["секунда", "секунды", "секунд"])}` :
    phase === "ask" ? "" :
    isRight() ? random(PRAISE) :
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
      examples.map(([ra, rb, rc, h]) => {
        const [a, b, c] = [parse(ra), parse(rb), parse(rc)];
        const hide: Slot = h === 0 ? "a" : h === 1 ? "b" : "c";
        return { op, a, b, c, hide, answer: hide === "a" ? a : hide === "b" ? b : c };
      }),
    ),
  );
  const all = levels.flat(2);
  const numbers = all.flatMap((e) => [e.a, e.b, e.c]);
  tall = numbers.some((x) => x.d !== 1);
  maxPart = Math.max(...numbers.map((x) => Math.max(x.n, x.d)));
  answerPool = [...new Map(all.map((e) => [show(e.answer), e.answer])).values()];
  maxAnswer = Math.max(...all.map((e) => value(e.answer)));
  for (const e of all) {
    maxAnswers[e.op] = Math.max(maxAnswers[e.op] ?? 0, value(e.answer));
    boxWidth[e.hide] = Math.max(boxWidth[e.hide], width(e.answer));
  }
  // The widest example + a margin cell on each side
  cols = Math.max(...all.map((e) => layout(e).reduce((n, p) => n + p.span, 0))) + 2;
  // Before the first round the paper shows just the box, where it will be
  const first = all[0]!;
  const hide: Slot = all.some((e) => e.hide !== "c") ? "a" : "c";
  example = { ...first, hide, answer: first[hide] };
  document.body.style.setProperty("--cols", String(cols)); // sizes the paper and the timer under it
  document.body.style.setProperty("--rows", tall ? "4" : "3");

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
