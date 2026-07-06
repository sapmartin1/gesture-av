// sequencer.js — Ableton-style session engine: transport + lookahead scheduler,
// scenes, per-track clip slots, bar-quantized clip launch/stop, live recording.

export const STEPS_PER_BAR = 16;
export const N_SCENES = 6;

export function melodicClip(bars = 2, name = "MIDI") {
  return { kind: "melodic", bars, notes: [], name };
}
export function drumClip(bars = 2, lanes = 6, name = "Beat") {
  return { kind: "drums", bars, steps: Array.from({ length: lanes }, () => ({})), name };
}
export function clipLen(clip) { return clip.bars * STEPS_PER_BAR; }

export class Transport {
  constructor(engine) {
    this.engine = engine;
    this.bpm = 110;
    this.swing = 0;                        // 0..0.6 — delays odd 16ths
    this.mode = "session";                 // "session" | "arr"
    this.playing = false;
    this.recording = false;
    this.metronome = false;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.tracks = [];
    this.onStep = null;                    // (globalStep) => UI playheads
    this.onLaunchChange = null;            // () => UI slot states
    this.autoValueAt = null;               // injected (render.js) for live automation
    this.autoParams = null;
  }

  stepDur() { return 60 / this.bpm / 4; }

  arrEndBars() {
    return Math.max(4, ...this.tracks.flatMap((t) =>
      (t.arr || []).map((p) => p.startBar + (t.clips[p.scene] ? t.clips[p.scene].bars : 0))));
  }

  start() {
    this.engine.resume();
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = this.engine.now() + 0.06;
    this.timer = setInterval(() => this._tick(), 25);
  }

  stop() {
    this.playing = false; this.recording = false;
    clearInterval(this.timer);
    for (const tr of this.tracks) {
      tr.playing = null; tr.queued = null;
      if (tr.inst && tr.inst.allOff) tr.inst.allOff();
    }
    if (this.onStep) this.onStep(-1);
    if (this.onLaunchChange) this.onLaunchChange();
  }

  /** Queue a clip (bar-quantized). scene=null queues a stop for the track. */
  launch(track, scene) {
    track.queued = scene === null ? "stop" : scene;
    if (!this.playing) this.start();
    if (this.onLaunchChange) this.onLaunchChange();
  }

  launchScene(scene) {
    for (const tr of this.tracks) {
      if (tr.clips[scene]) this.launch(tr, scene);
    }
  }

  stopAll() { for (const tr of this.tracks) tr.queued = "stop"; }

  _tick() {
    const ahead = this.engine.now() + 0.12;
    while (this.nextTime < ahead) {
      this._schedule(this.step, this.nextTime);
      this.nextTime += this.stepDur();
      this.step += 1;
    }
  }

  _schedule(rawStep, rawWhen) {
    const when = rawWhen + (rawStep % 2 ? this.swing * this.stepDur() * 0.5 : 0);
    const step = this.mode === "arr"
      ? rawStep % (this.arrEndBars() * STEPS_PER_BAR)   // loop the arrangement
      : rawStep;

    if (this.mode === "session" && step % STEPS_PER_BAR === 0) {
      let changed = false;
      for (const tr of this.tracks) {
        if (tr.queued === "stop") { tr.playing = null; tr.queued = null; changed = true; }
        else if (tr.queued != null) {
          tr.playing = { scene: tr.queued, startStep: step };
          tr.queued = null; changed = true;
        }
      }
      if (changed && this.onLaunchChange) {
        setTimeout(() => this.onLaunchChange(), Math.max(0, (when - this.engine.now()) * 1000));
      }
    }
    if (this.metronome && step % 4 === 0) this._click(when, step % STEPS_PER_BAR === 0);

    const solo = this.tracks.some((t) => t.solo);
    for (const tr of this.tracks) {
      if (tr.mute || (solo && !tr.solo)) continue;

      // live automation (arrangement mode, once per beat)
      if (this.mode === "arr" && tr.auto && tr.auto.param && tr.auto.points.length
          && step % 4 === 0 && this.autoValueAt && this.autoParams) {
        const spec = this.autoParams[tr.auto.param];
        tr.chain.set(tr.auto.param,
          spec.denorm(this.autoValueAt(tr.auto.points, step / STEPS_PER_BAR)), when);
      }

      if (this.mode === "arr") {
        for (const pl of tr.arr || []) {
          const clip = tr.clips[pl.scene];
          if (!clip) continue;
          const s0 = pl.startBar * STEPS_PER_BAR;
          if (step < s0 || step >= s0 + clipLen(clip)) continue;
          this._playClipStep(tr, clip, step - s0, when);
        }
      } else {
        if (!tr.playing) continue;
        const clip = tr.clips[tr.playing.scene];
        if (!clip) continue;
        this._playClipStep(tr, clip, (step - tr.playing.startStep) % clipLen(clip), when);
      }
    }
    if (this.onStep) {
      const dt = Math.max(0, (when - this.engine.now()) * 1000);
      setTimeout(() => this.playing && this.onStep(step), dt);
    }
  }

  _playClipStep(tr, clip, pos, when) {
    if (clip.kind === "drums") {
      clip.steps.forEach((lane, li) => {
        const v = lane[pos];
        if (v) tr.inst.trigger(tr.laneNames[li], v, when);
      });
    } else {
      for (const n of clip.notes) {
        if (n.step === pos) tr.inst.noteOn(n.note, n.vel, when, n.len * this.stepDur());
      }
    }
  }

  _click(when, accent) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator(); o.frequency.value = accent ? 1600 : 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.22 : 0.12, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
    o.connect(g); g.connect(this.engine.master);
    o.start(when); o.stop(when + 0.05);
  }

  /** Track playhead position (step within its playing clip), or -1. */
  trackPos(tr) {
    if (!this.playing || !tr.playing) return -1;
    const clip = tr.clips[tr.playing.scene];
    if (!clip) return -1;
    return (this.step - 1 - tr.playing.startStep + clipLen(clip) * 4) % clipLen(clip);
  }

  /** Quantized live-record into the armed track's PLAYING clip. */
  recordNote(track, note, vel, tOn, tOff) {
    if (!this.playing || !this.recording || !track.playing) return;
    const clip = track.clips[track.playing.scene];
    if (!clip) return;
    const sd = this.stepDur();
    const len = clipLen(clip);
    // this.step corresponds to this.nextTime (lookahead), NOT engine.now() —
    // using now() here biased every recorded note 1-2 sixteenths late.
    let startFloat = this.step - (this.nextTime - tOn) / sd - track.playing.startStep;
    if (Math.round(startFloat) % 2) startFloat -= this.swing * 0.5;  // swung grid
    const step = ((Math.round(startFloat) % len) + len) % len;
    if (clip.kind === "drums") {
      const lane = Math.abs(note) % clip.steps.length;
      clip.steps[lane][step] = vel;
    } else {
      const dur = Math.max(1, Math.round((tOff - tOn) / sd));
      clip.notes = clip.notes.filter((n) => !(n.step === step && n.note === note));
      clip.notes.push({ step, note, vel, len: Math.min(dur, len) });
    }
  }
}
