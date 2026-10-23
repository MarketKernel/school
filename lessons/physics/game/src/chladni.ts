// «Поющий песок»: Chladni figures. A metal plate rings in one of its standing-wave modes; where it moves, sand grains
// are tossed about, and they come to rest on the nodal lines, where the plate stands still.
// Square plate: u = cos(nπX)cos(mπY) ± cos(mπX)cos(nπY) on X, Y ∈ [0, 1] (Chladni's own approximation of the free
// square plate's modes, frequency growing with n² + m²). Round plate: u = J_n(kr)·cos(nθ) with k a root of J_n′ (the
// edge is free to move); J_n comes from Bessel's integral J_n(x) = 1/π ∫₀^π cos(nτ − x sin τ) dτ, sampled into a table.
// Each mode is sampled once into a grid of |u|; every frame each grain jumps randomly by a step ∝ |u| at its spot and
// slides a little down the slope of |u|, so the sand piles up where |u| = 0. Grains are WebGL points over a shaded
// metal plate that shimmers with u·sin(ωt).

namespace Chladni {
  type Plate = "square" | "circle";

  const GRAINS_DESKTOP = 32000;
  const GRAINS_PHONE = 20000;
  const MODES = 30;
  const FIRST_MODE = 18; // the scene starts on a rich pattern (1-based, as on the slider)
  const N = 256; // amplitude grid
  const JUMP = 0.42; // random step at an antinode, plate half-widths per √second
  const SLIDE = 0.03; // drift down the slope of |u|
  const FLOOR = 0.035; // the smallest shaking, as a share of the strongest
  const POUR = 220; // grains moved under the finger each frame while it is pressed
  const TONE_BASE = 150; // Hz of the first mode; each next one sounds a bit higher

  interface Mode { u: (x: number, y: number) => number; k: number; label: string }

  // ---------- Modes ----------

  /** Square plate modes ordered by n² + m², the minus variant (diagonal lines) first. */
  function squareModes(): Mode[] {
    const list: { n: number; m: number; s: number }[] = [];
    for (let n = 1; n <= 12; n++)
      for (let m = 0; m <= n; m++)
        for (const s of [-1, 1]) {
          if (n === m && s < 0) continue; // the minus variant would be zero everywhere
          // the plain stripes (m = 0) and checkerboards (n = m) only at the start: the rest are the curly figures
          if ((m === 0 && n > 3) || (n === m && n > 2)) continue;
          list.push({ n, m, s });
        }
    list.sort((a, b) => a.n * a.n + a.m * a.m - (b.n * b.n + b.m * b.m) || a.s - b.s);
    return list.slice(0, MODES).map(({ n, m, s }) => ({
      u: (x: number, y: number) => {
        const X = (x + 1) / 2, Y = (y + 1) / 2;
        return Math.cos(n * Math.PI * X) * Math.cos(m * Math.PI * Y) + s * Math.cos(m * Math.PI * X) * Math.cos(n * Math.PI * Y);
      },
      k: Math.PI * Math.hypot(n, m),
      label: `${n}, ${m}`,
    }));
  }

  /** J_n(x) by Bessel's integral; the trapezoid rule is very accurate for this periodic integrand. */
  function besselJ(n: number, x: number): number {
    const steps = 96;
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI;
      const w = i === 0 || i === steps ? 0.5 : 1;
      sum += w * Math.cos(n * t - x * Math.sin(t));
    }
    return sum / steps;
  }

  const besselDJ = (n: number, x: number): number => (n === 0 ? -besselJ(1, x) : (besselJ(n - 1, x) - besselJ(n + 1, x)) / 2);

  /** Round plate modes: the first roots of J_n′ for n = 0…8, ordered by k. */
  function circleModes(): Mode[] {
    const roots: { n: number; k: number; s: number }[] = [];
    for (let n = 0; n <= 12; n++) {
      let s = 0;
      let prev = besselDJ(n, 0.05);
      for (let x = 0.1; x < 26 && s < 5; x += 0.1) {
        const cur = besselDJ(n, x);
        if (prev * cur < 0) {
          let lo = x - 0.1, hi = x;
          for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            if (besselDJ(n, lo) * besselDJ(n, mid) <= 0) hi = mid;
            else lo = mid;
          }
          s++;
          roots.push({ n, k: (lo + hi) / 2, s });
        }
        prev = cur;
      }
    }
    roots.sort((a, b) => a.k - b.k);
    return roots.slice(0, MODES).map(({ n, k, s }) => {
      // J_n(k r) for r in 0…1, as a table
      const table = new Float32Array(513);
      for (let i = 0; i <= 512; i++) table[i] = besselJ(n, (k * i) / 512);
      return {
        u: (x: number, y: number) => {
          const r = Math.min(1, Math.hypot(x, y));
          const f = r * 512;
          const i = Math.min(511, Math.floor(f));
          const j = table[i]! + (table[i + 1]! - table[i]!) * (f - i);
          return j * Math.cos(n * Math.atan2(y, x));
        },
        k,
        label: `${n}, ${s}`,
      };
    });
  }

  // ---------- Shaders ----------

  const PLATE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec2 u_view;      // canvas size, device px
uniform vec3 u_plate;     // centre x, y and half side, device px
uniform float u_round;
uniform sampler2D u_mode; // signed u, −1…1, over the plate square
uniform float u_wobble;   // sin(ωt) × the shimmer strength

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), s.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), s.x), s.y);
}

void main() {
  vec2 px = v_uv * u_view;
  vec2 q = (px - u_plate.xy) / u_plate.z; // plate units, y up
  // the night around the plate, with a soft warm glow under it
  vec3 col = mix(vec3(0.03, 0.028, 0.07), vec3(0.075, 0.06, 0.13), 1.0 - v_uv.y);
  float d = u_round > 0.5 ? length(q) - 1.0 : max(abs(q.x), abs(q.y)) - 1.0;
  col += vec3(0.25, 0.16, 0.08) * exp(-max(d, 0.0) * 6.0) * 0.25;
  float aa = 1.5 / u_plate.z;
  float inside = smoothstep(aa, -aa, d);
  if (inside > 0.0) {
    // dark brushed metal: fine streaks, a broad sheen and a bevelled rim
    float streak = noise(vec2(q.x * 3.0, q.y * 260.0)) * 0.6 + noise(vec2(q.x * 9.0, q.y * 900.0)) * 0.4;
    vec3 metal = vec3(0.13, 0.135, 0.16) + vec3(0.05) * (streak - 0.5);
    metal += vec3(0.11, 0.1, 0.12) * exp(-dot(q - vec2(-0.45, 0.5), q - vec2(-0.45, 0.5)) * 1.6);
    float u = texture(u_mode, q * 0.5 + 0.5).r;
    metal += vec3(0.22, 0.2, 0.3) * u * u_wobble;
    float rim = smoothstep(-0.05, 0.0, d);
    metal = mix(metal, vec3(0.32, 0.3, 0.36), rim * 0.8);
    col = mix(col, metal, inside);
  }
  o = vec4(col, 1.0);
}`;

  const GRAIN_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_view;
uniform vec3 u_plate;
uniform float u_size;
out vec3 v_color;
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec2 px = u_plate.xy + a_pos * u_plate.z;
  gl_Position = vec4(px / u_view * 2.0 - 1.0, 0.0, 1.0);
  float h = hash(float(gl_VertexID));
  gl_PointSize = u_size * (0.75 + 0.5 * hash(float(gl_VertexID) + 7.0));
  // warm golden sand, every grain a little different
  v_color = mix(vec3(1.0, 0.72, 0.32), vec3(1.0, 0.9, 0.62), h) * (0.55 + 0.45 * hash(float(gl_VertexID) + 3.0));
}`;

  const GRAIN_FS = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.2, dot(d, d));
  o = vec4(v_color * a * 0.38, 1.0);
}`;

  const gl = canvasGL(2);
  if (gl) start(gl);

  function start(gl: WebGL2RenderingContext): void {
    const plateProgram = glProgram(gl, PLATE_FS);
    const plateU = glUniforms(gl, plateProgram);
    const grainProgram = glProgram(gl, GRAIN_FS, GRAIN_VS);
    const grainU = glUniforms(gl, grainProgram);

    const modes: Record<Plate, Mode[]> = { square: squareModes(), circle: circleModes() };
    let plate: Plate = "square";
    let modeIndex = FIRST_MODE - 1;

    // |u| on a grid over the plate square (0 outside a round plate), its slope, and a signed copy for the shimmer
    const amp = new Float32Array(N * N);
    const slopeX = new Float32Array(N * N);
    const slopeY = new Float32Array(N * N);
    const signed = new Float32Array(N * N);
    const modeTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, modeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    function sampleMode(): void {
      const mode = modes[plate][modeIndex]!;
      let top = 1e-9;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const x = ((i + 0.5) / N) * 2 - 1, y = ((j + 0.5) / N) * 2 - 1;
          const v = plate === "circle" && x * x + y * y > 1 ? 0 : mode.u(x, y);
          signed[j * N + i] = v;
          top = Math.max(top, Math.abs(v));
        }
      for (let i = 0; i < N * N; i++) {
        signed[i] = signed[i]! / top;
        amp[i] = Math.abs(signed[i]!);
      }
      const h = 2 / N;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const at = (a: number, b: number) => amp[clamp(b, 0, N - 1) * N + clamp(a, 0, N - 1)]!;
          slopeX[j * N + i] = (at(i + 1, j) - at(i - 1, j)) / (2 * h);
          slopeY[j * N + i] = (at(i, j + 1) - at(i, j - 1)) / (2 * h);
        }
      gl!.bindTexture(gl!.TEXTURE_2D, modeTex);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R16F, N, N, 0, gl!.RED, gl!.FLOAT, signed);
      tone?.glide(frequency());
    }

    // ---------- Sand ----------

    let count = view.w < 700 ? GRAINS_PHONE : GRAINS_DESKTOP;
    const px = new Float32Array(GRAINS_DESKTOP);
    const py = new Float32Array(GRAINS_DESKTOP);
    const buffer = new Float32Array(GRAINS_DESKTOP * 2);
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buffer.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    /** Keeps a grain on the plate: a square reflects at its sides, a disk pulls it back inside. */
    function keepOn(i: number): void {
      let x = px[i]!, y = py[i]!;
      if (plate === "square") {
        if (x > 0.995) x = 1.99 - x;
        if (x < -0.995) x = -1.99 - x;
        if (y > 0.995) y = 1.99 - y;
        if (y < -0.995) y = -1.99 - y;
        x = clamp(x, -0.995, 0.995);
        y = clamp(y, -0.995, 0.995);
      } else {
        const r = Math.hypot(x, y);
        if (r > 0.995) {
          const k = Math.max(0, 1.99 - r) / r;
          x *= k;
          y *= k;
        }
      }
      px[i] = x;
      py[i] = y;
    }

    function scatter(): void {
      for (let i = 0; i < GRAINS_DESKTOP; i++) {
        px[i] = rand(-1, 1);
        py[i] = rand(-1, 1);
        if (plate === "circle") {
          const r = Math.sqrt(Math.random()) * 0.99, a = rand(0, TAU);
          px[i] = r * Math.cos(a);
          py[i] = r * Math.sin(a);
        }
      }
    }

    function shake(dt: number): void {
      const jump = JUMP * Math.sqrt(dt) * 1.732; // a uniform step with the deviation JUMP·√dt
      const slide = SLIDE * dt;
      for (let i = 0; i < count; i++) {
        const x = px[i]!, y = py[i]!;
        const c = Math.min(N - 1, Math.max(0, ((x + 1) * 0.5 * N) | 0)) + Math.min(N - 1, Math.max(0, ((y + 1) * 0.5 * N) | 0)) * N;
        // even on a nodal line the plate trembles a little, so the lines keep some width
        const a = Math.max(amp[c]!, FLOOR);
        px[i] = x + a * jump * (Math.random() * 2 - 1) - slopeX[c]! * a * slide;
        py[i] = y + a * jump * (Math.random() * 2 - 1) - slopeY[c]! * a * slide;
        keepOn(i);
      }
    }

    // ---------- Layout and drawing ----------

    const geo = { cx: 0, cy: 0, half: 1 }; // CSS px

    function layout(): void {
      const area = freeArea();
      geo.half = Math.min(area.w, area.h) * 0.46;
      geo.cx = area.x + area.w / 2;
      geo.cy = area.y + area.h / 2;
    }

    let wobble = 0;

    function draw(time: number): void {
      const dpr = stage.width / view.w;
      const plateVec: [number, number, number] = [geo.cx * dpr, stage.height - geo.cy * dpr, geo.half * dpr];
      glBindTarget(gl!, null);
      gl!.useProgram(plateProgram);
      gl!.uniform2f(plateU("u_view"), stage.width, stage.height);
      gl!.uniform3f(plateU("u_plate"), ...plateVec);
      gl!.uniform1f(plateU("u_round"), plate === "circle" ? 1 : 0);
      gl!.uniform1f(plateU("u_wobble"), wobble * Math.sin(time * 40));
      glTexture(gl!, 0, modeTex, plateU("u_mode"));
      glDrawQuad(gl!);

      for (let i = 0; i < count; i++) {
        buffer[i * 2] = px[i]!;
        buffer[i * 2 + 1] = py[i]!;
      }
      gl!.useProgram(grainProgram);
      gl!.uniform2f(grainU("u_view"), stage.width, stage.height);
      gl!.uniform3f(grainU("u_plate"), ...plateVec);
      gl!.uniform1f(grainU("u_size"), Math.max(1.5, (geo.half * dpr) / 190));
      gl!.bindVertexArray(vao);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
      gl!.bufferSubData(gl!.ARRAY_BUFFER, 0, buffer.subarray(0, count * 2));
      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.ONE, gl!.ONE);
      gl!.drawArrays(gl!.POINTS, 0, count);
      gl!.disable(gl!.BLEND);
      gl!.bindVertexArray(null);
    }

    // ---------- Pouring sand with a finger ----------

    function pour(p: Pointer): void {
      const x = (p.x - geo.cx) / geo.half;
      const y = (geo.cy - p.y) / geo.half;
      if (plate === "square" ? Math.max(Math.abs(x), Math.abs(y)) > 1 : Math.hypot(x, y) > 1) return;
      for (let k = 0; k < POUR; k++) {
        const i = randInt(0, count - 1);
        px[i] = x + gauss() * 0.03;
        py[i] = y + gauss() * 0.03;
        keepOn(i);
      }
    }

    // ---------- Sound ----------

    const frequencyOf = (index: number): number => Math.round(TONE_BASE * Math.pow(modes[plate][index]!.k / modes[plate][0]!.k, 0.8));
    const frequency = (): number => frequencyOf(modeIndex);

    let tone: { glide(f: number): void; stop(): void } | null = null;

    function startTone(): void {
      const ac = audioContext();
      if (!ac) return;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.07, ac.currentTime, 0.15);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      tone = {
        glide(f) {
          osc.frequency.setTargetAtTime(f, ac.currentTime, 0.06);
        },
        stop() {
          gain.gain.setTargetAtTime(0, ac.currentTime, 0.1);
          osc.stop(ac.currentTime + 0.6);
        },
      };
    }

    // ---------- Frame ----------

    startLoop((dt, time) => {
      if (dt > 0) {
        for (const p of pointers.values()) pour(p);
        // two half steps keep fast grains from overshooting the lines
        shake(dt / 2);
        shake(dt / 2);
        wobble = 0.35;
      } else wobble = 0;
      draw(time);
    });

    // ---------- Controls ----------

    addChoice<Plate>(
      [
        { value: "square", label: "⬛ Квадрат" },
        { value: "circle", label: "⚪ Круг" },
      ],
      plate,
      (next) => {
        plate = next;
        scatter();
        sampleMode();
        slider.set(modeIndex + 1);
      },
    );
    const slider = addSlider({
      label: "Частота",
      min: 1,
      max: MODES,
      step: 1,
      value: modeIndex + 1,
      onInput: (v) => {
        modeIndex = v - 1;
        sampleMode();
      },
      format: (v) => `${frequencyOf(v - 1)} Гц`,
      title: "Чем выше частота, тем сложнее узор",
    });
    const sound = addButton("🔈", () => {
      if (tone) {
        tone.stop();
        tone = null;
      } else startTone();
      sound.textContent = tone ? "🔊" : "🔈";
      sound.title = tone ? "Выключить звук" : "Включить звук";
    }, { round: true, title: "Включить звук" });
    addButton("🔄", scatter, { round: true, title: "Рассыпать песок заново" });

    onPointer({ down: pour });
    onResize(() => {
      count = view.w < 700 ? GRAINS_PHONE : GRAINS_DESKTOP;
      layout();
    });

    layout();
    scatter();
    sampleMode();
    // a moment of shaking before the first frame: the lines are already showing
    for (let i = 0; i < 12; i++) shake(1 / 60);
    showHint("Двигай «Частоту» — песок станцует новый узор");
  }
}
