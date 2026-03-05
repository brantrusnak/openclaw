import { WebSocket } from "ws";
import type { OmadeusTokenManager } from "./auth.js";
import { isOmadeusMessage } from "./inbound.js";
import type { OmadeusMessage } from "./types.js";

export type JaguarSocketOptions = {
  maestroUrl: string;
  tokenManager: OmadeusTokenManager;
  onMessage?: (msg: OmadeusMessage) => void;
  /** Called for any non-message events (typing, presence, etc.). */
  onOtherEvent?: (data: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export type JaguarSocketClient = {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  /** Send a raw JSON payload over the Jaguar socket. */
  send(data: unknown): void;
};

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export function createJaguarSocketClient(opts: JaguarSocketOptions): JaguarSocketClient {
  const {
    maestroUrl,
    tokenManager,
    onMessage,
    onOtherEvent,
    onConnect,
    onDisconnect,
    onError,
    log,
  } = opts;

  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  function buildWsUrl(): string {
    const base = maestroUrl.replace(/^http/, "ws");
    const token = tokenManager.getToken();
    return `${base}/ws?token=${encodeURIComponent(token)}`;
  }

  function scheduleReconnect() {
    if (intentionalClose) return;
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    log?.info(`[jaguar] reconnecting in ${delayMs}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => connect(), delayMs);
  }

  function connect() {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
    intentionalClose = false;

    if (tokenManager.needsRefresh()) {
      tokenManager
        .refresh()
        .then(() => connect())
        .catch((err) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
          scheduleReconnect();
        });
      return;
    }

    const url = buildWsUrl();
    log?.info("[jaguar] connecting...");

    ws = new WebSocket(url);

    ws.on("open", () => {
      reconnectAttempt = 0;
      log?.info("[jaguar] connected");
      onConnect?.();
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw)) as Record<string, unknown>;

        const content = (data as { content?: unknown }).content;
        const action = (data as { action?: unknown }).action;
        if (content === "keep-alive" && action === "answer") {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ data: "keep-alive", action: "answer" }));
          }
          return;
        }

        if (isOmadeusMessage(data)) {
          onMessage?.(data as OmadeusMessage);
        } else {
          onOtherEvent?.(data);
        }
      } catch {
        log?.warn(`[jaguar] unparseable message: ${String(raw).slice(0, 200)}`);
      }
    });

    ws.on("close", (code, reason) => {
      const msg = `code=${code} reason=${String(reason)}`;
      log?.info(`[jaguar] disconnected: ${msg}`);
      onDisconnect?.(msg);
      ws = null;
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log?.error(`[jaguar] error: ${err.message}`);
      onError?.(err);
    });
  }

  function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  }

  return {
    connect,
    disconnect,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    send: (data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },
  };
}
