#!/bin/bash
# Installs the latest macOS release into /Applications without tripping Gatekeeper.
# Browsers tag downloads with com.apple.quarantine, which makes macOS block apps that aren't
# notarized. curl doesn't set that attribute, so an app fetched this way opens normally.
#
#   curl -fsSL https://raw.githubusercontent.com/asofianidis/dbms-tool/main/scripts/install-mac.sh | bash
set -euo pipefail

REPO="asofianidis/dbms-tool"
APP="dbms-tool.app"
DEST="/Applications"

case "$(uname -m)" in
  arm64) arch="aarch64" ;;
  x86_64) arch="x64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Releases ship one universal bundle; an arch-specific one is used if that ever changes
url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oE "\"browser_download_url\": *\"[^\"]*_(universal|$arch)\.app\.tar\.gz\"" \
  | head -n1 \
  | sed 's/.*"\(https[^"]*\)"/\1/')"
if [[ -z "$url" ]]; then
  echo "Couldn't find a macOS build in the latest release" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $url"
curl -fL --progress-bar -o "$tmp/app.tar.gz" "$url"
mkdir "$tmp/out"
tar -xzf "$tmp/app.tar.gz" -C "$tmp/out"

if pgrep -xq "dbms-tool"; then
  echo "Quitting running dbms-tool"
  osascript -e 'quit app "dbms-tool"' || true
  sleep 1
fi

rm -rf "$DEST/$APP"
ditto "$tmp/out/$APP" "$DEST/$APP"
# Clear quarantine in case the archive picked it up some other way
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
# Unsigned builds still need an ad-hoc signature to launch on Apple Silicon
if ! codesign --verify --deep "$DEST/$APP" 2>/dev/null; then
  codesign --force --deep --sign - "$DEST/$APP"
fi

echo "Installed to $DEST/$APP"
open "$DEST/$APP"
