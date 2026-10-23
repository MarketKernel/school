// «Квантовая частица»: the 2D time-dependent Schrödinger equation i∂ψ/∂t = −½∇²ψ + Vψ (ħ = m = 1, one grid cell = one
// length unit) solved on the GPU with Visscher's staggered scheme: the real part R and the imaginary part I live half
// a step apart, R += dt·H I, then I −= dt·H R (H = −½∇² + V). It is explicit, keeps the probability almost exactly and
// is stable while dt·max(H) < 2, so the potential is capped. A band near the edges damps ψ so packets leave the screen
// instead of bouncing back. The picture: brightness = |ψ|^1.5, hue = the phase of ψ.
// A wave packet ψ = exp(−r²/4σ²)·exp(ik·r) moves with speed k (cells per time unit) and spreads as it goes.
// «Стена» is a thin barrier a bit higher than the packet's energy k²/2: part of the packet tunnels through it. Its share
// is summed on the GPU (two reduction passes into a 1×1 byte target, read back now and then).

namespace Quantum {
  type Potential = "wall" | "slits" | "well";

  const GRID = 320; // cells along the long side
  const DT = 0.25;
  const STEPS_PER_SECOND = 520; // 130 time units a second: a packet with k = 1 crosses a third of the screen
  const MAX_STEPS = 14;
  const SPONGE = 24;
  const K_START = 0.9; // the first packet's momentum, radians per cell (wavelength 7 cells)
  const K_MAX = 1.4;
  const WALL_V = 0.52; // a bit above the energy k²/2 ≈ 0.4 of the first packet
  const WALL_HALF = 1.0; // half the wall thickness, cells
  const SLITS_V = 3.0;
  const SLIT_GAP = 30; // centre to centre, cells
  const SLIT_HALF = 4;
  const WELL_OMEGA = 0.0095; // the well's frequency: one slosh in about 5 seconds
  const V_CAP = 3.2; // stability: dt·(4 + V) must stay below 2
  const BLOCKS = 32; // the first reduction pass sums blocks into a BLOCKS×BLOCKS target

  // Shared GLSL: grid → (s along the long axis, c across it), and the potential there
  const COMMON = `
uniform vec2 u_size;
uniform float u_axis;
uniform float u_kind;
uniform vec3 u_center; // s and c of the wall or the well's bottom, and the slit gap
vec2 sc(vec2 g) { return u_axis < 0.5 ? g : vec2(u_size.y - g.y, g.x); }
float potential(vec2 g) {
  vec2 q = sc(g) - u_center.xy;
  if (u_kind < 0.5) return abs(q.x) <= ${WALL_HALF.toFixed(2)} ? ${WALL_V} : 0.0;
  if (u_kind < 1.5) {
    if (abs(q.x) > 2.0) return 0.0;
    float a = abs(abs(q.y) - u_center.z * 0.5);
    return a < ${SLIT_HALF}.0 ? 0.0 : ${SLITS_V.toFixed(2)};
  }
  return min(0.5 * ${WELL_OMEGA * WELL_OMEGA} * dot(q, q), ${V_CAP});
}`;

  /** One half of a Visscher step: u_part 0 updates R from I, 1 updates I from R. */
  const STEP_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_psi;
uniform float u_part;
${COMMON}
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 m = ivec2(u_size) - 1;
  vec4 c = texelFetch(u_psi, p, 0);
  vec2 l = texelFetch(u_psi, min(p + ivec2(1, 0), m), 0).xy
         + texelFetch(u_psi, max(p - ivec2(1, 0), ivec2(0)), 0).xy
         + texelFetch(u_psi, min(p + ivec2(0, 1), m), 0).xy
         + texelFetch(u_psi, max(p - ivec2(0, 1), ivec2(0)), 0).xy - 4.0 * c.xy;
  vec2 g = gl_FragCoord.xy;
  float v = potential(g);
  vec2 hpsi = -0.5 * l + v * c.xy;
  if (u_part < 0.5) c.x += ${DT} * hpsi.y;
  else {
    c.y -= ${DT} * hpsi.x;
    // the edges swallow the wave
    float d = min(min(g.x, u_size.x - g.x), min(g.y, u_size.y - g.y));
    float t = clamp(1.0 - d / ${SPONGE}.0, 0.0, 1.0);
    c.xy *= 1.0 - 0.1 * t * t;
  }
  o = c;
}`;

  /** Adds a Gaussian packet (u_keep scales what was there: 0 replaces it). */
  const LAUNCH_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_psi;
uniform vec2 u_size;
uniform vec2 u_pos;
uniform vec2 u_k;
uniform vec2 u_sigma; // along k and across it
uniform float u_keep;
out vec4 o;
void main() {
  vec4 c = texelFetch(u_psi, ivec2(gl_FragCoord.xy), 0) * u_keep;
  vec2 d = gl_FragCoord.xy - u_pos;
  float kl = length(u_k);
  vec2 along = kl > 1e-4 ? u_k / kl : vec2(1.0, 0.0);
  float a = dot(d, along);
  float b = dot(d, vec2(-along.y, along.x));
  float env = exp(-a * a / (4.0 * u_sigma.x * u_sigma.x) - b * b / (4.0 * u_sigma.y * u_sigma.y));
  float ph = dot(u_k, d);
  // I lives half a step later than R: turn it by the packet's energy times dt/2
  float e = 0.5 * kl * kl;
  c.x += env * cos(ph);
  c.y += env * sin(ph - e * ${DT / 2});
  o = c;
}`;

  /** Reduction 1: each texel sums |ψ|² of its block, split into before the wall, at it and behind it. */
  const SUM_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_psi;
uniform float u_side;
uniform float u_scale; // turns the sampled sum into a share of the launched probability
${COMMON}
out vec4 o;
void main() {
  vec2 block = u_size / ${BLOCKS}.0;
  vec2 start = floor(gl_FragCoord.xy - 0.5) * block;
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 24; y++) {
    for (int x = 0; x < 24; x++) {
      vec2 g = start + (vec2(x, y) + 0.5) * block / 24.0;
      vec2 w = texelFetch(u_psi, ivec2(g), 0).xy;
      float p = dot(w, w);
      float s = (sc(g).x - u_center.x) * u_side;
      if (s < -8.0) sum.x += p;
      else if (s > 8.0) sum.z += p;
      else sum.y += p;
    }
  }
  o = vec4(sum * u_scale, 1.0);
}`;

  /** Reduction 2: the shares, packed into bytes so any GPU can read them back. */
  const SHARE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_sums;
out vec4 o;
void main() {
  vec3 s = vec3(0.0);
  for (int y = 0; y < ${BLOCKS}; y++)
    for (int x = 0; x < ${BLOCKS}; x++) s += texelFetch(u_sums, ivec2(x, y), 0).rgb;
  float total = s.x + s.y + s.z;
  o = total > 1e-9 ? vec4(s / total, min(total, 1.0)) : vec4(0.0);
}`;

  const SHOW_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_psi;
uniform vec4 u_arrow; // from, to (grid cells)
uniform float u_arrowOn;
${COMMON}

vec2 fetch(vec2 g) {
  vec2 f = g - 0.5;
  ivec2 i = ivec2(floor(f));
  vec2 t = f - floor(f);
  ivec2 m = ivec2(u_size) - 1;
  vec2 a = texelFetch(u_psi, clamp(i, ivec2(0), m), 0).xy;
  vec2 b = texelFetch(u_psi, clamp(i + ivec2(1, 0), ivec2(0), m), 0).xy;
  vec2 c = texelFetch(u_psi, clamp(i + ivec2(0, 1), ivec2(0), m), 0).xy;
  vec2 d = texelFetch(u_psi, clamp(i + ivec2(1, 1), ivec2(0), m), 0).xy;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t);
}

void main() {
  vec2 g = v_uv * u_size;
  vec2 w = fetch(g);
  // brightness follows |ψ|^1.5: between |ψ| (ghosts well seen) and |ψ|² (where the particle would be found)
  float amp = pow(dot(w, w), 0.75);
  float phase = atan(w.y, w.x);
  // a saturated rainbow wheel for the phase
  vec3 hue = clamp(abs(mod(phase / 6.2832 * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  hue = mix(vec3(1.0), hue, 0.85);
  vec3 col = vec3(0.051, 0.043, 0.118);
  float b = 1.0 - exp(-amp * 2.2);
  col += hue * b * 1.25 + vec3(1.0, 0.95, 0.9) * pow(b, 4.0) * 0.45;

  // the potential, faintly: a glass wall, or the bowl of the well with contour lines
  float v = potential(g);
  if (u_kind < 1.5) {
    float wall = smoothstep(0.0, 0.3, v);
    col = mix(col, col * 0.6 + vec3(0.45, 0.42, 0.75), wall * (u_kind < 0.5 ? 0.55 : 0.85));
    vec2 q = sc(g) - u_center.xy;
    col += vec3(0.5, 0.45, 1.0) * exp(-abs(abs(q.x) - (u_kind < 0.5 ? ${WALL_HALF + 0.5} : 2.5)) * 1.2) * 0.12 * step(0.01, v + (u_kind < 0.5 ? 1.0 : 0.0));
  } else {
    float lv = v / ${V_CAP};
    col += vec3(0.25, 0.2, 0.55) * lv * 0.35;
    float ring = abs(fract(sqrt(v) * 4.0) - 0.5);
    col += vec3(0.45, 0.4, 0.9) * smoothstep(0.06, 0.0, ring) * 0.12 * (1.0 - lv);
  }

  // the launch arrow while dragging
  if (u_arrowOn > 0.5) {
    vec2 a = u_arrow.xy, e = u_arrow.zw;
    vec2 dir = normalize(e - a + vec2(1e-5));
    vec2 side = vec2(-dir.y, dir.x);
    float head = min(segment(g, e, e - dir * 9.0 + side * 6.0), segment(g, e, e - dir * 9.0 - side * 6.0));
    float d = min(segment(g, a, e), head);
    col += vec3(1.0, 0.85, 0.55) * (smoothstep(1.4, 0.4, d) + exp(-d * 0.5) * 0.35);
    col += vec3(1.0, 0.8, 0.5) * exp(-length(g - a) * 0.25) * 0.8;
  }
  o = vec4(1.0 - exp(-col * 1.25), 1.0);
}`;

  const gl = canvasGL(1);
  if (gl) start(gl);

  function start(gl: WebGL2RenderingContext): void {
    const float = glFloat(gl);
    const type = float.f32 ? "f32" : "f16";
    const stepProgram = glProgram(gl, STEP_FS);
    const stepU = glUniforms(gl, stepProgram);
    const launchProgram = glProgram(gl, LAUNCH_FS);
    const launchU = glUniforms(gl, launchProgram);
    const sumProgram = glProgram(gl, SUM_FS);
    const sumU = glUniforms(gl, sumProgram);
    const shareProgram = glProgram(gl, SHARE_FS);
    const shareU = glUniforms(gl, shareProgram);
    const showProgram = glProgram(gl, SHOW_FS);
    const showU = glUniforms(gl, showProgram);
    const sums = glTarget(gl, BLOCKS, BLOCKS, { type });
    const share = glTarget(gl, 1, 1, { type: "u8" });
    const shareBytes = new Uint8Array(4);

    let potentialKind: Potential = "wall";
    let W = 1, H = 1;
    let portrait = false;
    let psi = glPingPong(gl, 1, 1, { type });
    const center = { s: 0, c: 0 };

    const toGrid = (x: number, y: number): [number, number] => [(x * W) / view.w, ((view.h - y) * H) / view.h];
    const fromSC = (s: number, c: number): [number, number] => (portrait ? [c, H - s] : [s, c]);

    function layout(): void {
      portrait = view.h > view.w * 1.05;
      const long = Math.max(view.w, view.h);
      W = Math.max(16, Math.round((view.w / long) * GRID));
      H = Math.max(16, Math.round((view.h / long) * GRID));
      const area = freeArea();
      const [gx, gy] = toGrid(area.x + area.w / 2, area.y + area.h / 2);
      [center.s, center.c] = (portrait ? [H - gy, gx] : [gx, gy]).map(Math.round) as [number, number];
      psi = glPingPong(gl!, W, H, { type });
      autoLaunch();
    }

    // ---------- Simulation ----------

    function setCommon(u: (name: string) => WebGLUniformLocation | null): void {
      gl!.uniform2f(u("u_size"), W, H);
      gl!.uniform1f(u("u_axis"), portrait ? 1 : 0);
      gl!.uniform1f(u("u_kind"), potentialKind === "wall" ? 0 : potentialKind === "slits" ? 1 : 2);
      gl!.uniform3f(u("u_center"), center.s, center.c, SLIT_GAP);
    }

    function step(): void {
      gl!.useProgram(stepProgram);
      setCommon(stepU);
      for (let part = 0; part < 2; part++) {
        glBindTarget(gl!, psi.write);
        glTexture(gl!, 0, psi.read.tex, stepU("u_psi"));
        gl!.uniform1f(stepU("u_part"), part);
        glDrawQuad(gl!);
        psi.swap();
      }
    }

    let lastLaunch = -10;
    let clock = 0;

    /** A packet at (gx, gy) with momentum (kx, ky); a launch right after another one adds to it. */
    function launch(gx: number, gy: number, kx: number, ky: number, sigmaAlong: number, sigmaAcross: number): void {
      const together = clock - lastLaunch < 0.4;
      lastLaunch = clock;
      glBindTarget(gl!, psi.write);
      gl!.useProgram(launchProgram);
      glTexture(gl!, 0, psi.read.tex, launchU("u_psi"));
      gl!.uniform2f(launchU("u_size"), W, H);
      gl!.uniform2f(launchU("u_pos"), gx, gy);
      gl!.uniform2f(launchU("u_k"), kx, ky);
      gl!.uniform2f(launchU("u_sigma"), sigmaAlong, sigmaAcross);
      gl!.uniform1f(launchU("u_keep"), together ? 1 : 0);
      glDrawQuad(gl!);
      psi.swap();
      // the probability a Gaussian packet carries: ∫|ψ|² = 2π σ_along σ_across
      launched = (together ? launched : 0) + TAU * sigmaAlong * sigmaAcross;
      left = 1;
      quiet = 0;
      tunnel = { touched: false, frozen: false, value: 0, side: 0 };
      // which side of the wall the packet starts on: what reaches the other side has tunnelled
      const s = portrait ? H - gy : gx;
      tunnel.side = s < center.s ? 1 : -1;
    }

    const widths = (): [number, number] => (potentialKind === "slits" ? [10, 20] : potentialKind === "well" ? [4.5, 4.5] : [10, 14]);

    /** The packet the scene starts with: towards the wall or the slits, or off-centre into the well. */
    function autoLaunch(): void {
      lastLaunch = -10;
      const [along, across] = widths();
      if (potentialKind === "well") {
        const [x, y] = fromSC(center.s - 70, center.c);
        const [kx, ky] = portrait ? [0.45, 0] : [0, 0.45];
        launch(x, y, kx, ky, along, across);
        return;
      }
      const [x, y] = fromSC(center.s - 80, center.c);
      const [kx, ky] = portrait ? [0, -K_START] : [K_START, 0];
      launch(x, y, kx, ky, along, across);
    }

    // ---------- How much went through the wall ----------

    let tunnel = { touched: false, frozen: false, value: 0, side: 0 };
    let frame = 0;
    let launched = 1;
    let left = 1; // the share of the packet still on the screen
    let quiet = 0; // seconds the screen has been nearly empty

    function measure(): void {
      glBindTarget(gl!, sums);
      gl!.useProgram(sumProgram);
      glTexture(gl!, 0, psi.read.tex, sumU("u_psi"));
      setCommon(sumU);
      gl!.uniform1f(sumU("u_side"), tunnel.side);
      gl!.uniform1f(sumU("u_scale"), (W / BLOCKS) * (H / BLOCKS) / (24 * 24) / launched);
      glDrawQuad(gl!);
      glBindTarget(gl!, share);
      gl!.useProgram(shareProgram);
      glTexture(gl!, 0, sums.tex, shareU("u_sums"));
      glDrawQuad(gl!);
      gl!.readPixels(0, 0, 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, shareBytes);
      const mid = shareBytes[1]! / 255;
      const far = shareBytes[2]! / 255;
      left = shareBytes[3]! / 255;
      if (mid > 0.15) tunnel.touched = true;
      if (!tunnel.frozen) tunnel.value = far;
      // once the packet has left the wall, the share is final
      if (tunnel.touched && mid < 0.02) tunnel.frozen = true;
    }

    // ---------- Frame ----------

    let drag: { id: number; x: number; y: number; ex: number; ey: number } | null = null;
    let stepDebt = 0;

    startLoop((dt) => {
      clock += dt;
      if (dt > 0) {
        stepDebt += dt * STEPS_PER_SECOND;
        const steps = Math.min(MAX_STEPS, Math.floor(stepDebt));
        stepDebt -= Math.floor(stepDebt);
        for (let i = 0; i < steps; i++) step();
      }
      frame++;
      if (dt > 0 && frame % 6 === 0) measure();
      // when everything has flown away, a new packet comes by itself
      quiet = left < 0.08 && !drag ? quiet + dt : 0;
      if (quiet > 1.2) autoLaunch();
      if (potentialKind === "wall") {
        setReadout(`Сквозь стену: ${Math.round(tunnel.value * 100)} %`);
      } else setReadout(null);

      glBindTarget(gl!, null);
      gl!.useProgram(showProgram);
      glTexture(gl!, 0, psi.read.tex, showU("u_psi"));
      setCommon(showU);
      gl!.uniform1f(showU("u_arrowOn"), drag ? 1 : 0);
      if (drag) {
        const [ax, ay] = toGrid(drag.x, drag.y);
        const [bx, by] = toGrid(drag.ex, drag.ey);
        gl!.uniform4f(showU("u_arrow"), ax, ay, bx, by);
      }
      glDrawQuad(gl!);
    });

    // ---------- Controls ----------

    addChoice<Potential>(
      [
        { value: "wall", label: "🧱 Стена", title: "Тонкая стенка: частица может пройти сквозь неё" },
        { value: "slits", label: "✌️ Щели", title: "Стенка с двумя щелями" },
        { value: "well", label: "🥣 Ямка", title: "Ямка: частица качается в ней туда-сюда" },
      ],
      potentialKind,
      (next) => {
        potentialKind = next;
        autoLaunch();
      },
    );
    // on a narrow phone the bar has no room for 🔄: a second tap on the chosen potential launches again just as well
    const again = addButton("🔄", autoLaunch, { round: true, title: "Запустить ещё раз" });
    const fitBar = (): void => {
      again.hidden = view.w < 430;
      // on a phone the readout goes just under the title, however many lines the question takes
      const below = document.querySelector(".heading")!.getBoundingClientRect().bottom + 8;
      $("readout").style.top = view.w <= 700 ? `${Math.round(below)}px` : "";
    };

    // Drag: where the press starts is where the packet appears, the arrow is its momentum
    const momentum = (dx: number, dy: number): [number, number] => {
      const len = Math.hypot(dx, dy);
      if (len < 12) return [0, 0];
      const k = Math.min(K_MAX, (len / Math.min(view.w, view.h)) * 4);
      // CSS y points down, grid y up
      return [(dx / len) * k, (-dy / len) * k];
    };
    onPointer({
      down(p) {
        if (!drag) drag = { id: p.id, x: p.x, y: p.y, ex: p.x, ey: p.y };
      },
      move(p) {
        if (drag && drag.id === p.id) {
          drag.ex = p.x;
          drag.ey = p.y;
        }
      },
      up(p) {
        if (!drag || drag.id !== p.id) return;
        const [gx, gy] = toGrid(drag.x, drag.y);
        const [kx, ky] = momentum(drag.ex - drag.x, drag.ey - drag.y);
        const [along, across] = widths();
        launch(gx, gy, kx, ky, along, across);
        drag = null;
      },
    });
    onResize(() => {
      fitBar();
      layout();
    });

    fitBar();
    layout();
    showHint("Потяни пальцем — запустишь новую частицу");
  }
}
