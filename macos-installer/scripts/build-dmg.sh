#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
DMG_ROOT="${DIST_DIR}/dmg-root"
DMG_PATH="${DIST_DIR}/Deployment Platform Installer.dmg"
APP_PATH="${DIST_DIR}/Deployment Platform Installer.app"

cd "$ROOT_DIR"
npm run build

rm -rf "$DMG_ROOT" "$DMG_PATH"
mkdir -p "$DMG_ROOT"
cp -R "$APP_PATH" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"

hdiutil create \
  -volname "Deployment Platform Installer" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

hdiutil verify "$DMG_PATH"
echo "$DMG_PATH"
