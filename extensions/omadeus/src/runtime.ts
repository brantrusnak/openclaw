import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setOmadeusRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getOmadeusRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Omadeus runtime not initialized");
  }
  return runtime;
}
