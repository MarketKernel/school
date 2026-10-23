// «Бабочка Лоренца»: the Lorenz system, the simplest model of air heated from below,
//   x' = σ(y − x),  y' = x(ρ − z) − y,  z' = xy − βz,  σ = 10, ρ = 28, β = 8/3.
// Thousands of points start on a tiny rainbow segment (0.01 long) and follow the flow. For a few loops they move as
// one white dot; then the segment is stretched and folded again and again until the rainbow covers both wings of the
// butterfly. With ρ below about 24.7 the flow settles into two resting points and the chaos switches off.
// Method: classic RK4 with a fixed step in Lorenz time units; every point keeps a short history for its glowing trail,
// re-projected every frame through the orbit rotation with a mild perspective. Drawn with additive blending in colour
// groups and age bands (a few strokes for thousands of trails).

namespace Lorenz {
  type Mode = "cloud" | "line";

  const SIGMA = 10;
  const BETA = 8 / 3;
  const POINTS = 2400;
  const TRAIL = 12; // history samples per point
  const SAMPLE = 0.008; // Lorenz time between samples
  const SPEED = 0.8; // Lorenz time units per second
  const H = 0.004; // RK4 step
  const SEGMENT = 0.01; // length of the starting segment
  const LONG = 6000; // samples of the single long line
  const GROUPS = 40; // colour groups
  const BANDS = 3; // age bands of a trail
  const BG = "#0d0b1e";

  const ctx = canvas2d();
  const orbit = orbitControl({ yaw: 0.35, pitch: 0.12, spin: 0.1, minZoom: 0.6, maxZoom: 3 });

  let mode: Mode = "cloud";
  let rho = 28;
  const pos = new Float64Array(POINTS * 3);
  const hist = new Float32Array(POINTS * TRAIL * 3);
  let head = 0; // the ring slot written last
  let filled = 0; // how many history samples exist
  let since = 0; // Lorenz time since the last sample
  let elapsed = 0;
  // the single point of the line mode and its long history
  const one = new Float64Array(3);
  const line = new Float32Array(LONG * 3);
  let lineHead = 0;
  let lineFilled = 0;
  // a faint long trajectory: the shape of the butterfly behind the cloud, also used to pick where a tap starts
  let ghost = new Float32Array(0);
  const colours: string[] = [];
  for (let k = 0; k < GROUPS; k++) colours.push(hsl((k / (GROUPS - 1)) * 300, 100, 62));

  const out = [0, 0, 0];
  /** One RK4 step of the Lorenz flow on p[o…o+2]. */
  function step(p: Float64Array, o: number, h: number): void {
    const x = p[o]!, y = p[o + 1]!, z = p[o + 2]!;
    const f = (x: number, y: number, z: number) => {
      out[0] = SIGMA * (y - x);
      out[1] = x * (rho - z) - y;
      out[2] = x * y - BETA * z;
    };
    f(x, y, z);
    const k1x = out[0]!, k1y = out[1]!, k1z = out[2]!;
    f(x + (h / 2) * k1x, y + (h / 2) * k1y, z + (h / 2) * k1z);
    const k2x = out[0]!, k2y = out[1]!, k2z = out[2]!;
    f(x + (h / 2) * k2x, y + (h / 2) * k2y, z + (h / 2) * k2z);
    const k3x = out[0]!, k3y = out[1]!, k3z = out[2]!;
    f(x + h * k3x, y + h * k3y, z + h * k3z);
    p[o] = x + (h / 6) * (k1x + 2 * k2x + 2 * k3x + out[0]!);
    p[o + 1] = y + (h / 6) * (k1y + 2 * k2y + 2 * k3y + out[1]!);
    p[o + 2] = z + (h / 6) * (k1z + 2 * k2z + 2 * k3z + out[2]!);
  }

  function traceGhost(): void {
    const p = new Float64Array([1, 1, 20]);
    for (let i = 0; i < 250; i++) step(p, 0, H);
    ghost = new Float32Array(5000 * 3);
    for (let i = 0; i < 5000; i++) {
      for (let s = 0; s < 3; s++) step(p, 0, H);
      ghost.set(p, i * 3);
    }
  }

  /** A new cloud: all points on a tiny segment through (x, y, z), its rainbow running along it. */
  function release(x: number, y: number, z: number): void {
    for (let i = 0; i < POINTS; i++) {
      const t = (i / (POINTS - 1) - 0.5) * SEGMENT;
      pos[i * 3] = x + t;
      pos[i * 3 + 1] = y + t;
      pos[i * 3 + 2] = z;
    }
    one.set([x, y, z]);
    filled = 0;
    lineFilled = 0;
    since = 0;
    elapsed = 0;
  }

  function restart(): void {
    // a point on the butterfly from where the cloud makes a few loops together before it splits
    const p = new Float64Array([1, 1, 1]);
    for (let i = 0; i < 6000; i++) step(p, 0, 0.005);
    release(p[0]!, p[1]!, p[2]!);
  }

  function advance(dt: number): void {
    const steps = Math.min(40, Math.max(1, Math.round((dt * SPEED) / H)));
    for (let s = 0; s < steps; s++) {
      if (mode === "cloud") for (let i = 0; i < POINTS; i++) step(pos, i * 3, H);
      step(one, 0, H);
      since += H;
      if (since >= SAMPLE) {
        since -= SAMPLE;
        head = (head + 1) % TRAIL;
        for (let i = 0; i < POINTS; i++) hist.set(pos.subarray(i * 3, i * 3 + 3), (i * TRAIL + head) * 3);
        filled = Math.min(TRAIL, filled + 1);
      }
      lineHead = (lineHead + 1) % LONG;
      line.set(one, lineHead * 3);
      lineFilled = Math.min(LONG, lineFilled + 1);
    }
    elapsed += dt;
  }

  // ---------- Projection ----------

  let cx = 0, cy = 0, scale = 1;
  let cyaw = 1, syaw = 0, cpit = 1, spit = 0;
  const DEPTH = 110; // camera distance, Lorenz units
  let sx = 0, sy = 0;
  /** Projects a Lorenz point into (sx, sy): x to the right, z up, around the middle of the butterfly. */
  function project(x: number, y: number, z: number): void {
    const X = x, Y = z - 25, Z = y;
    const x1 = cyaw * X + syaw * Z;
    const z1 = -syaw * X + cyaw * Z;
    const y2 = cpit * Y - spit * z1;
    const z2 = spit * Y + cpit * z1;
    const f = (DEPTH / (DEPTH - z2)) * scale;
    sx = cx + x1 * f;
    sy = cy - y2 * f;
  }

  let freeW = 1, freeH = 1;
  function layout(): void {
    const area = freeArea();
    cx = area.x + area.w / 2;
    cy = area.y + area.h / 2;
    freeW = area.w;
    freeH = area.h;
  }

  // ---------- Drawing ----------

  function drawGhost(): void {
    ctx.strokeStyle = "rgba(180, 170, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < ghost.length / 3; i++) {
      project(ghost[i * 3]!, ghost[i * 3 + 1]!, ghost[i * 3 + 2]!);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  function drawCloud(): void {
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    const per = Math.ceil(TRAIL / BANDS);
    for (let band = 0; band < BANDS; band++) {
      ctx.globalAlpha = [0.75, 0.35, 0.12][band]!;
      for (let k = 0; k < GROUPS; k++) {
        ctx.beginPath();
        for (let i = Math.floor((k * POINTS) / GROUPS); i < Math.floor(((k + 1) * POINTS) / GROUPS); i++) {
          // band 0 runs from the point itself back through the newest samples, the next bands further back
          let first = true;
          if (band === 0) {
            project(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
            ctx.moveTo(sx, sy);
            first = false;
          }
          for (let a = band * per; a <= Math.min((band + 1) * per, filled - 1); a++) {
            const o = (i * TRAIL + ((head - a + TRAIL) % TRAIL)) * 3;
            project(hist[o]!, hist[o + 1]!, hist[o + 2]!);
            if (first) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
            first = false;
          }
        }
        ctx.strokeStyle = colours[k]!;
        ctx.stroke();
      }
    }
    // bright heads
    ctx.globalAlpha = 0.9;
    for (let k = 0; k < GROUPS; k++) {
      ctx.fillStyle = colours[k]!;
      for (let i = Math.floor((k * POINTS) / GROUPS); i < Math.floor(((k + 1) * POINTS) / GROUPS); i++) {
        project(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawLine(): void {
    // the long line in chunks: old parts fade and turn blue, the newest part is warm and bright
    const CHUNK = 120;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    for (let start = lineFilled - 1; start > 0; start -= CHUNK) {
      const age = (lineFilled - 1 - start) / LONG;
      ctx.beginPath();
      for (let a = start; a >= Math.max(0, start - CHUNK); a--) {
        const o = ((lineHead - (lineFilled - 1 - a) + LONG) % LONG) * 3;
        project(line[o]!, line[o + 1]!, line[o + 2]!);
        if (a === start) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = hsl(30 + age * 230, 95, 64, 0.2 + 0.8 * (1 - age) ** 1.5);
      ctx.stroke();
    }
    project(one[0]!, one[1]!, one[2]!);
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "#ffb86b";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  startLoop((dt) => {
    if (dt > 0) advance(dt);
    orbit.step(dt);
    cyaw = Math.cos(orbit.yaw);
    syaw = Math.sin(orbit.yaw);
    cpit = Math.cos(orbit.pitch);
    spit = Math.sin(orbit.pitch);
    scale = ((Math.min(freeW, freeH) * 0.5) / 30) * orbit.zoom;

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.globalCompositeOperation = "lighter";
    drawGhost();
    if (mode === "cloud") drawCloud();
    else drawLine();
    ctx.globalCompositeOperation = "source-over";
    const calm = rho < 24.74 ? "\nХаос выключен" : "";
    setReadout(`Прошло: ${Math.floor(elapsed)} с${calm}`);
  });

  // a tap (not a drag that turns the butterfly) releases a new cloud at the nearest point of the butterfly
  onPointer({
    up(p) {
      if (Math.hypot(p.x - p.startX, p.y - p.startY) > 8 || pointers.size > 0) return;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < ghost.length / 3; i += 2) {
        project(ghost[i * 3]!, ghost[i * 3 + 1]!, ghost[i * 3 + 2]!);
        const d = (sx - p.x) ** 2 + (sy - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      release(ghost[best * 3]!, ghost[best * 3 + 1]!, ghost[best * 3 + 2]!);
    },
  });

  addChoice<Mode>(
    [
      { value: "cloud", label: "✨ Облако", title: "Тысячи точек из одного места" },
      { value: "line", label: "🦋 Линия", title: "Одна точка рисует длинный след" },
    ],
    mode,
    (next) => {
      mode = next;
      restart();
    },
  );
  addSlider({
    label: "🔥 Нагрев",
    min: 10,
    max: 40,
    step: 0.5,
    value: rho,
    title: "Число ρ: как сильно воздух нагревают снизу",
    format: (v) => String(v).replace(".", ","),
    onInput: (v) => {
      rho = v;
      traceGhost();
    },
  });
  addButton("🔄", () => restart(), { round: true, title: "Запустить ещё раз" });

  onResize(layout);
  layout();
  traceGhost();
  restart();
  showHint("Нажми на бабочку — оттуда вылетит новое облако. Тяни, чтобы повернуть");
}
