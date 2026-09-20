import streamDeck from "@elgato/streamdeck";
import WebSocket, { type RawData } from "ws";

// Our bundled WASAPI server (see audio-server-process.ts), not the Elgato
// server's 1844.
const AUDIO_CONTROL_URL = "ws://127.0.0.1:1845";
const REQUEST_TIMEOUT_MS = 3000;
// Apple Music commands drive another app's UI and may have to launch it first.
// Measured 2026-09-20: starting a playlist takes ~2.2s on a warm app, and the
// server itself waits up to 20s for a cold launch.
const APPLE_MUSIC_TIMEOUT_MS = 30000;

// Reconnect backoff. The audio server may be briefly unavailable — during the
// plugin's own startup before it has finished spawning, or across a manual
// restart — so the ~1.5s poll loop must not hammer a fresh socket at it every
// cycle. After repeated failures we stop attempting until an exponentially
// growing window elapses, then let exactly one retry through (half-open); a
// real response resets it, another failure widens it (capped).
const CONNECT_BACKOFF_BASE_MS = 1000;
const CONNECT_BACKOFF_MAX_MS = 30000;
// Consecutive request-timeout *episodes* that mean the socket is open but the
// server has stopped answering (that state emits no close event, so
// connect-failure backoff alone never engages). At this many, tear the socket
// down and back off. See noteRequestTimeout for why this counts episodes rather
// than individual requests.
const REQUEST_TIMEOUT_TRIP = 3;

export type AudioControlActivity = 2 | 3 | 4 | number;

export type ApplePlaylist = {
  /** Apple's library database id; survives renaming the playlist. */
  id: string;
  name: string;
};

export type AppleMusicStatus = {
  running: boolean;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  title: string;
  artist: string;
};

export type SystemDefaultDevice = {
  deviceID: string;
  friendlyName: string;
  hardwareID?: string;
  iconPath?: string;
  mute: boolean;
  volume: number;
};

export type ApplicationInstance = {
  processID: number;
  name?: string;
  displayName?: string;
  executableFile: string;
  executablePath?: string;
  iconPath?: string;
  mute: boolean;
  volume: number;
  activity: AudioControlActivity;
};

type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: number;
  result: T;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: number;
  error: {
    code?: number;
    message?: string;
  };
};

type PendingRequest<T> = {
  method: string;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

export class AudioControlClient {
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, PendingRequest<unknown>>();
  private messageListeners = new Set<(event: any) => void>();
  private instancesCache?: { at: number; value: ApplicationInstance[] };
  private instancesInFlight?: Promise<ApplicationInstance[]>;
  // Bumped by every write that makes the cached session list obsolete. A fetch
  // records the generation it started at and refuses to install its result if
  // the generation moved while it was in flight — see getApplicationInstances.
  private instancesGeneration = 0;
  private instancesInFlightGeneration = -1;
  private deviceCache?: { at: number; value: SystemDefaultDevice };
  private deviceInFlight?: Promise<SystemDefaultDevice>;
  private deviceGeneration = 0;
  private deviceInFlightGeneration = -1;
  // Circuit-breaker state (see CONNECT_BACKOFF_* and ensureConnected).
  // `connectBlockedUntil` is a timestamp before which lazy reconnects fast-fail;
  // `connectFailures` sizes the backoff; `requestTimeouts` counts consecutive
  // unanswered request episodes so a hung-but-open server also trips it.
  private connectFailures = 0;
  private connectBlockedUntil = 0;
  private requestTimeouts = 0;
  private lastRequestTimeoutAt = 0;
  // Offline/online transition tracking. Every caller of this client swallows its
  // errors (the keys just paint the offline glyph), so without this the plugin
  // can spend hours unreachable and write nothing to the log — which is exactly
  // what made "it dies when a game starts" impossible to diagnose after the fact.
  private online = true;
  private offlineSince = 0;
  private offlineReason = "";

  async connect(): Promise<void> {
    // A deliberate connect (plugin startup, or the restart-server recovery
    // probe) must try now, not sit behind the lazy-reconnect backoff window — a
    // bare connect doesn't enumerate sessions, so it can't re-trip the crash.
    this.connectFailures = 0;
    this.connectBlockedUntil = 0;
    await this.ensureConnected();
  }

  /**
   * Forcibly drops the current connection so the next request/connect reconnects
   * from scratch. Used by the server-restart key: after the server is killed the
   * old socket may briefly still report OPEN, so we tear it down explicitly
   * rather than trust a stale `readyState`.
   */
  disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;
    // A forced disconnect is a deliberate reset point (the restart-server key
    // calls it before re-probing), so clear the breaker too.
    this.connectFailures = 0;
    this.connectBlockedUntil = 0;
    this.requestTimeouts = 0;
    this.lastRequestTimeoutAt = 0;
    if (socket) {
      try {
        socket.terminate();
      } catch {
        // Already gone — nothing to do.
      }
    }
  }

  /** True while the breaker still considers the audio server reachable. */
  isOnline(): boolean {
    return this.online;
  }

  /**
   * Retries `connect()` at a steady interval until the server answers or
   * `timeoutMs` elapses. Resolves to whether it came up.
   *
   * Used where we know the server is *expected* to appear shortly — plugin
   * startup, which has just spawned it, and the restart key. The lazy
   * reconnect's exponential backoff is wrong for both: it assumes repeated
   * failures mean the server is gone, so after a handful of misses it waits
   * seconds between attempts. At startup the plugin reliably outran its own
   * server by a moment and then sat out the ladder — measured at 2.5s on a good
   * run and 22.5s on a bad one, with every key showing the offline glyph for
   * the duration. connect() clears the breaker on each attempt, so this keeps
   * probing at a fixed rate instead.
   */
  async waitUntilReachable(timeoutMs: number, intervalMs = 400): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.connect();
        return true;
      } catch {
        // Not up yet.
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  onMessage(listener: (event: any) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /**
   * The system default output device, cached for `maxAgeMs`.
   *
   * The default is 0 (always fresh) so accepting a stale reading has to be a
   * deliberate choice: anything that computes a *new* value from the current
   * one — a volume step — must never step off stale data. Painting a key can.
   *
   * This matters because one title refresh renders every placed key, and three
   * of the keys on this profile target the master device. Uncached, a single
   * repaint was three separate ~8ms round-trips, all serialized behind the
   * server's one COM thread, for a value that cannot have changed between them.
   */
  async getSystemDefaultDevice(maxAgeMs = 0): Promise<SystemDefaultDevice> {
    const cache = this.deviceCache;
    if (cache && Date.now() - cache.at < maxAgeMs) {
      return cache.value;
    }

    if (this.deviceInFlight && this.deviceInFlightGeneration === this.deviceGeneration) {
      return this.deviceInFlight;
    }

    const generation = this.deviceGeneration;
    this.deviceInFlightGeneration = generation;
    const fetch = (async () => {
      try {
        const device = await this.request<SystemDefaultDevice>("getSystemDefaultDevice", {});
        if (this.deviceGeneration === generation) {
          this.deviceCache = { at: Date.now(), value: device };
        }
        return device;
      } finally {
        if (this.deviceInFlightGeneration === generation) {
          this.deviceInFlight = undefined;
        }
      }
    })();
    this.deviceInFlight = fetch;
    return fetch;
  }

  /** Drops the cached device so the next read reflects a just-made change. */
  invalidateDeviceCache(): void {
    this.deviceCache = undefined;
    this.deviceGeneration += 1;
  }

  async setSystemDefaultDeviceVolume(volume: number): Promise<void> {
    await this.requestNoResponse("setSystemDefaultDeviceVolume", {
      processID: 0,
      volume: clampVolume(volume),
    });
    this.invalidateDeviceCache();
  }

  async setSystemDefaultDeviceMute(mute: boolean): Promise<void> {
    await this.requestNoResponse("setSystemDefaultDeviceMute", {
      processID: 0,
      mute,
    });
    this.invalidateDeviceCache();
  }

  async getApplicationInstanceCount(): Promise<number> {
    const result = await this.request<{ count: number }>("getApplicationInstanceCount", {});
    return result.count;
  }

  async getApplicationInstanceAtIndex(index: number): Promise<ApplicationInstance> {
    return this.request<ApplicationInstance>("getApplicationInstanceAtIndex", { index });
  }

  /**
   * Returns the application sessions, cached briefly. Every visible key reads
   * this on each refresh, so without caching a single notification would fan out
   * to N keys × (count + N index) WebSocket round-trips and swamp the server.
   * Concurrent callers share one in-flight fetch; `maxAgeMs` lets callers that
   * need fresh data (e.g. right before a key acts) bypass the cache.
   *
   * The generation guard is what stops a held volume key from stalling. A fetch
   * that started *before* a write used to install its pre-write snapshot
   * *after* the write had invalidated the cache, so the next step computed
   * "current + step" from the stale reading and re-sent the value the key
   * already had. Held down, the volume simply stopped moving.
   */
  async getApplicationInstances(maxAgeMs = 1000): Promise<ApplicationInstance[]> {
    const cache = this.instancesCache;
    if (cache && Date.now() - cache.at < maxAgeMs) {
      return cache.value;
    }

    // Only join an in-flight fetch started at the current generation; an older
    // one is already known to be reading pre-write state.
    if (this.instancesInFlight && this.instancesInFlightGeneration === this.instancesGeneration) {
      return this.instancesInFlight;
    }

    const generation = this.instancesGeneration;
    this.instancesInFlightGeneration = generation;
    const fetch = (async () => {
      try {
        const count = await this.getApplicationInstanceCount();
        // Read every index concurrently rather than sequentially: the count call
        // snapshots the session list server-side and each index reads from that
        // snapshot, so the whole enumeration is consistent and collapses to a
        // single round-trip instead of `count` sequential ones.
        const results = await Promise.allSettled(
          Array.from({ length: count }, (_, index) => this.getApplicationInstanceAtIndex(index)),
        );
        const instances: ApplicationInstance[] = [];
        for (const result of results) {
          if (result.status === "fulfilled") {
            instances.push(result.value);
          } else {
            streamDeck.logger.warn(`Failed to read application instance: ${String(result.reason)}`);
          }
        }
        if (this.instancesGeneration === generation) {
          this.instancesCache = { at: Date.now(), value: instances };
        }
        return instances;
      } finally {
        // Don't clear a newer fetch that has already replaced this one.
        if (this.instancesInFlightGeneration === generation) {
          this.instancesInFlight = undefined;
        }
      }
    })();
    this.instancesInFlight = fetch;

    return fetch;
  }

  /** Drops the cached session list so the next read reflects a just-made change. */
  invalidateInstancesCache(): void {
    this.instancesCache = undefined;
    this.instancesGeneration += 1;
  }

  async setApplicationInstanceMute(processID: number, mute: boolean): Promise<void> {
    await this.requestNoResponse("setApplicationInstanceMute", { processID, mute });
    this.invalidateInstancesCache();
  }

  async setApplicationInstanceVolume(processID: number, volume: number): Promise<void> {
    await this.requestNoResponse("setApplicationInstanceVolume", {
      processID,
      volume: clampVolume(volume),
    });
    this.invalidateInstancesCache();
  }

  // --- Apple Music ---------------------------------------------------------
  // These are answered by a separate thread in the audio server and, unlike the
  // volume calls, can legitimately take seconds (starting a playlist drives the
  // app's UI, and may first have to launch it). They get their own, longer
  // deadline so a slow-but-working command is not reported as a failure — and
  // so it never feeds the breaker that the volume path shares.

  async appleMusicStatus(): Promise<AppleMusicStatus> {
    return this.request<AppleMusicStatus>("appleMusicStatus", {}, APPLE_MUSIC_TIMEOUT_MS);
  }

  async appleMusicListPlaylists(): Promise<ApplePlaylist[]> {
    const result = await this.request<{ playlists: ApplePlaylist[] }>(
      "appleMusicListPlaylists",
      {},
      APPLE_MUSIC_TIMEOUT_MS,
    );
    return result.playlists ?? [];
  }

  async appleMusicPlayPlaylist(id: string, name: string, shuffle: boolean): Promise<void> {
    await this.request<null>("appleMusicPlayPlaylist", { id, name, shuffle }, APPLE_MUSIC_TIMEOUT_MS);
  }

  async appleMusicResume(): Promise<void> {
    await this.request<null>("appleMusicResume", {}, APPLE_MUSIC_TIMEOUT_MS);
  }

  async appleMusicPause(): Promise<void> {
    await this.request<null>("appleMusicPause", {}, APPLE_MUSIC_TIMEOUT_MS);
  }

  private async requestNoResponse(method: string, params: Record<string, unknown>): Promise<void> {
    await this.ensureConnected();

    const payload = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };

    this.socket?.send(JSON.stringify(payload));
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureConnected();

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        // Only the short-deadline calls feed the breaker. A slow Apple Music
        // command says nothing about whether the audio server is healthy, and
        // counting it would drop the volume keys offline for an unrelated
        // reason.
        if (timeoutMs === REQUEST_TIMEOUT_MS) {
          this.noteRequestTimeout();
        }
        reject(new Error(`Audio Control request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timeout });
    });

    this.socket?.send(JSON.stringify(payload));
    return response;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Half-open the breaker: inside the backoff window, fail fast without
    // opening a socket. The poll loop keeps calling this, so the first call
    // after the window elapses is the single retry that probes the server.
    if (Date.now() < this.connectBlockedUntil) {
      throw new Error("Audio Control connection is backing off after repeated failures.");
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(AUDIO_CONTROL_URL);
      this.socket = socket;

      const cleanupStartupListeners = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onStartupClose);
      };

      const onOpen = () => {
        cleanupStartupListeners();
        socket.on("message", (data) => this.handleMessage(data));
        socket.on("close", () => this.handleClose(socket));
        socket.on("error", (error) => {
          streamDeck.logger.warn(`Audio Control WebSocket error: ${String(error)}`);
        });
        this.connectPromise = undefined;
        resolve();
      };

      const onError = (error: Error) => {
        cleanupStartupListeners();
        this.connectPromise = undefined;
        this.socket = undefined;
        this.noteConnectFailure(String(error));
        reject(error);
      };

      const onStartupClose = () => {
        cleanupStartupListeners();
        this.connectPromise = undefined;
        this.socket = undefined;
        this.noteConnectFailure("socket closed before the connection completed");
        reject(new Error("Audio Control WebSocket closed before connection completed."));
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onStartupClose);
    });

    return this.connectPromise;
  }

  private handleMessage(data: RawData): void {
    // Any inbound byte proves the server is alive and answering, so reset the
    // breaker here rather than on a bare socket open (which a hung server also
    // grants before it stops responding).
    this.noteHealthy();

    let message: JsonRpcSuccess<unknown> | JsonRpcError;

    try {
      message = JSON.parse(data.toString()) as JsonRpcSuccess<unknown> | JsonRpcError;
    } catch (error) {
      streamDeck.logger.warn(`Failed to parse Audio Control message: ${String(error)}`);
      return;
    }

    if (!("id" in message)) {
      for (const listener of this.messageListeners) {
        listener(message);
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if ("error" in message) {
      pending.reject(new Error(message.error.message ?? `Audio Control request failed: ${pending.method}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleClose(socket: WebSocket): void {
    // Ignore a stale close from a socket we've already replaced (e.g. after
    // disconnect() + reconnect), so we don't null out the live connection.
    if (this.socket && this.socket !== socket) {
      return;
    }

    this.socket = undefined;
    this.connectPromise = undefined;

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Audio Control WebSocket closed during request: ${pending.method}`));
      this.pending.delete(id);
    }
  }

  /** Server answered: clear the breaker so the next request goes through clean. */
  private noteHealthy(): void {
    if (!this.online) {
      const seconds = ((Date.now() - this.offlineSince) / 1000).toFixed(1);
      streamDeck.logger.warn(
        `Audio server reachable again after ${seconds}s offline (first failure: ${this.offlineReason}).`,
      );
      this.online = true;
    }
    this.connectFailures = 0;
    this.connectBlockedUntil = 0;
    this.requestTimeouts = 0;
    this.lastRequestTimeoutAt = 0;
  }

  /** A connect attempt failed: grow the backoff window (capped). */
  private noteConnectFailure(reason: string): void {
    this.connectFailures += 1;
    const backoff = Math.min(
      CONNECT_BACKOFF_MAX_MS,
      CONNECT_BACKOFF_BASE_MS * 2 ** (this.connectFailures - 1),
    );
    this.connectBlockedUntil = Date.now() + backoff;
    this.noteOffline(reason, backoff);
  }

  /**
   * Records — and logs, on the transition — that the server is unreachable.
   * Every caller of this client swallows its errors and just paints the offline
   * glyph, so this is the only place an outage leaves a trace. Logging the
   * transition (rather than each failure) keeps a long outage to two lines.
   */
  private noteOffline(reason: string, backoffMs: number): void {
    const retryIn = (backoffMs / 1000).toFixed(1);
    if (this.online) {
      this.online = false;
      this.offlineSince = Date.now();
      this.offlineReason = reason;
      streamDeck.logger.warn(
        `Audio server went offline — keys will paint the offline glyph. Reason: ${reason}. Retrying in ${retryIn}s.`,
      );
      return;
    }
    streamDeck.logger.warn(
      `Audio server still offline after ${this.connectFailures} attempt(s): ${reason}. Next retry in ${retryIn}s.`,
    );
  }

  /**
   * A request timed out. Enough consecutive timeout *episodes* mean the socket
   * is open but the server has stopped answering (a hang, which fires no close
   * event), so tear the socket down and back off as if the connect had failed.
   *
   * Episodes, not requests: a session read goes out as one count call plus N
   * index calls sharing a single deadline, so one slow moment on the server
   * times every one of them out within milliseconds of each other. Counting
   * those individually meant a *single* stutter supplied the whole
   * REQUEST_TIMEOUT_TRIP budget and dropped the connection for up to 30s — the
   * keys went dead on the first hiccup of a game launch. Timeouts closer
   * together than one request deadline are therefore one failure.
   */
  private noteRequestTimeout(): void {
    if (!this.socket) {
      return;
    }
    const now = Date.now();
    if (now - this.lastRequestTimeoutAt > REQUEST_TIMEOUT_MS) {
      this.requestTimeouts += 1;
    }
    this.lastRequestTimeoutAt = now;
    if (this.requestTimeouts < REQUEST_TIMEOUT_TRIP) {
      return;
    }
    this.requestTimeouts = 0;
    this.lastRequestTimeoutAt = 0;
    const socket = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;
    try {
      socket.terminate();
    } catch {
      // Already gone — nothing to do.
    }
    this.noteConnectFailure(
      `${REQUEST_TIMEOUT_TRIP} request-timeout episodes (socket open, server not answering)`,
    );
  }
}

export const audioControlClient = new AudioControlClient();

export function clampVolume(volume: number): number {
  return Math.max(0, Math.min(1, volume));
}

export function getApplicationLabel(application: ApplicationInstance): string {
  // Use `||` (not `??`) so an empty/whitespace displayName falls through to a
  // stable identifier. The executable path is the same across restarts, whereas
  // the PID fallback changes every launch — keying saved per-app volume on a
  // PID-based label is why some apps were forgotten after a reboot.
  return (
    application.displayName?.trim() ||
    application.name?.trim() ||
    application.executableFile?.trim() ||
    `PID ${application.processID}`
  );
}
