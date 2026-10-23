// «Тысяча маятников»: a thousand double pendulums (two equal masses on two equal weightless arms) hang from one pivot
// and start almost in the same pose: the upper arm angle differs by only 1e-5 rad across the whole set. At first they
// cover each other and look like one white pendulum; the tiny difference doubles again and again (chaos), the rainbow
// fans out and after a few seconds every pendulum swings its own way.
// Method: the exact Lagrange equations of motion for angles θ1, θ2 measured from the downward vertical, integrated with
// classic RK4 in small fixed substeps. Arms are drawn as thin lines with additive blending, so overlapping pendulums
// add up to white; the tips leave fading trails on a separate canvas.

namespace Pendulums {
  const G = 9.81; // m/s²
  const ARM = 0.5; // m, both arms
  const SPREAD = 1e-5; // rad: the whole difference between the first and the last pendulum
  const STEP = 1 / 360; // s, one RK4 substep
  const MAX_STEPS = 24; // substeps per frame at most
  const START: [number, number] = [2.5, 2.5]; // high above the pivot: chaos comes in a few seconds
  const BG = "#0d0b1e";
  const BUCKETS = 90; // pendulums are drawn in this many colour groups (one stroke each)

  const ctx = canvas2d();
  const trail = document.createElement("canvas");
  const tctx = trail.getContext("2d")!;
  // the arms are also drawn small on this canvas, shrunk once more and both stretched over the stage: a cheap bloom
  const GLOW = 3; // CSS px per glow pixel
  const glow = document.createElement("canvas");
  const gctx = glow.getContext("2d")!;
  const haze = document.createElement("canvas"); // twice smaller still
  const hctx = haze.getContext("2d")!;

  let count = 1000;
  let trails = true;
  // state: angles and angular velocities
  let t1 = new Float64Array(count);
  let t2 = new Float64Array(count);
  let w1 = new Float64Array(count);
  let w2 = new Float64Array(count);
  // the last drawn tip, for the trails
  let tipX = new Float32Array(count);
  let tipY = new Float32Array(count);
  let pose: [number, number] = [...START];
  let elapsed = 0;
  let posing = false;
  let scale = 100; // px per metre
  let ox = 0; // pivot on the screen
  let oy = 0;
  let colours: string[] = [];

  /** Angular accelerations of the double pendulum with m1 = m2 and l1 = l2 = ARM. */
  function accel(a: number, b: number, u: number, v: number): [number, number] {
    const d = a - b;
    const s = Math.sin(d), c = Math.cos(d);
    const den = ARM * (3 - Math.cos(2 * d));
    const aa = (-3 * G * Math.sin(a) - G * Math.sin(a - 2 * b) - 2 * s * ARM * (v * v + u * u * c)) / den;
    const bb = (2 * s * (2 * ARM * u * u + 2 * G * Math.cos(a) + ARM * v * v * c)) / den;
    return [aa, bb];
  }

  /** One RK4 step of pendulum i. */
  function rk4(i: number, h: number): void {
    const a = t1[i]!, b = t2[i]!, u = w1[i]!, v = w2[i]!;
    const [p1, q1] = accel(a, b, u, v);
    const a2 = a + (h / 2) * u, b2 = b + (h / 2) * v, u2 = u + (h / 2) * p1, v2 = v + (h / 2) * q1;
    const [p2, q2] = accel(a2, b2, u2, v2);
    const a3 = a + (h / 2) * u2, b3 = b + (h / 2) * v2, u3 = u + (h / 2) * p2, v3 = v + (h / 2) * q2;
    const [p3, q3] = accel(a3, b3, u3, v3);
    const a4 = a + h * u3, b4 = b + h * v3, u4 = u + h * p3, v4 = v + h * q3;
    const [p4, q4] = accel(a4, b4, u4, v4);
    t1[i] = a + (h / 6) * (u + 2 * u2 + 2 * u3 + u4);
    t2[i] = b + (h / 6) * (v + 2 * v2 + 2 * v3 + v4);
    w1[i] = u + (h / 6) * (p1 + 2 * p2 + 2 * p3 + p4);
    w2[i] = v + (h / 6) * (q1 + 2 * q2 + 2 * q3 + q4);
  }

  /** A new set of pendulums in the pose, all at rest, the upper angles spread by SPREAD. */
  function launch(): void {
    t1 = new Float64Array(count);
    t2 = new Float64Array(count);
    w1 = new Float64Array(count);
    w2 = new Float64Array(count);
    tipX = new Float32Array(count);
    tipY = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      t1[i] = pose[0] + (count > 1 ? (i / (count - 1) - 0.5) * SPREAD : 0);
      t2[i] = pose[1];
      [tipX[i], tipY[i]] = tip(i);
    }
    colours = [];
    const groups = Math.min(count, BUCKETS);
    for (let k = 0; k < groups; k++) colours.push(groups > 1 ? hsl((k / (groups - 1)) * 300, 100, 62) : "#ffe0a0");
    elapsed = 0;
    tctx.clearRect(0, 0, trail.width, trail.height);
  }

  const elbow = (i: number): [number, number] => [ox + Math.sin(t1[i]!) * ARM * scale, oy + Math.cos(t1[i]!) * ARM * scale];
  function tip(i: number): [number, number] {
    const [x, y] = elbow(i);
    return [x + Math.sin(t2[i]!) * ARM * scale, y + Math.cos(t2[i]!) * ARM * scale];
  }

  function layout(): void {
    // the tip reaches 2 arms from the pivot in every direction: the whole circle must fit
    const area = freeArea();
    scale = (Math.min(area.w, area.h) * 0.46) / (2 * ARM);
    ox = area.x + area.w / 2;
    oy = area.y + area.h / 2;
    trail.width = stage.width;
    trail.height = stage.height;
    tctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    glow.width = Math.ceil(view.w / GLOW);
    glow.height = Math.ceil(view.h / GLOW);
    gctx.setTransform(1 / GLOW, 0, 0, 1 / GLOW, 0, 0);
    haze.width = Math.ceil(glow.width / 2);
    haze.height = Math.ceil(glow.height / 2);
    for (let i = 0; i < count; i++) [tipX[i], tipY[i]] = tip(i);
  }

  /** Strokes every colour group of pendulums: path(i) adds pendulum i to the current path. */
  function strokeGroups(c: CanvasRenderingContext2D, path: (i: number) => void, fill = false): void {
    const groups = colours.length;
    for (let k = 0; k < groups; k++) {
      c.beginPath();
      for (let i = Math.floor((k * count) / groups); i < Math.floor(((k + 1) * count) / groups); i++) path(i);
      if (fill) {
        c.fillStyle = posing ? "#fff" : colours[k]!;
        c.fill();
      } else {
        c.strokeStyle = posing ? "#fff" : colours[k]!;
        c.stroke();
      }
    }
  }

  const armPath = (c: CanvasRenderingContext2D) => (i: number) => {
    const [ex, ey] = elbow(i);
    const [tx, ty] = tip(i);
    c.moveTo(ox, oy);
    c.lineTo(ex, ey);
    c.lineTo(tx, ty);
  };
  const upperArm = (c: CanvasRenderingContext2D) => (i: number) => {
    c.moveTo(ox, oy);
    c.lineTo(...elbow(i));
  };
  const lowerArm = (c: CanvasRenderingContext2D) => (i: number) => {
    c.moveTo(...elbow(i));
    c.lineTo(...tip(i));
  };

  /** Line width and opacity: one pendulum is bold, a thousand are hair-thin so the overlap shows. */
  const look = () => (count === 1 ? { width: 3, alpha: 1 } : count <= 100 ? { width: 1.6, alpha: 0.6 } : { width: 1, alpha: 0.32 });

  /** Adds the tips' latest moves to the trail canvas and lets the old trail fade. */
  function drawTrails(dt: number): void {
    tctx.globalCompositeOperation = "destination-out";
    tctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1, dt * 2.2)})`;
    tctx.fillRect(0, 0, view.w, view.h);
    tctx.globalCompositeOperation = "lighter";
    tctx.lineWidth = count === 1 ? 2 : 1;
    tctx.globalAlpha = count === 1 ? 0.9 : count <= 100 ? 0.6 : 0.22;
    strokeGroups(tctx, (i) => {
      const [x, y] = tip(i);
      tctx.moveTo(tipX[i]!, tipY[i]!);
      tctx.lineTo(x, y);
      tipX[i] = x;
      tipY[i] = y;
    });
    tctx.globalAlpha = 1;
  }

  function draw(): void {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, view.w, view.h);
    // a faint circle shows how far the tip can reach
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ox, oy, 2 * ARM * scale, 0, TAU);
    ctx.stroke();
    if (trails && !posing) ctx.drawImage(trail, 0, 0, view.w, view.h);

    const { width, alpha } = look();
    // glow: thick faint arms on the small canvas, stretched (and so blurred) over the stage
    gctx.globalCompositeOperation = "source-over";
    gctx.clearRect(0, 0, view.w, view.h);
    gctx.globalCompositeOperation = "lighter";
    gctx.lineWidth = 2 * GLOW;
    gctx.lineJoin = "round";
    // where all the groups lie on top of each other the glow adds up to about one half
    gctx.globalAlpha = colours.length > 1 ? 0.5 / colours.length : 0.6;
    strokeGroups(gctx, armPath(gctx));
    ctx.globalCompositeOperation = "lighter";
    ctx.imageSmoothingEnabled = true;
    hctx.clearRect(0, 0, haze.width, haze.height);
    hctx.drawImage(glow, 0, 0, haze.width, haze.height);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(glow, 0, 0, glow.width * GLOW, glow.height * GLOW);
    ctx.globalAlpha = 1;
    ctx.drawImage(haze, 0, 0, haze.width * GLOW * 2, haze.height * GLOW * 2);

    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    // all the upper arms meet at the pivot: they are dimmer, or the middle would burn white in the chaos
    ctx.globalAlpha = count === 1 ? alpha : alpha * 0.5;
    strokeGroups(ctx, upperArm(ctx));
    ctx.globalAlpha = alpha;
    strokeGroups(ctx, lowerArm(ctx));
    // the bobs: small bright dots at the elbows and the tips
    const r = count === 1 ? 7 : count <= 100 ? 3 : 2.2;
    strokeGroups(ctx, (i) => {
      for (const [x, y] of [elbow(i), tip(i)]) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
    }, true);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#ffe6a8";
    ctx.shadowColor = "#ffb86b";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(ox, oy, 5, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  startLoop((dt) => {
    if (dt > 0 && !posing) {
      const steps = Math.min(MAX_STEPS, Math.max(1, Math.round(dt / STEP)));
      const h = dt / steps;
      for (let i = 0; i < count; i++) for (let s = 0; s < steps; s++) rk4(i, h);
      elapsed += dt;
      if (trails) drawTrails(dt);
    }
    draw();
    setReadout(posing ? "Отпусти — и полетят!" : `Прошло: ${elapsed.toFixed(1).replace(".", ",")} с`);
  });

  /** Two-arm pose with the tip at the pointer; of the two elbow positions the one nearer the current elbow is taken. */
  function poseAt(px: number, py: number): void {
    let dx = (px - ox) / scale, dy = (py - oy) / scale;
    const d = Math.max(1e-6, Math.hypot(dx, dy));
    const reach = Math.min(d, 2 * ARM * 0.9999);
    dx *= reach / d;
    dy *= reach / d;
    const toTip = Math.atan2(dx, dy); // angle from the downward vertical
    const bend = Math.acos(clamp(reach / (2 * ARM), -1, 1));
    const options: [number, number][] = [
      [toTip + bend, toTip - bend],
      [toTip - bend, toTip + bend],
    ];
    const near = (o: [number, number]) => Math.abs(Math.sin((o[0] - (t1[0] ?? 0)) / 2));
    const best = near(options[0]!) <= near(options[1]!) ? options[0]! : options[1]!;
    pose = best;
    for (let i = 0; i < count; i++) {
      t1[i] = best[0];
      t2[i] = best[1];
      w1[i] = w2[i] = 0;
    }
  }

  onPointer({
    down(p) {
      posing = true;
      poseAt(p.x, p.y);
    },
    move(p) {
      if (p.down && posing) poseAt(p.x, p.y);
    },
    up() {
      if (!posing) return;
      posing = false;
      launch();
    },
  });

  addChoice<string>(
    [
      { value: "1", label: "1", title: "Один маятник" },
      { value: "100", label: "100", title: "Сто маятников" },
      { value: "1000", label: "1000", title: "Тысяча маятников" },
    ],
    String(count),
    (value) => {
      count = Number(value);
      launch();
    },
  );
  const trailButton = addButton("✨ Следы", () => {
    trails = !trails;
    trailButton.classList.toggle("on", trails);
    tctx.clearRect(0, 0, view.w, view.h);
  }, { title: "Следы кончиков" });
  trailButton.classList.toggle("on", trails);
  addButton("🔄", () => launch(), { round: true, title: "Запустить ещё раз" });

  onResize(layout);
  layout();
  launch();
  showHint("Потяни за кончик маятника и отпусти");
}
