// «Четырёхмерный куб»: regular 4D polytopes turning in four dimensions. Each vertex (x, y, z, w) is rotated in the XW,
// YW and ZW planes (the planes that only exist in 4D), then projected to 3D in perspective along w,
// p = (x, y, z) · D / (D − w), so the half nearer in w looks like a big outer cube and the farther half like a small
// inner one; turning in a W plane swaps them, and the figure seems to turn inside out. The 3D shadow is then turned by
// dragging (orbit) and projected to the screen in perspective. Edges glow in a colour that tells the w coordinate,
// fading with depth; faint faces give the figure a glassy body.
// «Куб и его тень» is the same idea one dimension lower: a 3D cube under a lamp casts a flat 2D shadow — a small square
// inside a big one, just as the tesseract's 3D shadow is a small cube inside a big one.

namespace Tesseract {
  type Shape = "tesseract" | "16-cell" | "24-cell" | "shadow";
  type Vec4 = [number, number, number, number];

  const W_DIST = 2.4; // 4D viewpoint distance along w (the polytopes have circumradius 1)
  const DEPTH = 6; // 3D camera distance
  const LAMP_Y = 2.7;
  const FLOOR_Y = -1.15;
  const CUBE = 0.62; // half the edge of the 3D cube
  const CUBE_Y = 0.35; // its centre above the middle

  interface Polytope {
    verts: Vec4[];
    edges: [number, number][];
    faces: number[][];
    info: string;
    /** 3D size factor so that every shape's shadow fills about the same space */
    scale?: number;
  }

  function tesseract(): Polytope {
    const verts: Vec4[] = [];
    for (let i = 0; i < 16; i++) verts.push([0, 1, 2, 3].map((b) => ((i >> b) & 1 ? 0.5 : -0.5)) as Vec4);
    const edges: [number, number][] = [];
    const faces: number[][] = [];
    for (let i = 0; i < 16; i++) {
      for (let b = 0; b < 4; b++) if (!((i >> b) & 1)) edges.push([i, i | (1 << b)]);
      // a square: from a corner, along two axes where the corner sits at −
      for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
          if ((i >> a) & 1 || (i >> b) & 1) continue;
          faces.push([i, i | (1 << a), i | (1 << a) | (1 << b), i | (1 << b)]);
        }
      }
    }
    return { verts, edges, faces, info: "16 вершин · 32 ребра\n8 кубиков" };
  }

  /** Edges join the nearest pairs of vertices; faces are the triangles of edges. */
  function fromVertices(verts: Vec4[], info: string): Polytope {
    const d = (a: Vec4, b: Vec4) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
    let min = Infinity;
    for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) min = Math.min(min, d(verts[i]!, verts[j]!));
    const near = (i: number, j: number) => Math.abs(d(verts[i]!, verts[j]!) - min) < 1e-6;
    const edges: [number, number][] = [];
    const faces: number[][] = [];
    for (let i = 0; i < verts.length; i++) {
      for (let j = i + 1; j < verts.length; j++) {
        if (!near(i, j)) continue;
        edges.push([i, j]);
        for (let k = j + 1; k < verts.length; k++) if (near(i, k) && near(j, k)) faces.push([i, j, k]);
      }
    }
    return { verts, edges, faces, info };
  }

  function sixteenCell(): Polytope {
    const verts: Vec4[] = [];
    for (let a = 0; a < 4; a++) {
      for (const s of [-1, 1]) {
        const v: Vec4 = [0, 0, 0, 0];
        v[a] = s;
        verts.push(v);
      }
    }
    return fromVertices(verts, "8 вершин · 24 ребра\n16 пирамидок");
  }

  function twentyFourCell(): Polytope {
    const verts: Vec4[] = [];
    const k = Math.SQRT1_2;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        for (const sa of [-1, 1]) {
          for (const sb of [-1, 1]) {
            const v: Vec4 = [0, 0, 0, 0];
            v[a] = sa * k;
            v[b] = sb * k;
            verts.push(v);
          }
        }
      }
    }
    return fromVertices(verts, "24 вершины · 96 рёбер\n24 восьмигранника");
  }

  const polytopes: Record<Exclude<Shape, "shadow">, Polytope> = {
    tesseract: tesseract(),
    "16-cell": sixteenCell(),
    "24-cell": twentyFourCell(),
  };

  /** How far the 3D shadow of a polytope reaches at most, over many random 4D turns. */
  function reachOf(p: Polytope): number {
    let reach = 0;
    for (let t = 0; t < 300; t++) {
      a1 = rand(0, TAU);
      a2 = rand(0, TAU);
      a3 = rand(0, TAU);
      for (const v of p.verts) {
        const [x, y, z, w] = turn4(v);
        reach = Math.max(reach, (Math.hypot(x, y, z) * W_DIST) / (W_DIST - w));
      }
    }
    return reach;
  }

  const ctx = canvas2d();
  let shape: Shape = "tesseract";
  let speed = 0.5;
  let a1 = 0.4, a2 = 0.2, a3 = 0; // angles in the XW, YW, ZW planes
  let c1 = 0.5, c2 = 0.3; // angles of the 3D cube
  let cx = 0, cy = 0, focal = 300;
  let lift = 0; // the lamp scene is taller above the middle than below: shift it down

  const orbit = orbitControl({ yaw: 0.55, pitch: 0.38, spin: 0.12, minZoom: 0.6, maxZoom: 2.2 });

  function layout(): void {
    const area = freeArea();
    cx = area.x + area.w / 2;
    cy = area.y + area.h / 2;
    const reach = shape === "shadow" ? 2.35 : 1.75;
    lift = shape === "shadow" ? (LAMP_Y + FLOOR_Y) / 2 : 0;
    focal = (Math.min(area.w, area.h) * 0.47 * (DEPTH - reach)) / reach;
  }

  /** Screen point and perspective factor of a 3D point (after the orbit turn). */
  const out = { x: 0, y: 0, z: 0, k: 1 };
  function project(x: number, y: number, z: number): void {
    const [X, Y, Z] = orbit.rotate(x, y - lift, z);
    const k = (focal * orbit.zoom) / (DEPTH - Z);
    out.x = cx + X * k;
    out.y = cy - Y * k;
    out.z = Z;
    out.k = k;
  }

  // ---------- 4D ----------

  const sx = new Float32Array(24), sy = new Float32Array(24), sz = new Float32Array(24), sk = new Float32Array(24);
  const sw = new Float32Array(24);

  function turn4(v: Vec4): Vec4 {
    let [x, y, z, w] = v;
    let c = Math.cos(a1), s = Math.sin(a1);
    [x, w] = [c * x - s * w, s * x + c * w];
    c = Math.cos(a2);
    s = Math.sin(a2);
    [y, w] = [c * y - s * w, s * y + c * w];
    c = Math.cos(a3);
    s = Math.sin(a3);
    [z, w] = [c * z - s * w, s * z + c * w];
    return [x, y, z, w];
  }

  /** Colour of a vertex by its w: near in w (outer) — warm pink, far (inner) — cool cyan. */
  const wHue = (w: number) => 190 + (w + 1) * 70;

  function drawPolytope(p: Polytope): void {
    p.verts.forEach((v, i) => {
      const [x, y, z, w] = turn4(v);
      const k = (W_DIST / (W_DIST - w)) * (p.scale ?? 1);
      project(x * k, y * k, z * k);
      sx[i] = out.x;
      sy[i] = out.y;
      sz[i] = out.z;
      sk[i] = out.k;
      sw[i] = w;
    });
    const near = (i: number) => clamp(0.35 + 0.65 * ((sz[i]! + 1.8) / 3.6), 0.25, 1);
    ctx.globalCompositeOperation = "lighter";

    // glassy faces
    for (const f of p.faces) {
      let w = 0, n = 0;
      ctx.beginPath();
      f.forEach((i, j) => {
        if (j === 0) ctx.moveTo(sx[i]!, sy[i]!);
        else ctx.lineTo(sx[i]!, sy[i]!);
        w += sw[i]!;
        n += near(i);
      });
      ctx.closePath();
      ctx.fillStyle = hsl(wHue(w / f.length), 90, 60, (0.05 * n) / f.length);
      ctx.fill();
    }

    // glowing edges: a wide faint pass, a middle one and a bright core, each a gradient between the end colours
    ctx.lineCap = "round";
    for (const [width, alpha, light] of [[9, 0.08, 60], [3.6, 0.3, 65], [1.4, 0.95, 85]] as const) {
      for (const [i, j] of p.edges) {
        const g = ctx.createLinearGradient(sx[i]!, sy[i]!, sx[j]!, sy[j]!);
        g.addColorStop(0, hsl(wHue(sw[i]!), 95, light, alpha * near(i)));
        g.addColorStop(1, hsl(wHue(sw[j]!), 95, light, alpha * near(j)));
        ctx.strokeStyle = g;
        ctx.lineWidth = width * ((sk[i]! + sk[j]!) / 2 / focal) * 5.5;
        ctx.beginPath();
        ctx.moveTo(sx[i]!, sy[i]!);
        ctx.lineTo(sx[j]!, sy[j]!);
        ctx.stroke();
      }
    }

    // vertices
    p.verts.forEach((_, i) => {
      const r = 3.2 * (sk[i]! / focal) * 5.5;
      const g = ctx.createRadialGradient(sx[i]!, sy[i]!, 0, sx[i]!, sy[i]!, r * 3);
      g.addColorStop(0, hsl(wHue(sw[i]!), 100, 92, near(i)));
      g.addColorStop(0.3, hsl(wHue(sw[i]!), 100, 70, 0.5 * near(i)));
      g.addColorStop(1, hsl(wHue(sw[i]!), 100, 60, 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx[i]! - r * 3, sy[i]! - r * 3, r * 6, r * 6);
    });
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- The cube and its shadow ----------

  const cubeVerts: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) cubeVerts.push([i & 1 ? CUBE : -CUBE, i & 2 ? CUBE : -CUBE, i & 4 ? CUBE : -CUBE]);
  const cubeEdges: [number, number][] = [];
  for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) if (!((i >> b) & 1)) cubeEdges.push([i, i | (1 << b)]);
  const cubeFaces = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];

  function drawShadow(): void {
    // the cube turns about two axes, then hangs above the floor
    const pts = cubeVerts.map(([x, y, z]) => {
      let c = Math.cos(c1), s = Math.sin(c1);
      [x, z] = [c * x + s * z, -s * x + c * z];
      c = Math.cos(c2);
      s = Math.sin(c2);
      [x, y] = [c * x - s * y, s * x + c * y];
      return [x, y + CUBE_Y, z] as [number, number, number];
    });
    // the shadow of a point is where the ray from the lamp through it meets the floor
    const shadow = pts.map(([x, y, z]) => {
      const t = (FLOOR_Y - LAMP_Y) / (y - LAMP_Y);
      return [x * t, FLOOR_Y, z * t] as [number, number, number];
    });

    // the floor: a lit disc of grid under the lamp
    const R = 2.3;
    const floor = new Path2D();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * TAU;
      project(Math.cos(a) * R, FLOOR_Y, Math.sin(a) * R);
      if (i === 0) floor.moveTo(out.x, out.y);
      else floor.lineTo(out.x, out.y);
    }
    project(0, FLOOR_Y, 0);
    const fx = out.x, fy = out.y;
    project(R, FLOOR_Y, 0);
    const spread = Math.max(40, Math.hypot(out.x - fx, out.y - fy) * 1.3);
    const light = ctx.createRadialGradient(fx, fy, 0, fx, fy, spread);
    light.addColorStop(0, "rgba(255, 226, 170, 0.34)");
    light.addColorStop(0.6, "rgba(190, 150, 255, 0.12)");
    light.addColorStop(1, "rgba(120, 100, 220, 0)");
    ctx.fillStyle = light;
    ctx.fill(floor);
    ctx.strokeStyle = "rgba(200, 185, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = -R; g <= R + 1e-6; g += R / 6) {
      const h = Math.sqrt(Math.max(0, R * R - g * g));
      project(g, FLOOR_Y, -h);
      ctx.moveTo(out.x, out.y);
      project(g, FLOOR_Y, h);
      ctx.lineTo(out.x, out.y);
      project(-h, FLOOR_Y, g);
      ctx.moveTo(out.x, out.y);
      project(h, FLOOR_Y, g);
      ctx.lineTo(out.x, out.y);
    }
    ctx.stroke();

    const screen = (p: [number, number, number]) => {
      project(...p);
      return { x: out.x, y: out.y, z: out.z, k: out.k };
    };
    const sp = shadow.map(screen);
    const cp = pts.map(screen);
    const lamp = screen([0, LAMP_Y, 0]);

    // the shadow: darker floor under every face, its edges drawn in the tesseract's cyan
    ctx.fillStyle = "rgba(6, 4, 18, 0.5)";
    for (const f of cubeFaces) {
      ctx.beginPath();
      f.forEach((i, j) => (j ? ctx.lineTo(sp[i]!.x, sp[i]!.y) : ctx.moveTo(sp[i]!.x, sp[i]!.y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (const [width, alpha] of [[7, 0.1], [2.6, 0.35], [1.2, 0.9]] as const) {
      ctx.strokeStyle = `rgba(120, 230, 255, ${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [i, j] of cubeEdges) {
        ctx.moveTo(sp[i]!.x, sp[i]!.y);
        ctx.lineTo(sp[j]!.x, sp[j]!.y);
      }
      ctx.stroke();
    }
    // light rays from the lamp through the corners
    ctx.strokeStyle = "rgba(255, 230, 170, 0.09)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const s of sp) {
      ctx.moveTo(lamp.x, lamp.y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();

    // the cube: faint faces and golden edges
    for (const f of cubeFaces) {
      ctx.beginPath();
      f.forEach((i, j) => (j ? ctx.lineTo(cp[i]!.x, cp[i]!.y) : ctx.moveTo(cp[i]!.x, cp[i]!.y)));
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 184, 107, 0.06)";
      ctx.fill();
    }
    for (const [width, alpha, l] of [[9, 0.08, 60], [3.6, 0.3, 65], [1.5, 0.95, 82]] as const) {
      for (const [i, j] of cubeEdges) {
        const near = clamp(0.4 + 0.6 * ((cp[i]!.z + cp[j]!.z) / 2 + 1.5) / 3, 0.3, 1);
        ctx.strokeStyle = hsl(36, 100, l, alpha * near);
        ctx.lineWidth = width * ((cp[i]!.k + cp[j]!.k) / 2 / focal) * 5;
        ctx.beginPath();
        ctx.moveTo(cp[i]!.x, cp[i]!.y);
        ctx.lineTo(cp[j]!.x, cp[j]!.y);
        ctx.stroke();
      }
    }
    // the lamp
    const g = ctx.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, 34);
    g.addColorStop(0, "rgba(255, 255, 240, 1)");
    g.addColorStop(0.2, "rgba(255, 220, 150, 0.6)");
    g.addColorStop(1, "rgba(255, 200, 120, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(lamp.x - 34, lamp.y - 34, 68, 68);
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- Loop and controls ----------

  let backdrop: CanvasGradient | null = null;
  startLoop((dt) => {
    orbit.step(dt);
    if (dt > 0) {
      a1 += dt * speed * 0.9;
      a2 += dt * speed * 0.33;
      a3 += dt * speed * 0.17;
      c1 += dt * speed * 0.8;
      c2 += dt * speed * 0.37;
    }
    ctx.globalCompositeOperation = "source-over";
    backdrop ??= (() => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(view.w, view.h) * 0.7);
      g.addColorStop(0, "#1c1640");
      g.addColorStop(1, "#08071a");
      return g;
    })();
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, view.w, view.h);
    if (shape === "shadow") drawShadow();
    else drawPolytope(polytopes[shape]);
    const info = shape === "shadow" ? "8 вершин · 12 рёбер\n6 квадратов" : polytopes[shape].info;
    setReadout(view.w >= 700 ? info : null);
  });

  addChoice<Shape>(
    [
      { value: "tesseract", label: "🧊 Тессеракт", title: "Четырёхмерный куб" },
      { value: "16-cell", label: "💎 16-ячейник", title: "Четырёхмерный родственник пирамидки" },
      { value: "24-cell", label: "⭐ 24-ячейник", title: "Фигура, которая бывает только в четырёх измерениях" },
      { value: "shadow", label: "🔦 Тень куба", title: "Обычный куб и его плоская тень" },
    ],
    shape,
    (next) => {
      shape = next;
      layout();
      backdrop = null;
    },
  );
  addSlider({
    label: "🌀",
    min: 0,
    max: 1.5,
    step: 0.05,
    value: speed,
    title: "Скорость вращения в четвёртом измерении",
    onInput: (v) => (speed = v),
  });

  onResize(() => {
    layout();
    backdrop = null;
  });
  for (const p of Object.values(polytopes)) p.scale = 2 / reachOf(p);
  a1 = 0.4;
  a2 = 0.2;
  a3 = 0;
  layout();
  showHint("Смотри: маленький куб выворачивается и становится большим");
}
