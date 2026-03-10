import { sendRoomMessage } from "./api/message.api.js";
import type { JaguarSocketClient } from "./socket/jaguar.socket.js";
import type { OmadeusApiOptions } from "./utils/http.util.js";

export type OutboundDeps = {
  apiOpts: OmadeusApiOptions;
  jaguarSocket: JaguarSocketClient;
};

export async function sendOmadeusMessage(
  deps: OutboundDeps,
  params: { to: string; text: string },
): Promise<{ channel: string; messageId: string; chatId: string }> {
  const { to, text } = params;

  const result = await sendRoomMessage(deps.apiOpts, { roomId: to, body: text });
  if (!result.ok) {
    throw new Error(`Omadeus send failed: ${result.error}`);
  }

  return {
    channel: "omadeus",
    messageId: String(result.message?.id ?? ""),
    chatId: to,
  };
}
