#!/bin/bash
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'macOS only' >&2; exit 1; }
install_dir="$HOME/Library/Application Support/LumiBrowserMCP"
manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.lumiplug.browser.json"
marker="$install_dir/.lumi-install-v1"
[[ ! -L "$install_dir" && ! -L "$marker" && -f "$marker" && $(cat "$marker") == 'LumiBrowserMCP installer v1' ]] || { echo 'No owned installation; nothing removed' >&2; exit 1; }
if [[ -e "$manifest" ]]; then
  [[ ! -L "$manifest" && $(/usr/bin/plutil -extract path raw -o - "$manifest") == "$install_dir/lumi-browser-adapter" ]] || { echo 'Manifest ownership changed; refusing removal' >&2; exit 1; }
  rm -- "$manifest"
fi
# Never recursively remove directories or runtime credentials/data.
rm -f -- "$install_dir/lumi-browser-adapter" "$install_dir/uninstall-macos.sh" "$marker"
rmdir -- "$install_dir" 2>/dev/null || true
echo 'Removed installer-owned files. Close MCP clients and Chrome to stop existing adapter processes. Runtime data was retained.'
