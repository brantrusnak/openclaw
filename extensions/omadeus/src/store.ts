// In-memory store for CAS session credentials (token + refresh cookie)
// persisted between auth steps within a single process lifetime.

export type CasSession = {
  token: string;
  refreshCookie: string;
};

let currentSession: CasSession | null = null;

export function setCasSession(session: CasSession): void {
  currentSession = session;
}

export function getCasSession(): CasSession | null {
  return currentSession;
}

export function clearCasSession(): void {
  currentSession = null;
}
