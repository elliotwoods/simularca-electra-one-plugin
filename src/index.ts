import type { PluginHandshakeModule } from "./contracts";
import { createElectraOnePlugin } from "./electraOnePlugin";
import { PLUGIN_VERSION } from "./pluginBuildInfo.generated";

export { ElectraOneInspector, ElectraOneRuntime, createElectraOnePlugin } from "./electraOnePlugin";
export { ElectraSession } from "./connectionState";

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "plugin.electraOneMini",
    name: "Electra One Surface",
    version: PLUGIN_VERSION,
    description:
      "Turns an Electra One Mini into a hardware control surface for the selected actor's inspector, over Web MIDI/SysEx with a self-contained on-device Lua app.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return createElectraOnePlugin();
  }
};

export { handshake };
export default handshake;
