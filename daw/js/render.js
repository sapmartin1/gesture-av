// render.js — offline arrangement render to a real 16-bit WAV file.
// Rebuilds the whole graph in an OfflineAudioContext, schedules every event
// (clips + automation + swing) with exact times, renders, encodes WAV.
import { SynthInst, DrumKit, Sampler, DRUM_LANES } from "./instruments.js";
import { STEPS_PER_BAR, clipLen } from "./sequencer.js";
import { AUTO_PARAMS } from "./automation.js";

function impulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate, len = rate * seconds;
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function driveCurve(amt) {
  if (amt <= 0.01) return null;
  const k = amt * 60, n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

export async function renderArrangementWav(tracks, { bpm, swing = 0, tailSec = 1.5 }) {
  const arrEnd = Math.max(4, ...tracks.flatMap((t) =>
    (t.arr || []).map((p) => p.startBar + (t.clips[p.scene] ? t.clips[p.scene].bars : 0))));
  const stepDur = 60 / bpm / 4;
  const totalSteps = arrEnd * STEPS_PER_BAR;
  const dur = totalSteps * stepDur + tailSec;
  const octx = new OfflineAudioContext(2, Math.ceil(dur * 44100), 44100);
  const fake = { ctx: octx };

  // master + returns
  const master = octx.createGain(); master.gain.value = 0.8;
  const comp = octx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 4;
  master.connect(comp); comp.connect(octx.destination);
  const delay = octx.createDelay(2); delay.delayTime.value = 0.375;
  const dfb = octx.createGain(); dfb.gain.value = 0.35;
  const dtone = octx.createBiquadFilter(); dtone.type = "lowpass"; dtone.frequency.value = 4200;
  delay.connect(dtone); dtone.connect(dfb); dfb.connect(delay); dtone.connect(master);
  const reverb = octx.createConvolver(); reverb.buffer = impulse(octx, 2.8, 2.6);
  reverb.connect(master);

  // rebuild each track's chain + instrument offline
  const offline = tracks.map((tr) => {
    const input = octx.createGain();
    const filter = octx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = tr.params.cutoff; filter.Q.value = tr.params.res;
    const shaper = octx.createWaveShaper(); shaper.curve = driveCurve(tr.params.drive);
    const vol = octx.createGain(); vol.gain.value = tr.params.vol;
    const pan = octx.createStereoPanner(); pan.pan.value = tr.params.pan;
    const sd = octx.createGain(); sd.gain.value = tr.params.delay;
    const sr = octx.createGain(); sr.gain.value = tr.params.reverb;
    input.connect(filter); filter.connect(shaper); shaper.connect(vol);
    vol.connect(pan); pan.connect(master); vol.connect(sd); sd.connect(delay);
    vol.connect(sr); sr.connect(reverb);
    const chain = { input };
    let inst;
    if (tr.type === "drums") inst = new DrumKit(fake, chain);
    else if (tr.type === "sampler") {
      inst = new Sampler(fake, chain);
      inst.buffer = tr.inst.buffer; inst.mode = tr.inst.mode;
    } else inst = new SynthInst(fake, chain, tr.inst.presetName);
    return { tr, inst, filter, vol, sr };
  });

  const solo = tracks.some((t) => t.solo);
  for (let step = 0; step < totalSteps; step++) {
    const when = step * stepDur + (step % 2 ? swing * stepDur * 0.5 : 0) + 0.03;
    for (const o of offline) {
      const tr = o.tr;
      if (tr.mute || (solo && !tr.solo)) continue;
      // automation (per-bar interpolation)
      if (tr.auto && tr.auto.param && tr.auto.points.length && step % 4 === 0) {
        const spec = AUTO_PARAMS[tr.auto.param];
        const v = spec.denorm(autoValueAt(tr.auto.points, step / STEPS_PER_BAR));
        if (tr.auto.param === "cutoff") o.filter.frequency.setValueAtTime(v, when);
        else if (tr.auto.param === "vol") o.vol.gain.setValueAtTime(v, when);
        else if (tr.auto.param === "reverb") o.sr.gain.setValueAtTime(v, when);
      }
      for (const pl of tr.arr || []) {
        const clip = tr.clips[pl.scene];
        if (!clip) continue;
        const s0 = pl.startBar * STEPS_PER_BAR, len = clipLen(clip);
        if (step < s0 || step >= s0 + len) continue;
        const pos = step - s0;
        if (clip.kind === "drums") {
          clip.steps.forEach((lane, li) => {
            if (lane[pos]) o.inst.trigger(DRUM_LANES[li], lane[pos], when);
          });
        } else {
          for (const nte of clip.notes) {
            if (nte.step === pos) o.inst.noteOn(nte.note, nte.vel, when, nte.len * stepDur);
          }
        }
      }
    }
  }

  const buf = await octx.startRendering();
  return { url: URL.createObjectURL(encodeWav(buf)), bars: arrEnd };
}

export function autoValueAt(points, bar) {
  const pts = [...points].sort((a, b) => a.bar - b.bar);
  if (!pts.length) return 0.5;
  if (bar <= pts[0].bar) return pts[0].v;
  if (bar >= pts[pts.length - 1].bar) return pts[pts.length - 1].v;
  for (let i = 0; i < pts.length - 1; i++) {
    if (bar >= pts[i].bar && bar <= pts[i + 1].bar) {
      const f = (bar - pts[i].bar) / (pts[i + 1].bar - pts[i].bar || 1);
      return pts[i].v + (pts[i + 1].v - pts[i].v) * f;
    }
  }
  return pts[0].v;
}

function encodeWav(buf) {
  const nCh = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
  const bytes = 44 + len * nCh * 2;
  const ab = new ArrayBuffer(bytes), dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); dv.setUint32(4, bytes - 8, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * nCh * 2, true); dv.setUint16(32, nCh * 2, true);
  dv.setUint16(34, 16, true); wstr(36, "data"); dv.setUint32(40, len * nCh * 2, true);
  let off = 44;
  const chans = Array.from({ length: nCh }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}
