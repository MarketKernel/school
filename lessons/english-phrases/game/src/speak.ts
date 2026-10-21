// Modes "to-russian" and "to-english": the child translates a phrase aloud, speech recognition checks it.
//   to-russian — hear an English phrase (🔊), say it in Russian; 💡 shows the translation and plays it.
//   to-english — read or hear (🔊) a Russian phrase, say it in English; 💡 plays the English phrase.

namespace Speak {
  // idle — waiting; listening — the mic is on; ok — translated right; miss — try again
  type Phase = "idle" | "listening" | "ok" | "miss";

  let toRussian = true;
  let current: PhraseData | null = null;
  let phase: Phase = "idle";
  let playing: "" | "phrase" | "hint" = ""; // what is playing: the phrase (🔊) or the hint (💡)
  let hinted = false; // 💡 was used for this phrase: then it doesn't count as learned
  let misses = 0; // tries on this phrase
  let heard = ""; // what the recognizer heard on the last attempt

  const answers = (p: PhraseData) => (toRussian ? [p.ru, ...p.ruAlt] : [p.en, ...p.enAlt]);
  const matches = (transcript: string, p: PhraseData) =>
    answers(p).some((a) => matchesVariant(transcript, a, toRussian ? "ru" : "en"));
  // The sound of the task: the English phrase, or the Russian one in to-english (if it's voiced)
  const promptUrl = (p: PhraseData) => (toRussian ? audioUrl(p) : p.ruAudio ? ruAudioUrl(p) : "");

  function newRound() {
    stopSounds();
    stopListening();
    current = pickItem(current);
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

  // ---------- Sound ----------

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
    playThenListen("hint", () => (toRussian ? playRussian(phrase) : play(audioUrl(phrase))));
  }

  // ---------- Listening ----------

  function startListening() {
    const phrase = current;
    if (!phrase || playing || phase === "ok") return;
    heard = "";
    const started = startRecognition(toRussian ? "ru-RU" : "en-US", (t) => matches(t, phrase), (t) => {
      heard = t;
      render();
    }, finishListening);
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
    if (phase === "miss") {
      misses++;
      chime(false);
    }
    render();
  }

  /** 🎤: starts listening; pressed while listening — the child has finished. */
  function toggleListening() {
    if (recognizing()) finishRecognition();
    else startListening();
  }

  function success() {
    const phrase = current;
    if (!phrase || phase === "ok") return;
    stopListening();
    phase = "ok";
    const topicDone = scoreItem(phrase, hinted);
    chime(true);
    confetti();
    render();
    // Reading Russian, the child said the English phrase: now let them hear how it really sounds
    if (!toRussian) setTimeout(() => current === phrase && play(audioUrl(phrase)), 600);
    if (topicDone) {
      const n = currentTopic().items.length;
      setTimeout(() => showTopicDone(`Все фразы переведены без подсказки — целых ${n}. Молодец!`), 1800);
    }
  }

  // ---------- Rendering ----------

  function renderBoard() {
    const phrase = current!;
    $("task").textContent = `${currentTopic().icon} ` + (toRussian ? "Как это сказать по-русски?" : "Как это сказать по-английски?");
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
    listen.classList.toggle("hint", toRussian && phase === "idle" && !playing);

    const speak = $<HTMLButtonElement>("speak");
    speak.hidden = !canSpeak();
    speak.disabled = playing !== "" || phase === "ok";
    speak.classList.toggle("active", phase === "listening");
    speak.classList.toggle("hint", phase === "miss" || (!toRussian && phase === "idle" && !playing));
    $("speak-label").textContent = phase === "listening" ? "Готово" : toRussian ? "По-русски" : "По-английски";

    const hint = $<HTMLButtonElement>("hint");
    hint.disabled = phase === "ok" || playing === "phrase";
    hint.classList.toggle("active", playing === "hint");
    hint.classList.toggle("hint", phase === "miss" && misses >= HINT_AFTER_MISSES && !hinted);
  }

  function message(): string {
    if (playing) return playing === "hint" ? "Подсказка…" : "Слушай…";
    switch (phase) {
      case "listening":
        return toRussian ? "Говори по-русски! 🎤" : "Говори по-английски! 🎤";
      case "ok":
        return hinted
          ? random(["Правильно! +1", "Получилось! +1"]) + " А потом — без подсказки 😉"
          : random(["Правильно! +1", "Ура! Получилось! +1", "Отлично! +1", "Здорово! +1", "Супер! +1"]);
      case "miss":
        return missMessage(heard, misses, hinted);
      default:
        if (toRussian) return manualMode() ? "Послушай 🔊 и скажи по-русски" : "Нажми 🔊, послушай и скажи по-русски";
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
    note.textContent = micNote();
  }

  function render() {
    renderTopics();
    renderBoard();
    renderActions();
    renderControls();
  }

  // ---------- Startup ----------

  function main() {
    if (!initGame(newRound)) return;
    toRussian = GAME_DATA.mode === "to-russian";
    $("listen").onclick = listenToPhrase;
    $("speak").onclick = toggleListening;
    $("hint").onclick = showHint;
    $("manual-ok").onclick = success;
    $("next").onclick = newRound;
    document.addEventListener("keydown", (e) => {
      if (e.repeat || overlayKey(e)) return;
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
}
