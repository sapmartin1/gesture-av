// app.js — wiring: Web MIDI (auto-connects GestureAV), on-screen + QWERTY
// keyboard, macro knobs, presets. Feeds the synth and the visualizer.
import { Synth, PRESETS } from "./synth.js";
import { Visualizer } from "./visuals.js";

const synth = new Synth();
const viz = new Visualizer(document.getElementById("viz"), synth);
viz.start();

const NOTE_MIN = 48, NOTE_MAX = 84;          // C3..C6
const keyEls = new Map();

// ---- build on-screen keyboard ------------------------------------------------
const kb = document.getElementById("keyboard");
const isBlack = (n) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
const NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
(function buildKeys() {
  let whiteIdx = 0;
  const whites = [];
  for (let n = NOTE_MIN; n <= NOTE_MAX; n++) if (!isBlack(n)) whites.push(n);
  const wW = 100 / whites.length;
  for (let n = NOTE_MIN; n <= NOTE_MAX; n++) {
    const el = document.createElement("div");
    el.className = "key " + (isBlack(n) ? "black" : "white");
    el.dataset.note = n;
    if (isBlack(n)) {
      // place relative to previous white key
      el.style.left = `calc(${whiteIdx * wW}% - ${wW * 0.3}vw)`;
      el.style.width = `${wW * 0.6}vw`;
    } else {
      el.style.left = `${whiteIdx * wW}%`;
      el.style.width = `${wW}%`;
      if (n % 12 === 0) el.innerHTML = `<span>C${Math.floor(n / 12) - 1}</span>`;
      whiteIdx++;
    }
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); noteOn(n, 110); });
    el.addEventListener("pointerup", () => noteOff(n));
    el.addEventListener("pointerleave", () => noteOff(n));
    kb.appendChild(el);
    keyEls.set(n, el);
  }
})();

function noteOn(n, vel = 100) {
  synth.noteOn(n, vel);
  const el = keyEls.get(n);
  if (el) {
    el.classList.add("on");
    const r = el.getBoundingClientRect();
    viz.burst(r.left + r.width / 2, r.top, (n % 12) / 12 * 300 + 180, vel / 127);
  } else {
    viz.burst(innerWidth / 2, innerHeight / 2, (n % 12) / 12 * 300 + 180, vel / 127);
  }
}
function noteOff(n) { synth.noteOff(n); const el = keyEls.get(n); if (el) el.classList.remove("on"); }

// ---- QWERTY playing ----------------------------------------------------------
const QWERTY = { a:60,w:61,s:62,e:63,d:64,f:65,t:66,g:67,y:68,h:69,u:70,j:71,k:72,o:73,l:74 };
const held = new Set();
addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const n = QWERTY[e.key.toLowerCase()];
  if (n != null && !held.has(n)) { held.add(n); noteOn(n, 110); }
});
addEventListener("keyup", (e) => {
  const n = QWERTY[e.key.toLowerCase()];
  if (n != null) { held.delete(n); noteOff(n); }
});

// ---- Web MIDI (auto-connect GestureAV) --------------------------------------
const midiStatus = document.getElementById("midi-status");
midiStatus.style.cursor = "pointer";
midiStatus.title = "click to (re)connect MIDI";
function initMidi() {
  if (!navigator.requestMIDIAccess) {
    midiStatus.textContent = "○ Web MIDI unsupported (use Chrome)";
    return;
  }
  midiStatus.textContent = "○ connecting…";
  navigator.requestMIDIAccess({ sysex: false }).then((access) => {
    const wire = () => {
      let names = [];
      for (const input of access.inputs.values()) {
        input.onmidimessage = onMidi; names.push(input.name);
      }
      const gav = names.find((x) => /gestureav/i.test(x));
      midiStatus.textContent = gav ? `● ${gav}`
        : (names.length ? `● ${names[0]}` : "○ no MIDI source — is tracking running?");
      midiStatus.classList.toggle("live", names.length > 0);
    };
    wire(); access.onstatechange = wire;
  }).catch(() => {
    midiStatus.textContent = "○ MIDI blocked — click here, or allow MIDI in site settings";
  });
}
midiStatus.onclick = initMidi;
initMidi();
function onMidi(e) {
  const [status, d1, d2] = e.data, cmd = status & 0xf0;
  if (cmd === 0x90 && d2 > 0) noteOn(d1, d2);
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
  else if (cmd === 0xb0) synth.cc(d1, d2 / 127);
}

// ---- presets -----------------------------------------------------------------
const presetBar = document.getElementById("presets");
Object.keys(PRESETS).forEach((name, i) => {
  const b = document.createElement("button");
  b.textContent = name; b.className = "chip" + (i === 0 ? " active" : "");
  b.onclick = () => {
    synth.setPreset(name);
    [...presetBar.children].forEach((c) => c.classList.remove("active"));
    b.classList.add("active");
    syncKnobs();
  };
  presetBar.appendChild(b);
});

// ---- macro knobs -------------------------------------------------------------
const KNOBS = [
  { id: "cutoff", label: "CUTOFF", min: 200, max: 12000, get: () => synth.preset.cutoff, set: (v) => synth.set("cutoff", v) },
  { id: "res",    label: "RES",    min: 0,   max: 20,    get: () => synth.preset.res,    set: (v) => synth.set("res", v) },
  { id: "rev",    label: "REVERB", min: 0,   max: 1,     get: () => synth.revSend.gain.value, set: (v) => synth.set("rev", v) },
  { id: "dly",    label: "DELAY",  min: 0,   max: 0.8,   get: () => synth.delaySend.gain.value, set: (v) => synth.set("dly", v) },
  { id: "attack", label: "ATTACK", min: 0.001, max: 1.5, get: () => synth.preset.a,      set: (v) => synth.set("attack", v) },
  { id: "release",label: "RELEASE",min: 0.05, max: 3,    get: () => synth.preset.r,      set: (v) => synth.set("release", v) },
];
const knobBar = document.getElementById("knobs");
const knobObjs = KNOBS.map((k) => {
  const wrap = document.createElement("div"); wrap.className = "knob";
  wrap.innerHTML = `<div class="dial"><div class="ind"></div></div><label>${k.label}</label>`;
  const dial = wrap.querySelector(".dial"), ind = wrap.querySelector(".ind");
  const norm = () => (k.get() - k.min) / (k.max - k.min);
  const render = () => { ind.style.transform = `rotate(${-135 + norm() * 270}deg)`; };
  let dragging = false, sy = 0, sv = 0;
  const down = (e) => { dragging = true; sy = (e.touches ? e.touches[0].clientY : e.clientY); sv = norm(); e.preventDefault(); };
  const move = (e) => {
    if (!dragging) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    let v = Math.max(0, Math.min(1, sv + (sy - y) / 200));
    k.set(k.min + v * (k.max - k.min)); render();
  };
  const up = () => { dragging = false; };
  dial.addEventListener("mousedown", down); addEventListener("mousemove", move); addEventListener("mouseup", up);
  dial.addEventListener("touchstart", down); addEventListener("touchmove", move, { passive: false }); addEventListener("touchend", up);
  knobBar.appendChild(wrap);
  return { render };
});
function syncKnobs() { knobObjs.forEach((k) => k.render()); }
syncKnobs();

// ---- master volume + resume on first gesture --------------------------------
document.getElementById("vol").addEventListener("input", (e) => synth.set("gain", +e.target.value));
addEventListener("pointerdown", () => synth.resume(), { once: true });
addEventListener("keydown", () => synth.resume(), { once: true });
