// «Песочная куча»: the abelian sandpile of Bak, Tang and Wiesenfeld (1987). Grains fall onto a grid of cells; a cell
// holding 4 or more grains topples — it gives one grain to each of its four neighbours, which may make them topple too,
// and an avalanche runs on until every cell holds 0…3. Grains that fall off the edge are lost. The order of topplings
// never changes the result («abelian»), so cells are toppled in batches (a cell with h grains sends ⌊h/4⌋ to each
// neighbour at once) from a queue of unstable cells, a few milliseconds per frame: big piles visibly grow and settle.
// Grains dropped at one point build a fractal mandala with the symmetry of the square.

namespace Sandpile {
  const GRID = 300; // cells on the short side of the screen (about)
  const MOUNTAIN = 1 << 16; // grains of «Высыпать гору»
  const BUDGET = 7; // ms of toppling per frame
  const SEED = 1 << 12; // grains in the middle at the very start, so a small mandala is there at once
  const AUTO_START = 400; // grains per second of the centre stream at the start …
  const AUTO_GROW = 1.7; // … growing by this factor every second …
  const AUTO_MAX = 15000; // … up to this rate
  const TAP_FIRST = 64; // grains of a single tap
  const TAP_START = 300; // grains per second while a finger is held, growing like the centre stream
  const TAP_GROW = 3;
  const TAP_MAX = 20000;
  const AUTO_REACH = 0.4; // the centre stream stops when its pile could reach this share of the short side
  const FLASH_FADE = 0.75; // per frame
  // colours of 0, 1, 2, 3 grains, never-touched cells and an unstable cell (4 or more)
  const COLORS: [number, number, number][] = [
    [56, 42, 108],
    [110, 190, 255],
    [255, 143, 190],
    [255, 214, 140],
  ];
  const EMPTY: [number, number, number] = [13, 11, 30];
  const HOT: [number, number, number] = [255, 250, 235];

  const ctx = canvas2d();
  let gw = 1, gh = 1, cell = 1, ox = 0, oy = 0;
  let grains = new Int32Array(1);
  let touched = new Uint8Array(1); // the cell has held a grain: its 0 is drawn as part of the pile
  let flash = new Float32Array(1);
  let queue = new Int32Array(1);
  let queued = new Uint8Array(1);
  let qHead = 0, qTail = 0, qCount = 0;
  let total = 0; // grains on the table
  let centre = 0;
  let autoRate = AUTO_START;
  let autoLeft = 0; // grains the centre stream still drops
  let image: ImageData | null = null;
  const buffer = document.createElement("canvas");
  const bufferCtx = buffer.getContext("2d")!;
  const taps = new Map<number, { x: number; y: number; rate: number; carry: number }>();
  let autoCarry = 0;

  // ---------- Grid ----------

  function build(): void {
    // whole device pixels per cell keep the picture crisp
    const devCell = Math.max(2, Math.round((Math.min(view.w, view.h) * view.dpr) / GRID));
    cell = devCell / view.dpr;
    gw = Math.ceil(view.w / cell);
    gh = Math.ceil(view.h / cell);
    const n = gw * gh;
    grains = new Int32Array(n);
    touched = new Uint8Array(n);
    flash = new Float32Array(n);
    queue = new Int32Array(n);
    queued = new Uint8Array(n);
    qHead = qTail = qCount = 0;
    total = 0;
    buffer.width = gw;
    buffer.height = gh;
    image = bufferCtx.createImageData(gw, gh);
    ox = 0;
    oy = 0;
    const area = freeArea();
    centre = cellAt(area.x + area.w / 2, area.y + area.h / 2);
    // the centre stream: grains for a pile reaching AUTO_REACH of the shorter free side (about 2.1 grains per cell)
    const radius = (Math.min(area.w, area.h) / cell) * AUTO_REACH * 0.5 * 1.25;
    autoLeft = Math.round(2.1 * Math.PI * radius * radius);
    autoRate = AUTO_START;
    autoCarry = 0;
    drop(centre, SEED);
    autoLeft -= SEED;
  }

  function cellAt(px: number, py: number): number {
    const x = clamp(Math.floor((px - ox) / cell), 0, gw - 1);
    const y = clamp(Math.floor((py - oy) / cell), 0, gh - 1);
    return y * gw + x;
  }

  function enqueue(i: number): void {
    if (queued[i]) return;
    queued[i] = 1;
    queue[qTail] = i;
    qTail = qTail + 1 === queue.length ? 0 : qTail + 1;
    qCount++;
  }

  function drop(i: number, count: number): void {
    grains[i] = grains[i]! + count;
    touched[i] = 1;
    total += count;
    if (grains[i]! >= 4) enqueue(i);
  }

  /** Gives q grains to the neighbour j (or to the floor when the edge is in the way). */
  function give(j: number, q: number): void {
    const h = grains[j]! + q;
    grains[j] = h;
    touched[j] = 1;
    if (h >= 4) enqueue(j);
  }

  /** Topples unstable cells until the queue is empty or the frame's time is up. */
  function relax(): void {
    const end = performance.now() + BUDGET;
    let ops = 0;
    while (qCount > 0) {
      const i = queue[qHead]!;
      qHead = qHead + 1 === queue.length ? 0 : qHead + 1;
      qCount--;
      queued[i] = 0;
      const h = grains[i]!;
      if (h < 4) continue;
      const q = h >> 2;
      grains[i] = h & 3;
      flash[i] = 1;
      const x = i % gw, y = (i - x) / gw;
      let lost = 0;
      if (x > 0) give(i - 1, q);
      else lost += q;
      if (x < gw - 1) give(i + 1, q);
      else lost += q;
      if (y > 0) give(i - gw, q);
      else lost += q;
      if (y < gh - 1) give(i + gw, q);
      else lost += q;
      total -= lost;
      if ((++ops & 2047) === 0 && performance.now() > end) break;
    }
  }

  // ---------- Drawing ----------

  function draw(fade: boolean): void {
    const img = image!;
    const data = img.data;
    for (let i = 0; i < grains.length; i++) {
      const h = grains[i]!;
      const base = h >= 4 ? HOT : touched[i] ? COLORS[h]! : EMPTY;
      let f = flash[i]!;
      const o = i * 4;
      if (f > 0.01) {
        const k = f * 0.4;
        data[o] = base[0] + (255 - base[0]) * k;
        data[o + 1] = base[1] + (246 - base[1]) * k;
        data[o + 2] = base[2] + (220 - base[2]) * k;
        if (fade) flash[i] = f * FLASH_FADE;
      } else {
        if (f !== 0) flash[i] = f = 0;
        data[o] = base[0];
        data[o + 1] = base[1];
        data[o + 2] = base[2];
      }
      data[o + 3] = 255;
    }
    bufferCtx.putImageData(img, 0, 0);
    ctx.fillStyle = "#0d0b1e";
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buffer, ox, oy, gw * cell, gh * cell);
    setReadout(`Песчинок: ${total.toLocaleString("ru-RU")}`);
  }

  // ---------- Input ----------

  onPointer({
    down(p) {
      taps.set(p.id, { x: p.x, y: p.y, rate: TAP_START, carry: 0 });
      drop(cellAt(p.x, p.y), TAP_FIRST);
    },
    move(p) {
      const t = taps.get(p.id);
      if (!t) return;
      t.x = p.x;
      t.y = p.y;
    },
    up(p) {
      taps.delete(p.id);
    },
  });

  // ---------- Loop ----------

  onResize(build);

  startLoop((dt) => {
    if (dt > 0) {
      if (autoLeft > 0) {
        autoCarry += autoRate * dt;
        const n = Math.min(autoLeft, Math.floor(autoCarry));
        autoCarry -= n;
        if (n > 0) drop(centre, n);
        autoLeft -= n;
        autoRate = Math.min(AUTO_MAX, autoRate * AUTO_GROW ** dt);
      }
      for (const t of taps.values()) {
        t.carry += t.rate * dt;
        const n = Math.floor(t.carry);
        t.carry -= n;
        if (n > 0) drop(cellAt(t.x, t.y), n);
        t.rate = Math.min(TAP_MAX, t.rate * TAP_GROW ** dt);
      }
      relax();
    }
    draw(dt > 0);
  });

  addButton("⛰️ Высыпать гору", () => drop(centre, MOUNTAIN), {
    primary: true,
    title: `Высыпать ${MOUNTAIN.toLocaleString("ru-RU")} песчинок в середину`,
  });
  addButton("🔄", build, { round: true, title: "Убрать весь песок" });
  // after the controls: the pile's centre is the middle of the free area between the title and the buttons
  build();

  showHint("Нажми и держи — посыплется песок");
}
