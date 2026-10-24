#!/bin/bash
# Installs or updates the latest macOS release in /Applications from the Terminal.
# The download is checked against the release's SHA256SUMS.txt, and a Developer ID signed build
# must pass codesign and Gatekeeper checks before it replaces the installed app.
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

release="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")"
asset_url() {
  printf '%s' "$release" \
    | grep -oE "\"browser_download_url\": *\"[^\"]*$1\"" \
    | head -n1 \
    | sed 's/.*"\(https[^"]*\)"/\1/'
}

# Releases ship one universal bundle; an arch-specific one is used if that ever changes
url="$(asset_url "_(universal|$arch)\.app\.tar\.gz")"
sums_url="$(asset_url "/SHA256SUMS\.txt")"
if [[ -z "$url" ]]; then
  echo "Couldn't find a macOS build in the latest release" >&2
  exit 1
fi
if [[ -z "$sums_url" ]]; then
  echo "The latest release has no SHA256SUMS.txt; refusing to install an unverified download" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $url"
curl -fL --progress-bar -o "$tmp/app.tar.gz" "$url"
curl -fsSL -o "$tmp/SHA256SUMS.txt" "$sums_url"

name="$(basename "$url")"
expected="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS.txt")"
actual="$(shasum -a 256 "$tmp/app.tar.gz" | awk '{ print $1 }')"
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
  echo "Checksum mismatch for $name; not installing" >&2
  exit 1
fi
echo "Checksum verified"

mkdir "$tmp/out"
tar -xzf "$tmp/app.tar.gz" -C "$tmp/out"
app="$tmp/out/$APP"

# A Developer ID signed (and notarized) build must verify. Only builds that carry no real
# signature at all get the ad-hoc signature Apple Silicon needs to launch them.
if codesign -dv "$app" 2>&1 | grep -q "^Authority=Developer ID Application"; then
  if ! codesign --verify --deep --strict "$app" || ! spctl --assess --type execute "$app"; then
    echo "$APP is signed but failed signature or Gatekeeper checks; not installing" >&2
    exit 1
  fi
  echo "Signature and notarization verified"
  signed=1
else
  signed=0
fi

if pgrep -xq "dbms-tool"; then
  echo "Quitting running dbms-tool"
  osascript -e 'quit app "dbms-tool"' || true
  sleep 1
fi

rm -rf "$DEST/$APP"
ditto "$app" "$DEST/$APP"
if [[ "$signed" == 0 ]]; then
  # Unsigned builds: curl doesn't quarantine downloads, but clear it in case the archive
  # picked it up some other way, then add the ad-hoc signature
  xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
  codesign --force --deep --sign - "$DEST/$APP"
fi

echo "Installed to $DEST/$APP"
open "$DEST/$APP"
