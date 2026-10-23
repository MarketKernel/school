// «Собери слово» mode "aloud": the word is shown split into syllables, the child reads it aloud,
// and browser speech recognition (Web Speech API, ru-RU) checks it. What was heard is shown under the cells.
// No picture and no sound of the word: with them the child could guess or just repeat instead of reading.
// Shared parts (words, split, sounds, levels, cells, recognition, score) are in common.ts;
// a namespace keeps this mode's names apart.

namespace Aloud {
  const TIMING: ListenTiming = {
    listen: 10000, // stop listening after this long anyway: reading by syllables is slow
    quiet: 2500, // after something was heard, this much silence ends the attempt
  };

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

  // ---------- State ----------

  // idle — waiting for 🎤; listening — the mic is on; ok — read right; miss — try again
  type Phase = "idle" | "listening" | "ok" | "miss";

  let phase: Phase = "idle";
  let heard = ""; // what the recognizer heard on the last attempt
  let score = 0;

  function startRound() {
    stopListening();
    phase = "idle";
    heard = "";
    if (lastError !== "network") lastError = "";
  }

  // ---------- Listening ----------

  function startListening() {
    if (phase === "ok") return;
    const started = startRecognition(matches, (text) => {
      heard = text;
      render();
    }, finishListening, TIMING);
    heard = "";
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
    addProgress();
    bump($("score"));
    chime(true);
    confetti();
    render();
  }

  function next() {
    newRound();
  }

  // ---------- Rendering ----------

  function message(): string {
    switch (phase) {
      case "listening":
        return "Читай! 🎤";
      case "ok":
        return random(["Правильно! +1", "Ура! Получилось! +1", "Отлично! +1", "Здорово! +1"]);
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
    note.textContent = micNote();
  }

  // ---------- Startup ----------

  if (startGame({ newRound: startRound, render: renderMode, busy: () => false })) {
    score = loadScore();
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
