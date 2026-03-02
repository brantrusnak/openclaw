import { randomUUID } from "node:crypto";
import type { OmadeusTokenManager } from "./auth.js";
import type { OmadeusMessage } from "./types.js";

export type OmadeusApiOptions = {
  maestroUrl: string;
  tokenManager: OmadeusTokenManager;
};

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiFetch(
  opts: OmadeusApiOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const token = opts.tokenManager.getToken();
  if (!token) throw new Error("Omadeus: not authenticated");
  const url = `${opts.maestroUrl}${path}`;
  return fetch(url, {
    ...init,
    headers: { ...authHeaders(token), ...(init?.headers as Record<string, string>) },
  });
}

function generateTemporaryId(): string {
  return `_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Send a message to a Jaguar room
// POST /jaguar/apiv1/rooms/{roomId}/messages
// ---------------------------------------------------------------------------

export async function sendRoomMessage(
  opts: OmadeusApiOptions,
  params: { roomId: number | string; body: string },
): Promise<{ ok: boolean; message?: OmadeusMessage; error?: string }> {
  const res = await apiFetch(opts, `/jaguar/apiv1/rooms/${params.roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body: params.body,
      temporaryId: generateTemporaryId(),
      links: "[]",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }
  const data = (await res.json()) as OmadeusMessage;
  return { ok: true, message: data };
}
