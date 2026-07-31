import type { IrcLine } from "./irc-client.js";

/** The channel and kicked nick from a KICK line (params: <channel> <nick> [:reason]), or null if not a KICK. */
export function parseKick(line: IrcLine): { channel: string; target: string } | null {
  if (line.command !== "KICK") {
    return null;
  }
  const [channel, target] = line.params;
  return channel && target ? { channel, target } : null;
}
