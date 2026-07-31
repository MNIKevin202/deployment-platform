import { loadConfig } from "./config.js";
import { matchCommand } from "./commands.js";
import { findBannedWord } from "./moderation.js";
import { renderWelcomeMessage } from "./welcome.js";
import { channelsFromListReply, channelsToJoin } from "./joins.js";
import { IrcConnection, prefixNick, type IrcLine } from "./irc-client.js";

const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const LIST_REPLY_TIMEOUT_MS = 8000;

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function isChannel(target: string | undefined): target is string {
  return typeof target === "string" && (target.startsWith("#") || target.startsWith("&"));
}

/** Sends LIST and collects RPL_LIST (322) lines until RPL_LISTEND (323) or a timeout. */
function requestChannelList(conn: IrcConnection): Promise<IrcLine[]> {
  return new Promise((resolve) => {
    const collected: IrcLine[] = [];

    const timer = setTimeout(() => {
      unsubscribe();
      resolve(collected);
    }, LIST_REPLY_TIMEOUT_MS);

    const unsubscribe = conn.onLine((line) => {
      if (line.command === "322") {
        collected.push(line);
      } else if (line.command === "323") {
        clearTimeout(timer);
        unsubscribe();
        resolve(collected);
      }
    });

    conn.send("LIST");
  });
}

async function runConnection(config: ReturnType<typeof loadConfig>): Promise<void> {
  const conn = await IrcConnection.connect(config.host, config.port);
  await conn.register(config.nick);
  await conn.oper(config.operUsername, config.operPassword);
  log("connected", { host: config.host, port: config.port, nick: config.nick });

  const joinedChannels = new Set<string>();

  conn.onLine((line) => {
    if (line.command === "JOIN") {
      const channel = line.params[0];
      const nick = prefixNick(line.prefix);
      if (!channel || !nick) {
        return;
      }
      if (nick === config.nick) {
        joinedChannels.add(channel);
        log("bot-joined", { channel });
        return;
      }
      log("join", { channel, nick });
      const welcome = renderWelcomeMessage(config.welcomeMessageTemplate, nick);
      if (welcome) {
        conn.send(`PRIVMSG ${channel} :${welcome}`);
      }
      return;
    }

    if (line.command === "PART" || line.command === "KICK") {
      log(line.command.toLowerCase(), { channel: line.params[0], nick: prefixNick(line.prefix) });
      return;
    }

    if (line.command === "PRIVMSG") {
      const [target, message] = line.params;
      const nick = prefixNick(line.prefix);
      if (!isChannel(target) || !nick || nick === config.nick || !message) {
        return;
      }
      log("privmsg", { channel: target, nick, message });

      const reply = matchCommand(message, {
        prefix: config.commandPrefix,
        rulesText: config.rulesText,
        customCommands: config.botCommands
      });
      if (reply) {
        conn.send(`PRIVMSG ${target} :${reply}`);
      }

      const bannedWord = findBannedWord(message, config.bannedWords);
      if (bannedWord) {
        log("moderation-match", { channel: target, nick, bannedWord, action: config.moderationAction });
        conn.send(`NOTICE ${target} :${nick}: that message was flagged by the server's word filter.`);
        if (config.moderationAction === "kick") {
          conn.send(`KICK ${target} ${nick} :Message violated server rules`);
        }
      }
    }
  });

  await joinAllChannels(conn, joinedChannels);

  const pollTimer = setInterval(() => {
    void joinAllChannels(conn, joinedChannels).catch((error) => {
      log("join-poll-error", { message: error instanceof Error ? error.message : String(error) });
    });
  }, config.joinPollIntervalSeconds * 1000);

  await new Promise<void>((resolve) => {
    conn.onClose(() => {
      clearInterval(pollTimer);
      log("disconnected");
      resolve();
    });
  });
}

async function joinAllChannels(conn: IrcConnection, joinedChannels: Set<string>): Promise<void> {
  const listLines = await requestChannelList(conn);
  const serverChannels = channelsFromListReply(listLines);
  const toJoin = channelsToJoin(serverChannels, joinedChannels);

  for (const channel of toJoin) {
    conn.send(`JOIN ${channel}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  let delayMs = RECONNECT_BASE_DELAY_MS;

  for (;;) {
    try {
      await runConnection(config);
      delayMs = RECONNECT_BASE_DELAY_MS;
    } catch (error) {
      log("connection-error", { message: error instanceof Error ? error.message : String(error) });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
  }
}

main().catch((error) => {
  console.error("Fatal error starting Quipora Bot:", error);
  process.exit(1);
});
