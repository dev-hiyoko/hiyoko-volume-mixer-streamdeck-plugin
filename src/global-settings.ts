import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

/**
 * Settings shared across every mixer key. Detection options decide the global
 * slot ordering and the volume step is a shared preference, so they live in
 * Stream Deck's global settings rather than per-action. App-name aliases let
 * the user rename a detected app everywhere it appears.
 */
export const MIN_POLL_MS = 500;
export const MAX_POLL_MS = 10000;

export type GlobalMixerSettings = {
  showApps: "all" | "active";
  groupDuplicates: boolean;
  /** Volume step as a 0.0–1.0 fraction. */
  step: number;
  /** How often to poll for newly started/stopped audio apps, in milliseconds. */
  pollMs: number;
  /** Map of detected app name -> custom display name. */
  aliases: Record<string, string>;
  /** Map of detected app name -> mute-key glyph id (see key-image MUTE_ICONS). */
  icons: Record<string, string>;
  /** App-name keys in priority order; listed apps take the lower slots first. */
  order: string[];
};

// The global settings object is shared with auto-app-state (which owns
// `devices`); we only read/write `detection`/`aliases`/`order` and preserve the rest.
type GlobalState = JsonObject & {
  detection?: Partial<Pick<GlobalMixerSettings, "showApps" | "groupDuplicates" | "step" | "pollMs">>;
  aliases?: Record<string, string>;
  icons?: Record<string, string>;
  order?: string[];
};

export const DEFAULT_MIXER_SETTINGS: GlobalMixerSettings = {
  showApps: "active",
  groupDuplicates: true,
  step: 0.05,
  pollMs: 1500,
  aliases: {},
  icons: {},
  order: [],
};

function normalizeAliases(aliases: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (aliases && typeof aliases === "object") {
    for (const [key, value] of Object.entries(aliases)) {
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
  }
  return out;
}

// Cached parse of the global settings. getGlobalSettings() is a round-trip to
// the Stream Deck host, and the poll/title-refresh path calls this once per key
// render (thousands of times a minute when audio is active). Each host round-trip
// grew StreamDeck.exe by ~500MB/h — measured 2026-07-19: with the plugin the host
// leaked unbounded, without it the host stayed flat. Global settings change only
// when the user edits them, so cache the parsed result with a short TTL; the poll
// loop re-reads every ~1.5s, so a user edit is reflected within the TTL.
//
// Two hazards this guards against, both observed on 2026-07-19:
//  1. Concurrent stampede — a title refresh renders all keys via Promise.all, so
//     15 renders hit a cold cache at once and would fire 15 identical round-trips.
//     A single in-flight promise coalesces them into one.
//  2. Feedback loop — do NOT invalidate this cache from onDidReceiveGlobalSettings.
//     getGlobalSettings() itself makes the host emit that event, so invalidating
//     there means every read triggers an event that forces the next read to
//     re-fetch: a self-sustaining ~1600 round-trips/min storm. TTL-only expiry
//     avoids it entirely.
let cached: GlobalMixerSettings | undefined;
let cachedAt = 0;
let inflight: Promise<GlobalMixerSettings> | undefined;
const CACHE_TTL_MS = 3000;

async function fetchGlobalMixerSettings(): Promise<GlobalMixerSettings> {
  const state = (await streamDeck.settings.getGlobalSettings<GlobalState>()) ?? {};
  const d = state.detection ?? {};
  const pollMs = Number(d.pollMs);
  cached = {
    showApps: d.showApps === "all" ? "all" : "active",
    groupDuplicates: d.groupDuplicates !== false,
    step: typeof d.step === "number" && d.step > 0 && d.step <= 1 ? d.step : DEFAULT_MIXER_SETTINGS.step,
    pollMs: Number.isFinite(pollMs) ? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, pollMs)) : DEFAULT_MIXER_SETTINGS.pollMs,
    aliases: normalizeAliases(state.aliases),
    icons: normalizeAliases(state.icons),
    order: Array.isArray(state.order) ? state.order.filter((k): k is string => typeof k === "string") : [],
  };
  cachedAt = Date.now();
  return cached;
}

export async function getGlobalMixerSettings(): Promise<GlobalMixerSettings> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }
  if (inflight) {
    return inflight;
  }
  const p = fetchGlobalMixerSettings();
  inflight = p;
  void p.finally(() => {
    if (inflight === p) {
      inflight = undefined;
    }
  });
  return p;
}
