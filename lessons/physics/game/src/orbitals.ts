// «Облако электрона»: the orbitals of the hydrogen atom. An electron in an atom is not a little ball on a track but a
// cloud of probability: ψ(r, θ, φ) = R_nl(r) · Y_lm(θ, φ) and the chance to find it near a point is |ψ|². The radial
// part is exact: R_nl ∝ ρ^l e^(−ρ/2) L_(n−l−1)^(2l+1)(ρ), ρ = 2r / n (r in Bohr radii, associated Laguerre polynomial
// by its recurrence); the angular part is a real spherical harmonic, computed as a solid harmonic r^l P_l^|m|(cos θ)
// · cos(mφ) (or sin for m < 0) straight from x, y, z by the Legendre recurrence, so it has no singularities.
// The cloud is ~100 000 points sampled from |ψ|² by the Metropolis algorithm: every frame each point proposes a small
// random jump and keeps it with probability min(1, |ψ(new)|² / |ψ(old)|²). The walk never stops, so the cloud
// shimmers while keeping its shape, and after a switch the same walk carries the points into the new orbital.
// The walk runs on the GPU (WebGL 2 transform feedback, one vertex per point); the points are drawn as soft dots with
// additive blending into a half-float target, then tone-mapped with a cheap mipmap glow. The colour is the sign of
// the real wavefunction: the two colours are the two «phases» of the electron wave, black gaps between are nodes.

namespace Orbitals {
  interface Orbital {
    n: number;
    l: number;
    m: number; // m > 0: cos(mφ), m < 0: sin(|m|φ)
    label: string; // «4f»
    shape: string; // «xyz»: the real orbital's usual name
  }

  const orb = (n: number, l: number, m: number, shape = ""): Orbital => ({ n, l, m, label: `${n}${"spdfgh"[l]}`, shape });
  const MAIN: Record<string, Orbital> = {
    "1s": orb(1, 0, 0),
    "2p": orb(2, 1, 0, "z"),
    "3d": orb(3, 2, 0, "z²"),
    "4f": orb(4, 3, -2, "xyz"),
  };
  /** «Ещё» walks through these one by one. */
  const MORE: Orbital[] = [
    orb(2, 0, 0),
    orb(3, 1, 0, "z"),
    orb(3, 2, 1, "xz"),
    orb(3, 2, 2, "x²−y²"),
    orb(4, 3, 0, "z³"),
    orb(4, 3, 3, "x(x²−3y²)"),
    orb(4, 3, 1, "xz²"),
    orb(4, 2, 0, "z²"),
    orb(5, 4, 0, "z⁴"),
    orb(5, 4, -4, "xy(x²−y²)"),
    orb(5, 4, 2, "z²(x²−y²)"),
    orb(5, 3, -2, "xyz"),
    orb(6, 5, 5, "h"),
    orb(3, 0, 0),
  ];

  const SMALL_STEP = 0.035; // shimmer: share of the cloud size per Metropolis step
  const BIG_STEP = 0.3; // rare long jumps let points cross the nodes between lobes
  const BIG_SHARE = 0.06; // share of points that try a long jump each step
  const FLOW_TIME = 2.2; // seconds of faster walking after a switch
  const STEPS_PER_SECOND = 60;
  const WARM_UP = 120; // steps before the first frame
  const WARM = [1.0, 0.48, 0.3]; // ψ > 0: apricot-pink
  const COOL = [0.22, 0.58, 1.0]; // ψ < 0: sky blue
  const BACKGROUND = [0.051, 0.043, 0.118]; // #0d0b1e

  // ---------- Exact hydrogen wavefunction (CPU: only the radial part, to size the view) ----------

  /** Associated Laguerre polynomial L_k^α(x) by the three-term recurrence. */
  function laguerre(k: number, alpha: number, x: number): number {
    if (k === 0) return 1;
    let l0 = 1, l1 = 1 + alpha - x;
    for (let i = 1; i < k; i++) {
      const l2 = ((2 * i + 1 + alpha - x) * l1 - (i + alpha) * l0) / (i + 1);
      l0 = l1;
      l1 = l2;
    }
    return l1;
  }

  const extents = new Map<Orbital, number>();
  /** The radius (Bohr radii) that holds 92% of the electron: r²R² integrated outwards. */
  function extent(o: Orbital): number {
    let r = extents.get(o);
    if (r === undefined) extents.set(o, (r = radialExtent(o)));
    return r;
  }

  function radialExtent(o: Orbital): number {
    const top = 8 * o.n * o.n + 12;
    const steps = 4000;
    const dr = top / steps;
    const density: number[] = [];
    let total = 0;
    for (let i = 1; i <= steps; i++) {
      const r = i * dr;
      const radial = laguerre(o.n - o.l - 1, 2 * o.l + 1, (2 * r) / o.n) * Math.pow(r, o.l) * Math.exp(-r / o.n);
      const p = r * r * radial * radial;
      density.push(p);
      total += p;
    }
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      sum += density[i]!;
      if (sum >= total * 0.92) return (i + 1) * dr;
    }
    return top;
  }

  // ---------- Shaders ----------

  /** ψ up to its normalisation (and without e^(−r/n), applied in the ratio) — the same code in both programs. */
  const PSI = `
uniform int u_n, u_l, u_m;
float psiPoly(vec3 p, out float r) {
  float r2 = dot(p, p);
  r = sqrt(r2);
  // radial: associated Laguerre L_(n-l-1)^(2l+1)(2r/n)
  float rho = 2.0 * r / float(u_n);
  int k = u_n - u_l - 1;
  float alpha = float(2 * u_l + 1);
  float L0 = 1.0, L1 = 1.0 + alpha - rho;
  float L = k == 0 ? 1.0 : L1;
  for (int i = 1; i < k; i++) {
    float L2 = ((2.0 * float(i) + 1.0 + alpha - rho) * L1 - (float(i) + alpha) * L0) / float(i + 1);
    L0 = L1; L1 = L2; L = L2;
  }
  // angular: solid harmonic r^l P_l^|m|(z/r) e^(i m phi), by the Legendre recurrence in z and r^2
  int am = abs(u_m);
  float q0 = 1.0;
  for (int i = 1; i <= am; i++) q0 *= float(2 * i - 1);
  float q = q0, qPrev = 0.0;
  for (int j = am + 1; j <= u_l; j++) {
    float qNext = (float(2 * j - 1) * p.z * q - float(j + am - 1) * r2 * qPrev) / float(j - am);
    qPrev = q; q = qNext;
  }
  vec2 c = vec2(1.0, 0.0);
  for (int i = 0; i < am; i++) c = vec2(c.x * p.x - c.y * p.y, c.x * p.y + c.y * p.x);
  float trig = u_m >= 0 ? c.x : c.y;
  return L * q * trig;
}`;

  const STEP_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_state;
out vec4 v_state;
uniform uint u_seed;
uniform float u_small, u_big, u_bigShare;
${PSI}
uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float rnd(inout uint s) {
  s = hash(s);
  return (float(s >> 8) + 0.5) / 16777216.0;
}
void main() {
  uint s = hash(uint(gl_VertexID) * 747796405u + u_seed);
  vec3 p = a_state.xyz;
  float r0;
  float a0 = psiPoly(p, r0);
  float sigma = rnd(s) < u_bigShare ? u_big : u_small;
  // three normal numbers (Box-Muller)
  float m1 = sqrt(-2.0 * log(rnd(s))), t1 = 6.2831853 * rnd(s);
  float m2 = sqrt(-2.0 * log(rnd(s))), t2 = 6.2831853 * rnd(s);
  vec3 q = p + sigma * vec3(m1 * cos(t1), m1 * sin(t1), m2 * cos(t2));
  float r1;
  float a1 = psiPoly(q, r1);
  // |psi(q)|^2 / |psi(p)|^2 without overflow: the polynomial ratio squared times the exponential ratio
  float ratio = a0 == 0.0 ? 2.0 : pow(a1 / a0, 2.0) * exp(-2.0 * (r1 - r0) / float(u_n));
  bool accept = rnd(s) < ratio && !isnan(a1) && r1 < 400.0;
  v_state = accept ? vec4(q, a1) : vec4(p, a0);
}`;

  const STEP_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

  const DRAW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_state;
uniform vec2 u_view, u_center;
uniform float u_scale, u_dist, u_size, u_gain, u_yaw, u_pitch, u_extent;
uniform vec3 u_warm, u_cool;
out vec3 v_color;
void main() {
  // the quantisation axis z points up the screen
  vec3 p = vec3(a_state.x, a_state.z, -a_state.y);
  float cy = cos(u_yaw), sy = sin(u_yaw), cp = cos(u_pitch), sp = sin(u_pitch);
  float x1 = cy * p.x + sy * p.z;
  float z1 = -sy * p.x + cy * p.z;
  vec3 c = vec3(x1, cp * p.y - sp * z1, sp * p.y + cp * z1);
  float persp = u_dist / (u_dist - c.z);
  vec2 s = u_center + vec2(c.x, -c.y) * u_scale * persp;
  gl_Position = vec4(s.x / u_view.x * 2.0 - 1.0, 1.0 - s.y / u_view.y * 2.0, 0.0, 1.0);
  gl_PointSize = u_size * persp;
  // nearer points a little brighter, and every point twinkles by its own number
  float depth = clamp(1.0 + 0.45 * c.z / u_extent, 0.35, 1.6);
  float twinkle = 0.75 + 0.5 * fract(sin(float(gl_VertexID) * 12.9898) * 43758.5453);
  v_color = (a_state.w >= 0.0 ? u_warm : u_cool) * u_gain * depth * twinkle;
}`;

  const DRAW_FS = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = max(0.0, 1.0 - dot(d, d));
  o = vec4(v_color * a * a, 1.0);
}`;

  const SHOW_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_acc;
uniform vec3 u_bg;
uniform vec2 u_view, u_nucleus;
uniform float u_exposure, u_dpr;
void main() {
  vec3 base = textureLod(u_acc, v_uv, 0.0).rgb;
  vec3 glow = textureLod(u_acc, v_uv, 3.0).rgb * 0.8 + textureLod(u_acc, v_uv, 5.0).rgb * 0.9;
  vec3 light = (base + glow) * u_exposure;
  // the nucleus: a proton, 100 000 times smaller than the cloud, so just a tiny white-hot spark
  vec2 px = v_uv * u_view;
  float d = length(px - u_nucleus) / u_dpr;
  light += vec3(1.0, 0.92, 0.8) * (exp(-d * d / 3.0) * 2.5 + exp(-d / 7.0) * 0.12);
  vec3 c = 1.0 - exp(-light);
  // a soft vignette keeps the eye on the atom
  vec2 q = v_uv - 0.5;
  vec3 bg = u_bg * (1.15 - dot(q, q) * 0.9);
  o = vec4(bg + c * (1.0 - bg), 1.0);
}`;

  /** Like glProgram, but names the transform feedback outputs before linking. */
  function feedbackProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string, varyings: string[]): WebGLProgram {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
    return program;
  }

  function run(gl: WebGL2RenderingContext): void {
    // fewer points on a small screen: the same density per pixel for less work
    const COUNT = Math.round(clamp((view.w * view.h) / 6, 60000, 140000));
    const canGlow = glFloat(gl).f16;

    const step = feedbackProgram(gl, STEP_VS, STEP_FS, ["v_state"]);
    const uStep = glUniforms(gl, step);
    const draw = glProgram(gl, DRAW_FS, DRAW_VS);
    const uDraw = glUniforms(gl, draw);
    const show = glProgram(gl, SHOW_FS);
    const uShow = glUniforms(gl, show);

    let orbital = MAIN["4f"]!;
    let size = extent(orbital); // what the view shows now, eases towards the orbital's extent
    let flow = 0; // seconds of fast walking left
    let stepClock = 0;
    let seed = 1;

    // two buffers of (x, y, z, psi): the walk reads one and writes the other
    const start = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      start[i * 4] = gauss() * size * 0.35;
      start[i * 4 + 1] = gauss() * size * 0.35;
      start[i * 4 + 2] = gauss() * size * 0.35;
    }
    const buffers = [gl.createBuffer()!, gl.createBuffer()!];
    const vaos = buffers.map((buffer) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, start, gl.DYNAMIC_COPY);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      return vao;
    });
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const feedback = gl.createTransformFeedback()!;
    let current = 0;

    function walk(small: number, big: number, bigShare: number): void {
      gl.useProgram(step);
      gl.uniform1i(uStep("u_n"), orbital.n);
      gl.uniform1i(uStep("u_l"), orbital.l);
      gl.uniform1i(uStep("u_m"), orbital.m);
      gl.uniform1ui(uStep("u_seed"), (seed = (seed * 1664525 + 1013904223) >>> 0));
      gl.uniform1f(uStep("u_small"), small);
      gl.uniform1f(uStep("u_big"), big);
      gl.uniform1f(uStep("u_bigShare"), bigShare);
      gl.bindVertexArray(vaos[current]!);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - current]!);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, COUNT);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindVertexArray(null);
      current = 1 - current;
    }

    // the accumulation target with mipmaps for the glow
    let acc: Target | null = null;
    function makeTarget(): void {
      if (!canGlow) return;
      if (acc) {
        gl.deleteTexture(acc.tex);
        gl.deleteFramebuffer(acc.fbo);
      }
      acc = glTarget(gl, stage.width, stage.height, { type: "f16", linear: true });
      gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    const orbit = orbitControl({ yaw: 0.5, pitch: 0.42, spin: 0.18, minZoom: 0.5, maxZoom: 2.5 });
    let center = { x: view.w / 2, y: view.h / 2 };
    let fit = 1; // pixels of the free area's half-size
    function layout(): void {
      const area = freeArea();
      center = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
      fit = Math.min(area.w * 0.44, area.h * 0.5);
      // on a narrow screen the title wraps and would hide under the readout: keep the readout just below it
      const heading = document.querySelector(".heading")!.getBoundingClientRect();
      $("readout").style.top = view.w < 700 ? `${Math.round(heading.bottom + 8)}px` : "";
      makeTarget();
    }

    function render(): void {
      const dpr = view.dpr;
      const target = size * 1.08;
      const scale = (fit / target) * orbit.zoom;
      const pointSize = Math.max(1.5, 1.9 * dpr);
      // the same light per pixel for any number of points, cloud size and zoom
      const cloudPixels = (target * scale * dpr) ** 2;
      const gain = (cloudPixels / (COUNT * pointSize * pointSize)) * (canGlow ? 1.6 : 0.6);

      if (acc) {
        glBindTarget(gl, acc);
        gl.clearColor(0, 0, 0, 1);
      } else {
        glBindTarget(gl, null);
        gl.clearColor(BACKGROUND[0]!, BACKGROUND[1]!, BACKGROUND[2]!, 1);
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(draw);
      gl.uniform2f(uDraw("u_view"), view.w, view.h);
      gl.uniform2f(uDraw("u_center"), center.x, center.y);
      gl.uniform1f(uDraw("u_scale"), scale);
      gl.uniform1f(uDraw("u_dist"), target * 4);
      gl.uniform1f(uDraw("u_size"), pointSize);
      gl.uniform1f(uDraw("u_gain"), gain);
      gl.uniform1f(uDraw("u_yaw"), orbit.yaw);
      gl.uniform1f(uDraw("u_pitch"), orbit.pitch);
      gl.uniform1f(uDraw("u_extent"), target);
      gl.uniform3f(uDraw("u_warm"), WARM[0]!, WARM[1]!, WARM[2]!);
      gl.uniform3f(uDraw("u_cool"), COOL[0]!, COOL[1]!, COOL[2]!);
      gl.bindVertexArray(vaos[current]!);
      gl.drawArrays(gl.POINTS, 0, COUNT);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      if (!acc) return;

      gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      glBindTarget(gl, null);
      gl.useProgram(show);
      glTexture(gl, 0, acc.tex, uShow("u_acc"));
      gl.uniform3f(uShow("u_bg"), BACKGROUND[0]!, BACKGROUND[1]!, BACKGROUND[2]!);
      gl.uniform2f(uShow("u_view"), stage.width, stage.height);
      gl.uniform2f(uShow("u_nucleus"), center.x * dpr, (view.h - center.y) * dpr);
      gl.uniform1f(uShow("u_exposure"), 1.0);
      gl.uniform1f(uShow("u_dpr"), dpr);
      glDrawQuad(gl);
    }

    function choose(next: Orbital): void {
      orbital = next;
      flow = FLOW_TIME;
      const name = next.shape ? `${next.label} · ${next.shape}` : next.label;
      setReadout(`${name}\nn = ${next.n}, l = ${next.l}, m = ${String(next.m).replace("-", "−")}`);
    }

    startLoop((dt) => {
      orbit.step(dt);
      const goal = extent(orbital);
      if (dt > 0) {
        // the view eases to the new size while the points walk there
        size += (goal - size) * (1 - Math.exp(-dt * 2.2));
        flow = Math.max(0, flow - dt);
        stepClock += dt * STEPS_PER_SECOND;
        const fast = flow > 0 ? 1 + Math.round(5 * (flow / FLOW_TIME)) : 1;
        let steps = Math.min(3, Math.floor(stepClock));
        stepClock -= Math.floor(stepClock);
        steps *= fast;
        for (let k = 0; k < steps; k++) {
          if (flow > 0) walk(goal * 0.09, goal * BIG_STEP, 0.25);
          else walk(goal * SMALL_STEP, goal * BIG_STEP, BIG_SHARE);
        }
      }
      render();
    });

    const choice = addChoice<string>(
      Object.keys(MAIN).map((key) => ({ value: key, label: key, title: `Орбиталь ${key}` })),
      "4f",
      (key) => choose(MAIN[key]!),
    );
    let more = -1;
    addButton("✨ Ещё", () => {
      more = (more + 1) % MORE.length;
      choice.set(""); // none of the four is lit
      choose(MORE[more]!);
    }, { title: "Другие орбитали: 3d xz, 4f z³, 5g…" });

    onResize(layout);
    layout();
    // start from an already formed cloud: warm the walk up before the first frame
    for (let k = 0; k < WARM_UP; k++) walk(size * (k < WARM_UP / 2 ? 0.15 : SMALL_STEP), size * BIG_STEP, 0.3);
    choose(orbital);
    flow = 0;
    showHint("Покрути атом пальцем и выбери другую орбиталь");
  }

  const gl = canvasGL(1.5);
  if (gl) run(gl);
}
