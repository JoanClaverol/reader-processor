#!/bin/sh
# Build the menu bar app into ~/Applications/ReaderProcessor.app.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
APP="${1:-$HOME/Applications/ReaderProcessor.app}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ReaderProcessor</string>
  <key>CFBundleDisplayName</key><string>ReaderProcessor</string>
  <key>CFBundleIdentifier</key><string>com.joanclaverol.reader-processor.menu</string>
  <key>CFBundleExecutable</key><string>ReaderProcessor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar only: no Dock icon, no app switcher entry. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Without an explicit -target, swiftc stamps the build host's macOS as the
# minimum, so the LSMinimumSystemVersion above would be a decorative claim the
# binary contradicts.
swiftc -O -target "$(uname -m)-apple-macos13.0" \
  -o "$APP/Contents/MacOS/ReaderProcessor" "$HERE/ReaderProcessorMenu.swift"

# Ad-hoc sign so Gatekeeper doesn't nag about a locally built bundle.
codesign --force --sign - "$APP"

echo "Built $APP"
