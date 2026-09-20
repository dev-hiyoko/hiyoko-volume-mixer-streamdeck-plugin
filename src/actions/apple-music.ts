import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { audioControlClient } from "../audio-control-client.js";
import { renderKeyImage } from "../key-image.js";

/**
 * One key = one Apple Music playlist.
 *
 * Pressing it starts that playlist (shuffled, if the key is set that way), and
 * pressing it again pauses and resumes. Apple Music is launched first if it
 * isn't running.
 */
type PlaylistSettings = JsonObject & {
  /** Apple's library database id. Survives renaming the playlist. */
  playlistId?: string;
  /** The name as it was when the key was configured — display, and fallback. */
  playlistName?: string;
  /** Start shuffled. Defaults to true: it is why this key exists. */
  shuffle?: boolean;
};

/**
 * Which playlist this plugin last started, shared across every key.
 *
 * Apple Music does not tell anyone what playlist is playing — SMTC reports the
 * track, and the window reports no usable playlist name — so "is my playlist
 * the one playing?" cannot be read back and has to be remembered. Playing vs
 * paused *is* read from SMTC, so only the identity is a guess.
 *
 * The guess is wrong in exactly one case: the user starts something else from
 * inside Apple Music itself, and then presses a playlist key. That press pauses
 * instead of starting; a second press does the right thing. Detecting it would
 * mean tracking individual tracks, which costs more than the mistake does.
 */
let lastStartedPlaylistId: string | undefined;

const POLL_MS = 2000;

@action({ UUID: "fun.hiyoko.volumemixer.apple-music" })
export class AppleMusicAction extends SingletonAction<PlaylistSettings> {
  private settingsCache = new Map<string, PlaylistSettings>();
  private lastImage = new Map<string, string>();
  /**
   * Keys with a press still running. Starting a playlist takes ~2s (it drives
   * the app's UI), which is long enough for an impatient second press to arrive
   * — and two overlapping starts fight over the same window.
   */
  private busy = new Set<string>();
  /** Keys showing a failure, so the poll doesn't immediately repaint over it. */
  private errorUntil = new Map<string, number>();
  private pollTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.pollLoop();
  }

  private pollLoop(): void {
    this.pollTimer = setTimeout(() => {
      this.refreshAll()
        .catch((error) => streamDeck.logger.warn(`Apple Music refresh failed: ${String(error)}`))
        .finally(() => this.pollLoop());
    }, POLL_MS);
  }

  override async onWillAppear(ev: WillAppearEvent<PlaylistSettings>): Promise<void> {
    this.settingsCache.set(ev.action.id, ev.payload.settings);
    await this.render(ev.action.id, ev.payload.settings);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlaylistSettings>): Promise<void> {
    this.settingsCache.set(ev.action.id, ev.payload.settings);
    await this.render(ev.action.id, ev.payload.settings);
  }

  override async onWillDisappear(ev: WillDisappearEvent<PlaylistSettings>): Promise<void> {
    this.settingsCache.delete(ev.action.id);
    this.lastImage.delete(ev.action.id);
    this.errorUntil.delete(ev.action.id);
    this.busy.delete(ev.action.id);
  }

  /** Property inspector: fill the playlist picker. */
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PlaylistSettings>): Promise<void> {
    const payload = ev.payload as { request?: string } | undefined;
    if (payload?.request !== "getPlaylists") {
      return;
    }
    try {
      const playlists = await audioControlClient.appleMusicListPlaylists();
      await streamDeck.ui.sendToPropertyInspector({ event: "playlists", playlists });
    } catch (error) {
      // Tell the inspector why the list is empty. The usual reason is that
      // Apple Music isn't running — the playlists are read out of its window.
      await streamDeck.ui.sendToPropertyInspector({
        event: "playlists",
        playlists: [],
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }

  override async onKeyDown(ev: KeyDownEvent<PlaylistSettings>): Promise<void> {
    const id = ev.action.id;
    const settings = ev.payload.settings;
    this.settingsCache.set(id, settings);

    const playlistId = settings.playlistId?.trim();
    const playlistName = settings.playlistName?.trim();
    if (!playlistId || !playlistName) {
      await this.show(id, renderKeyImage({ kind: "music", name: "", shuffle: false, status: "unset" }));
      return;
    }

    // A second press while the first is still working would race it for the
    // app's window; ignore rather than queue, so a double tap can't start the
    // playlist twice.
    if (this.busy.has(id)) {
      return;
    }
    this.busy.add(id);
    this.errorUntil.delete(id);

    const shuffle = settings.shuffle !== false;
    try {
      const status = await audioControlClient.appleMusicStatus();
      const isMine = lastStartedPlaylistId === playlistId;

      if (isMine && status.playing) {
        await audioControlClient.appleMusicPause();
        await this.paint(id, playlistName, shuffle, "paused");
        return;
      }

      if (isMine && status.paused) {
        // Resume where it stopped. Re-selecting the playlist here would restart
        // it from the top, which is not what a second press should do.
        await audioControlClient.appleMusicResume();
        await this.paint(id, playlistName, shuffle, "playing");
        return;
      }

      // Nothing of ours is playing: start this playlist. Paint "working" first
      // — this takes ~2s, and a key that looks inert invites a second press.
      await this.paint(id, playlistName, shuffle, "working");
      await audioControlClient.appleMusicPlayPlaylist(playlistId, playlistName, shuffle);
      lastStartedPlaylistId = playlistId;
      await this.paint(id, playlistName, shuffle, "playing");
    } catch (error) {
      // Never fail silently: the user pressed a key and nothing happened, and
      // the reason (Apple Music closed, playlist renamed away, an AutomationId
      // that moved in an app update) is only visible here.
      streamDeck.logger.warn(`Apple Music key failed: ${String(error)}`);
      this.errorUntil.set(id, Date.now() + 4000);
      await this.paint(id, playlistName, shuffle, "error");
    } finally {
      this.busy.delete(id);
    }
  }

  /** Repaints every placed key from the current transport state. */
  private async refreshAll(): Promise<void> {
    if (this.actions.length === 0) {
      return;
    }

    let status: { playing: boolean; paused: boolean } | undefined;
    try {
      status = await audioControlClient.appleMusicStatus();
    } catch {
      // Server unreachable — leave the keys as they are rather than flashing an
      // error for something the volume keys already report.
      return;
    }

    await Promise.all(
      this.actions.map(async (actionInstance) => {
        const settings = this.settingsCache.get(actionInstance.id);
        if (!settings) {
          return;
        }
        await this.render(actionInstance.id, settings, status);
      }),
    );
  }

  private async render(
    id: string,
    settings: PlaylistSettings,
    status?: { playing: boolean; paused: boolean },
  ): Promise<void> {
    if (this.busy.has(id)) {
      return;
    }
    const until = this.errorUntil.get(id);
    if (until && Date.now() < until) {
      return;
    }

    const playlistId = settings.playlistId?.trim();
    const playlistName = settings.playlistName?.trim();
    if (!playlistId || !playlistName) {
      await this.show(id, renderKeyImage({ kind: "music", name: "", shuffle: false, status: "unset" }));
      return;
    }

    const shuffle = settings.shuffle !== false;
    const isMine = lastStartedPlaylistId === playlistId;
    const state = !status || !isMine ? "idle" : status.playing ? "playing" : status.paused ? "paused" : "idle";
    await this.paint(id, playlistName, shuffle, state);
  }

  private async paint(
    id: string,
    name: string,
    shuffle: boolean,
    status: "idle" | "playing" | "paused" | "working" | "error",
  ): Promise<void> {
    await this.show(id, renderKeyImage({ kind: "music", name, shuffle, status }));
  }

  /** Pushes an image only when it differs — same dedup rule as the mixer keys. */
  private async show(id: string, image: string): Promise<void> {
    if (this.lastImage.get(id) === image) {
      return;
    }
    const target = this.actions.find((candidate) => candidate.id === id);
    if (!target) {
      return;
    }
    this.lastImage.set(id, image);
    await target.setImage(image);
    await target.setTitle("");
  }
}
