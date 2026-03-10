import {
  DEFAULT_ACCOUNT_ID,
  missingTargetError,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listOmadeusAccountIds,
  resolveDefaultOmadeusAccountId,
  resolveIgnoreSelfMessages,
  resolveOmadeusAccount,
} from "./config.js";
import { parseJaguarMessage } from "./inbound.js";
import { createOmadeusMessageHandler } from "./message-handler.js";
import { omadeusOnboardingAdapter } from "./onboarding.js";
import { sendOmadeusMessage, type OutboundDeps } from "./outbound.js";
import { getOmadeusRuntime } from "./runtime.js";
import { createDolphinSocketClient, type DolphinSocketClient } from "./socket/dolphin.socket.js";
import { createJaguarSocketClient, type JaguarSocketClient } from "./socket/jaguar.socket.js";
import { createTokenManager, type OmadeusTokenManager } from "./token.js";
import type { ResolvedOmadeusAccount as Account } from "./types.js";

// Gateway-scoped state for the running account
let activeTokenManager: OmadeusTokenManager | null = null;
let activeDolphin: DolphinSocketClient | null = null;
let activeJaguar: JaguarSocketClient | null = null;

async function persistSessionToken(token: string): Promise<void> {
  const runtime = getOmadeusRuntime();
  const cfg = runtime.config.loadConfig();
  const section = ((cfg.channels as Record<string, unknown> | undefined)?.["omadeus"] ??
    {}) as Record<string, unknown>;
  if (section["sessionToken"] === token) {
    return;
  }

  await runtime.config.writeConfigFile({
    ...cfg,
    channels: {
      ...cfg.channels,
      omadeus: {
        ...section,
        sessionToken: token,
      },
    },
  } as OpenClawConfig);
}

export const omadeusPlugin: ChannelPlugin<Account> = {
  id: "omadeus",
  meta: {
    id: "omadeus",
    label: "Omadeus",
    selectionLabel: "Omadeus (WebSocket)",
    docsPath: "/channels/omadeus",
    docsLabel: "omadeus",
    blurb: "Omadeus project management — tasks, chat rooms, and sprints.",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Omadeus: reply with plain text. Only use the message tool for proactive sends to other channels/rooms.",
    ],
  },
  actions: {
    listActions: () => ["send", "edit", "delete"],
    handleAction: async (ctx) => {
      ctx.log?.info(`[omadeus] handleAction - context: ${JSON.stringify(ctx)}`);
      ctx.log?.info(`[omadeus] handleAction - action: ${ctx.action}`);

      // Return null to fall through to default handler
      return null as never;
    },
  },
  reload: { configPrefixes: ["channels.omadeus"] },
  onboarding: omadeusOnboardingAdapter,

  // -------------------------------------------------------------------------
  // Config adapter
  // -------------------------------------------------------------------------
  config: {
    listAccountIds: (cfg) => listOmadeusAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOmadeusAccount({ cfg, accountId }),
    defaultAccountId: (_cfg) => resolveDefaultOmadeusAccountId(_cfg),
    isConfigured: (account) => account.credentialSource !== "none",
    unconfiguredReason: () =>
      "Omadeus requires email, password, and organizationId. Run: openclaw setup omadeus",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      baseUrl: account.maestroUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveOmadeusAccount({ cfg, accountId });
      return (account.config.dm?.allowFrom ?? []).map(String);
    },
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((e) => String(e).trim()).filter(Boolean),
  },

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "open",
      allowFrom: account.config.dm?.allowFrom ?? [],
      allowFromPath: "channels.omadeus.dm.",
      approveHint: "openclaw config set channels.omadeus.dm.allowFrom '[\"*\"]'",
    }),
  },

  // -------------------------------------------------------------------------
  // Setup adapter
  // -------------------------------------------------------------------------
  setup: {
    validateInput: ({ input }) => {
      if (!input.email && !input.useEnv) {
        return "Omadeus requires --email (or use OMADEUS_EMAIL env var).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId: _accountId, input }) => {
      const casUrl = input.httpUrl?.trim() || undefined;
      const maestroUrl = input.url?.trim() || undefined;
      const email = input.email?.trim() || undefined;
      const password = input.password?.trim() || undefined;
      const organizationId = input.organizationId
        ? Number(String(input.organizationId).trim())
        : undefined;

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          omadeus: {
            ...(cfg.channels as Record<string, unknown>)?.["omadeus"],
            enabled: true,
            ...(casUrl ? { casUrl } : {}),
            ...(maestroUrl ? { maestroUrl } : {}),
            ...(email ? { email } : {}),
            ...(password ? { password } : {}),
            ...(organizationId ? { organizationId } : {}),
          },
        },
      } as OpenClawConfig;
    },
  },

  // -------------------------------------------------------------------------
  // Outbound adapter
  // -------------------------------------------------------------------------
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: (text, limit) => getOmadeusRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (!trimmed) {
        return { ok: false, error: missingTargetError("Omadeus", "<roomId>") };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text }) => {
      if (!activeJaguar || !activeTokenManager) {
        throw new Error("Omadeus: not connected. Is the gateway running with Omadeus enabled?");
      }
      const deps: OutboundDeps = {
        apiOpts: {
          maestroUrl: resolveOmadeusAccount({
            cfg: getOmadeusRuntime().loadConfig(),
          }).maestroUrl,
          tokenManager: activeTokenManager,
        },
        jaguarSocket: activeJaguar,
      };
      return sendOmadeusMessage(deps, { to, text });
    },
  },

  // -------------------------------------------------------------------------
  // Status adapter
  // -------------------------------------------------------------------------
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const issues: ChannelStatusIssue[] = [];
        if (entry.enabled !== false && entry.configured !== true) {
          issues.push({
            channel: "omadeus",
            accountId: String(entry.accountId ?? DEFAULT_ACCOUNT_ID),
            kind: "config",
            message: "Omadeus credentials are missing.",
            fix: "Run: openclaw setup omadeus",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      baseUrl: account.maestroUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  // -------------------------------------------------------------------------
  // Gateway adapter — starts sockets on gateway boot
  // -------------------------------------------------------------------------
  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg, abortSignal } = ctx;
      ctx.log?.info(`[omadeus] starting for org ${account.organizationId}`);

      if (account.credentialSource === "none") {
        ctx.log?.warn("[omadeus] skipping start: credentials not configured");
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastError: "credentials not configured",
        });
        return;
      }

      const hasCachedSession = Boolean(account.sessionToken?.trim());
      if (!account.password && !hasCachedSession) {
        ctx.log?.warn("[omadeus] skipping start: password/sessionToken not set");
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastError: "password/sessionToken not set",
        });
        return;
      }

      const log = ctx.log ?? { info: () => {}, warn: () => {}, error: () => {} };

      // Auth
      const tokenManager = createTokenManager({
        casUrl: account.casUrl,
        maestroUrl: account.maestroUrl,
        email: account.email,
        password: account.password,
        organizationId: account.organizationId,
        initialToken: account.sessionToken,
        onRefresh: (token) => {
          log.info("[omadeus] token refreshed");
          void persistSessionToken(token).catch((err) =>
            log.warn(`[omadeus] failed to persist session token: ${String(err)}`),
          );
        },
        onError: (err) => {
          log.error(`[omadeus] token refresh failed: ${err.message}`);
          ctx.setStatus({ accountId: account.accountId, lastError: err.message });
        },
      });

      try {
        await tokenManager.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[omadeus] initial auth failed: ${msg}`);
        ctx.setStatus({ accountId: account.accountId, running: false, lastError: msg });
        return;
      }

      tokenManager.startAutoRefresh();
      activeTokenManager = tokenManager;

      const selfReferenceId = tokenManager.getPayload().referenceId;
      const ignoreSelfMessages = resolveIgnoreSelfMessages(cfg);

      const outboundDeps: OutboundDeps = {
        apiOpts: { maestroUrl: account.maestroUrl, tokenManager },
        jaguarSocket: null as unknown as JaguarSocketClient,
      };

      const handleMessage = createOmadeusMessageHandler({
        cfg,
        runtime: ctx.runtime,
        log,
        outboundDeps,
      });

      // Jaguar socket (chat — DMs, nugget/task/project rooms)
      const jaguar = createJaguarSocketClient({
        maestroUrl: account.maestroUrl,
        tokenManager,
        log,
        onMessage: (msg) => {
          const label =
            msg.subscribableKind === "direct"
              ? `DM from ${msg.senderReferenceId}`
              : `${msg.subscribableKind}/${msg.roomName ?? msg.roomId} from ${msg.senderReferenceId}`;
          log.info(`[jaguar] ${label}: ${msg.body.slice(0, 80)}`);

          const inbound = parseJaguarMessage(msg, { selfReferenceId, ignoreSelfMessages }, log);
          if (inbound) {
            log.info(
              `[jaguar] inbound: ${inbound.subscribableKind} room=${inbound.roomId} ` +
                `from=${inbound.from} mention=${inbound.isMention}`,
            );
            ctx.setStatus({ accountId: account.accountId, lastInboundAt: Date.now() });
            handleMessage(inbound).catch((err) => {
              log.error(
                `[jaguar] dispatch error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        },
        onOtherEvent: (data) => {
          log.info(`[jaguar] non-message event: ${JSON.stringify(data).slice(0, 120)}`);
        },
        onConnect: () =>
          ctx.setStatus({
            accountId: account.accountId,
            connected: true,
            lastConnectedAt: Date.now(),
          }),
        onDisconnect: () => ctx.setStatus({ accountId: account.accountId, connected: false }),
        onError: (err) => ctx.setStatus({ accountId: account.accountId, lastError: err.message }),
      });

      // Dolphin socket (data — tasks, projects, sprints, releases)
      const dolphin = createDolphinSocketClient({
        maestroUrl: account.maestroUrl,
        tokenManager,
        log,
        onEvent: (data) => {
          log.info(`[dolphin] event: ${JSON.stringify(data).slice(0, 120)}`);
          // TODO: handle task assignment/update events as they are discovered
        },
        onConnect: () =>
          ctx.setStatus({
            accountId: account.accountId,
            connected: true,
            lastConnectedAt: Date.now(),
          }),
        onDisconnect: () => ctx.setStatus({ accountId: account.accountId, connected: false }),
        onError: (err) => ctx.setStatus({ accountId: account.accountId, lastError: err.message }),
      });

      // Wire the jaguar socket into outbound deps now that it's created
      outboundDeps.jaguarSocket = jaguar;

      jaguar.connect();
      dolphin.connect();
      activeJaguar = jaguar;
      activeDolphin = dolphin;

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        tokenManager.stopAutoRefresh();
        jaguar.disconnect();
        dolphin.disconnect();
        activeTokenManager = null;
        activeJaguar = null;
        activeDolphin = null;
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };

      // Keep this account runner alive until the gateway aborts it.
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      cleanup();
    },
  },
};
