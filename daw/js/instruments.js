// instruments.js — the studio's instruments: polyphonic Synth (5 presets),
// synthesized DrumKit (no samples needed), and a Sampler for your own sounds
// (one-shot or pitched across the keys).

export const SYNTH_PRESETS = {
  "Warm Keys":  { oscs: [["sawtooth", 0], ["triangle", -7]], a: 0.005, d: 0.25, s: 0.55, r: 0.5,  gain: 0.5 },
  "Analog Pad": { oscs: [["sawtooth", -5], ["sawtooth", 7]], a: 0.5,   d: 0.8,  s: 0.8,  r: 1.4,  gain: 0.42 },
  "Deep Bass":  { oscs: [["square", 0], ["sine", -12]],      a: 0.004, d: 0.2,  s: 0.6,  r: 0.22, gain: 0.6 },
  "Pluck":      { oscs: [["triangle", 0], ["sawtooth", 12]], a: 0.002, d: 0.18, s: 0.0,  r: 0.2,  gain: 0.5 },
  "Lead":       { oscs: [["sawtooth", 0], ["square", 7]],    a: 0.006, d: 0.3,  s: 0.7,  r: 0.4,  gain: 0.5 },
};

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class SynthInst {
  constructor(engine, chain, presetName = "Warm Keys") {
    this.engine = engine; this.chain = chain;
    this.preset = SYNTH_PRESETS[presetName]; this.presetName = presetName;
    this.voices = new Map();
  }

  setPreset(name) { this.preset = SYNTH_PRESETS[name] || this.preset; this.presetName = name; }

  /** when: absolute ctx time (0/undefined = now). dur: seconds (scheduled clips). */
  noteOn(note, vel = 100, when = 0, dur = null) {
    const ctx = this.engine.ctx, t = when || ctx.currentTime, p = this.preset;
    const v = vel / 127;
    const vca = ctx.createGain(); vca.gain.value = 0;
    const oscs = p.oscs.map(([type, det]) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = mtof(note); o.detune.value = det * 100;
      o.connect(vca); o.start(t); return o;
    });
    vca.connect(this.chain.input);
    const peak = (0.22 + v * 0.45) * p.gain * 2;
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(peak, t + p.a);
    vca.gain.linearRampToValueAtTime(peak * p.s + 0.0001, t + p.a + p.d);
    const voice = { oscs, vca };
    if (dur != null) {
      const off = t + Math.max(dur, p.a + 0.02);
      vca.gain.setValueAtTime(peak * p.s + 0.0001, off);
      vca.gain.linearRampToValueAtTime(0.0001, off + p.r);
      oscs.forEach((o) => o.stop(off + p.r + 0.05));
    } else {
      this.voices.set(note, voice);
    }
  }

  noteOff(note) {
    const voice = this.voices.get(note);
    if (!voice) return;
    const t = this.engine.ctx.currentTime, r = this.preset.r;
    voice.vca.gain.cancelScheduledValues(t);
    voice.vca.gain.setValueAtTime(voice.vca.gain.value, t);
    voice.vca.gain.linearRampToValueAtTime(0.0001, t + r);
    voice.oscs.forEach((o) => o.stop(t + r + 0.05));
    this.voices.delete(note);
  }

  allOff() { [...this.voices.keys()].forEach((n) => this.noteOff(n)); }
}

// ---- synthesized drum kit -----------------------------------------------------
export const DRUM_LANES = ["kick", "snare", "clap", "hat", "open hat", "tom"];

export class DrumKit {
  constructor(engine, chain) { this.engine = engine; this.chain = chain; }

  _noise(t, dur) {
    const ctx = this.engine.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.start(t);
    return src;
  }

  trigger(lane, vel = 110, when = 0) {
    const ctx = this.engine.ctx, t = when || ctx.currentTime, v = vel / 127;
    const out = this.chain.input;
    const g = ctx.createGain(); g.connect(out);
    if (lane === "kick") {
      const o = ctx.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      o.connect(g); o.start(t); o.stop(t + 0.35);
      g.gain.setValueAtTime(1.1 * v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    } else if (lane === "snare") {
      const n = this._noise(t, 0.25);
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1800;
      n.connect(bp); bp.connect(g);
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = 190;
      const og = ctx.createGain(); og.gain.setValueAtTime(0.5 * v, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.1);
      g.gain.setValueAtTime(0.8 * v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    } else if (lane === "clap") {
      for (const dt of [0, 0.012, 0.026]) {
        const n = this._noise(t + dt, 0.12);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
        bp.frequency.value = 1400; bp.Q.value = 1.4;
        const cg = ctx.createGain(); cg.gain.setValueAtTime(0.55 * v, t + dt);
        cg.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.1);
        n.connect(bp); bp.connect(cg); cg.connect(out);
      }
      g.gain.value = 0;
    } else if (lane === "hat" || lane === "open hat") {
      const open = lane === "open hat";
      const n = this._noise(t, open ? 0.4 : 0.06);
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7500;
      n.connect(hp); hp.connect(g);
      g.gain.setValueAtTime(0.45 * v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.35 : 0.05));
    } else if (lane === "tom") {
      const o = ctx.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.18);
      o.connect(g); o.start(t); o.stop(t + 0.3);
      g.gain.setValueAtTime(0.9 * v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    }
  }
}

// ---- sampler: drop your own sound ----------------------------------------------
export class Sampler {
  constructor(engine, chain) {
    this.engine = engine; this.chain = chain;
    this.buffer = null; this.name = "no sample";
    this.mode = "pitched";                 // "pitched" | "oneshot"
    this.live = new Map();
  }

  async load(file) {
    const arr = await file.arrayBuffer();
    this.buffer = await this.engine.ctx.decodeAudioData(arr);
    this.name = file.name.replace(/\.[^.]+$/, "");
  }

  noteOn(note, vel = 100, when = 0) {
    if (!this.buffer) return;
    const ctx = this.engine.ctx, t = when || ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.buffer;
    if (this.mode === "pitched") src.playbackRate.value = Math.pow(2, (note - 60) / 12);
    const g = ctx.createGain(); g.gain.value = (vel / 127) * 0.9;
    src.connect(g); g.connect(this.chain.input);
    src.start(t);
    this.live.set(note, { src, g });
    src.onended = () => this.live.delete(note);
  }

  noteOff(note) {
    const p = this.live.get(note);
    if (!p) return;
    const t = this.engine.ctx.currentTime;
    p.g.gain.setTargetAtTime(0, t, 0.05);
    try { p.src.stop(t + 0.25); } catch (e) {}
    this.live.delete(note);
  }

  allOff() { [...this.live.keys()].forEach((n) => this.noteOff(n)); }
}
