// «Скрытые измерения»: a cross-section of a Calabi–Yau manifold, the shape string theory uses for its curled-up extra
// dimensions. This is mathematics, not a simulation: the classic picture of A. J. Hanson (1994) of the complex curve
//   z₁ⁿ + z₂ⁿ = 1  in C² (four real dimensions),
// projected to 3D. With z = x + iy, x ∈ [−a, a], y ∈ [0, π/2], every pair k₁, k₂ ∈ {0 … n−1} gives one patch:
//   z₁ = e^(2πik₁/n) · cosh(z)^(2/n),  z₂ = e^(2πik₂/n) · (−i·sinh z)^(2/n),
// since cosh² − sinh² = 1 makes z₁ⁿ + z₂ⁿ = 1. The n² patches meet along their edges into one surface. A point is
// drawn at (Re z₁, Re z₂, cos α · Im z₁ + sin α · Im z₂): turning the angle α turns the surface in the hidden fourth
// direction, so it morphs. The mesh is rebuilt on the CPU every frame (normals from neighbouring grid points) and drawn
// with WebGL 2 and a depth test: rainbow colour per patch, soft light, a gloss highlight, a rim glow and a parameter grid.

namespace CalabiYau {
  const A = 1.0; // the x range of a patch
  const DIST = 4.2; // camera distance at zoom 1
  const NEAR = 0.5;
  const FAR = 12;
  const MORPH = 0.22; // rad/s of the α wobble

  const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_center;   // in uv
uniform float u_aspect;
void main() {
  vec2 d = (v_uv - u_center) * vec2(u_aspect, 1.0);
  float r = length(d);
  vec3 col = mix(vec3(0.13, 0.09, 0.26), vec3(0.035, 0.03, 0.08), smoothstep(0.0, 0.95, r));
  // a few faint dust specks
  vec2 cell = floor(gl_FragCoord.xy / 2.0);
  float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  col += step(0.9985, h) * (h - 0.9985) * 400.0 * vec3(0.8, 0.75, 1.0);
  outColor = vec4(col, 1.0);
}`;

  const MESH_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec3 a_info; // u, v of the patch grid and the patch hue
uniform mat3 u_rot;
uniform float u_dist, u_scale;
uniform vec2 u_center, u_view;  // centre of the free area and the canvas size, CSS pixels
out vec3 v_normal;
out vec3 v_info;
out float v_depth;
void main() {
  vec3 q = u_rot * a_pos;
  float d = u_dist - q.z;
  vec2 px = u_center + vec2(q.x, -q.y) * u_scale / d;
  gl_Position = vec4((px.x / u_view.x * 2.0 - 1.0) * d, (1.0 - px.y / u_view.y * 2.0) * d,
                     ((d - ${NEAR.toFixed(1)}) / ${(FAR - NEAR).toFixed(1)} * 2.0 - 1.0) * d, d);
  v_normal = u_rot * a_normal;
  v_info = a_info;
  v_depth = q.z;
}`;

  const MESH_FS = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_info;
in float v_depth;
out vec4 outColor;
uniform float u_grid;
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
void main() {
  vec3 n = normalize(v_normal);
  if (n.z < 0.0) n = -n; // light both sides: always the side facing the viewer
  vec3 base = hsv(v_info.z + 0.08 * v_info.x, 0.7, 1.0);
  vec3 l1 = normalize(vec3(-0.45, 0.65, 0.6));
  vec3 l2 = normalize(vec3(0.7, -0.35, 0.4));
  float diff = 0.22 + 0.7 * max(dot(n, l1), 0.0) + 0.25 * max(dot(n, l2), 0.0);
  float spec = pow(max(dot(n, normalize(l1 + vec3(0.0, 0.0, 1.0))), 0.0), 36.0);
  float rim = pow(1.0 - n.z, 3.0);
  vec3 col = base * diff + vec3(1.0) * spec * 0.55 + base * rim * 0.6;
  // thin lines along the parameter grid
  vec2 g = v_info.xy * vec2(8.0, 6.0);
  vec2 w = fwidth(g);
  vec2 f = abs(fract(g - 0.5) - 0.5) / max(w, 1e-4);
  float line = 1.0 - clamp(min(f.x, f.y) - 0.3, 0.0, 1.0);
  col = mix(col, col * 0.45 + base * 0.15, line * 0.55 * u_grid);
  // the far side fades a little into the night
  col *= 0.72 + 0.28 * smoothstep(-1.6, 1.2, v_depth);
  outColor = vec4(pow(col, vec3(0.92)), 1.0);
}`;

  const gl = canvasGL(2, { antialias: true });
  if (gl) start(gl);

  function start(gl: WebGL2RenderingContext): void {
    const bg = glProgram(gl, BG_FS);
    const mesh = glProgram(gl, MESH_FS, MESH_VS);
    const ub = glUniforms(gl, bg);
    const um = glUniforms(gl, mesh);

    let n = 5;
    let grid = true;
    let res = 16; // quads along one side of a patch
    let vertexCount = 0;
    let indexCount = 0;
    let data = new Float32Array(0);
    let alpha = Math.PI / 4;
    let reach = 1.5; // the biggest distance from the middle, for fitting
    let dirty = true;

    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    const ibo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.bindVertexArray(null);

    /** Allocates the buffers for the current n: (res + 1)² vertices and res² quads per patch. */
    function allocate(): void {
      res = Math.round(clamp(84 / n, 14, 30));
      const side = res + 1;
      const patches = n * n;
      vertexCount = patches * side * side;
      data = new Float32Array(vertexCount * 9);
      const index = new Uint32Array(patches * res * res * 6);
      let k = 0;
      for (let p = 0; p < patches; p++) {
        const o = p * side * side;
        for (let i = 0; i < res; i++) {
          for (let j = 0; j < res; j++) {
            const a = o + i * side + j, b = a + 1, c = a + side, d = c + 1;
            index.set([a, c, b, b, c, d], k);
            k += 6;
          }
        }
      }
      indexCount = k;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      reach = 0;
      build();
    }

    /** w^(2/n) for w = (re, im) with the principal argument; the patch domain keeps Re w ≥ 0, so it is continuous. */
    function root(re: number, im: number, out: number[]): void {
      const m = Math.pow(Math.hypot(re, im), 2 / n);
      const arg = (Math.atan2(im, re) * 2) / n;
      out[0] = m * Math.cos(arg);
      out[1] = m * Math.sin(arg);
    }

    const w1 = [0, 0], w2 = [0, 0];

    /** Positions of every patch for the current α, then normals from neighbouring grid points. */
    function build(): void {
      const side = res + 1;
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      let big = 0;
      for (let k1 = 0; k1 < n; k1++) {
        for (let k2 = 0; k2 < n; k2++) {
          const p = k1 * n + k2;
          const o = p * side * side;
          const t1 = (TAU * k1) / n, t2 = (TAU * k2) / n;
          const c1 = Math.cos(t1), s1 = Math.sin(t1), c2 = Math.cos(t2), s2 = Math.sin(t2);
          const hue = (k1 + k2 / n) / n;
          for (let i = 0; i < side; i++) {
            const x = -A + (2 * A * i) / res;
            const chx = Math.cosh(x), shx = Math.sinh(x);
            for (let j = 0; j < side; j++) {
              const y = ((Math.PI / 2) * j) / res;
              const cy = Math.cos(y), sy = Math.sin(y);
              // cosh(x + iy) and −i·sinh(x + iy)
              root(chx * cy, shx * sy, w1);
              root(chx * sy, -shx * cy, w2);
              const z1r = c1 * w1[0]! - s1 * w1[1]!, z1i = s1 * w1[0]! + c1 * w1[1]!;
              const z2r = c2 * w2[0]! - s2 * w2[1]!, z2i = s2 * w2[0]! + c2 * w2[1]!;
              const v = (o + i * side + j) * 9;
              data[v] = z1r;
              data[v + 1] = z2r;
              data[v + 2] = ca * z1i + sa * z2i;
              data[v + 6] = i / res;
              data[v + 7] = j / res;
              data[v + 8] = hue;
              big = Math.max(big, Math.hypot(z1r, z2r, data[v + 2]!));
            }
          }
          // normals: cross product of the grid directions (one-sided at the patch edges)
          for (let i = 0; i < side; i++) {
            for (let j = 0; j < side; j++) {
              const at = (a: number, b: number) => (o + a * side + b) * 9;
              const ia = at(Math.max(0, i - 1), j), ib = at(Math.min(res, i + 1), j);
              const ja = at(i, Math.max(0, j - 1)), jb = at(i, Math.min(res, j + 1));
              const ux = data[ib]! - data[ia]!, uy = data[ib + 1]! - data[ia + 1]!, uz = data[ib + 2]! - data[ia + 2]!;
              const vx = data[jb]! - data[ja]!, vy = data[jb + 1]! - data[ja + 1]!, vz = data[jb + 2]! - data[ja + 2]!;
              let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
              const len = Math.hypot(nx, ny, nz) || 1;
              nx /= len;
              ny /= len;
              nz /= len;
              const v = at(i, j);
              data[v + 3] = nx;
              data[v + 4] = ny;
              data[v + 5] = nz;
            }
          }
        }
      }
      // fit to the largest size seen for this n, so the morph doesn't make the picture breathe
      reach = Math.max(reach, big);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    }

    const orbit = orbitControl({ yaw: 0.5, pitch: 0.45, spin: 0.16, minZoom: 0.6, maxZoom: 2.5 });

    function draw(): void {
      const area = freeArea();
      const center: [number, number] = [area.x + area.w / 2, area.y + area.h / 2];
      glBindTarget(gl, null);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(bg);
      gl.uniform2f(ub("u_center"), center[0] / view.w, 1 - center[1] / view.h);
      gl.uniform1f(ub("u_aspect"), view.w / view.h);
      glDrawQuad(gl);

      gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(mesh);
      const cy = Math.cos(orbit.yaw), sy = Math.sin(orbit.yaw), cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
      // the same turn as Orbit.rotate, as a column-major matrix
      gl.uniformMatrix3fv(um("u_rot"), false, [cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy]);
      const dist = DIST / orbit.zoom;
      // the reach of the shape fills about 46 % of the smaller side of the free area at zoom 1
      const scale = (Math.min(area.w, area.h) * 0.46 * DIST) / Math.max(reach, 0.5) / 1.12;
      gl.uniform1f(um("u_dist"), dist);
      gl.uniform1f(um("u_scale"), scale);
      gl.uniform2f(um("u_center"), center[0], center[1]);
      gl.uniform2f(um("u_view"), view.w, view.h);
      gl.uniform1f(um("u_grid"), grid ? 1 : 0);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }

    let lastKey = "";
    startLoop((dt, time) => {
      orbit.step(dt);
      if (dt > 0) {
        alpha = Math.PI / 4 + 0.85 * Math.sin(time * MORPH) + 0.25 * Math.sin(time * MORPH * 2.3);
        build();
      }
      const key = `${orbit.yaw} ${orbit.pitch} ${orbit.zoom}`;
      if (dt === 0 && !dirty && key === lastKey) return;
      lastKey = key;
      dirty = false;
      draw();
    });

    addSlider({
      label: "Степень n",
      min: 2,
      max: 6,
      step: 1,
      value: n,
      format: (v) => String(v),
      title: "Сколько лепестков у фигуры: из n × n кусочков",
      onInput: (v) => {
        if (v === n) return;
        n = v;
        allocate();
        dirty = true;
      },
    });
    const gridButton = addButton("🕸️ Сетка", () => {
      grid = !grid;
      gridButton.classList.toggle("on", grid);
      dirty = true;
    }, { title: "Показать или спрятать линии сетки" });
    gridButton.classList.add("on");

    onResize(() => (dirty = true));
    allocate();
    showHint("Покрути фигуру пальцем, подвигай ползунок");
  }
}
