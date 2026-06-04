import streamDeck from "@elgato/streamdeck";

import { audioControlClient, clampVolume, getApplicationLabel, type ApplicationInstance } from "./audio-control-client.js";
import { getGlobalMixerSettings } from "./global-settings.js";

type SavedAppState = {
  mute?: boolean;
  volume?: number;
};

type SavedDeviceState = {
  apps?: Record<string, SavedAppState>;
};

type GlobalAutoState = {
  devices?: Record<string, SavedDeviceState>;
};

const DEFAULT_GLOBAL_STATE: GlobalAutoState = {
  devices: {},
};

let syncTimer: NodeJS.Timeout | undefined;

export type AutoAppGroup = {
  label: string;
  instances: ApplicationInstance[];
  representative: ApplicationInstance;
  count: number;
};

export type AutoAppOptions = {
  showApps?: "all" | "active";
  groupDuplicates?: boolean;
  /** App-name keys in priority order; listed apps sort to the front. */
  order?: string[];
};

/**
 * Stable identity for a detected app: the display name, or the executable file
 * name. Used as the alias-map key, the priority-order key, and the default
 * shown name.
 */
export function appNameKey(instance: ApplicationInstance): string {
  const name = instance.displayName?.trim() || instance.executableFile.split("\\").pop() || "App";
  return name.trim();
}

export async function getAutoDeviceKey(): Promise<string> {
  const device = await audioControlClient.getSystemDefaultDevice();
  return device.deviceID || "default";
}

export function getAutoAppGroups(instances: ApplicationInstance[], options: AutoAppOptions = {}): AutoAppGroup[] {
  const groups = new Map<string, ApplicationInstance[]>();
  const showApps = options.showApps ?? "active";
  const groupDuplicates = options.groupDuplicates ?? true;
  const order = options.order ?? [];
  const orderIndex = (instance: ApplicationInstance): number => {
    const i = order.indexOf(appNameKey(instance));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  const candidates = instances
    // processID 0 is the system default device ("system全体"); exclude it so the
    // list is real per-app sessions only.
    .filter((item) => item.processID > 0)
    .filter((item) => showApps === "all" || item.activity <= 3);

  for (const instance of candidates) {
    const key = getAutoAppLabel(instance, groupDuplicates);
    const existing = groups.get(key) ?? [];
    existing.push(instance);
    groups.set(key, existing);
  }

  return Array.from(groups.entries())
    .map(([label, groupInstances]) => ({
      label,
      instances: groupInstances,
      count: groupInstances.length,
      representative: groupInstances
        .slice()
        .sort((left, right) => {
          const activityDiff = left.activity - right.activity;
          if (activityDiff !== 0) {
            return activityDiff;
          }

          return getApplicationLabel(left).localeCompare(getApplicationLabel(right));
        })[0],
    }))
    .sort((left, right) => {
      // User-defined priority order wins; listed apps take the lower slots.
      const orderDiff = orderIndex(left.representative) - orderIndex(right.representative);
      if (orderDiff !== 0) {
        return orderDiff;
      }

      const activityDiff = left.representative.activity - right.representative.activity;
      if (activityDiff !== 0) {
        return activityDiff;
      }

      return left.label.localeCompare(right.label);
    });
}

export function getAutoAppLabel(instance: ApplicationInstance, groupDuplicates = true): string {
  const baseLabel = getApplicationLabel(instance).trim() || `PID ${instance.processID}`;
  return groupDuplicates ? baseLabel : `${baseLabel}#${instance.processID}`;
}

export function getAutoAppStateKey(instance: ApplicationInstance, groupDuplicates = true): string {
  return getAutoAppLabel(instance, groupDuplicates);
}

export async function getAutoApplicationGroups(): Promise<AutoAppGroup[]> {
  const [instances, global] = await Promise.all([
    audioControlClient.getApplicationInstances(),
    getGlobalMixerSettings(),
  ]);
  return getAutoAppGroups(instances, {
    showApps: global.showApps,
    groupDuplicates: global.groupDuplicates,
    order: global.order,
  });
}

export async function updateSavedAutoAppState(label: string, nextState: SavedAppState): Promise<void> {
  const deviceKey = await getAutoDeviceKey();
  const state = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  const devices = { ...(state.devices ?? {}) };
  const currentDeviceState = { ...(devices[deviceKey] ?? {}) };
  const apps = { ...(currentDeviceState.apps ?? {}) };
  const current = apps[label] ?? {};

  apps[label] = {
    mute: nextState.mute ?? current.mute,
    volume: nextState.volume ?? current.volume,
  };

  currentDeviceState.apps = apps;
  devices[deviceKey] = currentDeviceState;
  await streamDeck.settings.setGlobalSettings({
    ...DEFAULT_GLOBAL_STATE,
    ...state,
    devices,
  });
}

export async function mirrorSavedAutoAppState(sourceLabel: string, mirrorLabel: string): Promise<void> {
  const deviceKey = await getAutoDeviceKey();
  const state = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  const saved = state.devices?.[deviceKey]?.apps?.[sourceLabel];
  if (!saved) {
    return;
  }

  const devices = { ...(state.devices ?? {}) };
  const currentDeviceState = { ...(devices[deviceKey] ?? {}) };
  const apps = { ...(currentDeviceState.apps ?? {}) };
  apps[mirrorLabel] = { ...saved };
  currentDeviceState.apps = apps;
  devices[deviceKey] = currentDeviceState;
  await streamDeck.settings.setGlobalSettings({
    ...DEFAULT_GLOBAL_STATE,
    ...state,
    devices,
  });
}

export async function getSavedAutoAppState(label: string): Promise<SavedAppState | undefined> {
  const deviceKey = await getAutoDeviceKey();
  const state = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  return state.devices?.[deviceKey]?.apps?.[label];
}

/**
 * Pulls every instance in the group back to its saved volume/mute. Only sends a
 * change when the live value actually deviates (>0.5% volume, or a mute
 * mismatch), so this is safe to run on every poll cycle as drift correction —
 * some apps reset their own session to 100% shortly after launch, and a
 * one-shot restore on appearance loses that race.
 */
async function applySavedStateToGroup(group: AutoAppGroup, saved: SavedAppState | undefined): Promise<void> {
  if (!saved) {
    return;
  }

  await Promise.all(
    group.instances.map(async (instance) => {
      if (typeof saved.volume === "number" && Number.isFinite(saved.volume)) {
        const nextVolume = clampVolume(saved.volume);
        if (Math.abs(instance.volume - nextVolume) > 0.005) {
          await audioControlClient.setApplicationInstanceVolume(instance.processID, nextVolume);
        }
      }

      if (typeof saved.mute === "boolean" && instance.mute !== saved.mute) {
        await audioControlClient.setApplicationInstanceMute(instance.processID, saved.mute);
      }
    }),
  );
}

export async function syncAutoAppGroup(group: AutoAppGroup): Promise<void> {
  await applySavedStateToGroup(group, await getSavedAutoAppState(group.label));
}

export async function syncAllAutoAppGroups(): Promise<void> {
  const groups = await getAutoApplicationGroups();
  if (groups.length === 0) {
    return;
  }

  // Resolve the device key and saved map once instead of per group, so the
  // per-poll drift-correction sweep doesn't fan out to N device round-trips.
  const deviceKey = await getAutoDeviceKey();
  const state = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  const savedApps = state.devices?.[deviceKey]?.apps ?? {};
  await Promise.all(groups.map((group) => applySavedStateToGroup(group, savedApps[group.label])));
}

export function scheduleAutoAppSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }

  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncAllAutoAppGroups();
  }, 250);
}
