// «Собери слово» mode "assemble": the word is split into syllables and the child assembles it from the tiles below.
// Riddle lessons (game.json "mode": "riddle") use this file too: the big speaker plays the riddle instead of the word,
// and the answer is assembled the same way.
// Shared parts (words, split, sounds, levels, cells) are in common.ts; a namespace keeps this mode's names apart from aloud.ts.

namespace Assemble {
  interface Tile {
    id: number;
    text: string;
    used: boolean;
  }

  let tiles: Tile[] = [];
  let placed: Tile[] = [];
  let result: "ok" | "bad" | null = null;
  let busy = false; // a check is in progress — tiles are locked

  const riddles = GAME_DATA.riddles; // set only in a riddle lesson: answer -> sound of the riddle
  const labels = riddles ? { other: "Другая загадка", next: "Следующая загадка →" } : { other: "Другое слово", next: "Следующее слово →" };

  /** The big speaker: the riddle, or the word by syllables. */
  const sayWord = () => (riddles ? playFile(riddles[entry]!) : playParts(parts));

  const placedText = () => placed.map((t) => t.text).join("");
  const isFull = () => placedText().length === word.length;

  /** Decoy tiles: one look-alike per correct tile (a syllable for a syllable, a letter for a letter). */
  function decoys(correct: string[]): string[] {
    const taken = new Set(correct);
    const syllablePool = Object.keys(syllableFiles);
    const letterPool = [...ALPHABET].filter((c) => !isSign(c));
    return correct.map((part) => {
      let pool: string[];
      if (isSyllable(part)) pool = syllablePool;
      else if (part.length === 1) pool = letterPool;
      else pool = [...SOFTABLE].map((c) => c + part.slice(1)); // «ть» → «нь», «сь»…
      const options = pool.filter((x) => !taken.has(x));
      const pick = options.length ? random(options) : random(pool);
      taken.add(pick);
      return pick;
    });
  }

  function startRound() {
    tiles = shuffle([...parts, ...decoys(parts)]).map((text, id) => ({ id, text, used: false }));
    placed = [];
    result = null;
    // A new riddle is read at once; before the first tap the browser blocks sound, and the child taps 🔊
    if (riddles) void sayWord();
  }

  function place(tile: Tile, el: HTMLElement) {
    if (busy || result === "ok" || tile.used) return;
    if (placedText().length + tile.text.length > word.length) {
      shake(el); // doesn't fit into the remaining cells
      return;
    }
    tile.used = true;
    placed.push(tile);
    result = null;
    render();
    playParts([tile.text]);
  }

  function erase() {
    if (busy || result === "ok") return;
    const tile = placed.pop();
    if (!tile) return;
    tile.used = false;
    result = null;
    render();
  }

  async function check() {
    if (busy || !isFull() || result === "ok") return;
    busy = true;
    render();
    await playParts(placed.map((t) => t.text));
    result = placedText() === word ? "ok" : "bad";
    busy = false;
    if (result === "ok") {
      addProgress();
      chime(true);
      confetti();
    } else {
      chime(false);
      shake($("word"));
    }
    render();
  }

  function next() {
    if (busy) return;
    newRound();
  }

  // ---------- Rendering ----------

  function renderTiles() {
    const box = $("tiles");
    box.replaceChildren();
    for (const tile of tiles) {
      const el = document.createElement("div");
      el.className = "tile" + (tile.used ? " used" : "");

      const text = document.createElement("button");
      text.className = "tile-text";
      text.textContent = tile.text;
      text.disabled = tile.used || busy || result === "ok";
      text.onclick = () => place(tile, el);

      const speaker = document.createElement("button");
      speaker.className = "speaker small";
      speaker.title = "Послушать";
      speaker.innerHTML = SPEAKER_SVG;
      speaker.disabled = tile.used;
      speaker.onclick = () => playParts([tile.text]);

      el.append(text, speaker);
      box.append(el);
    }
  }

  function renderControls() {
    ($("erase") as HTMLButtonElement).disabled = busy || !placed.length || result === "ok";
    ($("check") as HTMLButtonElement).disabled = busy || !isFull() || result === "ok";
    $("check").hidden = result === "ok";
    $("next").classList.toggle("primary", result === "ok");
    $("next").textContent = result === "ok" ? labels.next : labels.other;

    const message = $("message");
    message.className = result ?? "";
    message.textContent =
      result === "ok" ? random(["Правильно! Молодец!", "Ура! Получилось!", "Отлично!", "Здорово!"]) :
      result === "bad" ? "Не так. Сотри и попробуй ещё раз" :
      busy ? "Слушаем…" :
      riddles && !placed.length ? "Послушай загадку 🔊 и собери отгадку" :
      "";
  }

  function renderMode() {
    renderWord(placedText(), result);
    renderTiles();
    renderControls();
  }

  // ---------- Startup ----------

  if (startGame({ newRound: startRound, render: renderMode, busy: () => busy, everyWord: !!riddles })) {
    $("say-word").innerHTML = SPEAKER_SVG;
    $("say-word").onclick = sayWord;
    if (riddles) {
      $("say-word").title = "Послушать загадку ещё раз";
      $("say-word").setAttribute("aria-label", "Послушать загадку");
    }
    $("erase").onclick = erase;
    $("check").onclick = check;
    $("next").onclick = next;
    document.addEventListener("keydown", (e) => {
      if (!$("overlay").hidden) {
        if (e.key === "Enter") $("overlay-btn").click();
        return;
      }
      if (e.key === "Backspace") erase();
      if (e.key === "Enter") (result === "ok" ? next : check)();
    });
  }
}
