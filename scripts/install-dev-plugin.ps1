$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $root "fun.hiyoko.volumemixer.sdPlugin"
$destination = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\fun.hiyoko.volumemixer.sdPlugin"

Push-Location $root
try {
  & (Join-Path $PSScriptRoot "build-server.ps1")
  npm run build

  if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
  }

  Copy-Item -LiteralPath $source -Destination $destination -Recurse
  Write-Host "Installed to $destination"
  Write-Host "Restart Stream Deck if the plugin does not appear or old code is still loaded."
} finally {
  Pop-Location
}
