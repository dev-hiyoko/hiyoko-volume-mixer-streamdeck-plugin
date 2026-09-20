import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { audioControlClient } from "../audio-control-client.js";
import { restartAudioServer } from "../audio-server-process.js";
import { renderKeyImage } from "../key-image.js";

// One-click recovery for the bundled WASAPI audio server. The old Elgato
// server was fragile (ucrtbase 0xc0000409, hung respawns) and needed an
// elevated Windows-Audio reset; our own Rust server does not have that failure
// mode and is auto-respawned by the plugin, so this key is just a manual bounce:
// kill it and let it come back, then confirm the connection is live again.
type RestartSettings = JsonObject;

@action({ UUID: "fun.hiyoko.volumemixer.restart-server" })
export class RestartServerAction extends SingletonAction<RestartSettings> {
  override async onWillAppear(ev: WillAppearEvent<RestartSettings>): Promise<void> {
    await ev.action.setImage(renderKeyImage({ kind: "restart", status: "idle" }));
    await ev.action.setTitle("");
  }

  override async onKeyDown(ev: KeyDownEvent<RestartSettings>): Promise<void> {
    await ev.action.setImage(renderKeyImage({ kind: "restart", status: "working" }));

    restartAudioServer();
    // Drop the stale socket so the reachability probe forces a fresh connect
    // against the newly spawned server.
    audioControlClient.disconnect();

    let ok = false;
    try {
      ok = await audioControlClient.waitUntilReachable(8000, 500);
    } catch (error) {
      streamDeck.logger.warn(`Audio server restart probe failed: ${String(error)}`);
    }

    await ev.action.setImage(renderKeyImage({ kind: "restart", status: ok ? "ok" : "error" }));
    // Settle back to the idle glyph so the key is ready for next time.
    setTimeout(() => {
      ev.action.setImage(renderKeyImage({ kind: "restart", status: "idle" })).catch(() => {});
    }, 2500);
  }
}

// The reachability probe lives on the client now (waitUntilReachable): plugin
// startup needs exactly the same thing, and two copies of "retry connect until
// it answers" would drift apart.
