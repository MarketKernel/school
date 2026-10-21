// Mode "assemble": hear an English phrase and put it together from shuffled word cards.
// The Russian translation is shown for the meaning; 💡 puts the next right word in place.

namespace Assemble {
  // idle — building the phrase; miss — all slots filled, but some words are out of place; ok — assembled
  type Phase = "idle" | "miss" | "ok";

  interface Card {
    id: number;
    text: string; // as shown: «it's», «I», «Anna»
  }

  let current: PhraseData | null = null;
  let phase: Phase = "idle";
  let playing = false;
  let hinted = false; // 💡 was used for this phrase: then it doesn't count as learned
  let misses = 0; // wrong full answers on this phrase
  let want: string[] = []; // the right words, as shown
  let cards: Card[] = []; // the bank: the phrase's words plus a few extra ones, shuffled
  let placed: number[] = []; // card ids in the answer line
  let wrong = new Set<number>(); // card ids out of place after a check
  const proper = new Set<string>(); // words that keep their capital letter anywhere: «Anna», «Monday», «English»
  const pool: string[] = []; // every word of every phrase, as shown: extra cards come from here

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const card = (id: number) => cards.find((c) => c.id === id)!;
  const inBank = () => cards.filter((c) => !placed.includes(c.id));

  /** «Ready, steady, go!» → ["Ready", "steady", "go"]: punctuation goes, apostrophes and hyphens stay. */
  const splitWords = (text: string) =>
    text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);

  /** The first word loses its capital letter, so it doesn't give the order away — unless it's «I» or a name. */
  function shown(word: string, index: number): string {
    if (index > 0 || word === "I" || word.startsWith("I'") || proper.has(word.toLowerCase())) return word;
    if (word.length > 1 && word === word.toUpperCase()) return word; // «TV»
    return word[0]!.toLowerCase() + word.slice(1);
  }

  /** Extra cards make a short phrase a real puzzle: two for 2–3 words, one for 4–5, none for longer. */
  function extras(words: string[]): string[] {
    const count = words.length <= 3 ? 2 : words.length <= 5 ? 1 : 0;
    const own = new Set(words.map((w) => w.toLowerCase()));
    const topicWords = currentTopic().items.flatMap((p) => splitWords((p as PhraseData).en).map(shown));
    // A name or «I» among the extras would give itself away by its capital letter
    const pick = (list: string[]) =>
      shuffle([...new Set(list)]).filter((w) => !own.has(w.toLowerCase()) && w[0] === w[0]!.toLowerCase());
    const out: string[] = [];
    for (const w of [...pick(topicWords), ...pick(pool)]) {
      if (out.length === count) break;
      if (!out.some((x) => same(x, w))) out.push(w);
    }
    return out;
  }

  function newRound() {
    stopSounds();
    current = pickItem(current);
    phase = "idle";
    hinted = false;
    misses = 0;
    want = splitWords(current.en).map(shown);
    cards = shuffle([...want, ...extras(want)]).map((text, id) => ({ id, text }));
    placed = [];
    wrong = new Set();
    audioFor(audioUrl(current)).load();
    render();
    if (touched) listen();
  }

  // ---------- Sound ----------

  async function listen() {
    const phrase = current;
    if (!phrase || playing) return;
    playing = true;
    render();
    await play(audioUrl(phrase));
    playing = false;
    render();
  }

  // ---------- Moves ----------

  function place(id: number) {
    if (phase === "ok" || placed.includes(id) || placed.length >= want.length) return;
    placed.push(id);
    wrong.clear();
    phase = "idle";
    if (placed.length === want.length) check();
    else render();
  }

  /** A card in the line goes back to the bank. */
  function takeBack(id: number) {
    if (phase === "ok") return;
    placed = placed.filter((x) => x !== id);
    wrong.delete(id);
    if (!wrong.size) phase = "idle";
    render();
  }

  function check() {
    wrong = new Set(placed.filter((id, i) => !same(card(id).text, want[i]!)));
    if (!wrong.size) {
      success();
      return;
    }
    phase = "miss";
    misses++;
    chime(false);
    render();
  }

  /** 💡: keeps the right beginning, sends the rest back and puts the next right word in place. */
  function hint() {
    if (!current || phase === "ok") return;
    hinted = true;
    let keep = 0;
    while (keep < placed.length && same(card(placed[keep]!).text, want[keep]!)) keep++;
    placed = placed.slice(0, keep);
    wrong.clear();
    phase = "idle";
    const next = inBank().find((c) => same(c.text, want[keep]!));
    if (next) place(next.id);
    else render();
  }

  function success() {
    const phrase = current!;
    phase = "ok";
    const topicDone = scoreItem(phrase, hinted);
    chime(true);
    confetti();
    render();
    setTimeout(() => current === phrase && play(audioUrl(phrase)), 500);
    if (topicDone) {
      const n = currentTopic().items.length;
      setTimeout(() => showTopicDone(`Все фразы собраны без подсказки — целых ${n}. Молодец!`), 1800);
    }
  }

  // ---------- Rendering ----------

  function cardButton(c: Card, onClick: () => void, extra = ""): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "card-word" + extra;
    btn.textContent = c.text;
    btn.lang = "en";
    btn.onclick = onClick;
    return btn;
  }

  function renderBoard() {
    const phrase = current!;
    $("task").textContent = `${currentTopic().icon} Послушай и собери фразу`;
    const question = $("question");
    question.textContent = phrase.ru;
    question.lang = "ru";

    const line = $("line");
    line.replaceChildren();
    line.classList.toggle("ok", phase === "ok");
    want.forEach((_, i) => {
      const id = placed[i];
      if (id === undefined) {
        const slot = document.createElement("span");
        slot.className = "slot";
        line.append(slot);
      } else {
        const c = card(id);
        line.append(cardButton(c, () => takeBack(id), wrong.has(id) ? " wrong" : ""));
      }
    });

    // After the right answer — the phrase as written, with its punctuation
    const answer = $("answer");
    answer.hidden = phase !== "ok";
    answer.textContent = phrase.en;
    answer.lang = "en";
    answer.classList.add("ok");

    const bank = $("bank");
    bank.replaceChildren();
    for (const c of cards) {
      const used = placed.includes(c.id);
      const btn = cardButton(c, () => place(c.id), used ? " used" : "");
      btn.disabled = used || phase === "ok";
      bank.append(btn);
    }
  }

  function renderActions() {
    const listenBtn = $<HTMLButtonElement>("listen");
    listenBtn.classList.toggle("active", playing);
    listenBtn.classList.toggle("hint", !touched && !playing);
    const hintBtn = $<HTMLButtonElement>("hint");
    hintBtn.disabled = phase === "ok";
    hintBtn.classList.toggle("hint", phase === "miss" && misses >= HINT_AFTER_MISSES);
  }

  function message(): string {
    switch (phase) {
      case "ok":
        return hinted
          ? random(["Правильно! +1", "Собрано! +1"]) + " А потом — без подсказки 😉"
          : random(["Правильно! +1", "Ура! Собрал! +1", "Отлично! +1", "Здорово! +1", "Супер! +1"]);
      case "miss":
        return misses >= HINT_AFTER_MISSES
          ? "Не совсем. Убери красные слова или возьми подсказку 💡"
          : "Почти! Красные слова не на месте — нажми на них, чтобы убрать";
      default:
        if (playing) return "Слушай…";
        return touched ? "Нажимай на слова по порядку" : "Нажми 🔊, послушай и собери фразу";
    }
  }

  function render() {
    renderTopics();
    renderBoard();
    renderActions();
    const msg = $("message");
    msg.className = phase === "ok" ? "ok" : phase === "miss" ? "miss" : "";
    msg.textContent = message();
    $("next").classList.toggle("primary", phase === "ok");
    $("next").textContent = phase === "ok" ? "Следующая фраза →" : "Другая фраза";
  }

  // ---------- Startup ----------

  function main() {
    if (!initGame(newRound)) return;
    const all = topics.flatMap((t) => t.items as PhraseData[]);
    for (const p of all) splitWords(p.en).forEach((w, i) => i > 0 && /^\p{Lu}\p{Ll}/u.test(w) && proper.add(w.toLowerCase()));
    for (const p of all) pool.push(...splitWords(p.en).map(shown));

    $("listen").onclick = listen;
    $("hint").onclick = hint;
    $("next").onclick = newRound;
    document.addEventListener("keydown", (e) => {
      if (e.repeat || overlayKey(e)) return;
      if (e.key === " ") {
        e.preventDefault(); // not a click on the focused button
        listen();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (phase === "ok") newRound();
      } else if (e.key === "Backspace") {
        const last = placed[placed.length - 1];
        if (last !== undefined) takeBack(last);
      } else if (e.key === "h" || e.key === "р") {
        hint();
      } else if (/^[1-9]$/.test(e.key)) {
        const c = cards[Number(e.key) - 1]; // cards keep their place in the bank
        if (c) place(c.id);
      }
    });
    newRound();
  }

  main();
}
