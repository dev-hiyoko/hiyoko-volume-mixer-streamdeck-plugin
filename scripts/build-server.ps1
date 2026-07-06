$ErrorActionPreference = "Stop"

# Builds the Rust WASAPI audio server (release) and copies the exe into the
# plugin bundle at fun.hiyoko.volumemixer.sdPlugin/server/, where the plugin
# spawns it from at runtime.

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverDir = Join-Path $root "audio-server"
$destDir = Join-Path $root "fun.hiyoko.volumemixer.sdPlugin\server"
$exe = Join-Path $serverDir "target\release\hiyoko-audio-server.exe"

Push-Location $serverDir
try {
  mise exec -- cargo build --release
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $destDir "hiyoko-audio-server.exe") -Force
Write-Host "Bundled audio server -> $destDir"
