import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import streamDeck from "@elgato/streamdeck";

// Our own WASAPI audio backend replaces the Elgato server. The plugin launches
// it on startup and connects to it over the port below. 1845 sits next to the
// Elgato server's 1844 so both can coexist while the user migrates off Elgato.
export const AUDIO_SERVER_PORT = 1845;

const EXE_NAME = "hiyoko-audio-server.exe";
// The bundled plugin runs from bin/plugin.js, so the server sits at
// ../server/hiyoko-audio-server.exe relative to this module.
const EXE_PATH = join(dirname(__dirname), "server", EXE_NAME);

// If the server dies unexpectedly, respawn with a small backoff. A fast exit
// (e.g. the port is already held by a server from a previous plugin instance)
// is not an error — we just connect to whoever owns the port.
const RESPAWN_DELAY_MS = 2000;
const FAST_EXIT_MS = 1500;

let child: ChildProcess | undefined;
let stopped = false;

/**
 * Launches the bundled audio server and keeps it running for the plugin's
 * lifetime. Safe to call once at startup. The child is not detached, so it exits
 * with the plugin (no orphaned server surviving a Stream Deck restart).
 */
export function startAudioServer(): void {
  stopped = false;
  spawnOnce();
}

export function stopAudioServer(): void {
  stopped = true;
  if (child) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    child = undefined;
  }
}

/**
 * Manual recovery for the server-restart key: kill the current server and spawn
 * a fresh one. The delay lets the old process release port 1845 before the new
 * one binds it.
 */
export function restartAudioServer(): void {
  stopAudioServer();
  setTimeout(startAudioServer, 500);
}

function spawnOnce(): void {
  if (!existsSync(EXE_PATH)) {
    streamDeck.logger.error(`Audio server binary missing at ${EXE_PATH} — build it with the server build step.`);
    return;
  }

  const startedAt = Date.now();
  try {
    child = spawn(EXE_PATH, [String(AUDIO_SERVER_PORT)], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (error) {
    streamDeck.logger.error(`Failed to spawn audio server: ${String(error)}`);
    return;
  }

  child.on("error", (error) => {
    streamDeck.logger.warn(`Audio server process error: ${String(error)}`);
  });

  child.on("exit", (code) => {
    child = undefined;
    if (stopped) {
      return;
    }
    const ranBriefly = Date.now() - startedAt < FAST_EXIT_MS;
    if (ranBriefly) {
      // Almost certainly the port is already owned by another instance — that
      // one serves the plugin fine, so don't fight it with a respawn loop.
      streamDeck.logger.info(`Audio server exited quickly (code ${code}); assuming another instance owns the port.`);
      return;
    }
    streamDeck.logger.warn(`Audio server exited (code ${code}); respawning.`);
    setTimeout(spawnOnce, RESPAWN_DELAY_MS);
  });
}
