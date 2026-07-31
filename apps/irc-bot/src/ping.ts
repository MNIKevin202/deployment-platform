import type { IrcLine } from "./irc-client.js";

/** The PONG command to send in reply to a server PING, or null if the line isn't a PING. */
export function pongReply(line: IrcLine): string | null {
  if (line.command !== "PING") {
    return null;
  }
  return `PONG :${line.params[0] ?? ""}`;
}
