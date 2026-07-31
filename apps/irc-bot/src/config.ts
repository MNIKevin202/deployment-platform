export interface BotConfig {
  host: string;
  port: number;
  nick: string;
  operUsername: string;
  operPassword: string;
  joinPollIntervalSeconds: number;
  welcomeMessageTemplate: string;
  commandPrefix: string;
  rulesText: string;
  botCommands: Record<string, string>;
  bannedWords: string[];
  moderationAction: "warn" | "kick";
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseBotCommands(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to empty map below
  }
  console.error("BOT_COMMANDS is not valid JSON; ignoring it");
  return {};
}

function parseBannedWords(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const moderationAction = env.MODERATION_ACTION === "kick" ? "kick" : "warn";

  return {
    host: requireEnv(env, "IRC_HOST"),
    port: env.IRC_PORT ? Number(env.IRC_PORT) : 6697,
    nick: env.IRC_BOT_NICK?.trim() || "QuiporaBot",
    operUsername: requireEnv(env, "IRC_OPER_USER"),
    operPassword: requireEnv(env, "IRC_OPER_PASS"),
    joinPollIntervalSeconds: env.JOIN_POLL_INTERVAL_SECONDS
      ? Number(env.JOIN_POLL_INTERVAL_SECONDS)
      : 30,
    welcomeMessageTemplate: env.WELCOME_MESSAGE_TEMPLATE ?? "",
    commandPrefix: env.COMMAND_PREFIX?.trim() || "!",
    rulesText: env.RULES_TEXT ?? "",
    botCommands: parseBotCommands(env.BOT_COMMANDS),
    bannedWords: parseBannedWords(env.BANNED_WORDS),
    moderationAction
  };
}
