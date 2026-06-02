import streamDeck from "@elgato/streamdeck";

const AUDIO_SERVER_URL = "ws://127.0.0.1:1844";

type AudioEvent = {
  method?: string;
  params?: Record<string, unknown>;
};

type Listener = (event: AudioEvent) => void;

export class AudioControlClient {
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private requestId = 1;
  private listeners = new Set<Listener>();

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      return;
    }

    this.socket = new WebSocket(AUDIO_SERVER_URL);

    this.socket.addEventListener("open", () => {
      streamDeck.logger.info(`Connected to ${AUDIO_SERVER_URL}`);
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as AudioEvent;
        for (const listener of this.listeners) {
          listener(data);
        }
      } catch (error) {
        streamDeck.logger.warn("Ignoring non-JSON audio server message", error);
      }
    });

    this.socket.addEventListener("close", () => {
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", (error) => {
      streamDeck.logger.warn("Audio server WebSocket error", error);
    });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    this.connect();
    return () => this.listeners.delete(listener);
  }

  send(method: string, params: Record<string, unknown> = {}): void {
    this.connect();

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      streamDeck.logger.warn(`Audio server is not connected; cannot send ${method}`);
      return;
    }

    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId++,
        method,
        params,
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 2000);
  }
}

export const audioControlClient = new AudioControlClient();
