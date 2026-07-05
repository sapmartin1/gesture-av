// visuals.js — captivating audio-reactive background. Radial spectrum + waveform
// ribbon + note-triggered particle bursts, additive glow. Canvas 2D, 60fps.

export class Visualizer {
  constructor(canvas, synth) {
    this.c = canvas; this.g = canvas.getContext("2d");
    this.synth = synth;
    this.fft = new Uint8Array(synth.binCount);
    this.wav = new Uint8Array(synth.analyser.fftSize);
    this.particles = [];
    this.t = 0;
    this._resize(); window.addEventListener("resize", () => this._resize());
  }

  _resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.c.clientWidth; this.h = this.c.clientHeight;
    this.c.width = this.w * dpr; this.c.height = this.h * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  burst(x, y, hue, power) {
    const n = 10 + Math.floor(power * 26);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * (2 + power * 5);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 1, hue: hue + (Math.random() * 40 - 20), r: 2 + Math.random() * 3 });
    }
    if (this.particles.length > 1400) this.particles.splice(0, this.particles.length - 1400);
  }

  frame() {
    const g = this.g, w = this.w, h = this.h, cx = w / 2, cy = h / 2;
    this.t += 0.01;
    this.synth.fft(this.fft); this.synth.wave(this.wav);

    // fade-trail background (deep indigo)
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "rgba(8,10,20,0.28)";
    g.fillRect(0, 0, w, h);

    let energy = 0; for (let i = 0; i < 64; i++) energy += this.fft[i];
    energy /= 64 * 255;

    g.globalCompositeOperation = "lighter";

    // radial spectrum ring
    const bins = 128, baseR = Math.min(w, h) * 0.16;
    for (let i = 0; i < bins; i++) {
      const v = this.fft[Math.floor(i / bins * this.synth.binCount * 0.6)] / 255;
      const ang = (i / bins) * Math.PI * 2 + this.t * 0.2;
      const len = 8 + v * Math.min(w, h) * 0.28;
      const r0 = baseR + Math.sin(this.t + i * 0.2) * 6;
      const x0 = cx + Math.cos(ang) * r0, y0 = cy + Math.sin(ang) * r0;
      const x1 = cx + Math.cos(ang) * (r0 + len), y1 = cy + Math.sin(ang) * (r0 + len);
      const hue = 190 + i / bins * 140 + this.t * 20;
      g.strokeStyle = `hsla(${hue},90%,${45 + v * 35}%,${0.25 + v * 0.6})`;
      g.lineWidth = 2 + v * 3;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }

    // glowing core
    const cr = baseR * (0.55 + energy * 0.7);
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, cr);
    grd.addColorStop(0, `hsla(${200 + this.t * 30},100%,70%,${0.35 + energy * 0.5})`);
    grd.addColorStop(1, "hsla(280,100%,50%,0)");
    g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.fill();

    // waveform ribbon across the middle
    g.beginPath();
    const N = this.wav.length;
    for (let i = 0; i < N; i++) {
      const x = i / N * w;
      const y = cy + (this.wav[i] / 128 - 1) * h * 0.22;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = `hsla(${170 + energy * 60},100%,70%,${0.5 + energy * 0.4})`;
    g.lineWidth = 2; g.stroke();

    // particles
    const alive = [];
    for (const p of this.particles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.vx *= 0.99; p.life -= 0.016;
      if (p.life <= 0) continue;
      g.fillStyle = `hsla(${p.hue},95%,65%,${p.life})`;
      g.beginPath(); g.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); g.fill();
      alive.push(p);
    }
    this.particles = alive;

    g.globalCompositeOperation = "source-over";
    requestAnimationFrame(() => this.frame());
  }

  start() { this.frame(); }
}
