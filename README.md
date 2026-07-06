# Hiyoko Volume Mixer

A Stream Deck plugin for **per-application and per-device volume / mute on Windows** — backed by its own lightweight Rust + WASAPI server, so it does **not** depend on the Elgato Volume Controller (`ElgatoAudioControlServer`).

日本語の使い方ガイドは [`docs/usage.md`](docs/usage.md) を参照してください。

## Why

Windows exposes each audio stream as a *session* via Core Audio (WASAPI). Some tools — including Elgato's audio server — group sessions by their host **process**, which silently merges genuinely different streams that happen to share one process. The classic case: an optical/SPDIF interface monitor and a mixer's line input are both hosted by the Windows audio service, so they collapse into a single, ambiguous control.

This project talks to Core Audio directly and addresses **every session individually**, so those streams get their own independent volume and mute.

## Features

- **Per-session control** of every Windows audio session, including device-monitor sessions other tools merge together.
- **Auto-detected slots** — a key follows whatever app currently occupies its slot; no fixed per-app profiles. Relaunching an app (new PID) just works.
- **Group by label** — give two sessions the same custom name and they are controlled together; same detected name groups automatically.
- **Recently-active grace** — an app that made sound briefly stays on its slot for ~60s instead of vanishing the instant it goes quiet.
- **Master control** — a key can target the system default output device.
- **Saved per-device state** — volume is restored per output device; mute is restored on app relaunch (and never fights a manual change you make elsewhere).
- **Self-healing backend** — the plugin spawns the audio server, respawns it if it exits, and offers a one-tap manual restart key.

## Architecture

```
Stream Deck plugin (Node / TypeScript)   ← actions, key rendering, settings
        │  JSON-RPC over ws://127.0.0.1:1845
        ▼
hiyoko-audio-server (Rust / WASAPI)       ← enumerates & controls audio sessions
```

- **`fun.hiyoko.volumemixer.sdPlugin/`** — the Stream Deck plugin (bundled from `src/` with esbuild).
- **`audio-server/`** — the Rust server crate. A ~0.5 MB, dependency-free executable that the plugin launches automatically and bundles at `…/server/hiyoko-audio-server.exe`.

The plugin never touches the Elgato server; the two use different ports (Elgato `1844`, this server `1845`) and can coexist during migration.

## Requirements

- **Windows 10 / 11**
- **Stream Deck** app (physical, Mobile, or Virtual Stream Deck)
- Build toolchain:
  - **Node.js** (managed by [mise](https://mise.jdx.dev/))
  - **Rust** MSVC toolchain + **Visual Studio C++ Build Tools** (the MSVC linker and Windows SDK). Install once with:
    ```powershell
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    ```

## Build & install

```powershell
mise install                          # Node + Rust toolchains
.\scripts\install-dev-plugin.ps1      # builds the server + plugin and installs to Stream Deck
```

`install-dev-plugin.ps1` runs the Rust build (`scripts/build-server.ps1`), bundles the plugin, and copies everything into `%APPDATA%\Elgato\StreamDeck\Plugins\`. Restart Stream Deck if old code stays loaded.

Individual steps are also available as mise tasks:

```powershell
mise run build-server   # cargo build --release + copy exe into the plugin
mise run build          # esbuild the plugin
mise run check          # tsc --noEmit
mise run verify         # check + build-server + build
```

## Usage (short)

Drop the **アプリ音量ミキサー** (App Volume Mixer) action onto a key. Each key has a role (volume up / down / mute) and a **slot** — slot 0 is the most-active app, slot 1 the next, and so on. Assign the same slot number to three keys to make a volume-up / volume-down / mute strip for one app. The **音声サーバー再起動** (Restart Audio Server) action is a one-tap recovery button for the backend.

Detection options (active-only vs all, grouping, volume step, poll interval), per-app renames, mute-key icons, and slot priority are configured in any key's Property Inspector and shared across all keys. See [`docs/usage.md`](docs/usage.md) for the full guide.

## License

[MIT](LICENSE)
