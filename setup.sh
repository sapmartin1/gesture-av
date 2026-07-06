#!/bin/bash
# GestureAV bootstrap — run once on a fresh machine (e.g. your MacBook Air).
#   git clone <repo> && cd gesture-av && ./setup.sh && ./run
set -e
cd "$(dirname "$0")"

echo "== GestureAV setup =="

# 1) Need Homebrew Python 3.11 (MediaPipe supports 3.11, not 3.14).
if ! command -v python3.11 >/dev/null 2>&1; then
  echo "python3.11 not found."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing python@3.11 via Homebrew…"
    brew install python@3.11
  else
    echo "Install Homebrew first: https://brew.sh  then: brew install python@3.11"
    exit 1
  fi
fi

# 2) Virtual env + deps
echo "Creating venv…"
python3.11 -m venv venv
./venv/bin/python -m pip install --upgrade pip >/dev/null
echo "Installing dependencies (mediapipe, opencv, pygame, mido, rtmidi)…"
./venv/bin/pip install -r requirements.txt

# 3) Hand model
if [ ! -f models/hand_landmarker.task ]; then
  echo "Downloading hand model…"
  mkdir -p models
  curl -sSL -o models/hand_landmarker.task \
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
fi

chmod +x run make-app.sh 2>/dev/null
./make-app.sh 2>/dev/null || true
echo ""
echo "✅ Done. Easiest way to play:"
echo "   → Open the GestureAV app from /Applications (Spotlight: 'GestureAV')."
echo "     It starts tracking + the DAW in Chrome. Allow Camera when asked."
echo ""
echo "   (Terminal alternative: ./run  — or ./run --no-visuals + ./daw/serve)"
