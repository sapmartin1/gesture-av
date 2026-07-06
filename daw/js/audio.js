// audio.js — the studio engine: master bus, per-track chains (filter → drive →
// vol → pan), global delay/reverb return buses, analyser tap, and master
// recording (bounce) via MediaRecorder.

export class Engine {
  constructor() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain(); this.master.gain.value = 0.8;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12; this.comp.ratio.value = 4;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.8;

    this.master.connect(this.comp);
    this.comp.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // recording tap
    this.recDest = ctx.createMediaStreamDestination();
    this.analyser.connect(this.recDest);
    this.recorder = null; this.recChunks = [];

    // global return buses (Ableton-style sends)
    this.delay = ctx.createDelay(2.0); this.delay.delayTime.value = 0.375;
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.35;
    this.delayTone = ctx.createBiquadFilter(); this.delayTone.type = "lowpass";
    this.delayTone.frequency.value = 4200;
    this.delay.connect(this.delayTone); this.delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay); this.delayTone.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.8, 2.6);
    this.reverb.connect(this.master);
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
  now() { return this.ctx.currentTime; }

  setDelayTime(sec) { this.delay.delayTime.setTargetAtTime(sec, this.now(), 0.02); }

  /** Per-track chain: input → filter → drive → vol → pan → master (+ sends). */
  makeChain() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = 18000; filter.Q.value = 0.8;
    const shaper = ctx.createWaveShaper(); shaper._amount = 0;
    const vol = ctx.createGain(); vol.gain.value = 0.9;
    const pan = ctx.createStereoPanner();
    const sendD = ctx.createGain(); sendD.gain.value = 0;
    const sendR = ctx.createGain(); sendR.gain.value = 0;

    input.connect(filter); filter.connect(shaper); shaper.connect(vol);
    vol.connect(pan); pan.connect(this.master);
    vol.connect(sendD); sendD.connect(this.delay);
    vol.connect(sendR); sendR.connect(this.reverb);

    const setDrive = (amt) => {                       // 0..1
      shaper._amount = amt;
      if (amt <= 0.01) { shaper.curve = null; return; }
      const k = amt * 60, n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      shaper.curve = curve;
    };

    return {
      input,
      set: (param, v) => {
        const t = this.now();
        if (param === "cutoff") filter.frequency.setTargetAtTime(v, t, 0.02);
        else if (param === "res") filter.Q.setTargetAtTime(v, t, 0.02);
        else if (param === "drive") setDrive(v);
        else if (param === "vol") vol.gain.setTargetAtTime(v, t, 0.02);
        else if (param === "pan") pan.pan.setTargetAtTime(v, t, 0.02);
        else if (param === "delay") sendD.gain.setTargetAtTime(v, t, 0.02);
        else if (param === "reverb") sendR.gain.setTargetAtTime(v, t, 0.02);
      },
      dispose: () => { try { input.disconnect(); vol.disconnect(); } catch (e) {} },
    };
  }

  // ---- master bounce ---------------------------------------------------------
  startBounce() {
    this.recChunks = [];
    this.recorder = new MediaRecorder(this.recDest.stream);
    this.recorder.ondataavailable = (e) => e.data.size && this.recChunks.push(e.data);
    this.recorder.start();
  }

  stopBounce() {
    return new Promise((res) => {
      this.recorder.onstop = () => {
        const blob = new Blob(this.recChunks, { type: this.recorder.mimeType });
        res(URL.createObjectURL(blob));
      };
      this.recorder.stop();
    });
  }

  // for the visualizer (same interface the old synth exposed)
  fft(arr) { this.analyser.getByteFrequencyData(arr); }
  wave(arr) { this.analyser.getByteTimeDomainData(arr); }
  get binCount() { return this.analyser.frequencyBinCount; }
}
