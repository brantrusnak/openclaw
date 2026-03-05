import { randomUUID } from "node:crypto";
import type { OmadeusTokenManager } from "./auth.js";
import { getCasSession, setCasSession } from "./store.js";
import type {
  CasAuthorizationCodeResponse,
  OmadeusOrganization,
  OmadeusSessionTokenResponse,
  OmadeusMessage,
} from "./types.js";

const CAS_APPLICATION_ID = 1;
const CAS_SCOPES = "title,email,avatar,firstName,lastName,birth,phone,countryCode";

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
  try {
    return await fetch(url, {
      ...init,
      headers: { ...authHeaders(token), ...(init?.headers as Record<string, string>) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Omadeus API request to ${url} failed: ${message}`);
  }
}

function generateTemporaryId(): string {
  return `_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Omadeus + CAS auth-related API helpers
// ---------------------------------------------------------------------------

export async function createCasToken(params: {
  casUrl: string;
  email: string;
  password: string;
}): Promise<{ token: string; refreshCookie: string }> {
  const { casUrl, email, password } = params;
  const url = `${casUrl}/apiv1/tokens`;
  const jsonBody = JSON.stringify({ email, password });
  const res = await fetch(url, {
    method: "CREATE",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Content-Length": String(jsonBody.length),
    },
    body: jsonBody,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS token request failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { token: string };
  const refreshCookie = res.headers.get("set-cookie") ?? "";

  setCasSession({ token: body.token, refreshCookie });

  return { token: body.token, refreshCookie };
}

export async function getMe(params: {
  casUrl: string;
  casToken: string;
  refreshCookie?: string;
}): Promise<{ email: string }> {
  const { casUrl, casToken, refreshCookie } = params;
  const url = `${casUrl}/apiv1/members/me`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${casToken}`,
      "Content-Type": "application/json;charset=UTF-8",
      ...(refreshCookie ? { Cookie: refreshCookie } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS get member failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { email: string };
}

export async function createAuthorizationCode(params: {
  casUrl: string;
  token: string;
  email: string;
  redirectUri?: string;
}): Promise<string> {
  const { casUrl, token, email, redirectUri } = params;
  const casSession = getCasSession();
  const qs = new URLSearchParams({
    applicationId: String(CAS_APPLICATION_ID),
    scopes: CAS_SCOPES,
    state: email,
    redirectUri: redirectUri ?? "",
  });
  if (redirectUri) qs.set("redirectUri", redirectUri);
  const url = `${casUrl}/apiv1/authorizationcodes?${qs}`;
  // CAS backend (nanohttp/restfulpy) rejects this endpoint when Content-Length is absent.
  // Use a tiny JSON body so fetch transports a concrete payload length.
  const body = "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(casSession?.refreshCookie ? { Cookie: casSession.refreshCookie } : {}),
  };
  const res = await fetch(url, {
    method: "CREATE",
    body,
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS authorization code request failed (${res.status}): ${text}`);
  }
  const jsonResponse = (await res.json()) as CasAuthorizationCodeResponse;
  const code = jsonResponse.authorizationCode ?? jsonResponse.code;
  if (!code) {
    throw new Error("CAS authorization code response missing code");
  }
  return code;
}

export async function obtainSessionToken(params: {
  maestroUrl: string;
  authorizationCode: string;
  organizationId: number;
}): Promise<string> {
  const { maestroUrl, authorizationCode, organizationId } = params;
  const url = `${maestroUrl}/dolphin/apiv1/oauth2/tokens`;
  const res = await fetch(url, {
    method: "OBTAIN",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ authorizationCode, organizationId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus session token request failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as OmadeusSessionTokenResponse;
  if (!body.token) {
    throw new Error("Omadeus session token response missing token");
  }
  return body.token;
}

export async function listOrganizations(params: {
  maestroUrl: string;
  email: string;
}): Promise<OmadeusOrganization[]> {
  const { maestroUrl, email } = params;
  const url = `${maestroUrl}/dolphin/apiv1/organizations`;
  const res = await fetch(url, {
    method: "LIST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list organizations failed (${res.status}): ${text}`);
  }
  return (await res.json()) as OmadeusOrganization[];
}

// ---------------------------------------------------------------------------
// Send a message to a Jaguar room
// POST /jaguar/apiv1/rooms/{roomId}/messages
// ---------------------------------------------------------------------------

export async function sendRoomMessage(
  opts: OmadeusApiOptions,
  params: { roomId: number | string; body: string },
): Promise<{ ok: boolean; message?: OmadeusMessage; error?: string }> {
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 300) };
  }
}
