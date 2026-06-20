import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { audioControlClient, clampVolume } from "../audio-control-client.js";
import {
  getAutoAppStateKey,
  mirrorSavedAutoAppState,
  scheduleAutoAppSync,
  updateSavedAutoAppState,
} from "../auto-app-state.js";
import { getGlobalMixerSettings } from "../global-settings.js";
import { renderKeyImage } from "../key-image.js";
import { appNameKey, listDetectedAppNames, resolveApplicationTargetGroup } from "./app-target.js";

type MixerRole = "volume-up" | "volume-down" | "mute-toggle";

type KeyView = {
  setTitle(title: string): Promise<void>;
  setImage(image: string): Promise<void>;
};

// Per-key settings only. Detection options, the volume step, and app-name
// aliases are shared across all keys and live in global settings.
type AppMixerSettings = JsonObject & {
  /** What the key does. Defaults to volume-up. */
  role?: string;
  /** Target the system default output device (master) instead of an app slot. */
  master?: boolean;
  /** Position in the auto-detected group list this key owns. */
  slot?: number;
};

function normalizeRole(role: string | undefined): MixerRole {
  return role === "volume-down" || role === "mute-toggle" ? role : "volume-up";
}

// Long-press repeat for the volume keys: first step on press, then auto-repeat
// while held. REPEAT_DELAY keeps a quick tap from repeating.
const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 130;
// Safety stops for a hold that never sees its key-up (a missed/dropped key-up
// would otherwise repeat forever — the "volume keeps dropping" bug). The volume
// hitting 0 or 100% also stops it (see startHold), so these are just backstops.
const MAX_REPEATS = 80;
const MAX_HOLD_MS = 8000;

@action({ UUID: "fun.hiyoko.volumemixer.app-volume" })
export class AppVolumeAction extends SingletonAction<AppMixerSettings> {
  private titleTimer?: NodeJS.Timeout;
  // Per-key auto-repeat timers, keyed by action instance id.
  private holdTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();

    // Global (shared) settings changed — slot ordering / step may differ now.
    streamDeck.settings.onDidReceiveGlobalSettings(() => {
      this.scheduleTitleRefresh();
    });

    // The audio server's change notifications are unreliable, so poll for newly
    // started / stopped audio apps. The interval is a global setting (CPU cost),
    // re-read each cycle so changes take effect without a restart.
    this.pollLoop().catch((error) => {
      streamDeck.logger.warn(`Poll loop error: ${String(error)}`);
    });

    audioControlClient.onMessage((event) => {
      if (
        event.method === "currentSystemDefaultDeviceVolumeChanged" ||
        event.method === "currentSystemDefaultDeviceMuteChanged"
      ) {
        this.scheduleTitleRefresh();
        return;
      }

      if (
        event.method === "preferredSessionInstanceVolumeChanged" ||
        event.method === "preferredSessionInstanceMuteChanged" ||
        event.method === "appInstanceActivityChanged" ||
        event.method === "appInstanceAddRemove"
      ) {
        // Detection doubles as a sync point: re-apply saved per-device state.
        scheduleAutoAppSync();
        this.scheduleTitleRefresh();
      }
    });
  }

  /** Self-rescheduling poll loop; interval comes from global settings. */
  private async pollLoop(): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      streamDeck.logger.warn(`Poll iteration failed: ${String(error)}`);
    }
    let pollMs = 1500;
    try {
      pollMs = (await getGlobalMixerSettings()).pollMs;
    } catch {
      // keep default
    }
    // The loop must never die — keep it self-rescheduling even if an iteration
    // threw, so the plugin reconnects on its own once the server is back.
    setTimeout(() => {
      this.pollLoop().catch((error) => {
        streamDeck.logger.warn(`Poll loop error: ${String(error)}`);
      });
    }, pollMs);
  }

  /** Periodic detection: pick up apps that started/stopped making sound. */
  private async poll(): Promise<void> {
    if (this.actions.length === 0) {
      // No keys placed — nothing to detect for.
      return;
    }

    try {
      // Force a fresh read so detection / drift-correction isn't masked by the cache.
      await audioControlClient.getApplicationInstances(0);
      // Re-apply saved per-device volume/mute every cycle, not just when the app
      // set changes. Some apps reset their own session to 100% shortly after
      // launch (notably right after a PC restart), and a one-shot restore on
      // appearance loses that race — the PID set never changes again, so the app
      // stays at 100%. The sync only sends a change when the live value actually
      // deviates from the saved value, so an unchanged set is near free.
      scheduleAutoAppSync();
    } catch {
      // Ignore — server may be offline; titles will show that.
    }

    this.scheduleTitleRefresh();
  }

  /** Coalesces bursts of notifications into a single title refresh. */
  private scheduleTitleRefresh(): void {
    if (this.titleTimer) {
      return;
    }
    this.titleTimer = setTimeout(() => {
      this.titleTimer = undefined;
      // A settings/device read here can reject on a server timeout; catch it so
      // it can't become an unhandled rejection that kills the plugin process.
      this.updateVisibleTitles().catch((error) => {
        streamDeck.logger.warn(`Title refresh failed: ${String(error)}`);
      });
    }, 150);
  }

  override async onWillAppear(ev: WillAppearEvent<AppMixerSettings>): Promise<void> {
    await this.renderKey(ev.action, ev.payload.settings);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AppMixerSettings>): Promise<void> {
    await this.renderKey(ev.action, ev.payload.settings);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, AppMixerSettings>): Promise<void> {
    const payload = ev.payload as { request?: string } | undefined;
    if (payload?.request !== "getApps") {
      return;
    }

    let apps: string[] = [];
    try {
      const global = await getGlobalMixerSettings();
      apps = await listDetectedAppNames(global.showApps, global.groupDuplicates, global.order);
    } catch {
      apps = [];
    }
    await streamDeck.ui.sendToPropertyInspector({ event: "apps", apps });
  }

  override async onKeyDown(ev: KeyDownEvent<AppMixerSettings>): Promise<void> {
    const settings = ev.payload.settings;
    try {
      await this.applyStep(ev.action, settings);
    } catch {
      this.stopHold(ev.action.id);
      await this.showImage(ev.action, renderKeyImage({ kind: "offline" }));
      return;
    }
    // Mute is a one-shot toggle; volume keys auto-repeat while held.
    if (normalizeRole(settings.role) !== "mute-toggle") {
      this.startHold(ev.action, settings);
    }
  }

  override async onKeyUp(ev: KeyUpEvent<AppMixerSettings>): Promise<void> {
    this.stopHold(ev.action.id);
  }

  override async onWillDisappear(ev: WillDisappearEvent<AppMixerSettings>): Promise<void> {
    // The key is gone (profile switch, removal) — don't keep repeating into it.
    this.stopHold(ev.action.id);
  }

  /** Begins auto-repeat for a held volume key; cleared by onKeyUp. */
  private startHold(view: KeyView & { id: string }, settings: AppMixerSettings): void {
    const id = view.id;
    this.stopHold(id);
    const startedAt = Date.now();
    let repeats = 0;
    const tick = async (): Promise<void> => {
      let result: number | undefined;
      try {
        result = await this.applyStep(view, settings);
      } catch {
        this.stopHold(id);
        return;
      }
      repeats += 1;
      // Stop the repeat when the volume can't move any further (hit 0 or 100%).
      // This is the real guard against "the volume keeps dropping": even if the
      // key-up is never delivered, a held volume-down settles at 0 and stops.
      const atLimit = result !== undefined && (result <= 0.0001 || result >= 0.9999);
      const hitCap = repeats >= MAX_REPEATS || Date.now() - startedAt >= MAX_HOLD_MS;
      // Released/disappeared (holdTimers cleared), hit a limit, or hit a backstop.
      if (!this.holdTimers.has(id) || atLimit || hitCap) {
        if (hitCap) {
          streamDeck.logger.warn("Volume hold hit its safety cap — a key-up was likely missed.");
        }
        this.stopHold(id);
        return;
      }
      this.holdTimers.set(id, setTimeout(() => void tick(), REPEAT_INTERVAL_MS));
    };
    this.holdTimers.set(id, setTimeout(() => void tick(), REPEAT_DELAY_MS));
  }

  private stopHold(id: string): void {
    const timer = this.holdTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.holdTimers.delete(id);
    }
  }

  /**
   * Applies one volume/mute step to the key's target and repaints it from the
   * computed value (no settle-delay or read-back), so auto-repeat stays snappy
   * and light on the audio server.
   */
  private async applyStep(view: KeyView, settings: AppMixerSettings): Promise<number | undefined> {
    const role = normalizeRole(settings.role);
    const global = await getGlobalMixerSettings();

    if (settings.master) {
      const device = await audioControlClient.getSystemDefaultDevice();
      if (role === "mute-toggle") {
        const muted = !device.mute;
        await audioControlClient.setSystemDefaultDeviceMute(muted);
        await this.showImage(view, renderKeyImage({ kind: "mute", name: "マスター", muted }));
        return undefined;
      }
      // Changing the volume implies the user wants to hear it: lift mute.
      if (device.mute) {
        await audioControlClient.setSystemDefaultDeviceMute(false);
      }
      const nextVolume = clampVolume(device.volume + (role === "volume-down" ? -global.step : global.step));
      await audioControlClient.setSystemDefaultDeviceVolume(nextVolume);
      await this.showImage(
        view,
        renderKeyImage({ kind: "volume", direction: role === "volume-down" ? "down" : "up", name: "マスター", percent: nextVolume * 100 }),
      );
      return nextVolume;
    }

    const target = await resolveApplicationTargetGroup({
      slot: settings.slot,
      showApps: global.showApps,
      groupDuplicates: global.groupDuplicates,
      order: global.order,
    });
    if (!target) {
      // Empty slot: nothing to control yet, but the key stays placed and will
      // pick up an app as soon as one occupies this slot.
      await this.renderKey(view, settings);
      return undefined;
    }

    const { representative, instances } = target;
    const nameKey = appNameKey(representative);
    const name = global.aliases[nameKey] || nameKey;
    const count = instances.length;
    const primaryKey = getAutoAppStateKey(representative, global.groupDuplicates);
    const secondaryKey = getAutoAppStateKey(representative, !global.groupDuplicates);

    let result: number | undefined;
    if (role === "mute-toggle") {
      const nextMute = !representative.mute;
      await Promise.all(
        instances.map((instance) => audioControlClient.setApplicationInstanceMute(instance.processID, nextMute)),
      );
      await updateSavedAutoAppState(primaryKey, { mute: nextMute });
      await this.showImage(view, renderKeyImage({ kind: "mute", name, muted: nextMute, count, icon: global.icons[nameKey] }));
    } else {
      const nextVolume = clampVolume(representative.volume + (role === "volume-down" ? -global.step : global.step));
      // Changing the volume implies the user wants to hear it: lift mute.
      const wasMuted = representative.mute;
      await Promise.all(
        instances.map((instance) => audioControlClient.setApplicationInstanceVolume(instance.processID, nextVolume)),
      );
      if (wasMuted) {
        await Promise.all(
          instances.map((instance) => audioControlClient.setApplicationInstanceMute(instance.processID, false)),
        );
      }
      // Persist mute:false too, or the per-poll sync would re-apply the old mute.
      await updateSavedAutoAppState(primaryKey, wasMuted ? { volume: nextVolume, mute: false } : { volume: nextVolume });
      await this.showImage(
        view,
        renderKeyImage({ kind: "volume", direction: role === "volume-down" ? "down" : "up", name, percent: nextVolume * 100, count }),
      );
      result = nextVolume;
    }

    await mirrorSavedAutoAppState(primaryKey, secondaryKey);
    return result;
  }

  /** Draws the key as a glyph image (speaker / mute slash / volume ±). */
  private async renderKey(view: KeyView, settings: AppMixerSettings): Promise<void> {
    try {
      const role = normalizeRole(settings.role);

      if (settings.master) {
        const device = await audioControlClient.getSystemDefaultDevice();
        const image =
          role === "mute-toggle"
            ? renderKeyImage({ kind: "mute", name: "マスター", muted: device.mute })
            : renderKeyImage({ kind: "volume", direction: role === "volume-down" ? "down" : "up", name: "マスター", percent: device.volume * 100 });
        await this.showImage(view, image);
        return;
      }

      const global = await getGlobalMixerSettings();
      const target = await resolveApplicationTargetGroup({
        slot: settings.slot,
        showApps: global.showApps,
        groupDuplicates: global.groupDuplicates,
        order: global.order,
      });
      if (!target) {
        const slot = Math.max(0, Number(settings.slot ?? 0));
        await this.showImage(view, renderKeyImage({ kind: "empty", name: `スロット${slot}` }));
        return;
      }

      const { representative, instances } = target;
      const nameKey = appNameKey(representative);
      const name = global.aliases[nameKey] || nameKey;
      const count = instances.length;
      const image =
        role === "mute-toggle"
          ? renderKeyImage({ kind: "mute", name, muted: representative.mute, count, icon: global.icons[nameKey] })
          : renderKeyImage({ kind: "volume", direction: role === "volume-down" ? "down" : "up", name, percent: representative.volume * 100, count });
      await this.showImage(view, image);
    } catch {
      await this.showImage(view, renderKeyImage({ kind: "offline" }));
    }
  }

  private async showImage(view: KeyView, image: string): Promise<void> {
    // The image carries all text, so keep the Stream Deck title empty.
    await view.setImage(image);
    await view.setTitle("");
  }

  private async updateVisibleTitles(): Promise<void> {
    await Promise.all(
      this.actions.map(async (actionInstance) => {
        const settings = await actionInstance.getSettings<AppMixerSettings>();
        await this.renderKey(actionInstance, settings);
      }),
    );
  }
}
