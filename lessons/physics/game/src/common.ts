// Shared code of the physics scenes: the full-screen canvas, the animation loop, pointer input, the control bar,
// the «Что тут происходит?» card, a 3D orbit control and WebGL 2 helpers.
// Each scene is src/<scene>.ts: a classic script that runs after this one in the same global scope, wrapped in its
// own namespace so scenes never clash when they are type-checked together.

declare const GAME_DATA: {
  lesson: string;
  scene: string;
  question: string;
  about: string[];
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const TAU = Math.PI * 2;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const rand = (lo = 0, hi = 1): number => lo + Math.random() * (hi - lo);
const randInt = (lo: number, hi: number): number => Math.floor(rand(lo, hi + 1));
/** Normally distributed random number (mean 0, deviation 1). */
const gauss = (): number => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(TAU * Math.random());
const hsl = (h: number, s: number, l: number, a = 1): string => `hsla(${h}, ${s}%, ${l}%, ${a})`;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Stage: the full-screen canvas ----------

const stage = $<HTMLCanvasElement>("stage");
/** Canvas size in CSS pixels and the device pixel ratio actually used for its backing store. */
const view = { w: 1, h: 1, dpr: 1 };
let maxDpr = 2;
let ctx2d: CanvasRenderingContext2D | null = null;
const resizeHandlers: (() => void)[] = [];

function fitStage(): void {
  view.dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  view.w = Math.max(1, stage.clientWidth);
  view.h = Math.max(1, stage.clientHeight);
  stage.width = Math.round(view.w * view.dpr);
  stage.height = Math.round(view.h * view.dpr);
  // Resizing a canvas resets its 2D state: draw in CSS pixels again
  ctx2d?.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  for (const handler of resizeHandlers) handler();
}
addEventListener("resize", fitStage);

/** Called after every resize; the canvas is already resized (and cleared). */
function onResize(handler: () => void): void {
  resizeHandlers.push(handler);
}

/** The 2D context of the stage; it draws in CSS pixels. */
function canvas2d(dprCap = 2): CanvasRenderingContext2D {
  maxDpr = dprCap;
  ctx2d = stage.getContext("2d")!;
  fitStage();
  return ctx2d;
}

/** The WebGL 2 context of the stage, or null (and a message on the screen) when the browser has none. */
function canvasGL(dprCap = 1.5, attributes: WebGLContextAttributes = {}): WebGL2RenderingContext | null {
  maxDpr = dprCap;
  const gl = stage.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, ...attributes });
  if (!gl) {
    $("no-gl").hidden = false;
    return null;
  }
  fitStage();
  return gl;
}

// ---------- Animation loop ----------

interface Loop {
  readonly paused: boolean;
  pause(): void;
  play(): void;
  toggle(): void;
}

/**
 * Calls frame(dt, time) on every animation frame; dt is in seconds, at most 1/20 s (a slow device slows the scene
 * down instead of making it jump). While paused, frame is still called with dt = 0 so the picture follows the pointer:
 * a scene moves its physics only when dt > 0.
 * Adds a ⏸/▶ button to the controls (and the Space key). With prefers-reduced-motion the scene starts paused.
 */
function startLoop(frame: (dt: number, time: number) => void, options: { button?: boolean } = {}): Loop {
  let paused = reducedMotion;
  let last = performance.now();
  let time = 0;
  let button: HTMLButtonElement | null = null;
  const label = () => {
    if (!button) return;
    button.textContent = paused ? "▶" : "⏸";
    button.title = paused ? "Запустить (пробел)" : "Пауза (пробел)";
    button.setAttribute("aria-label", paused ? "Запустить" : "Пауза");
  };
  const loop: Loop = {
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
      label();
    },
    play() {
      paused = false;
      label();
    },
    toggle() {
      if (paused) loop.play();
      else loop.pause();
    },
  };
  if (options.button !== false) {
    button = addButton("⏸", () => loop.toggle(), { round: true });
    label();
    addEventListener("keydown", (e) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        loop.toggle();
      }
    });
    if (paused) showHint("Нажми ▶, чтобы запустить");
  }
  const tick = (now: number) => {
    const dt = paused ? 0 : Math.min((now - last) / 1000, 1 / 20);
    last = now;
    time += dt;
    frame(dt, time);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    last = now;
    tick(now);
  });
  return loop;
}

// ---------- Pointer input ----------

interface Pointer {
  id: number;
  /** position in CSS pixels of the canvas */
  x: number;
  y: number;
  /** movement since the previous event */
  dx: number;
  dy: number;
  /** where the press started */
  startX: number;
  startY: number;
  down: boolean;
}

interface PointerHandlers {
  down?(p: Pointer): void;
  /** also called for a mouse hovering without a press (p.down is false) */
  move?(p: Pointer): void;
  up?(p: Pointer): void;
}

const pointerHandlers: PointerHandlers[] = [];
/** Pointers currently pressed on the stage (several fingers on a touch screen). */
const pointers = new Map<number, Pointer>();

function onPointer(handlers: PointerHandlers): void {
  pointerHandlers.push(handlers);
}

{
  const position = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  stage.addEventListener("pointerdown", (e) => {
    const { x, y } = position(e);
    const p: Pointer = { id: e.pointerId, x, y, dx: 0, dy: 0, startX: x, startY: y, down: true };
    pointers.set(e.pointerId, p);
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer (tests) may have no capture
    }
    hideHint();
    for (const h of pointerHandlers) h.down?.(p);
  });
  stage.addEventListener("pointermove", (e) => {
    const { x, y } = position(e);
    const p = pointers.get(e.pointerId) ?? { id: e.pointerId, x, y, dx: 0, dy: 0, startX: x, startY: y, down: false };
    p.dx = x - p.x;
    p.dy = y - p.y;
    p.x = x;
    p.y = y;
    for (const h of pointerHandlers) h.move?.(p);
  });
  const release = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    p.down = false;
    for (const h of pointerHandlers) h.up?.(p);
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---------- Controls ----------

const controls = $("controls");

/** A pill button in the bottom bar. */
function addButton(label: string, onClick: () => void, options: { title?: string; primary?: boolean; round?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "chip" + (options.primary ? " primary" : "") + (options.round ? " round" : "");
  button.textContent = label;
  if (options.title) button.title = options.title;
  button.addEventListener("click", () => {
    hideHint();
    onClick();
  });
  controls.append(button);
  return button;
}

/** A row of buttons of which one is chosen (the shape of a table, a mode…). */
function addChoice<T extends string>(
  options: { value: T; label: string; title?: string }[],
  value: T,
  onChange: (value: T) => void,
): { set(value: T): void; readonly value: T; readonly el: HTMLElement } {
  const group = document.createElement("div");
  group.className = "choice";
  group.setAttribute("role", "group");
  let current = value;
  const buttons = options.map((option) => {
    const button = document.createElement("button");
    button.className = "chip";
    button.textContent = option.label;
    if (option.title) button.title = option.title;
    button.addEventListener("click", () => {
      hideHint();
      choice.set(option.value);
      onChange(option.value);
    });
    group.append(button);
    return button;
  });
  const choice = {
    set(v: T) {
      current = v;
      options.forEach((o, i) => {
        buttons[i]!.classList.toggle("on", o.value === v);
        buttons[i]!.setAttribute("aria-pressed", String(o.value === v));
      });
    },
    get value() {
      return current;
    },
    el: group,
  };
  choice.set(value);
  controls.append(group);
  return choice;
}

/** A labelled slider; format turns the value into the text shown next to it. */
function addSlider(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (value: number) => void;
  format?: (value: number) => string;
  title?: string;
}): { set(value: number): void; readonly value: number; readonly input: HTMLInputElement; readonly el: HTMLElement } {
  const wrap = document.createElement("label");
  wrap.className = "slider";
  if (options.title) wrap.title = options.title;
  const text = document.createElement("span");
  text.textContent = options.label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.value);
  const output = document.createElement("output");
  const show = () => {
    output.textContent = options.format ? options.format(Number(input.value)) : "";
    output.hidden = !options.format;
  };
  input.addEventListener("input", () => {
    hideHint();
    show();
    options.onInput(Number(input.value));
  });
  show();
  wrap.append(text, input, output);
  controls.append(wrap);
  return {
    set(v: number) {
      input.value = String(v);
      show();
    },
    get value() {
      return Number(input.value);
    },
    input,
    el: wrap,
  };
}

/**
 * The part of the stage not covered by the title on top and the controls at the bottom, in CSS pixels: fit a figure
 * that must be seen whole (a table, a pendulum) into it. Call it after adding the controls, and again on resize.
 */
function freeArea(): { x: number; y: number; w: number; h: number } {
  const top = Math.max($("about-open").getBoundingClientRect().bottom, document.querySelector(".heading")!.getBoundingClientRect().bottom) + 8;
  const bottom = (controls.children.length ? controls.getBoundingClientRect().top : view.h - 70) - 8;
  return { x: 0, y: top, w: view.w, h: Math.max(80, bottom - top) };
}

/** Live numbers in the top-right corner (lines separated by \n); null hides the panel. */
function setReadout(text: string | null): void {
  const el = $("readout");
  const shown = !el.hidden;
  el.hidden = text === null;
  if (text !== null && el.textContent !== text) el.textContent = text;
  if (!shown && !el.hidden) placeReadout();
}

/** Keeps the readout under the title and the «?» button, however many lines the title takes. */
function placeReadout(): void {
  const below = Math.max($("about-open").getBoundingClientRect().bottom, document.querySelector(".heading")!.getBoundingClientRect().bottom);
  $("readout").style.top = `${Math.round(below + 8)}px`;
}
addEventListener("resize", placeReadout);

let hintTimer = 0;

/** A short hint above the controls («Проведи пальцем»); it fades on the first touch or button press. */
function showHint(text: string): void {
  const el = $("hint");
  clearTimeout(hintTimer); // a hint shown right after a press must not be hidden by that press
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("fade");
  placeHint();
}

/** Keeps the hint just above the controls, however many rows they take. */
function placeHint(): void {
  const top = controls.children.length ? controls.getBoundingClientRect().top : innerHeight - 20;
  $("hint").style.bottom = `${Math.round(innerHeight - top + 12)}px`;
}
addEventListener("resize", placeHint);
// the scene adds its controls after the hint is shown: place it again once they are on the screen
requestAnimationFrame(placeHint);

function hideHint(): void {
  const el = $("hint");
  if (el.hidden || el.classList.contains("fade")) return;
  el.classList.add("fade");
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (el.hidden = true), 700);
}

// ---------- «Что тут происходит?» ----------

{
  $("question").textContent = GAME_DATA.question;
  const text = $("about-text");
  for (const paragraph of GAME_DATA.about) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    text.append(p);
  }
  const overlay = $("about");
  const open = () => {
    overlay.hidden = false;
    $("about-close").focus();
  };
  const close = () => (overlay.hidden = true);
  $("about-open").addEventListener("click", open);
  $("about-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

// ---------- Sound ----------

let audio: AudioContext | null = null;

/** The page's AudioContext, created on first use (call it from a click or touch so browsers allow sound). */
function audioContext(): AudioContext | null {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

// ---------- 3D: rotate by dragging ----------

interface Orbit {
  yaw: number;
  pitch: number;
  /** 1 by default; wheel and pinch change it between minZoom and maxZoom */
  zoom: number;
  /** turns by inertia and slow auto-spin; call once per frame */
  step(dt: number): void;
  /** rotates a point: returns camera-space [x, y, z], z towards the viewer */
  rotate(x: number, y: number, z: number): [number, number, number];
  /** true while a finger or the mouse is turning the scene */
  readonly dragging: boolean;
}

/**
 * Drag to turn the scene, flick to let it spin on, wheel or two fingers to zoom. Without touching it slowly turns by
 * itself (spin radians per second). Uses the stage pointer events: a scene with an orbit shouldn't use drags for
 * anything else.
 */
function orbitControl(options: { yaw?: number; pitch?: number; spin?: number; minZoom?: number; maxZoom?: number } = {}): Orbit {
  const spin = options.spin ?? 0.15;
  const minZoom = options.minZoom ?? 0.5;
  const maxZoom = options.maxZoom ?? 3;
  let vy = spin;
  let vp = 0;
  let pinch = 0;
  let idle = 10;
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const orbit: Orbit = {
    yaw: options.yaw ?? 0.6,
    pitch: options.pitch ?? 0.35,
    zoom: 1,
    get dragging() {
      return pointers.size > 0;
    },
    step(dt) {
      idle += dt;
      if (pointers.size === 0) {
        orbit.yaw += vy * dt;
        orbit.pitch += vp * dt;
        // the flick slows down back to the gentle auto-spin
        const k = Math.exp(-dt * 1.5);
        vy = spin + (vy - spin) * k;
        vp *= k;
      }
      orbit.pitch = clamp(orbit.pitch, -1.5, 1.5);
    },
    rotate(x, y, z) {
      const cy = Math.cos(orbit.yaw), sy = Math.sin(orbit.yaw);
      const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      return [x1, cp * y - sp * z1, sp * y + cp * z1];
    },
  };
  onPointer({
    down() {
      pinch = pinchDistance();
      vy = 0;
      vp = 0;
    },
    move(p) {
      if (!p.down) return;
      if (pointers.size >= 2) {
        const d = pinchDistance();
        if (pinch > 0 && d > 0) orbit.zoom = clamp((orbit.zoom * d) / pinch, minZoom, maxZoom);
        pinch = d;
        return;
      }
      const k = 4 / Math.min(view.w, view.h);
      orbit.yaw += p.dx * k;
      orbit.pitch += p.dy * k;
      // remember the flick speed (radians per second, events come ~60 times a second)
      vy = p.dx * k * 60;
      vp = p.dy * k * 60;
      idle = 0;
    },
    up() {
      pinch = pinchDistance();
      if (idle > 0.1) vy = vp = 0;
    },
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    orbit.zoom = clamp(orbit.zoom * Math.exp(-e.deltaY * 0.001), minZoom, maxZoom);
  }, { passive: false });
  return orbit;
}

// ---------- WebGL 2 helpers ----------

/** Vertex shader of a full-screen triangle: v_uv runs 0…1 over the target. */
const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Compiles and links a program; the vertex attribute a_pos is always at location 0. Throws with the shader log. */
function glProgram(gl: WebGL2RenderingContext, fragment: string, vertex = FULLSCREEN_VS): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}\n${source}`);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

/** Uniform lookup with a cache: gl.uniform1f(u("u_time"), t). */
function glUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): (name: string) => WebGLUniformLocation | null {
  const cache = new Map<string, WebGLUniformLocation | null>();
  return (name) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name) ?? null;
  };
}

const quads = new WeakMap<WebGL2RenderingContext, WebGLVertexArrayObject>();

/** Draws one triangle covering the whole target (use with FULLSCREEN_VS). */
function glDrawQuad(gl: WebGL2RenderingContext): void {
  let vao = quads.get(gl);
  if (!vao) {
    vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    quads.set(gl, vao);
  }
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Which float textures the GPU can render into: f16 is nearly everywhere, f32 not on every phone. */
function glFloat(gl: WebGL2RenderingContext): { f16: boolean; f32: boolean } {
  const f32 = !!gl.getExtension("EXT_color_buffer_float");
  const f16 = f32 || !!gl.getExtension("EXT_color_buffer_half_float");
  return { f16, f32 };
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

/**
 * A texture to render into. type "f32" needs glFloat().f32 and is read with nearest filtering only (linear is not
 * guaranteed); "f16" filters linearly everywhere; "u8" is plain RGBA bytes.
 */
function glTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  options: { type?: "f16" | "f32" | "u8"; linear?: boolean; repeat?: boolean } = {},
): Target {
  const type = options.type ?? "f16";
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = options.linear && type !== "f32" ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  const wrap = options.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (type === "f32") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  else if (type === "f16") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

/** Two targets for a simulation step: read from one, write to the other, then swap. */
function glPingPong(gl: WebGL2RenderingContext, w: number, h: number, options: Parameters<typeof glTarget>[3] = {}) {
  const pair = {
    read: glTarget(gl, w, h, options),
    write: glTarget(gl, w, h, options),
    swap() {
      [pair.read, pair.write] = [pair.write, pair.read];
    },
  };
  return pair;
}

/** Draw into a target, or onto the screen (the stage canvas) with null. */
function glBindTarget(gl: WebGL2RenderingContext, target: Target | null): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
  if (target) gl.viewport(0, 0, target.w, target.h);
  else gl.viewport(0, 0, stage.width, stage.height);
}

/** Binds a texture to a texture unit and points a sampler uniform at it. */
function glTexture(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture, location: WebGLUniformLocation | null): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(location, unit);
}
