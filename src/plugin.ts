import streamDeck from "@elgato/streamdeck";

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

audioControlClient.connect().catch((error) => {
  streamDeck.logger.warn(`Audio Control WebSocket is not ready yet: ${String(error)}`);
});

streamDeck.connect();
