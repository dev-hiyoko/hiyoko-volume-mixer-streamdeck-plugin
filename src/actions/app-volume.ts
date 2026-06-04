import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { audioControlClient } from "../audio-control-client.js";
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

@action({ UUID: "fun.hiyoko.volumemixer.app-volume" })
export class AppVolumeAction extends SingletonAction<AppMixerSettings> {
  private titleTimer?: NodeJS.Timeout;

  constructor() {
    super();

    // Global (shared) settings changed — slot ordering / step may differ now.
    streamDeck.settings.onDidReceiveGlobalSettings(() => {
      this.scheduleTitleRefresh();
    });

    // The audio server's change notifications are unreliable, so poll for newly
    // started / stopped audio apps. The interval is a global setting (CPU cost),
    // re-read each cycle so changes take effect without a restart.
    void this.pollLoop();

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
    await this.poll();
    let pollMs = 1500;
    try {
      pollMs = (await getGlobalMixerSettings()).pollMs;
    } catch {
      // keep default
    }
    setTimeout(() => void this.pollLoop(), pollMs);
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
      void this.updateVisibleTitles();
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
    try {
      const settings = ev.payload.settings;
      const role = normalizeRole(settings.role);
      const global = await getGlobalMixerSettings();

      if (settings.master) {
        const device = await audioControlClient.getSystemDefaultDevice();
        if (role === "mute-toggle") {
          await audioControlClient.setSystemDefaultDeviceMute(!device.mute);
        } else {
          // Changing the volume implies the user wants to hear it: lift mute.
          if (device.mute) {
            await audioControlClient.setSystemDefaultDeviceMute(false);
          }
          await audioControlClient.setSystemDefaultDeviceVolume(
            device.volume + (role === "volume-down" ? -global.step : global.step),
          );
        }
        await delay(150);
        await this.renderKey(ev.action, settings);
        return;
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
        await this.renderKey(ev.action, settings);
        return;
      }

      const { representative, instances } = target;
      const primaryKey = getAutoAppStateKey(representative, global.groupDuplicates);
      const secondaryKey = getAutoAppStateKey(representative, !global.groupDuplicates);

      if (role === "mute-toggle") {
        const nextMute = !representative.mute;
        await Promise.all(
          instances.map((instance) => audioControlClient.setApplicationInstanceMute(instance.processID, nextMute)),
        );
        await updateSavedAutoAppState(primaryKey, { mute: nextMute });
      } else {
        const nextVolume = representative.volume + (role === "volume-down" ? -global.step : global.step);
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
      }

      await mirrorSavedAutoAppState(primaryKey, secondaryKey);
      await delay(150);
      await this.renderKey(ev.action, settings);
    } catch {
      await this.showImage(ev.action, renderKeyImage({ kind: "offline" }));
    }
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
      const name = global.aliases[appNameKey(representative)] || appNameKey(representative);
      const count = instances.length;
      const image =
        role === "mute-toggle"
          ? renderKeyImage({ kind: "mute", name, muted: representative.mute, count })
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
