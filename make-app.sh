#!/bin/bash
# Build GestureAV.app — a double-clickable Mac app. Run once after ./setup.sh:
#   ./make-app.sh
# Then launch GestureAV from /Applications like any app. No terminal needed.
set -e
cd "$(dirname "$0")"
REPO="$(pwd)"
APP="/Applications/GestureAV.app"

[ -x venv/bin/python ] || { echo "run ./setup.sh first"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>GestureAV</string>
  <key>CFBundleDisplayName</key><string>GestureAV</string>
  <key>CFBundleIdentifier</key><string>local.gestureav</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>GestureAV</string>
  <key>CFBundleIconFile</key><string>GestureAV</string>
  <key>NSCameraUsageDescription</key>
  <string>GestureAV tracks your hands with the camera so you can play music with gestures.</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/GestureAV" << LAUNCH
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"   # app launches get a bare PATH
REPO="$REPO"
cd "\$REPO" || exit 1
# stop any stale instances
pkill -f "gesture_av.py" 2>/dev/null
lsof -ti tcp:8777 2>/dev/null | xargs kill 2>/dev/null
sleep 0.3
# 1) hand tracking -> MIDI (auto-picks the built-in camera, skips iPhone)
"\$REPO/venv/bin/python" gesture_av.py --no-visuals >/tmp/gestureav.log 2>&1 &
TRACK=\$!
# 2) the DAW
"\$REPO/venv/bin/python" -m http.server 8777 --directory "\$REPO/daw" >/dev/null 2>&1 &
SRV=\$!
sleep 1
# 3) Chrome (Safari has no Web MIDI)
open -a "Google Chrome" "http://localhost:8777/index.html" 2>/dev/null \\
  || open -a "Chromium" "http://localhost:8777/index.html" 2>/dev/null \\
  || open "http://localhost:8777/index.html"
# 4) a tiny control window; clicking Quit stops everything
/usr/bin/osascript -e 'display dialog "GestureAV is live.\n\nPinch in front of the camera — Chrome plays it.\n(Presets & knobs are in the Chrome tab.)" buttons {"Quit GestureAV"} default button 1 with title "GestureAV"' >/dev/null 2>&1
kill \$TRACK \$SRV 2>/dev/null
pkill -f "gesture_av.py" 2>/dev/null
LAUNCH
chmod +x "$APP/Contents/MacOS/GestureAV"

cp assets/GestureAV.icns "$APP/Contents/Resources/GestureAV.icns" 2>/dev/null || true

echo "✅ Built $APP"
echo "   Launch it from /Applications (or Spotlight: 'GestureAV')."
echo "   First launch: macOS will ask for Camera access → Allow."
