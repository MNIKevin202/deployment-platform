/** Whether a JOIN by `nick` to `channel` should be immediately kicked as a blocked channel. */
export function shouldKickForBlockedChannel(
  channel: string,
  nick: string,
  actualNick: string,
  blockedChannels: string[]
): boolean {
  return nick !== actualNick && blockedChannels.includes(channel);
}
