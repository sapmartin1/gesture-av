#!/usr/bin/env python3
"""
GestureAV — a one-person hand-tracked AV instrument for macOS.

Your webcam tracks both hands (MediaPipe). Pinch to play notes into any DAW over
a virtual MIDI port — including the bundled GestureAV DAW (see ./daw). A synced
neon visualizer reacts to every note; or run headless (--no-visuals) and let the
web DAW own the visuals.

  RIGHT hand  : pinch (thumb+index) = play. Hand HEIGHT picks the pitch on a
                pentatonic scale. Pinch tightness = velocity.
  LEFT hand   : height  -> CC1  (mod / filter),  openness -> CC74 (brightness).

Run:  ./run                      windowed visualizer
      ./run --no-visuals         headless: tracking + MIDI only (feed the DAW)
      ./run --camera 0           pick camera
      ./run --no-midi            visuals only (no DAW needed)
      ./run --scale minor        major | minor | penta (default penta)
"""
import argparse
import math
import os
import sys
import time
import random

import numpy as np
import cv2
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions

MODEL = os.path.join(os.path.dirname(__file__), "models", "hand_landmarker.task")

SCALES = {
    "penta": [0, 3, 5, 7, 10],
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
}
ROOT = 48
OCTAVES = 3

WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_MCP, MIDDLE_TIP = 0, 4, 8, 9, 12

NEON = (57, 255, 140)
CYAN = (80, 220, 255)
CONNECTIONS = [(0,1),(1,2),(2,3),(3,4),(0,5),(5,6),(6,7),(7,8),(5,9),(9,10),
               (10,11),(11,12),(9,13),(13,14),(14,15),(15,16),(13,17),
               (17,18),(18,19),(19,20),(0,17)]


def dist(a, b):
    return math.hypot(a.x - b.x, a.y - b.y)


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(n):
    return f"{NOTE_NAMES[n % 12]}{n // 12 - 1}"


def zone_from_y(y, n_zones, prev_zone):
    """Map hand height to one of n_zones big bands, with hysteresis so the note
    doesn't flicker at boundaries. Top of frame = highest zone."""
    raw = (1.0 - y) * n_zones
    zone = max(0, min(n_zones - 1, int(raw)))
    if prev_zone is not None and zone != prev_zone:
        frac = raw - int(raw)                     # position inside the new band
        if zone == prev_zone + 1 and frac < 0.35:
            zone = prev_zone                      # only just crossed up — stay
        elif zone == prev_zone - 1 and frac > 0.65:
            zone = prev_zone                      # only just crossed down — stay
    return zone


def zone_note(zone, scale, oct_base):
    deg = zone % len(scale)
    octv = zone // len(scale)
    return ROOT + (oct_base + octv) * 12 + scale[deg]


def chord_notes(zone, scale, oct_base):
    """A triad built by stacking scale degrees from the selected zone."""
    return [zone_note(zone + step, scale, oct_base) for step in (0, 2, 4)]


def octave_from_left(y):
    """Left hand height picks the octave: low hand = low octave."""
    return [0, 1, 2, 3][max(0, min(3, int((1.0 - y) * 4)))]


class MidiOut:
    def __init__(self, enabled):
        self.port = None
        if not enabled:
            return
        import mido
        self.mido = mido
        self.port = mido.open_output("GestureAV", virtual=True)

    def note_on(self, n, v):
        if self.port: self.port.send(self.mido.Message("note_on", note=n, velocity=v))

    def note_off(self, n):
        if self.port: self.port.send(self.mido.Message("note_off", note=n, velocity=0))

    def cc(self, num, val):
        if self.port: self.port.send(self.mido.Message("control_change", control=num, value=val))

    def close(self):
        if self.port: self.port.close()


class Particle:
    __slots__ = ("x", "y", "vx", "vy", "life", "color", "size")

    def __init__(self, x, y, color, size):
        ang = random.uniform(0, math.tau); spd = random.uniform(1.5, 6.0)
        self.x, self.y = x, y
        self.vx, self.vy = math.cos(ang) * spd, math.sin(ang) * spd
        self.life = 1.0; self.color = color; self.size = size

    def step(self):
        self.x += self.vx; self.y += self.vy; self.vy += 0.08; self.life -= 0.02
        return self.life > 0


def _all_off(midi, state):
    for n in state.get("right_notes", []):
        midi.note_off(n)
    state["right_notes"] = []
    state["playing_zone"] = None


def analyze_and_play(result, midi, state, scale, W, H, n_zones=6, chord=False):
    """Zoned hand->MIDI. Big note bands + hysteresis + note-latch = playable.
    Right hand = pitch (pinch to strike). Left hand = octave + filter. Chord opt."""
    render, bursts = [], []
    hands = list(zip(result.hand_landmarks or [], result.handedness or []))

    # left hand first → octave + expression
    for lms, handed in hands:
        if handed[0].category_name == "Left":
            state["oct_base"] = octave_from_left(lms[MIDDLE_TIP].y)
            openness = dist(lms[WRIST], lms[MIDDLE_TIP]) / (dist(lms[WRIST], lms[MIDDLE_MCP]) + 1e-6)
            midi.cc(1, int(max(0, min(127, (1.0 - lms[MIDDLE_TIP].y) * 127))))
            midi.cc(74, int(max(0, min(127, min(openness, 1.5) / 1.5 * 127))))
    oct_base = state.get("oct_base", 1)

    right_pinch_now = False
    for lms, handed in hands:
        label = handed[0].category_name
        pts = [(int(p.x * W), int(p.y * H)) for p in lms]
        hand_size = dist(lms[WRIST], lms[MIDDLE_MCP]) + 1e-6
        pinch = dist(lms[THUMB_TIP], lms[INDEX_TIP]) / hand_size
        info = {"label": label, "pts": pts, "pinch": pinch}

        if label == "Right":
            zone = zone_from_y(lms[INDEX_TIP].y, n_zones, state.get("prev_zone"))
            state["prev_zone"] = zone
            note = zone_note(zone, scale, oct_base)
            info["zone"] = zone; info["note"] = note; info["note_label"] = note_name(note)
            right_pinch_now = pinch < 0.5              # tighter → deliberate strike
            if right_pinch_now:
                vel = int(max(30, min(127, (1.0 - pinch) * 200)))
                info["vel"] = vel
                struck = not state["pinch_was"]        # new pinch = attack
                moved = state.get("playing_zone") not in (None, zone)
                if struck or moved:
                    _all_off(midi, state)
                    notes = chord_notes(zone, scale, oct_base) if chord else [note]
                    for nn in notes:
                        midi.note_on(nn, vel)
                    state["right_notes"] = notes
                    state["playing_zone"] = zone
                    mx = int((lms[THUMB_TIP].x + lms[INDEX_TIP].x) / 2 * W)
                    my = int((lms[THUMB_TIP].y + lms[INDEX_TIP].y) / 2 * H)
                    col = (int(120 + (note % 12) / 12 * 135), 255, int(120 + vel / 127 * 135))
                    bursts.append((mx, my, col, vel))
        render.append(info)

    if state["pinch_was"] and not right_pinch_now:
        _all_off(midi, state)
    state["pinch_was"] = right_pinch_now
    info_meta = {"n_zones": n_zones, "oct_base": oct_base, "scale": scale,
                 "playing_zone": state.get("playing_zone"), "cur_zone": state.get("prev_zone")}
    return render, bursts, info_meta


VIRTUAL_CAMS = ("iphone", "continuity", "camo", "obs", "virtual", "ipad", "desk view")


def pick_camera_index():
    """Prefer the Mac's BUILT-IN camera over iPhone Continuity Camera etc.
    Uses system_profiler (always present on macOS — no ffmpeg dependency).
    Never raises; falls back to index 0."""
    try:
        import json as _json
        import subprocess as sp
        out = sp.run(["/usr/sbin/system_profiler", "SPCameraDataType", "-json"],
                     capture_output=True, text=True, timeout=15).stdout
        cams = [c.get("_name", "") for c in _json.loads(out).get("SPCameraDataType", [])]
        if cams:
            for i, name in enumerate(cams):
                if not any(v in name.lower() for v in VIRTUAL_CAMS):
                    print(f"🎥 camera: [{i}] {name}")
                    return i
            print(f"🎥 camera: [0] {cams[0]}  (only virtual cams found)")
    except Exception as e:
        print(f"🎥 camera auto-pick failed ({e}); using index 0")
    return 0


def open_camera(idx, W, H):
    if idx is None:                      # auto: avoid iPhone/virtual cameras
        idx = pick_camera_index()
    cap = cv2.VideoCapture(idx)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, W); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, H)
    if not cap.isOpened():
        sys.exit(f"Could not open camera {idx}. Try --camera 1, and grant Camera "
                 "permission to your terminal.")
    return cap


def make_landmarker():
    opts = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL),
        num_hands=2, running_mode=vision.RunningMode.VIDEO,
        min_hand_detection_confidence=0.6, min_tracking_confidence=0.6)
    return vision.HandLandmarker.create_from_options(opts)


def run_headless(args, midi, scale):
    landmarker = make_landmarker()
    cap = open_camera(args.camera, args.width, args.height)
    state = {"pinch_was": False}
    t0 = time.time()
    print("🟢 GestureAV headless — tracking + MIDI only. Open ./daw for visuals. Ctrl+C to quit.")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                continue
            rgb = cv2.cvtColor(cv2.flip(frame, 1), cv2.COLOR_BGR2RGB)
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            res = landmarker.detect_for_video(img, int((time.time() - t0) * 1000))
            analyze_and_play(res, midi, state, scale, args.width, args.height,
                             n_zones=args.zones, chord=args.chord)
            time.sleep(0.005)
    except KeyboardInterrupt:
        pass
    finally:
        _all_off(midi, state)
        cap.release(); landmarker.close()


def draw_zones(screen, font, meta, W, H):
    """Draw the note bands so you can SEE where each note is. Highlights the
    band your hand is in, and flashes the one you're playing."""
    import pygame
    scale = meta["scale"]; n = meta["n_zones"]; ob = meta["oct_base"]
    band = H / n
    for z in range(n):
        top = int((n - 1 - z) * band)             # zone 0 at bottom (low), high at top
        note = zone_note(z, scale, ob)
        playing = meta["playing_zone"] == z
        cur = meta["cur_zone"] == z
        col = (30, 60, 45) if not (cur or playing) else ((60, 200, 120) if playing else (40, 90, 65))
        s = pygame.Surface((160, int(band) - 2), pygame.SRCALPHA)
        s.fill((*col, 150 if (cur or playing) else 60))
        screen.blit(s, (0, top + 1))
        lab = font.render(note_name(note), True,
                          (230, 255, 240) if (cur or playing) else (120, 150, 135))
        screen.blit(lab, (14, top + int(band / 2) - 10))


def run_visual(args, midi, scale):
    import pygame
    landmarker = make_landmarker()
    cap = open_camera(args.camera, args.width, args.height)
    pygame.init()
    W, H = args.width, args.height
    screen = pygame.display.set_mode((W, H))
    pygame.display.set_caption("GestureAV — pinch to play  (Esc to quit)")
    font = pygame.font.SysFont("Menlo", 20)
    clock = pygame.time.Clock()
    particles = []
    state = {"pinch_was": False}
    t0 = time.time()
    running = True
    while running:
        for e in pygame.event.get():
            if e.type == pygame.QUIT or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                running = False
        ok, frame = cap.read()
        if not ok:
            continue
        rgb = cv2.cvtColor(cv2.flip(frame, 1), cv2.COLOR_BGR2RGB)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = landmarker.detect_for_video(img, int((time.time() - t0) * 1000))

        small = cv2.resize(rgb, (W, H))
        surf = pygame.image.frombuffer((small * 0.18).astype(np.uint8).tobytes(), (W, H), "RGB")
        screen.blit(surf, (0, 0))

        render, bursts, meta = analyze_and_play(res, midi, state, scale, W, H,
                                                n_zones=args.zones, chord=args.chord)
        draw_zones(screen, font, meta, W, H)
        for info in render:
            color = NEON if info["label"] == "Right" else CYAN
            pts = info["pts"]
            for a, b in CONNECTIONS:
                pygame.draw.line(screen, color, pts[a], pts[b], 3)
            for (px, py) in pts:
                pygame.draw.circle(screen, color, (px, py), 5)
            if info["label"] == "Right" and info.get("vel"):
                mid = ((pts[4][0]+pts[8][0])//2, (pts[4][1]+pts[8][1])//2)
                pygame.draw.circle(screen, (255, 255, 255), mid, 12, 2)
        for (mx, my, col, vel) in bursts:
            for _ in range(int(vel / 3)):
                particles.append(Particle(mx, my, col, random.randint(2, 5)))

        alive = []
        for p in particles:
            if p.step():
                a = max(0, min(255, int(p.life * 255)))
                s = pygame.Surface((p.size*2, p.size*2), pygame.SRCALPHA)
                pygame.draw.circle(s, (*p.color, a), (p.size, p.size), p.size)
                screen.blit(s, (p.x - p.size, p.y - p.size)); alive.append(p)
        particles = alive[-1500:]

        now = "  ♪ " + note_name(zone_note(meta["playing_zone"], scale, meta["oct_base"])) \
            if meta.get("playing_zone") is not None else ""
        head = f"GestureAV  oct {meta['oct_base']}  {'chords' if args.chord else 'notes'}{now}"
        screen.blit(font.render(head, True, (200, 255, 220)), (180, 12))
        screen.blit(font.render("pinch to play · left hand = octave · Esc quits",
                                True, (90, 140, 120)), (180, H - 28))
        pygame.display.flip()
        clock.tick(60)

    _all_off(midi, state)
    landmarker.close(); cap.release(); pygame.quit()


def main():
    ap = argparse.ArgumentParser(description="Local hand-tracked MIDI instrument.")
    ap.add_argument("--camera", type=int, default=None,
                    help="camera index; default auto-picks the built-in (skips iPhone)")
    ap.add_argument("--scale", choices=SCALES, default="penta")
    ap.add_argument("--no-midi", action="store_true")
    ap.add_argument("--no-visuals", action="store_true",
                    help="tracking + MIDI only; use the web DAW for visuals")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--zones", type=int, default=6,
                    help="number of note bands (fewer = bigger, easier targets)")
    ap.add_argument("--chord", action="store_true", help="pinch plays a chord, not one note")
    args = ap.parse_args()

    if not os.path.exists(MODEL):
        sys.exit(f"Missing model: {MODEL}\nRun ./run once with internet, or see README.")

    scale = SCALES[args.scale]
    midi = MidiOut(not args.no_midi)
    try:
        if args.no_visuals:
            run_headless(args, midi, scale)
        else:
            run_visual(args, midi, scale)
    finally:
        midi.close()


if __name__ == "__main__":
    main()
