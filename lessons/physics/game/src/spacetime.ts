// «Батут пространства»: the rubber-sheet picture of gravity. A glowing grid sags under the stars like a trampoline
// under heavy balls; its depth is the gravitational potential, h = −K · Σ M / √(r² + ε²). Planets roll on it like
// marbles circling a funnel. Their motion is honest 2D Newtonian gravity, a = Σ G·M·(r⃗ᵢ − r⃗) / (|r⃗ᵢ − r⃗|² + s²)^(3/2),
// integrated with a leapfrog step (kick-drift-kick, a few sub-steps per frame), and only drawn on the curved sheet.
// The planets are test bodies (they feel the stars, the stars don't feel them); two stars attract each other and
// circle their common centre of mass, wobbling the sheet. The camera looks down at the sheet in perspective; a pointer
// is mapped back onto the sagging sheet by intersecting its ray with the surface (a few fixed-point iterations).

namespace Spacetime {
  interface Star {
    x: number;
    z: number;
    vx: number;
    vz: number;
    m: number;
    hue: number;
    held: boolean;
  }
  interface Planet {
    x: number;
    z: number;
    vx: number;
    vz: number;
    hue: number;
    size: number;
    trail: Float32Array; // ring buffer of x, z
    head: number;
    filled: number;
  }
  interface Flash {
    x: number;
    z: number;
    age: number;
    hue: number;
  }

  const G = 1.15; // a planet at r = 1 around the big star circles in about 6 s
  const SOFT = 0.05; // softening of the force
  const DEPTH_K = 0.34; // sheet depth scale
  const DEPTH_EPS = 0.22; // how wide the bottom of a dip is
  const HALF = 2.5; // the sheet is the square [−HALF, HALF]²
  const FIT = 1.55; // this circle of the sheet must be seen whole
  const LINES = 38;
  const SAMPLES = 110; // points along one grid line
  const TRAIL = 180;
  const MAX_PLANETS = 14;
  const SUBSTEPS = 10;
  const EAT = 0.11; // a planet this close to a star falls into it
  const PITCH = 0.92; // camera angle above the sheet, radians (a bit steeper on a tall screen)
  const CAM_DIST = 5.6;
  const THROW = 1.7; // speed per sheet unit of drag
  const COLOURS = 6; // depth levels of the grid colour
  const FADES = 4; // levels of the fade at the rim

  const ctx = canvas2d();
  let stars: Star[] = [];
  let planets: Planet[] = [];
  let flashes: Flash[] = [];
  let backdrop: HTMLCanvasElement | null = null;
  let yaw = 0;
  let pitch = PITCH;
  let focal = 300;
  let cx = 0;
  let cy = 0;
  let nextHue = 0;
  // camera frame (recomputed when yaw changes)
  const cam = { x: 0, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fy: 0, fz: 0, ux: 0, uy: 0, uz: 0 };

  // ---------- The sheet ----------

  function height(x: number, z: number, list: Star[] = stars): number {
    let h = 0;
    for (const s of list) {
      const dx = x - s.x, dz = z - s.z;
      h -= (DEPTH_K * s.m) / Math.sqrt(dx * dx + dz * dz + DEPTH_EPS * DEPTH_EPS);
    }
    return h;
  }

  function setCamera(): void {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    cam.x = CAM_DIST * cp * Math.sin(yaw);
    cam.y = CAM_DIST * sp;
    cam.z = CAM_DIST * cp * Math.cos(yaw);
    // forward points at the sheet centre, a little below the flat level so the dip sits in the middle
    const tx = 0, ty = -0.35, tz = 0;
    let fx = tx - cam.x, fy = ty - cam.y, fz = tz - cam.z;
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl;
    fy /= fl;
    fz /= fl;
    cam.fx = fx;
    cam.fy = fy;
    cam.fz = fz;
    cam.rx = Math.cos(yaw);
    cam.rz = -Math.sin(yaw);
    // up = right × forward
    cam.ux = -cam.rz * fy;
    cam.uy = cam.rz * fx - cam.rx * fz;
    cam.uz = cam.rx * fy;
  }

  /** Projects a world point; returns false when it is behind the camera. Writes screen x, y and the depth. */
  const out = { x: 0, y: 0, d: 1 };
  function project(x: number, y: number, z: number): boolean {
    const qx = x - cam.x, qy = y - cam.y, qz = z - cam.z;
    const d = qx * cam.fx + qy * cam.fy + qz * cam.fz;
    if (d < 0.1) return false;
    out.d = d;
    out.x = cx + (focal * (qx * cam.rx + qz * cam.rz)) / d;
    out.y = cy - (focal * (qx * cam.ux + qy * cam.uy + qz * cam.uz)) / d;
    return true;
  }

  /** The point of the sagging sheet under a screen point: the pointer ray meets the surface. */
  function toSheet(sx: number, sy: number): [number, number] {
    const a = (sx - cx) / focal, b = -(sy - cy) / focal;
    const dx = cam.fx + a * cam.rx + b * cam.ux;
    const dy = cam.fy + b * cam.uy;
    const dz = cam.fz + a * cam.rz + b * cam.uz;
    let level = 0;
    let x = 0, z = 0;
    for (let i = 0; i < 8; i++) {
      const t = (level - cam.y) / dy;
      x = cam.x + dx * t;
      z = cam.z + dz * t;
      level = lerp(level, height(x, z), 0.7);
    }
    return [x, z];
  }

  function layout(): void {
    const area = freeArea();
    cx = area.x + area.w / 2;
    cy = area.y + area.h / 2;
    pitch = area.h > area.w * 1.3 ? PITCH + 0.14 : PITCH;
    setCamera();
    // fit the circle of radius FIT around the centre, on the flat sheet, into the free area
    focal = 1;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * TAU;
      project(Math.cos(a) * FIT, 0, Math.sin(a) * FIT);
      minX = Math.min(minX, out.x - cx);
      maxX = Math.max(maxX, out.x - cx);
      minY = Math.min(minY, out.y - cy);
      maxY = Math.max(maxY, out.y - cy);
    }
    project(0, height(0, 0) - 0.2, 0);
    maxY = Math.max(maxY, out.y - cy);
    focal = Math.min((area.w * (area.h > area.w ? 0.56 : 0.48)) / Math.max(-minX, maxX), (area.h * 0.47) / Math.max(-minY, maxY));
    // centre the fitted shape vertically
    cy = area.y + area.h / 2 - ((minY + maxY) / 2) * focal;
    paintBackdrop();
  }

  /** The night sky behind the sheet, painted once per size. */
  function paintBackdrop(): void {
    backdrop = document.createElement("canvas");
    backdrop.width = Math.round(view.w * view.dpr);
    backdrop.height = Math.round(view.h * view.dpr);
    const b = backdrop.getContext("2d")!;
    b.scale(view.dpr, view.dpr);
    const g = b.createRadialGradient(cx, cy, 0, cx, cy, Math.max(view.w, view.h) * 0.75);
    g.addColorStop(0, "#1d1740");
    g.addColorStop(0.55, "#110e28");
    g.addColorStop(1, "#07060f");
    b.fillStyle = g;
    b.fillRect(0, 0, view.w, view.h);
    for (let i = 0; i < 260; i++) {
      const r = Math.random() ** 3 * 1.4 + 0.3;
      b.fillStyle = hsl(rand(200, 300), 60, 85, rand(0.25, 0.8));
      b.beginPath();
      b.arc(rand(0, view.w), rand(0, view.h), r, 0, TAU);
      b.fill();
    }
  }

  // Grid segments sorted into a few colour × fade buckets, so the whole grid is a few dozen strokes
  const buckets: Path2D[] = [];

  function drawGrid(): void {
    buckets.length = 0;
    for (let i = 0; i < COLOURS * FADES; i++) buckets.push(new Path2D());
    const step = (2 * HALF) / (SAMPLES - 1);
    for (let dir = 0; dir < 2; dir++) {
      for (let l = 0; l < LINES; l++) {
        const c = -HALF + (l / (LINES - 1)) * 2 * HALF;
        let px = 0, py = 0, ok = false;
        for (let k = 0; k < SAMPLES; k++) {
          const u = -HALF + k * step;
          const x = dir ? c : u, z = dir ? u : c;
          const r = Math.hypot(x, z);
          const h = height(x, z);
          const visible = project(x, h, z) && r < HALF;
          if (visible && ok) {
            const fade = clamp((HALF - r) / (HALF - FIT * 0.9), 0, 0.999);
            const deep = clamp(-h / 1.35, 0, 0.999);
            if (fade > 0.02) {
              const path = buckets[Math.floor(deep * COLOURS) * FADES + Math.floor(fade * FADES)]!;
              path.moveTo(px, py);
              path.lineTo(out.x, out.y);
            }
          }
          px = out.x;
          py = out.y;
          ok = visible;
        }
      }
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let c = 0; c < COLOURS; c++) {
      const t = (c + 0.5) / COLOURS;
      // cool cyan on the flat sheet, violet and pink down the slope, hot orange at the bottom of the dip
      const hue = 195 + t * 195;
      const light = 55 + t * 15;
      for (let f = 0; f < FADES; f++) {
        const path = buckets[c * FADES + f]!;
        const a = ((f + 0.5) / FADES) ** 1.5;
        ctx.strokeStyle = hsl(hue, 95, light, 0.13 * a * (1 + t));
        ctx.lineWidth = 5;
        ctx.stroke(path);
        ctx.strokeStyle = hsl(hue, 100, light + 10, 0.55 * a * (0.8 + t * 0.6));
        ctx.lineWidth = 1.2;
        ctx.stroke(path);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- Bodies ----------

  function makePlanet(x: number, z: number, vx: number, vz: number): Planet {
    const p: Planet = { x, z, vx, vz, hue: nextHue, size: rand(0.055, 0.075), trail: new Float32Array(TRAIL * 2), head: 0, filled: 0 };
    nextHue = (nextHue + 67) % 360;
    planets.push(p);
    if (planets.length > MAX_PLANETS) planets.shift();
    return p;
  }

  /** A planet on a near-circular orbit around the first star, radius r, start angle a, speed factor k. */
  function orbitPlanet(r: number, a: number, k: number): void {
    const s = stars[0]!;
    const v = Math.sqrt((G * s.m) / r) * k;
    makePlanet(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r, -Math.sin(a) * v, Math.cos(a) * v);
  }

  function accel(x: number, z: number, list: Star[], skip: Star | null = null): [number, number] {
    let ax = 0, az = 0;
    for (const s of list) {
      if (s === skip) continue;
      const dx = s.x - x, dz = s.z - z;
      const d2 = dx * dx + dz * dz + SOFT * SOFT;
      const f = (G * s.m) / (d2 * Math.sqrt(d2));
      ax += f * dx;
      az += f * dz;
    }
    return [ax, az];
  }

  /** One leapfrog step of the stars (they pull each other; a held star stays put). */
  function stepStars(list: Star[], dt: number): void {
    if (list.length < 2) return;
    for (const s of list) {
      if (s.held) continue;
      const [ax, az] = accel(s.x, s.z, list, s);
      s.vx += ax * dt;
      s.vz += az * dt;
    }
    for (const s of list) {
      if (s.held) continue;
      s.x += s.vx * dt;
      s.z += s.vz * dt;
    }
  }

  function stepPlanet(p: { x: number; z: number; vx: number; vz: number }, list: Star[], dt: number): void {
    let [ax, az] = accel(p.x, p.z, list);
    p.vx += ax * dt * 0.5;
    p.vz += az * dt * 0.5;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    [ax, az] = accel(p.x, p.z, list);
    p.vx += ax * dt * 0.5;
    p.vz += az * dt * 0.5;
  }

  function simulate(dt: number): void {
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      stepStars(stars, h);
      for (const p of planets) stepPlanet(p, stars, h);
    }
    // swallowed by a star or flown away
    planets = planets.filter((p) => {
      for (const s of stars) {
        if (Math.hypot(p.x - s.x, p.z - s.z) < EAT) {
          flashes.push({ x: s.x, z: s.z, age: 0, hue: p.hue });
          return false;
        }
      }
      return Math.hypot(p.x, p.z) < HALF * 1.6;
    });
    for (const p of planets) {
      p.trail[p.head * 2] = p.x;
      p.trail[p.head * 2 + 1] = p.z;
      p.head = (p.head + 1) % TRAIL;
      p.filled = Math.min(TRAIL, p.filled + 1);
    }
    for (const f of flashes) f.age += dt;
    flashes = flashes.filter((f) => f.age < 1.2);
    // keep a lone star from drifting off the middle forever
    if (stars.length === 1) {
      const s = stars[0]!;
      s.vx = s.vz = 0;
    }
  }

  /** A binary: both stars on circular orbits around their common centre of mass. */
  function circularise(): void {
    if (stars.length < 2) return;
    const [a, b] = stars as [Star, Star];
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.max(0.25, Math.hypot(dx, dz));
    const m = a.m + b.m;
    const w = Math.sqrt((G * m) / (d * d * d));
    const nx = -dz / d, nz = dx / d; // perpendicular to the line between them
    a.vx = -nx * w * d * (b.m / m);
    a.vz = -nz * w * d * (b.m / m);
    b.vx = nx * w * d * (a.m / m);
    b.vz = nz * w * d * (a.m / m);
  }

  function reset(): void {
    stars = [{ x: 0, z: 0, vx: 0, vz: 0, m: 1, hue: 42, held: false }];
    planets = [];
    flashes = [];
    nextHue = 190;
    orbitPlanet(0.5, 0.3, 1);
    orbitPlanet(0.82, 2.4, 0.97);
    orbitPlanet(1.15, 4.4, 1.03);
    orbitPlanet(1.5, 1.2, 0.92);
    orbitPlanet(1.0, 5.6, 0.72); // an eccentric one that swoops deep into the funnel
    // run a few seconds ahead so the first picture already has trails
    for (let i = 0; i < 150; i++) simulate(1 / 60);
    starButton.textContent = "⭐ + Звезда";
  }

  function toggleStar(): void {
    if (stars.length === 1) {
      const s = stars[0]!;
      stars.push({ x: s.x + 0.75, z: s.z - 0.2, vx: 0, vz: 0, m: 0.65, hue: 205, held: false });
      circularise();
      starButton.textContent = "⭐ − Звезда";
    } else {
      stars.pop();
      const s = stars[0]!;
      s.vx = s.vz = 0;
      starButton.textContent = "⭐ + Звезда";
    }
  }

  // ---------- Drawing ----------

  function drawTrail(p: Planet): void {
    if (p.filled < 2) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const chunk = 12;
    const start = (p.head - p.filled + TRAIL) % TRAIL;
    for (let c = 0; c < p.filled - 1; c += chunk) {
      ctx.beginPath();
      let first = true;
      for (let k = c; k <= Math.min(c + chunk, p.filled - 1); k++) {
        const i = (start + k) % TRAIL;
        const x = p.trail[i * 2]!, z = p.trail[i * 2 + 1]!;
        if (!project(x, height(x, z) + 0.01, z)) continue;
        if (first) ctx.moveTo(out.x, out.y);
        else ctx.lineTo(out.x, out.y);
        first = false;
      }
      const t = (c + chunk) / p.filled;
      ctx.strokeStyle = hsl(p.hue, 95, 65, 0.65 * t * t);
      ctx.lineWidth = 1 + 2.2 * t;
      ctx.stroke();
    }
  }

  function drawBall(x: number, y: number, z: number, radius: number, hue: number, light: number): void {
    if (!project(x, y, z)) return;
    const r = Math.max(3, (focal * radius) / out.d);
    const glow = ctx.createRadialGradient(out.x, out.y, 0, out.x, out.y, r * 3);
    glow.addColorStop(0, hsl(hue, 100, 70, 0.55));
    glow.addColorStop(1, hsl(hue, 100, 60, 0));
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = glow;
    ctx.fillRect(out.x - r * 3, out.y - r * 3, r * 6, r * 6);
    ctx.globalCompositeOperation = "source-over";
    const g = ctx.createRadialGradient(out.x - r * 0.35, out.y - r * 0.4, r * 0.1, out.x, out.y, r);
    g.addColorStop(0, hsl(hue, 100, Math.min(97, light + 30)));
    g.addColorStop(0.6, hsl(hue, 90, light));
    g.addColorStop(1, hsl(hue, 80, light - 25));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(out.x, out.y, r, 0, TAU);
    ctx.fill();
  }

  function drawStar(s: Star, time: number): void {
    const y = height(s.x, s.z) + 0.05;
    if (!project(s.x, y, s.z)) return;
    const r = (focal * 0.13 * Math.sqrt(s.m)) / out.d;
    const pulse = 1 + 0.06 * Math.sin(time * 3 + s.hue);
    ctx.globalCompositeOperation = "lighter";
    const corona = ctx.createRadialGradient(out.x, out.y, r * 0.5, out.x, out.y, r * 6 * pulse);
    corona.addColorStop(0, hsl(s.hue, 100, 70, 0.75));
    corona.addColorStop(0.25, hsl(s.hue + 10, 100, 60, 0.25));
    corona.addColorStop(1, hsl(s.hue + 20, 100, 50, 0));
    ctx.fillStyle = corona;
    ctx.fillRect(out.x - r * 7, out.y - r * 7, r * 14, r * 14);
    const core = ctx.createRadialGradient(out.x, out.y, 0, out.x, out.y, r * 1.1);
    core.addColorStop(0, "rgba(255, 255, 255, 1)");
    core.addColorStop(0.55, hsl(s.hue, 100, 85, 1));
    core.addColorStop(1, hsl(s.hue, 100, 60, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(out.x, out.y, r * 1.1, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  function drawFlashes(): void {
    ctx.globalCompositeOperation = "lighter";
    for (const f of flashes) {
      if (!project(f.x, height(f.x, f.z), f.z)) continue;
      const r = (focal * (0.1 + f.age * 0.6)) / out.d;
      ctx.strokeStyle = hsl(f.hue, 100, 70, 1 - f.age / 1.2);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(out.x, out.y, r, r * Math.sin(pitch), 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- Throwing ----------

  interface Aim {
    kind: "throw" | "star";
    star?: Star;
    x0: number;
    z0: number;
    x: number;
    z: number;
    // smoothed velocity of a dragged star, for its release
    vx: number;
    vz: number;
  }
  const aims = new Map<number, Aim>();

  /** The path a planet thrown now would take: a dotted preview of the next few seconds. */
  function drawPreview(a: Aim): void {
    const vx = (a.x - a.x0) * THROW, vz = (a.z - a.z0) * THROW;
    const ghost = stars.map((s) => ({ ...s }));
    const p = { x: a.x0, z: a.z0, vx, vz };
    ctx.fillStyle = hsl(nextHue, 100, 80, 0.9);
    const dt = 1 / 120;
    for (let i = 1; i <= 300; i++) {
      stepStars(ghost, dt);
      stepPlanet(p, ghost, dt);
      if (ghost.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < EAT)) break;
      if (i % 6 === 0 && project(p.x, height(p.x, p.z) + 0.01, p.z)) {
        const r = 3.2 * (1 - i / 380);
        ctx.beginPath();
        ctx.arc(out.x, out.y, r, 0, TAU);
        ctx.fill();
      }
    }
    // the aim arrow
    if (project(a.x0, height(a.x0, a.z0) + 0.02, a.z0)) {
      const sx = out.x, sy = out.y;
      if (project(a.x, height(a.x, a.z) + 0.02, a.z)) {
        ctx.strokeStyle = "rgba(255, 184, 107, 0.9)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(out.x, out.y);
        ctx.stroke();
      }
    }
    drawBall(a.x0, height(a.x0, a.z0) + 0.06, a.z0, 0.065, nextHue, 62);
  }

  onPointer({
    down(p) {
      const [x, z] = toSheet(p.x, p.y);
      // a star is grabbed when the press is near its glowing core on the screen
      let grabbed: Star | undefined;
      for (const s of stars) {
        if (!project(s.x, height(s.x, s.z) + 0.05, s.z)) continue;
        const reach = Math.max(34, (focal * 0.3) / out.d);
        if (Math.hypot(out.x - p.x, out.y - p.y) < reach && !s.held) grabbed = s;
      }
      if (grabbed) {
        grabbed.held = true;
        grabbed.vx = grabbed.vz = 0;
        aims.set(p.id, { kind: "star", star: grabbed, x0: grabbed.x, z0: grabbed.z, x: grabbed.x, z: grabbed.z, vx: 0, vz: 0 });
      } else {
        aims.set(p.id, { kind: "throw", x0: x, z0: z, x, z, vx: 0, vz: 0 });
      }
    },
    move(p) {
      const a = aims.get(p.id);
      if (!a) return;
      const [x, z] = toSheet(p.x, p.y);
      a.x = x;
      a.z = z;
      if (a.kind === "star" && a.star) {
        const s = a.star;
        const lim = HALF * 0.8;
        s.x = clamp(x, -lim, lim);
        s.z = clamp(z, -lim, lim);
      }
    },
    up(p) {
      const a = aims.get(p.id);
      aims.delete(p.id);
      if (!a) return;
      if (a.kind === "star" && a.star) {
        a.star.held = false;
        circularise();
      } else {
        let vx = (a.x - a.x0) * THROW, vz = (a.z - a.z0) * THROW;
        const v = Math.hypot(vx, vz);
        if (v > 3) {
          vx *= 3 / v;
          vz *= 3 / v;
        }
        makePlanet(a.x0, a.z0, vx, vz);
      }
    },
  });

  // ---------- Loop and controls ----------

  startLoop((dt, time) => {
    yaw = 0.28 * Math.sin(time * 0.07);
    setCamera();
    if (dt > 0) simulate(dt);
    if (backdrop) {
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(backdrop, 0, 0, view.w, view.h);
    }
    drawGrid();
    ctx.globalCompositeOperation = "lighter";
    for (const p of planets) drawTrail(p);
    ctx.globalCompositeOperation = "source-over";
    // far things first: sort stars and planets by their distance from the camera
    const items: { d: number; draw: () => void }[] = [];
    for (const s of stars) {
      if (project(s.x, 0, s.z)) items.push({ d: out.d, draw: () => drawStar(s, time) });
    }
    for (const p of planets) {
      if (project(p.x, 0, p.z)) items.push({ d: out.d, draw: () => drawBall(p.x, height(p.x, p.z) + p.size, p.z, p.size, p.hue, 62) });
    }
    items.sort((a, b) => b.d - a.d);
    for (const it of items) it.draw();
    drawFlashes();
    for (const a of aims.values()) if (a.kind === "throw") drawPreview(a);
  });

  const starButton = addButton("⭐ + Звезда", toggleStar, { title: "Добавить вторую звезду или убрать её" });
  addButton("🔄", reset, { round: true, title: "Начать сначала" });
  onResize(layout);
  layout();
  reset();
  showHint("Проведи пальцем по батуту — и запусти планету");
}
