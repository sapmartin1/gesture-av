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


def pitch_from_height(y, scale):
    """y in [0,1], top of frame = highest pitch."""
    steps = len(scale) * OCTAVES
    idx = max(0, min(steps - 1, int((1.0 - y) * steps)))
    octave, deg = divmod(idx, len(scale))
    return ROOT + octave * 12 + scale[deg]


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


def analyze_and_play(result, midi, state, scale, W, H):
    """Shared hand->MIDI logic. Returns (render_hands, bursts). Mutates state."""
    render, bursts = [], []
    right_pinch_now = False
    for lms, handed in zip(result.hand_landmarks or [], result.handedness or []):
        label = handed[0].category_name
        pts = [(int(p.x * W), int(p.y * H)) for p in lms]
        hand_size = dist(lms[WRIST], lms[MIDDLE_MCP]) + 1e-6
        pinch = dist(lms[THUMB_TIP], lms[INDEX_TIP]) / hand_size
        openness = dist(lms[WRIST], lms[MIDDLE_TIP]) / hand_size
        info = {"label": label, "pts": pts, "pinch": pinch}

        if label == "Right":
            right_pinch_now = pinch < 0.6
            note = pitch_from_height(lms[INDEX_TIP].y, scale)
            info["note"] = note
            if right_pinch_now:
                vel = int(max(20, min(127, (1.0 - pinch) * 160)))
                info["vel"] = vel
                if not state["pinch_was"] or note != state["right_note"]:
                    if state["right_note"] is not None:
                        midi.note_off(state["right_note"])
                    midi.note_on(note, vel)
                    state["right_note"] = note
                    mx = int((lms[THUMB_TIP].x + lms[INDEX_TIP].x) / 2 * W)
                    my = int((lms[THUMB_TIP].y + lms[INDEX_TIP].y) / 2 * H)
                    col = (int(120 + (note % 12) / 12 * 135), 255, int(120 + vel / 127 * 135))
                    bursts.append((mx, my, col, vel))
        else:
            cc1 = int(max(0, min(127, (1.0 - lms[MIDDLE_TIP].y) * 127)))
            cc74 = int(max(0, min(127, min(openness, 1.5) / 1.5 * 127)))
            midi.cc(1, cc1); midi.cc(74, cc74)
            info["cc1"], info["cc74"] = cc1, cc74
        render.append(info)

    if state["pinch_was"] and not right_pinch_now and state["right_note"] is not None:
        midi.note_off(state["right_note"]); state["right_note"] = None
    state["pinch_was"] = right_pinch_now
    return render, bursts


def open_camera(idx, W, H):
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
    state = {"right_note": None, "pinch_was": False}
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
            analyze_and_play(res, midi, state, scale, args.width, args.height)
            time.sleep(0.005)
    except KeyboardInterrupt:
        pass
    finally:
        if state["right_note"] is not None:
            midi.note_off(state["right_note"])
        cap.release(); landmarker.close()


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
    state = {"right_note": None, "pinch_was": False}
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

        render, bursts = analyze_and_play(res, midi, state, scale, W, H)
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

        head = "GestureAV  " + ("[MIDI: GestureAV]" if midi.port else "[visuals only]")
        screen.blit(font.render(head, True, (200, 255, 220)), (12, 12))
        screen.blit(font.render(f"{int(clock.get_fps())} fps  scale={args.scale}  Esc=quit",
                                True, (90, 140, 120)), (12, H - 28))
        pygame.display.flip()
        clock.tick(60)

    if state["right_note"] is not None:
        midi.note_off(state["right_note"])
    landmarker.close(); cap.release(); pygame.quit()


def main():
    ap = argparse.ArgumentParser(description="Local hand-tracked MIDI instrument.")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--scale", choices=SCALES, default="penta")
    ap.add_argument("--no-midi", action="store_true")
    ap.add_argument("--no-visuals", action="store_true",
                    help="tracking + MIDI only; use the web DAW for visuals")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
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
