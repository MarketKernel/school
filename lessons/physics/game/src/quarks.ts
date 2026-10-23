// «Кварки на резинке»: confinement, as a picture. Quarks carry a «colour» charge (red, green, blue; antiquarks the
// anticolours) and the gluon field between them is squeezed into a flux tube of constant thickness, so its energy
// grows in proportion to its length: the pull is the same constant tension κ (about 16 tonnes-force in real life)
// however far the quark is — the opposite of gravity or magnets, which weaken with distance. A meson (quark +
// antiquark) is one tube; a baryon (three quarks) is a Y of three tubes meeting at the junction, which sits at the
// Fermat point of the triangle (found by Weiszfeld iterations), so the total length is the shortest.
// Pull a quark far enough and the stored energy is enough to make a new quark–antiquark pair: the tube snaps, the
// pair pops up in the gap and you get two hadrons, never a free quark (the Lund string picture). Colours are always
// combined to «white»: R + G + B, or a colour with its anticolour; every few seconds a gluon swaps them around.
// A metaphor in its scale and speed (the real thing is 10⁻¹⁵ m and 10⁻²³ s), but the rules are those of QCD.
// Method: quarks are points with the tube force κ·clamp((d − d₀)/s, −1, 1) towards their partner or the junction,
// plus damping and a gentle random push; the picture is one WebGL fragment shader: glowing tubes with colour noise
// flowing along them, quarks (antiquarks as rings), flashes, and the seething vacuum behind.

namespace Quarks {
  type Kind = "meson" | "baryon";

  interface Quark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    colour: number; // 0 red, 1 green, 2 blue
    anti: boolean;
    shown: [number, number, number]; // the colour on the screen, easing to the real one
    held: number | null; // pointer id, −1 for the demo hand
    tx: number; // where the finger is
    ty: number;
    phase: number;
    hx: number; // where it is held while another quark of its hadron is pulled
    hy: number;
  }

  interface Hadron {
    kind: Kind;
    quarks: Quark[];
    jx: number; // junction of a baryon
    jy: number;
    main: boolean;
    free: number; // seconds since it was let go (only for hadrons that will fade)
    fade: number;
    nextSwap: number;
  }

  const COLOURS: [number, number, number][] = [
    [1.0, 0.22, 0.28],
    [0.25, 1.0, 0.38],
    [0.28, 0.48, 1.0],
  ];
  const ANTI: [number, number, number][] = [
    [0.2, 0.95, 1.0], // anti-red: cyan
    [1.0, 0.3, 0.95], // anti-green: magenta
    [1.0, 0.88, 0.25], // anti-blue: yellow
  ];
  const EMOJI = ["🔴", "🟢", "🔵"];
  const MAX_SEGS = 16;
  const MAX_QUARKS = 16;
  const MAX_FLASHES = 6;
  const MAX_HADRONS = 6;
  const DAMP_FREE = 1.6; // 1/s
  const DAMP_RESIST = 7; // the rest of a hadron while one of its quarks is pulled
  const HOME = 2.2; // 1/s: pull of the main hadron back to the middle
  const HOLD = 6; // 1/s: how firmly the rest of it stays put while a quark is pulled
  const WOBBLE = 1.0; // share of κ for the random push

  const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec2 u_view;
uniform float u_time, u_width;
uniform int u_segs, u_quarks, u_flashes, u_auras;
uniform vec4 u_seg[${MAX_SEGS}];
uniform vec4 u_segA[${MAX_SEGS}];
uniform vec4 u_segB[${MAX_SEGS}]; // w: 1 for a baryon leg
uniform vec2 u_seg2[${MAX_SEGS}]; // x: energy (brighter when stretched)
uniform vec4 u_quark[${MAX_QUARKS}];
uniform vec4 u_quarkCol[${MAX_QUARKS}];
uniform vec4 u_flash[${MAX_FLASHES}];
uniform vec4 u_aura[${MAX_HADRONS}];

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.875;
}

void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_view;
  float w = u_width;
  // the vacuum is never empty: faint seething foam
  vec2 v = p / (w * 7.0);
  float foam = 0.5 + 0.25 * (sin(v.x * 1.7 + 1.5 * sin(v.y * 1.3 + u_time * 0.4) + u_time * 0.3)
    + sin(v.y * 1.9 + 1.5 * sin(v.x * 1.1 - u_time * 0.35) - u_time * 0.25));
  vec3 light = vec3(0.3, 0.22, 0.7) * smoothstep(0.5, 1.0, foam) * 0.2;

  for (int i = 0; i < ${MAX_HADRONS}; i++) {
    if (i >= u_auras) break;
    vec4 a = u_aura[i];
    float d = length(p - a.xy) / a.z;
    // colour-neutral: a soft white glow around a compact hadron
    light += vec3(1.0, 0.97, 0.92) * a.w * (exp(-d * d * 1.5) * 0.05 + exp(-pow((d - 1.0) / 0.05, 2.0)) * 0.07);
  }

  for (int i = 0; i < ${MAX_SEGS}; i++) {
    if (i >= u_segs) break;
    vec4 s = u_seg[i];
    vec2 ab = s.zw - s.xy;
    float len = max(length(ab), 1e-3);
    vec2 dir = ab / len;
    vec2 ap = p - s.xy;
    float along = clamp(dot(ap, dir), 0.0, len);
    float across = dir.x * ap.y - dir.y * ap.x;
    float d = length(ap - dir * along);
    if (d > w * 5.0) continue;
    float t = along / len;
    float energy = u_seg2[i].x;
    // the tube boils: its width and brightness wander, and the colour streams flow along it
    float wob = fbm(vec2(along / w * 0.35 - u_time * 0.9, float(i) * 3.7));
    float ww = w * (0.75 + 0.5 * wob);
    float flow = fbm(vec2(along / w * 0.8 - u_time * 2.4 * energy, across / ww * 1.4 + float(i) * 5.1));
    float core = exp(-pow(d / ww, 2.0) * 1.6);
    float halo = exp(-d / (w * 1.4)) * 0.3;
    // a baryon leg turns white only near the junction; a meson tube blends colour into anticolour
    float k = u_segB[i].w > 0.5 ? smoothstep(0.55, 1.0, t) : smoothstep(0.0, 1.0, t);
    vec3 c = mix(u_segA[i].rgb, u_segB[i].rgb, k);
    float streak = flow * flow;
    c = mix(c, vec3(1.0), smoothstep(0.55, 0.9, flow) * 0.35);
    light += c * (core * (0.6 + 1.6 * streak) + halo) * u_segA[i].w * energy;
  }

  for (int i = 0; i < ${MAX_QUARKS}; i++) {
    if (i >= u_quarks) break;
    vec4 q = u_quark[i];
    vec4 col = u_quarkCol[i];
    float d = length(p - q.xy);
    float r = q.z;
    float body = q.w > 0.5
      ? exp(-pow((d - r * 0.62) / (r * 0.2), 2.0)) * 1.3 + exp(-pow(d / r, 2.0)) * 0.15 // antiquark: a ring
      : exp(-pow(d / r, 2.0) * 1.6) * 1.2;
    float hot = q.w > 0.5 ? 0.0 : exp(-pow(d / (r * 0.28), 2.0)) * 0.45;
    float halo = exp(-d / (r * 0.9)) * 0.22;
    light += (col.rgb * (body + halo) + vec3(hot)) * col.w;
  }

  for (int i = 0; i < ${MAX_FLASHES}; i++) {
    if (i >= u_flashes) break;
    vec4 f = u_flash[i];
    float d = length(p - f.xy);
    float size = f.w * (0.4 + f.z * 1.6);
    float ring = exp(-pow((d - size) / (f.w * 0.18), 2.0));
    light += vec3(1.0, 0.95, 0.85) * (exp(-pow(d / (f.w * 0.5), 2.0)) * 3.0 * (1.0 - f.z) + ring * (1.0 - f.z) * 0.8);
  }

  vec3 bg = vec3(0.051, 0.043, 0.118);
  vec3 c = 1.0 - exp(-light);
  o = vec4(bg + c * (1.0 - bg), 1.0);
}`;

  function run(gl: WebGL2RenderingContext): void {
    const program = glProgram(gl, FS);
    const u = glUniforms(gl, program);

    let hadrons: Hadron[] = [];
    const flashes: { x: number; y: number; t: number; size: number }[] = [];
    let kind: Kind = "baryon";
    let home = { x: view.w / 2, y: view.h / 2 };
    let box = { x: 0, y: 0, w: view.w, h: view.h }; // the free area: spare hadrons stay inside it
    let size = 40; // quark distance from the middle of a hadron at rest
    let snap = 200; // tube length at which it breaks
    let tension = 1200; // px/s² — the same at any length
    let time = 0;
    let demo = 1.4; // seconds until the ghost hand pulls a quark (if nobody touched yet)
    let demoTarget: { q: Quark; dx: number; dy: number } | null = null;
    let touched = false;

    function layout(): void {
      const area = freeArea();
      box = area;
      home = { x: area.x + area.w / 2, y: area.y + area.h / 2 };
      const s = Math.min(area.w, area.h);
      size = clamp(s * 0.1, 30, 70);
      snap = Math.max(size * 4, s * 0.4);
      tension = s * 2.6;
      const heading = document.querySelector(".heading")!.getBoundingClientRect();
      $("readout").style.top = view.w < 700 ? `${Math.round(heading.bottom + 8)}px` : "";
    }

    const quark = (x: number, y: number, colour: number, anti: boolean): Quark => ({
      x, y, vx: 0, vy: 0, colour, anti,
      shown: [...(anti ? ANTI : COLOURS)[colour]!] as [number, number, number],
      held: null, tx: x, ty: y, phase: rand(0, TAU), hx: x, hy: y,
    });

    function hadron(k: Kind, quarks: Quark[], main: boolean): Hadron {
      const h: Hadron = { kind: k, quarks, jx: 0, jy: 0, main, free: 0, fade: 1, nextSwap: time + rand(1.5, 3.5) };
      junction(h);
      return h;
    }

    function reset(next: Kind): void {
      kind = next;
      const { x, y } = home;
      if (kind === "meson") {
        const c = randInt(0, 2);
        hadrons = [hadron("meson", [quark(x - size, y, c, false), quark(x + size, y, c, true)], true)];
      } else {
        const order = [0, 1, 2].sort(() => Math.random() - 0.5);
        const qs = [0, 1, 2].map((i) => {
          const a = -Math.PI / 2 + (i * TAU) / 3;
          return quark(x + Math.cos(a) * size, y + Math.sin(a) * size, order[i]!, false);
        });
        hadrons = [hadron("baryon", qs, true)];
      }
    }

    function flash(x: number, y: number, s: number): void {
      flashes.push({ x, y, t: time, size: s });
      if (flashes.length > MAX_FLASHES) flashes.shift();
    }

    /** The Fermat point of the three quarks: where three tubes of equal tension balance (at 120° to each other). */
    function junction(h: Hadron): void {
      const qs = h.quarks;
      if (h.kind === "meson") {
        h.jx = (qs[0]!.x + qs[1]!.x) / 2;
        h.jy = (qs[0]!.y + qs[1]!.y) / 2;
        return;
      }
      let x = (qs[0]!.x + qs[1]!.x + qs[2]!.x) / 3;
      let y = (qs[0]!.y + qs[1]!.y + qs[2]!.y) / 3;
      for (let k = 0; k < 12; k++) {
        let sx = 0, sy = 0, sw = 0;
        for (const q of qs) {
          const d = Math.max(Math.hypot(q.x - x, q.y - y), 0.5);
          sx += q.x / d;
          sy += q.y / d;
          sw += 1 / d;
        }
        x = sx / sw;
        y = sy / sw;
      }
      h.jx = x;
      h.jy = y;
    }

    /** The tubes of a hadron as [from quark, to point]; a meson's tube goes quark to quark. */
    function tubes(h: Hadron): [Quark, number, number, Quark | null][] {
      const [a, b] = h.quarks;
      if (h.kind === "meson") return [[a!, b!.x, b!.y, b!]];
      return h.quarks.map((q) => [q, h.jx, h.jy, null] as [Quark, number, number, Quark | null]);
    }

    /** Stretched too far: a new quark–antiquark pair appears in the gap and the hadron becomes two. */
    function breakTube(h: Hadron, q: Quark): void {
      if (h.kind === "meson") {
        // the piece that leaves is the one being pulled (or the one further from the middle)
        const [a, b] = h.quarks as [Quark, Quark];
        const far = (o: Quark) => Math.hypot(o.x - home.x, o.y - home.y);
        q = b.held !== null && a.held === null ? b : a.held !== null && b.held === null ? a : far(b) > far(a) ? b : a;
      }
      const end = h.kind === "meson" ? h.quarks.find((o) => o !== q)! : { x: h.jx, y: h.jy };
      const k = rand(0.45, 0.6);
      const px = lerp(end.x, q.x, k), py = lerp(end.y, q.y, k);
      const len = Math.hypot(q.x - end.x, q.y - end.y) || 1;
      const ux = (q.x - end.x) / len, uy = (q.y - end.y) / len;
      const gap = size * 0.35;
      // the new partner of q is its anticolour; the other new one takes q's place in the old hadron
      const partner = quark(px + ux * gap, py + uy * gap, q.colour, !q.anti);
      const stand = quark(px - ux * gap, py - uy * gap, q.colour, q.anti);
      partner.vx = q.vx * 0.5 + ux * 60;
      partner.vy = q.vy * 0.5 + uy * 60;
      stand.vx = -ux * 60;
      stand.vy = -uy * 60;
      h.quarks = h.quarks.map((o) => (o === q ? stand : o));
      // the old hadron (with the new quark in place) stays, the pulled quark leaves with its new partner
      const born = hadron("meson", [q, partner], false);
      if (!h.main) born.free = h.free;
      junction(h);
      hadrons.push(born);
      const spare = hadrons.filter((o) => !o.main);
      if (spare.length > MAX_HADRONS - 1) spare[0]!.free = Math.max(spare[0]!.free, 99);
      flash(px, py, size * 1.6);
      pop();
    }

    /** A soft «pop» for the new pair (when sound is allowed). */
    function pop(): void {
      const audio = audioContext();
      if (!audio || audio.state !== "running") return;
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(220, t + 0.25);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    }

    /** A gluon swaps colours: two quarks of a baryon trade, or a meson turns to another colour and its anticolour. */
    function swap(h: Hadron): void {
      h.nextSwap = time + rand(2.2, 4.5);
      if (h.kind === "meson") {
        const c = (h.quarks[0]!.colour + randInt(1, 2)) % 3;
        for (const q of h.quarks) q.colour = c;
      } else {
        const i = randInt(0, 2), j = (i + randInt(1, 2)) % 3;
        const a = h.quarks[i]!, b = h.quarks[j]!;
        [a.colour, b.colour] = [b.colour, a.colour];
      }
    }

    function step(dt: number): void {
      time += dt;
      for (const h of hadrons) {
        const pulled = h.quarks.some((q) => q.held !== null);
        junction(h);
        if (time > h.nextSwap) swap(h);
        // the centre of the hadron, for the pull home
        let cx = 0, cy = 0;
        for (const q of h.quarks) {
          cx += q.x / h.quarks.length;
          cy += q.y / h.quarks.length;
        }
        for (const q of h.quarks) {
          let ax = 0, ay = 0;
          // constant tension towards the partner (meson) or the junction (baryon)
          const [tx, ty] = h.kind === "meson" ? (() => {
            const o = h.quarks.find((p) => p !== q)!;
            return [o.x, o.y];
          })() : [h.jx, h.jy];
          const dx = tx - q.x, dy = ty - q.y;
          const d = Math.hypot(dx, dy) || 1;
          const rest = h.kind === "meson" ? size * 2 : size;
          const f = tension * clamp((d - rest) / (size * 0.6), -1.5, 1);
          ax += (f * dx) / d;
          ay += (f * dy) / d;
          // a gentle random push keeps everything alive
          const w = tension * WOBBLE * 0.25;
          ax += w * (Math.sin(time * 1.7 + q.phase) + 0.6 * Math.sin(time * 2.9 + q.phase * 2.3));
          ay += w * (Math.cos(time * 1.3 + q.phase * 1.7) + 0.6 * Math.sin(time * 3.3 + q.phase * 0.7));
          if (h.main) {
            // while a quark is pulled, the rest of the hadron is held near its place (as by its neighbours in a nucleus)
            const k = pulled ? HOLD : HOME;
            const ox = pulled ? q.x - q.hx : cx - home.x;
            const oy = pulled ? q.y - q.hy : cy - home.y;
            ax -= k * k * ox;
            ay -= k * k * oy;
          } else {
            // spare hadrons drift away from the main one
            const main = hadrons.find((o) => o.main);
            if (main) {
              const mx = cx - main.jx, my = cy - main.jy;
              const md = Math.hypot(mx, my) || 1;
              const push = (tension * 0.1 * size * 4) / Math.max(md, size * 2);
              ax += (push * mx) / md;
              ay += (push * my) / md;
            }
            // soft walls: it stays on the screen while it fades
            const m = size * 1.5;
            if (cx < box.x + m) ax += tension * 0.4;
            if (cx > box.x + box.w - m) ax -= tension * 0.4;
            if (cy < box.y + m) ay += tension * 0.4;
            if (cy > box.y + box.h - m) ay -= tension * 0.4;
          }
          if (q.held !== null) {
            // the finger is much stronger than the tube: the quark follows it closely
            q.vx = (q.tx - q.x) * 18;
            q.vy = (q.ty - q.y) * 18;
          } else {
            const damp = Math.exp(-dt * (pulled && h.main ? DAMP_RESIST : h.main ? DAMP_FREE : DAMP_FREE * 1.6));
            q.vx = (q.vx + ax * dt) * damp;
            q.vy = (q.vy + ay * dt) * damp;
          }
        }
        // quarks of a baryon stay apart a little (the three tubes would else fold into one line)
        if (h.kind === "baryon") {
          for (let i = 0; i < 3; i++) {
            for (let j = i + 1; j < 3; j++) {
              const a = h.quarks[i]!, b = h.quarks[j]!;
              const dx = b.x - a.x, dy = b.y - a.y;
              const d = Math.hypot(dx, dy) || 1;
              if (d > size * 1.4) continue;
              const k = (tension * 1.5 * (1 - d / (size * 1.4)) * dt) / d;
              if (a.held === null) {
                a.vx -= dx * k;
                a.vy -= dy * k;
              }
              if (b.held === null) {
                b.vx += dx * k;
                b.vy += dy * k;
              }
            }
          }
        }
        for (const q of h.quarks) {
          q.x += q.vx * dt;
          q.y += q.vy * dt;
          if (!pulled) {
            q.hx = q.x;
            q.hy = q.y;
          }
          const target = (q.anti ? ANTI : COLOURS)[q.colour]!;
          for (let c = 0; c < 3; c++) q.shown[c] = lerp(q.shown[c]!, target[c]!, 1 - Math.exp(-dt * 5));
        }
        if (!h.main && !pulled) h.free += dt;
        if (pulled) h.free = 0;
        h.fade = 1 - clamp((h.free - 2.5) / 2.5, 0, 1);
      }
      // stretched tubes snap (only one per frame, so the pieces settle)
      outer: for (const h of hadrons) {
        junction(h);
        for (const [q, tx, ty] of tubes(h)) {
          const limit = h.kind === "meson" ? snap : snap * 0.75;
          if (Math.hypot(q.x - tx, q.y - ty) > limit) {
            breakTube(h, q);
            break outer;
          }
        }
      }
      hadrons = hadrons.filter((h) => h.fade > 0);
      if (!hadrons.some((h) => h.main) && hadrons.length) hadrons[0]!.main = true;
      if (!hadrons.length) reset(kind);

      // the ghost hand: shows what to do until somebody touches the screen
      if (!touched) {
        demo -= dt;
        const main = hadrons.find((h) => h.main);
        if (demo <= 0 && !demoTarget && main) {
          const q = main.quarks[0]!;
          const dx = q.x - main.jx, dy = q.y - main.jy;
          const d = Math.hypot(dx, dy) || 1;
          demoTarget = { q, dx: dx / d, dy: dy / d };
          q.held = -1;
          q.tx = q.x;
          q.ty = q.y;
        }
        if (demoTarget) {
          const { q } = demoTarget;
          if (!hadrons.some((h) => h.quarks.includes(q)) || q.held !== -1) demoTarget = null;
          else {
            q.tx += demoTarget.dx * snap * 1.1 * dt;
            q.ty += demoTarget.dy * snap * 1.1 * dt;
            const owner = hadrons.find((h) => h.quarks.includes(q));
            if (owner && !owner.main) {
              q.held = null;
              demoTarget = null;
              demo = 9;
            }
          }
        }
      }
    }

    function readout(): void {
      const lines: string[] = [];
      for (const h of hadrons) {
        if (h.fade < 0.5 || lines.length >= 3) continue;
        const parts = h.quarks.map((q) => (q.anti ? `анти${EMOJI[q.colour]}` : EMOJI[q.colour]!));
        lines.push(`${h.kind === "meson" ? "Мезон" : "Протон"} ${parts.join(h.kind === "meson" ? " " : "")} = ⚪`);
      }
      setReadout(lines.join("\n"));
    }

    const seg = new Float32Array(MAX_SEGS * 4);
    const segA = new Float32Array(MAX_SEGS * 4);
    const segB = new Float32Array(MAX_SEGS * 4);
    const seg2 = new Float32Array(MAX_SEGS * 2);
    const qPos = new Float32Array(MAX_QUARKS * 4);
    const qCol = new Float32Array(MAX_QUARKS * 4);
    const fl = new Float32Array(MAX_FLASHES * 4);
    const aura = new Float32Array(MAX_HADRONS * 4);

    function render(): void {
      let ns = 0, nq = 0, na = 0;
      for (const h of hadrons) {
        let longest = 0;
        for (const [q, tx, ty, other] of tubes(h)) {
          if (ns >= MAX_SEGS) break;
          const len = Math.hypot(q.x - tx, q.y - ty);
          const rest = h.kind === "meson" ? size * 2 : size;
          const limit = h.kind === "meson" ? snap : snap * 0.75;
          const stretch = clamp((len - rest) / (limit - rest), 0, 1);
          longest = Math.max(longest, stretch);
          seg.set([q.x, q.y, tx, ty], ns * 4);
          segA.set([...q.shown, h.fade], ns * 4);
          // a meson's tube runs from the colour to the anticolour, a baryon's from the colour to white at the junction
          const end = other ? other.shown : [0.95, 0.93, 0.9];
          // close to breaking the tube glows hotter
          segB.set([end[0]!, end[1]!, end[2]!, other ? 0 : 1], ns * 4);
          seg2.set([1 + stretch * stretch * 0.8, 0], ns * 2);
          ns++;
        }
        for (const q of h.quarks) {
          if (nq >= MAX_QUARKS) break;
          qPos.set([q.x, q.y, size * 0.5, q.anti ? 1 : 0], nq * 4);
          qCol.set([...q.shown, h.fade], nq * 4);
          nq++;
        }
        if (na < MAX_HADRONS) {
          aura.set([h.jx, h.jy, size * (h.kind === "meson" ? 1.9 : 1.75), h.fade * (1 - longest) ** 2], na * 4);
          na++;
        }
      }
      let nf = 0;
      for (const f of flashes) {
        const age = (time - f.t) / 0.6;
        if (age >= 1 || nf >= MAX_FLASHES) continue;
        fl.set([f.x, f.y, age, f.size], nf * 4);
        nf++;
      }
      glBindTarget(gl, null);
      gl.useProgram(program);
      gl.uniform2f(u("u_view"), view.w, view.h);
      gl.uniform1f(u("u_time"), time);
      gl.uniform1f(u("u_width"), size * 0.4);
      gl.uniform1i(u("u_segs"), ns);
      gl.uniform1i(u("u_quarks"), nq);
      gl.uniform1i(u("u_flashes"), nf);
      gl.uniform1i(u("u_auras"), na);
      gl.uniform4fv(u("u_seg"), seg);
      gl.uniform4fv(u("u_segA"), segA);
      gl.uniform4fv(u("u_segB"), segB);
      gl.uniform2fv(u("u_seg2"), seg2);
      gl.uniform4fv(u("u_quark"), qPos);
      gl.uniform4fv(u("u_quarkCol"), qCol);
      gl.uniform4fv(u("u_flash"), fl);
      gl.uniform4fv(u("u_aura"), aura);
      glDrawQuad(gl);
    }

    let dirty = true;
    startLoop((dt) => {
      if (dt > 0) step(dt);
      if (dt > 0 || dirty) {
        render();
        readout();
      }
      dirty = false;
    });

    // ---------- Controls and touch ----------

    addChoice<Kind>(
      [
        { value: "meson", label: "✌️ Мезон", title: "Два: кварк и антикварк" },
        { value: "baryon", label: "🔺 Протон", title: "Три кварка трёх цветов" },
      ],
      kind,
      (next) => {
        reset(next);
        flash(home.x, home.y, size * 1.2);
        dirty = true;
      },
    );

    const grab = Math.max(44, size * 1.3);
    onPointer({
      down(p) {
        touched = true;
        if (demoTarget) {
          demoTarget.q.held = null;
          demoTarget = null;
        }
        let best: Quark | null = null;
        let bestD = Math.max(grab, size * 1.3);
        for (const h of hadrons) {
          if (h.fade < 0.3) continue;
          for (const q of h.quarks) {
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            if (q.held === null && d < bestD) {
              best = q;
              bestD = d;
            }
          }
        }
        if (best) {
          best.held = p.id;
          best.tx = p.x;
          best.ty = p.y;
          audioContext();
        } else {
          // a tap on the empty vacuum: a little shock wave that shakes the quarks
          flash(p.x, p.y, size * 0.9);
          for (const h of hadrons) {
            for (const q of h.quarks) {
              const dx = q.x - p.x, dy = q.y - p.y;
              const d = Math.hypot(dx, dy) || 1;
              const kick = (tension * 0.4 * size * 3) / Math.max(d, size * 2);
              q.vx += (kick * dx) / d;
              q.vy += (kick * dy) / d;
            }
          }
        }
        dirty = true;
      },
      move(p) {
        if (!p.down) return;
        for (const h of hadrons) {
          for (const q of h.quarks) {
            if (q.held === p.id) {
              q.tx = p.x;
              q.ty = p.y;
            }
          }
        }
        dirty = true;
      },
      up(p) {
        for (const h of hadrons) {
          for (const q of h.quarks) {
            if (q.held !== p.id) continue;
            q.held = null;
            // a flick throws it, but not off the screen at once
            const v = Math.hypot(q.vx, q.vy);
            const max = tension * 0.4;
            if (v > max) {
              q.vx *= max / v;
              q.vy *= max / v;
            }
          }
        }
      },
    });
    onResize(() => {
      layout();
      dirty = true;
    });

    layout();
    reset(kind);
    showHint("Потяни кварк пальцем — далеко-далеко!");
  }

  const gl = canvasGL(1);
  if (gl) run(gl);
}
