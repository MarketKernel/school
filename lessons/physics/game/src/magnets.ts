// «Магнитное поле»: bar magnets and the field around them. Each magnet is modelled as a pair of magnetic charges
// (Gilbert's model) near its ends: +1 at the north pole, −1 at the south pole, each giving B = q·r̂ / r² like a point
// charge in 3D (the paper with filings lies on the magnets, so the 3D law, not a 2D one). Far away this is exactly a
// dipole field; near the ends it bends the way it does around a real bar. Fields of all magnets simply add up.
// Three ways to see it:
//   «Опилки» — iron filings: thousands of headless needles that turn along B (they are tiny magnets themselves),
//              brighter where |B| is larger; they turn with a little lag when a magnet moves, like on shaken paper;
//   «Компасы» — a grid of compass needles: a damped torsion pendulum each, θ'' = K·|B|·sin(θ_B − θ) − c·θ', so they
//              swing past the field and settle (north end red, pointing along B: towards the south poles);
//   «Линии»  — tracers that leave the north poles and run along B̂ (midpoint steps) into the south poles; their fading
//              trails draw the field lines.

namespace Magnets {
  type View = "filings" | "compass" | "lines";

  interface Magnet {
    x: number;
    y: number;
    angle: number; // the direction from S to N
    target: number; // the angle it turns to after a tap
    spin: number; // angular velocity of that turn
    grow: number; // 0 → 1 when it appears
  }

  const MAX_MAGNETS = 4;
  const POLE = 0.36; // pole charges at ±POLE·length from the middle
  const SOFT = 0.08; // softening of the pole charges, share of the length
  const TRACERS = 420;
  const TRACER_SPEED = 150; // px/s
  const BACK = "#0d0b1e";

  const ctx = canvas2d(2);
  let magnets: Magnet[] = [];
  let look: View = "filings";
  let length = 150; // magnet length in px
  let width = 44;
  let reference = 1; // the |B| that counts as «strong»
  let dirty = true;

  // ---------- Field ----------

  const field = (x: number, y: number): [number, number] => {
    let bx = 0, by = 0;
    const soft2 = (length * SOFT) ** 2;
    for (const m of magnets) {
      const c = Math.cos(m.angle) * length * POLE * m.grow, s = Math.sin(m.angle) * length * POLE * m.grow;
      // north pole (+1) at the front, south pole (−1) at the back
      let dx = x - (m.x + c), dy = y - (m.y + s);
      let r2 = dx * dx + dy * dy + soft2;
      let k = m.grow / (r2 * Math.sqrt(r2));
      bx += dx * k;
      by += dy * k;
      dx = x - (m.x - c);
      dy = y - (m.y - s);
      r2 = dx * dx + dy * dy + soft2;
      k = m.grow / (r2 * Math.sqrt(r2));
      bx -= dx * k;
      by -= dy * k;
    }
    return [bx, by];
  };

  /** 0 (no field) … 1 (right at a pole) */
  const strength = (bx: number, by: number): number => 1 - Math.exp(-Math.hypot(bx, by) / reference);

  // ---------- Filings ----------

  let filingX = new Float32Array(0);
  let filingY = new Float32Array(0);
  let filingA = new Float32Array(0); // headless: an angle mod π
  let filingS = new Float32Array(0); // shown strength
  let filingJ = new Float32Array(0); // extra jiggle that dies away

  function placeFilings(): void {
    const n = Math.round(clamp((view.w * view.h) / 120, 2000, 7000));
    filingX = new Float32Array(n);
    filingY = new Float32Array(n);
    filingA = new Float32Array(n);
    filingS = new Float32Array(n);
    filingJ = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      filingX[i] = rand(0, view.w);
      filingY[i] = rand(0, view.h);
      filingA[i] = rand(0, Math.PI);
    }
  }

  /** Turns every filing towards the field; dt = 0 snaps at once. */
  function stepFilings(dt: number): void {
    const k = dt > 0 ? 1 - Math.exp(-dt * 9) : 1;
    for (let i = 0; i < filingX.length; i++) {
      const [bx, by] = field(filingX[i]!, filingY[i]!);
      const target = Math.atan2(by, bx);
      // the shortest turn for a needle without head or tail
      let d = target - filingA[i]!;
      d -= Math.PI * Math.round(d / Math.PI);
      filingA[i] = filingA[i]! + d * k + (dt > 0 ? filingJ[i]! * gauss() * dt * 4 : 0);
      filingJ[i] = filingJ[i]! * Math.exp(-dt * 5);
      filingS[i] = strength(bx, by);
    }
  }

  /** A shake of the paper: filings jump a little and settle again. */
  function shake(power: number): void {
    for (let i = 0; i < filingJ.length; i++) filingJ[i] = Math.max(filingJ[i]!, power * rand(0.5, 1));
  }

  function drawFilings(): void {
    const levels = 8;
    const paths: Path2D[] = [];
    for (let l = 0; l < levels; l++) paths.push(new Path2D());
    for (let i = 0; i < filingX.length; i++) {
      const s = filingS[i]!;
      if (s < 0.04) continue;
      const level = Math.min(levels - 1, Math.floor(s * levels));
      const half = 3 + 4.5 * Math.sqrt(s);
      const c = Math.cos(filingA[i]!) * half, sn = Math.sin(filingA[i]!) * half;
      const p = paths[level]!;
      p.moveTo(filingX[i]! - c, filingY[i]! - sn);
      p.lineTo(filingX[i]! + c, filingY[i]! + sn);
    }
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "lighter";
    for (let l = 0; l < levels; l++) {
      const t = (l + 0.5) / levels;
      // weak field: dim lavender dust; strong field: warm golden-white
      ctx.strokeStyle = `rgba(${Math.round(lerp(150, 255, t))}, ${Math.round(lerp(140, 226, t))}, ${Math.round(lerp(210, 170, t))}, ${0.08 + 0.92 * t})`;
      ctx.lineWidth = 0.9 + 0.7 * t;
      ctx.stroke(paths[l]!);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- Compasses ----------

  let compassX = new Float32Array(0);
  let compassY = new Float32Array(0);
  let compassA = new Float32Array(0);
  let compassW = new Float32Array(0);
  let compassS = new Float32Array(0);
  let spacing = 50;

  function placeCompasses(): void {
    spacing = view.w < 700 ? 44 : 54;
    const cols = Math.floor(view.w / spacing), rows = Math.floor(view.h / spacing);
    const ox = (view.w - (cols - 1) * spacing) / 2, oy = (view.h - (rows - 1) * spacing) / 2;
    const n = cols * rows;
    compassX = new Float32Array(n);
    compassY = new Float32Array(n);
    compassA = new Float32Array(n);
    compassW = new Float32Array(n);
    compassS = new Float32Array(n);
    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i++) {
        compassX[i] = ox + c * spacing;
        compassY[i] = oy + r * spacing;
        compassA[i] = rand(-Math.PI, Math.PI);
      }
    }
  }

  function stepCompasses(dt: number): void {
    for (let i = 0; i < compassX.length; i++) {
      const [bx, by] = field(compassX[i]!, compassY[i]!);
      const s = strength(bx, by);
      compassS[i] = s;
      const target = Math.atan2(by, bx);
      let d = target - compassA[i]!;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (dt === 0) {
        if (dirty) compassA[i] = target;
        continue;
      }
      // a springy needle: stiffer in a strong field, lightly damped so it swings past and settles
      const stiff = 25 + 160 * s;
      const sub = 3;
      for (let k = 0; k < sub; k++) {
        const h = dt / sub;
        const e = Math.atan2(Math.sin(target - compassA[i]!), Math.cos(target - compassA[i]!));
        compassW[i] = compassW[i]! + (stiff * Math.sin(e) - 3.2 * compassW[i]!) * h;
        compassA[i] = compassA[i]! + compassW[i]! * h;
      }
    }
  }

  function drawCompasses(): void {
    const r = spacing * 0.4;
    ctx.globalCompositeOperation = "source-over";
    // dials
    ctx.beginPath();
    for (let i = 0; i < compassX.length; i++) {
      ctx.moveTo(compassX[i]! + r, compassY[i]!);
      ctx.arc(compassX[i]!, compassY[i]!, r, 0, TAU);
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.035)";
    ctx.fill();
    ctx.strokeStyle = "rgba(201, 192, 230, 0.16)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // needles: the north half red, the south half pale blue, brighter in a strong field
    const north = new Path2D(), south = new Path2D();
    const glow = new Path2D();
    for (let i = 0; i < compassX.length; i++) {
      const x = compassX[i]!, y = compassY[i]!;
      const c = Math.cos(compassA[i]!), s = Math.sin(compassA[i]!);
      const len = r * 0.92, half = r * 0.2;
      north.moveTo(x + c * len, y + s * len);
      north.lineTo(x - s * half, y + c * half);
      north.lineTo(x + s * half, y - c * half);
      north.closePath();
      south.moveTo(x - c * len, y - s * len);
      south.lineTo(x - s * half, y + c * half);
      south.lineTo(x + s * half, y - c * half);
      south.closePath();
      if (compassS[i]! > 0.35) {
        glow.moveTo(x + r * 0.9, y);
        glow.arc(x, y, r * 0.9, 0, TAU);
      }
    }
    ctx.fillStyle = "rgba(255, 184, 107, 0.07)";
    ctx.fill(glow);
    ctx.fillStyle = "#ff6b6b";
    ctx.fill(north);
    ctx.fillStyle = "#cfe0ff";
    ctx.fill(south);
    ctx.beginPath();
    for (let i = 0; i < compassX.length; i++) {
      ctx.moveTo(compassX[i]! + 2.2, compassY[i]!);
      ctx.arc(compassX[i]!, compassY[i]!, 2.2, 0, TAU);
    }
    ctx.fillStyle = "#3d2b2f";
    ctx.fill();
  }

  // ---------- Field lines ----------

  const trails = document.createElement("canvas");
  const trailCtx = trails.getContext("2d")!;
  const tx = new Float32Array(TRACERS);
  const ty = new Float32Array(TRACERS);
  const tAge = new Float32Array(TRACERS);
  const tHue = new Float32Array(TRACERS);
  const tAlive = new Uint8Array(TRACERS);
  let fadeClock = 0;

  function spawn(i: number): void {
    if (!magnets.length) return;
    const m = magnets[i % magnets.length]!;
    const a = rand(0, TAU);
    const r = length * 0.06;
    tx[i] = m.x + Math.cos(m.angle) * length * POLE + Math.cos(a) * r;
    ty[i] = m.y + Math.sin(m.angle) * length * POLE + Math.sin(a) * r;
    tAge[i] = rand(-1.5, 0); // a staggered start, so they don't leave in one wave
    tHue[i] = (a / TAU) * 360;
    tAlive[i] = 1;
  }

  function stepLines(dt: number): void {
    const g = trailCtx;
    // the trails fade: what was drawn a second ago is almost gone. The fade goes in steps of 15%: tiny steps would
    // leave faint ghosts behind, as 8-bit alpha stops shrinking once a step rounds to zero
    fadeClock += dt * 2.2;
    if (fadeClock >= 0.15) {
      fadeClock -= 0.15;
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = "rgba(0, 0, 0, 0.15)";
      g.fillRect(0, 0, view.w, view.h);
    }
    g.globalCompositeOperation = "lighter";
    const buckets: Path2D[] = [];
    for (let b = 0; b < 12; b++) buckets.push(new Path2D());
    const h = TRACER_SPEED * dt;
    for (let i = 0; i < TRACERS; i++) {
      if (!tAlive[i]) spawn(i);
      tAge[i] = tAge[i]! + dt;
      if (tAge[i]! < 0) continue;
      const x = tx[i]!, y = ty[i]!;
      // midpoint step along the field direction
      let [bx, by] = field(x, y);
      let n = Math.hypot(bx, by) || 1;
      const mx = x + (bx / n) * h * 0.5, my = y + (by / n) * h * 0.5;
      [bx, by] = field(mx, my);
      n = Math.hypot(bx, by) || 1;
      const nx = x + (bx / n) * h, ny = y + (by / n) * h;
      tx[i] = nx;
      ty[i] = ny;
      const bucket = Math.floor(tHue[i]! / 30) % 12;
      buckets[bucket]!.moveTo(x, y);
      buckets[bucket]!.lineTo(nx, ny);
      // into a south pole, off the screen or too old: start again at a north pole
      let done = nx < -40 || ny < -40 || nx > view.w + 40 || ny > view.h + 40 || tAge[i]! > 9;
      for (const m of magnets) {
        const sx = m.x - Math.cos(m.angle) * length * POLE, sy = m.y - Math.sin(m.angle) * length * POLE;
        if ((nx - sx) ** 2 + (ny - sy) ** 2 < (length * 0.07) ** 2) done = true;
      }
      if (done) tAlive[i] = 0;
    }
    g.lineCap = "round";
    g.lineWidth = 1.8;
    for (let b = 0; b < 12; b++) {
      g.strokeStyle = hsl(b * 30 + 15, 90, 70, 0.9);
      g.stroke(buckets[b]!);
    }
    g.globalCompositeOperation = "source-over";
  }

  function clearLines(): void {
    trailCtx.setTransform(1, 0, 0, 1, 0, 0);
    trailCtx.clearRect(0, 0, trails.width, trails.height);
    trailCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    tAlive.fill(0);
  }

  // ---------- Magnets ----------

  /** A point in the magnet's own frame: x along it (towards N), y across. */
  function local(m: Magnet, x: number, y: number): [number, number] {
    const c = Math.cos(m.angle), s = Math.sin(m.angle);
    const dx = x - m.x, dy = y - m.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  const handleOf = (m: Magnet): [number, number] => {
    const d = width / 2 + 24;
    return [m.x + Math.sin(m.angle) * d, m.y - Math.cos(m.angle) * d];
  };

  function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawMagnet(m: Magnet, active: boolean): void {
    const L = length * (0.6 + 0.4 * m.grow), W = width * (0.6 + 0.4 * m.grow);
    ctx.save();
    ctx.globalAlpha = m.grow;
    // the rotation knob, tied to the magnet by a thin line
    const [hx, hy] = handleOf(m);
    ctx.strokeStyle = "rgba(255, 248, 236, 0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.x - Math.sin(m.angle) * -W / 2, m.y + Math.cos(m.angle) * -W / 2);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = active ? "rgba(255, 184, 107, 0.95)" : "rgba(28, 23, 56, 0.85)";
    ctx.strokeStyle = active ? "#e8954a" : "rgba(255, 255, 255, 0.35)";
    ctx.beginPath();
    ctx.arc(hx, hy, 13, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? "#3d2b2f" : "#fdf6ec";
    ctx.font = "800 15px Nunito, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("↻", hx, hy + 1);

    ctx.translate(m.x, m.y);
    ctx.rotate(m.angle);
    ctx.shadowColor = "rgba(255, 160, 200, 0.35)";
    ctx.shadowBlur = 24;
    roundRect(ctx, -L / 2, -W / 2, L, W, W * 0.28);
    ctx.fillStyle = "#222";
    ctx.fill();
    ctx.shadowBlur = 0;
    // south half (back) blue, north half (front) red, each with a soft shine
    ctx.save();
    ctx.clip();
    const south = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    south.addColorStop(0, "#8fb3ff");
    south.addColorStop(0.45, "#4f7cf0");
    south.addColorStop(1, "#2c4cb0");
    ctx.fillStyle = south;
    ctx.fillRect(-L / 2, -W / 2, L / 2, W);
    const north = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    north.addColorStop(0, "#ffa3a3");
    north.addColorStop(0.45, "#f05454");
    north.addColorStop(1, "#b02c3a");
    ctx.fillStyle = north;
    ctx.fillRect(0, -W / 2, L / 2, W);
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    ctx.fillRect(-L / 2, -W / 2 + W * 0.1, L, W * 0.16);
    ctx.restore();
    roundRect(ctx, -L / 2, -W / 2, L, W, W * 0.28);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // letters stay upright-ish: turn them back by the magnet's angle
    ctx.fillStyle = "#fff";
    ctx.font = `900 ${Math.round(W * 0.52)}px Nunito, system-ui, sans-serif`;
    for (const [label, x] of [["N", L / 4], ["S", -L / 4]] as [string, number][]) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(-m.angle);
      ctx.fillText(label, 0, 1);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- Layout and frame ----------

  function layout(): void {
    const s = Math.min(view.w, view.h);
    length = clamp(s * 0.26, 96, 180);
    width = length * 0.3;
    reference = 1 / (length * 1.1) ** 2;
    trails.width = stage.width;
    trails.height = stage.height;
    trailCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    tAlive.fill(0);
    placeFilings();
    placeCompasses();
    dirty = true;
  }

  function reset(): void {
    const area = freeArea();
    const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
    const wide = area.w > area.h;
    // two magnets facing each other N to S: the lines run from one into the other
    magnets = wide
      ? [
          { x: cx - length * 0.85, y: cy + length * 0.1, angle: 0.12, target: 0.12, spin: 0, grow: 1 },
          { x: cx + length * 0.85, y: cy - length * 0.1, angle: -0.35, target: -0.35, spin: 0, grow: 1 },
        ]
      : [
          { x: cx - length * 0.1, y: cy + length * 0.85, angle: -Math.PI / 2 - 0.15, target: -Math.PI / 2 - 0.15, spin: 0, grow: 1 },
          { x: cx + length * 0.15, y: cy - length * 0.85, angle: -Math.PI / 2 + 0.35, target: -Math.PI / 2 + 0.35, spin: 0, grow: 1 },
        ];
    clearLines();
    shake(1);
    dirty = true;
    updateAdd();
  }

  // pointer state: which magnet each finger holds, and how
  const grips = new Map<number, { m: Magnet; mode: "move" | "turn"; ox: number; oy: number; moved: boolean }>();
  let active: Magnet | null = null;

  function stepMagnets(dt: number): void {
    for (const m of magnets) {
      if (m.grow < 1) {
        m.grow = Math.min(1, m.grow + dt * 2.5);
        dirty = true;
      }
      const turning = [...grips.values()].some((g) => g.m === m && g.mode === "turn");
      if (!turning && Math.abs(m.target - m.angle) > 1e-3) {
        // a springy turn with a little overshoot
        m.spin += ((m.target - m.angle) * 90 - m.spin * 11) * dt;
        m.angle += m.spin * dt;
        dirty = true;
      } else if (!turning) m.spin = 0;
    }
  }

  startLoop((dt) => {
    stepMagnets(dt);
    const moving = dt > 0;
    if (!moving && !dirty) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BACK;
    ctx.fillRect(0, 0, view.w, view.h);
    if (look === "filings") {
      stepFilings(dt);
      drawFilings();
    } else if (look === "compass") {
      stepCompasses(dt);
      drawCompasses();
    } else {
      if (moving) stepLines(dt);
      ctx.drawImage(trails, 0, 0, view.w, view.h);
    }
    for (const m of magnets) drawMagnet(m, m === active);
    dirty = false;
  });

  // ---------- Controls and touch ----------

  const narrow = view.w < 500; // on a phone the three choices fit in one row only without the emoji
  addChoice<View>(
    [
      { value: "filings", label: `${narrow ? "" : "✨ "}Опилки`, title: "Железные опилки выстраиваются вдоль поля" },
      { value: "compass", label: `${narrow ? "" : "🧭 "}Компасы`, title: "Стрелки компасов показывают, куда направлено поле" },
      { value: "lines", label: `${narrow ? "" : "🌈 "}Линии`, title: "Линии поля бегут от северного полюса к южному" },
    ],
    look,
    (next) => {
      look = next;
      if (look === "lines") clearLines();
      if (look === "filings") shake(1);
      dirty = true;
    },
  );
  const addButtonEl = addButton("+ Магнит", () => {
    if (magnets.length >= MAX_MAGNETS) return;
    const area = freeArea();
    // a free spot: the farthest of a few random tries from the other magnets
    let best = { x: area.x + area.w / 2, y: area.y + area.h / 2 }, bestD = -1;
    for (let k = 0; k < 30; k++) {
      const x = rand(area.x + length * 0.7, area.x + area.w - length * 0.7);
      const y = rand(area.y + length * 0.5, area.y + area.h - length * 0.5);
      const d = Math.min(...magnets.map((m) => Math.hypot(m.x - x, m.y - y)));
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    const angle = Math.round(rand(0, 8)) * (Math.PI / 4);
    magnets.push({ ...best, angle, target: angle, spin: 0, grow: 0 });
    shake(0.8);
    updateAdd();
  }, { title: "Добавить магнит (до четырёх)" });
  function updateAdd(): void {
    addButtonEl.disabled = magnets.length >= MAX_MAGNETS;
  }
  addButton("🔄", reset, { round: true, title: "Начать сначала" });

  function pick(x: number, y: number): { m: Magnet; mode: "move" | "turn" } | null {
    for (let i = magnets.length - 1; i >= 0; i--) {
      const m = magnets[i]!;
      const [hx, hy] = handleOf(m);
      if (Math.hypot(x - hx, y - hy) < 24) return { m, mode: "turn" };
      const [lx, ly] = local(m, x, y);
      if (Math.abs(lx) < length / 2 + 8 && Math.abs(ly) < width / 2 + 10) return { m, mode: "move" };
    }
    return null;
  }

  onPointer({
    down(p) {
      // a second finger on a held magnet turns it
      const held = [...grips.values()].find((g) => g.mode === "move");
      const hit = pick(p.x, p.y);
      if (!hit && held && pointers.size === 2) {
        grips.set(p.id, { m: held.m, mode: "turn", ox: Math.atan2(p.y - held.m.y, p.x - held.m.x) - held.m.angle, oy: 0, moved: true });
        return;
      }
      if (!hit) {
        if (look === "filings") shake(0.6);
        if (look === "compass") for (let i = 0; i < compassW.length; i++) compassW[i] = compassW[i]! + gauss() * 4;
        return;
      }
      const { m, mode } = hit;
      // the touched magnet goes on top
      magnets = magnets.filter((o) => o !== m).concat(m);
      active = m;
      grips.set(p.id, mode === "move"
        ? { m, mode, ox: m.x - p.x, oy: m.y - p.y, moved: false }
        : { m, mode, ox: Math.atan2(p.y - m.y, p.x - m.x) - m.angle, oy: 0, moved: true });
      dirty = true;
    },
    move(p) {
      const g = grips.get(p.id);
      if (!g || !p.down) return;
      if (g.mode === "move") {
        if (Math.hypot(p.x - p.startX, p.y - p.startY) > 6) g.moved = true;
        if (!g.moved) return;
        const area = freeArea();
        g.m.x = clamp(p.x + g.ox, 0, view.w);
        g.m.y = clamp(p.y + g.oy, area.y * 0.5, view.h - 20);
      } else {
        g.m.angle = Math.atan2(p.y - g.m.y, p.x - g.m.x) - g.ox;
        g.m.target = g.m.angle;
      }
      dirty = true;
    },
    up(p) {
      const g = grips.get(p.id);
      grips.delete(p.id);
      if (!g) return;
      // a tap (no drag) on a magnet turns it by 45°
      if (g.mode === "move" && !g.moved) g.m.target = g.m.angle + Math.PI / 4;
      else if (look === "filings") shake(0.5);
      if (![...grips.values()].some((o) => o.m === g.m)) active = null;
      dirty = true;
    },
  });
  stage.addEventListener("wheel", (e) => {
    const hit = pick(e.offsetX, e.offsetY);
    if (!hit) return;
    e.preventDefault();
    hit.m.target += Math.sign(e.deltaY) * (Math.PI / 16);
    dirty = true;
  }, { passive: false });
  onResize(() => {
    layout();
    for (const m of magnets) {
      m.x = clamp(m.x, 0, view.w);
      m.y = clamp(m.y, 0, view.h);
    }
  });

  layout();
  reset();
  showHint("Двигай магниты, нажми на магнит — он повернётся");
}
