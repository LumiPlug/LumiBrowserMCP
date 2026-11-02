param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
$ErrorActionPreference = 'Stop'
if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'Extension ID must be exactly 32 lowercase letters a-p' }
$dir = Join-Path $env:LOCALAPPDATA 'LumiBrowserMCP'
$exe = Join-Path $dir 'lumi-browser-adapter.exe'
$manifest = Join-Path $dir 'com.lumiplug.browser.json'
$marker = Join-Path $dir '.lumi-install-v1'
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.lumiplug.browser'
foreach ($p in @($dir,$exe,$manifest,$marker,(Join-Path $dir 'uninstall-windows.ps1'))) {
  if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing reparse point: $p" }
}
if ((Test-Path -LiteralPath $dir) -and !(Test-Path -LiteralPath $marker)) { throw 'Existing directory not installer-owned' }
if ((Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'LumiBrowserMCP installer v1')) { throw 'Ownership marker mismatch' }
if (Test-Path $key) {
  if (!(Test-Path -LiteralPath $marker) -or ((Get-Item $key).GetValue('') -ne $manifest)) { throw 'Registration belongs to another installation' }
}
if ((Test-Path -LiteralPath $manifest) -and ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).path -ne $exe)) { throw 'Manifest belongs to another installation' }
$source = Join-Path $PSScriptRoot 'lumi-browser-adapter.exe'
if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Missing adapter executable' }
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Set-Content -LiteralPath $marker -Value 'LumiBrowserMCP installer v1' -Encoding ASCII
Copy-Item -LiteralPath $source -Destination $exe -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-windows.ps1') -Destination (Join-Path $dir 'uninstall-windows.ps1') -Force
$data = @{name='com.lumiplug.browser'; description='Lumi Browser MCP adapter'; path=$exe; type='stdio'; allowed_origins=@("chrome-extension://$ExtensionId/")}
[IO.File]::WriteAllText($manifest, ($data | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "Registered for extension $ExtensionId"
Write-Host "MCP command: $exe"
Write-Host 'MCP arguments: ["--mcp"]. No service was started. Restart Chrome before connecting.'
