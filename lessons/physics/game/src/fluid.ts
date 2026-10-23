// «Жидкие краски»: a GPU fluid after Jos Stam's «Stable Fluids» (1999). The velocity field lives on a coarse grid,
// the coloured dye on a finer one. Every step: the velocity carries itself and the dye along (semi-Lagrangian
// advection: each cell looks back along the flow and takes what was there), the curl of the flow is measured and
// small swirls are pushed to spin harder (vorticity confinement, which gives back the eddies the coarse grid smears
// out), then the flow is made incompressible: its divergence is computed, the pressure is found by Jacobi iterations
// of the Poisson equation and its gradient is subtracted. A finger adds a Gaussian splat of velocity along the drag
// and a splat of dye whose hue drifts with time. A small bloom makes the bright paint glow.

namespace Fluid {
  type Palette = "rainbow" | "sunset" | "sea";

  const SIM = 128; // velocity cells on the short side of the screen
  const DYE = 512; // dye cells on the short side (capped by the screen's own pixels)
  const PRESSURE_STEPS = 20;
  const PRESSURE_KEEP = 0.8; // the last pressure is the first guess of the next solve
  const VELOCITY_FADE = 0.2; // per second: 1 / (1 + fade · dt) per step
  const DYE_FADE = 0.9;
  const SPLAT_RADIUS = 0.0022; // squared, in screen heights
  const FORCE = 6000; // velocity of a splat per screen width of drag
  const DYE_AMOUNT = 0.16;
  const IDLE_SPLAT = 2.5; // seconds without a finger before the paint stirs by itself
  const STEP = 1 / 60; // seconds of one simulation step
  const MAX_STEPS = 2; // per frame
  const BACKGROUND = [0.051, 0.043, 0.118]; // #0d0b1e

  const gl = canvasGL(1);
  const float = gl ? glFloat(gl) : null;
  if (gl && !float!.f16) {
    const note = $("no-gl");
    note.textContent = "Этот браузер не умеет считать на видеокарте дробными числами, а без этого краски не потекут. Попробуйте открыть урок в свежем Chrome, Safari или Firefox.";
    note.hidden = false;
  }

  if (gl && float!.f16) run(gl);

  function run(gl: WebGL2RenderingContext): void {
    // ---------- Shaders ----------

    const header = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 o;
`;
    const program = (body: string) => {
      const p = glProgram(gl, header + body);
      return { p, u: glUniforms(gl, p) };
    };

    const splat = program(`
uniform sampler2D u_target;
uniform float u_aspect;
uniform vec3 u_color;
uniform vec2 u_point;
uniform float u_radius;
void main() {
  vec2 p = v_uv - u_point;
  p.x *= u_aspect;
  vec3 s = exp(-dot(p, p) / u_radius) * u_color;
  o = vec4(texture(u_target, v_uv).xyz + s, 1.0);
}`);

    const advect = program(`
uniform sampler2D u_velocity;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_dt;
uniform float u_fade;
void main() {
  vec2 back = v_uv - u_dt * texture(u_velocity, v_uv).xy * u_texel;
  o = texture(u_source, back) / (1.0 + u_fade * u_dt);
}`);

    const curl = program(`
uniform sampler2D u_velocity;
uniform vec2 u_texel;
void main() {
  float l = texture(u_velocity, v_uv - vec2(u_texel.x, 0.0)).y;
  float r = texture(u_velocity, v_uv + vec2(u_texel.x, 0.0)).y;
  float t = texture(u_velocity, v_uv + vec2(0.0, u_texel.y)).x;
  float b = texture(u_velocity, v_uv - vec2(0.0, u_texel.y)).x;
  o = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}`);

    const vorticity = program(`
uniform sampler2D u_velocity;
uniform sampler2D u_curl;
uniform vec2 u_texel;
uniform float u_strength;
uniform float u_dt;
void main() {
  float l = texture(u_curl, v_uv - vec2(u_texel.x, 0.0)).x;
  float r = texture(u_curl, v_uv + vec2(u_texel.x, 0.0)).x;
  float t = texture(u_curl, v_uv + vec2(0.0, u_texel.y)).x;
  float b = texture(u_curl, v_uv - vec2(0.0, u_texel.y)).x;
  float c = texture(u_curl, v_uv).x;
  // push across the gradient of |curl|: towards the swirl's core, sideways — the swirl spins faster
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 1e-4;
  force *= u_strength * c;
  force.y = -force.y;
  vec2 v = texture(u_velocity, v_uv).xy + force * u_dt;
  o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`);

    const divergence = program(`
uniform sampler2D u_velocity;
uniform vec2 u_texel;
void main() {
  vec2 c = texture(u_velocity, v_uv).xy;
  float l = texture(u_velocity, v_uv - vec2(u_texel.x, 0.0)).x;
  float r = texture(u_velocity, v_uv + vec2(u_texel.x, 0.0)).x;
  float t = texture(u_velocity, v_uv + vec2(0.0, u_texel.y)).y;
  float b = texture(u_velocity, v_uv - vec2(0.0, u_texel.y)).y;
  // solid walls: the flow through the border is zero
  if (v_uv.x - u_texel.x < 0.0) l = -c.x;
  if (v_uv.x + u_texel.x > 1.0) r = -c.x;
  if (v_uv.y + u_texel.y > 1.0) t = -c.y;
  if (v_uv.y - u_texel.y < 0.0) b = -c.y;
  o = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`);

    const scale = program(`
uniform sampler2D u_source;
uniform float u_value;
void main() {
  o = u_value * texture(u_source, v_uv);
}`);

    const pressure = program(`
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
uniform vec2 u_texel;
void main() {
  float l = texture(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x;
  float r = texture(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
  float t = texture(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
  float b = texture(u_pressure, v_uv - vec2(0.0, u_texel.y)).x;
  float d = texture(u_divergence, v_uv).x;
  o = vec4(0.25 * (l + r + t + b - d), 0.0, 0.0, 1.0);
}`);

    const gradient = program(`
uniform sampler2D u_pressure;
uniform sampler2D u_velocity;
uniform vec2 u_texel;
void main() {
  float l = texture(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x;
  float r = texture(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
  float t = texture(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
  float b = texture(u_pressure, v_uv - vec2(0.0, u_texel.y)).x;
  vec2 v = texture(u_velocity, v_uv).xy - 0.5 * vec2(r - l, t - b);
  o = vec4(v, 0.0, 1.0);
}`);

    // bloom: keep the bright paint, then blur it down a chain of ever smaller targets and back up
    const bright = program(`
uniform sampler2D u_source;
void main() {
  vec3 c = texture(u_source, v_uv).rgb;
  float m = max(c.r, max(c.g, c.b));
  float k = clamp(m - 0.35, 0.0, 1.0);
  o = vec4(c * k * k / max(m, 1e-4), 1.0);
}`);

    const blur = program(`
uniform sampler2D u_source;
uniform vec2 u_texel;
void main() {
  vec4 s = texture(u_source, v_uv + u_texel * vec2(-1.0, -1.0));
  s += texture(u_source, v_uv + u_texel * vec2(1.0, -1.0));
  s += texture(u_source, v_uv + u_texel * vec2(-1.0, 1.0));
  s += texture(u_source, v_uv + u_texel * vec2(1.0, 1.0));
  o = s * 0.25;
}`);

    const display = program(`
uniform sampler2D u_dye;
uniform sampler2D u_bloom;
uniform vec2 u_texel;
uniform vec3 u_background;
void main() {
  vec3 c = texture(u_dye, v_uv).rgb;
  // light the paint from the top-left by the slope of its thickness: it looks like a glossy liquid
  float l = length(texture(u_dye, v_uv - vec2(u_texel.x, 0.0)).rgb);
  float r = length(texture(u_dye, v_uv + vec2(u_texel.x, 0.0)).rgb);
  float t = length(texture(u_dye, v_uv + vec2(0.0, u_texel.y)).rgb);
  float b = length(texture(u_dye, v_uv - vec2(0.0, u_texel.y)).rgb);
  vec3 n = normalize(vec3(r - l, t - b, 0.06));
  float light = clamp(dot(n, normalize(vec3(-0.4, 0.5, 0.75))) + 0.25, 0.72, 1.15);
  c *= light;
  c += texture(u_bloom, v_uv).rgb * 0.55;
  // soft tone mapping keeps thick paint from burning to white
  c = 1.0 - exp(-c * 2.0);
  c = pow(c, vec3(0.92));
  // where paints of different hues overlap they turn greyish: give some colour back
  float grey = dot(c, vec3(0.3, 0.55, 0.15));
  c = clamp(mix(vec3(grey), c, 1.3), 0.0, 1.0);
  o = vec4(u_background * (1.0 - clamp(max(c.r, max(c.g, c.b)) * 1.4, 0.0, 1.0)) + c, 1.0);
}`);

    // ---------- Targets ----------

    type Pair = ReturnType<typeof glPingPong>;
    let simW = 1, simH = 1, dyeW = 1, dyeH = 1;
    let velocity: Pair, dye: Pair, press: Pair;
    let curlT: Target, divT: Target;
    let bloomT: Target[] = [];
    let made: Target[] = [];

    function make(): void {
      // a resize starts a new picture: free the old textures first
      for (const t of made) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
      const cssShort = Math.min(view.w, view.h);
      const aspect = view.w / view.h;
      const size = (short: number) => (aspect >= 1 ? [Math.round(short * aspect), short] : [short, Math.round(short / aspect)]) as [number, number];
      [simW, simH] = size(SIM);
      [dyeW, dyeH] = size(Math.min(DYE, Math.round(cssShort * view.dpr)));
      const opts = { type: "f16" as const, linear: true };
      velocity = glPingPong(gl, simW, simH, opts);
      press = glPingPong(gl, simW, simH, opts);
      curlT = glTarget(gl, simW, simH, opts);
      divT = glTarget(gl, simW, simH, opts);
      dye = glPingPong(gl, dyeW, dyeH, opts);
      bloomT = [];
      let w = dyeW >> 1, h = dyeH >> 1;
      for (let i = 0; i < 4 && w > 4 && h > 4; i++) {
        bloomT.push(glTarget(gl, w, h, opts));
        w >>= 1;
        h >>= 1;
      }
      made = [velocity.read, velocity.write, press.read, press.write, curlT, divT, dye.read, dye.write, ...bloomT];
    }

    // ---------- Passes ----------

    const simTexel = () => [1 / simW, 1 / simH] as const;

    function pass(prog: { p: WebGLProgram }, target: Target | null): void {
      gl.useProgram(prog.p);
      glBindTarget(gl, target);
    }

    function splatInto(pair: Pair, x: number, y: number, r: number, g: number, b: number, radius: number): void {
      pass(splat, pair.write);
      glTexture(gl, 0, pair.read.tex, splat.u("u_target"));
      gl.uniform1f(splat.u("u_aspect"), view.w / view.h);
      gl.uniform2f(splat.u("u_point"), x, y);
      gl.uniform3f(splat.u("u_color"), r, g, b);
      gl.uniform1f(splat.u("u_radius"), radius);
      glDrawQuad(gl);
      pair.swap();
    }

    /** A blob of paint at (x, y) in 0…1 (y up) pushed with velocity (vx, vy) in sim cells per second. */
    function addSplat(x: number, y: number, vx: number, vy: number, color: [number, number, number], size = 1): void {
      const radius = SPLAT_RADIUS * size * (view.w > view.h ? view.w / view.h : 1);
      splatInto(velocity, x, y, vx, vy, 0, radius);
      splatInto(dye, x, y, color[0], color[1], color[2], radius);
    }

    function step(dt: number): void {
      gl.disable(gl.BLEND);
      const [tx, ty] = simTexel();

      pass(curl, curlT);
      glTexture(gl, 0, velocity.read.tex, curl.u("u_velocity"));
      gl.uniform2f(curl.u("u_texel"), tx, ty);
      glDrawQuad(gl);

      pass(vorticity, velocity.write);
      glTexture(gl, 0, velocity.read.tex, vorticity.u("u_velocity"));
      glTexture(gl, 1, curlT.tex, vorticity.u("u_curl"));
      gl.uniform2f(vorticity.u("u_texel"), tx, ty);
      gl.uniform1f(vorticity.u("u_strength"), swirl);
      gl.uniform1f(vorticity.u("u_dt"), dt);
      glDrawQuad(gl);
      velocity.swap();

      pass(divergence, divT);
      glTexture(gl, 0, velocity.read.tex, divergence.u("u_velocity"));
      gl.uniform2f(divergence.u("u_texel"), tx, ty);
      glDrawQuad(gl);

      pass(scale, press.write);
      glTexture(gl, 0, press.read.tex, scale.u("u_source"));
      gl.uniform1f(scale.u("u_value"), PRESSURE_KEEP);
      glDrawQuad(gl);
      press.swap();

      gl.useProgram(pressure.p);
      gl.uniform2f(pressure.u("u_texel"), tx, ty);
      glTexture(gl, 1, divT.tex, pressure.u("u_divergence"));
      for (let i = 0; i < PRESSURE_STEPS; i++) {
        glBindTarget(gl, press.write);
        glTexture(gl, 0, press.read.tex, pressure.u("u_pressure"));
        glDrawQuad(gl);
        press.swap();
      }

      pass(gradient, velocity.write);
      glTexture(gl, 0, press.read.tex, gradient.u("u_pressure"));
      glTexture(gl, 1, velocity.read.tex, gradient.u("u_velocity"));
      gl.uniform2f(gradient.u("u_texel"), tx, ty);
      glDrawQuad(gl);
      velocity.swap();

      pass(advect, velocity.write);
      glTexture(gl, 0, velocity.read.tex, advect.u("u_velocity"));
      glTexture(gl, 1, velocity.read.tex, advect.u("u_source"));
      gl.uniform2f(advect.u("u_texel"), tx, ty);
      gl.uniform1f(advect.u("u_dt"), dt);
      gl.uniform1f(advect.u("u_fade"), VELOCITY_FADE);
      glDrawQuad(gl);
      velocity.swap();

      pass(advect, dye.write);
      glTexture(gl, 0, velocity.read.tex, advect.u("u_velocity"));
      glTexture(gl, 1, dye.read.tex, advect.u("u_source"));
      gl.uniform1f(advect.u("u_fade"), DYE_FADE);
      glDrawQuad(gl);
      dye.swap();
    }

    function bloom(): void {
      gl.disable(gl.BLEND);
      const first = bloomT[0];
      if (!first) return;
      pass(bright, first);
      glTexture(gl, 0, dye.read.tex, bright.u("u_source"));
      glDrawQuad(gl);
      gl.useProgram(blur.p);
      for (let i = 1; i < bloomT.length; i++) {
        const from = bloomT[i - 1]!;
        glBindTarget(gl, bloomT[i]!);
        glTexture(gl, 0, from.tex, blur.u("u_source"));
        gl.uniform2f(blur.u("u_texel"), 1 / from.w, 1 / from.h);
        glDrawQuad(gl);
      }
      // back up: each smaller level is added onto the bigger one
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = bloomT.length - 1; i > 0; i--) {
        const from = bloomT[i]!;
        glBindTarget(gl, bloomT[i - 1]!);
        glTexture(gl, 0, from.tex, blur.u("u_source"));
        gl.uniform2f(blur.u("u_texel"), 0.5 / from.w, 0.5 / from.h);
        glDrawQuad(gl);
      }
      gl.disable(gl.BLEND);
    }

    function show(): void {
      pass(display, null);
      glTexture(gl, 0, dye.read.tex, display.u("u_dye"));
      glTexture(gl, 1, (bloomT[0] ?? dye.read).tex, display.u("u_bloom"));
      gl.uniform2f(display.u("u_texel"), 1 / dyeW, 1 / dyeH);
      gl.uniform3f(display.u("u_background"), BACKGROUND[0]!, BACKGROUND[1]!, BACKGROUND[2]!);
      glDrawQuad(gl);
    }

    // ---------- Colours ----------

    let palette: Palette = "rainbow";
    let hueClock = rand(0, 1);

    /** HSL (h in turns) to RGB 0…1. */
    function hslRgb(h: number, s: number, l: number): [number, number, number] {
      const f = (n: number) => {
        const k = (n + h * 12) % 12;
        return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      };
      return [f(0), f(8), f(4)];
    }

    /** The next paint colour: the hue drifts slowly along the palette, with a little scatter. */
    function nextColor(): [number, number, number] {
      const t = hueClock + rand(-0.04, 0.04);
      let h: number;
      if (palette === "rainbow") h = t;
      else if (palette === "sunset") h = 0.93 + 0.17 * (0.5 - 0.5 * Math.cos(TAU * t)); // pink → orange → gold
      else h = 0.45 + 0.25 * (0.5 - 0.5 * Math.cos(TAU * t)); // turquoise → blue → violet
      const [r, g, b] = hslRgb(((h % 1) + 1) % 1, 0.9, 0.55);
      return [r * DYE_AMOUNT * 10, g * DYE_AMOUNT * 10, b * DYE_AMOUNT * 10];
    }

    // ---------- Input and the idle stirring ----------

    interface Splat {
      x: number;
      y: number;
      vx: number;
      vy: number;
      color: [number, number, number];
      size: number;
    }
    const queue: Splat[] = [];
    const fingerColor = new Map<number, [number, number, number]>();
    let idle = 0;
    let nextAuto = 0.4;
    let swirl = 30;
    let clock = 0;

    /** A random burst of paint: from somewhere on the screen, flung in a random direction. */
    function randomSplat(power = 1): void {
      const a = rand(0, TAU);
      const v = rand(700, 1300) * power;
      queue.push({ x: rand(0.15, 0.85), y: rand(0.2, 0.8), vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: nextColor(), size: rand(0.8, 1.6) });
    }

    function startPicture(): void {
      for (let i = 0; i < 7; i++) {
        hueClock += 0.13;
        randomSplat(1.2);
      }
    }

    onPointer({
      down(p) {
        idle = 0;
        const color = nextColor();
        fingerColor.set(p.id, color);
        const a = rand(0, TAU);
        queue.push({ x: p.x / view.w, y: 1 - p.y / view.h, vx: Math.cos(a) * 300, vy: Math.sin(a) * 300, color, size: 1.3 });
      },
      move(p) {
        if (!p.down) return;
        idle = 0;
        const color = fingerColor.get(p.id) ?? nextColor();
        // one finger keeps its colour while it drags, but it drifts along with the clock
        const fresh = nextColor();
        const mixed: [number, number, number] = [lerp(color[0], fresh[0], 0.05), lerp(color[1], fresh[1], 0.05), lerp(color[2], fresh[2], 0.05)];
        fingerColor.set(p.id, mixed);
        queue.push({
          x: p.x / view.w,
          y: 1 - p.y / view.h,
          vx: (p.dx / view.w) * FORCE * (simW / SIM),
          vy: (-p.dy / view.h) * FORCE * (simH / SIM),
          color: [mixed[0] * 0.2, mixed[1] * 0.2, mixed[2] * 0.2],
          size: 1,
        });
      },
      up(p) {
        fingerColor.delete(p.id);
      },
    });

    function clearAll(): void {
      for (const t of [velocity.read, velocity.write, dye.read, dye.write, press.read, press.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      queue.length = 0;
    }

    // ---------- Loop ----------

    make();
    startPicture();
    onResize(() => {
      make();
      startPicture();
    });

    startLoop((dt) => {
      if (dt > 0) {
        hueClock += dt * 0.05;
        if (pointers.size === 0) idle += dt;
        nextAuto -= dt;
        if (idle > IDLE_SPLAT && nextAuto <= 0) {
          randomSplat();
          if (Math.random() < 0.25) randomSplat();
          nextAuto = rand(1.4, 3);
        }
      }
      gl.disable(gl.BLEND);
      for (const s of queue) addSplat(s.x, s.y, s.vx, s.vy, s.color, s.size);
      queue.length = 0;
      // fixed small steps keep the explicit vorticity push stable; a slow device runs the fluid in slow motion
      if (dt > 0) {
        clock = Math.min(clock + dt, STEP * MAX_STEPS);
        while (clock >= STEP) {
          step(STEP);
          clock -= STEP;
        }
      }
      bloom();
      show();
    });

    addChoice<Palette>(
      [
        { value: "rainbow", label: "🌈 Радуга" },
        { value: "sunset", label: "🌅 Закат" },
        { value: "sea", label: "🌊 Море" },
      ],
      palette,
      (next) => {
        palette = next;
        hueClock = rand(0, 1);
      },
    );
    addSlider({
      label: "🌀 Вихри",
      min: 0,
      max: 60,
      step: 1,
      value: swirl,
      onInput: (v) => (swirl = v),
      format: (v) => String(v),
      title: "Как сильно закручиваются маленькие водовороты",
    });
    addButton("🔄", () => {
      clearAll();
      idle = 0;
      nextAuto = 0;
    }, { round: true, title: "Очистить" });

    // the very first frames: the burst of paint must already be swirling
    idle = IDLE_SPLAT - 1.5;
    showHint("Проведи пальцем — краски потекут за ним");
  }
}
