// «Две щели»: the double-slit experiment, the most famous puzzle of quantum physics.
// Mode «Волна»: the 2D wave equation u_tt + 2σu_t = c²∇²u on a GPU grid (explicit leapfrog, ping-pong targets:
// r = u now, g = u one step ago, b = a running mean of u², the intensity). A soft line source on one side sends a plane
// wave into a wall with two slits (Dirichlet u = 0 in the wall); the two circular waves behind it interfere, and the
// screen strip at the far end shows the time-averaged intensity as bright and dark bands. A damping layer (σ grows
// towards the edges, behind the source and behind the screen) swallows the waves so nothing reflects back.
// Mode «Электроны»: electrons fly one by one and land on a detector plate. Each landing point is drawn from |ψ|²:
// the far-field two-slit pattern, a sinc² envelope (the width of a slit) times cos² stripes (the distance between the
// slits). One slit closed: one hump behind the open slit. «Шпион» (a detector at the slits): the path is known, the
// interference term is gone and the electrons land like little balls — a hump behind each slit, no stripes.
// On a tall screen the whole experiment is turned so that the waves run from the top to the bottom.

namespace DoubleSlit {
  type Mode = "wave" | "electrons";
  type Slits = "two" | "one" | "peek";

  const GRID = 512; // cells along the long side of the screen
  const LAMBDA = 10; // wavelength, cells
  const C = 0.5; // wave speed, cells per step (stable below 1/√2)
  const K = TAU / LAMBDA;
  const OMEGA = 2 * Math.asin(C * Math.sin(K / 2)); // the grid's own dispersion relation, radians per step
  const SOURCE_FORCE = 2 * C * C * Math.sin(K); // a line source of this strength makes waves of amplitude 1
  const FINGER_FORCE = 0.6;
  const SPONGE = 28; // cells of the damping layer
  const WALL = 4; // wall thickness, cells
  const STRIP = 12; // screen strip thickness, cells
  const STEPS_PER_SECOND = 420;
  const MAX_STEPS = 12;
  const WARMUP_STEPS = 520; // the first seconds already show the fan
  const MEAN_RATE = 0.004; // how fast the running mean of u² follows

  // Electrons: Y runs −1…1 across the plate
  const ENVELOPE = 1.25; // the sinc envelope of both slits: first zero at Y = 1/ENVELOPE
  const FRINGE = 0.15; // stripe period on the plate
  const SLIT_Y = 0.32; // the hump behind one slit: where it stands…
  const HUMP = 2.6; // …and how narrow it is (first zero at ΔY = 1/HUMP)
  const MAX_ELECTRONS = 60000;
  const FLIGHT_IN = 0.45; // seconds from the gun to the wall
  const FLIGHT_OUT = 0.35; // from the wall to the plate
  const VISIBLE_PER_SECOND = 25; // at most this many flights are drawn, the rest land at once

  const STEP_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_state;
uniform vec2 u_size;
uniform float u_axis;
uniform float u_source;
uniform float u_wall;
uniform float u_screen;
uniform vec3 u_slit;
uniform float u_open2;
uniform float u_force;
uniform vec4 u_fingers[4];
out vec4 o;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 m = ivec2(u_size) - 1;
  vec4 c = texelFetch(u_state, p, 0);
  float lap = texelFetch(u_state, min(p + ivec2(1, 0), m), 0).r
            + texelFetch(u_state, max(p - ivec2(1, 0), ivec2(0)), 0).r
            + texelFetch(u_state, min(p + ivec2(0, 1), m), 0).r
            + texelFetch(u_state, max(p - ivec2(0, 1), ivec2(0)), 0).r - 4.0 * c.r;
  vec2 g = gl_FragCoord.xy;
  vec2 q = u_axis < 0.5 ? g : vec2(u_size.y - g.y, g.x);
  float cross = u_axis < 0.5 ? u_size.y : u_size.x;
  // the damping layer: along the sides, behind the source and behind the screen
  float d = min(q.y, cross - q.y);
  d = min(d, q.x - (u_source - 2.0 - ${SPONGE}.0));
  d = min(d, u_screen + ${STRIP}.0 + ${SPONGE}.0 - q.x);
  float t = clamp(1.0 - d / ${SPONGE}.0, 0.0, 1.0);
  float sigma = 0.3 * t * t;
  float next = (2.0 * c.r - (1.0 - sigma) * c.g + ${C * C} * lap) / (1.0 + sigma);
  if (abs(q.x - u_source) < 0.5) next += u_force;
  for (int i = 0; i < 4; i++) {
    vec4 f = u_fingers[i];
    if (f.z != 0.0) {
      vec2 dd = g - f.xy;
      next += f.z * exp(-dot(dd, dd) / 4.0);
    }
  }
  if (q.x >= u_wall && q.x < u_wall + ${WALL}.0) {
    bool open = abs(q.y - u_slit.x) < u_slit.z || (u_open2 > 0.5 && abs(q.y - u_slit.y) < u_slit.z);
    if (!open) next = 0.0;
  }
  float mean = c.b + (next * next - c.b) * ${MEAN_RATE};
  o = vec4(next, c.r, mean, 1.0);
}`;

  const SHOW_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_state;
uniform sampler2D u_hits;
uniform sampler2D u_top;
uniform vec2 u_size;
uniform float u_axis;
uniform float u_mode;
uniform float u_source;
uniform float u_wall;
uniform float u_screen;
uniform vec3 u_slit;
uniform float u_open2;
uniform vec4 u_plate;
uniform vec2 u_glow;
uniform float u_phase;

vec4 fetch(vec2 g) {
  // bilinear by hand: f32 textures can't be filtered everywhere
  vec2 f = g - 0.5;
  ivec2 i = ivec2(floor(f));
  vec2 t = f - floor(f);
  ivec2 m = ivec2(u_size) - 1;
  vec4 a = texelFetch(u_state, clamp(i, ivec2(0), m), 0);
  vec4 b = texelFetch(u_state, clamp(i + ivec2(1, 0), ivec2(0), m), 0);
  vec4 c = texelFetch(u_state, clamp(i + ivec2(0, 1), ivec2(0), m), 0);
  vec4 d = texelFetch(u_state, clamp(i + ivec2(1, 1), ivec2(0), m), 0);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

vec2 toGrid(vec2 q) {
  return u_axis < 0.5 ? q : vec2(q.y, u_size.y - q.x);
}

void main() {
  vec2 g = v_uv * u_size;
  vec2 q = u_axis < 0.5 ? g : vec2(u_size.y - g.y, g.x);
  vec3 col = vec3(0.051, 0.043, 0.118);
  float mid = 0.5 * (u_slit.x + u_slit.y);

  if (u_mode < 0.5) {
    vec4 st = fetch(g);
    // circular waves fade as they spread: lift them back so the far fan is as bright as the near one
    float r = length(q - vec2(u_wall, mid));
    float gain = q.x > u_wall ? clamp(sqrt(r / 14.0), 1.0, 3.6) : 0.5;
    float v = st.r * gain;
    float glow = sqrt(max(st.b, 0.0)) * gain;
    col += vec3(1.0, 0.45, 0.35) * glow * 0.28;
    float crest = max(v, 0.0);
    col += vec3(0.12, 0.45, 1.0) * crest * 0.6 + vec3(0.6, 0.95, 1.0) * crest * crest * crest * 0.4;
    col += vec3(0.22, 0.08, 0.4) * max(-v, 0.0) * 0.4;
    // the lamp: a glowing line that sends the waves
    col += vec3(1.0, 0.82, 0.5) * exp(-abs(q.x - u_source) * 0.7) * (0.7 + 0.3 * sin(u_phase));

    // the screen: brightness is the mean intensity just before it, scaled by its brightest spot; the light
    // spills a little onto the water in front of it
    float lit = 0.0;
    if (q.x > u_screen - 40.0 && q.x < u_screen + ${STRIP}.0 && q.y > u_plate.z && q.y < u_plate.w) {
      float top = max(texelFetch(u_top, ivec2(0), 0).r, 1e-6);
      lit = clamp(fetch(toGrid(vec2(u_screen - 1.0, q.y))).b / top, 0.0, 1.0);
      col += vec3(1.0, 0.7, 0.4) * lit * exp(min(q.x - u_screen, 0.0) / 8.0) * 0.45;
    }
    if (q.x >= u_screen && q.x < u_screen + ${STRIP}.0 && q.y > u_plate.z && q.y < u_plate.w) {
      col = vec3(0.08, 0.06, 0.15) + vec3(1.6, 0.85, 0.4) * lit + vec3(0.8, 0.9, 1.0) * lit * lit * lit;
    }
    // the screen swallows the waves: nothing is seen behind it
    if (q.x >= u_screen + ${STRIP}.0) col = vec3(0.051, 0.043, 0.118);
  } else {
    // the detector plate: dark glass where the electrons leave their dots
    float edge = min(min(q.x - u_plate.x, u_plate.y - q.x), min(q.y - u_plate.z, u_plate.w - q.y));
    if (edge > 0.0) {
      col = vec3(0.075, 0.07, 0.16);
      float n = texelFetch(u_hits, ivec2(gl_FragCoord.xy), 0).r;
      float b = 1.0 - exp(-n * 0.55);
      col += vec3(0.35, 0.85, 1.0) * b + vec3(0.6, 0.6, 0.5) * b * b;
    }
    col += vec3(0.55, 0.5, 0.95) * exp(-abs(edge) * 1.2) * 0.35;
    // the electron gun
    vec2 gun = q - vec2(u_source, mid);
    float barrel = max(abs(gun.x + 6.0) - 8.0, abs(gun.y) - 4.0);
    col = mix(col, vec3(0.32, 0.28, 0.45), step(barrel, 0.0));
    col += vec3(1.0, 0.7, 0.35) * exp(-length(gun - vec2(2.0, 0.0)) * 0.35) * 0.9;
  }

  // the wall with its slits; the closed slit is plugged with a lid
  if (q.x >= u_wall && q.x < u_wall + ${WALL}.0) {
    bool open1 = abs(q.y - u_slit.x) < u_slit.z;
    bool open2 = abs(q.y - u_slit.y) < u_slit.z;
    if (!open1 && !(open2 && u_open2 > 0.5)) {
      float shade = 0.85 + 0.15 * (q.x - u_wall) / ${WALL}.0;
      col = vec3(0.36, 0.32, 0.5) * shade;
      if (open2) col = vec3(0.62, 0.38, 0.42);
    }
  }
  // the slits' edges glow; in the electron mode they flash when an electron goes through
  for (int j = 0; j < 2; j++) {
    float cj = j == 0 ? u_slit.x : u_slit.y;
    float on = j == 0 ? 1.0 : u_open2;
    float lip = abs(abs(q.y - cj) - u_slit.z);
    float near = abs(q.x - u_wall - ${WALL / 2}.0);
    col += vec3(1.0, 0.8, 0.55) * exp(-lip * 0.9 - near * 0.4) * 0.5 * on;
    float flash = j == 0 ? u_glow.x : u_glow.y;
    col += vec3(0.5, 0.9, 1.0) * exp(-length(q - vec2(u_wall + ${WALL / 2}.0, cj)) * 0.18) * flash;
  }
  o = vec4(1.0 - exp(-col * 1.3), 1.0);
}`;

  /** The brightest spot on the screen, into a 1×1 target, so the screen shows its bands at full contrast. */
  const TOP_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_state;
uniform vec2 u_size;
uniform float u_axis;
uniform float u_screen;
uniform vec2 u_range;
out vec4 o;
void main() {
  float top = 1e-6;
  for (int k = 0; k < 128; k++) {
    float y = mix(u_range.x, u_range.y, (float(k) + 0.5) / 128.0);
    vec2 g = u_axis < 0.5 ? vec2(u_screen - 1.0, y) : vec2(y, u_size.y - u_screen + 1.0);
    top = max(top, texelFetch(u_state, ivec2(g), 0).b);
  }
  o = vec4(top, 0.0, 0.0, 1.0);
}`;

  const SPRITE_VS = `#version 300 es
in vec2 a_pos;
in vec2 a_shape;
in vec4 a_color;
uniform vec2 u_size;
out vec4 v_color;
out float v_ring;
void main() {
  gl_Position = vec4(a_pos / u_size * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = a_shape.x;
  v_ring = a_shape.y;
  v_color = a_color;
}`;

  const SPRITE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_ring;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = length(d);
  if (r > 1.0) discard;
  float a = v_ring > 0.5 ? exp(-pow((r - 0.7) * 7.0, 2.0)) : exp(-r * r * 5.0);
  o = vec4(v_color.rgb * v_color.a * a, 1.0);
}`;

  const gl = canvasGL(1.5);
  if (gl) start(gl);

  function start(gl: WebGL2RenderingContext): void {
    const float = glFloat(gl);
    const stateType = float.f32 ? "f32" : "f16";
    const stepProgram = glProgram(gl, STEP_FS);
    const stepU = glUniforms(gl, stepProgram);
    const showProgram = glProgram(gl, SHOW_FS);
    const showU = glUniforms(gl, showProgram);
    const topProgram = glProgram(gl, TOP_FS);
    const topU = glUniforms(gl, topProgram);
    const top = glTarget(gl, 1, 1, { type: stateType });
    const spriteProgram = glProgram(gl, SPRITE_FS, SPRITE_VS);
    const spriteU = glUniforms(gl, spriteProgram);
    const shapeAt = gl.getAttribLocation(spriteProgram, "a_shape");
    const colorAt = gl.getAttribLocation(spriteProgram, "a_color");

    // sprites: x, y (grid cells), size (px), ring, r, g, b, a
    const SPRITE = 8;
    const spriteVao = gl.createVertexArray()!;
    const spriteBuffer = gl.createBuffer()!;
    gl.bindVertexArray(spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, SPRITE * 4, 0);
    gl.enableVertexAttribArray(shapeAt);
    gl.vertexAttribPointer(shapeAt, 2, gl.FLOAT, false, SPRITE * 4, 8);
    gl.enableVertexAttribArray(colorAt);
    gl.vertexAttribPointer(colorAt, 4, gl.FLOAT, false, SPRITE * 4, 16);
    gl.bindVertexArray(null);
    let sprites = new Float32Array(SPRITE * 2048);
    let spriteCount = 0;

    let mode: Mode = "wave";
    let slits: Slits = "two";

    // ---------- Layout: grid size and where everything stands, in grid cells ----------

    let W = 1, H = 1;
    let portrait = false;
    let state = glPingPong(gl, 1, 1, { type: stateType });
    let hits = glTarget(gl, 1, 1, { type: float.f16 ? "f16" : "u8" });
    const geo = { source: 0, wall: 0, screen: 0, slit1: 0, slit2: 0, halfSlit: 0, c0: 0, c1: 0, plate0: 0, plate1: 0 };

    /** CSS pixels → grid cells (x right, y up). */
    const toGrid = (x: number, y: number): [number, number] => [(x * W) / view.w, ((view.h - y) * H) / view.h];
    /** Grid cells → (s along the waves, c across them). */
    const toSC = (gx: number, gy: number): [number, number] => (portrait ? [H - gy, gx] : [gx, gy]);
    const fromSC = (s: number, c: number): [number, number] => (portrait ? [c, H - s] : [s, c]);

    function layout(): void {
      portrait = view.h > view.w * 1.05;
      const long = Math.max(view.w, view.h);
      W = Math.max(16, Math.round((view.w / long) * GRID));
      H = Math.max(16, Math.round((view.h / long) * GRID));
      const area = freeArea();
      // the plate stands on the right of a wide screen, under the readout «Электронов: N» (72 px from the top + its
      // height): keep it below
      const top = portrait ? area.y : Math.max(area.y, 124);
      const [ax0, ay0] = toGrid(area.x, top);
      const [ax1, ay1] = toGrid(area.x + area.w, area.y + area.h);
      const [sa, ca] = toSC(ax0, ay0);
      const [sb, cb] = toSC(ax1, ay1);
      const s0 = portrait ? Math.min(sa, sb) : 0;
      const s1 = portrait ? Math.max(sa, sb) : W;
      const len = s1 - s0;
      geo.c0 = Math.min(ca, cb) + 4;
      geo.c1 = Math.max(ca, cb) - 4;
      const cLen = geo.c1 - geo.c0;
      const mid = (geo.c0 + geo.c1) / 2;
      geo.source = Math.round(Math.max(s0 + (portrait ? 16 : 8), SPONGE + 6)) + 0.5;
      geo.wall = Math.round(s0 + len * 0.36);
      geo.screen = Math.round(Math.min(s1 - STRIP - 4, (portrait ? H : W) - SPONGE * 0.5 - STRIP));
      const d = cLen * 0.27;
      geo.slit1 = mid + d / 2;
      geo.slit2 = mid - d / 2;
      geo.halfSlit = LAMBDA * 0.45;
      geo.plate0 = Math.round(s0 + len * 0.6);
      geo.plate1 = geo.screen + STRIP;
      state = glPingPong(gl!, W, H, { type: stateType });
      hits = glTarget(gl!, stage.width, stage.height, { type: float.f16 ? "f16" : "u8" });
      redrawHits();
      warm = mode === "wave" ? WARMUP_STEPS : 0;
      phase = 0;
      ramp = 0;
    }

    // ---------- Waves ----------

    let phase = 0;
    let ramp = 0; // the source fades in so the first front is smooth
    let warm = 0;
    let stepDebt = 0;
    const fingers = new Float32Array(16);
    /** Fingers on the water: a point source keeps ringing a little after the finger is lifted. */
    const ripples = new Map<number, { x: number; y: number; left: number }>();

    function step(): void {
      phase += OMEGA;
      ramp = Math.min(1, ramp + 1 / 60);
      fingers.fill(0);
      let i = 0;
      for (const r of ripples.values()) {
        if (i >= 4) break;
        fingers[i * 4] = r.x;
        fingers[i * 4 + 1] = r.y;
        fingers[i * 4 + 2] = FINGER_FORCE * Math.sin(phase) * Math.min(1, r.left / 0.15);
        i++;
      }
      glBindTarget(gl!, state.write);
      gl!.useProgram(stepProgram);
      glTexture(gl!, 0, state.read.tex, stepU("u_state"));
      gl!.uniform2f(stepU("u_size"), W, H);
      gl!.uniform1f(stepU("u_axis"), portrait ? 1 : 0);
      gl!.uniform1f(stepU("u_source"), geo.source);
      gl!.uniform1f(stepU("u_wall"), geo.wall);
      gl!.uniform1f(stepU("u_screen"), geo.screen);
      gl!.uniform3f(stepU("u_slit"), geo.slit1, geo.slit2, geo.halfSlit);
      gl!.uniform1f(stepU("u_open2"), slits === "one" ? 0 : 1);
      gl!.uniform1f(stepU("u_force"), SOURCE_FORCE * ramp * Math.sin(phase));
      gl!.uniform4fv(stepU("u_fingers"), fingers);
      glDrawQuad(gl!);
      state.swap();
    }

    function resetWaves(): void {
      for (const t of [state.read, state.write]) {
        glBindTarget(gl!, t);
        gl!.clearColor(0, 0, 0, 0);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
      }
      phase = 0;
      ramp = 0;
      warm = WARMUP_STEPS;
    }

    // ---------- Electrons ----------

    let count = 0;
    let fired = 0;
    let electronTime = 0;
    let fireDebt = 0;
    const stored: number[] = []; // landing points: u along the plate 0…1, Y across it −1…1
    const pendingHits: number[] = [];
    interface Flight { age: number; slit: number; u: number; y: number; land: boolean }
    let flights: Flight[] = [];
    const glow = [0, 0];
    const eyes = [0, 0];

    const sinc = (x: number): number => (Math.abs(x) < 1e-6 ? 1 : Math.sin(x) / x);
    /** The hump behind one slit (j = 0 or 1), as a ball flying through it would leave. */
    const hump = (y: number, j: number): number => sinc((y - (j === 0 ? SLIT_Y : -SLIT_Y)) * HUMP * Math.PI) ** 2;
    /** Where an electron may land: |ψ|² for two slits, one hump for one slit, two humps when the spy watches. */
    function density(y: number): number {
      if (slits === "one") return hump(y, 0);
      if (slits === "peek") return hump(y, 0) + hump(y, 1);
      const a = sinc(y * ENVELOPE * Math.PI);
      return a * a * Math.cos((Math.PI * y) / FRINGE) ** 2;
    }

    function sampleY(): number {
      const top = slits === "peek" ? 1.1 : 1.0;
      for (let k = 0; k < 400; k++) {
        const y = rand(-1, 1);
        if (Math.random() * top < density(y)) return y;
      }
      return 0;
    }

    /** Which slit the spy saw it in: the hump this landing point most likely came from. */
    function slitOf(y: number): number {
      if (slits === "one") return 0;
      const a1 = hump(y, 0);
      const a2 = hump(y, 1);
      return Math.random() * (a1 + a2) < a1 ? 0 : 1;
    }

    function fire(rate: number): void {
      fired++;
      const y = sampleY();
      const u = rand(0.04, 0.96);
      if (Math.random() < VISIBLE_PER_SECOND / Math.max(rate, VISIBLE_PER_SECOND)) {
        flights.push({ age: 0, slit: slitOf(y), u, y, land: false });
      } else {
        land(u, y);
      }
    }

    function land(u: number, y: number): void {
      count++;
      stored.push(u, y);
      pendingHits.push(u, y);
    }

    /** Plate point (u, Y) → grid cells. */
    function platePoint(u: number, y: number): [number, number] {
      const mid = (geo.c0 + geo.c1) / 2;
      const half = (geo.c1 - geo.c0) / 2;
      return fromSC(lerp(geo.plate0, geo.plate1, u), mid + y * half);
    }

    function resetElectrons(): void {
      count = 0;
      fired = 0;
      electronTime = 0;
      fireDebt = 0;
      stored.length = 0;
      pendingHits.length = 0;
      flights = [];
      glBindTarget(gl!, hits);
      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
    }

    function redrawHits(): void {
      glBindTarget(gl!, hits);
      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
      pendingHits.length = 0;
      pendingHits.push(...stored);
    }

    function pushSprite(x: number, y: number, size: number, ring: number, r: number, g: number, b: number, a: number): void {
      if ((spriteCount + 1) * SPRITE > sprites.length) {
        const bigger = new Float32Array(sprites.length * 2);
        bigger.set(sprites);
        sprites = bigger;
      }
      sprites.set([x, y, size, ring, r, g, b, a], spriteCount * SPRITE);
      spriteCount++;
    }

    function drawSprites(target: Target | null): void {
      if (!spriteCount) return;
      glBindTarget(gl!, target);
      gl!.useProgram(spriteProgram);
      gl!.uniform2f(spriteU("u_size"), W, H);
      gl!.bindVertexArray(spriteVao);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, spriteBuffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, sprites.subarray(0, spriteCount * SPRITE), gl!.DYNAMIC_DRAW);
      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.ONE, gl!.ONE);
      gl!.drawArrays(gl!.POINTS, 0, spriteCount);
      gl!.disable(gl!.BLEND);
      gl!.bindVertexArray(null);
      spriteCount = 0;
    }

    function electrons(dt: number): void {
      if (dt > 0) {
        electronTime += dt;
        // slow at first, so each dot is seen; then faster and faster
        const t = electronTime;
        const rate = Math.min(1500, 1.5 + 0.35 * t * t * t);
        fireDebt += rate * dt;
        while (fireDebt >= 1 && fired < MAX_ELECTRONS) {
          fireDebt -= 1;
          fire(rate);
        }
        if (fired >= MAX_ELECTRONS) fireDebt = 0;
        for (const f of flights) {
          const before = f.age;
          f.age += dt;
          if (before < FLIGHT_IN && f.age >= FLIGHT_IN) {
            if (slits === "two") glow[0] = glow[1] = 1;
            else glow[f.slit] = 1;
            if (slits === "peek") eyes[f.slit] = 1;
          }
          if (!f.land && f.age >= FLIGHT_IN + FLIGHT_OUT) {
            f.land = true;
            land(f.u, f.y);
          }
        }
        flights = flights.filter((f) => f.age < FLIGHT_IN + FLIGHT_OUT + 0.5);
        const k = Math.exp(-dt * 6);
        for (let j = 0; j < 2; j++) {
          glow[j]! *= k;
          eyes[j]! *= k;
        }
      }
      // new dots go into the plate texture once
      const size = Math.max(3, 2.8 * view.dpr);
      for (let i = 0; i < pendingHits.length; i += 2) {
        const [x, y] = platePoint(pendingHits[i]!, pendingHits[i + 1]!);
        pushSprite(x, y, size, 0, 1.2, 1.2, 1.2, 1);
        if (spriteCount > 20000) drawSprites(hits);
      }
      pendingHits.length = 0;
      drawSprites(hits);
      setReadout(`Электронов: ${count.toLocaleString("ru-RU")}`);
    }

    function electronSprites(): void {
      const mid = (geo.c0 + geo.c1) / 2;
      const dpr = view.dpr;
      for (const f of flights) {
        if (f.age < FLIGHT_IN) {
          // to the wall: straight at the slit when it is known, otherwise at the middle, blurring as it goes
          const t = f.age / FLIGHT_IN;
          const known = slits !== "two";
          const target = known ? (f.slit === 0 ? geo.slit1 : geo.slit2) : mid;
          const [x, y] = fromSC(lerp(geo.source + 2, geo.wall, t), lerp(mid, target, t));
          const blur = known ? 0 : t;
          pushSprite(x, y, (9 + 14 * blur) * dpr, 0, 0.6, 0.95, 1, 1 - 0.75 * blur);
        } else if (f.age < FLIGHT_IN + FLIGHT_OUT) {
          // behind the wall nobody knows the path, unless a slit was watched or the other one closed
          if (slits === "two") continue;
          const t = (f.age - FLIGHT_IN) / FLIGHT_OUT;
          const [px, py] = platePoint(f.u, f.y);
          const [ps, pc] = toSC(px, py);
          const [x, y] = fromSC(lerp(geo.wall + WALL, ps, t), lerp(f.slit === 0 ? geo.slit1 : geo.slit2, pc, t));
          pushSprite(x, y, 9 * dpr, 0, 0.6, 0.95, 1, 1);
        } else {
          // the flash where it landed
          const fade = 1 - (f.age - FLIGHT_IN - FLIGHT_OUT) / 0.5;
          const [x, y] = platePoint(f.u, f.y);
          pushSprite(x, y, 14 * dpr, 0, 0.8, 1, 1, fade * 1.5);
          pushSprite(x, y, 34 * dpr * (1.2 - fade), 1, 0.5, 0.85, 1, fade);
        }
      }
      if (slits === "peek") {
        // the detectors: two little eyes beside the slits that blink when they catch an electron
        for (let j = 0; j < 2; j++) {
          const c = j === 0 ? geo.slit1 : geo.slit2;
          const [x, y] = fromSC(geo.wall - 9, c + (j === 0 ? 1 : -1) * (geo.halfSlit + 7));
          pushSprite(x, y, 22 * dpr, 1, 1, 0.75, 0.4, 0.55 + eyes[j]!);
          pushSprite(x, y, 9 * dpr, 0, 1, 0.8, 0.5, 0.5 + eyes[j]!);
        }
      }
    }

    // ---------- Frame ----------

    function show(): void {
      if (mode === "wave") {
        glBindTarget(gl!, top);
        gl!.useProgram(topProgram);
        glTexture(gl!, 0, state.read.tex, topU("u_state"));
        gl!.uniform2f(topU("u_size"), W, H);
        gl!.uniform1f(topU("u_axis"), portrait ? 1 : 0);
        gl!.uniform1f(topU("u_screen"), geo.screen);
        gl!.uniform2f(topU("u_range"), geo.c0, geo.c1);
        glDrawQuad(gl!);
      }
      glBindTarget(gl!, null);
      gl!.useProgram(showProgram);
      glTexture(gl!, 0, state.read.tex, showU("u_state"));
      glTexture(gl!, 1, hits.tex, showU("u_hits"));
      glTexture(gl!, 2, top.tex, showU("u_top"));
      gl!.uniform2f(showU("u_size"), W, H);
      gl!.uniform1f(showU("u_axis"), portrait ? 1 : 0);
      gl!.uniform1f(showU("u_mode"), mode === "wave" ? 0 : 1);
      gl!.uniform1f(showU("u_source"), geo.source);
      gl!.uniform1f(showU("u_wall"), geo.wall);
      gl!.uniform1f(showU("u_screen"), geo.screen);
      gl!.uniform3f(showU("u_slit"), geo.slit1, geo.slit2, geo.halfSlit);
      gl!.uniform1f(showU("u_open2"), slits === "one" ? 0 : 1);
      gl!.uniform4f(showU("u_plate"), geo.plate0, geo.plate1, geo.c0, geo.c1);
      gl!.uniform2f(showU("u_glow"), mode === "electrons" ? glow[0]! : 0, mode === "electrons" ? glow[1]! : 0);
      gl!.uniform1f(showU("u_phase"), phase);
      glDrawQuad(gl!);
      if (mode === "electrons") electronSprites();
      else {
        for (const r of ripples.values()) {
          const [x, y] = toGrid(...cssOf(r));
          pushSprite(x, y, 34 * view.dpr, 1, 0.6, 0.9, 1, 0.5 * Math.min(1, r.left / 0.15));
        }
      }
      drawSprites(null);
    }

    const cssOf = (r: { x: number; y: number }): [number, number] => [(r.x * view.w) / W, view.h - (r.y * view.h) / H];

    startLoop((dt) => {
      if (mode === "wave") {
        let steps = 0;
        if (warm > 0) {
          steps = Math.min(warm, 40);
          warm -= steps;
        } else if (dt > 0) {
          stepDebt += dt * STEPS_PER_SECOND;
          steps = Math.min(MAX_STEPS, Math.floor(stepDebt));
          stepDebt -= Math.floor(stepDebt);
        }
        for (let i = 0; i < steps; i++) step();
        for (const [id, r] of ripples) {
          if (!pointers.has(id)) r.left -= dt;
          if (r.left <= 0) ripples.delete(id);
        }
        setReadout(null);
      } else {
        electrons(dt);
      }
      show();
    });

    // ---------- Controls ----------

    addChoice<Mode>(
      [
        { value: "wave", label: "🌊 Волна", title: "Волны на воде или свет" },
        { value: "electrons", label: "⚛️ Электроны", title: "Электроны летят по одному" },
      ],
      mode,
      (next) => {
        mode = next;
        if (mode === "wave") resetWaves();
        else resetElectrons();
        peekButton.disabled = mode === "wave";
        if (mode === "wave" && slits === "peek") setSlits("two");
        showHint(mode === "wave" ? "Нажми на воду — палец станет ещё одним источником волн" : "Электроны летят по одному. Смотри, что выйдет на экране");
      },
    );
    const slitChoice = addChoice<Slits>(
      [
        { value: "two", label: "✌️ Две", title: "Открыты обе щели" },
        { value: "one", label: "☝️ Одна", title: "Закрыть одну щель" },
        { value: "peek", label: "🕵️ Шпион", title: "Подглядеть: поставить у щелей датчик, через какую пролетел электрон" },
      ],
      slits,
      (next) => setSlits(next),
    );
    const peekButton = controls.lastElementChild!.lastElementChild as HTMLButtonElement;
    peekButton.disabled = true;
    function setSlits(next: Slits): void {
      slits = next;
      slitChoice.set(next);
      if (mode === "electrons") resetElectrons();
    }
    // on a narrow phone the bar has no room for 🔄: a second tap on the chosen mode starts over just as well
    const again = addButton("🔄", () => (mode === "wave" ? resetWaves() : resetElectrons()), { round: true, title: "Начать заново" });
    const fitBar = () => {
      again.hidden = view.w < 430;
      // on a phone the readout goes just under the title, however many lines the question takes
      const below = document.querySelector(".heading")!.getBoundingClientRect().bottom + 8;
      $("readout").style.top = view.w <= 700 ? `${Math.round(below)}px` : "";
    };

    onPointer({
      down(p) {
        if (mode === "electrons") {
          // a tap fires a handful at once
          for (let i = 0; i < 12 && fired < MAX_ELECTRONS; i++) fire(VISIBLE_PER_SECOND);
          return;
        }
        if (ripples.size >= 4) return;
        const [x, y] = toGrid(p.x, p.y);
        ripples.set(p.id, { x, y, left: 0.6 });
      },
      move(p) {
        const r = ripples.get(p.id);
        if (!r || !p.down) return;
        [r.x, r.y] = toGrid(p.x, p.y);
      },
    });
    onResize(() => {
      fitBar();
      layout();
    });

    fitBar();
    layout();
    showHint("Нажми на воду — палец станет ещё одним источником волн");
  }
}
