import type {
  CasAuthorizationCodeResponse,
  OmadeusOrganization,
  OmadeusSessionTokenResponse,
  OmadeusJwtPayload,
} from "./types.js";

const CAS_APPLICATION_ID = 1;
const CAS_SCOPES = "title,email,avatar,firstName,lastName,birth,phone,countryCode";
// Re-authenticate 5 minutes before expiry
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/** Decode the payload portion of a JWT without verifying the signature. */
export function decodeJwtPayload(token: string): OmadeusJwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT: expected 3 parts");
  }
  const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
  return JSON.parse(payload) as OmadeusJwtPayload;
}

/** Returns ms until the token expires (negative = already expired). */
export function tokenExpiresInMs(token: string): number {
  const { exp } = decodeJwtPayload(token);
  return exp * 1000 - Date.now();
}

/** Whether the token should be refreshed now (within safety margin). */
export function shouldRefreshToken(token: string): boolean {
  return tokenExpiresInMs(token) < TOKEN_REFRESH_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// Step 1: CAS token (email + password -> session cookie/token)
// ---------------------------------------------------------------------------

export async function createCasToken(params: {
  casUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const { casUrl, email, password } = params;
  const url = `${casUrl}/apiv1/tokens`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS token request failed (${res.status}): ${text}`);
  }
  // CAS may return the token in the response body or set it as a cookie.
  // The authorization code step uses the CAS session, so we capture cookies.
  const setCookie = res.headers.get("set-cookie") ?? "";
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Return whichever token identifier the CAS server provides
  return (body.token as string) ?? setCookie ?? "";
}

// ---------------------------------------------------------------------------
// Step 2: Authorization code
// ---------------------------------------------------------------------------

export async function createAuthorizationCode(params: {
  casUrl: string;
  casToken: string;
  email: string;
  redirectUri?: string;
}): Promise<string> {
  const { casUrl, casToken, email, redirectUri = "http://localhost:8080" } = params;
  const qs = new URLSearchParams({
    applicationId: String(CAS_APPLICATION_ID),
    scopes: CAS_SCOPES,
    redirectUri,
    state: email,
  });
  const url = `${casUrl}/apiv1/authorizationcodes?${qs}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(casToken ? { Authorization: `Bearer ${casToken}`, Cookie: casToken } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CAS authorization code request failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as CasAuthorizationCodeResponse;
  const code = body.authorizationCode ?? body.code;
  if (!code) {
    throw new Error("CAS authorization code response missing code");
  }
  return code;
}

// ---------------------------------------------------------------------------
// Step 3: Exchange authorization code + orgId -> session JWT
// ---------------------------------------------------------------------------

export async function obtainSessionToken(params: {
  maestroUrl: string;
  authorizationCode: string;
  organizationId: number;
}): Promise<string> {
  const { maestroUrl, authorizationCode, organizationId } = params;
  const url = `${maestroUrl}/dolphin/apiv1/oauth2/tokens`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// ---------------------------------------------------------------------------
// List organizations (used during setup to help pick orgId)
// ---------------------------------------------------------------------------

export async function listOrganizations(params: {
  maestroUrl: string;
  email: string;
}): Promise<OmadeusOrganization[]> {
  const { maestroUrl, email } = params;
  const url = `${maestroUrl}/dolphin/apiv1/organizations`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Omadeus list organizations failed (${res.status}): ${text}`);
  }
  return (await res.json()) as OmadeusOrganization[];
}

// ---------------------------------------------------------------------------
// Full auth flow: email + password + orgId -> session JWT
// ---------------------------------------------------------------------------

export async function authenticate(params: {
  casUrl: string;
  maestroUrl: string;
  email: string;
  password: string;
  organizationId: number;
}): Promise<{ token: string; payload: OmadeusJwtPayload }> {
  const { casUrl, maestroUrl, email, password, organizationId } = params;

  const casToken = await createCasToken({ casUrl, email, password });
  const authCode = await createAuthorizationCode({ casUrl, casToken, email });
  const token = await obtainSessionToken({ maestroUrl, authorizationCode: authCode, organizationId });
  const payload = decodeJwtPayload(token);

  return { token, payload };
}

// ---------------------------------------------------------------------------
// Token manager: holds current token and handles refresh
// ---------------------------------------------------------------------------

export type OmadeusTokenManager = {
  getToken(): string;
  getPayload(): OmadeusJwtPayload;
  /** Refresh the token now. Throws on auth failure. */
  refresh(): Promise<void>;
  /** Start the background refresh timer. */
  startAutoRefresh(): void;
  /** Stop the background refresh timer. */
  stopAutoRefresh(): void;
  /** Whether the current token needs refresh. */
  needsRefresh(): boolean;
};

export function createTokenManager(params: {
  casUrl: string;
  maestroUrl: string;
  email: string;
  password: string;
  organizationId: number;
  onRefresh?: (token: string) => void;
  onError?: (error: Error) => void;
}): OmadeusTokenManager {
  const { casUrl, maestroUrl, email, password, organizationId, onRefresh, onError } = params;

  let currentToken = "";
  let currentPayload: OmadeusJwtPayload | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    const { token, payload } = await authenticate({
      casUrl,
      maestroUrl,
      email,
      password,
      organizationId,
    });
    currentToken = token;
    currentPayload = payload;
    onRefresh?.(token);
  };

  const scheduleNextRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (!currentToken) return;

    const expiresInMs = tokenExpiresInMs(currentToken);
    const refreshInMs = Math.max(expiresInMs - TOKEN_REFRESH_MARGIN_MS, 10_000);

    refreshTimer = setTimeout(async () => {
      try {
        await refresh();
        scheduleNextRefresh();
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        // Retry in 30s on failure
        refreshTimer = setTimeout(() => void scheduleNextRefresh(), 30_000);
      }
    }, refreshInMs);
  };

  return {
    getToken() {
      return currentToken;
    },
    getPayload() {
      if (!currentPayload) throw new Error("Omadeus: not authenticated");
      return currentPayload;
    },
    async refresh() {
      await refresh();
    },
    startAutoRefresh() {
      scheduleNextRefresh();
    },
    stopAutoRefresh() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    },
    needsRefresh() {
      return !currentToken || shouldRefreshToken(currentToken);
    },
  };
}
