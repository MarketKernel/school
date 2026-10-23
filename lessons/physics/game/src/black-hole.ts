// «Чёрная дыра»: a ray-traced Schwarzschild black hole. Every pixel shoots a photon backwards from the camera and
// follows its real path in the curved space around the hole. Units: the horizon radius rs = 1 (so the photon sphere
// is at r = 1.5 and the innermost stable orbit, where the disk starts, at r = 3).
// Method: a light ray around a Schwarzschild mass stays in one plane, and in that plane its orbit equation
// u'' + u = 1.5·u² (u = 1/r, rs = 1) is exactly reproduced by the Newtonian-looking Cartesian motion
//   a = −1.5 · h² · r⃗ / r⁵,  h = |r⃗ × v⃗| (conserved),
// which the fragment shader integrates with a step proportional to r (small near the hole, big far away). A ray that
// falls below r = 1 is swallowed (black); one that flies away picks the colour of the sky in its final direction, so
// the stars behind the hole are seen bent around it (the Einstein ring). A ray crossing the plane y = 0 between the
// innermost stable orbit and the outer rim hits the thin accretion disk: its colour is a black body of the disk
// temperature T ∝ r^(−3/4)·(1 − √(r_in/r))^(1/4), shifted by the Doppler factor of the gas orbiting at the Kepler speed
// v = √(1/(2r)) and by the gravitational redshift √(1 − 1/r); brightness goes as the cube of the Doppler factor, so the side flying towards us is
// brighter and bluer. The picture is drawn into a smaller texture (its size adapts to the frame time) and stretched to
// the screen with a soft glow built from its mipmaps.

namespace BlackHole {
  type Disk = "disk" | "none";

  const DISTANCE = 22; // camera distance at zoom 1, in horizon radii
  const DISK_IN = 3; // innermost stable circular orbit
  const DISK_OUT = 13;
  const FOV = 1.05; // vertical field of view, radians
  const SCALES = [0.34, 0.42, 0.5, 0.6, 0.7, 0.8]; // render size relative to CSS pixels
  const SLOW_FRAME = 1 / 30; // seconds: slower frames shrink the picture, much faster ones grow it

  const TRACE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_res;
uniform vec3 u_cam, u_right, u_up, u_fwd;
uniform float u_tan;     // tan(fov / 2)
uniform float u_time;
uniform float u_disk;    // 1 with the disk, 0 without
uniform int u_steps;
uniform float u_pix;     // angular size of a pixel, radians

const float DISK_IN = ${DISK_IN.toFixed(1)};
const float DISK_OUT = ${DISK_OUT.toFixed(1)};

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec4 hash43(vec3 p) {
  vec4 q = fract(vec4(p.xyzx) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
                 mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
                 mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// Black body colour of a temperature in kelvin (fit of the CIE colours, normalised to the brightest channel)
vec3 blackbody(float t) {
  t = clamp(t, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : 1.2929 * pow(t - 60.0, -0.1332);
  c.g = t <= 66.0 ? 0.3901 * log(t) - 0.6318 : 1.1299 * pow(t - 60.0, -0.0755);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : 0.5432 * log(t - 10.0) - 1.1963);
  return clamp(c, 0.0, 1.0);
}

// Stars: one candidate per cell of a 3D grid around the sky, three layers of different density
vec3 stars(vec3 d) {
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 3; layer++) {
    float n = 90.0 + float(layer) * 110.0;
    vec3 p = d * n;
    vec3 cell = floor(p);
    vec4 h = hash43(cell + float(layer) * 71.0);
    if (h.x > 0.03 + 0.02 * float(layer)) continue;
    vec3 center = cell + 0.25 + 0.5 * h.yzw;
    float dist = length(p - center);
    float size = max(u_pix * n * 0.9, 0.05);
    float bright = pow(h.w, 10.0) * 7.0 + 0.12;
    vec3 tint = blackbody(mix(3200.0, 14000.0, h.y));
    col += tint * bright * exp(-dist * dist / (size * size)) * (0.9 / (1.0 + float(layer)));
  }
  return col;
}

vec3 sky(vec3 d) {
  vec3 col = stars(d);
  // the Milky Way: a band of glowing clouds with dark dust lanes, tilted against the disk
  vec3 n = normalize(vec3(0.35, 1.0, -0.45));
  float lat = dot(d, n);
  float band = exp(-lat * lat / 0.035);
  float cloud = fbm(d * 3.5);
  float dust = smoothstep(0.45, 0.75, fbm(d * 7.0 + 3.0));
  vec3 milky = mix(vec3(0.30, 0.26, 0.45), vec3(0.75, 0.55, 0.40), smoothstep(0.4, 0.8, cloud));
  col += milky * band * cloud * cloud * (1.0 - 0.8 * dust) * 0.9;
  col += stars(d.zxy) * band * 1.2; // denser stars inside the band
  // faint coloured nebulae all over the sky
  float neb = fbm(d * 1.6 + 9.0);
  col += mix(vec3(0.10, 0.03, 0.18), vec3(0.02, 0.10, 0.20), noise(d * 2.0)) * smoothstep(0.45, 0.8, neb) * 0.55;
  return col;
}

// The disk at a point of the plane y = 0 seen along the ray direction dir: colour and opacity
vec4 disk(vec3 p, vec3 dir) {
  float r = length(p.xz);
  if (r < DISK_IN || r > DISK_OUT) return vec4(0.0);
  float phi = atan(p.z, p.x);
  // gas swirls at the Kepler angular speed; two layers wound up at different times hide the endless winding
  float omega = sqrt(0.5) / pow(r, 1.5);
  float tex = 0.0;
  for (int k = 0; k < 2; k++) {
    float age = mod(u_time + float(k) * 10.0, 20.0);
    float w = 1.0 - abs(age / 10.0 - 1.0);
    float a = phi - omega * age;
    tex += w * fbm(vec3(cos(a) * 2.2, sin(a) * 2.2, r * 1.3) + float(k) * 5.0);
  }
  float rings = 0.8 + 0.2 * sin(r * 5.0 + 3.0 * noise(vec3(r * 1.5, 0.0, 0.0)));
  float density = clamp(tex * 2.2 - 0.45, 0.0, 1.0) * rings;
  // temperature profile of a thin disk (its maximum is 0.488 at r = 49/36·r_in)
  float x = r / DISK_IN;
  float prof = pow(x, -0.75) * pow(max(1.0 - 1.0 / sqrt(x), 0.0), 0.25) / 0.488;
  // Doppler factor of the orbiting gas and the gravitational redshift
  float beta = sqrt(0.5 / r);
  vec3 vel = beta * vec3(-p.z, 0.0, p.x) / r;
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  float doppler = 1.0 / (gamma * (1.0 + dot(vel, dir)));
  float grav = sqrt(1.0 - 1.0 / r);
  float g = doppler * grav;
  float temp = 4800.0 * prof * g;
  // the beaming is kept honest (g³ of the Doppler part); the redshift dims only gently so the inner edge still glows
  vec3 col = blackbody(temp) * pow(prof, 1.5) * pow(doppler, 3.0) * grav * 1.5;
  float edge = smoothstep(DISK_IN, DISK_IN + 0.4, r) * smoothstep(DISK_OUT, DISK_OUT - 4.0, r);
  float alpha = clamp((0.25 + density) * edge, 0.0, 0.95);
  return vec4(col * (0.4 + 1.2 * density), alpha);
}

void main() {
  vec2 q = (v_uv * 2.0 - 1.0) * vec2(u_res.x / u_res.y, 1.0) * u_tan;
  vec3 dir = normalize(u_fwd + q.x * u_right + q.y * u_up);
  vec3 pos = u_cam;
  vec3 vel = dir;
  float h2 = dot(cross(pos, vel), cross(pos, vel));
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  bool captured = false;
  float far = max(length(u_cam) * 1.3, 40.0);
  for (int i = 0; i < 300; i++) {
    if (i >= u_steps) break;
    float r2 = dot(pos, pos);
    float r = sqrt(r2);
    if (r < 1.0) { captured = true; break; }
    if (r > far && dot(pos, vel) > 0.0) break;
    float dt = clamp(0.075 * (r - 0.6), 0.03, 2.5); // small steps near the hole
    vec3 old = pos;
    vel += -1.5 * h2 * pos / (r2 * r2 * r) * dt;
    pos += vel * dt;
    if (u_disk > 0.5 && old.y * pos.y < 0.0) {
      vec3 p = mix(old, pos, old.y / (old.y - pos.y));
      vec4 d = disk(p, normalize(vel));
      col += (1.0 - alpha) * d.rgb * d.a;
      alpha += (1.0 - alpha) * d.a;
      if (alpha > 0.97) break;
    }
  }
  if (!captured && alpha < 0.97) col += (1.0 - alpha) * sky(normalize(vel));
  col = 1.0 - exp(-col * 1.25);
  outColor = vec4(pow(col, vec3(0.85)), 1.0);
}`;

  // The small picture stretched to the screen, plus a glow from two blurrier mipmap levels
  const SHOW_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb;
  vec3 b1 = textureLod(u_tex, v_uv, 2.0).rgb;
  vec3 b2 = textureLod(u_tex, v_uv, 4.0).rgb;
  vec3 glow = max(b1 - 0.35, 0.0) * 0.45 + max(b2 - 0.25, 0.0) * 0.6;
  outColor = vec4(c + glow * vec3(1.0, 0.85, 0.7), 1.0);
}`;

  const gl = canvasGL(1);
  if (gl) start(gl);

  function start(gl: WebGL2RenderingContext): void {
    const trace = glProgram(gl, TRACE_FS);
    const show = glProgram(gl, SHOW_FS);
    const ut = glUniforms(gl, trace);
    const us = glUniforms(gl, show);
    const phone = () => Math.min(view.w, view.h) < 600;

    let withDisk: Disk = "disk";
    let scaleIndex = 3;
    let target: Target | null = null;
    let slowTime = 0;
    let fastTime = 0;
    let dirty = true;
    let lastKey = "";

    const orbit = orbitControl({ yaw: 0.4, pitch: 0.12, spin: 0.045, minZoom: 0.55, maxZoom: 2.6 });

    function makeTarget(): void {
      const s = SCALES[scaleIndex]!;
      const w = Math.max(64, Math.round(view.w * s));
      const h = Math.max(64, Math.round(view.h * s));
      if (target && target.w === w && target.h === h) return;
      if (target) {
        gl.deleteTexture(target.tex);
        gl.deleteFramebuffer(target.fbo);
      }
      target = glTarget(gl, w, h, { type: "u8" });
      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      dirty = true;
    }

    /** Frame time watch: shrink the picture when frames are slow, grow it back when they are quick. */
    function adapt(frameSeconds: number): void {
      if (frameSeconds > SLOW_FRAME) {
        slowTime += frameSeconds;
        fastTime = 0;
      } else if (frameSeconds < SLOW_FRAME * 0.55) {
        fastTime += frameSeconds;
        slowTime = 0;
      }
      if (slowTime > 0.6 && scaleIndex > 0) {
        scaleIndex--;
        slowTime = 0;
        makeTarget();
      } else if (fastTime > 2 && scaleIndex < SCALES.length - 1) {
        scaleIndex++;
        fastTime = 0;
        makeTarget();
      }
    }

    function render(time: number): void {
      if (!target) return;
      // the camera starts a little further away and glides in during the first seconds
      const intro = 1 + 0.45 * Math.exp(-time / 2.5);
      const dist = (DISTANCE / orbit.zoom) * intro;
      const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
      const cam: [number, number, number] = [dist * cp * Math.sin(orbit.yaw), dist * sp, dist * cp * Math.cos(orbit.yaw)];
      const fwd = cam.map((c) => -c / dist) as [number, number, number];
      // right = fwd × up(0, 1, 0), up = right × fwd
      let right: [number, number, number] = [-fwd[2], 0, fwd[0]];
      const rl = Math.hypot(right[0], right[2]) || 1;
      right = [right[0] / rl, 0, right[2] / rl];
      const up: [number, number, number] = [
        right[1] * fwd[2] - right[2] * fwd[1],
        right[2] * fwd[0] - right[0] * fwd[2],
        right[0] * fwd[1] - right[1] * fwd[0],
      ];

      glBindTarget(gl, target);
      gl.useProgram(trace);
      gl.uniform2f(ut("u_res"), target.w, target.h);
      gl.uniform3f(ut("u_cam"), ...cam);
      gl.uniform3f(ut("u_right"), ...right);
      gl.uniform3f(ut("u_up"), ...up);
      gl.uniform3f(ut("u_fwd"), ...fwd);
      const tan = Math.tan(FOV / 2) * (view.w < view.h ? Math.min(1.45, view.h / view.w / 1.2) : 1);
      gl.uniform1f(ut("u_tan"), tan);
      gl.uniform1f(ut("u_time"), time);
      gl.uniform1f(ut("u_disk"), withDisk === "disk" ? 1 : 0);
      gl.uniform1i(ut("u_steps"), phone() ? 170 : 260);
      gl.uniform1f(ut("u_pix"), (2 * tan) / target.h);
      glDrawQuad(gl);

      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      glBindTarget(gl, null);
      gl.useProgram(show);
      glTexture(gl, 0, target.tex, us("u_tex"));
      glDrawQuad(gl);

      setReadout(view.w >= 700 ? `До дыры: ${Math.round(dist)} радиусов` : null);
    }

    let lastNow = performance.now();
    startLoop((dt, time) => {
      const now = performance.now();
      const frameSeconds = (now - lastNow) / 1000;
      lastNow = now;
      orbit.step(dt);
      // while paused, draw only when the camera has moved
      const key = `${orbit.yaw.toFixed(4)} ${orbit.pitch.toFixed(4)} ${orbit.zoom.toFixed(4)} ${withDisk}`;
      if (dt === 0 && !dirty && key === lastKey) return;
      lastKey = key;
      dirty = false;
      render(time);
      if (dt > 0) adapt(frameSeconds);
    });

    addChoice<Disk>(
      [
        { value: "disk", label: "🔥 С диском", title: "Вокруг дыры кружится раскалённый газ" },
        { value: "none", label: "✨ Без диска", title: "Только звёзды за дырой" },
      ],
      withDisk,
      (next) => {
        withDisk = next;
        dirty = true;
      },
    );

    onResize(() => {
      makeTarget();
      dirty = true;
    });
    makeTarget();
    showHint("Потяни пальцем — и облетишь дыру");
  }
}
