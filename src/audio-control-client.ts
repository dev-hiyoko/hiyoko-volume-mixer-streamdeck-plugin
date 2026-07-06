import streamDeck from "@elgato/streamdeck";
import WebSocket, { type RawData } from "ws";

// Our bundled WASAPI server (see audio-server-process.ts), not the Elgato
// server's 1844.
const AUDIO_CONTROL_URL = "ws://127.0.0.1:1845";
const REQUEST_TIMEOUT_MS = 3000;

// Reconnect backoff. The audio server may be briefly unavailable — during the
// plugin's own startup before it has finished spawning, or across a manual
// restart — so the ~1.5s poll loop must not hammer a fresh socket at it every
// cycle. After repeated failures we stop attempting until an exponentially
// growing window elapses, then let exactly one retry through (half-open); a
// real response resets it, another failure widens it (capped).
const CONNECT_BACKOFF_BASE_MS = 1000;
const CONNECT_BACKOFF_MAX_MS = 30000;
// Consecutive request timeouts that mean the socket is open but the server has
// stopped answering (that state emits no close event, so connect-failure
// backoff alone never engages). At this many, tear the socket down and back off.
const REQUEST_TIMEOUT_TRIP = 3;

export type AudioControlActivity = 2 | 3 | 4 | number;

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
  // Circuit-breaker state (see CONNECT_BACKOFF_* and ensureConnected).
  // `connectBlockedUntil` is a timestamp before which lazy reconnects fast-fail;
  // `connectFailures` sizes the backoff; `requestTimeouts` counts consecutive
  // unanswered requests so a hung-but-open server also trips it.
  private connectFailures = 0;
  private connectBlockedUntil = 0;
  private requestTimeouts = 0;

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
    if (socket) {
      try {
        socket.terminate();
      } catch {
        // Already gone — nothing to do.
      }
    }
  }

  onMessage(listener: (event: any) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  async getSystemDefaultDevice(): Promise<SystemDefaultDevice> {
    return this.request<SystemDefaultDevice>("getSystemDefaultDevice", {});
  }

  async setSystemDefaultDeviceVolume(volume: number): Promise<void> {
    await this.requestNoResponse("setSystemDefaultDeviceVolume", {
      processID: 0,
      volume: clampVolume(volume),
    });
  }

  async setSystemDefaultDeviceMute(mute: boolean): Promise<void> {
    await this.requestNoResponse("setSystemDefaultDeviceMute", {
      processID: 0,
      mute,
    });
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
   */
  async getApplicationInstances(maxAgeMs = 1000): Promise<ApplicationInstance[]> {
    const cache = this.instancesCache;
    if (cache && Date.now() - cache.at < maxAgeMs) {
      return cache.value;
    }

    if (this.instancesInFlight) {
      return this.instancesInFlight;
    }

    this.instancesInFlight = (async () => {
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
        this.instancesCache = { at: Date.now(), value: instances };
        return instances;
      } finally {
        this.instancesInFlight = undefined;
      }
    })();

    return this.instancesInFlight;
  }

  /** Drops the cached session list so the next read reflects a just-made change. */
  invalidateInstancesCache(): void {
    this.instancesCache = undefined;
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

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
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
        this.noteRequestTimeout();
        reject(new Error(`Audio Control request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

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
        this.noteConnectFailure();
        reject(error);
      };

      const onStartupClose = () => {
        cleanupStartupListeners();
        this.connectPromise = undefined;
        this.socket = undefined;
        this.noteConnectFailure();
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
    this.connectFailures = 0;
    this.connectBlockedUntil = 0;
    this.requestTimeouts = 0;
  }

  /** A connect attempt failed: grow the backoff window (capped). */
  private noteConnectFailure(): void {
    this.connectFailures += 1;
    const backoff = Math.min(
      CONNECT_BACKOFF_MAX_MS,
      CONNECT_BACKOFF_BASE_MS * 2 ** (this.connectFailures - 1),
    );
    this.connectBlockedUntil = Date.now() + backoff;
  }

  /**
   * A request timed out. Enough consecutive timeouts means the socket is open
   * but the server has stopped answering (a hang, which fires no close event),
   * so tear the socket down and back off as if the connect had failed. Guarded
   * on a live socket so a whole batch of simultaneous timeouts trips only once.
   */
  private noteRequestTimeout(): void {
    if (!this.socket) {
      return;
    }
    this.requestTimeouts += 1;
    if (this.requestTimeouts < REQUEST_TIMEOUT_TRIP) {
      return;
    }
    this.requestTimeouts = 0;
    const socket = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;
    try {
      socket.terminate();
    } catch {
      // Already gone — nothing to do.
    }
    this.noteConnectFailure();
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
