import { action, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { audioControlClient } from "../audio-control-client.js";

type MasterState = {
  volume?: number;
  mute?: boolean;
};

@action({ UUID: "fun.hiyoko.audiomixer.master-status" })
export class MasterStatusAction extends SingletonAction<JsonObject> {
  private state: MasterState = {};

  constructor() {
    super();

    audioControlClient.onMessage((event) => {
      if (event.method === "currentSystemDefaultDeviceVolumeChanged") {
        this.state.volume = Number(event.params?.volume);
        void this.updateTitle();
      }

      if (event.method === "currentSystemDefaultDeviceMuteChanged") {
        this.state.mute = Boolean(event.params?.mute);
        void this.updateTitle();
      }
    });
  }

  override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
    await ev.action.setTitle(this.formatTitle());
  }

  private async updateTitle(): Promise<void> {
    const title = this.formatTitle();
    const actions = this.actions;

    await Promise.all(actions.map((actionInstance) => actionInstance.setTitle(title)));
  }

  private formatTitle(): string {
    if (this.state.volume === undefined) {
      return "Audio\nWaiting";
    }

    const percent = Math.round(this.state.volume * 100);
    return this.state.mute ? `Muted\n${percent}%` : `Master\n${percent}%`;
  }
}
