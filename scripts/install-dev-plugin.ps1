$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $root "fun.hiyoko.volumemixer.sdPlugin"
$destination = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\fun.hiyoko.volumemixer.sdPlugin"
$EXE_NAME = "hiyoko-audio-server.exe"

Push-Location $root
try {
  & (Join-Path $PSScriptRoot "build-server.ps1")
  npm run build

  # The bundled server exe is held open by the running audio server, so the copy
  # below cannot replace it while Stream Deck is up. Say so plainly rather than
  # failing halfway through with an access-denied on one file.
  if (Get-Process -Name StreamDeck -ErrorAction SilentlyContinue) {
    throw "Stream Deck is running. Close it first — the audio server it spawned holds $EXE_NAME open, so the install would only half-apply."
  }

  # Replace the destination's *contents*, not the directory itself.
  #
  # Removing the directory and copying the source folder onto it looks
  # equivalent but has two failure modes, both of which happened on 2026-09-20:
  # the removal fails whenever anything holds a handle on the folder (Explorer
  # sitting in it is enough), and `Copy-Item -Recurse` onto a directory that
  # still exists nests the source *inside* it — leaving bin/ and server/ one
  # level too deep and the plugin silently broken.
  #
  # logs/ is kept: it is where the plugin records audio-server outages, and
  # that history is worth more than a clean directory.
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Get-ChildItem -LiteralPath $destination -Force |
    Where-Object { $_.Name -ne "logs" } |
    Remove-Item -Recurse -Force

  Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
  }

  # Verify rather than assume: a partial copy is the failure this script is
  # meant to stop producing.
  foreach ($relative in @("manifest.json", "bin\plugin.js", "server\$EXE_NAME")) {
    $from = Join-Path $source $relative
    $to = Join-Path $destination $relative
    if (-not (Test-Path -LiteralPath $to)) { throw "Install incomplete: $relative is missing from $destination" }
    if ((Get-FileHash $from -Algorithm MD5).Hash -ne (Get-FileHash $to -Algorithm MD5).Hash) {
      throw "Install incomplete: $relative does not match the build"
    }
  }

  Write-Host "Installed to $destination (verified against the build)"
  Write-Host "Start Stream Deck to load it."
} finally {
  Pop-Location
}
