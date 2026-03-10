import { createAuthorizationCode, createCasToken, obtainSessionToken } from "./api/auth.api.js";
import { clearCasSession } from "./store.js";
import type { OmadeusJwtPayload } from "./types.js";
import { decodeJwtPayload } from "./utils/jwt.util.js";

export async function authenticate(params: {
  casUrl: string;
  maestroUrl: string;
  email: string;
  password: string;
  organizationId: number;
}): Promise<{ token: string; payload: OmadeusJwtPayload }> {
  const { casUrl, maestroUrl, email, password, organizationId } = params;
  const { token } = await createCasToken({ casUrl, email, password });

  const authorizationCode = await createAuthorizationCode({
    casUrl,
    token,
    email,
    redirectUri: maestroUrl,
  });
  // CAS session no longer needed after obtaining the authorization code
  clearCasSession();

  const dolphinToken = await obtainSessionToken({
    maestroUrl,
    authorizationCode,
    organizationId,
  });
  const payload = decodeJwtPayload(dolphinToken);

  return { dolphinToken, payload };
}
