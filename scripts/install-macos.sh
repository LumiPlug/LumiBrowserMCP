#!/bin/bash
set -euo pipefail
[[ $# == 1 && "$1" =~ ^[a-p]{32}$ ]] || { echo 'Usage: ./install-macos.sh <32-character Chrome extension ID>' >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || { echo 'macOS only' >&2; exit 1; }
umask 077
source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
install_dir="$HOME/Library/Application Support/LumiBrowserMCP"
manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
manifest="$manifest_dir/com.lumiplug.browser.json"
exe="$install_dir/lumi-browser-adapter"
marker="$install_dir/.lumi-install-v1"
for p in "$install_dir" "$manifest_dir" "$manifest" "$exe" "$marker" "$install_dir/uninstall-macos.sh"; do
  [[ ! -L "$p" ]] || { echo "Refusing symlink: $p" >&2; exit 1; }
done
if [[ -e "$install_dir" && ! -f "$marker" ]]; then echo 'Directory is not installer-owned; refusing overwrite' >&2; exit 1; fi
if [[ -f "$marker" && $(cat "$marker") != 'LumiBrowserMCP installer v1' ]]; then echo 'Ownership marker mismatch' >&2; exit 1; fi
if [[ -e "$manifest" ]]; then
  [[ -f "$marker" && $(/usr/bin/plutil -extract path raw -o - "$manifest") == "$exe" ]] || { echo 'Manifest belongs to another installation' >&2; exit 1; }
fi
[[ -f "$source_dir/lumi-browser-adapter" ]] || { echo 'Missing adapter executable' >&2; exit 1; }
mkdir -p "$install_dir" "$manifest_dir"
chmod 700 "$install_dir"
printf '%s\n' 'LumiBrowserMCP installer v1' > "$marker"
staged=$(mktemp "$install_dir/.adapter.XXXXXX")
tmp=$(mktemp "$manifest_dir/.lumi.XXXXXX")
trap 'rm -f "$staged" "$tmp"' EXIT
/usr/bin/install -m 700 "$source_dir/lumi-browser-adapter" "$staged"
mv -f "$staged" "$exe"
cp "$source_dir/uninstall-macos.sh" "$install_dir/uninstall-macos.sh"
chmod 700 "$install_dir/uninstall-macos.sh"
/usr/bin/plutil -create json "$tmp"
/usr/bin/plutil -insert name -string com.lumiplug.browser "$tmp"
/usr/bin/plutil -insert description -string 'Lumi Browser MCP adapter' "$tmp"
/usr/bin/plutil -insert path -string "$exe" "$tmp"
/usr/bin/plutil -insert type -string stdio "$tmp"
/usr/bin/plutil -insert allowed_origins -json "[\"chrome-extension://$1/\"]" "$tmp"
mv -f "$tmp" "$manifest"
printf 'Registered for extension %s\nMCP command: %s\nMCP arguments: ["--mcp"]\nNo service was started. Restart Chrome before connecting.\n' "$1" "$exe"
