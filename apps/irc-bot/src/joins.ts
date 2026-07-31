import type { IrcLine } from "./irc-client.js";

/** RPL_LIST (322) params are: <nick> <channel> <#visible> :<topic>. */
export function channelsFromListReply(lines: IrcLine[]): string[] {
  return lines
    .filter((line) => line.command === "322")
    .map((line) => line.params[1])
    .filter((channel): channel is string => Boolean(channel));
}

/** Channels present on the server but not yet in our joined set, compared case-insensitively. */
export function channelsToJoin(serverChannels: string[], joinedChannels: Set<string>): string[] {
  const joinedLower = new Set([...joinedChannels].map((c) => c.toLowerCase()));
  return serverChannels.filter((channel) => !joinedLower.has(channel.toLowerCase()));
}
