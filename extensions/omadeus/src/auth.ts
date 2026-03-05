import { createAuthorizationCode, createCasToken, obtainSessionToken } from "./api.js";
import { clearCasSession } from "./store.js";
import type { OmadeusJwtPayload } from "./types.js";

// Re-authenticate 5 minutes before expiry
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Node.js timers use a 32-bit signed integer for delays; clamp below this to avoid overflow warnings.
const MAX_TIMEOUT_MS = 2_147_483_647;

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
  const { token } = await createCasToken({ casUrl, email, password });

  const authCode = await createAuthorizationCode({
    casUrl,
    token,
    email,
    redirectUri: maestroUrl,
  });
  // CAS session no longer needed after obtaining the authorization code
  clearCasSession();

  const dolphinToken = await obtainSessionToken({
    maestroUrl,
    authorizationCode: authCode,
    organizationId,
  });
  const payload = decodeJwtPayload(dolphinToken);

  return { dolphinToken, payload };
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
  initialToken?: string;
  onRefresh?: (token: string) => void;
  onError?: (error: Error) => void;
}): OmadeusTokenManager {
  const { casUrl, maestroUrl, email, password, organizationId, initialToken, onRefresh, onError } =
    params;

  let currentToken = "";
  let currentPayload: OmadeusJwtPayload | null = null;
  if (initialToken) {
    try {
      const payload = decodeJwtPayload(initialToken);
      currentToken = initialToken;
      currentPayload = payload;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      // Ignore malformed seed token and fall back to authenticate().
    }
  }
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    if (currentToken && !shouldRefreshToken(currentToken)) {
      return;
    }
    const { dolphinToken, payload } = await authenticate({
      casUrl,
      maestroUrl,
      email,
      password,
      organizationId,
    });
    currentToken = dolphinToken;
    currentPayload = payload;
    onRefresh?.(dolphinToken);
  };

  const scheduleNextRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (!currentToken) return;

    const expiresInMs = tokenExpiresInMs(currentToken);
    const desiredDelayMs = expiresInMs - TOKEN_REFRESH_MARGIN_MS;
    const refreshInMs = Math.min(Math.max(desiredDelayMs, 10_000), MAX_TIMEOUT_MS);

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
      try {
        await refresh();
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
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
