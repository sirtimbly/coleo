#!/bin/bash
# Package an existing app; release signing uses the configured Keychain identity.
set -euo pipefail
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
require_cmd codesign
require_cmd ditto
require_cmd xcrun
APP="${1:?usage: package-release.sh APP OUTPUT.zip}"
OUTPUT="${2:?usage: package-release.sh APP OUTPUT.zip}"
: "${COLEO_SIGNING_IDENTITY:?Set COLEO_SIGNING_IDENTITY to a Developer ID Application identity}"
: "${COLEO_NOTARY_PROFILE:?Set COLEO_NOTARY_PROFILE to a notarytool Keychain profile}"
[[ -d "$APP/Contents" ]] || { echo "App bundle not found: $APP" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
codesign --force --options runtime --timestamp --sign "$COLEO_SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"
ditto -c -k --keepParent "$APP" "$WORK/submission.zip"
xcrun notarytool submit "$WORK/submission.zip" --keychain-profile "$COLEO_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
mkdir -p "$(dirname "$OUTPUT")"
ditto -c -k --keepParent "$APP" "$OUTPUT"
echo "Packaged signed and notarized app: $OUTPUT"
