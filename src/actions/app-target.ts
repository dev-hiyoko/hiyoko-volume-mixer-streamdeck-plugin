import type { ApplicationInstance } from "../audio-control-client.js";
import { audioControlClient } from "../audio-control-client.js";
import { appNameKey, getAutoAppGroups, type AutoAppGroup } from "../auto-app-state.js";

export { appNameKey };

export type AppTargetSettings = {
  /** Position in the auto-detected (active-priority) group list this key owns. */
  slot?: number;
  showApps?: "all" | "active";
  groupDuplicates?: boolean;
  /** App-name keys in priority order (global). */
  order?: string[];
  /** Detected-name -> custom label; same label groups sessions together. */
  aliases?: Record<string, string>;
};

export type ResolvedTargetGroup = {
  representative: ApplicationInstance;
  instances: ApplicationInstance[];
  /** The group's key (alias or detected name) — also the saved-state key. */
  label: string;
};

/**
 * Resolves the same-displayName group occupying this key's slot. Slots map to
 * the live auto-detected order (active priority), so a key keeps following
 * whatever app currently sits at that position — that's the auto-detection
 * design (no manual per-app assignment). An empty slot resolves to undefined.
 */
export async function resolveApplicationTargetGroup(
  settings: AppTargetSettings,
): Promise<ResolvedTargetGroup | undefined> {
  const slot = Math.max(0, Number(settings.slot ?? 0));
  const group = (await listApplicationTargetGroups(settings))[slot];
  return group ? { representative: group.representative, instances: group.instances, label: group.label } : undefined;
}

/**
 * The whole slot-ordered group list that `resolveApplicationTargetGroup` picks
 * a single slot out of.
 *
 * A key that acts needs both: the group it targets, *and* which other placed
 * keys point at that same group, so they can be repainted from the value just
 * computed instead of waiting for the next poll. Taking the list once gives
 * both from one read.
 */
export async function listApplicationTargetGroups(settings: AppTargetSettings): Promise<AutoAppGroup[]> {
  return getAutoAppGroups(await audioControlClient.getApplicationInstances(), {
    showApps: settings.showApps ?? "active",
    groupDuplicates: settings.groupDuplicates ?? true,
    order: settings.order ?? [],
    aliases: settings.aliases ?? {},
  });
}

/** Ordered slot → app-name-key list for the Property Inspector preview. */
export async function listDetectedAppNames(
  showApps: "all" | "active",
  groupDuplicates: boolean,
  order: string[] = [],
  aliases: Record<string, string> = {},
): Promise<string[]> {
  const groups = getAutoAppGroups(await audioControlClient.getApplicationInstances(), {
    showApps,
    groupDuplicates,
    order,
    aliases,
  });
  return groups.map((group) => appNameKey(group.representative));
}
