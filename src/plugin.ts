import streamDeck from "@elgato/streamdeck";

import { JsonRpcCommandAction } from "./actions/json-rpc-command.js";
import { MasterStatusAction } from "./actions/master-status.js";
import { audioControlClient } from "./audio-control-client.js";

streamDeck.actions.registerAction(new MasterStatusAction());
streamDeck.actions.registerAction(new JsonRpcCommandAction());

audioControlClient.connect();

streamDeck.connect();
