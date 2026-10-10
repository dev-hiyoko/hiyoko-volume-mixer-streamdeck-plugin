import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { audioControlClient } from "../audio-control-client.js";
import { renderKeyImage } from "../key-image.js";

/**
 * One key = one Yamaha URX22 mix bus, switched on and off.
 *
 * The user mutes their mic by turning the bus off, so OFF is drawn as muted.
 * The audio server talks to the interface's control port directly, so Yamaha
 * Device Center does not need to be running. If it is, it holds the port (it is
 * exclusive) and a press fails and says so; the server lets go of the port a
 * minute after the last press so Device Center can be started.
 */
type UrxMixSettings = JsonObject & {
  /** Which bus. Defaults to 1. */
  mix?: number;
  /**
   * What this key last set the bus to. Only written on a press, so the state
   * survives a Stream Deck restart without settings being written in a loop.
   */
  lastOn?: boolean;
};

type MixNumber = 1 | 2;

/**
 * What this plugin last set each bus to, shared by every key on that bus.
 *
 * The device's current state is not read back yet, so it has to be remembered.
 * It is wrong only when something else (Device Center, the front panel)
 * changed the bus since; the next press then sets the opposite of what we
 * remembered, and the key is right again from there.
 */
const mixState = new Map<MixNumber, boolean>();

const ERROR_SHOW_MS = 4000;

function mixOf(settings: UrxMixSettings): MixNumber {
  return Number(settings.mix) === 2 ? 2 : 1;
}

/**
 * A few characters for the key, from the server's error message. The cause the
 * user can act on — Device Center holding the port, the interface unplugged —
 * has to be readable on the key itself, not only in the log.
 */
function errorCaption(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error);
  if (message.includes("in use")) {
    return "使用中";
  }
  if (message.includes("not connected") || message.includes("unplugged")) {
    return "未接続";
  }
  if (message.includes("did not answer")) {
    return "応答なし";
  }
  return "失敗";
}

@action({ UUID: "fun.hiyoko.volumemixer.urx-mix" })
export class UrxMixAction extends SingletonAction<UrxMixSettings> {
  private settingsCache = new Map<string, UrxMixSettings>();
  private lastImage = new Map<string, string>();
  /**
   * Buses with a press in flight. A second press is dropped, not queued — and
   * per bus rather than per key, because two keys on one bus pressed together
   * would both read the same remembered state and send the same value.
   */
  private busy = new Set<MixNumber>();
  /** Keys showing a failure, so a repaint for another key doesn't cover it. */
  private errorUntil = new Map<string, number>();
  private errorReason = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<UrxMixSettings>): Promise<void> {
    this.remember(ev.action.id, ev.payload.settings);
    await this.render(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UrxMixSettings>): Promise<void> {
    this.remember(ev.action.id, ev.payload.settings);
    await this.render(ev.action.id);
  }

  override async onWillDisappear(ev: WillDisappearEvent<UrxMixSettings>): Promise<void> {
    this.settingsCache.delete(ev.action.id);
    this.lastImage.delete(ev.action.id);
    this.errorUntil.delete(ev.action.id);
    this.errorReason.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<UrxMixSettings>): Promise<void> {
    const id = ev.action.id;
    const settings = ev.payload.settings;
    this.remember(id, settings);

    const mix = mixOf(settings);
    if (this.busy.has(mix)) {
      return;
    }
    this.busy.add(mix);
    this.errorUntil.delete(id);

    // Unknown → OFF: the key exists to mute, so the safe first press is the one
    // that silences the mic rather than the one that opens it.
    const known = mixState.get(mix);
    const on = known === undefined ? false : !known;

    let applied = false;
    try {
      await audioControlClient.urxSetMixOn(mix, on);
      applied = true;
      mixState.set(mix, on);
    } catch (error) {
      streamDeck.logger.warn(`URX22 MIX${mix} key failed: ${String(error)}`);
      this.errorUntil.set(id, Date.now() + ERROR_SHOW_MS);
      this.errorReason.set(id, errorCaption(error));
      setTimeout(() => {
        this.render(id).catch(() => {});
      }, ERROR_SHOW_MS + 50);
    } finally {
      this.busy.delete(mix);
    }

    // Saved separately from the device write: the bus has already changed, so a
    // failure to persist must not paint the key as if the press failed.
    if (applied) {
      const next: UrxMixSettings = { ...settings, mix, lastOn: on };
      this.settingsCache.set(id, next);
      try {
        await ev.action.setSettings(next);
      } catch (error) {
        streamDeck.logger.warn(`URX22 MIX${mix} state could not be saved: ${String(error)}`);
      }
    }

    // Every key on this bus shows the same state, not just the one pressed.
    await Promise.all(
      [...this.settingsCache.entries()]
        .filter(([, cached]) => mixOf(cached) === mix)
        .map(([keyId]) => this.render(keyId)),
    );
  }

  /**
   * Caches the key's settings and, if this bus has no remembered state yet,
   * takes the one this key saved on its last press.
   */
  private remember(id: string, settings: UrxMixSettings): void {
    this.settingsCache.set(id, settings);
    const mix = mixOf(settings);
    if (!mixState.has(mix) && typeof settings.lastOn === "boolean") {
      mixState.set(mix, settings.lastOn);
    }
  }

  private async render(id: string): Promise<void> {
    const settings = this.settingsCache.get(id);
    if (!settings) {
      return;
    }
    const mix = mixOf(settings);
    const until = this.errorUntil.get(id);
    if (until && Date.now() < until) {
      await this.show(id, renderKeyImage({ kind: "urx", mix, state: "error", reason: this.errorReason.get(id) }));
      return;
    }
    this.errorUntil.delete(id);
    this.errorReason.delete(id);
    const on = mixState.get(mix);
    const state = on === undefined ? "unknown" : on ? "on" : "off";
    await this.show(id, renderKeyImage({ kind: "urx", mix, state }));
  }

  /** Pushes an image only when it differs — same dedup rule as the other keys. */
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
