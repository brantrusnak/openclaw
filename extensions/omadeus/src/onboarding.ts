import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
} from "openclaw/plugin-sdk";
import { listOrganizations } from "./api/auth.api.js";
import { authenticate } from "./auth.js";
import { resolveOmadeusAccount } from "./config.js";
import type { OmadeusChannelConfig } from "./types.js";

const channel = "omadeus" as const;

type CoreConfig = OpenClawConfig & {
  channels?: { omadeus?: OmadeusChannelConfig };
};

function getOmadeusSection(cfg: OpenClawConfig): OmadeusChannelConfig | undefined {
  return (cfg as CoreConfig).channels?.omadeus;
}

function setOmadeusDmPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
  const allowFrom =
    policy === "open" ? addWildcardAllowFrom(getOmadeusSection(cfg)?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      omadeus: {
        ...getOmadeusSection(cfg),
        dm: {
          ...getOmadeusSection(cfg)?.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

async function promptOmadeusAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const existing = getOmadeusSection(cfg)?.dm?.allowFrom ?? [];

  while (true) {
    const entry = await prompter.text({
      message: "Omadeus allowFrom (user IDs or reference IDs, comma-separated)",
      placeholder: "123, 456",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = String(entry)
      .split(/[\n,;]+/g)
      .map((e) => e.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      await prompter.note("Enter at least one user.", "Omadeus allowlist");
      continue;
    }
    const unique = mergeAllowFromEntries(existing.map(String), parts);
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        omadeus: {
          ...getOmadeusSection(cfg),
          dm: {
            ...getOmadeusSection(cfg)?.dm,
            policy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    };
  }
}

async function noteOmadeusAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Omadeus authenticates via CAS + Maestro (email + password + organization).",
      "You need:",
      "  - CAS URL (authentication server)",
      "  - Maestro URL (API server)",
      "  - Email + password",
      "  - Organization ID (we can look it up for you)",
      "Env vars supported: OMADEUS_EMAIL, OMADEUS_PASSWORD, OMADEUS_ORGANIZATION_ID,",
      "  OMADEUS_CAS_URL, OMADEUS_MAESTRO_URL.",
      `Docs: ${formatDocsLink("/channels/omadeus", "omadeus")}`,
    ].join("\n"),
    "Omadeus setup",
  );
}

async function promptOrganizationId(params: {
  prompter: WizardPrompter;
  maestroUrl: string;
  email: string;
  existing?: number;
}): Promise<number> {
  const { prompter, maestroUrl, email, existing } = params;

  // Try to list organizations from the API
  if (maestroUrl && email) {
    try {
      const orgs = await listOrganizations({ maestroUrl, email });
      if (orgs.length > 0) {
        if (orgs.length === 1) {
          await prompter.note(
            `Found organization: ${orgs[0]!.title} (${orgs[0]!.id})`,
            "Omadeus organization",
          );
          return orgs[0]!.id;
        }
        const choice = await prompter.select({
          message: "Select organization",
          options: orgs.map((org) => ({
            value: String(org.id),
            label: `${org.title} (${org.membersCount} members)`,
            hint: `ID: ${org.id}`,
          })),
          initialValue: existing ? String(existing) : String(orgs[0]!.id),
        });
        return Number(choice);
      }
    } catch {
      await prompter.note(
        "Could not fetch organizations from the API. Enter the ID manually.",
        "Omadeus organization",
      );
    }
  }

  const raw = await prompter.text({
    message: "Organization ID (number)",
    initialValue: existing ? String(existing) : undefined,
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return "Required";
      if (!/^\d+$/.test(trimmed)) return "Must be a number";
      return undefined;
    },
  });
  return Number(String(raw).trim());
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Omadeus",
  channel,
  policyKey: "channels.omadeus.dm.policy",
  allowFromKey: "channels.omadeus.dm.allowFrom",
  getCurrent: (cfg) => (getOmadeusSection(cfg)?.dm?.policy as DmPolicy) ?? "open",
  setPolicy: (cfg, policy) => setOmadeusDmPolicy(cfg, policy),
  promptAllowFrom: promptOmadeusAllowFrom,
};

export const omadeusOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveOmadeusAccount({ cfg });
    const configured = account.credentialSource !== "none";
    return {
      channel,
      configured,
      statusLines: [
        `Omadeus: ${configured ? "configured" : "needs email, password, and organization ID"}`,
      ],
      selectionHint: configured ? "configured" : "needs credentials",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter, forceAllowFrom }) => {
    const account = resolveOmadeusAccount({ cfg });
    const section = getOmadeusSection(cfg) ?? {};
    let next = cfg;

    if (account.credentialSource === "none") {
      await noteOmadeusAuthHelp(prompter);
    }

    const envEmail = process.env.OMADEUS_EMAIL?.trim();
    const envPassword = process.env.OMADEUS_PASSWORD?.trim();
    const envOrgId = process.env.OMADEUS_ORGANIZATION_ID?.trim();
    const envCasUrl = process.env.OMADEUS_CAS_URL?.trim();
    const envMaestroUrl = process.env.OMADEUS_MAESTRO_URL?.trim();
    const hasConfigCreds = Boolean(
      section.email?.trim() && section.password?.trim() && section.organizationId,
    );
    const canUseEnv = Boolean(!hasConfigCreds && envEmail && envPassword && envOrgId);

    let casUrl: string | undefined;
    let maestroUrl: string | undefined;
    let email: string | undefined;
    let password: string | undefined;
    let organizationId: number | undefined;

    if (canUseEnv) {
      const useEnv = await prompter.confirm({
        message:
          "OMADEUS_EMAIL + OMADEUS_PASSWORD + OMADEUS_ORGANIZATION_ID detected. Use env vars?",
        initialValue: true,
      });
      if (useEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            omadeus: {
              ...getOmadeusSection(next),
              enabled: true,
              ...(envCasUrl ? { casUrl: envCasUrl } : {}),
              ...(envMaestroUrl ? { maestroUrl: envMaestroUrl } : {}),
            },
          },
        };
        if (forceAllowFrom) {
          next = await promptOmadeusAllowFrom({ cfg: next, prompter });
        }
        return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "Omadeus credentials already configured. Keep them?",
        initialValue: true,
      });
      if (keep) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            omadeus: { ...getOmadeusSection(next), enabled: true },
          },
        };
        if (forceAllowFrom) {
          next = await promptOmadeusAllowFrom({ cfg: next, prompter });
        }
        return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
      }
    }

    casUrl = String(
      await prompter.text({
        message: "CAS URL (authentication server)",
        initialValue: section.casUrl ?? envCasUrl,
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) return "Required";
          if (!/^https?:\/\//i.test(raw)) return "Use a full URL (https://...)";
          return undefined;
        },
      }),
    ).trim();

    maestroUrl = String(
      await prompter.text({
        message: "Maestro URL (API server)",
        initialValue: section.maestroUrl ?? envMaestroUrl,
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) return "Required";
          if (!/^https?:\/\//i.test(raw)) return "Use a full URL (https://...)";
          return undefined;
        },
      }),
    ).trim();

    email = String(
      await prompter.text({
        message: "Omadeus email",
        initialValue: section.email ?? envEmail,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    password = String(
      await prompter.text({
        message: "Omadeus password",
        initialValue: section.password ?? envPassword,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    organizationId = await promptOrganizationId({
      prompter,
      maestroUrl: maestroUrl ?? section.maestroUrl ?? "",
      email,
      existing: section.organizationId,
    });

    // Verify the full auth flow before saving
    let sessionToken: string | undefined;
    while (true) {
      try {
        const { dolphinToken, payload } = await authenticate({
          casUrl,
          maestroUrl,
          email,
          password,
          organizationId,
        });
        sessionToken = dolphinToken;
        await prompter.note(`Authenticated as ${payload.email}`, "Omadeus authentication");
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await prompter.note(`Authentication failed: ${msg}`, "Omadeus authentication");
        const retry = await prompter.confirm({
          message: "Re-enter email/password and try again?",
          initialValue: true,
        });
        if (!retry) {
          await prompter.note(
            "Saving config without verifying credentials. The gateway may fail to connect.",
            "Omadeus authentication",
          );
          break;
        }
        email = String(
          await prompter.text({
            message: "Omadeus email",
            initialValue: email,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();
        password = String(
          await prompter.text({
            message: "Omadeus password",
            initialValue: password,
            validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    }

    const ignoreSelfMessages = await prompter.confirm({
      message: "Ignore messages sent by the authenticated user?",
      initialValue: section.ignoreSelfMessages !== false,
    });

    next = {
      ...next,
      channels: {
        ...next.channels,
        omadeus: {
          ...getOmadeusSection(next),
          enabled: true,
          casUrl,
          maestroUrl,
          email,
          password,
          organizationId,
          ...(sessionToken ? { sessionToken } : {}),
          ignoreSelfMessages,
        },
      },
    };

    if (forceAllowFrom) {
      next = await promptOmadeusAllowFrom({ cfg: next, prompter });
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      omadeus: { ...getOmadeusSection(cfg), enabled: false },
    },
  }),
};
