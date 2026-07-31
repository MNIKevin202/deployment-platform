import { withIrcServiceSession } from "./irc-client-service.js";

export interface RegisteredChannel {
  name: string;
  memberCount: number;
  founder: string | null;
  registeredAt: string | null;
}

export interface ChanServActionResult {
  ok: boolean;
  message: string;
}

/**
 * Parses `ChanServ INFO #channel`'s reply. Verified against the real
 * server's exact wording:
 *   "Channel #x is registered" / "Channel #x is not registered"
 *   "Founder: <name>"
 *   "Registered at: <date>"
 * Returns null for an unregistered channel rather than a half-filled object.
 */
export function parseChannelInfo(
  lines: string[],
  channelName: string
): Pick<RegisteredChannel, "name" | "founder" | "registeredAt"> | null {
  const notRegistered = lines.some((line) => /\bis not registered\b/i.test(line));
  if (notRegistered) {
    return null;
  }

  let founder: string | null = null;
  let registeredAt: string | null = null;

  for (const line of lines) {
    const founderMatch = line.match(/^Founder:\s*(.+)$/i);
    if (founderMatch) {
      founder = founderMatch[1].trim();
      continue;
    }

    const registeredMatch = line.match(/^Registered at:\s*(.+)$/i);
    if (registeredMatch) {
      registeredAt = registeredMatch[1].trim();
    }
  }

  return { name: channelName, founder, registeredAt };
}

/**
 * Ergo's UNREGISTER/TRANSFER commands both require a confirmation code:
 * calling without one replies with a line like
 *   "To confirm, run this command: /CS UNREGISTER #chan a1b2c3"
 * — verified against the real server. The code is always the final
 * whitespace-separated token on that line.
 */
export function extractConfirmationCode(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(/run this command:\s*(.+)$/i);
    if (match) {
      const tokens = match[1].trim().split(/\s+/);
      return tokens.at(-1) ?? null;
    }
  }
  return null;
}

/**
 * Runs the standard IRC LIST (every channel currently active on the server —
 * anyone in it, registered or not), then ChanServ INFO on each to attach
 * registration details where they exist. A channel with no registration
 * still gets an entry, just with `founder`/`registeredAt` left null, so the
 * Channels tab reflects what's actually happening on the server rather than
 * only what ChanServ knows about.
 */
export async function listRegisteredChannels(
  host: string,
  port: number,
  operatorUsername: string,
  operatorPassword: string
): Promise<RegisteredChannel[]> {
  return withIrcServiceSession(host, port, operatorUsername, operatorPassword, async (session) => {
    const active = await session.listChannels();

    const channels: RegisteredChannel[] = [];
    for (const { name, memberCount } of active) {
      const infoReply = await session.chanServCommand(`INFO ${name}`);
      const info = parseChannelInfo(infoReply, name);
      channels.push({
        name,
        memberCount,
        founder: info?.founder ?? null,
        registeredAt: info?.registeredAt ?? null
      });
    }

    return channels.sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Unregisters (drops) a channel — the two-step confirm-code flow, done automatically in one session. */
export async function unregisterChannel(
  host: string,
  port: number,
  operatorUsername: string,
  operatorPassword: string,
  channelName: string
): Promise<ChanServActionResult> {
  return withIrcServiceSession(host, port, operatorUsername, operatorPassword, async (session) => {
    const promptReply = await session.chanServCommand(`UNREGISTER ${channelName}`);
    const code = extractConfirmationCode(promptReply);

    if (!code) {
      return { ok: false, message: promptReply.at(-1) ?? "Unable to unregister this channel" };
    }

    const confirmReply = await session.chanServCommand(`UNREGISTER ${channelName} ${code}`);
    const success = confirmReply.some((line) => /unregistered/i.test(line));

    return {
      ok: success,
      message: confirmReply.at(-1) ?? (success ? "Channel unregistered" : "Unable to unregister this channel")
    };
  });
}

/**
 * Transfers channel ownership to a different account. As a server-admin
 * operator this completes immediately — verified via ChanServ's own HELP
 * text: "Unless you are an IRC operator with the correct permissions, [the
 * recipient] must then accept the transfer."
 */
export async function transferChannel(
  host: string,
  port: number,
  operatorUsername: string,
  operatorPassword: string,
  channelName: string,
  newFounder: string
): Promise<ChanServActionResult> {
  return withIrcServiceSession(host, port, operatorUsername, operatorPassword, async (session) => {
    const promptReply = await session.chanServCommand(`TRANSFER ${channelName} ${newFounder}`);
    const code = extractConfirmationCode(promptReply);

    if (!code) {
      return { ok: false, message: promptReply.at(-1) ?? "Unable to transfer this channel" };
    }

    const confirmReply = await session.chanServCommand(`TRANSFER ${channelName} ${newFounder} ${code}`);
    const success = confirmReply.some((line) => /transferred/i.test(line));

    return {
      ok: success,
      message: confirmReply.at(-1) ?? (success ? "Channel transferred" : "Unable to transfer this channel")
    };
  });
}
