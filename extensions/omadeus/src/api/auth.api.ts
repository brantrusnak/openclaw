import { getCasSession, setCasSession } from "../store.js";
import type {
  CasAuthorizationCodeResponse,
  OmadeusOrganization,
  OmadeusSessionTokenResponse,
} from "../types.js";

const CAS_APPLICATION_ID = 1;
const CAS_SCOPES = "title,email,avatar,firstName,lastName,birth,phone,countryCode";

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
