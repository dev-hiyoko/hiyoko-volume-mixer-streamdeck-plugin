# Stream Deck Audio Mixer

Stream Deck のアクションから、Elgato Volume Controller が起動する `ElgatoAudioControlServer` の WebSocket API (`ws://127.0.0.1:1844`) を利用する実験用プラグインです。

## 前提

- Windows
- Stream Deck 7.1 以降
- Elgato Marketplace の公式 `Volume Controller` プラグイン
- `ElgatoAudioControlServer.exe` が起動していること

## アクション

- `Master Status`: `currentSystemDefaultDeviceVolumeChanged` と `currentSystemDefaultDeviceMuteChanged` を受信して、マスター音量とミュート状態をキーに表示します。
- `JSON-RPC Command`: Property Inspector に設定した JSON-RPC メソッドと params を `ws://127.0.0.1:1844` に送信します。

## 開発

```powershell
mise install
mise run install
mise run verify
```

または Node.js が直接入っている環境では:

```powershell
npm install
npm run build
```

ビルド後、`fun.hiyoko.audiomixer.sdPlugin` を Stream Deck のプラグインフォルダへ配置するか、Elgato CLI の開発フローで読み込んでください。

Git は mise registry にないため、必要なら別途インストールしてください。

```powershell
winget install --id Git.Git -e
```

参考: https://zenn.dev/yuichiroharai/scraps/d54be9703d4004
