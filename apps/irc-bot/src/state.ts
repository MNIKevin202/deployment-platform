import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotConfig } from "./config.js";

export interface MutableBotFields {
  welcomeMessageTemplate: string;
  commandPrefix: string;
  rulesText: string;
  botCommands: Record<string, string>;
  bannedWords: string[];
  moderationAction: "warn" | "kick";
}

export interface BotStateData extends MutableBotFields {
  nickRegistered: boolean;
}

/**
 * The NickServ account password, kept separate from BotStateData so it can
 * never leak through get() (used to answer GET /config over the admin API).
 * Persisted to the same file, on the same volume, purely so the bot can
 * IDENTIFY and reclaim its own registered nick after a restart or
 * reconnect — once a nick is registered, Ergo refuses to let anyone
 * (including its rightful owner) use it again without proving ownership.
 */
interface PersistedFile extends BotStateData {
  nickServPassword?: string | null;
}

export function stateFromConfig(config: BotConfig): BotStateData {
  return {
    welcomeMessageTemplate: config.welcomeMessageTemplate,
    commandPrefix: config.commandPrefix,
    rulesText: config.rulesText,
    botCommands: config.botCommands,
    bannedWords: config.bannedWords,
    moderationAction: config.moderationAction,
    nickRegistered: false
  };
}

/** A persisted state file always wins over env defaults for the fields it contains. */
export function mergeState(base: BotStateData, persisted: Partial<BotStateData> | null): BotStateData {
  return persisted ? { ...base, ...persisted } : base;
}

function readPersistedState(filePath: string): PersistedFile | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as PersistedFile) : null;
  } catch (error) {
    console.error("Failed to read persisted bot state; ignoring it:", error);
    return null;
  }
}

export class BotState {
  private data: BotStateData;
  private nickServPassword: string | null;

  private constructor(
    data: BotStateData,
    nickServPassword: string | null,
    private readonly filePath: string
  ) {
    this.data = data;
    this.nickServPassword = nickServPassword;
  }

  static load(config: BotConfig, filePath: string): BotState {
    const persisted = readPersistedState(filePath);
    const merged = mergeState(stateFromConfig(config), persisted);
    return new BotState(merged, persisted?.nickServPassword ?? null, filePath);
  }

  get(): BotStateData {
    return { ...this.data, botCommands: { ...this.data.botCommands }, bannedWords: [...this.data.bannedWords] };
  }

  update(patch: Partial<MutableBotFields>): BotStateData {
    this.data = { ...this.data, ...patch };
    this.persist();
    return this.get();
  }

  setNickRegistered(value: boolean): void {
    this.data = { ...this.data, nickRegistered: value };
    this.persist();
  }

  getNickServPassword(): string | null {
    return this.nickServPassword;
  }

  setNickServPassword(password: string): void {
    this.nickServPassword = password;
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload: PersistedFile = { ...this.data, nickServPassword: this.nickServPassword };
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.error("Failed to persist bot state:", error);
    }
  }
}
