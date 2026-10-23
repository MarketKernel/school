// «Стрела времени»: a gas of soft disks shows why time has a direction. The molecules repel each other (and the walls)
// with a stiff spring potential U = K (σ − d)² / 2, and move by velocity Verlet with a fixed step: in exact arithmetic
// this integrator is time-reversible, so flipping every velocity retraces the path. The computer rounds every number
// to 16 digits, and every collision of two disks magnifies a small error many times over (chaos), so a reversal soon
// after the partition is lifted brings the gases back apart, a late one doesn't: the errors have grown to the size of
// the molecules. «Пылинка»: a heavy dust grain among the same molecules walks randomly (Brownian motion).
// A coarse-grained mixing measure: the box is cut into a few cells and the binary entropy of the red/blue share in
// each cell is averaged (0 — all apart, 100 % — evenly mixed). Units: the molecule diameter is 1, time in seconds.

namespace Entropy {
  type Mode = "split" | "dust";
  type Phase = "apart" | "mixing";

  const AREA = 500 * 310; // box area in molecule diameters²
  const GAS = 700; // molecules in «Перегородка»
  const GAS_DUST = 1600; // molecules in «Пылинка»
  const SPEED = 30; // thermal speed (per velocity component) of the split gas: sets how long the reversal still works
  const SPEED_DUST = 90;
  const K = 5e4; // spring constant between molecules
  const K_WALL = 4e5; // walls, the partition, the dust grain and fingers are stiffer
  const STEP = 0.0015; // seconds of one Verlet step
  const MAX_STEPS = 34; // per frame
  const DUST_R = 10;
  const DUST_MASS = 60;
  const FINGER_R = 14;
  const TRAIL = 900; // remembered dust positions
  const CELLS_X = 6; // coarse cells of the mixing measure (on the long side)
  const CELLS_Y = 4;
  const RED = "#ff7a85";
  const BLUE = "#6cc4ff";
  const BACKGROUND = "#0d0b1e";

  const ctx = canvas2d();

  let mode: Mode = "split";
  let phase: Phase = "apart";
  let W = 500, H = 310; // box size
  let n = 0; // molecules; the dust grain, when there is one, is index n
  let x = new Float64Array(0), y = new Float64Array(0), vx = new Float64Array(0), vy = new Float64Array(0);
  let ax = new Float64Array(0), ay = new Float64Array(0);
  let gridW = 1, gridH = 1;
  let head = new Int32Array(1), next = new Int32Array(1);
  let wall = true;
  let ticks = 0; // steps since the partition was lifted, counted backwards while time runs back
  let backwards = false;
  let touched = false; // a finger stirred the gas: the reversal can't work any more
  let carry = 0;
  let mixed = 0;
  let scale = 1, ox = 0, oy = 0;
  const trailX = new Float32Array(TRAIL), trailY = new Float32Array(TRAIL);
  let trailLen = 0, trailHead = 0;
  let showMolecules = false;
  const fingers = new Map<number, { x: number; y: number }>();

  // ---------- Sprites: a soft glowing dot per colour ----------

  function sprite(color: string, radius: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    const size = Math.ceil(radius * 2 * view.dpr);
    c.width = c.height = size;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.42, color + "66");
    grad.addColorStop(1, color + "00");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }
  let redDot = sprite(RED, 6), blueDot = sprite(BLUE, 6), greyDot = sprite("#b9b4d8", 5);

  // ---------- Setup ----------

  function layout(): void {
    const area = freeArea();
    const readout = $("readout");
    const top = readout.hidden ? area.y : Math.max(area.y, readout.getBoundingClientRect().bottom + 6);
    const bottom = area.y + area.h;
    const aw = area.w - 24, ah = bottom - top - 8;
    scale = Math.min(aw / W, ah / H);
    ox = (view.w - W * scale) / 2;
    oy = top + (ah - H * scale) / 2 + 4;
    const r = clamp(scale * 2.6, 3.5, 7);
    redDot = sprite(RED, r);
    blueDot = sprite(BLUE, r);
    greyDot = sprite("#b9b4d8", r * 0.8);
  }

  /** The box takes the shape of the free screen area (keeping its area), then a new gas fills it. */
  function reset(): void {
    const area = freeArea();
    const aspect = clamp(area.w / Math.max(1, area.h - 60), 0.62, 2.1);
    W = Math.sqrt(AREA * aspect);
    H = AREA / W;
    const dust = mode === "dust";
    n = dust ? GAS_DUST : GAS;
    const total = n + (dust ? 1 : 0);
    x = new Float64Array(total);
    y = new Float64Array(total);
    vx = new Float64Array(total);
    vy = new Float64Array(total);
    ax = new Float64Array(total);
    ay = new Float64Array(total);
    gridW = Math.ceil(W);
    gridH = Math.ceil(H);
    head = new Int32Array(gridW * gridH);
    next = new Int32Array(total);
    const speed = dust ? SPEED_DUST : SPEED;
    if (dust) {
      x[n] = W / 2;
      y[n] = H / 2;
    }
    // random places without overlaps: red in the left half, blue in the right one (the dust mode doesn't care)
    for (let i = 0; i < n; i++) {
      const left = i < n / 2;
      for (let attempt = 0; attempt < 50; attempt++) {
        x[i] = dust ? rand(1, W - 1) : left ? rand(1, W / 2 - 1) : rand(W / 2 + 1, W - 1);
        y[i] = rand(1, H - 1);
        let free = !dust || Math.hypot(x[i]! - W / 2, y[i]! - H / 2) > DUST_R + 2;
        for (let j = 0; j < i && free; j++) if (Math.abs(x[i]! - x[j]!) < 1.2 && Math.abs(y[i]! - y[j]!) < 1.2) free = false;
        if (free) break;
      }
      vx[i] = gauss() * speed;
      vy[i] = gauss() * speed;
    }
    wall = !dust;
    phase = "apart";
    ticks = 0;
    backwards = false;
    touched = false;
    carry = 0;
    trailLen = 0;
    forces();
    layout();
    updateButtons();
  }

  // ---------- Physics ----------

  function forces(): void {
    ax.fill(0);
    ay.fill(0);
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const c = clamp(Math.floor(y[i]!), 0, gridH - 1) * gridW + clamp(Math.floor(x[i]!), 0, gridW - 1);
      next[i] = head[c]!;
      head[c] = i;
    }
    const r = 0.5;
    for (let i = 0; i < n; i++) {
      const xi = x[i]!, yi = y[i]!;
      const cx = clamp(Math.floor(xi), 0, gridW - 1), cy = clamp(Math.floor(yi), 0, gridH - 1);
      let fx = 0, fy = 0;
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(gridH - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(gridW - 1, cx + 1); gx++) {
          for (let j = head[gy * gridW + gx]!; j >= 0; j = next[j]!) {
            if (j <= i) continue;
            const dx = xi - x[j]!, dy = yi - y[j]!;
            const d2 = dx * dx + dy * dy;
            if (d2 >= 1 || d2 === 0) continue;
            const d = Math.sqrt(d2);
            const f = (K * (1 - d)) / d;
            fx += f * dx;
            fy += f * dy;
            ax[j] = ax[j]! - f * dx;
            ay[j] = ay[j]! - f * dy;
          }
        }
      }
      // walls and the partition: the same kind of spring, only stiffer
      if (xi < r) fx += K_WALL * (r - xi);
      else if (xi > W - r) fx -= K_WALL * (xi - W + r);
      if (yi < r) fy += K_WALL * (r - yi);
      else if (yi > H - r) fy -= K_WALL * (yi - H + r);
      if (wall) {
        const dx = xi - W / 2;
        if (Math.abs(dx) < r) fx += K_WALL * (r - Math.abs(dx)) * Math.sign(dx);
      }
      ax[i] = ax[i]! + fx;
      ay[i] = ay[i]! + fy;
    }
    if (mode === "dust") {
      // the grain: a big heavy disk pushed by every molecule that bumps into it
      const gx0 = x[n]!, gy0 = y[n]!;
      let fx = 0, fy = 0;
      const reach = DUST_R + r;
      for (let i = 0; i < n; i++) {
        const dx = x[i]! - gx0, dy = y[i]! - gy0;
        if (Math.abs(dx) >= reach || Math.abs(dy) >= reach) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= reach * reach || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const f = (K_WALL * (reach - d)) / d;
        ax[i] = ax[i]! + f * dx;
        ay[i] = ay[i]! + f * dy;
        fx -= f * dx;
        fy -= f * dy;
      }
      if (gx0 < DUST_R) fx += K_WALL * (DUST_R - gx0);
      else if (gx0 > W - DUST_R) fx -= K_WALL * (gx0 - W + DUST_R);
      if (gy0 < DUST_R) fy += K_WALL * (DUST_R - gy0);
      else if (gy0 > H - DUST_R) fy -= K_WALL * (gy0 - H + DUST_R);
      ax[n] = fx / DUST_MASS;
      ay[n] = fy / DUST_MASS;
    }
    // fingers: big soft disks that push the molecules (and the grain) away
    for (const f of fingers.values()) {
      const total = mode === "dust" ? n + 1 : n;
      for (let i = 0; i < total; i++) {
        const reach = (i === n ? DUST_R : r) + FINGER_R;
        const dx = x[i]! - f.x, dy = y[i]! - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= reach * reach || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const push = (K_WALL * (reach - d)) / d / (i === n ? DUST_MASS : 1);
        ax[i] = ax[i]! + push * dx;
        ay[i] = ay[i]! + push * dy;
      }
    }
  }

  function step(): void {
    const total = mode === "dust" ? n + 1 : n;
    const h = STEP;
    for (let i = 0; i < total; i++) {
      vx[i] = vx[i]! + 0.5 * h * ax[i]!;
      vy[i] = vy[i]! + 0.5 * h * ay[i]!;
      x[i] = x[i]! + h * vx[i]!;
      y[i] = y[i]! + h * vy[i]!;
    }
    forces();
    for (let i = 0; i < total; i++) {
      vx[i] = vx[i]! + 0.5 * h * ax[i]!;
      vy[i] = vy[i]! + 0.5 * h * ay[i]!;
    }
  }

  /** Flips every velocity: from now on the film runs backwards. */
  function reverse(): void {
    const total = mode === "dust" ? n + 1 : n;
    for (let i = 0; i < total; i++) {
      vx[i] = -vx[i]!;
      vy[i] = -vy[i]!;
    }
    backwards = !backwards;
  }

  /** Average binary entropy of the red share over coarse cells, 0…1. */
  function mixing(): number {
    const cx = W >= H ? CELLS_X : CELLS_Y, cy = W >= H ? CELLS_Y : CELLS_X;
    const red = new Float64Array(cx * cy), all = new Float64Array(cx * cy);
    for (let i = 0; i < n; i++) {
      const c = clamp(Math.floor((y[i]! / H) * cy), 0, cy - 1) * cx + clamp(Math.floor((x[i]! / W) * cx), 0, cx - 1);
      all[c] = all[c]! + 1;
      if (i < n / 2) red[c] = red[c]! + 1;
    }
    let s = 0;
    for (let c = 0; c < cx * cy; c++) {
      const p = red[c]! / (all[c]! || 1);
      if (p > 0 && p < 1) s -= all[c]! * (p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
    }
    return s / n;
  }

  /** Back at the moment the partition was lifted: did the gases come apart again? */
  function arrived(): void {
    backwards = false;
    mixed = mixing();
    if (mixed < 0.08 && !touched) {
      wall = true;
      phase = "apart";
      reverse();
      backwards = false;
      showHint("Получилось! Время повернулось назад");
    } else {
      if (touched) showHint("Палец перемешал молекулы — назад уже не вернуть");
      else if (mixed < 0.3) showHint("Почти! Но часть молекул уже сбилась с пути");
      else showHint("Не вышло: крошечные ошибки выросли, и молекулы сбились с пути");
    }
    updateButtons();
  }

  function advance(dt: number): void {
    carry = Math.min(carry + dt, STEP * MAX_STEPS);
    while (carry >= STEP) {
      carry -= STEP;
      step();
      if (phase !== "mixing" || mode === "dust") continue;
      ticks += backwards ? -1 : 1;
      if (backwards && ticks === 0) {
        arrived();
        break;
      }
    }
    if (mode === "dust") {
      trailX[trailHead] = x[n]!;
      trailY[trailHead] = y[n]!;
      trailHead = (trailHead + 1) % TRAIL;
      trailLen = Math.min(trailLen + 1, TRAIL);
    }
  }

  // ---------- Drawing ----------

  const sx = (bx: number) => ox + bx * scale;
  const sy = (by: number) => oy + (H - by) * scale;

  function roundRect(x0: number, y0: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, r);
  }

  function draw(): void {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, view.w, view.h);
    const bw = W * scale, bh = H * scale;
    // the box: a faint glass tray
    roundRect(ox - 6, oy - 6, bw + 12, bh + 12, 14);
    ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255, 184, 107, 0.7)";
    ctx.shadowColor = "#ffb86b";
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (wall) {
      ctx.fillStyle = "rgba(255, 210, 150, 0.85)";
      ctx.shadowColor = "#ffb86b";
      ctx.shadowBlur = 14;
      ctx.fillRect(sx(W / 2) - 2, oy - 2, 4, bh + 4);
      ctx.shadowBlur = 0;
    }

    ctx.globalCompositeOperation = "lighter";
    if (mode === "split") {
      const s = redDot.width / view.dpr;
      for (let i = 0; i < n; i++) ctx.drawImage(i < n / 2 ? redDot : blueDot, sx(x[i]!) - s / 2, sy(y[i]!) - s / 2, s, s);
    } else {
      if (showMolecules) {
        const s = greyDot.width / view.dpr;
        ctx.globalAlpha = 0.75;
        for (let i = 0; i < n; i++) ctx.drawImage(greyDot, sx(x[i]!) - s / 2, sy(y[i]!) - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
      drawDust();
    }
    ctx.globalCompositeOperation = "source-over";

    for (const f of fingers.values()) {
      ctx.beginPath();
      ctx.arc(sx(f.x), sy(f.y), FINGER_R * scale, 0, TAU);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawDust(): void {
    // the trail: a rainbow line, older parts fainter
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const start = (trailHead - trailLen + TRAIL) % TRAIL;
    const CHUNK = 15; // segments drawn as one path with one colour
    for (let k = 0; k < trailLen - 1; k += CHUNK) {
      const age = (k + CHUNK / 2) / trailLen;
      ctx.strokeStyle = hsl(200 + age * 140, 90, 65, Math.min(1, age) * 0.8);
      ctx.lineWidth = 1 + age * 2.2;
      ctx.beginPath();
      for (let m = k; m <= Math.min(k + CHUNK, trailLen - 1); m++) {
        const a = (start + m) % TRAIL;
        if (m === k) ctx.moveTo(sx(trailX[a]!), sy(trailY[a]!));
        else ctx.lineTo(sx(trailX[a]!), sy(trailY[a]!));
      }
      ctx.stroke();
    }
    const gx = sx(x[n]!), gy = sy(y[n]!), r = DUST_R * scale;
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 2.6);
    glow.addColorStop(0, "rgba(255, 240, 200, 1)");
    glow.addColorStop(0.3, "rgba(255, 200, 120, 0.85)");
    glow.addColorStop(0.42, "rgba(255, 160, 90, 0.3)");
    glow.addColorStop(1, "rgba(255, 140, 80, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(gx, gy, r * 2.6, 0, TAU);
    ctx.fill();
  }

  function readout(): void {
    if (mode === "dust") {
      setReadout(null);
      return;
    }
    if (phase === "mixing") mixed = mixing();
    const pct = Math.round((phase === "apart" ? 0 : mixed) * 100);
    const t = ((ticks * STEP) as number).toFixed(1).replace(".", ",");
    setReadout(`Перемешано: ${pct} %\nВремя: ${t} с${backwards ? " ⏪" : ""}`);
  }

  // ---------- Controls ----------

  /**
   * A hint in answer to a tap or a button: the press itself has just started hiding the old hint (common.ts hides it
   * 0.7 s later), so the new one is shown after that.
   */
  let hintTimer = 0;
  function hintLater(text: string): void {
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => showHint(text), 750);
  }

  addChoice<Mode>(
    [
      { value: "split", label: "🧱 Перегородка", title: "Два газа и перегородка между ними" },
      { value: "dust", label: "✨ Пылинка", title: "Броуновское движение пылинки" },
    ],
    mode,
    (next) => {
      mode = next;
      reset();
      hintLater(mode === "dust" ? "Пылинку толкают невидимые молекулы" : "Убери перегородку — и посмотри, что будет");
    },
  );
  function liftWall(): void {
    wall = false;
    phase = "mixing";
    ticks = 0;
    backwards = false;
    touched = false;
    hintLater("Газы перемешиваются… Скорее нажми «⏪ Повернуть время»!");
    updateButtons();
  }
  const lift = addButton("Убрать перегородку", () => {
    if (phase === "apart") liftWall();
    else reset();
  }, { primary: true });
  const rewind = addButton("⏪ Повернуть время", () => {
    reverse();
    updateButtons();
  });
  const molecules = addButton("👀 Показать молекулы", () => {
    showMolecules = !showMolecules;
    updateButtons();
  });

  function updateButtons(): void {
    const split = mode === "split";
    lift.hidden = !split;
    rewind.hidden = !split;
    molecules.hidden = split;
    lift.textContent = phase === "apart" ? "🧱 Убрать перегородку" : "🧱 Начать сначала";
    lift.classList.toggle("primary", phase === "apart");
    rewind.disabled = phase !== "mixing";
    rewind.textContent = backwards ? "⏩ Вперёд" : "⏪ Повернуть время";
    molecules.textContent = showMolecules ? "🙈 Спрятать молекулы" : "👀 Показать молекулы";
    molecules.classList.toggle("on", showMolecules);
    placeHint();
  }

  // ---------- Input ----------

  const toBox = (px: number, py: number): [number, number] => [(px - ox) / scale, H - (py - oy) / scale];

  onPointer({
    down(p) {
      const [bx, by] = toBox(p.x, p.y);
      if (bx < -FINGER_R || bx > W + FINGER_R || by < -FINGER_R || by > H + FINGER_R) return;
      // a tap on the closed box lifts the partition
      if (mode === "split" && phase === "apart") {
        liftWall();
        return;
      }
      fingers.set(p.id, { x: bx, y: by });
      if (phase === "mixing") touched = true;
    },
    move(p) {
      const f = fingers.get(p.id);
      if (!f) return;
      [f.x, f.y] = toBox(p.x, p.y);
    },
    up(p) {
      fingers.delete(p.id);
    },
  });

  onResize(() => {
    reset();
  });

  // ---------- Loop ----------

  reset();
  startLoop((dt) => {
    if (dt > 0) advance(dt);
    readout();
    draw();
  });
  // the readout panel now has its size: fit the box below it
  readout();
  layout();
  showHint("Убери перегородку — и посмотри, что будет");
}
