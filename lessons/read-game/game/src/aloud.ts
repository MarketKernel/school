// «Собери слово» mode "aloud": the word is shown split into syllables, the child reads it aloud,
// and browser speech recognition (Web Speech API, ru-RU) checks it. What was heard is shown under the cells.
// Shared parts (words, split, sounds, levels, cells) are in common.ts; a namespace keeps this mode's names apart.

namespace Aloud {
  const LANG = "ru-RU";
  const LISTEN_MS = 10000; // stop listening after this long anyway: reading by syllables is slow
  const QUIET_MS = 2500; // after something was heard, this much silence ends the attempt

  // ---------- Speech recognition (Web Speech API — not in the TypeScript DOM lib) ----------

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

  /**
   * Lenient on purpose: spaces don't matter («га ри» read by syllables counts for «Гарри»),
   * and a long word may have one wrong letter («Хагрит» for «Хагрид»).
   */
  function matches(transcript: string): boolean {
    const said = lettersOf(transcript);
    const want = lettersOf(word);
    if (!said) return false;
    return closest(said, want) <= (want.length >= 5 ? 1 : 0);
  }

  // ---------- Saved score ----------

  const storeKey = () => `read-game:${GAME_DATA.lesson}:score`;

  function loadScore(): number {
    try {
      return Number(localStorage.getItem(storeKey())) || 0;
    } catch {
      return 0;
    }
  }

  function saveScore() {
    try {
      localStorage.setItem(storeKey(), String(score));
    } catch {
      // Private mode or blocked storage: the score lives until the page is closed
    }
  }

  // ---------- State ----------

  // idle — waiting for 🎤; listening — the mic is on; ok — read right; miss — try again
  type Phase = "idle" | "listening" | "ok" | "miss";

  let phase: Phase = "idle";
  let heard = ""; // what the recognizer heard on the last attempt
  let lastError = ""; // recognizer error of the last attempt: no-speech, network…
  let micBlocked = false; // no permission or no microphone — only the manual button is left
  let hinted = false; // the word was played to the child: reading it then earns no point
  let pointGiven = false; // the last right answer earned a point
  let score = 0;

  const canSpeak = () => Recognizer !== null && !micBlocked;
  // Without recognition (or offline) an adult listens and presses «Получилось»
  const manualMode = () => !canSpeak() || lastError === "network";

  function startRound() {
    stopListening();
    stopSound();
    phase = "idle";
    heard = "";
    hinted = false;
    lastError = lastError === "network" ? lastError : "";
  }

  // ---------- Listening ----------

  let recognition: Recognition | null = null;
  let listenTimer = 0;
  let quietTimer = 0;

  function startListening() {
    if (!Recognizer || micBlocked || phase === "ok") return;
    stopSound(); // the mic must not hear the speaker
    stopListening();

    const rec = new Recognizer();
    rec.lang = LANG;
    rec.interimResults = true; // show what is heard while the child reads
    rec.maxAlternatives = 5; // the right word is often not the first guess for a child's voice
    rec.continuous = true; // a pause between syllables must not end the attempt
    let matched = false;
    let error = "";
    rec.onresult = (e) => {
      const best: string[] = [];
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i]!;
        best.push(result[0]?.transcript ?? "");
        for (let j = 0; j < result.length; j++) if (matches(result[j]!.transcript)) matched = true;
      }
      heard = best.join(" ").replace(/\s+/g, " ").trim();
      if (matches(heard)) matched = true; // syllables may come as separate results: «га» + «ри»
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
    if (phase === "miss") chime(false);
    render();
  }

  /** 🎤: starts listening; pressed while listening — the child has finished reading. */
  function toggleListening() {
    if (recognition) recognition.stop();
    else startListening();
  }

  function success() {
    if (phase === "ok") return;
    stopListening();
    phase = "ok";
    pointGiven = !hinted;
    if (pointGiven) {
      score++;
      saveScore();
      addProgress();
      bump($("score"));
    }
    chime(true);
    confetti();
    render();
  }

  /** 🔊: a hint — the word is read by syllables. Reading it right afterwards is praised but earns no point. */
  function hint() {
    stopListening();
    if (phase !== "ok") hinted = true;
    render();
    playParts(parts);
  }

  function next() {
    newRound();
  }

  // ---------- Rendering ----------

  function bump(el: HTMLElement) {
    el.classList.remove("bump");
    void el.offsetWidth; // restart the animation
    el.classList.add("bump");
  }

  function message(): string {
    switch (phase) {
      case "listening":
        return "Читай! 🎤";
      case "ok":
        return pointGiven
          ? random(["Правильно! +1", "Ура! Получилось! +1", "Отлично! +1", "Здорово! +1"])
          : "Правильно! Следующее попробуй прочитать сам — без подсказки";
      case "miss":
        if (lastError === "network") return "Нет интернета — проверить не получится";
        if (micBlocked) return "Нет доступа к микрофону";
        if (heard) return "Не совсем. Попробуй ещё раз!";
        return "Ничего не слышно. Читай погромче!";
      default:
        return manualMode() ? "Прочитай слово вслух" : "Нажми 🎤 и прочитай слово вслух";
    }
  }

  function renderMode() {
    renderWord(word, phase === "ok" ? "ok" : null);

    const heardLine = $("heard");
    heardLine.className = "heard" + (phase === "ok" ? " ok" : phase === "miss" ? " miss" : "");
    heardLine.textContent = heard ? `Я услышал: «${heard}»` : phase === "listening" ? "Я слушаю…" : "";

    const speak = $<HTMLButtonElement>("speak");
    speak.hidden = !canSpeak();
    speak.disabled = phase === "ok";
    speak.classList.toggle("active", phase === "listening");
    $("speak-label").textContent = phase === "listening" ? "Готово" : phase === "miss" ? "Ещё раз" : "Читать";

    const msg = $("message");
    msg.className = phase === "ok" ? "ok" : phase === "miss" ? "bad" : "";
    msg.textContent = message();

    $("score").textContent = `⭐ ${score}`;
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

  // ---------- Startup ----------

  if (startGame({ newRound: startRound, render: renderMode, busy: () => false })) {
    score = loadScore();
    $("say-word").innerHTML = SPEAKER_SVG;
    $("say-word").title = "Подсказка: послушать слово по слогам (без очка)";
    $("say-word").onclick = hint;
    $("speak").onclick = toggleListening;
    $("manual-ok").onclick = success;
    $("next").onclick = next;
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
