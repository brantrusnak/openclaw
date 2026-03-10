import {
  DEFAULT_ACCOUNT_ID,
  createScopedPairingAccess,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveControlCommandGate,
  resolveDmGroupAccessWithLists,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { OutboundDeps } from "./outbound.js";
import { createOmadeusReplyDispatcher } from "./reply-dispatcher.js";
import { getOmadeusRuntime } from "./runtime.js";
import type { OmadeusChannelConfig, OmadeusInboundMessage } from "./types.js";

type Log = {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
};

export type OmadeusMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  log: Log;
  outboundDeps: OutboundDeps;
};

export function createOmadeusMessageHandler(deps: OmadeusMessageHandlerDeps) {
  const { cfg, runtime, log, outboundDeps } = deps;
  const core = getOmadeusRuntime();
  const omadeusCfg = (cfg.channels as Record<string, unknown> | undefined)?.["omadeus"] as
    | OmadeusChannelConfig
    | undefined;

  const pairing = createScopedPairingAccess({
    core,
    channel: "omadeus",
    accountId: DEFAULT_ACCOUNT_ID,
  });

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "omadeus",
  });

  const handleMessageNow = async (inbound: OmadeusInboundMessage) => {
    const isDirectMessage = inbound.subscribableKind === "direct";
    const senderId = String(inbound.fromReferenceId);
    const senderName = inbound.from;
    const roomId = String(inbound.roomId);
    const rawBody = inbound.content;

    if (!rawBody.trim()) {
      log.debug?.("skipping empty message");
      return;
    }

    const dmPolicy = omadeusCfg?.dm?.policy ?? "open";
    const configuredDmAllowFrom = (omadeusCfg?.dm?.allowFrom ?? []).map(String);
    const storedAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "omadeus",
      accountId: pairing.accountId,
      dmPolicy,
      readStore: pairing.readStoreForDmPolicy,
    });
    const useAccessGroups =
      (cfg.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;

    if (isDirectMessage) {
      const access = resolveDmGroupAccessWithLists({
        isGroup: false,
        dmPolicy,
        groupPolicy: "disabled",
        allowFrom: configuredDmAllowFrom,
        storeAllowFrom: storedAllowFrom,
        groupAllowFromFallbackToAllowFrom: false,
        isSenderAllowed: (allowFrom) =>
          allowFrom.some((a) => a === "*" || a === senderId || a === senderName),
      });

      if (access.decision !== "allow") {
        if (access.reason === "dmPolicy=disabled") {
          log.debug?.("dropping dm (dms disabled)");
          return;
        }
        if (access.decision === "pairing") {
          const request = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName },
          });
          if (request) {
            log.info("pairing request created", { sender: senderId, label: senderName });
          }
        }
        log.debug?.("dropping dm (not allowlisted)", { sender: senderId, label: senderName });
        return;
      }
    }

    // For group messages, only respond when mentioned (unless groupPolicy is open)
    if (!isDirectMessage && !inbound.isMention) {
      log.debug?.("skipping group message (not mentioned)");
      return;
    }

    const hasControlCommand = core.channel.text.hasControlCommand(rawBody, cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        {
          configured: configuredDmAllowFrom.length > 0,
          allowed: configuredDmAllowFrom.some(
            (a) => a === "*" || a === senderId || a === senderName,
          ),
        },
      ],
      allowTextCommands: true,
      hasControlCommand,
    });

    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: (msg) => log.debug?.(msg),
        channel: "omadeus",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const omadeusFrom = isDirectMessage ? `omadeus:${senderId}` : `omadeus:group:${roomId}`;
    const omadeusTo = isDirectMessage ? `room:${roomId}` : `room:${roomId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "omadeus",
      peer: {
        kind: isDirectMessage ? "direct" : "group",
        id: isDirectMessage ? senderId : roomId,
      },
    });

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Omadeus DM from ${senderName}`
      : `Omadeus message in ${inbound.subscribableKind}/${inbound.roomName ?? roomId} from ${senderName}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `omadeus:message:${roomId}:${inbound.timestamp}`,
    });

    const envelopeFrom = isDirectMessage ? senderName : (inbound.roomName ?? roomId);
    const storePath = core.channel.session.resolveStorePath(
      (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
      { agentId: route.agentId },
    );
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const timestamp = inbound.timestamp ? new Date(inbound.timestamp) : undefined;
    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Omadeus",
      from: envelopeFrom,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: rawBody,
      RawBody: rawBody,
      CommandBody: rawBody.trim(),
      BodyForCommands: rawBody.trim(),
      From: omadeusFrom,
      To: omadeusTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : "group",
      ConversationLabel: envelopeFrom,
      GroupSubject: !isDirectMessage ? (inbound.roomName ?? inbound.subscribableKind) : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "omadeus" as const,
      Surface: "omadeus" as const,
      Timestamp: inbound.timestamp ?? Date.now(),
      WasMentioned: isDirectMessage || inbound.isMention,
      CommandAuthorized: commandGate.commandAuthorized,
      OriginatingChannel: "omadeus" as const,
      OriginatingTo: omadeusTo,
    });

    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        log.debug?.(`omadeus: failed updating session meta: ${String(err)}`);
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createOmadeusReplyDispatcher({
      cfg,
      agentId: route.agentId,
      accountId: route.accountId,
      runtime,
      log,
      outboundDeps,
      roomId,
    });

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions,
          }),
      });

      log.info("dispatch complete", { queuedFinal, counts });
      const finalCount = counts.final;
      if (queuedFinal) {
        log.debug?.(
          `omadeus: delivered ${finalCount} repl${finalCount === 1 ? "y" : "ies"} to room ${roomId}`,
        );
      }
    } catch (err) {
      log.error("dispatch failed", { error: String(err) });
      runtime.error?.(`omadeus dispatch failed: ${String(err)}`);
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<OmadeusInboundMessage>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      return `omadeus:${entry.roomId}:${entry.fromReferenceId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.content.trim()) return false;
      return !core.channel.text.hasControlCommand(entry.content, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;

      if (entries.length === 1) {
        await handleMessageNow(last);
        return;
      }

      // Combine debounced messages into a single inbound
      const combinedContent = entries
        .map((e) => e.content)
        .filter(Boolean)
        .join("\n");
      if (!combinedContent.trim()) return;

      await handleMessageNow({
        ...last,
        content: combinedContent,
        isMention: entries.some((e) => e.isMention),
      });
    },
    onError: (err) => {
      runtime.error?.(`omadeus debounce flush failed: ${String(err)}`);
    },
  });

  return async function handleOmadeusMessage(inbound: OmadeusInboundMessage) {
    await inboundDebouncer.enqueue(inbound);
  };
}
