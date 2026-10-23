// «Маятниковая волна»: 18 pendulums on one bar, each a little shorter than the one before. Lengths are chosen so
// that in one common period of 60 s pendulum k makes exactly 51 + k swings: its period is 60 / (51 + k) s and its
// length l = g·(period / 2π)². Starting in one line they slowly drift apart in phase: a travelling snake, two and three
// snakes, apparent chaos, and after 60 s all of them are back in one line.
// Method: small swings (20°), so every pendulum follows the exact small-angle solution θ = θ0·cos(2π·n·t / 60) — no
// integration error can spoil the meeting. Seen from the front and above with a mild perspective; the swing goes
// towards the viewer. Optional sound: a soft pentatonic note per pendulum each time it passes the middle.

namespace PendulumWave {
  const COUNT = 18;
  const CYCLE = 60; // s: the common period
  const FIRST = 51; // swings of the longest pendulum per cycle
  const G = 9.81;
  const AMPLITUDE = 0.35; // rad
  const GAP = 0.035; // m between pendulums along the bar
  const PITCH = 0.62; // camera looks down by this angle (more on a tall phone screen, where there is room)
  const YAW = -0.32; // and a little from the side
  const DEPTH = 1.6; // m from the camera to the middle
  const TRAIL = 16; // frames of the short motion trail
  const BG = "#0d0b1e";
  // C major pentatonic, two octaves and more from C4
  const SCALE = [0, 2, 4, 7, 9];

  const ctx = canvas2d();
  const swings = Array.from({ length: COUNT }, (_, k) => FIRST + k);
  const lengths = swings.map((n) => G * ((CYCLE / n / TAU) ** 2));
  const hues = swings.map((_, k) => (k / (COUNT - 1)) * 290);
  const xs = swings.map((_, k) => (k - (COUNT - 1) / 2) * GAP);
  const trail = new Float32Array(COUNT * TRAIL * 2);
  let trailHead = 0;
  let trailFilled = 0;

  let t = 0;
  let rate = 1;
  let sound = false;
  let lastAngles = swings.map(() => AMPLITUDE);
  let scale = 1, cx = 0, cy = 0;
  let pitch = PITCH;
  let scrubbing = false;
  const flash = new Float32Array(COUNT); // glow after a note or a tap

  const angle = (k: number, time: number) => AMPLITUDE * Math.cos((TAU * swings[k]! * time) / CYCLE);

  /** World (x along the bar, y up, z towards the viewer) → screen, through yaw, pitch and perspective. */
  function project(x: number, y: number, z: number): [number, number, number] {
    const cy1 = Math.cos(YAW), sy1 = Math.sin(YAW);
    const x1 = cy1 * x + sy1 * z;
    const z1 = -sy1 * x + cy1 * z;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // the camera is above: points nearer to it move down on the screen
    const y2 = cp * (y + 0.17) - sp * z1;
    const z2 = sp * (y + 0.17) + cp * z1;
    const f = DEPTH / (DEPTH - z2);
    return [cx + x1 * f * scale, cy - y2 * f * scale, f];
  }

  function bob(k: number, time: number): [number, number, number] {
    const a = angle(k, time), l = lengths[k]!;
    return [xs[k]!, -l * Math.cos(a), l * Math.sin(a)];
  }

  function layout(): void {
    const area = freeArea();
    pitch = area.h > area.w * 1.2 ? 0.9 : PITCH;
    cx = area.x + area.w / 2;
    cy = area.y + area.h / 2;
    // fit the whole swing (all extreme positions) into the free area
    scale = 1;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < COUNT; k++) {
      for (const a of [-AMPLITUDE, 0, AMPLITUDE]) {
        const l = lengths[k]!;
        for (const [x, y, z] of [[xs[k]!, 0, 0], [xs[k]!, -l * Math.cos(a), l * Math.sin(a)]] as const) {
          const [px, py] = project(x, y, z);
          minX = Math.min(minX, px - cx);
          maxX = Math.max(maxX, px - cx);
          minY = Math.min(minY, py - cy);
          maxY = Math.max(maxY, py - cy);
        }
      }
    }
    scale = Math.min((area.w * 0.86) / (maxX - minX), (area.h * 0.8) / (maxY - minY));
    cx -= ((minX + maxX) / 2) * scale;
    cy -= ((minY + maxY) / 2) * scale;
    trailFilled = 0;
  }

  // ---------- Sound ----------

  function note(k: number): void {
    const ac = audioContext();
    if (!ac) return;
    const step = SCALE[k % SCALE.length]! + 12 * Math.floor(k / SCALE.length);
    const freq = 261.63 * 2 ** (step / 12);
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.07 / Math.sqrt(rate), now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.95);
  }

  /** Pendulums that crossed the middle (moving towards the viewer) since the last frame chime and flash. */
  function crossings(play: boolean): void {
    for (let k = 0; k < COUNT; k++) {
      const a = angle(k, t);
      const before = lastAngles[k]!;
      if (before < 0 && a >= 0) {
        flash[k] = 1;
        if (play && sound) note(k);
      }
      lastAngles[k] = a;
    }
  }

  // ---------- Drawing ----------

  function draw(dt: number): void {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, view.w, view.h);

    // the bar with its two posts
    const left = project(xs[0]! - GAP, 0, 0), right = project(xs[COUNT - 1]! + GAP, 0, 0);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffb86b";
    ctx.shadowColor = "#ffb86b";
    ctx.shadowBlur = 12;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(left[0], left[1]);
    ctx.lineTo(right[0], right[1]);
    ctx.stroke();
    ctx.shadowBlur = 0;

    const now = swings.map((_, k) => project(...bob(k, t)));
    if (dt !== 0) {
      trailHead = (trailHead + 1) % TRAIL;
      now.forEach(([x, y], k) => trail.set([x, y], (k * TRAIL + trailHead) * 2));
      trailFilled = Math.min(TRAIL, trailFilled + 1);
    }

    ctx.globalCompositeOperation = "lighter";
    // the snake: a soft curve through all the bobs
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    now.forEach(([x, y], k) => {
      const next = now[k + 1];
      if (k === 0) ctx.moveTo(x, y);
      if (next) ctx.quadraticCurveTo(x, y, (x + next[0]) / 2, (y + next[1]) / 2);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // farther pendulums first, so the nearer glow lies on top
    const order = swings.map((_, k) => k).sort((a, b) => now[a]![2] - now[b]![2]);
    for (const k of order) {
      const [x, y, f] = now[k]!;
      const top = project(xs[k]!, 0, 0);
      const hue = hues[k]!;
      flash[k] = Math.max(0, flash[k]! - dt * 2.5);
      const lit = flash[k]!;
      // short fading trail
      ctx.lineWidth = 3 * f;
      for (let a = 0; a < trailFilled - 1; a++) {
        const o1 = (k * TRAIL + ((trailHead - a + TRAIL) % TRAIL)) * 2;
        const o2 = (k * TRAIL + ((trailHead - a - 1 + TRAIL) % TRAIL)) * 2;
        ctx.strokeStyle = hsl(hue, 100, 65, 0.25 * (1 - a / TRAIL));
        ctx.beginPath();
        ctx.moveTo(trail[o1]!, trail[o1 + 1]!);
        ctx.lineTo(trail[o2]!, trail[o2 + 1]!);
        ctx.stroke();
      }
      ctx.strokeStyle = hsl(hue, 80, 75, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.lineTo(x, y);
      ctx.stroke();
      const r = Math.max(4, scale * 0.011 * f);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * (3.2 + lit * 2));
      glow.addColorStop(0, hsl(hue, 100, 70, 0.9));
      glow.addColorStop(0.35, hsl(hue, 100, 60, 0.35 + lit * 0.3));
      glow.addColorStop(1, hsl(hue, 100, 60, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * (3.2 + lit * 2), 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      const ball = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
      ball.addColorStop(0, "#fff");
      ball.addColorStop(0.4, hsl(hue, 100, 72));
      ball.addColorStop(1, hsl(hue, 90, 45));
      ctx.fillStyle = ball;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = "lighter";
    }
    ctx.globalCompositeOperation = "source-over";
  }

  startLoop((dt) => {
    if (dt > 0 && !scrubbing) {
      t += dt * rate;
      crossings(true);
    }
    if (scrubbing) trailFilled = 0; // big jumps in time would leave long streaks
    draw(scrubbing ? 1 / 60 : dt);
    const phase = ((t % CYCLE) + CYCLE) % CYCLE;
    const left = Math.ceil((CYCLE - phase) / rate - 1e-6);
    setReadout(phase < 0.4 || CYCLE - phase < 0.4 ? "Все в ряд!" : `Снова в ряд через ${left} с`);
  });

  // dragging sideways turns time forwards and backwards; a tap chimes the nearest pendulum
  onPointer({
    move(p) {
      if (!p.down) return;
      if (Math.hypot(p.x - p.startX, p.y - p.startY) > 6) scrubbing = true;
      if (scrubbing) {
        t = Math.max(0, t + (p.dx / view.w) * 20);
        crossings(false);
      }
    },
    up(p) {
      if (!scrubbing) {
        let best = 0, bestD = Infinity;
        for (let k = 0; k < COUNT; k++) {
          const [x, y] = project(...bob(k, t));
          const d = Math.hypot(x - p.x, y - p.y);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        flash[best] = 1;
        note(best);
      }
      scrubbing = false;
    },
  });

  addButton("🔄", () => {
    t = 0;
    lastAngles = swings.map(() => AMPLITUDE);
    trailFilled = 0;
  }, { round: true, title: "Все снова в ряд" });
  addChoice<string>(
    [
      { value: "1", label: "×1", title: "Настоящая скорость" },
      { value: "3", label: "×3", title: "В три раза быстрее" },
    ],
    "1",
    (v) => (rate = Number(v)),
  );
  const soundButton = addButton("🔈 Звук", () => {
    sound = !sound;
    soundButton.textContent = sound ? "🔊 Звук" : "🔈 Звук";
    soundButton.classList.toggle("on", sound);
    if (sound) audioContext();
  }, { title: "Каждый маятник звенит, проходя середину" });

  onResize(layout);
  layout();
  showHint("Смотри, как ряд превращается в змейку. Потяни вбок — время побежит быстрее или назад");
}
