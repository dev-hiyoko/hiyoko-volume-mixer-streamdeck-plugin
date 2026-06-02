import streamDeck, { action, type KeyDownEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { audioControlClient } from "../audio-control-client.js";

type JsonRpcCommandSettings = JsonObject & {
  method?: string;
  params?: Record<string, unknown>;
};

@action({ UUID: "fun.hiyoko.audiomixer.json-rpc-command" })
export class JsonRpcCommandAction extends SingletonAction<JsonRpcCommandSettings> {
  override async onWillAppear(ev: WillAppearEvent<JsonRpcCommandSettings>): Promise<void> {
    await ev.action.setTitle(ev.payload.settings.method ? "JSON-RPC\nReady" : "JSON-RPC\nSetup");
  }

  override async onKeyDown(ev: KeyDownEvent<JsonRpcCommandSettings>): Promise<void> {
    const { method, params = {} } = ev.payload.settings;

    if (!method) {
      await ev.action.setTitle("Set\nMethod");
      return;
    }

    streamDeck.logger.info(`Sending audio JSON-RPC method: ${method}`);
    audioControlClient.send(method, params);
    await ev.action.setTitle("Sent");
  }
}
