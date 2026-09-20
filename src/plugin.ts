import streamDeck from "@elgato/streamdeck";

import { AppleMusicAction } from "./actions/apple-music.js";
import { AppVolumeAction } from "./actions/app-volume.js";
import { RestartServerAction } from "./actions/restart-server.js";
import { audioControlClient } from "./audio-control-client.js";
import { startAudioServer } from "./audio-server-process.js";

// Survival net: a transient WebSocket timeout/close rejects a pending request,
// and any such rejection that escapes a background task would otherwise kill the
// Node process — which is exactly what shows up as the key going "offline" and
// never coming back. Audio server errors are always transient (a restart, or
// the plugin outrunning the server's startup), so log and keep running; the
// poll loop reconnects on its own. Never exit on these.
process.on("unhandledRejection", (reason) => {
  streamDeck.logger.warn(`Ignored unhandled rejection to keep the plugin alive: ${String(reason)}`);
});

process.on("uncaughtException", (error) => {
  streamDeck.logger.error(`Ignored uncaught exception to keep the plugin alive: ${String(error)}`);
});

// Launch our own WASAPI backend before connecting; the poll loop retries the
// connection until it is listening.
startAudioServer();

streamDeck.actions.registerAction(new AppVolumeAction());
streamDeck.actions.registerAction(new RestartServerAction());
streamDeck.actions.registerAction(new AppleMusicAction());

// The server was spawned a moment ago and needs a beat to bind its port, so
// keep probing at a steady rate rather than letting a first failure put us on
// the lazy-reconnect backoff ladder — that left every key showing the offline
// glyph for up to ~22s after each Stream Deck start.
audioControlClient
  .waitUntilReachable(30000)
  .then((reachable) => {
    if (!reachable) {
      streamDeck.logger.warn("Audio server did not become reachable within 30s of startup.");
    }
  })
  .catch((error) => {
    streamDeck.logger.warn(`Audio Control startup probe failed: ${String(error)}`);
  });

streamDeck.connect();
