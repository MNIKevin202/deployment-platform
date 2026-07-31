import { randomBytes } from "node:crypto";
import { loadConfig, type BotConfig } from "./config.js";
import { matchCommand } from "./commands.js";
import { findBannedWord } from "./moderation.js";
import { renderWelcomeMessage } from "./welcome.js";
import { channelsFromListReply, channelsToJoin } from "./joins.js";
import { pongReply } from "./ping.js";
import { interpretServiceReply, isReservedNickError, type ServiceCommandResult } from "./nickserv.js";
import { BotState } from "./state.js";
import { startAdminServer, type BotRuntime } from "./admin-server.js";
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

async function joinAllChannels(conn: IrcConnection, joinedChannels: Set<string>): Promise<void> {
  const listLines = await requestChannelList(conn);
  const serverChannels = channelsFromListReply(listLines);
  const toJoin = channelsToJoin(serverChannels, joinedChannels);

  for (const channel of toJoin) {
    conn.send(`JOIN ${channel}`);
  }
}

/**
 * Registers under the bot's configured nick. If that nick is registered to
 * this same bot's own account (from a previous run's "Register Nickname"),
 * Ergo refuses to hand it out to a fresh, unauthenticated connection — so
 * this falls back to a temporary alternate nick, IDENTIFYs with the stored
 * account password, and reclaims the real nick via NICK. Returns whichever
 * nick the connection actually ended up under.
 */
async function claimIdentity(conn: IrcConnection, config: BotConfig, state: BotState): Promise<string> {
  try {
    await conn.register(config.nick);
    return config.nick;
  } catch (error) {
    const password = state.getNickServPassword();
    if (!isReservedNickError(error) || !password) {
      throw error;
    }

    log("nick-reserved-falling-back", { nick: config.nick });
    const altNick = `${config.nick}-${randomBytes(2).toString("hex")}`;
    await conn.register(altNick);

    const identifyLines = await conn.serviceCommand("NickServ", `IDENTIFY ${password}`);
    const identifyResult = interpretServiceReply(identifyLines);
    if (!identifyResult.ok) {
      log("nickserv-identify-failed", { message: identifyResult.message });
      return altNick;
    }

    const reclaimed = await conn.changeNick(config.nick);
    return reclaimed ? config.nick : altNick;
  }
}

async function runConnection(config: BotConfig, state: BotState, runtime: BotRuntime): Promise<void> {
  const conn = await IrcConnection.connect(config.host, config.port);
  const actualNick = await claimIdentity(conn, config, state);
  await conn.oper(config.operUsername, config.operPassword);
  log("connected", { host: config.host, port: config.port, nick: actualNick });

  const joinedChannels = new Set<string>();
  runtime.connected = true;
  runtime.nick = actualNick;
  runtime.joinedChannels = joinedChannels;
  runtime.registerNick = async (password: string, email?: string): Promise<ServiceCommandResult> => {
    const command = email ? `REGISTER ${password} ${email}` : `REGISTER ${password}`;
    const lines = await conn.serviceCommand("NickServ", command);
    const result = interpretServiceReply(lines);
    if (result.ok) {
      state.setNickRegistered(true);
      state.setNickServPassword(password);
    }
    return result;
  };

  conn.onLine((line) => {
    const pong = pongReply(line);
    if (pong) {
      conn.send(pong);
      return;
    }

    if (line.command === "JOIN") {
      const channel = line.params[0];
      const nick = prefixNick(line.prefix);
      if (!channel || !nick) {
        return;
      }
      if (nick === actualNick) {
        joinedChannels.add(channel);
        log("bot-joined", { channel });
        return;
      }
      log("join", { channel, nick });
      const welcome = renderWelcomeMessage(state.get().welcomeMessageTemplate, nick);
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
      if (!isChannel(target) || !nick || nick === actualNick || !message) {
        return;
      }
      log("privmsg", { channel: target, nick, message });

      const current = state.get();
      const reply = matchCommand(message, {
        prefix: current.commandPrefix,
        rulesText: current.rulesText,
        customCommands: current.botCommands
      });
      if (reply) {
        conn.send(`PRIVMSG ${target} :${reply}`);
      }

      const bannedWord = findBannedWord(message, current.bannedWords);
      if (bannedWord) {
        log("moderation-match", { channel: target, nick, bannedWord, action: current.moderationAction });
        conn.send(`NOTICE ${target} :${nick}: that message was flagged by the server's word filter.`);
        if (current.moderationAction === "kick") {
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
      runtime.connected = false;
      runtime.registerNick = null;
      log("disconnected");
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = BotState.load(config, config.stateFilePath);
  const runtime: BotRuntime = {
    connected: false,
    nick: config.nick,
    joinedChannels: new Set(),
    registerNick: null
  };

  startAdminServer(config.adminPort, state, runtime);

  let delayMs = RECONNECT_BASE_DELAY_MS;

  for (;;) {
    try {
      await runConnection(config, state, runtime);
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
