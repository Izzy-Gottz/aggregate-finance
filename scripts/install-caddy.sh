#!/bin/sh
# Install the pinned Caddy release, verified against the SHA-512 sums pinned here (from Caddy's
# caddy_2.11.7_checksums.txt, checked against the downloaded files when pinned). Used by CI (so the client-IP red-team,
# scripts/caddy-client-ip.test.ts, runs every time), and fit for the AWS boxes.
#
#   sh scripts/install-caddy.sh [dir]     installs dir/caddy (default ~/.local/bin); refuses on any checksum mismatch
#
# To move to a new version: change VERSION and the sums together, from the release's checksums file, after reading its
# notes. deploy/aws/Caddyfile is tested against this version.
set -eu
VERSION=2.11.7
DEST=${1:-$HOME/.local/bin}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=mac ;;
  *) echo "install-caddy: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "install-caddy: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
file="caddy_${VERSION}_${os}_${arch}.tar.gz"
case "$file" in
  caddy_2.11.7_linux_amd64.tar.gz) sum=a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7 ;;
  caddy_2.11.7_linux_arm64.tar.gz) sum=3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e ;;
  caddy_2.11.7_mac_arm64.tar.gz) sum=68f592df8f0ec058fbdb9b137b64e9a0aa792d28c06e1e3b9ec12d0e7fb371683a54e73ef6d8e6d0dd70dc6b941a5b5d5b73faedd3f89de119ad2eb78bdc668e ;;
  *) echo "install-caddy: no pinned checksum for $file" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/$file" "https://github.com/caddyserver/caddy/releases/download/v${VERSION}/${file}"
if command -v sha512sum >/dev/null 2>&1; then got=$(sha512sum "$tmp/$file" | cut -d' ' -f1); else got=$(shasum -a 512 "$tmp/$file" | cut -d' ' -f1); fi
[ "$got" = "$sum" ] || { echo "install-caddy: checksum mismatch for $file; not installing" >&2; exit 1; }
tar -xzf "$tmp/$file" -C "$tmp" caddy
mkdir -p "$DEST"
install -m 0755 "$tmp/caddy" "$DEST/caddy"
"$DEST/caddy" version
