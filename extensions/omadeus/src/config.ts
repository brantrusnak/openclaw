import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OmadeusChannelConfig, ResolvedOmadeusAccount } from "./types.js";

function getOmadeusSection(cfg: OpenClawConfig): OmadeusChannelConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.["omadeus"] as
    | OmadeusChannelConfig
    | undefined;
}

export function listOmadeusAccountIds(cfg: OpenClawConfig): string[] {
  const section = getOmadeusSection(cfg);
  if (!section) return [];
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultOmadeusAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveOmadeusAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOmadeusAccount {
  const { cfg } = params;
  const section = getOmadeusSection(cfg) ?? {};
  const email = section.email?.trim() ?? "";
  const password = section.password?.trim() ?? "";
  const orgId = section.organizationId;
  const sessionToken = section.sessionToken?.trim() ?? "";
  const hasCredentials = Boolean(email && password && orgId);
  const hasSessionToken = Boolean(sessionToken);
  const credentialSource = hasCredentials ? "config" : hasSessionToken ? "session" : "none";

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: "Omadeus",
    enabled: section.enabled !== false,
    config: section,
    casUrl: section.casUrl?.trim() ?? "",
    maestroUrl: section.maestroUrl?.trim() ?? "",
    email,
    password,
    organizationId: orgId ?? 0,
    ...(hasSessionToken ? { sessionToken } : {}),
    credentialSource,
  };
}

/** Whether messages from the authenticated user should be ignored. */
export function resolveIgnoreSelfMessages(cfg: OpenClawConfig): boolean {
  const section = getOmadeusSection(cfg);
  // Default: true (ignore own messages). Set to false to receive your own messages.
  return section?.ignoreSelfMessages !== false;
}
