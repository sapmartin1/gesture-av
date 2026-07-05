# GestureAV — hand-tracked instrument + live visuals

A one-person AV show. Your webcam tracks both hands; **pinch to play notes into
any DAW** over a virtual MIDI port, while a **neon visualizer** reacts to every
note and movement. 100% local — nothing leaves your machine.

```
  RIGHT hand   pinch (thumb+index) = play a note
               hand HEIGHT   → pitch (on a musical scale)
               pinch tightness → velocity (how hard)
  LEFT hand    height   → CC1  (mod wheel / filter sweep)
               openness → CC74 (brightness / cutoff)
```

## Setup on a new Mac (e.g. your MacBook Air)

```bash
git clone <this-repo> gesture-av
cd gesture-av
./setup.sh        # installs python3.11 venv + deps + hand model
```

Then grant permission and run:

1. **System Settings → Privacy & Security → Camera** → enable your terminal.
2. **`./run`**  — a window opens; hold your hand up and pinch.

> First launch loads the tracking model; give it a second.

## Playing into a DAW (Logic / Ableton / GarageBand)

GestureAV publishes a virtual MIDI source called **`GestureAV`**.

- **Logic Pro:** it just appears — create a Software Instrument track, load any
  instrument, and play. (If needed: Logic → Settings → MIDI → Inputs → enable it.)
- **Ableton Live:** Settings → Link/Tempo/MIDI → enable **Track** for the
  `GestureAV` input → arm a MIDI track with an instrument.
- **GarageBand:** create a Software Instrument track; it listens to all MIDI in.

Left hand's CC1/CC74 map to mod-wheel and filter on most synths — sweep away.

No DAW? Try the visuals alone: **`./run --no-midi`**.

## 🎛️ Bundled DAW (no Ableton needed)

The repo ships its own browser DAW — polyphonic synth, 5 presets (Warm Keys,
Analog Pad, Deep Bass, Pluck, Lead), macro knobs, an on-screen keyboard, and a
captivating audio-reactive visualizer. Ableton-inspired, glassmorphic, modern.

**Best combo — hands play the DAW while it draws the visuals:**

```bash
# terminal 1 — gestures → MIDI, no python window
./run --no-visuals
# terminal 2 — the DAW (opens in your browser)
./daw/serve
```

Now pinch in the air and the browser DAW plays + reacts. It **auto-connects** to
the `GestureAV` MIDI port (you'll see "● GestureAV" light up top-right).

**Also playable on its own** — open `./daw/serve` and use your mouse or the
computer keyboard (`A S D F …` = white keys, `W E T Y U` = black). Your left
hand's mod/brightness map to the synth's filter live.

> Use **Chrome** — Web MIDI (to hear your gestures) is Chrome-only. Web Audio
> (mouse/keyboard playing + visuals) works in any modern browser.

## Options
```
./run --camera 1        # if the built-in cam isn't index 0
./run --scale minor     # penta (default) | major | minor
./run --no-midi         # visuals only
./run --width 1920 --height 1080
```

## How it works
- **Tracking:** MediaPipe HandLandmarker (Tasks API), 21 landmarks/hand, on CPU.
- **MIDI:** `mido` + `python-rtmidi` create a CoreMIDI virtual source.
- **Visuals:** pygame — glowing skeletons + a particle burst per note.

## Roadmap / easy upgrades
- **True audio-reactive:** you already have BlackHole installed — route your DAW
  output into BlackHole and add an FFT so the visuals pulse to the actual sound.
- Gesture *chords*, sustain via fist, per-hand instruments, MIDI-learn mapping UI.
- Fullscreen / projector mode for performances.

## Troubleshooting
- **Black window / no camera:** grant Camera permission; try `--camera 1`.
- **DAW hears nothing:** confirm the `GestureAV` input is enabled + a track armed.
- **Laggy:** lower resolution (`--width 960 --height 540`).
- **Python version error:** GestureAV needs 3.11; `setup.sh` handles it.
