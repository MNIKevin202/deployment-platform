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

function readPersistedState(filePath: string): Partial<BotStateData> | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Partial<BotStateData>) : null;
  } catch (error) {
    console.error("Failed to read persisted bot state; ignoring it:", error);
    return null;
  }
}

export class BotState {
  private data: BotStateData;

  private constructor(
    data: BotStateData,
    private readonly filePath: string
  ) {
    this.data = data;
  }

  static load(config: BotConfig, filePath: string): BotState {
    const merged = mergeState(stateFromConfig(config), readPersistedState(filePath));
    return new BotState(merged, filePath);
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

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error("Failed to persist bot state:", error);
    }
  }
}
