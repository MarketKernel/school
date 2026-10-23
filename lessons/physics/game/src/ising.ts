// «Магнит из стрелочек»: the 2D Ising model. Every cell holds a tiny magnet, a spin s = ±1 (an arrow up or down);
// neighbours like to point the same way: the energy is E = −J Σ s_i s_j over the four neighbours. Heat shakes them:
// the Metropolis rule flips a spin always when that lowers the energy, and with probability exp(−ΔE / T) when it
// raises it (T in units of J / k_B). Below Onsager's critical temperature T_c = 2 / ln(1 + √2) ≈ 2.269 the arrows
// line up into big islands — a magnet; above it they boil into noise; right at T_c islands of every size nest inside
// each other (a fractal). Spins live in an Int8Array with periodic edges, updated in checkerboard sweeps with
// precomputed acceptance thresholds and a xorshift random generator.

namespace Ising {
  type View = "arrows" | "far";

  const TC = 2 / Math.log(1 + Math.SQRT2);
  const ARROW_CELL = 21; // CSS px per arrow on a wide screen
  const ARROW_CELL_MIN = 17;
  const FAR_CELL = 2.5; // CSS px per spin in «Издалека»
  const ARROW_SWEEPS = 10; // sweeps per second with arrows: each flip can be seen
  const FAR_MAX = 160000;
  const FAR_SWEEPS = 4; // sweeps per frame from far away
  const TURN = 14; // how fast an arrow turns over, 1/s
  const UP: [number, number, number] = [255, 190, 110]; // apricot
  const DOWN: [number, number, number] = [214, 92, 150]; // raspberry
  const FAR_DOWN: [number, number, number] = [86, 44, 128]; // deep violet: from far away the islands need contrast
  const BACKGROUND = "#0d0b1e";
  // the islands glow softly under the arrows
  const UP_GLOW: [number, number, number] = [70, 38, 36];
  const DOWN_GLOW: [number, number, number] = [62, 24, 74];

  const ctx = canvas2d();
  let view_: View = "arrows";
  let T = 1.6;
  let cols = 1, rows = 1, cell = 1;
  let spin = new Int8Array(1);
  let angle = new Float32Array(1); // arrows: 0 up … ±π down, turning smoothly towards the spin
  let side = new Int8Array(1); // which way each arrow turns over (half clockwise, half not: no fake «wind»)
  let shade = new Float32Array(1); // from far: the shown value −1…1, easing towards the spin
  let left = new Int32Array(1), right = new Int32Array(1), up = new Int32Array(1), down = new Int32Array(1);
  let magnet = 0; // Σ s
  let sweepClock = 0;
  let image: ImageData | null = null;
  const buffer = document.createElement("canvas");
  const bufferCtx = buffer.getContext("2d")!;

  // ---------- Random numbers: xorshift32, much faster than Math.random in the inner loop ----------

  let seed = (Math.random() * 0xffffffff) >>> 0 || 1;
  function random32(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  }

  // ---------- Lattice ----------

  /** A new lattice for the current view, filled with random spins: a «hot» start. */
  function build(): void {
    // from far away a big screen gets bigger cells: at most FAR_MAX spins, so the sweeps stay fast
    const target = view_ === "arrows" ? Math.max(ARROW_CELL_MIN, Math.min(ARROW_CELL, view.w / 30)) : Math.max(FAR_CELL, Math.sqrt((view.w * view.h) / FAR_MAX));
    cols = Math.max(8, Math.round(view.w / target));
    rows = Math.max(8, Math.round(view.h / target));
    cell = Math.max(view.w / cols, view.h / rows);
    const n = cols * rows;
    spin = new Int8Array(n);
    angle = new Float32Array(n);
    side = new Int8Array(n);
    for (let i = 0; i < n; i++) side[i] = random32() & 1 ? 1 : -1;
    shade = new Float32Array(n);
    left = new Int32Array(n);
    right = new Int32Array(n);
    up = new Int32Array(n);
    down = new Int32Array(n);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        left[i] = y * cols + ((x + cols - 1) % cols);
        right[i] = y * cols + ((x + 1) % cols);
        up[i] = ((y + rows - 1) % rows) * cols + x;
        down[i] = ((y + 1) % rows) * cols + x;
      }
    }
    scramble();
    buffer.width = cols;
    buffer.height = rows;
    image = bufferCtx.createImageData(cols, rows);
  }

  function scramble(): void {
    magnet = 0;
    for (let i = 0; i < spin.length; i++) {
      const s = random32() & 1 ? 1 : -1;
      spin[i] = s;
      angle[i] = s > 0 ? 0 : side[i]! * Math.PI;
      shade[i] = s;
      magnet += s;
    }
  }

  /** One Metropolis sweep: first the «black» cells of the checkerboard, then the «white» ones. */
  function sweep(): void {
    // ΔE = 2 s Σ neighbours ∈ {−8, −4, 0, 4, 8}: only the two positive cases need a dice roll
    const p4 = Math.exp(-4 / T) * 4294967296;
    const p8 = Math.exp(-8 / T) * 4294967296;
    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < rows; y++) {
        for (let x = (y + parity) & 1; x < cols; x += 2) {
          const i = y * cols + x;
          const s = spin[i]!;
          const e = s * (spin[left[i]!]! + spin[right[i]!]! + spin[up[i]!]! + spin[down[i]!]!);
          if (e <= 0 || (e === 2 ? random32() < p4 : random32() < p8)) {
            spin[i] = -s;
            magnet -= 2 * s;
          }
        }
      }
    }
  }

  // ---------- Drawing ----------

  /** The lattice as a picture of cols × rows pixels, stretched smoothly over the screen. */
  function paintLattice(value: Float32Array, hi: [number, number, number], lo: [number, number, number]): void {
    const img = image!;
    const data = img.data;
    for (let i = 0; i < value.length; i++) {
      const t = (1 - value[i]!) / 2;
      const o = i * 4;
      data[o] = lerp(hi[0], lo[0], t);
      data[o + 1] = lerp(hi[1], lo[1], t);
      data[o + 2] = lerp(hi[2], lo[2], t);
      data[o + 3] = 255;
    }
    bufferCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buffer, 0, 0, cols * cell, rows * cell);
  }

  function drawArrows(dt: number): void {
    const k = dt > 0 ? 1 - Math.exp(-dt * TURN) : 0;
    for (let i = 0; i < spin.length; i++) shade[i] = Math.cos(angle[i]!);
    paintLattice(shade, UP_GLOW, DOWN_GLOW);
    const len = cell * 0.38, head = cell * 0.24, width = Math.max(1.8, cell * 0.13);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const goal = spin[i]! > 0 ? 0 : side[i]! * Math.PI;
        let a = angle[i]!;
        a += (goal - a) * k;
        angle[i] = a;
        const t = Math.abs(a) / Math.PI;
        const r = lerp(UP[0], DOWN[0], t) | 0, g = lerp(UP[1], DOWN[1], t) | 0, b = lerp(UP[2], DOWN[2], t) | 0;
        const color = `rgb(${r},${g},${b})`;
        const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell;
        // the arrow turns over through the side (a rotation in the plane looks like a compass needle)
        const c = Math.cos(a), s = Math.sin(a);
        ctx.setTransform(view.dpr * c, view.dpr * s, -view.dpr * s, view.dpr * c, view.dpr * cx, view.dpr * cy);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, len);
        ctx.lineTo(0, -len + head * 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -len - head * 0.25);
        ctx.lineTo(head * 0.75, -len + head);
        ctx.lineTo(-head * 0.75, -len + head);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  }

  function drawFar(dt: number): void {
    const k = dt > 0 ? 1 - Math.exp(-dt * 20) : 0;
    for (let i = 0; i < spin.length; i++) shade[i] = shade[i]! + (spin[i]! - shade[i]!) * k;
    paintLattice(shade, UP, FAR_DOWN);
    // a soft dark vignette keeps the panels readable over the bright islands
    const g = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.3, view.w / 2, view.h / 2, Math.hypot(view.w, view.h) * 0.6);
    g.addColorStop(0, "rgba(13, 11, 30, 0)");
    g.addColorStop(1, "rgba(13, 11, 30, 0.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
  }

  function showReadout(): void {
    const m = Math.round((magnet / spin.length) * 100);
    const arrow = m > 2 ? " ↑" : m < -2 ? " ↓" : "";
    setReadout(`Намагниченность:\n${m > 0 ? "+" : m < 0 ? "−" : ""}${Math.abs(m)} %${arrow}`);
  }

  // ---------- Input: drag to paint spins ----------

  let paintWith: 1 | -1 = 1;

  function paint(px: number, py: number): void {
    const radius = view_ === "arrows" ? 0.9 : 7;
    const cx = px / cell, cy = py / cell;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > radius * radius) continue;
        const i = (((y % rows) + rows) % rows) * cols + (((x % cols) + cols) % cols);
        if (spin[i] !== paintWith) {
          spin[i] = paintWith;
          magnet += 2 * paintWith;
        }
      }
    }
  }

  onPointer({
    down(p) {
      // paint the way opposite to the arrow under the finger: then both kinds of islands can be drawn
      const x = clamp(Math.floor(p.x / cell), 0, cols - 1), y = clamp(Math.floor(p.y / cell), 0, rows - 1);
      paintWith = spin[y * cols + x]! > 0 ? -1 : 1;
      paint(p.x, p.y);
    },
    move(p) {
      if (!p.down) return;
      // fill the gaps of a fast stroke
      const steps = Math.max(1, Math.ceil(Math.hypot(p.dx, p.dy) / (cell * 0.5)));
      for (let s = 1; s <= steps; s++) paint(p.x - p.dx * (1 - s / steps), p.y - p.dy * (1 - s / steps));
    },
  });

  // ---------- Loop ----------

  build();
  onResize(build);

  startLoop((dt) => {
    if (dt > 0) {
      if (view_ === "arrows") {
        sweepClock = Math.min(sweepClock + dt * ARROW_SWEEPS, 2);
        while (sweepClock >= 1) {
          sweep();
          sweepClock -= 1;
        }
      } else {
        for (let s = 0; s < FAR_SWEEPS; s++) sweep();
      }
    }
    if (view_ === "arrows") drawArrows(dt);
    else drawFar(dt);
    showReadout();
  });

  addChoice<View>(
    [
      { value: "arrows", label: "🧭 Стрелочки", title: "Каждая стрелочка — крошечный магнит" },
      { value: "far", label: "🔭 Издалека", title: "Сто тысяч стрелочек издалека" },
    ],
    view_,
    (next) => {
      view_ = next;
      build();
    },
  );
  const slider = addSlider({
    label: view.w < 700 ? "🌡️" : "🌡️ Температура",
    min: 0.5,
    max: 5,
    step: 0.01,
    value: T,
    onInput: (v) => {
      // the critical point is narrow: snap to it when the finger is close
      if (Math.abs(v - TC) < 0.06) {
        v = Math.round(TC * 100) / 100;
        slider.set(v);
      }
      T = v;
    },
    format: (v) => (Math.abs(v - TC) < 0.02 ? "⭐ " : v < TC ? "❄️ " : "🔥 ") + v.toFixed(2).replace(".", ","),
    title: "Критическая температура (точка Кюри) — 2,27",
  });
  // a tick mark on the slider at the critical temperature
  {
    const input = controls.querySelector<HTMLInputElement>(".slider:last-of-type input")!;
    const list = document.createElement("datalist");
    list.id = "critical";
    const option = document.createElement("option");
    option.value = String(Math.round(TC * 100) / 100);
    list.append(option);
    document.body.append(list);
    input.setAttribute("list", list.id);
  }
  addButton("🔄", () => {
    scramble();
  }, { round: true, title: "Перемешать все стрелочки" });

  showHint("Проведи пальцем — стрелочки перевернутся");
}
