// «Волшебный бильярд»: mathematical billiards. Thousands of balls fly from one point and bounce off the rim like light
// off a mirror. Every table is an implicit curve f(x, y) = 0 (inside f < 0): a ball that steps outside is moved back to
// the rim found by bisection and reflected about the normal grad f. In the ellipse everything from one focus meets
// in the other; in the stadium a narrow fan scatters all over the table (chaos).

namespace Billiard {
  type Shape = "circle" | "ellipse" | "stadium" | "heart";
  type Burst = "fan" | "star";

  const BALLS = 1500;
  const SPEED = 0.55; // table radii per second
  const FAN = 0.04; // spread of a fan, radians
  const ELLIPSE_B = 0.62;
  const FOCUS = Math.sqrt(1 - ELLIPSE_B * ELLIPSE_B);
  const STADIUM_L = 0.45; // half the straight part
  const STADIUM_R = 0.52;

  // Table coordinates: y up, the table fits in about [-1.2, 1.2]
  const shapes: Record<Shape, (x: number, y: number) => number> = {
    circle: (x, y) => x * x + y * y - 1,
    ellipse: (x, y) => x * x + (y * y) / (ELLIPSE_B * ELLIPSE_B) - 1,
    stadium: (x, y) => Math.hypot(Math.max(Math.abs(x) - STADIUM_L, 0), y) - STADIUM_R,
    heart: (x, y) => {
      // (x² + y² − 1)³ − x²y³, shifted so the heart's middle is the origin
      y = y * 1.05 + 0.1;
      x *= 1.05;
      const a = x * x + y * y - 1;
      return a * a * a - x * x * y * y * y;
    },
  };

  const ctx = canvas2d();
  let shape: Shape = "ellipse";
  let burst: Burst = "star";
  let f = shapes[shape];
  let rim: [number, number][] = [];
  let scale = 1;
  let cx = 0;
  let cy = 0;
  const px = new Float32Array(BALLS);
  const py = new Float32Array(BALLS);
  const vx = new Float32Array(BALLS);
  const vy = new Float32Array(BALLS);
  const hue = new Float32Array(BALLS);
  let count = 0;
  let origin: [number, number] = [-FOCUS, 0];
  let dirty = true; // redraw while paused (after a resize or a new launch)

  const normal = (x: number, y: number): [number, number] => {
    const e = 1e-4;
    const gx = f(x + e, y) - f(x - e, y);
    const gy = f(x, y + e) - f(x, y - e);
    const len = Math.hypot(gx, gy) || 1;
    return [gx / len, gy / len];
  };

  /** The rim as a polygon: along each ray from the middle, the first point where f turns positive. */
  function traceRim(): void {
    rim = [];
    for (let i = 0; i < 720; i++) {
      const a = (i / 720) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      let lo = 0, hi = 2;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (f(c * mid, s * mid) < 0) lo = mid;
        else hi = mid;
      }
      rim.push([c * lo, s * lo]);
    }
  }

  function layout(): void {
    let reachX = 0, reachY = 0;
    for (const [x, y] of rim) {
      reachX = Math.max(reachX, Math.abs(x));
      reachY = Math.max(reachY, Math.abs(y));
    }
    // keep the table clear of the title on top and the buttons at the bottom
    const area = freeArea();
    scale = Math.min((area.w * 0.46) / reachX, (area.h * 0.48) / reachY);
    cx = area.x + area.w / 2;
    cy = area.y + area.h / 2;
    ctx.fillStyle = "#0d0b1e";
    ctx.fillRect(0, 0, view.w, view.h);
    dirty = true;
  }

  const toScreen = (x: number, y: number): [number, number] => [cx + x * scale, cy - y * scale];
  const toTable = (sx: number, sy: number): [number, number] => [(sx - cx) / scale, (cy - sy) / scale];

  /** All balls fly out of (x, y): a narrow fan in a random direction, or a star in every direction. */
  function launch(x: number, y: number): void {
    origin = [x, y];
    dirty = true;
    const dir = rand(0, TAU);
    count = BALLS;
    for (let i = 0; i < BALLS; i++) {
      const t = i / (BALLS - 1);
      const a = burst === "fan" ? dir + (t - 0.5) * FAN : t * TAU;
      px[i] = x;
      py[i] = y;
      vx[i] = Math.cos(a) * SPEED;
      vy[i] = Math.sin(a) * SPEED;
      hue[i] = t * 300;
    }
  }

  function setShape(next: Shape): void {
    shape = next;
    f = shapes[shape];
    traceRim();
    layout();
    // the ellipse starts from its focus, the others from a point off the middle
    if (shape === "ellipse" && burst === "star") launch(-FOCUS, 0);
    else launch(shape === "heart" ? -0.35 : -0.3, shape === "heart" ? 0.2 : 0.15);
  }

  function move(i: number, dt: number): void {
    let x = px[i]!, y = py[i]!, ux = vx[i]!, uy = vy[i]!;
    for (let bounce = 0; bounce < 4 && dt > 0; bounce++) {
      const nx = x + ux * dt, ny = y + uy * dt;
      if (f(nx, ny) < 0) {
        x = nx;
        y = ny;
        break;
      }
      // find where the path crosses the rim, reflect there and fly on for the rest of the step
      let lo = 0, hi = 1;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (f(x + ux * dt * mid, y + uy * dt * mid) < 0) lo = mid;
        else hi = mid;
      }
      x += ux * dt * lo;
      y += uy * dt * lo;
      const [mx, my] = normal(x, y);
      const dot = ux * mx + uy * my;
      if (dot > 0) {
        ux -= 2 * dot * mx;
        uy -= 2 * dot * my;
      }
      x -= mx * 1e-5;
      y -= my * 1e-5;
      dt *= 1 - lo;
    }
    px[i] = x;
    py[i] = y;
    vx[i] = ux;
    vy[i] = uy;
  }

  function draw(dt: number): void {
    if (dt === 0 && !dirty) return;
    const fresh = dirty || dt === 0;
    dirty = false;
    // a dark veil over the last frame leaves fading trails behind the balls; a new launch starts on a clean table
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = fresh ? "#0d0b1e" : "rgba(13, 11, 30, 0.16)";
    ctx.fillRect(0, 0, view.w, view.h);

    ctx.beginPath();
    rim.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 184, 107, 0.85)";
    ctx.shadowColor = "#ffb86b";
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (shape === "ellipse") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      for (const fx of [-FOCUS, FOCUS]) {
        const [sx, sy] = toScreen(fx, 0);
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalCompositeOperation = "lighter";
    const size = Math.max(1.6, scale / 160);
    for (let i = 0; i < count; i++) {
      const [sx, sy] = toScreen(px[i]!, py[i]!);
      ctx.fillStyle = `hsl(${hue[i]}, 95%, 62%)`;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  startLoop((dt) => {
    const steps = 3;
    if (dt > 0) for (let s = 0; s < steps; s++) for (let i = 0; i < count; i++) move(i, dt / steps);
    draw(dt);
  });

  addChoice<Shape>(
    [
      { value: "circle", label: "⚪ Круг" },
      { value: "ellipse", label: "🥚 Овал" },
      { value: "stadium", label: "🏟️ Стадион" },
      { value: "heart", label: "❤️ Сердце" },
    ],
    shape,
    setShape,
  );
  addChoice<Burst>(
    [
      { value: "fan", label: "Веер", title: "Узкий пучок шариков в одну сторону" },
      { value: "star", label: "Звезда", title: "Шарики во все стороны" },
    ],
    burst,
    (next) => {
      burst = next;
      launch(...origin);
    },
  );
  addButton("🔄", () => launch(...origin), { round: true, title: "Запустить ещё раз" });

  onPointer({
    down(p) {
      const [x, y] = toTable(p.x, p.y);
      if (f(x, y) < 0) launch(x, y);
    },
  });
  onResize(layout);

  traceRim();
  layout();
  launch(...origin);
  showHint("Нажми на стол — шарики вылетят из этой точки");
}
