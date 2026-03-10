import type { OmadeusTokenManager } from "../token.js";
import { createOmadeusSocketClient, type OmadeusSocketClient } from "./socket.js";

export type DolphinSocketOptions = {
  maestroUrl: string;
  tokenManager: OmadeusTokenManager;
  /** Called for every event received on the Dolphin data socket. */
  onEvent?: (data: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export type DolphinSocketClient = OmadeusSocketClient;

export function createDolphinSocketClient(opts: DolphinSocketOptions): DolphinSocketClient {
  const { maestroUrl, tokenManager, onEvent, onConnect, onDisconnect, onError, log } = opts;

  return createOmadeusSocketClient({
    maestroUrl,
    tokenManager,
    pathSuffix: "dolphin-ws",
    logPrefix: "[dolphin]",
    onEvent,
    onConnect,
    onDisconnect,
    onError,
    log,
  });
}
