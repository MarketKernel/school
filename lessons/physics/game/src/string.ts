// «Поющая струна»: a plucked string and its harmonics.
// «Струна»: a string fixed at both ends is pulled into a triangle with its peak at a fraction p of the length and
// height A. Its exact motion is the sum of standing waves (the Fourier series of the triangle):
//   y(x, t) = Σ bₙ · sin(nπx/L) · cos(ωₙt) · e^(−γₙt),  bₙ = 2A·sin(nπp) / (n²π²·p(1 − p)),  ωₙ = n·ω₁,
// with higher harmonics dying out faster (γₙ grows as n²), so the sharp running kink slowly rounds off. The picture is
// slowed down a few hundred times; the sound is the same sum played at a real pitch (G3, the violin's lowest string):
// what reaches the ear is the force of the string on its support, ∝ ∂y/∂x at the end, so harmonic n sounds with n·bₙ.
// Plucked in the middle, the even harmonics vanish (sin(nπ/2) = 0) and the tone is soft; plucked near the end, many
// harmonics are strong and the tone is bright. The sound is synthesised into an AudioBuffer: each harmonic is a
// decaying phasor rotated sample by sample.
// «Петля»: the string-theory picture — a closed loop of string in space vibrating in modes n = 1…5 (cos nθ waves running
// around it, in and out of its plane); each mode has its own colour and its own note n·f₁. A metaphor, not a simulation.

namespace StringScene {
  type Mode = "string" | "loop";

  const HARMONICS = 48; // terms of the visible sum
  const SHOWN = 6; // harmonics drawn below the string
  const VIS_FREQ = 0.85; // visible fundamental, Hz (the picture is slowed down)
  const BASE_NOTE = 196; // G3, Hz
  const LOOP_NOTE = 130.81; // C3, Hz: loop mode n sounds at n·LOOP_NOTE
  const LOOP_POINTS = 260;
  const MODE_HUES = [0, 32, 130, 190, 280]; // colours of the loop modes 1…5
  const NOTE_NAMES = ["до", "до", "соль", "до", "ми"]; // the notes of n·C3
  const SHOWN_HUES = [8, 38, 95, 170, 215, 285];
  const BG = "#0d0b1e";

  const ctx = canvas2d();
  let mode: Mode = "string";

  // ---------- Layout ----------

  let x0 = 0, x1 = 1, stringY = 0, maxAmp = 50, rowsTop = 0, rowH = 30, labelW = 40;
  let loopCx = 0, loopCy = 0, loopScale = 100;

  function layout(): void {
    const area = freeArea();
    const margin = Math.max(28, area.w * 0.07);
    x0 = area.x + margin;
    x1 = area.x + area.w - margin;
    labelW = area.w < 500 ? 30 : 44;
    stringY = area.y + area.h * 0.22;
    maxAmp = Math.min(area.h * 0.16, (x1 - x0) * 0.25);
    rowsTop = area.y + area.h * 0.46;
    rowH = (area.y + area.h * 0.94 - rowsTop) / SHOWN;
    loopCx = area.x + area.w / 2;
    loopCy = area.y + area.h / 2;
    loopScale = Math.min(area.w, area.h) * 0.3;
    fresh = true;
  }

  // ---------- Sound ----------

  /** Plays a sum of decaying harmonics: amps[k] is the amplitude of harmonic k + 1 of f0, decay(n) its rate (1/s). */
  function play(amps: number[], f0: number, decay: (n: number) => number, seconds = 3, volume = 0.32): void {
    const ac = audioContext();
    if (!ac) return;
    const rate = ac.sampleRate;
    const length = Math.round(seconds * rate);
    const buffer = ac.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    amps.forEach((a, k) => {
      const n = k + 1;
      if (Math.abs(a) < 1e-4 || n * f0 > rate * 0.45) return;
      // a phasor (re, im) turned by the harmonic's angle and shrunk by its damping every sample
      const w = (TAU * n * f0) / rate;
      const shrink = Math.exp(-decay(n) / rate);
      const c = Math.cos(w) * shrink, s = Math.sin(w) * shrink;
      let re = a, im = 0;
      for (let i = 0; i < length; i++) {
        data[i]! += im;
        const r = re * c - im * s;
        im = re * s + im * c;
        re = r;
      }
    });
    let peak = 1e-6;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]!));
    const attack = Math.round(rate * 0.004);
    for (let i = 0; i < length; i++) {
      const fadeIn = i < attack ? i / attack : 1;
      const fadeOut = Math.min(1, (length - i) / (rate * 0.2));
      data[i] = (data[i]! / peak) * volume * fadeIn * fadeOut;
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(ac.destination);
    source.start();
  }

  // ---------- «Струна» ----------

  const coef = new Float64Array(HARMONICS + 1); // bₙ, in pixels
  let pluckAt = 0.25; // fraction of the length
  let pluckAmp = 0;
  let held = false;
  let since = 0; // seconds since the release
  let autoTimer = 0;
  let touched = false;
  let fresh = true;

  const visDecay = (n: number) => 0.16 + 0.0035 * n * n;
  const soundDecay = (n: number) => 0.45 + 0.012 * n * n;

  function setPluck(p: number, amp: number): void {
    pluckAt = clamp(p, 0.03, 0.97);
    pluckAmp = amp;
    for (let n = 1; n <= HARMONICS; n++) {
      coef[n] = (2 * amp * Math.sin(n * Math.PI * pluckAt)) / (n * n * Math.PI * Math.PI * pluckAt * (1 - pluckAt));
    }
  }

  /** Amplitude of harmonic n right now (with its oscillation and damping). */
  function harmonicNow(n: number): number {
    if (held) return coef[n]!;
    return coef[n]! * Math.cos(TAU * VIS_FREQ * n * since) * Math.exp(-visDecay(n) * since);
  }

  function release(sound: boolean): void {
    held = false;
    since = 0;
    if (sound) {
      // force on the support: harmonic n sounds with n·bₙ (a slight roll-off keeps the top from buzzing)
      const amps: number[] = [];
      for (let n = 1; n <= 40; n++) amps.push((n * coef[n]!) / maxAmp / (1 + n / 30));
      play(amps, BASE_NOTE, soundDecay, 3.2, 0.12 + 0.25 * Math.min(1, Math.abs(pluckAmp) / maxAmp));
    }
  }

  function strokeGlow(path: Path2D, hue: number, sat: number, width: number, light = 70): void {
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = hsl(hue, sat, light - 10, 0.12);
    ctx.lineWidth = width * 5;
    ctx.stroke(path);
    ctx.strokeStyle = hsl(hue, sat, light, 0.35);
    ctx.lineWidth = width * 2.2;
    ctx.stroke(path);
    ctx.strokeStyle = hsl(hue, sat, Math.min(96, light + 22), 0.95);
    ctx.lineWidth = width;
    ctx.stroke(path);
    ctx.globalCompositeOperation = "source-over";
  }

  function peg(x: number, y: number, r: number): void {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
    g.addColorStop(0, "rgba(255, 230, 190, 0.95)");
    g.addColorStop(0.4, "rgba(255, 184, 107, 0.5)");
    g.addColorStop(1, "rgba(255, 184, 107, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.5, 0, TAU);
    ctx.fill();
  }

  function drawString(dt: number): void {
    // a soft veil leaves a short glowing blur behind the moving string; paused frames start clean
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = fresh || dt === 0 ? BG : "rgba(13, 11, 30, 0.42)";
    ctx.fillRect(0, 0, view.w, view.h);
    fresh = false;
    const len = x1 - x0;
    const pts = Math.max(120, Math.round(len / 3));

    // the main string: a triangle while held, the sum of the harmonics after the release
    const amps: number[] = [];
    for (let n = 1; n <= HARMONICS; n++) amps.push(harmonicNow(n));
    const path = new Path2D();
    if (held) {
      path.moveTo(x0, stringY);
      path.lineTo(x0 + pluckAt * len, stringY + pluckAmp);
      path.lineTo(x1, stringY);
    } else {
      for (let i = 0; i <= pts; i++) {
        const u = i / pts;
        let y = 0;
        for (let n = 1; n <= HARMONICS; n++) y += amps[n - 1]! * Math.sin(n * Math.PI * u);
        if (i === 0) path.moveTo(x0, stringY + y);
        else path.lineTo(x0 + u * len, stringY + y);
      }
    }
    strokeGlow(path, 38, 100, 3.2, 72);
    peg(x0, stringY, 7);
    peg(x1, stringY, 7);
    if (held) {
      ctx.fillStyle = "rgba(255, 248, 236, 0.9)";
      ctx.beginPath();
      ctx.arc(x0 + pluckAt * len, stringY + pluckAmp, 9, 0, TAU);
      ctx.fill();
    }

    // the first harmonics, each a little string of its own with its real amplitude
    const rx0 = x0 + labelW, rlen = x1 - rx0;
    // the strongest harmonic of this pluck fills its row; the others keep their true size next to it
    let strongest = 1e-6;
    for (let n = 1; n <= SHOWN; n++) strongest = Math.max(strongest, Math.abs(coef[n]!));
    const k = (rowH * 0.42) / strongest;
    ctx.font = `900 ${Math.round(Math.min(20, rowH * 0.5))}px Nunito, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let n = 1; n <= SHOWN; n++) {
      const y0 = rowsTop + rowH * (n - 0.5);
      const hue = SHOWN_HUES[n - 1]!;
      const a = amps[n - 1]! * k;
      // how strong this harmonic is in the pluck: the label glows with it
      const strength = Math.min(1, Math.abs(coef[n]!) / (maxAmp * 0.5));
      ctx.fillStyle = hsl(hue, 95, 66 + strength * 20, 0.5 + strength * 0.5);
      ctx.fillText(String(n), x0 - 4, y0);
      ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
      ctx.fillRect(rx0, y0 - 0.5, rlen, 1);
      const p = new Path2D();
      const steps = 24 + n * 10;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const y = y0 + a * Math.sin(n * Math.PI * u);
        if (i === 0) p.moveTo(rx0, y);
        else p.lineTo(rx0 + u * rlen, y);
      }
      strokeGlow(p, hue, 95, 1.8, 62);
      // the nodes: points of this harmonic that never move
      ctx.fillStyle = hsl(hue, 90, 85, 0.85);
      for (let j = 0; j <= n; j++) {
        ctx.beginPath();
        ctx.arc(rx0 + (j / n) * rlen, y0, 2.4, 0, TAU);
        ctx.fill();
      }
    }
    setReadout(view.w >= 700 ? `Щипок: ${Math.round(pluckAt * 100)} % длины` : null);
  }

  // ---------- «Петля» ----------

  const loopOn = [false, false, true, false, false];
  const loopAmp = new Float32Array(5); // current amplitude of every mode
  const loopPhase = [0.3, 1.7, 0.9, 2.4, 4.1];
  let loopYaw = 0.4;
  let loopPitch = 0.55;
  let loopTime = 0;
  const modeButtons: HTMLButtonElement[] = [];
  const LOOP_REST = 0.14; // amplitude a mode keeps humming at
  const LOOP_KICK = 0.26; // amplitude after a tap

  function playModes(only: number | null = null): void {
    const notes: number[] = [];
    for (let i = 0; i < 5; i++) if (loopOn[i] && (only === null || only === i)) notes.push(i + 1);
    if (!notes.length) return;
    // a soft bell for each note: its own fundamental and a few overtones
    const amps: number[] = new Array(16).fill(0);
    for (const n of notes) {
      amps[n - 1]! += 1;
      if (2 * n <= 16) amps[2 * n - 1]! += 0.25;
      if (3 * n <= 16) amps[3 * n - 1]! += 0.08;
    }
    play(amps, LOOP_NOTE, (n) => 0.7 + 0.05 * n, 3, 0.28);
  }

  /** The notes of the active modes, written under the loop. */
  function drawNotes(): void {
    const notes = loopOn.map((on, i) => (on ? NOTE_NAMES[i]! : "")).filter(Boolean);
    const size = Math.round(clamp(loopScale * 0.17, 18, 28));
    ctx.font = `900 ${size}px Nunito, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const y = loopCy + loopScale * 1.45;
    if (!notes.length) {
      ctx.fillStyle = "rgba(201, 192, 230, 0.6)";
      ctx.fillText("тишина — включи колебание", loopCx, y);
      return;
    }
    // each note in the colour of its mode
    const parts = loopOn.flatMap((on, i) => (on ? [{ text: NOTE_NAMES[i]!, hue: MODE_HUES[i]! }] : []));
    const gap = size * 0.9;
    const widths = parts.map((p) => ctx.measureText(p.text).width);
    let x = loopCx - (widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1)) / 2;
    ctx.textAlign = "left";
    parts.forEach((p, i) => {
      ctx.fillStyle = hsl(p.hue, 95, 70);
      ctx.fillText(p.text, x, y);
      x += widths[i]! + gap;
    });
  }

  const sky = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() ** 3 * 1.3 + 0.3, a: rand(0.2, 0.7) }));

  function drawLoop(dt: number): void {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = fresh || dt === 0 ? BG : "rgba(13, 11, 30, 0.5)";
    ctx.fillRect(0, 0, view.w, view.h);
    fresh = false;
    ctx.fillStyle = "#e6defa";
    for (const st of sky) {
      ctx.globalAlpha = st.a;
      ctx.fillRect(st.x * view.w, st.y * view.h, st.r, st.r);
    }
    ctx.globalAlpha = 1;
    loopTime += dt;
    if (dt > 0) {
      loopYaw += dt * 0.18;
      for (let i = 0; i < 5; i++) {
        const goal = loopOn[i] ? LOOP_REST : 0;
        loopAmp[i] = goal + (loopAmp[i]! - goal) * Math.exp(-dt * (loopOn[i] ? 0.6 : 2.5));
      }
    }
    const pitch = loopPitch + 0.12 * Math.sin(loopTime * 0.4);

    // a halo in the mode colours behind the loop
    let tr = 0, tg = 0, tb = 0, total = 0;
    const rgb = MODE_HUES.map((h) => hslToRgb(h, 0.95, 0.6));
    for (let i = 0; i < 5; i++) {
      const a = loopAmp[i]!;
      tr += rgb[i]![0] * a;
      tg += rgb[i]![1] * a;
      tb += rgb[i]![2] * a;
      total += a;
    }
    if (total > 1e-3) {
      const halo = ctx.createRadialGradient(loopCx, loopCy, 0, loopCx, loopCy, loopScale * 1.9);
      const c = (k: number) => Math.round(Math.min(255, k / total));
      halo.addColorStop(0, `rgba(${c(tr)}, ${c(tg)}, ${c(tb)}, ${Math.min(0.22, total * 0.9)})`);
      halo.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, view.w, view.h);
    }

    // the loop: points around a circle pushed in and out of their place by every active mode
    const cyw = Math.cos(loopYaw), syw = Math.sin(loopYaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const sx = new Float32Array(LOOP_POINTS + 1);
    const sy = new Float32Array(LOOP_POINTS + 1);
    const depth = new Float32Array(LOOP_POINTS + 1);
    const cr = new Float32Array(LOOP_POINTS + 1), cg = new Float32Array(LOOP_POINTS + 1), cb = new Float32Array(LOOP_POINTS + 1);
    for (let j = 0; j <= LOOP_POINTS; j++) {
      const th = (j / LOOP_POINTS) * TAU;
      let dr = 0, dy = 0, r = 0, g = 0, b = 0, w = 1e-4;
      for (let i = 0; i < 5; i++) {
        const a = loopAmp[i]!;
        if (a < 1e-4) continue;
        const n = i + 1;
        const wt = TAU * 0.55 * n * loopTime;
        const radial = a * Math.cos(n * th + loopPhase[i]!) * Math.cos(wt);
        const vertical = a * Math.sin(n * th + loopPhase[i]!) * Math.sin(wt + 0.6);
        dr += radial;
        dy += vertical;
        // a point takes the colour of the mode that moves it the most (a steep weight keeps the colours pure)
        const k = (a * (0.3 + 4 * (Math.abs(radial) + Math.abs(vertical)))) ** 3 * 50;
        r += rgb[i]![0] * k;
        g += rgb[i]![1] * k;
        b += rgb[i]![2] * k;
        w += k;
      }
      const R = 1 + dr;
      const x = R * Math.cos(th), z = R * Math.sin(th), y = dy;
      // turn: yaw around the vertical, then tilt by the pitch
      const x1r = cyw * x + syw * z, z1 = -syw * x + cyw * z;
      const y2 = cp * y - sp * z1, z2 = sp * y + cp * z1;
      const persp = 3.2 / (3.2 - z2);
      sx[j] = loopCx + x1r * loopScale * persp;
      sy[j] = loopCy - y2 * loopScale * persp;
      depth[j] = z2;
      cr[j] = (r + 240e-4) / w;
      cg[j] = (g + 230e-4) / w;
      cb[j] = (b + 255e-4) / w;
    }
    ctx.globalCompositeOperation = "lighter";
    // butt caps: round ones would overlap at every joint and add up into bright beads
    ctx.lineCap = "butt";
    for (const [width, alpha, white] of [[16, 0.07, 0], [7, 0.22, 0], [2.6, 0.9, 0.4]] as const) {
      for (let j = 0; j < LOOP_POINTS; j++) {
        const near = 0.45 + 0.55 * clamp((depth[j]! + 1.3) / 2.6, 0, 1);
        const mix = (c: number) => Math.round(c + (255 - c) * white);
        ctx.strokeStyle = `rgba(${mix(cr[j]!)}, ${mix(cg[j]!)}, ${mix(cb[j]!)}, ${alpha * near})`;
        ctx.lineWidth = width * (0.7 + 0.5 * near);
        ctx.beginPath();
        ctx.moveTo(sx[j]!, sy[j]!);
        ctx.lineTo(sx[j + 1]!, sy[j + 1]!);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = "source-over";
    drawNotes();
  }

  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  // ---------- Input ----------

  let pressMoved = 0;
  onPointer({
    down(p) {
      pressMoved = 0;
      if (mode === "string") {
        if (p.y > rowsTop - rowH * 0.3) return;
        touched = true;
        held = true;
        setPluck((p.x - x0) / (x1 - x0), clamp(p.y - stringY, -maxAmp, maxAmp));
      }
    },
    move(p) {
      if (!p.down) return;
      pressMoved += Math.abs(p.dx) + Math.abs(p.dy);
      if (mode === "string") {
        if (held) setPluck((p.x - x0) / (x1 - x0), clamp(p.y - stringY, -maxAmp, maxAmp));
      } else {
        loopYaw += p.dx * 0.008;
        loopPitch = clamp(loopPitch + p.dy * 0.008, -1.3, 1.3);
      }
    },
    up() {
      if (mode === "string") {
        if (held) release(true);
      } else if (pressMoved < 10) {
        // a tap plucks the loop: every active mode rings louder
        for (let i = 0; i < 5; i++) if (loopOn[i]) loopAmp[i] = LOOP_KICK;
        playModes();
      }
    },
  });

  // ---------- Loop and controls ----------

  startLoop((dt) => {
    if (mode === "string") {
      if (!held) since += dt;
      // until the first touch the string plucks itself now and then (silently: sound needs a tap first)
      if (!touched && dt > 0) {
        autoTimer -= dt;
        if (autoTimer <= 0) {
          autoTimer = 5;
          setPluck(rand(0.15, 0.45), maxAmp * rand(0.65, 0.9) * (Math.random() < 0.5 ? -1 : 1));
          release(false);
        }
      }
      drawString(dt);
    } else {
      drawLoop(dt);
    }
  });

  function setMode(next: Mode): void {
    mode = next;
    fresh = true;
    for (const b of modeButtons) b.hidden = mode !== "loop";
    if (mode === "loop") setReadout(null);
    placeHint();
    layout();
    if (mode === "loop") {
      for (let i = 0; i < 5; i++) if (loopOn[i] && loopAmp[i]! < LOOP_REST) loopAmp[i] = LOOP_KICK;
      showHint("Включай колебания 1–5, нажми на петлю — она зазвучит");
    } else {
      showHint("Оттяни струну пальцем и отпусти");
    }
  }

  addChoice<Mode>(
    [
      { value: "string", label: "🎻 Струна", title: "Струна, закреплённая с двух концов" },
      { value: "loop", label: "⭕ Петля", title: "Замкнутая струна, как в теории струн" },
    ],
    mode,
    setMode,
  );
  for (let i = 0; i < 5; i++) {
    const b = addButton(String(i + 1), () => {
      loopOn[i] = !loopOn[i];
      b.classList.toggle("on", loopOn[i]);
      if (loopOn[i]) {
        loopAmp[i] = LOOP_KICK;
        playModes(i);
      }
    }, { round: true, title: `Колебание номер ${i + 1}: ${i + 1} волн${i === 0 ? "а" : i < 4 ? "ы" : ""} вдоль петли` });
    b.style.borderColor = hsl(MODE_HUES[i]!, 90, 60);
    b.classList.toggle("on", loopOn[i]!);
    b.hidden = true;
    modeButtons.push(b);
  }

  onResize(layout);
  layout();
  setPluck(0.22, -maxAmp * 0.85);
  release(false);
  autoTimer = 5;
  showHint("Оттяни струну пальцем и отпусти");
}
