import type { OmadeusApiOptions } from "./api.js";
import { sendRoomMessage } from "./api.js";
import type { JaguarSocketClient } from "./jaguar-socket.js";

export type OutboundDeps = {
  apiOpts: OmadeusApiOptions;
  jaguarSocket: JaguarSocketClient;
};

/**
 * Send a text message to an Omadeus room.
 *
 * Always uses the REST API so we get a confirmed message ID back.
 * The `to` parameter is the room ID (numeric, passed as string through
 * the OpenClaw outbound pipeline).
 */
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
