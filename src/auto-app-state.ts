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
  /** Detected-name -> custom label. Sessions given the same custom label group together. */
  aliases?: Record<string, string>;
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
  const aliases = options.aliases ?? {};
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
    const key = getAutoAppLabel(instance, groupDuplicates, aliases);
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

/**
 * The grouping / saved-state key for a session. Sessions collapse into one group
 * when this key matches, so it keys on the user's custom label (alias) when set,
 * falling back to the detected name — assigning two sessions the same label
 * groups them. With groupDuplicates off, the pid suffix keeps every session its
 * own group.
 */
export function getAutoAppLabel(
  instance: ApplicationInstance,
  groupDuplicates = true,
  aliases: Record<string, string> = {},
): string {
  const base = getApplicationLabel(instance).trim() || `PID ${instance.processID}`;
  const alias = aliases[appNameKey(instance)]?.trim();
  const named = alias || base;
  return groupDuplicates ? named : `${named}#${instance.processID}`;
}

export function getAutoAppStateKey(
  instance: ApplicationInstance,
  groupDuplicates = true,
  aliases: Record<string, string> = {},
): string {
  return getAutoAppLabel(instance, groupDuplicates, aliases);
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
    aliases: global.aliases,
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
async function applySavedStateToGroup(
  group: AutoAppGroup,
  saved: SavedAppState | undefined,
  enforceMute: boolean,
): Promise<void> {
  if (!saved) {
    return;
  }

  await Promise.all(
    group.instances.map(async (instance) => {
      // Guard each instance independently: a session can end between when it was
      // enumerated and when we write to it, so a stale processID write may fail —
      // don't let that reject the whole sweep (or the others' writes).
      try {
        if (typeof saved.volume === "number" && Number.isFinite(saved.volume)) {
          const nextVolume = clampVolume(saved.volume);
          if (Math.abs(instance.volume - nextVolume) > 0.005) {
            await audioControlClient.setApplicationInstanceVolume(instance.processID, nextVolume);
          }
        }

        // Only restore mute when the app just appeared (relaunch), never on the
        // steady-state drift sweep — otherwise unmuting from the Windows mixer
        // (or anywhere outside the plugin) is instantly reverted, so the user
        // can never turn a saved mute back off.
        if (enforceMute && typeof saved.mute === "boolean" && instance.mute !== saved.mute) {
          await audioControlClient.setApplicationInstanceMute(instance.processID, saved.mute);
        }
      } catch (error) {
        streamDeck.logger.warn(`Failed to apply saved state to PID ${instance.processID}: ${String(error)}`);
      }
    }),
  );
}

// Labels present on the previous sync sweep. A label absent here but present now
// means the app just (re)appeared, which is the only time we restore saved mute.
let knownGroupLabels = new Set<string>();

export async function syncAutoAppGroup(group: AutoAppGroup): Promise<void> {
  await applySavedStateToGroup(group, await getSavedAutoAppState(group.label), true);
}

export async function syncAllAutoAppGroups(): Promise<void> {
  const groups = await getAutoApplicationGroups();
  if (groups.length === 0) {
    knownGroupLabels = new Set();
    return;
  }

  // Resolve the device key and saved map once instead of per group, so the
  // per-poll drift-correction sweep doesn't fan out to N device round-trips.
  const deviceKey = await getAutoDeviceKey();
  const state = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  const savedApps = state.devices?.[deviceKey]?.apps ?? {};
  const seen = new Set<string>();
  await Promise.all(
    groups.map((group) => {
      seen.add(group.label);
      // Restore mute only for groups that weren't present last sweep (a fresh
      // launch); steady-state sweeps correct volume drift but leave mute alone.
      const justAppeared = !knownGroupLabels.has(group.label);
      return applySavedStateToGroup(group, savedApps[group.label], justAppeared);
    }),
  );
  knownGroupLabels = seen;
}

export function scheduleAutoAppSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }

  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    // Must not be fire-and-forget: a rejected request here (server closed /
    // timed out) would become an unhandled rejection and crash the plugin
    // process, which is what makes the keys go offline and stay offline.
    syncAllAutoAppGroups().catch((error) => {
      streamDeck.logger.warn(`Auto app-state sync failed (will retry next poll): ${String(error)}`);
    });
  }, 250);
}
