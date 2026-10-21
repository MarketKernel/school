// Modes "tenses-listen" and "tenses-say": the three tenses for children — yesterday (Past Simple),
// now (Present Continuous) and tomorrow (will). Sentences come from the shared folder lessons/english-tenses.
//   tenses-listen — hear a sentence, choose when it happens: «⏪ Вчера», «🟢 Сейчас» or «⏩ Завтра»;
//                   💡 shows the sentence (the clue is in «-ed», «am/is/are …-ing», «will»).
//   tenses-say    — see and hear a sentence in one tense, say it in another (en-US recognition);
//                   💡 plays the right sentence.

namespace Tenses {
  type Tense = "past" | "now" | "future";
  interface Form {
    en: string;
    ru: string;
    slug: string;
  }
  interface SentenceData extends Item {
    tense: Tense;
    topic: string; // regular / irregular
    forms: Record<Tense, Form>; // the same sentence in all three tenses, this one included
  }

  const TENSES: Tense[] = ["past", "now", "future"];
  const TIMES: Record<Tense, { icon: string; name: string }> = {
    past: { icon: "⏪", name: "Вчера" },
    now: { icon: "🟢", name: "Сейчас" },
    future: { icon: "⏩", name: "Завтра" },
  };
  // Words a child may add to the sentence: «Yesterday I played football»
  const TIME_WORDS = new Set(["yesterday", "now", "today", "tomorrow", "right"]);

  // idle — waiting; listening — the mic is on (say); ok — right; miss — try again
  type Phase = "idle" | "listening" | "ok" | "miss";

  let sayMode = false;
  let current: SentenceData | null = null;
  let from: Tense = "now"; // say: the tense of the sentence shown
  let phase: Phase = "idle";
  let playing: "" | "phrase" | "hint" = "";
  let hinted = false;
  let misses = 0;
  let heard = "";
  let tried = new Set<Tense>(); // listen: wrong choices on this sentence

  const form = (s: SentenceData, t: Tense) => s.forms[t];
  const formUrl = (f: Form) => `${mediaBase}audio/${f.slug}.mp3`;
  // The sound of the task: the sentence itself (listen) or the one shown (say)
  const promptForm = () => (sayMode ? form(current!, from) : form(current!, current!.tense));

  /** Why it's this tense — shown after the answer. */
  function clue(s: SentenceData): string {
    if (s.tense === "future") return "«will» — значит, завтра";
    if (s.tense === "now") return "«am / is / are» и «-ing» — значит, сейчас";
    return s.topic === "irregular" ? "особая форма глагола — значит, вчера" : "окончание «-ed» — значит, вчера";
  }

  function newRound() {
    stopSounds();
    stopListening();
    current = pickItem(current);
    from = random(TENSES.filter((t) => t !== current!.tense));
    phase = "idle";
    hinted = false;
    misses = 0;
    heard = "";
    tried = new Set();
    lastError = lastError === "network" ? lastError : "";
    for (const t of TENSES) audioFor(formUrl(form(current, t))).load();
    render();
    if (touched) listenToPrompt();
  }

  // ---------- Sound ----------

  async function playThen(kind: "phrase" | "hint", f: Form, listenAfter: boolean) {
    const s = current;
    if (!s || playing) return;
    stopListening();
    playing = kind;
    render();
    await play(formUrl(f));
    playing = "";
    if (listenAfter && current === s && phase !== "ok" && canSpeak()) startListening();
    else render();
  }

  /** 🔊: the sentence to recognize (listen) or to change (say). */
  function listenToPrompt() {
    if (current) playThen("phrase", promptForm(), sayMode);
  }

  /** 💡 listen: shows the sentence; say: shows and plays the right one, then listens. */
  function showHint() {
    if (!current || phase === "ok") return;
    hinted = true;
    if (sayMode) playThen("hint", form(current, current.tense), true);
    else render();
  }

  // ---------- Listen: choose the time ----------

  function choose(t: Tense) {
    const s = current;
    if (!s || phase === "ok" || tried.has(t)) return;
    if (t === s.tense) {
      success();
      return;
    }
    tried.add(t);
    phase = "miss";
    misses++;
    chime(false);
    render();
    setTimeout(() => current === s && phase !== "ok" && listenToPrompt(), 700); // hear it again
  }

  // ---------- Say: the sentence in another tense ----------

  const matches = (text: string) => {
    const want = form(current!, current!.tense).en;
    return matchesVariant(text, want, "en", TIME_WORDS);
  };

  function startListening() {
    if (!current || playing || phase === "ok") return;
    heard = "";
    const started = startRecognition("en-US", matches, (t) => {
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

  function toggleListening() {
    if (recognizing()) finishRecognition();
    else startListening();
  }

  // ---------- Right answer ----------

  function success() {
    const s = current;
    if (!s || phase === "ok") return;
    stopListening();
    phase = "ok";
    const topicDone = scoreItem(s, hinted);
    chime(true);
    confetti();
    render();
    // Say: now hear how the sentence really sounds
    if (sayMode) setTimeout(() => current === s && play(formUrl(form(s, s.tense))), 600);
    if (topicDone) {
      const n = currentTopic().items.length;
      setTimeout(() => showTopicDone(`Все предложения — без подсказки, целых ${n}. Молодец!`), 1800);
    }
  }

  // ---------- Rendering ----------

  function renderBoard() {
    const s = current!;
    const own = form(s, s.tense);
    const question = $("question");
    const answer = $("answer");
    question.lang = answer.lang = "en";
    answer.classList.toggle("ok", phase === "ok");
    $("clue").textContent = phase === "ok" ? clue(s) : "";

    if (sayMode) {
      const shownForm = form(s, from);
      const time = TIMES[s.tense];
      $("task").textContent = `${TIMES[from].icon} ${TIMES[from].name}:`;
      question.textContent = shownForm.en;
      $("target").innerHTML = `<span class="target-label">а теперь</span>` +
        `<span class="time-badge time-${s.tense}">${time.icon} ${time.name}</span>` +
        `<span class="target-ru" lang="ru">${own.ru}</span>`;
      answer.hidden = !hinted && phase !== "ok";
      answer.textContent = own.en;
      const shown = phase === "listening" || (phase === "miss" && heard) ? heard : "";
      $("heard").textContent = shown ? `Я услышал: «${shown}»` : "";
      return;
    }

    $("task").textContent = "🎧 Когда это было?";
    // The sentence is hidden: the child must hear the tense, not read it
    question.textContent = hinted || phase === "ok" ? own.en : "• • •";
    question.classList.toggle("muted", !(hinted || phase === "ok"));
    answer.hidden = phase !== "ok";
    answer.textContent = own.ru;
    answer.lang = "ru";
    for (const t of TENSES) {
      const btn = $<HTMLButtonElement>(`time-${t}`);
      btn.classList.toggle("wrong", tried.has(t));
      btn.classList.toggle("right", phase === "ok" && t === s.tense);
      btn.disabled = phase === "ok" || tried.has(t);
    }
  }

  function renderActions() {
    const listen = $<HTMLButtonElement>("listen");
    listen.classList.toggle("active", playing === "phrase");
    listen.classList.toggle("hint", !touched && !playing);

    const speak = $<HTMLButtonElement>("speak");
    speak.hidden = !sayMode || !canSpeak();
    speak.disabled = playing !== "" || phase === "ok";
    speak.classList.toggle("active", phase === "listening");
    speak.classList.toggle("hint", phase === "miss");
    $("speak-label").textContent = phase === "listening" ? "Готово" : "Скажи";

    const hint = $<HTMLButtonElement>("hint");
    hint.disabled = phase === "ok" || playing === "phrase" || (!sayMode && hinted);
    hint.classList.toggle("active", playing === "hint");
    hint.classList.toggle("hint", phase === "miss" && misses >= HINT_AFTER_MISSES && !hinted);
  }

  function message(): string {
    if (playing) return playing === "hint" ? "Подсказка…" : "Слушай…";
    switch (phase) {
      case "listening":
        return "Говори! 🎤";
      case "ok":
        return hinted
          ? random(["Правильно! +1", "Получилось! +1"]) + " А потом — без подсказки 😉"
          : random(["Правильно! +1", "Ура! Получилось! +1", "Отлично! +1", "Здорово! +1", "Супер! +1"]);
      case "miss":
        if (sayMode) return missMessage(heard, misses, hinted);
        return misses >= HINT_AFTER_MISSES && !hinted ? "Не совсем. Посмотри подсказку 💡" : "Не совсем. Послушай ещё раз!";
      default:
        if (!sayMode) return touched ? "Послушай и выбери: вчера, сейчас или завтра" : "Нажми 🔊 и выбери: вчера, сейчас или завтра";
        if (manualMode()) return `Скажи это так, как будто это ${TIMES[current!.tense].name.toLowerCase()}`;
        return `Скажи это «${TIMES[current!.tense].name.toLowerCase()}» — нажми 🎤`;
    }
  }

  function render() {
    renderTopics();
    renderBoard();
    renderActions();
    const msg = $("message");
    msg.className = phase === "ok" ? "ok" : phase === "miss" ? "miss" : "";
    msg.textContent = message();
    $("manual-ok").hidden = !sayMode || !manualMode() || phase === "ok";
    $("next").classList.toggle("primary", phase === "ok");
    $("next").textContent = phase === "ok" ? "Дальше →" : "Другое предложение";
    const note = $("note");
    note.hidden = !sayMode || !manualMode();
    note.textContent = micNote();
  }

  // ---------- Startup ----------

  function main() {
    if (!initGame(newRound)) return;
    sayMode = GAME_DATA.mode === "tenses-say";
    $("listen").onclick = listenToPrompt;
    $("speak").onclick = toggleListening;
    $("hint").onclick = showHint;
    $("manual-ok").onclick = success;
    $("next").onclick = newRound;
    for (const t of TENSES) $(`time-${t}`).onclick = () => choose(t);
    document.addEventListener("keydown", (e) => {
      if (e.repeat || overlayKey(e)) return;
      if (e.key === " ") {
        e.preventDefault(); // not a click on the focused button
        listenToPrompt();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (phase === "ok") newRound();
        else if (sayMode) toggleListening();
      } else if (e.key === "h" || e.key === "р") {
        showHint();
      } else if (!sayMode && ["1", "2", "3"].includes(e.key)) {
        choose(TENSES[Number(e.key) - 1]!);
      }
    });
    newRound();
  }

  main();
}
