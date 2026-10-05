#!/usr/bin/env sh
# Builds the launcher for Windows (ARM64 and x64), macOS and Linux. Needs Go 1.21+ only.
set -e
cd "$(dirname "$0")"
mkdir -p dist
build() { # os arch outfile ldflags
  echo "→ $3"
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -ldflags "$4" -o "dist/$3" .
}
build windows arm64 ytam-launcher-windows-arm64.exe "-H=windowsgui"
build windows amd64 ytam-launcher-windows-amd64.exe "-H=windowsgui"
build linux   amd64 ytam-launcher-linux-amd64 ""
build darwin  arm64 ytam-launcher-macos-arm64 ""
build darwin  amd64 ytam-launcher-macos-amd64 ""
echo done; ls -la dist
