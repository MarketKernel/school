// «Три звезды»: Newton's gravity of three (or more) stars, G = 1. Every star pulls every other with the force
// m1·m2 / r², and there is no simple formula for where three stars go: most starts end in chaos with one star thrown
// out. Presets: the figure eight of Chenciner and Montgomery (2000, initial values by Simó), Lagrange's rotating
// equilateral triangle (equal masses — it is unstable, so a 1e-5 nudge makes it fall apart after ~2.5 turns), and Burrau's
// Pythagorean problem (masses 3, 4, 5 at rest at the corners of a 3-4-5 triangle: after ~60 time units the lightest
// star is ejected and 4 and 5 leave as a pair, Szebehely & Peters 1967).
// Method: classic RK4 on all positions and velocities. The step is not tied to the frame: it shrinks in close
// encounters (η·min over pairs of √(r³/(m1+m2)) and r/v, η = 0.001), so the result doesn't depend on the frame rate;
// a tiny softening (ε = 1e-7) only keeps a head-on collision of a thrown star finite. The view follows the centre of
// mass; every star leaves a long fading glowing trail.

namespace ThreeBody {
  type Preset = "eight" | "triangle" | "chaos";

  interface Star {
    m: number;
    colour: string;
    trail: Float32Array; // ring of x, y
    head: number;
    filled: number;
    added: boolean;
    gone: boolean; // thrown out for good: the camera stops following it
  }

  const SOFT2 = 1e-14; // softening ε²: bigger values already change who gets thrown out in «Хаос»
  const ETA = 0.001;
  const MAX_H = 0.004;
  const MAX_STEPS = 25000; // RK4 steps per frame at most: a slow device slows down instead of freezing
  const TRAIL = 900;
  const SAMPLE = 0.012; // time between trail samples
  const MAX_STARS = 9;
  const BG = "#0d0b1e";
  const COLOURS = ["#ffd36b", "#7fd8ff", "#ff8fc8", "#a6ff8f", "#c9a6ff", "#ffb07a", "#8fffe8", "#ff9f9f", "#fff3a6"];
  // per preset: time units per second and the radius of the view in world units
  const SPEED: Record<Preset, number> = { eight: 1.6, triangle: 2.2, chaos: 3.5 };
  const RADIUS: Record<Preset, number> = { eight: 1.25, triangle: 1.9, chaos: 4 };
  const NAMES: Record<Preset, string> = { eight: "∞ Восьмёрка", triangle: "🔺 Треугольник", chaos: "💥 Хаос" };

  const ctx = canvas2d();
  let preset: Preset = "eight";
  let stars: Star[] = [];
  let s = new Float64Array(0); // x, y, vx, vy per star
  let debt = 0; // simulated time still owed to the clock
  let since = 0;
  let scale = 100;
  let cx = 0, cy = 0;
  let comX = 0, comY = 0;
  let sky: [number, number, number][] = [];

  // ---------- Physics ----------

  let k1 = new Float64Array(0), k2 = k1, k3 = k1, k4 = k1, tmp = k1;

  function deriv(src: Float64Array, out: Float64Array): void {
    const n = stars.length;
    for (let i = 0; i < n; i++) {
      out[4 * i] = src[4 * i + 2]!;
      out[4 * i + 1] = src[4 * i + 3]!;
      out[4 * i + 2] = 0;
      out[4 * i + 3] = 0;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = src[4 * j]! - src[4 * i]!, dy = src[4 * j + 1]! - src[4 * i + 1]!;
        const r2 = dx * dx + dy * dy + SOFT2;
        const inv = 1 / (r2 * Math.sqrt(r2));
        out[4 * i + 2]! += stars[j]!.m * dx * inv;
        out[4 * i + 3]! += stars[j]!.m * dy * inv;
        out[4 * j + 2]! -= stars[i]!.m * dx * inv;
        out[4 * j + 3]! -= stars[i]!.m * dy * inv;
      }
    }
  }

  function rk4(h: number): void {
    const L = s.length;
    deriv(s, k1);
    for (let i = 0; i < L; i++) tmp[i] = s[i]! + (h / 2) * k1[i]!;
    deriv(tmp, k2);
    for (let i = 0; i < L; i++) tmp[i] = s[i]! + (h / 2) * k2[i]!;
    deriv(tmp, k3);
    for (let i = 0; i < L; i++) tmp[i] = s[i]! + h * k3[i]!;
    deriv(tmp, k4);
    for (let i = 0; i < L; i++) s[i]! += (h / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!);
  }

  /** The step: a small part of the shortest fall time and of the shortest fly-by time over all pairs. */
  function stepSize(): number {
    let best = MAX_H / ETA;
    const n = stars.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = s[4 * j]! - s[4 * i]!, dy = s[4 * j + 1]! - s[4 * i + 1]!;
        const dvx = s[4 * j + 2]! - s[4 * i + 2]!, dvy = s[4 * j + 3]! - s[4 * i + 3]!;
        const r = Math.sqrt(dx * dx + dy * dy + SOFT2);
        best = Math.min(best, Math.sqrt((r * r * r) / (stars[i]!.m + stars[j]!.m)), r / (Math.hypot(dvx, dvy) + 1e-9));
      }
    }
    return Math.max(1e-9, Math.min(MAX_H, ETA * best));
  }

  function sampleTrails(): void {
    stars.forEach((star, i) => {
      star.head = (star.head + 1) % TRAIL;
      star.trail[star.head * 2] = s[4 * i]!;
      star.trail[star.head * 2 + 1] = s[4 * i + 1]!;
      star.filled = Math.min(TRAIL, star.filled + 1);
    });
  }

  function advance(dt: number): void {
    debt = Math.min(debt + dt * SPEED[preset], 0.5);
    let steps = 0;
    while (debt > 0 && steps < MAX_STEPS) {
      const h = stepSize();
      rk4(h);
      debt -= h;
      since += h;
      steps++;
      if (since >= SAMPLE) {
        since -= SAMPLE;
        sampleTrails();
      }
    }
    if (steps >= MAX_STEPS) debt = 0;
  }

  /** Marks the stars leaving for good: far away, flying away and faster than the escape speed from the others. */
  function checkEjected(): void {
    const n = stars.length;
    for (let i = 0; i < n; i++) {
      if (stars[i]!.gone) continue;
      let m = 0, x = 0, y = 0, vx = 0, vy = 0;
      for (let j = 0; j < n; j++) {
        if (j === i || stars[j]!.gone) continue;
        const mj = stars[j]!.m;
        m += mj;
        x += mj * s[4 * j]!;
        y += mj * s[4 * j + 1]!;
        vx += mj * s[4 * j + 2]!;
        vy += mj * s[4 * j + 3]!;
      }
      if (m === 0) continue;
      const rx = s[4 * i]! - x / m, ry = s[4 * i + 1]! - y / m;
      const ux = s[4 * i + 2]! - vx / m, uy = s[4 * i + 3]! - vy / m;
      const r = Math.hypot(rx, ry);
      if (r > 2 * RADIUS[preset] && rx * ux + ry * uy > 0 && (ux * ux + uy * uy) / 2 > m / r) {
        stars[i]!.gone = true;
      }
    }
  }

  // ---------- Setup ----------

  function setStars(list: { m: number; x: number; y: number; vx: number; vy: number }[]): void {
    stars = [];
    s = new Float64Array(list.length * 4);
    list.forEach((b, i) => addStar(b, false, i));
    debt = since = 0;
  }

  function addStar(b: { m: number; x: number; y: number; vx: number; vy: number }, added: boolean, index = stars.length): void {
    if (index >= s.length / 4) {
      const grown = new Float64Array((index + 1) * 4);
      grown.set(s);
      s = grown;
    }
    s.set([b.x, b.y, b.vx, b.vy], index * 4);
    const used = new Set(stars.map((st) => st.colour));
    const colour = COLOURS.find((c) => !used.has(c)) ?? COLOURS[index % COLOURS.length]!;
    stars[index] = { m: b.m, colour, trail: new Float32Array(TRAIL * 2), head: 0, filled: 0, added, gone: false };
    k1 = new Float64Array(s.length);
    k2 = new Float64Array(s.length);
    k3 = new Float64Array(s.length);
    k4 = new Float64Array(s.length);
    tmp = new Float64Array(s.length);
  }

  function removeStar(index: number): void {
    stars.splice(index, 1);
    const rest = new Float64Array(stars.length * 4);
    rest.set(s.subarray(0, index * 4));
    rest.set(s.subarray(index * 4 + 4), index * 4);
    s = rest;
  }

  function start(next: Preset): void {
    preset = next;
    if (preset === "eight") {
      const x = 0.97000436, y = 0.24308753, vx = 0.93240737, vy = 0.86473146;
      setStars([
        { m: 1, x: -x, y, vx: vx / 2, vy: vy / 2 },
        { m: 1, x, y: -y, vx: vx / 2, vy: vy / 2 },
        { m: 1, x: 0, y: 0, vx: -vx, vy: -vy },
      ]);
    } else if (preset === "triangle") {
      // equal masses on a circle of radius 1: ω² = 3Gm / side³ = 1/√3
      const w = Math.sqrt(1 / Math.sqrt(3));
      setStars([0, 1, 2].map((k) => {
        const a = (k * TAU) / 3 + Math.PI / 2;
        const r = k === 0 ? 1 + 1e-5 : 1; // the nudge: one star 0.00001 further out
        return { m: 1, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: -w * Math.sin(a), vy: w * Math.cos(a) };
      }));
    } else {
      setStars([
        { m: 3, x: 1, y: 3, vx: 0, vy: 0 },
        { m: 4, x: -2, y: -1, vx: 0, vy: 0 },
        { m: 5, x: 1, y: -1, vx: 0, vy: 0 },
      ]);
    }
    centreOfMass(0, true);
    layout();
  }

  // ---------- Drawing ----------

  function layout(): void {
    const area = freeArea();
    cx = area.x + area.w / 2;
    cy = area.y + area.h / 2;
    scale = (Math.min(area.w, area.h) * 0.47) / RADIUS[preset];
    sky = [];
    for (let i = 0; i < 180; i++) sky.push([rand(0, view.w), rand(0, view.h), rand(0, TAU)]);
  }

  const toScreenX = (x: number) => cx + (x - comX) * scale;
  const toScreenY = (y: number) => cy - (y - comY) * scale;
  const radiusOf = (m: number) => 3 + 2.5 * Math.cbrt(m);

  /** The camera follows the centre of mass of the stars still dancing (a thrown-out star flies off the screen). */
  function centreOfMass(dt: number, snap: boolean): void {
    let m = 0, x = 0, y = 0;
    stars.forEach((star, i) => {
      if (star.gone) return;
      m += star.m;
      x += star.m * s[4 * i]!;
      y += star.m * s[4 * i + 1]!;
    });
    if (!m) return;
    const k = snap ? 1 : 1 - Math.exp(-dt * 2);
    comX += (x / m - comX) * k;
    comY += (y / m - comY) * k;
  }

  function drawTrail(star: Star): void {
    // chunks from the newest backwards; each is drawn wide and faint (glow) and thin and bright
    const CHUNK = 30;
    for (let a = 0; a < star.filled - 1; a += CHUNK) {
      const fade = 1 - a / TRAIL;
      ctx.beginPath();
      for (let b = a; b <= Math.min(a + CHUNK, star.filled - 1); b++) {
        const o = ((star.head - b + TRAIL) % TRAIL) * 2;
        const x = toScreenX(star.trail[o]!), y = toScreenY(star.trail[o + 1]!);
        if (b === a) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = star.colour;
      ctx.globalAlpha = 0.12 * fade * fade;
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.globalAlpha = 0.85 * fade * fade;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawStar(star: Star, i: number, time: number): void {
    const x = toScreenX(s[4 * i]!), y = toScreenY(s[4 * i + 1]!);
    const r = radiusOf(star.m);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
    glow.addColorStop(0, star.colour);
    glow.addColorStop(0.25, star.colour + "66");
    glow.addColorStop(1, star.colour + "00");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 5 * (1 + 0.05 * Math.sin(time * 3 + i)), 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, TAU);
    ctx.fill();
  }

  function drawAim(p: Pointer): void {
    // the new star sits where the press started; the band goes to the finger, the arrow shows where it will fly
    const dx = p.startX - p.x, dy = p.startY - p.y;
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.startX, p.startY);
    ctx.stroke();
    ctx.setLineDash([]);
    const ex = p.startX + dx, ey = p.startY + dy;
    ctx.strokeStyle = "#ffe6a8";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.startX, p.startY);
    ctx.lineTo(ex, ey);
    const a = Math.atan2(dy, dx);
    if (Math.hypot(dx, dy) > 12) {
      ctx.moveTo(ex - 12 * Math.cos(a - 0.5), ey - 12 * Math.sin(a - 0.5));
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex - 12 * Math.cos(a + 0.5), ey - 12 * Math.sin(a + 0.5));
    }
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "#ffe6a8";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(p.startX, p.startY, radiusOf(1), 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  startLoop((dt, time) => {
    if (dt > 0) {
      advance(dt);
      checkEjected();
    }
    centreOfMass(dt, false);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, view.w, view.h);
    for (const [x, y, phase] of sky) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.25 + 0.2 * Math.sin(time * 1.3 + phase)})`;
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const star of stars) drawTrail(star);
    stars.forEach((star, i) => drawStar(star, i, time));
    ctx.globalCompositeOperation = "source-over";
    if (aiming) drawAim(aiming);
    const gone = stars.filter((star) => star.gone).length;
    setReadout(`${label(preset)} · звёзд: ${stars.length}` + (gone ? `\nУлетело: ${gone}` : ""));
  });

  // ---------- Input and controls ----------

  let aiming: Pointer | null = null;
  onPointer({
    down(p) {
      aiming = p;
    },
    up(p) {
      if (aiming !== p) return;
      aiming = null;
      // pull back like a slingshot: the star flies away from the finger
      const k = 1.3 / scale;
      const vx = (p.startX - p.x) * k * Math.sqrt(RADIUS[preset]);
      const vy = -(p.startY - p.y) * k * Math.sqrt(RADIUS[preset]);
      // the new star moves with the centre of mass, plus the throw
      let m = 0, ux = 0, uy = 0;
      stars.forEach((star, i) => {
        m += star.m;
        ux += star.m * s[4 * i + 2]!;
        uy += star.m * s[4 * i + 3]!;
      });
      if (stars.length >= MAX_STARS) {
        const oldest = stars.findIndex((star) => star.added);
        removeStar(oldest >= 0 ? oldest : 0);
      }
      const x = comX + (p.startX - cx) / scale, y = comY - (p.startY - cy) / scale;
      addStar({ m: 1, x, y, vx: vx + (m ? ux / m : 0), vy: vy + (m ? uy / m : 0) }, true);
    },
  });

  // on a phone the names don't fit in one row: only the emoji there, the name is in the readout
  const narrow = matchMedia("(max-width: 700px)").matches;
  const label = (p: Preset) => (narrow ? NAMES[p].split(" ")[0]! : NAMES[p]);
  addChoice<Preset>(
    [
      { value: "eight", label: label("eight"), title: "Три звезды гоняются друг за другом по восьмёрке" },
      { value: "triangle", label: label("triangle"), title: "Треугольник Лагранжа: кружится, пока не развалится" },
      { value: "chaos", label: label("chaos"), title: "Пифагорова задача: звёзды 3, 4 и 5 отпустили из покоя" },
    ],
    preset,
    start,
  );
  addButton("🔄", () => start(preset), { round: true, title: "Начать сначала" });

  onResize(layout);
  start(preset);
  showHint("Нажми, оттяни и отпусти — как из рогатки вылетит новая звезда");
}
