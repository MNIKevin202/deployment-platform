export interface ServiceCommandResult {
  ok: boolean;
  message: string;
}

const FAILURE_MARKERS = ["already registered", "error", "invalid", "failed", "you must", "denied"];

/** Turns NickServ's raw NOTICE reply lines into a plain ok/message result for the admin API. */
export function interpretRegisterReply(lines: string[]): ServiceCommandResult {
  if (lines.length === 0) {
    return { ok: false, message: "No response from NickServ." };
  }

  const message = lines.join(" ");
  const lower = message.toLowerCase();
  const ok = !FAILURE_MARKERS.some((marker) => lower.includes(marker));

  return { ok, message };
}
