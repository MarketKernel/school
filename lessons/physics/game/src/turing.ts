// «Узоры Тьюринга»: the Gray–Scott reaction–diffusion model. Two chemicals spread over a plate: U is fed in from
// outside at rate F, V eats it (U + 2V → 3V) and is removed at rate F + k:
//   ∂u/∂t = Du ∇²u − u v² + F (1 − u)
//   ∂v/∂t = Dv ∇²v + u v² − (F + k) v
// U spreads twice as fast as V, so a patch of V starves its own surroundings and the plate breaks into stripes,
// spots, corals or dividing cells depending on F and k (Alan Turing's 1952 idea of how patterns form in living
// things). Solved on the GPU: the state (u, v) lives in a float texture with periodic edges, every step is an explicit
// Euler update with the 5-point Laplacian (grid step 1, dt 1, Du = 0.2097, Dv = 0.105), dozens of steps per frame by
// ping-pong. f32 targets where the GPU has them, else f16 (the patterns still form). The picture maps V to a soft
// gradient and lights its slope as a relief.

namespace Turing {
  type Preset = "zebra" | "leopard" | "coral" | "cells" | "worms";

  const DU = 0.2097;
  const DV = 0.105;
  const STEPS = 24; // simulation steps per frame
  const WARMUP_STEPS = 90; // per frame during the first second, so the pattern is already there
  const SHORT_CELLS = 230; // grid cells on the short side of the screen
  const BRUSH = 5; // cells
  const SEEDS = 22;

  interface Look {
    feed: number;
    kill: number;
    /** colour of the middle and the top of the gradient (RGB 0…1); the bottom is the night background */
    mid: [number, number, number];
    top: [number, number, number];
  }

  // (F, k) from the Pearson / Munafo maps of the Gray–Scott model
  const presets: Record<Preset, Look> = {
    zebra: { feed: 0.029, kill: 0.057, mid: [0.35, 0.55, 0.85], top: [1.0, 0.95, 0.86] },
    leopard: { feed: 0.03, kill: 0.062, mid: [0.85, 0.45, 0.18], top: [1.0, 0.85, 0.45] },
    coral: { feed: 0.0545, kill: 0.062, mid: [0.85, 0.3, 0.45], top: [1.0, 0.75, 0.62] },
    cells: { feed: 0.0367, kill: 0.0649, mid: [0.2, 0.65, 0.55], top: [0.8, 1.0, 0.75] },
    worms: { feed: 0.054, kill: 0.0635, mid: [0.55, 0.35, 0.9], top: [0.95, 0.8, 1.0] },
  };

  const gl = canvasGL(1);
  const float = gl ? glFloat(gl) : null;
  if (gl && !float!.f16) {
    const note = $("no-gl");
    note.textContent = "Этот браузер не умеет считать на видеокарте дробными числами, а без этого узоры не вырастут. Попробуйте открыть урок в свежем Chrome, Safari или Firefox.";
    note.hidden = false;
  }
  if (gl && float!.f16) run(gl, float!.f32 && location.hash !== "#f16");

  function run(gl: WebGL2RenderingContext, full: boolean): void {
    const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_state;
uniform ivec2 u_size;
vec2 cell(ivec2 p) {
  return texelFetch(u_state, (p + u_size) % u_size, 0).xy;
}
`;
    const program = (body: string) => {
      const p = glProgram(gl, header + body);
      return { p, u: glUniforms(gl, p) };
    };

    const react = program(`
uniform float u_feed;
uniform float u_kill;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = cell(p);
  vec2 lap = cell(p + ivec2(1, 0)) + cell(p - ivec2(1, 0)) + cell(p + ivec2(0, 1)) + cell(p - ivec2(0, 1)) - 4.0 * c;
  float uvv = c.x * c.y * c.y;
  float u = c.x + ${DU} * lap.x - uvv + u_feed * (1.0 - c.x);
  float v = c.y + ${DV} * lap.y + uvv - (u_feed + u_kill) * c.y;
  o = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), 0.0, 1.0);
}`);

    // V poured along a segment (a finger's last move), with a little noise so the growth isn't perfectly round
    const paint = program(`
uniform vec2 u_a;
uniform vec2 u_b;
uniform float u_radius;
uniform float u_seed;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + u_seed) * 43758.5453);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 c = cell(ivec2(p));
  vec2 ab = u_b - u_a;
  float t = clamp(dot(p - u_a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float d = length(p - u_a - ab * t);
  if (d < u_radius) c = vec2(0.5 + 0.1 * hash(p), 0.25 + 0.1 * hash(p + 7.0));
  o = vec4(c, 0.0, 1.0);
}`);

    const display = program(`
uniform vec2 u_screen;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_top;
// bilinear V at a fractional cell position (float targets need not filter linearly)
float vAt(vec2 q) {
  q -= 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = fract(q);
  float a = cell(i).y, b = cell(i + ivec2(1, 0)).y, c = cell(i + ivec2(0, 1)).y, d = cell(i + ivec2(1, 1)).y;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec2 q = v_uv * vec2(u_size);
  float v = vAt(q);
  float gx = vAt(q + vec2(0.7, 0.0)) - vAt(q - vec2(0.7, 0.0));
  float gy = vAt(q + vec2(0.0, 0.7)) - vAt(q - vec2(0.0, 0.7));
  float t = smoothstep(0.02, 0.42, v);
  vec3 col = t < 0.5 ? mix(u_low, u_mid, t * 2.0) : mix(u_mid, u_top, t * 2.0 - 1.0);
  // relief: V is the height, lit from the top-left, with a soft shine on the slopes facing the light
  vec3 n = normalize(vec3(-gx * 9.0, -gy * 9.0, 1.0));
  vec3 light = normalize(vec3(-0.5, 0.6, 0.65));
  float diffuse = dot(n, light);
  float shine = pow(max(dot(reflect(-light, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  col *= 0.72 + 0.4 * diffuse;
  col += shine * 0.35 * t;
  // a faint vignette keeps the eye in the middle
  vec2 e = v_uv - 0.5;
  col *= 1.0 - 0.35 * dot(e, e);
  o = vec4(col, 1.0);
}`);

    // ---------- State ----------

    let preset: Preset = "coral";
    let gridW = 1, gridH = 1;
    let state: ReturnType<typeof glPingPong> | null = null;
    let warmup = 0;

    /** Fills the plate with U = 1, V = 0 and drops a few round seeds of V. */
    function seed(): void {
      const data = new Float32Array(gridW * gridH * 4);
      for (let i = 0; i < gridW * gridH; i++) {
        data[i * 4] = 1;
        data[i * 4 + 3] = 1;
      }
      for (let s = 0; s < SEEDS; s++) {
        const cx = rand(0, gridW), cy = rand(0, gridH), r = rand(2.5, 6);
        for (let y = Math.floor(cy - r); y <= cy + r; y++) {
          for (let x = Math.floor(cx - r); x <= cx + r; x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
            const i = ((((y % gridH) + gridH) % gridH) * gridW + (((x % gridW) + gridW) % gridW)) * 4;
            data[i] = 0.5 + rand(-0.05, 0.05);
            data[i + 1] = 0.25 + rand(-0.05, 0.05);
          }
        }
      }
      const s = state!;
      gl.bindTexture(gl.TEXTURE_2D, s.read.tex);
      // floats upload into an f16 texture too: WebGL converts them
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, data);
      warmup = 1;
    }

    function make(): void {
      if (state) {
        for (const t of [state.read, state.write]) {
          gl.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
        }
      }
      const cellPx = Math.min(view.w, view.h) / SHORT_CELLS;
      gridW = Math.max(16, Math.round(view.w / cellPx));
      gridH = Math.max(16, Math.round(view.h / cellPx));
      state = glPingPong(gl, gridW, gridH, { type: full ? "f32" : "f16" });
      seed();
    }

    function use(prog: { p: WebGLProgram; u: (name: string) => WebGLUniformLocation | null }, target: Target | null): void {
      gl.useProgram(prog.p);
      glBindTarget(gl, target);
      gl.uniform2i(prog.u("u_size"), gridW, gridH);
    }

    function simulate(steps: number): void {
      const s = state!;
      const look = presets[preset];
      use(react, s.write);
      gl.uniform1f(react.u("u_feed"), look.feed);
      gl.uniform1f(react.u("u_kill"), look.kill);
      for (let i = 0; i < steps; i++) {
        glBindTarget(gl, s.write);
        glTexture(gl, 0, s.read.tex, react.u("u_state"));
        glDrawQuad(gl);
        s.swap();
      }
    }

    const strokes: [number, number, number, number][] = [];

    function applyStrokes(): void {
      const s = state!;
      for (const [ax, ay, bx, by] of strokes) {
        use(paint, s.write);
        glTexture(gl, 0, s.read.tex, paint.u("u_state"));
        gl.uniform2f(paint.u("u_a"), ax, ay);
        gl.uniform2f(paint.u("u_b"), bx, by);
        gl.uniform1f(paint.u("u_radius"), BRUSH);
        gl.uniform1f(paint.u("u_seed"), rand(0, 100));
        glDrawQuad(gl);
        s.swap();
      }
      strokes.length = 0;
    }

    function show(): void {
      const look = presets[preset];
      use(display, null);
      glTexture(gl, 0, state!.read.tex, display.u("u_state"));
      gl.uniform3f(display.u("u_low"), 0.051, 0.043, 0.118);
      gl.uniform3f(display.u("u_mid"), ...look.mid);
      gl.uniform3f(display.u("u_top"), ...look.top);
      glDrawQuad(gl);
    }

    // ---------- Input ----------

    /** Screen CSS pixels → grid cells (the grid's y runs up). */
    const toCell = (x: number, y: number): [number, number] => [(x / view.w) * gridW, (1 - y / view.h) * gridH];

    onPointer({
      down(p) {
        const [x, y] = toCell(p.x, p.y);
        strokes.push([x, y, x, y]);
      },
      move(p) {
        if (!p.down) return;
        const [ax, ay] = toCell(p.x - p.dx, p.y - p.dy);
        const [bx, by] = toCell(p.x, p.y);
        strokes.push([ax, ay, bx, by]);
      },
    });

    // ---------- Loop ----------

    make();
    onResize(make);

    startLoop((dt) => {
      if (strokes.length) applyStrokes();
      if (dt > 0) {
        warmup = Math.max(0, warmup - dt);
        simulate(warmup > 0 ? WARMUP_STEPS : STEPS);
      }
      show();
    });

    addButton("🔄", seed, { round: true, title: "Посеять заново" });
    const choices: { value: Preset; emoji: string; name: string; title: string }[] = [
      { value: "zebra", emoji: "🦓", name: "Зебра", title: "полоски и лабиринты" },
      { value: "leopard", emoji: "🐆", name: "Леопард", title: "пятнышки" },
      { value: "coral", emoji: "🪸", name: "Кораллы", title: "ветвистые кораллы" },
      { value: "cells", emoji: "🦠", name: "Клетки", title: "пятнышки, которые делятся пополам" },
      { value: "worms", emoji: "🪱", name: "Черви", title: "извилистые червячки" },
    ];
    addChoice<Preset>(
      choices.map((c) => ({ value: c.value, label: `${c.emoji} ${c.name}`, title: `${c.name}: ${c.title}` })),
      preset,
      (next) => {
        preset = next;
        seed();
      },
    );
    // names when they fit in one row, only the pictures when they don't (a phone); the names stay in the tooltips
    const group = controls.lastElementChild as HTMLElement;
    const fitLabels = () => {
      const buttons = [...group.querySelectorAll("button")];
      buttons.forEach((b, i) => (b.textContent = `${choices[i]!.emoji} ${choices[i]!.name}`));
      if (group.offsetHeight > buttons[0]!.offsetHeight * 1.6) buttons.forEach((b, i) => (b.textContent = choices[i]!.emoji));
      placeHint();
    };
    fitLabels();
    onResize(fitLabels);

    showHint("Порисуй пальцем — из линии вырастет узор");
  }
}
