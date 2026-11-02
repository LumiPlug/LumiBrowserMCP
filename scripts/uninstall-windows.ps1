$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'LumiBrowserMCP'
$manifest = Join-Path $dir 'com.lumiplug.browser.json'
$marker = Join-Path $dir '.lumi-install-v1'
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.lumiplug.browser'
foreach ($p in @($dir,$marker,$manifest)) {
  if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing reparse point: $p" }
}
if (!(Test-Path -LiteralPath $marker) -or ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'LumiBrowserMCP installer v1')) { throw 'No owned installation; nothing removed' }
if ((Test-Path -LiteralPath $manifest) -and ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).path -ne (Join-Path $dir 'lumi-browser-adapter.exe'))) { throw 'Manifest ownership changed; refusing removal' }
if (Test-Path $key) {
  if ((Get-Item $key).GetValue('') -ne $manifest) { throw 'Registration ownership changed; refusing removal' }
  Remove-Item -LiteralPath $key # No recursion: refuse unexpected subkeys.
}
# Remove only known files; retain runtime data and never recursively remove directories.
foreach ($name in @('com.lumiplug.browser.json','lumi-browser-adapter.exe','uninstall-windows.ps1','.lumi-install-v1')) {
  $p = Join-Path $dir $name
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p }
}
if (!(Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir }
Write-Host 'Removed installer-owned files. Runtime data retained. Close MCP clients and Chrome to stop existing adapter processes.'
