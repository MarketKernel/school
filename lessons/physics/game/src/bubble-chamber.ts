// «Пузырьковая камера»: a bubble chamber in a magnetic field, the way CERN photographed particles in the 1960s–80s.
// A charged particle boils a trail of tiny bubbles in the superheated liquid; the field B (perpendicular to the
// screen) bends it into a circle of radius r = p / (0.3 · B) (r in metres, momentum p in GeV/c, B in tesla) — the
// sign of the charge decides which way it turns. Each step the particle loses energy by ionisation (Bethe: ∝ 1/β², so
// slow heavy particles leave dense tracks and stop), so electrons wind into tightening spirals; multiple scattering
// (Highland: θ ≈ 13.6 MeV / (βp) · √(x/X₀)) makes the slow ends curly. The loss is that of a heavy liquid (freon, as
// in Gargamelle), somewhat stronger for electrons so the spirals fit on the screen.
// Events: π⁻/K⁻ beams with δ-electrons (tiny curls kicked out of atoms), interaction stars (π± and protons, π⁰ → γγ,
// neutral K⁰ / Λ), γ → e⁺e⁻ conversions (a pair from nowhere: the photon is invisible), bremsstrahlung of fast
// electrons (small showers), V⁰ decays with exact two-body kinematics (K⁰ → π⁺π⁻, Λ → pπ⁻) and the π → μ → e chain
// of a stopped π⁺. Particles move at a few metres per second so the tracks grow before the eye.
// Drawing: each bubble is a dot with its birth time; old bubbles are redrawn onto a «film» canvas a few times a
// second, batched into one path per brightness level, and only the young ones every frame.

namespace BubbleChamber {
  const M = { e: 0.000511, mu: 0.10566, pi: 0.13957, K: 0.49368, p: 0.93827, K0: 0.49761, L: 1.11568 };
  const CHAMBER = 2.4; // metres across the long side of the screen
  const SPEED = 3.2; // m/s on the screen for β = 1
  const LOSS_H = 0.03; // GeV/m of a minimum-ionising hadron or muon
  const LOSS_E = 0.075; // GeV/m of an electron
  const X0 = 1.2; // radiation length for the scattering, m
  const KE_MIN = 0.0008; // GeV: below this a particle stops
  const DELTA_RATE = 1.8; // δ-electrons per metre of a fast track
  const BREMS_RATE = 0.9; // photons per metre of a fast electron
  const BUBBLE_LIFE = 6.5; // seconds until a bubble has faded
  const FRESH = 0.6; // younger bubbles are drawn every frame, brighter
  const FILM_EVERY = 6; // frames between redraws of the old bubbles
  const MAX_PARTICLES = 170;
  const BEAM_EVERY = 4.2; // seconds
  const LEVELS = 10; // brightness levels of the old bubbles
  const TINT = ["rgb(185, 225, 255)", "rgb(255, 208, 186)"]; // negative, positive
  const BACK = "#05070d";

  interface Particle {
    x: number; // CSS px
    y: number;
    a: number; // direction, radians (screen: y down)
    p: number; // GeV/c
    m: number; // GeV
    q: number; // −1, 0, +1
    kind: string;
    life: number; // metres left before a neutral decays or a beam particle interacts
    carry: number; // bubbles owed (Poisson process)
    gen: number; // shower generation
  }

  const ctx = canvas2d(2);
  const isPhone = Math.min(screen.width, screen.height) < 600;
  const MAX_BUBBLES = isPhone ? 30000 : 50000;
  const bx = new Float32Array(MAX_BUBBLES);
  const by = new Float32Array(MAX_BUBBLES);
  const bt = new Float32Array(MAX_BUBBLES);
  const bs = new Float32Array(MAX_BUBBLES);
  const bq = new Uint8Array(MAX_BUBBLES);
  let head = 0;
  let filled = 0;

  let particles: Particle[] = [];
  let born: Particle[] = [];
  const flashes: { x: number; y: number; t: number; r: number }[] = [];
  let field = 1.5; // tesla
  let ppm = 400; // pixels per metre
  let now = 0;
  let nextBeam = 1.0;
  let nextEvent = 0.2;
  let frame = 0;
  let filmTime = -1e9; // the film holds every bubble born before filmTime − FRESH
  let dirty = true;

  const background = document.createElement("canvas");
  const film = document.createElement("canvas");
  const filmCtx = film.getContext("2d")!;

  /** The lit liquid: a dark teal glow, reference crosses on the glass like on the real photos, a little grain. */
  function paintBackground(): void {
    // the film is kept at one pixel per CSS pixel: cheaper, and upscaled it gives soft round bubbles like a photo
    background.width = film.width = Math.round(view.w);
    background.height = film.height = Math.round(view.h);
    const g = background.getContext("2d")!;
    g.fillStyle = BACK;
    g.fillRect(0, 0, view.w, view.h);
    const glow = g.createRadialGradient(view.w * 0.5, view.h * 0.48, 0, view.w * 0.5, view.h * 0.5, Math.hypot(view.w, view.h) * 0.6);
    glow.addColorStop(0, "rgba(34, 62, 74, 0.85)");
    glow.addColorStop(0.55, "rgba(16, 30, 42, 0.6)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, view.w, view.h);
    const step = Math.max(90, Math.min(view.w, view.h) / 4.5);
    g.strokeStyle = "rgba(170, 200, 215, 0.2)";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = step / 2; x < view.w; x += step) {
      for (let y = step / 2; y < view.h; y += step) {
        g.moveTo(x - 5, y);
        g.lineTo(x + 5, y);
        g.moveTo(x, y - 5);
        g.lineTo(x, y + 5);
      }
    }
    g.stroke();
    for (let i = 0; i < (view.w * view.h) / 60; i++) {
      g.fillStyle = `rgba(180, 210, 225, ${rand(0.02, 0.07)})`;
      g.fillRect(rand(0, view.w), rand(0, view.h), 1, 1);
    }
  }

  function layout(): void {
    ppm = Math.max(view.w, view.h) / CHAMBER;
    paintBackground();
    filmTime = -1e9;
    dirty = true;
  }

  // ---------- Particles ----------

  function add(kind: string, x: number, y: number, a: number, p: number, life = Infinity, gen = 0): void {
    if (particles.length + born.length >= MAX_PARTICLES || p <= 0) return;
    const mass: Record<string, [number, number]> = {
      "e-": [M.e, -1], "e+": [M.e, 1], "mu+": [M.mu, 1], "mu-": [M.mu, -1], "pi+": [M.pi, 1], "pi-": [M.pi, -1],
      "K-": [M.K, -1], p: [M.p, 1], gamma: [0, 0], K0: [M.K0, 0], L: [M.L, 0],
    };
    const [m, q] = mass[kind] ?? [M.pi, 0];
    born.push({ x, y, a, p, m, q, kind, life, carry: rand(0, 1), gen });
  }

  const logRand = (lo: number, hi: number): number => lo * Math.pow(hi / lo, Math.random());

  function flash(x: number, y: number, r = 22): void {
    flashes.push({ x, y, t: now, r });
  }

  /** γ → e⁺e⁻ next to a nucleus: the energy is shared, the two curl opposite ways. */
  function convert(g: Particle): void {
    const z = rand(0.15, 0.85);
    const spread = 0.004 / g.p;
    add("e-", g.x, g.y, g.a + rand(-spread, spread), g.p * z, Infinity, g.gen + 1);
    add("e+", g.x, g.y, g.a + rand(-spread, spread), g.p * (1 - z), Infinity, g.gen + 1);
  }

  /** Two-body decay at rest, isotropic in 3D, boosted along the flight and seen from above. */
  function decay2(parent: Particle, kind1: string, m1: number, kind2: string, m2: number): void {
    const Mp = parent.m;
    const pStar = Math.sqrt((Mp * Mp - (m1 + m2) ** 2) * (Mp * Mp - (m1 - m2) ** 2)) / (2 * Mp);
    const cos = rand(-1, 1);
    const sin = Math.sqrt(1 - cos * cos) * Math.cos(rand(0, TAU)); // the part in the picture's plane
    const E = Math.hypot(parent.p, Mp);
    const gamma = E / Mp, beta = parent.p / E;
    const part = (m: number, sign: number): [number, number] => {
      const e = Math.hypot(pStar, m);
      const along = gamma * (sign * pStar * cos + beta * e);
      const across = sign * pStar * sin;
      return [parent.a + Math.atan2(across, along), Math.hypot(along, across)];
    };
    const [a1, p1] = part(m1, 1);
    const [a2, p2] = part(m2, -1);
    add(kind1, parent.x, parent.y, a1, p1);
    add(kind2, parent.x, parent.y, a2, p2);
  }

  /** A hadron hits a proton of the liquid: a star of new particles, some of them invisible. */
  function star(x: number, y: number, a: number, forward: number): void {
    flash(x, y, 30);
    const cone = forward > 0 ? 0.55 : Math.PI;
    const pairs = randInt(1, 2);
    for (let i = 0; i < pairs; i++) {
      add(Math.random() < 0.3 ? "p" : "pi+", x, y, a + gauss() * cone, logRand(0.15, 1.2 + forward * 0.3));
      add("pi-", x, y, a + gauss() * cone, logRand(0.12, 1.2 + forward * 0.3));
    }
    if (Math.random() < 0.6) add("p", x, y, a + (Math.random() < 0.5 ? -1 : 1) * rand(0.9, 1.5), rand(0.22, 0.5));
    // a π⁰ lives 10⁻¹⁶ s: at once two photons, which convert some way off
    if (Math.random() < 0.8) {
      const ag = a + gauss() * cone * 0.7;
      const pg = logRand(0.15, 1.0);
      for (const s of [-1, 1]) add("gamma", x, y, ag + s * rand(0.05, 0.25), pg * rand(0.3, 0.7), -Math.log(1 - Math.random()) * 0.45 + 0.05);
    }
    if (Math.random() < 0.5) {
      const lambda = Math.random() < 0.45;
      add(lambda ? "L" : "K0", x, y, a + gauss() * cone * 0.6, rand(0.5, 1.6), rand(0.12, 0.6));
    }
  }

  /** What happens when a particle comes to rest. */
  function stopped(t: Particle): void {
    if (t.kind === "pi+") add("mu+", t.x, t.y, rand(0, TAU), 0.0298);
    else if (t.kind === "mu+" || t.kind === "mu-") add(t.q > 0 ? "e+" : "e-", t.x, t.y, rand(0, TAU), rand(0.012, 0.052));
    else if (t.kind === "pi-" && Math.random() < 0.6) {
      // captured by a nucleus, which breaks up into a couple of slow protons
      for (let i = randInt(1, 2); i > 0; i--) add("p", t.x, t.y, rand(0, TAU), rand(0.12, 0.25));
    }
  }

  function decayed(t: Particle): void {
    if (t.kind === "gamma") convert(t);
    else if (t.kind === "K0") decay2(t, "pi+", M.pi, "pi-", M.pi);
    else if (t.kind === "L") decay2(t, "p", M.p, "pi-", M.pi);
    else if (t.q !== 0 && t.p > 1) star(t.x, t.y, t.a, 1); // a beam particle interacts
  }

  function bubble(x: number, y: number, q: number): void {
    bx[head] = x;
    by[head] = y;
    bt[head] = now;
    bs[head] = rand(1.2, 2.0);
    bq[head] = q > 0 ? 1 : 0;
    head = (head + 1) % MAX_BUBBLES;
    filled = Math.min(filled + 1, MAX_BUBBLES);
  }

  /** Moves a particle by `dist` metres; false when it is gone. */
  function advance(t: Particle, dist: number): boolean {
    const margin = 60;
    let budget = 400;
    while (dist > 0 && budget-- > 0) {
      const E = Math.hypot(t.p, t.m);
      const beta = t.m === 0 ? 1 : t.p / E;
      const curve = t.q === 0 || field === 0 ? 0 : (-t.q * 0.3 * field) / t.p; // radians per metre
      let ds = Math.min(dist, 0.006, curve ? 0.12 / Math.abs(curve) : 1, t.life);
      ds = Math.max(ds, 1e-5);
      dist -= ds;
      const x0 = t.x, y0 = t.y;
      if (t.q !== 0) {
        t.a += curve * ds + (gauss() * 0.0136) / (beta * t.p) * Math.sqrt(ds / X0);
      }
      t.x += Math.cos(t.a) * ds * ppm;
      t.y += Math.sin(t.a) * ds * ppm;
      if (t.x < -margin || t.y < -margin || t.x > view.w + margin || t.y > view.h + margin) return false;
      t.life -= ds;
      if (t.life <= 0) {
        decayed(t);
        return false;
      }
      if (t.q === 0) continue;
      // bubbles: a Poisson process, denser for slow particles (∝ 1/β², like the energy loss)
      const density = Math.min(8, 1 / (beta * beta));
      t.carry -= (ds * ppm * density) / 3.2;
      while (t.carry < 0) {
        const k = Math.random();
        bubble(lerp(x0, t.x, k) + gauss() * 0.3, lerp(y0, t.y, k) + gauss() * 0.3, t.q);
        t.carry += -Math.log(1 - Math.random());
      }
      const electron = t.m < 0.001;
      const loss = electron ? LOSS_E : LOSS_H * density;
      const kinetic = E - t.m - loss * ds;
      if (kinetic < KE_MIN) {
        stopped(t);
        return false;
      }
      const e2 = kinetic + t.m;
      t.p = Math.sqrt(e2 * e2 - t.m * t.m);
      // knock-on electrons: tiny curls sideways off the track
      if (t.p > 0.08 && Math.random() < DELTA_RATE * ds * (electron ? 0.4 : 1)) {
        const side = Math.random() < 0.5 ? -1 : 1;
        add("e-", t.x, t.y, t.a + side * rand(0.9, 1.4), logRand(0.003, 0.025));
      }
      // a fast electron radiates a photon straight ahead: the start of a shower
      if (electron && t.p > 0.04 && t.gen < 4 && Math.random() < BREMS_RATE * ds) {
        const f = rand(0.15, 0.55);
        add("gamma", t.x, t.y, t.a, t.p * f, -Math.log(1 - Math.random()) * 0.35 + 0.03, t.gen + 1);
        t.p *= 1 - f;
      }
    }
    return true;
  }

  // ---------- Events ----------

  /** The beam axis: along the long side of the screen. */
  const across = () => view.w >= view.h * 0.9;

  function beam(): void {
    const n = randInt(3, 5);
    const hit = randInt(0, n - 1);
    const length = (across() ? view.w : view.h) / ppm;
    for (let i = 0; i < n; i++) {
      const offset = rand(0.15, 0.85);
      const p = rand(4, 9);
      const life = i === hit ? length * rand(0.25, 0.6) : -Math.log(1 - Math.random()) * 8;
      const kind = Math.random() < 0.15 ? "K-" : "pi-";
      // a negative beam bends one way: aim it a little the other way so it crosses the chamber
      const tilt = (0.3 * field * length * 0.5) / p;
      if (across()) add(kind, -20, view.h * offset, -tilt * 0.9 + rand(-0.02, 0.02), p, life);
      else add(kind, view.w * offset, -20, Math.PI / 2 - tilt * 0.9 + rand(-0.02, 0.02), p, life);
    }
  }

  /** Something from upstream: a photon converting, a lonely V⁰, or a slow π⁺ ending in the π → μ → e chain. */
  function ambient(): void {
    const x = rand(view.w * 0.15, view.w * 0.85);
    const y = rand(view.h * 0.2, view.h * 0.8);
    const a = across() ? rand(-0.25, 0.25) : Math.PI / 2 + rand(-0.25, 0.25);
    const r = Math.random();
    if (r < 0.4) add("gamma", x - Math.cos(a) * 30, y - Math.sin(a) * 30, a, logRand(0.08, 0.6), 30 / ppm);
    else if (r < 0.65) add(Math.random() < 0.5 ? "K0" : "L", x, y, a, rand(0.5, 1.4), rand(0.05, 0.3));
    else if (r < 0.85) add("pi+", x, y, rand(0, TAU), rand(0.07, 0.11));
    else add("gamma", across() ? -10 : x, across() ? y : -10, a, rand(1.5, 3), rand(0.2, 0.6) * CHAMBER);
  }

  // ---------- Drawing ----------

  const alphaAt = (age: number): number => Math.pow(Math.max(0, 1 - age / BUBBLE_LIFE), 1.6);

  function paintFilm(): void {
    filmTime = now;
    const g = filmCtx;
    g.globalCompositeOperation = "source-over";
    g.drawImage(background, 0, 0);
    const paths: Path2D[] = [];
    for (let i = 0; i < LEVELS * 2; i++) paths.push(new Path2D());
    const limit = now - FRESH;
    for (let i = 0; i < filled; i++) {
      if (bt[i]! > limit) continue;
      const alpha = alphaAt(now - bt[i]!);
      if (alpha <= 0.02) continue;
      const level = Math.min(LEVELS - 1, Math.floor(alpha * LEVELS));
      const s = bs[i]!;
      paths[level * 2 + bq[i]!]!.rect(bx[i]! - s / 2, by[i]! - s / 2, s, s);
    }
    g.globalCompositeOperation = "lighter";
    for (let level = 0; level < LEVELS; level++) {
      g.globalAlpha = Math.min(1, ((level + 0.5) / LEVELS) * 1.1);
      for (let q = 0; q < 2; q++) {
        g.fillStyle = TINT[q]!;
        g.fill(paths[level * 2 + q]!);
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }

  function draw(dt: number): void {
    if (dt === 0 && !dirty) return;
    dirty = false;
    if (dt > 0 && frame++ % FILM_EVERY === 0) paintFilm();
    else if (filmTime < -1e8) paintFilm();
    ctx.drawImage(film, 0, 0, view.w, view.h);
    ctx.globalCompositeOperation = "lighter";
    // young bubbles: still growing and glowing
    const limit = filmTime - FRESH;
    for (let q = 0; q < 2; q++) {
      const halo = new Path2D();
      const core = new Path2D();
      for (let i = 0; i < filled; i++) {
        if (bt[i]! <= limit || bq[i] !== q) continue;
        const age = now - bt[i]!;
        const grow = Math.min(1, 0.35 + age / 0.18);
        const r = bs[i]! * grow * 0.55;
        core.moveTo(bx[i]! + r, by[i]!);
        core.arc(bx[i]!, by[i]!, r, 0, TAU);
        if (age < FRESH) {
          halo.moveTo(bx[i]! + r * 2.6, by[i]!);
          halo.arc(bx[i]!, by[i]!, r * 2.6, 0, TAU);
        }
      }
      ctx.fillStyle = TINT[q]!;
      ctx.globalAlpha = 0.18;
      ctx.fill(halo);
      ctx.globalAlpha = 0.95;
      ctx.fill(core);
    }
    ctx.globalAlpha = 1;
    // interaction flashes
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]!;
      const k = (now - f.t) / 0.6;
      if (k >= 1) {
        flashes.splice(i, 1);
        continue;
      }
      const r = f.r * (0.5 + k);
      const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      grad.addColorStop(0, `rgba(255, 245, 225, ${0.8 * (1 - k)})`);
      grad.addColorStop(1, "rgba(255, 220, 180, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function simulate(dt: number): void {
    now += dt;
    if (now >= nextBeam) {
      beam();
      nextBeam = now + BEAM_EVERY * rand(0.8, 1.2);
    }
    if (now >= nextEvent) {
      ambient();
      nextEvent = now + rand(1.3, 2.8);
    }
    particles = particles.filter((t) => advance(t, SPEED * dt * Math.max(0.3, t.m === 0 ? 1 : t.p / Math.hypot(t.p, t.m))));
    particles.push(...born);
    born = [];
  }

  startLoop((dt) => {
    if (dt > 0) simulate(dt);
    else if (born.length) {
      particles.push(...born);
      born = [];
    }
    draw(dt);
  });

  // ---------- Controls and touch ----------

  addSlider({
    label: "🧲 Магнит",
    min: 0,
    max: 3.5,
    step: 0.1,
    value: field,
    format: (v) => `${v.toFixed(1).replace(".", ",")} Тл`,
    title: "Сила магнитного поля (тесла). Без поля следы прямые",
    onInput: (v) => (field = v),
  });
  addButton("⚡ Пучок", () => beam(), { title: "Впустить пучок частиц" });
  addButton("✨ Гамма", () => {
    const a = across() ? rand(-0.1, 0.1) : Math.PI / 2 + rand(-0.1, 0.1);
    if (across()) add("gamma", -10, view.h * rand(0.3, 0.7), a, rand(2, 4), CHAMBER * rand(0.12, 0.3));
    else add("gamma", view.w * rand(0.3, 0.7), -10, a, rand(2, 4), CHAMBER * rand(0.12, 0.3));
  }, { title: "Невидимый фотон: он родит пару электрон—позитрон и ливень" });

  // tap: a collision star at that point; drag and release: shoot one charged particle that way
  const shots = ["e-", "e+", "pi+", "pi-", "p", "mu-"];
  let shot = 0;
  onPointer({
    up(p) {
      const dx = p.x - p.startX, dy = p.y - p.startY;
      const length = Math.hypot(dx, dy);
      if (length < 25) star(p.x, p.y, rand(0, TAU), 0);
      else {
        const kind = shots[shot++ % shots.length]!;
        const momentum = (kind[0] === "e" ? 0.012 : 0.12) * Math.pow(length / 25, 1.3);
        add(kind, p.startX, p.startY, Math.atan2(dy, dx), Math.min(momentum, 3));
        flash(p.startX, p.startY, 14);
      }
      dirty = true;
    },
  });
  onResize(layout);

  layout();
  // the first picture is already busy: a few seconds of the chamber are run before it is shown
  for (let i = 0; i < 200; i++) {
    // …with one γ → e⁺e⁻ pair surely in the middle, half way through its spirals
    if (i === 150) {
      const a = across() ? rand(-0.2, 0.2) : Math.PI / 2 + rand(-0.2, 0.2);
      add("gamma", view.w * 0.45, view.h * 0.45, a, rand(0.25, 0.4), 0.02);
    }
    simulate(1 / 60);
  }
  showHint("Нажми — будет столкновение, проведи пальцем — пустишь частицу");
}
