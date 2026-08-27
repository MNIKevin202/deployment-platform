#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
APP_NAME="Deployment Platform Installer"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
ELECTRON_APP="${ROOT_DIR}/node_modules/electron/dist/Electron.app"
APP_RESOURCE_DIR="${APP_PATH}/Contents/Resources/app"
INFO_PLIST="${APP_PATH}/Contents/Info.plist"

if [ ! -d "$ELECTRON_APP" ]; then
  echo "Electron runtime not found. Run npm install in macos-installer first." >&2
  exit 1
fi

rm -rf "$APP_PATH"
mkdir -p "$DIST_DIR"
ditto "$ELECTRON_APP" "$APP_PATH"

/usr/libexec/PlistBuddy -c "Set :CFBundleName ${APP_NAME}" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${APP_NAME}" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.deploymentplatform.installer" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 0.1.0" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.0" "$INFO_PLIST"

rm -rf "$APP_RESOURCE_DIR"
mkdir -p "$APP_RESOURCE_DIR"
cp "${ROOT_DIR}/package.json" "$APP_RESOURCE_DIR/package.json"
cp "${ROOT_DIR}/package-lock.json" "$APP_RESOURCE_DIR/package-lock.json"
cp -R "${ROOT_DIR}/src" "$APP_RESOURCE_DIR/src"
mkdir -p "$APP_RESOURCE_DIR/node_modules"
rsync -a \
  --exclude='electron/dist/*.zip' \
  --exclude='electron/dist/Electron.app' \
  "${ROOT_DIR}/node_modules/" "$APP_RESOURCE_DIR/node_modules/"

codesign --force --deep --sign - "$APP_PATH" >/dev/null
echo "$APP_PATH"
