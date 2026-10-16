#!/bin/bash
# Build an unsigned, local-development ColeoInbox.app bundle from the SwiftPM executable.
set -euo pipefail

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
require_cmd swift
require_cmd codesign
require_cmd xcrun

cd "$(dirname "$0")/.."
VERSION="${COLEO_VERSION:-$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' ../../package.json | head -n 1)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "COLEO_VERSION must be a numeric release version" >&2
  exit 1
fi
swift build -c release
BIN="$(swift build -c release --show-bin-path)/ColeoInboxMac"
APP=".build/ColeoInbox.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ColeoInboxMac"
cp "Sources/ColeoInboxMac/Resources/modules.json" "$APP/Contents/Resources/modules.json"
cp "Artwork/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
xcrun actool Artwork/AppIcon.icon --compile "$APP/Contents/Resources" \
  --platform macosx --minimum-deployment-target 14.0 --target-device mac \
  --app-icon AppIcon --include-all-app-icons \
  --output-partial-info-plist .build/icon-info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ColeoInboxMac</string>
  <key>CFBundleIdentifier</key><string>dev.coleo.inbox-mac</string>
  <key>CFBundleName</key><string>Coleo Workbench</string>
  <key>CFBundleDisplayName</key><string>Coleo Workbench</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "Built $APP"
