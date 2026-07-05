// synth.js — a small polyphonic Web Audio synth with FX, presets, and an
// analyser tap for the visualizer. No dependencies.

export const PRESETS = {
  "Warm Keys":  { oscs:[["sawtooth",0],["triangle",-7]], cutoff:2200, res:6,  a:0.005,d:0.25,s:0.55,r:0.5,  rev:0.28, dly:0.12, gain:0.5 },
  "Analog Pad": { oscs:[["sawtooth",-5],["sawtooth",7]], cutoff:1200, res:4,  a:0.6,  d:0.8, s:0.8, r:1.6,  rev:0.55, dly:0.22, gain:0.42 },
  "Deep Bass":  { oscs:[["square",0],["sine",-12]],       cutoff:700,  res:9,  a:0.004,d:0.2, s:0.6, r:0.22, rev:0.05, dly:0.0,  gain:0.6 },
  "Pluck":      { oscs:[["triangle",0],["sawtooth",12]],  cutoff:3200, res:5,  a:0.002,d:0.18,s:0.0, r:0.2,  rev:0.35, dly:0.28, gain:0.5 },
  "Lead":       { oscs:[["sawtooth",0],["square",7]],     cutoff:2800, res:11, a:0.006,d:0.3, s:0.7, r:0.4,  rev:0.2,  dly:0.18, gain:0.5 },
};

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Synth {
  constructor() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.voices = new Map();           // midi note -> voice
    this.preset = PRESETS["Warm Keys"];
    this.modCutoff = 0;                // CC1 adds here
    this.bright = 0;                   // CC74

    // master chain: bus -> filterTrim -> comp -> master -> analyser -> out
    this.bus = ctx.createGain(); this.bus.gain.value = 1;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 3;
    this.master = ctx.createGain(); this.master.gain.value = this.preset.gain;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.8;

    // FX sends
    this.delay = ctx.createDelay(1.0); this.delay.delayTime.value = 0.34;
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.34;
    this.delaySend = ctx.createGain(); this.delaySend.gain.value = this.preset.dly;
    this.delay.connect(this.delayFb); this.delayFb.connect(this.delay);
    this.delaySend.connect(this.delay); this.delay.connect(this.bus);

    this.reverb = ctx.createConvolver(); this.reverb.buffer = this._impulse(2.6, 3.0);
    this.revSend = ctx.createGain(); this.revSend.gain.value = this.preset.rev;
    this.revSend.connect(this.reverb); this.reverb.connect(this.bus);

    this.bus.connect(this.comp); this.comp.connect(this.master);
    this.master.connect(this.analyser); this.analyser.connect(ctx.destination);
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate, len = rate * seconds;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  resume() { if (this.ctx.state !== "running") this.ctx.resume(); }

  setPreset(name) {
    this.preset = PRESETS[name] || this.preset;
    this.master.gain.setTargetAtTime(this.preset.gain, this.ctx.currentTime, 0.02);
    this.revSend.gain.setTargetAtTime(this.preset.rev, this.ctx.currentTime, 0.02);
    this.delaySend.gain.setTargetAtTime(this.preset.dly, this.ctx.currentTime, 0.02);
  }

  // live macro overrides (from knobs)
  set(param, v) {
    const p = this.preset, t = this.ctx.currentTime;
    if (param === "cutoff") p.cutoff = v;
    else if (param === "res") p.res = v;
    else if (param === "rev") this.revSend.gain.setTargetAtTime(v, t, 0.02);
    else if (param === "dly") this.delaySend.gain.setTargetAtTime(v, t, 0.02);
    else if (param === "attack") p.a = v;
    else if (param === "release") p.r = v;
    else if (param === "gain") this.master.gain.setTargetAtTime(v, t, 0.02);
  }

  cc(num, val01) {                     // val01 in [0,1]
    if (num === 1) this.modCutoff = val01 * 4000;      // mod wheel -> cutoff
    else if (num === 74) this.bright = val01;          // brightness -> res+cutoff
  }

  noteOn(note, vel = 100) {
    this.resume();
    if (this.voices.has(note)) this.noteOff(note, true);
    const ctx = this.ctx, t = ctx.currentTime, p = this.preset;
    const v = vel / 127;

    const vca = ctx.createGain(); vca.gain.value = 0;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    const cut = Math.min(16000, p.cutoff + this.modCutoff + this.bright * 3000);
    filt.frequency.setValueAtTime(cut, t);
    filt.Q.value = p.res + this.bright * 6;

    const oscs = p.oscs.map(([type, det]) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = mtof(note); o.detune.value = det * 100;
      o.connect(filt); o.start(t); return o;
    });
    filt.connect(vca);
    vca.connect(this.bus); vca.connect(this.revSend); vca.connect(this.delaySend);

    // ADSR
    const peak = 0.28 + v * 0.5;
    vca.gain.cancelScheduledValues(t);
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(peak, t + p.a);
    vca.gain.linearRampToValueAtTime(peak * p.s + 0.0001, t + p.a + p.d);

    this.voices.set(note, { oscs, vca, filt });
  }

  noteOff(note) {
    const voice = this.voices.get(note);
    if (!voice) return;
    const t = this.ctx.currentTime, r = this.preset.r;
    voice.vca.gain.cancelScheduledValues(t);
    voice.vca.gain.setValueAtTime(voice.vca.gain.value, t);
    voice.vca.gain.linearRampToValueAtTime(0.0001, t + r);
    voice.oscs.forEach((o) => o.stop(t + r + 0.05));
    this.voices.delete(note);
  }

  fft(arr) { this.analyser.getByteFrequencyData(arr); }
  wave(arr) { this.analyser.getByteTimeDomainData(arr); }
  get binCount() { return this.analyser.frequencyBinCount; }
}
