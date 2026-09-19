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

// Cached copy of the global auto-state (saved per-app volume/mute). The per-poll
// drift-correction sweep (syncAllAutoAppGroups) reads this several times a
// second; each read was an uncached Stream Deck host round-trip — the leak that
// remained after the render path was cached (measured 2026-07-19). Saved state
// only changes when we write it, so serve hot reads from cache (short TTL as a
// self-healing backstop) and write through on save.
let cachedState: GlobalAutoState | undefined;
let cachedStateAt = 0;
const STATE_TTL_MS = 3000;

// Write coalescing. setGlobalSettings makes the Stream Deck host serialise and
// persist the whole settings object to disk, on the same thread that drives its
// UI. A held volume key steps every REPEAT_INTERVAL_MS (130ms) and each step
// used to do two read+write pairs (updateSavedAutoAppState, then
// mirrorSavedAutoAppState) — about fifteen settings files written per second
// for as long as the key was down. That is survivable on an idle machine and
// not survivable while a game is loading and saturating the disk: the host
// stalls, which is what "Stream Deck freezes when I launch a game" is.
//
// So saves now mutate the in-memory copy and schedule one flush. A continuous
// hold collapses from ~15 writes/second to at most one per FLUSH_MAX_WAIT_MS.
const FLUSH_DEBOUNCE_MS = 400;
const FLUSH_MAX_WAIT_MS = 2000;
let flushTimer: NodeJS.Timeout | undefined;
let dirtySince = 0;
let flushInFlight: Promise<void> | undefined;

/**
 * Hot-path read: cached copy of the global auto-state.
 *
 * While a flush is pending the cache holds unsaved edits, so it must not be
 * refreshed from the host — doing so would silently discard them.
 */
async function readGlobalAutoStateCached(): Promise<GlobalAutoState> {
  const now = Date.now();
  if (cachedState && (dirtySince > 0 || now - cachedStateAt < STATE_TTL_MS)) {
    return cachedState;
  }
  cachedState = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  cachedStateAt = now;
  return cachedState;
}

/** Record a freshly written state so hot reads see it without a round-trip. */
function rememberWrittenState(state: GlobalAutoState): void {
  cachedState = state;
  cachedStateAt = Date.now();
}

/**
 * Persists our `devices` subtree, merged onto whatever the host currently holds.
 *
 * The global settings object is shared with global-settings.ts, which owns
 * `detection`/`aliases`/`icons`/`order` and is written by the property
 * inspector. Because our write is now deferred, the user may have edited those
 * in the meantime — so re-read at flush time and merge, rather than writing back
 * a snapshot taken before the edit. That read costs one round-trip per flush,
 * not one per volume step.
 */
async function flushGlobalAutoState(): Promise<void> {
  if (dirtySince === 0 || !cachedState) {
    return;
  }
  dirtySince = 0;
  const live = (await streamDeck.settings.getGlobalSettings<GlobalAutoState>()) ?? DEFAULT_GLOBAL_STATE;
  // Read our own subtree *after* the await: a key pressed while that read was in
  // flight has already updated it, and capturing it earlier would write the
  // pre-edit copy back over the new one.
  const devices = cachedState?.devices ?? {};
  const written: GlobalAutoState = { ...DEFAULT_GLOBAL_STATE, ...live, devices };
  await streamDeck.settings.setGlobalSettings(written);
  // Same hazard on the way out: if an edit landed during the write, the cache
  // now holds something newer than what we just saved. Leave it alone — the
  // edit already scheduled the follow-up flush that will persist it.
  if (dirtySince === 0) {
    rememberWrittenState(written);
  }
}

/** Marks the in-memory state dirty and schedules a single coalesced write. */
function scheduleGlobalAutoStateFlush(): void {
  const now = Date.now();
  if (dirtySince === 0) {
    dirtySince = now;
  }

  // Cap the debounce: a key held down keeps resetting it, and a hold can run for
  // MAX_HOLD_MS, so without this the save could be deferred for seconds.
  if (now - dirtySince >= FLUSH_MAX_WAIT_MS) {
    runFlush();
    return;
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(runFlush, FLUSH_DEBOUNCE_MS);
}

function runFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  // Serialise flushes: two overlapping read-merge-write pairs could interleave
  // and write back a half-merged object.
  flushInFlight = (flushInFlight ?? Promise.resolve())
    .then(() => flushGlobalAutoState())
    .catch((error) => {
      streamDeck.logger.warn(`Failed to save per-app volume state: ${String(error)}`);
    });
}

/** Forces any buffered save out now (used when a key is released). */
export async function flushSavedAutoAppState(): Promise<void> {
  runFlush();
  await flushInFlight;
}

// The default output device's id, used as the saved-state key. Reading it is a
// round-trip to the audio server, and updateSavedAutoAppState/mirrorSaved... and
// the drift sweep each wanted it — three per volume step. The id only changes
// when the user switches their default output, so a short TTL is enough; the
// cost of being briefly stale is that a volume change made within this window of
// switching devices is saved under the previous device.
const DEVICE_KEY_TTL_MS = 2000;

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
  const device = await audioControlClient.getSystemDefaultDevice(DEVICE_KEY_TTL_MS);
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

/** Applies `mutate` to the saved app map for the current device, in memory. */
async function editSavedApps(mutate: (apps: Record<string, SavedAppState>) => boolean): Promise<void> {
  const deviceKey = await getAutoDeviceKey();
  const state = await readGlobalAutoStateCached();
  const devices = { ...(state.devices ?? {}) };
  const currentDeviceState = { ...(devices[deviceKey] ?? {}) };
  const apps = { ...(currentDeviceState.apps ?? {}) };

  if (!mutate(apps)) {
    return;
  }

  currentDeviceState.apps = apps;
  devices[deviceKey] = currentDeviceState;
  // Hold the edit in memory and let the coalescing flush persist it; a held key
  // makes one of these every 130ms and the host cannot absorb that as disk writes.
  cachedState = { ...DEFAULT_GLOBAL_STATE, ...state, devices };
  cachedStateAt = Date.now();
  scheduleGlobalAutoStateFlush();
}

export async function updateSavedAutoAppState(label: string, nextState: SavedAppState): Promise<void> {
  await editSavedApps((apps) => {
    const current = apps[label] ?? {};
    apps[label] = {
      mute: nextState.mute ?? current.mute,
      volume: nextState.volume ?? current.volume,
    };
    return true;
  });
}

export async function mirrorSavedAutoAppState(sourceLabel: string, mirrorLabel: string): Promise<void> {
  await editSavedApps((apps) => {
    const saved = apps[sourceLabel];
    if (!saved) {
      return false;
    }
    apps[mirrorLabel] = { ...saved };
    return true;
  });
}

export async function getSavedAutoAppState(label: string): Promise<SavedAppState | undefined> {
  const deviceKey = await getAutoDeviceKey();
  const state = await readGlobalAutoStateCached();
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
  const state = await readGlobalAutoStateCached();
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
