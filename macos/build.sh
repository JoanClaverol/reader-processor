#!/bin/sh
# Build the native dashboard app into ~/Applications/Reader Processor.app.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
if [ "$#" -eq 0 ]; then
  APP="$HOME/Applications/Reader Processor.app"
  # Replace the former menu-bar bundle instead of leaving a duplicate result
  # in Spotlight after upgrading.
  rm -rf "$HOME/Applications/ReaderProcessor.app"
else
  APP="$1"
fi
ICONSET="$HERE/.build/AppIcon.iconset"

rm -rf "$APP"
rm -rf "$HERE/.build"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$ICONSET"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Reader Processor</string>
  <key>CFBundleDisplayName</key><string>Reader Processor</string>
  <key>CFBundleIdentifier</key><string>com.joanclaverol.reader-processor</string>
  <key>CFBundleExecutable</key><string>ReaderProcessor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>ReaderProcessorRepoRoot</key><string>REPO_ROOT_PLACEHOLDER</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.joanclaverol.reader-processor.authenticate</string>
      <key>CFBundleURLSchemes</key>
      <array><string>reader-processor</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
/usr/libexec/PlistBuddy -c "Set :ReaderProcessorRepoRoot $REPO_ROOT" "$APP/Contents/Info.plist"

# Build every required icon representation from the editable vector source.
for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do
  set -- $spec
  sips -s format png -z "$1" "$1" "$HERE/AppIcon.svg" --out "$ICONSET/$2" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Without an explicit -target, swiftc stamps the build host's macOS as the
# minimum, so the LSMinimumSystemVersion above would be a decorative claim the
# binary contradicts.
swiftc -O -target "$(uname -m)-apple-macos13.0" -framework AppKit \
  -o "$APP/Contents/MacOS/ReaderProcessor" "$HERE/ReaderProcessorMenu.swift"

# Ad-hoc sign so Gatekeeper doesn't nag about a locally built bundle.
codesign --force --sign - "$APP"

# Replacing an app bundle in place can leave Spotlight and Launch Services
# pointing at the deleted bundle inode until their next background scan.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f "$APP"
mdimport "$APP" >/dev/null 2>&1 || true
rm -rf "$HERE/.build"

echo "Built $APP"
