import {
  createReplyPrefixContext,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { sendOmadeusMessage, type OutboundDeps } from "./outbound.js";
import { getOmadeusRuntime } from "./runtime.js";

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  debug?: (msg: string) => void;
};

export type CreateOmadeusReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: Log;
  outboundDeps: OutboundDeps;
  roomId: string;
};

export function createOmadeusReplyDispatcher(params: CreateOmadeusReplyDispatcherParams) {
  const core = getOmadeusRuntime();
  const { cfg, agentId, roomId, accountId } = params;

  const prefixContext = createReplyPrefixContext({ cfg, agentId });
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "omadeus", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "omadeus");

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (!text.trim()) return;

        const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await sendOmadeusMessage(params.outboundDeps, { to: String(roomId), text: chunk });
        }
      },
      onError: (error, info) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        params.runtime.error?.(`omadeus ${info.kind} reply failed: ${errMsg}`);
        params.log.error("reply failed", { kind: info.kind, error: errMsg });
      },
    });

  return {
    dispatcher,
    replyOptions: { ...replyOptions, onModelSelected: prefixContext.onModelSelected },
    markDispatchIdle,
  };
}
