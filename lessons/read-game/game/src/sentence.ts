// «Собери слово» mode "sentence": a short sentence is shown, the child reads it aloud, and browser speech recognition
// (Web Speech API, ru-RU) checks it; each word lights up green as soon as it is heard. The prize for a sentence
// read right is a longer text of the same pair: its sound plays and its text appears under the sentence.
// The sentence itself is never voiced: the child must read it, not repeat it.
// Shared parts (levels, effects, recognition, score) are in common.ts; a namespace keeps this mode's names apart.

namespace Sentence {
  const TIMING: ListenTiming = {
    listen: 25000, // a sentence of fifteen words read slowly
    quiet: 3000, // a pause between words must not end the attempt
  };
  const REWARD_DELAY = 900; // ms between the chime and the prize, so they don't overlap

  // Levels by the number of words to read
  const SIZES: Difficulty[] = [
    { hint: "фразы из 5–7 слов", fits: (s) => wordsOf(s).length <= 7 },
    { hint: "фразы из 8–9 слов", fits: (s) => wordsOf(s).length >= 8 && wordsOf(s).length <= 9 },
    { hint: "фразы из 10 слов и больше", fits: (s) => wordsOf(s).length >= 10 },
  ];

  // ---------- Checking what was heard ----------

  /** The words of a sentence as written, with their punctuation: «Загадка:», «—» (no letters) stays a token too. */
  const tokensOf = (sentence: string) => sentence.split(/\s+/).filter(Boolean);
  const wordsOf = (sentence: string) => tokensOf(sentence).filter((t) => lettersOf(t));

  // The ru-RU recognizer writes game names in Latin letters at times («Roblox», «Doors») — read them the Russian way
  const LATIN: [RegExp, string][] = [
    [/sh/g, "ш"], [/ch/g, "ч"], [/th/g, "т"], [/ph/g, "ф"], [/ck/g, "к"], [/oo/g, "у"], [/ee/g, "и"], [/x/g, "кс"],
  ];
  const LETTERS: Record<string, string> = {
    a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "дж", k: "к", l: "л", m: "м",
    n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", y: "и", z: "з",
  };

  function cyrillic(text: string): string {
    let s = text.toLowerCase();
    for (const [from, to] of LATIN) s = s.replace(from, to);
    return s.replace(/[a-z]/g, (ch) => LETTERS[ch] ?? ch);
  }

  // Numbers come as digits («в 2006 году», «100 дверей»): with a digit heard, number words count as read
  const NUMBER_WORD = /^(одн|один|дв[аеу]|двух|тр[иеё]|четыр|пят|шест|сем|восем|восьм|девят|десят|сто|ста|тысяч|двадцат|тридцат|сорок|девяност|втор|трет|перв)/;

  /** Words of 1–2 letters («в», «и», «не») must be heard as they are; longer ones may hide in a longer piece. */
  const SHORT = 2;

  /** How many letters a word may differ by: none for short words, one for 5–7 letters, two for longer ones. */
  const slack = (want: string) => (want.length >= 8 ? 2 : want.length >= 5 ? 1 : 0);

  /** Indexes (in tokensOf) of the words found in what was heard. */
  function heardWords(sentence: string, transcript: string): Set<number> {
    const text = cyrillic(transcript);
    const said = text.split(/\s+/).map(lettersOf).filter(Boolean);
    const all = said.join(""); // the recognizer may split a word («шифт лок») or merge two
    const digits = /\d/.test(text);
    const found = new Set<number>();
    tokensOf(sentence).forEach((token, i) => {
      const want = lettersOf(token);
      if (!want) return;
      const ok = want.length <= SHORT
        ? said.includes(want)
        : closest(all, want) <= slack(want) || (digits && NUMBER_WORD.test(want));
      if (ok) found.add(i);
    });
    return found;
  }

  /** The words of three letters and more that must be heard; a short word missed by the recognizer doesn't count. */
  const keyWords = (sentence: string) =>
    tokensOf(sentence).map((t, i) => [lettersOf(t), i] as const).filter(([w]) => w.length > SHORT).map(([, i]) => i);

  /**
   * Lenient on purpose: one word in four may be missed — names («Тауэр», «Дорс») are often heard
   * as something else, and the reading still counts.
   */
  function matches(transcript: string): boolean {
    const found = heardWords(entry, transcript);
    const keys = keyWords(entry);
    const missed = keys.filter((i) => !found.has(i)).length;
    return keys.length > 0 && missed <= Math.floor(keys.length / 4);
  }

  // ---------- State ----------

  // idle — waiting for 🎤; listening — the mic is on; ok — read right, the prize is playing; miss — try again
  type Phase = "idle" | "listening" | "ok" | "miss";

  let phase: Phase = "idle";
  let heard = ""; // what the recognizer heard on the last attempt
  let found = new Set<number>(); // words heard on the last attempt
  let score = 0;
  let levelDone = false; // this sentence completed the level: the dialog comes after the prize, on «Дальше»
  let rewardTimer = 0;

  const reward = () => GAME_DATA.rewards?.[entry];

  function startRound() {
    stopListening();
    stopSounds();
    clearTimeout(rewardTimer);
    phase = "idle";
    heard = "";
    found = new Set();
    levelDone = false;
    if (lastError !== "network") lastError = "";
  }

  // ---------- Listening ----------

  function startListening() {
    if (phase === "ok") return;
    const started = startRecognition(matches, (text) => {
      heard = text;
      found = heardWords(entry, text);
      render();
    }, finishListening, TIMING);
    heard = "";
    found = new Set();
    phase = started ? "listening" : "idle";
    render();
  }

  function stopListening() {
    stopRecognition();
    if (phase === "listening") phase = "idle";
  }

  function finishListening(matched: boolean, error: string) {
    if (matched) {
      success();
      return;
    }
    phase = error === "aborted" ? "idle" : "miss";
    if (phase === "miss") chime(false);
    render();
  }

  /** 🎤: starts listening; pressed while listening — the child has finished reading. */
  function toggleListening() {
    if (recognition) finishRecognition();
    else startListening();
  }

  function success() {
    if (phase === "ok") return;
    stopListening();
    phase = "ok";
    score++;
    saveScore(score);
    levelDone = addProgress(false);
    bump($("score"));
    chime(true);
    confetti();
    render();
    rewardTimer = setTimeout(playReward, REWARD_DELAY);
  }

  function playReward() {
    const prize = reward();
    if (prize) void playFile(prize.audio);
  }

  function next() {
    if (levelDone) {
      stopSounds();
      levelDone = false;
      showLevelDone();
    } else {
      newRound();
    }
  }

  // ---------- Rendering ----------

  function message(): string {
    switch (phase) {
      case "listening":
        return "Читай! 🎤";
      case "ok":
        return random(["Правильно! А вот тебе секрет:", "Ура! Слушай награду:", "Отлично! Вот что я знаю:", "Здорово! Слушай:"]);
      case "miss":
        if (lastError === "network") return "Нет интернета — проверить не получится";
        if (micBlocked) return "Нет доступа к микрофону";
        if (heard) return "Почти! Прочитай ещё раз";
        return "Ничего не слышно. Читай погромче!";
      default:
        return manualMode() ? "Прочитай фразу вслух" : "Нажми 🎤 и прочитай фразу вслух";
    }
  }

  function renderSentence() {
    const box = $("sentence");
    box.replaceChildren();
    const keys = new Set(keyWords(entry));
    tokensOf(entry).forEach((token, i) => {
      const span = document.createElement("span");
      span.className = "sentence-word";
      span.textContent = token;
      if (phase === "ok" || found.has(i)) span.classList.add("ok");
      else if (phase === "miss" && keys.has(i)) span.classList.add("miss"); // these were not heard
      if (phase === "ok") span.style.setProperty("--i", String(i)); // wave across the words
      box.append(span, " ");
    });
  }

  function renderMode() {
    renderSentence();

    const heardLine = $("heard");
    heardLine.className = "heard" + (phase === "ok" ? " ok" : phase === "miss" ? " miss" : "");
    heardLine.textContent = heard ? `Я услышал: «${heard}»` : phase === "listening" ? "Я слушаю…" : "";

    const prize = reward();
    const card = $("reward");
    card.hidden = phase !== "ok" || !prize;
    $("reward-text").textContent = prize?.text ?? "";

    const speak = $<HTMLButtonElement>("speak");
    speak.hidden = !canSpeak() || phase === "ok";
    speak.classList.toggle("active", phase === "listening");
    $("speak-label").textContent = phase === "listening" ? "Готово" : phase === "miss" ? "Ещё раз" : "Читать";

    const msg = $("message");
    msg.className = phase === "ok" ? "ok" : phase === "miss" ? "bad" : "";
    msg.textContent = message();

    $("score").textContent = `⭐ ${score}`;
    $("manual-ok").hidden = !manualMode() || phase === "ok";
    $("next").classList.toggle("primary", phase === "ok");
    $("next").textContent = phase === "ok" ? "Дальше →" : "Другая фраза";

    const note = $("note");
    note.hidden = !manualMode();
    note.textContent = micNote();
  }

  // ---------- Startup ----------

  if (startGame({ newRound: startRound, render: renderMode, busy: () => false, everyWord: true, difficulty: SIZES })) {
    score = loadScore();
    $("speak").onclick = toggleListening;
    $("manual-ok").onclick = success;
    $("next").onclick = next;
    $("reward-play").innerHTML = SPEAKER_SVG;
    $("reward-play").onclick = playReward;
    document.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (!$("overlay").hidden) {
        if (e.key === "Enter") $("overlay-btn").click();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault(); // not a click on the focused button
        if (phase === "ok") next();
        else toggleListening();
      }
    });
    render();
  }
}
