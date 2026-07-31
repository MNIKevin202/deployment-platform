import type { MutableBotFields } from "./state.js";

export type ConfigPatchResult =
  | { ok: true; patch: Partial<MutableBotFields> }
  | { ok: false; message: string };

/** Validates an untrusted request body into a partial state patch, rejecting unknown shapes field by field. */
export function validateConfigPatch(body: unknown): ConfigPatchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const input = body as Record<string, unknown>;
  const patch: Partial<MutableBotFields> = {};

  if ("welcomeMessageTemplate" in input) {
    if (typeof input.welcomeMessageTemplate !== "string") {
      return { ok: false, message: "welcomeMessageTemplate must be a string." };
    }
    patch.welcomeMessageTemplate = input.welcomeMessageTemplate;
  }

  if ("commandPrefix" in input) {
    if (typeof input.commandPrefix !== "string" || input.commandPrefix.length === 0) {
      return { ok: false, message: "commandPrefix must be a non-empty string." };
    }
    patch.commandPrefix = input.commandPrefix;
  }

  if ("rulesText" in input) {
    if (typeof input.rulesText !== "string") {
      return { ok: false, message: "rulesText must be a string." };
    }
    patch.rulesText = input.rulesText;
  }

  if ("botCommands" in input) {
    const commands = input.botCommands;
    if (
      typeof commands !== "object" ||
      commands === null ||
      Array.isArray(commands) ||
      Object.values(commands).some((value) => typeof value !== "string")
    ) {
      return { ok: false, message: "botCommands must be an object mapping commands to string replies." };
    }
    patch.botCommands = commands as Record<string, string>;
  }

  if ("bannedWords" in input) {
    const words = input.bannedWords;
    if (!Array.isArray(words) || words.some((word) => typeof word !== "string")) {
      return { ok: false, message: "bannedWords must be an array of strings." };
    }
    patch.bannedWords = words as string[];
  }

  if ("moderationAction" in input) {
    if (input.moderationAction !== "warn" && input.moderationAction !== "kick") {
      return { ok: false, message: "moderationAction must be 'warn' or 'kick'." };
    }
    patch.moderationAction = input.moderationAction;
  }

  return { ok: true, patch };
}
