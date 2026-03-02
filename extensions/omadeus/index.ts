import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { omadeusPlugin } from "./src/channel.js";
import { setOmadeusRuntime } from "./src/runtime.js";

const plugin = {
  id: "omadeus",
  name: "Omadeus",
  description: "Omadeus project management channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setOmadeusRuntime(api.runtime);
    api.registerChannel({ plugin: omadeusPlugin });
  },
};

export default plugin;
