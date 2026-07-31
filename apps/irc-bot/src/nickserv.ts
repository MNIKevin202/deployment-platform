import { IrcRegistrationError } from "./irc-client.js";

export interface ServiceCommandResult {
  ok: boolean;
  message: string;
}

const FAILURE_MARKERS = ["already registered", "error", "invalid", "failed", "you must", "denied"];

/** Turns a NickServ NOTICE reply (REGISTER or IDENTIFY) into a plain ok/message result for the admin API. */
export function interpretServiceReply(lines: string[]): ServiceCommandResult {
  if (lines.length === 0) {
    return { ok: false, message: "No response from NickServ." };
  }

  const message = lines.join(" ");
  const lower = message.toLowerCase();
  const ok = !FAILURE_MARKERS.some((marker) => lower.includes(marker));

  return { ok, message };
}

/**
 * Whether a registration failure is specifically "this nick belongs to a
 * registered account" — the case that needs the reclaim flow (connect under
 * an alternate nick, IDENTIFY, then NICK back), rather than some other
 * connection problem that should just be retried as-is.
 */
export function isReservedNickError(error: unknown): boolean {
  return error instanceof IrcRegistrationError && /reserved/i.test(error.message);
}
