#!/usr/bin/env bash
# Builds NectarDummy.app for the iOS Simulator — no Xcode project, just swiftc.
# The throwaway/fixture app for exercising the ios-mode chain (SPEC §6.5).
# Usage: ./build.sh [out-dir]   (default: ./out)
set -euo pipefail
cd "$(dirname "$0")"

OUT="${1:-out}"
APP="$OUT/NectarDummy.app"
SDK="$(xcrun -sdk iphonesimulator --show-sdk-path)"

rm -rf "$APP"
mkdir -p "$APP"

xcrun -sdk iphonesimulator swiftc \
  -target arm64-apple-ios17.0-simulator \
  -sdk "$SDK" \
  -parse-as-library \
  -O \
  -o "$APP/NectarDummy" \
  main.swift

cp Info.plist "$APP/Info.plist"
codesign --force --sign - "$APP"
echo "$APP"
