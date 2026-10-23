// «Свет на дне бассейна»: caustics. Sunlight is bent by the wavy water surface (Snell's law, n = 1.33); bumps act like
// little lenses and gather the light into a bright net on the floor.
// The surface is a height field: ripples from the wave equation on a GPU grid (leapfrog, ping-pong, reflecting pool
// walls, slight damping; fingers and raindrops push it down) plus a fixed set of gentle analytic swells that never stop.
// The light: a ray through the surface point x tilts by about (1 − 1/n)·∇h and meets the floor at depth d at
// x + d(1 − 1/n)∇h. Light per floor area is 1/|det J| of that map, J = I + d(1 − 1/n)·Hess h: flat water gives 1,
// a focusing bump more, and along the lines where det J = 0 (the caustics) it is brightest. For each floor pixel the
// shader steps back to the surface point whose ray lands there (one fixed-point step) and takes ∇h and Hess h there —
// the swells exactly, the ripples by finite differences of the grid. The floor (procedural tiles, a lane stripe) is
// seen from above through the same surface, lit by that light, tinted by the water, with the sun's glints on top.

namespace Caustics {
  const GRID = 256; // ripple cells along the long side
  const C2 = 0.35; // (c dt / dx)²
  const DAMP = 0.994;
  const STEPS_PER_SECOND = 120;
  const MAX_STEPS = 4;
  const SLOPE = 1.0; // turns ripple heights (grid units) into surface slopes
  const N_WATER = 1.33;
  const SUN: [number, number] = [0.18, 0.1]; // the sun a little off overhead
  const DROPS = 8;
  // gentle swells from all sides, a fixed random set: wavelengths 0.05…0.25 of the screen height, each with the same
  // slope, so the short ones (which bend the light the most) draw the fine net and the long ones sway it
  const SWELLS = (() => {
    let seed = 7;
    const next = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    return Array.from({ length: 14 }, (_, i) => {
      const l = 0.05 * Math.pow(5, i / 13);
      return { l, a: next() * TAU, s: 0.028, v: 0.07 * Math.sqrt(l / 0.1) };
    });
  })();

  const STEP_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_state;
uniform vec2 u_size;
uniform vec4 u_drops[${DROPS}]; // x, y (cells), radius, amount
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 m = ivec2(u_size) - 1;
  vec4 c = texelFetch(u_state, p, 0);
  // clamped neighbours: the pool walls reflect the waves
  float lap = texelFetch(u_state, min(p + ivec2(1, 0), m), 0).r
            + texelFetch(u_state, max(p - ivec2(1, 0), ivec2(0)), 0).r
            + texelFetch(u_state, min(p + ivec2(0, 1), m), 0).r
            + texelFetch(u_state, max(p - ivec2(0, 1), ivec2(0)), 0).r - 4.0 * c.r;
  float next = c.r + (c.r - c.g) * ${DAMP} + ${C2} * lap;
  for (int i = 0; i < ${DROPS}; i++) {
    vec4 d = u_drops[i];
    if (d.w == 0.0) continue;
    float r = length(gl_FragCoord.xy - d.xy) / d.z;
    if (r < 1.0) next -= d.w * (0.5 + 0.5 * cos(3.14159 * r));
  }
  o = vec4(next, c.r, 0.0, 1.0);
}`;

  const SHOW_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_height;
uniform vec2 u_world;   // the screen in world units: aspect × 1
uniform vec2 u_cells;   // ripple grid size
uniform float u_time;
uniform vec4 u_swell[${SWELLS.length}]; // k vector, slope amplitude, angular speed
uniform float u_depth;
uniform vec3 u_sun;

/** The surface slope ∇h at w and its derivatives (Hess h, as xx, yy, xy). */
vec2 surface(vec2 w, out vec3 hess) {
  vec2 uv = w / u_world;
  vec2 e = 1.0 / u_cells;
  float c = texture(u_height, uv).r;
  float l = texture(u_height, uv - vec2(e.x, 0.0)).r, r = texture(u_height, uv + vec2(e.x, 0.0)).r;
  float d = texture(u_height, uv - vec2(0.0, e.y)).r, u = texture(u_height, uv + vec2(0.0, e.y)).r;
  float ru = texture(u_height, uv + e).r, ld = texture(u_height, uv - e).r;
  float rd = texture(u_height, uv + vec2(e.x, -e.y)).r, lu = texture(u_height, uv + vec2(-e.x, e.y)).r;
  // ripple heights are in grid units: SLOPE turns them into slopes, cells per world unit into curvature
  vec2 g = vec2(r - l, u - d) * 0.5 * ${SLOPE.toFixed(3)};
  float k = ${SLOPE.toFixed(3)} * u_cells.y;
  hess = vec3(r - 2.0 * c + l, u - 2.0 * c + d, (ru - rd - lu + ld) * 0.25) * k;
  for (int i = 0; i < ${SWELLS.length}; i++) {
    vec4 s = u_swell[i];
    float kl = length(s.xy);
    vec2 dir = s.xy / kl;
    float ph = dot(s.xy, w) - s.w * u_time;
    g += dir * s.z * cos(ph);
    hess -= vec3(dir.x * dir.x, dir.y * dir.y, dir.x * dir.y) * s.z * kl * sin(ph);
  }
  return g;
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

/** Pool floor: small square tiles with grout, a dark lane stripe with a T at its end. */
vec3 floorColor(vec2 w) {
  float tile = 0.042;
  vec2 t = w / tile;
  vec2 f = fract(t);
  vec2 id = floor(t);
  float grout = smoothstep(0.02, 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  vec3 col = mix(vec3(0.56, 0.8, 0.88), vec3(0.62, 0.85, 0.91), hash(id));
  col = mix(vec3(0.46, 0.66, 0.74), col, grout);
  // the lane line along the pool (along the long side of the screen), in tiles
  bool wide = u_world.x >= u_world.y;
  vec2 lw = wide ? w : w.yx;
  vec2 size = wide ? u_world : u_world.yx;
  float mid = size.y * 0.5;
  float lane = step(abs(lw.y - mid), tile) * step(size.x * 0.12, lw.x) * step(lw.x, size.x * 0.88);
  float tee = step(abs(lw.x - size.x * 0.12), tile) * step(abs(lw.y - mid), tile * 4.0)
            + step(abs(lw.x - size.x * 0.88), tile) * step(abs(lw.y - mid), tile * 4.0);
  vec3 navy = mix(vec3(0.07, 0.13, 0.32), vec3(0.09, 0.16, 0.38), hash(id + 7.0));
  col = mix(col, mix(vec3(0.05, 0.1, 0.25), navy, grout), clamp(lane + tee, 0.0, 1.0));
  return col;
}

void main() {
  vec2 w = v_uv * u_world;
  vec3 hess;
  vec2 g = surface(w, hess);
  vec3 n = normalize(vec3(-g, 1.0));
  float bend = u_depth * (1.0 - 1.0 / ${N_WATER});
  // looking straight down, the floor seems shifted where the surface tilts
  vec2 seen = w - g * bend * 0.5;
  // the surface point whose sun ray lands on this bit of floor, and how much light it brings
  vec2 from = seen - g * bend;
  surface(from, hess);
  float det = (1.0 + bend * hess.x) * (1.0 + bend * hess.y) - bend * bend * hess.z * hess.z;
  // the sun is a disk, not a point: that softens the brightest lines a little
  float light = 1.0 / sqrt(det * det + 0.012);
  vec3 col = floorColor(seen) * (0.12 + 0.55 * light);
  // the water: blue-green, deeper water a little darker
  col *= mix(vec3(0.35, 0.78, 0.95), vec3(0.2, 0.55, 0.85), clamp(u_depth - 0.2, 0.0, 1.0));
  col += vec3(0.0, 0.03, 0.08);
  // glints of the sun and a faint sky reflection on the slopes
  vec3 refl = reflect(vec3(0.0, 0.0, -1.0), n);
  col += vec3(1.0, 0.97, 0.9) * pow(max(dot(refl, normalize(-u_sun * vec3(1.0, 1.0, -1.0))), 0.0), 3000.0) * 0.6;
  col += vec3(0.55, 0.75, 1.0) * (1.0 - n.z) * 0.6;
  o = vec4(1.0 - exp(-col * 1.6), 1.0);
}`;

  const gl = canvasGL(1);
  if (gl) start(gl);

  function start(gl: WebGL2RenderingContext): void {
    glFloat(gl); // turns on rendering into f16 targets
    const stepProgram = glProgram(gl, STEP_FS);
    const stepU = glUniforms(gl, stepProgram);
    const showProgram = glProgram(gl, SHOW_FS);
    const showU = glUniforms(gl, showProgram);

    let W = 1, H = 1; // ripple grid
    let world: [number, number] = [1, 1];
    let state = glPingPong(gl, 1, 1, { type: "f16", linear: true });
    let depth = 0.8;
    let rain = true;
    let time = 0;

    function layout(): void {
      const long = Math.max(view.w, view.h);
      W = Math.max(16, Math.round((view.w / long) * GRID));
      H = Math.max(16, Math.round((view.h / long) * GRID));
      world = [view.w / view.h, 1];
      state = glPingPong(gl!, W, H, { type: "f16", linear: true });
      // a few drops so the first frames already ring
      for (let i = 0; i < 5; i++) drop(rand(0.15, 0.85) * W, rand(0.2, 0.8) * H, rand(3, 5), rand(0.15, 0.3));
    }

    // ---------- Ripples ----------

    const drops = new Float32Array(DROPS * 4);
    let dropCount = 0;
    /** A push into the water at (x, y) cells; it acts during the next step. */
    function drop(x: number, y: number, radius: number, amount: number): void {
      if (dropCount >= DROPS) return;
      drops.set([x, y, radius, amount], dropCount * 4);
      dropCount++;
    }

    function step(): void {
      glBindTarget(gl!, state.write);
      gl!.useProgram(stepProgram);
      glTexture(gl!, 0, state.read.tex, stepU("u_state"));
      gl!.uniform2f(stepU("u_size"), W, H);
      gl!.uniform4fv(stepU("u_drops"), drops);
      glDrawQuad(gl!);
      state.swap();
      drops.fill(0);
      dropCount = 0;
    }

    function calm(): void {
      for (const t of [state.read, state.write]) {
        glBindTarget(gl!, t);
        gl!.clearColor(0, 0, 0, 0);
        gl!.clear(gl!.COLOR_BUFFER_BIT);
      }
    }

    // ---------- Picture ----------

    const sunDir = (): [number, number, number] => {
      const len = Math.hypot(SUN[0], SUN[1], 1);
      return [SUN[0] / len, SUN[1] / len, -1 / len];
    };
    const swell = new Float32Array(SWELLS.length * 4);
    SWELLS.forEach((s, i) => {
      const k = TAU / s.l;
      swell.set([Math.cos(s.a) * k, Math.sin(s.a) * k, s.s, (s.v * k)], i * 4);
    });

    function surfaceUniforms(u: (name: string) => WebGLUniformLocation | null): void {
      glTexture(gl!, 0, state.read.tex, u("u_height"));
      gl!.uniform2f(u("u_world"), ...world);
      gl!.uniform2f(u("u_cells"), W, H);
      gl!.uniform1f(u("u_time"), time);
      gl!.uniform4fv(u("u_swell"), swell);
      gl!.uniform1f(u("u_depth"), depth);
      gl!.uniform3f(u("u_sun"), ...sunDir());
    }

    function show(): void {
      glBindTarget(gl!, null);
      gl!.useProgram(showProgram);
      surfaceUniforms(showU);
      glDrawQuad(gl!);
    }

    // ---------- Frame ----------

    let stepDebt = 0;
    let rainClock = 0;
    const toCells = (p: Pointer): [number, number] => [(p.x / view.w) * W, (1 - p.y / view.h) * H];

    startLoop((dt) => {
      if (dt > 0) {
        time += dt;
        if (rain) {
          rainClock -= dt;
          if (rainClock <= 0) {
            rainClock = rand(0.08, 0.35);
            drop(rand(0, W), rand(0, H), rand(1.5, 3), rand(0.04, 0.12));
          }
        }
        stepDebt += dt * STEPS_PER_SECOND;
        const steps = Math.min(MAX_STEPS, Math.floor(stepDebt));
        stepDebt -= Math.floor(stepDebt);
        for (let i = 0; i < steps; i++) {
          // a finger in the water: a little push each step, more when it moves
          for (const p of pointers.values()) {
            const [x, y] = toCells(p);
            drop(x, y, 4, 0.04 + Math.min(0.2, Math.hypot(p.dx, p.dy) * 0.01));
          }
          step();
        }
      }
      show();
    });

    // ---------- Controls ----------

    const rainButton = addButton("🌧 Дождь", () => {
      rain = !rain;
      rainButton.classList.toggle("on", rain);
      rainButton.setAttribute("aria-pressed", String(rain));
    }, { title: "Капли дождя падают в воду" });
    rainButton.classList.add("on");
    rainButton.setAttribute("aria-pressed", "true");
    addSlider({
      label: "Глубина",
      min: 0.15,
      max: 1.2,
      step: 0.05,
      value: depth,
      onInput: (v) => (depth = v),
      format: (v) => `${(v * 2).toFixed(1).replace(".", ",")} м`,
      title: "Чем глубже, тем тоньше и ярче сетка света",
    });
    addButton("🔄", calm, { round: true, title: "Успокоить воду" });

    onPointer({
      down(p) {
        const [x, y] = toCells(p);
        drop(x, y, 6, 0.7);
      },
    });
    onResize(layout);

    layout();
    showHint("Проведи пальцем по воде");
  }
}
