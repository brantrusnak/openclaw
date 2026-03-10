import type { OmadeusJwtPayload } from "../types.js";

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
