export interface CommandContext {
  prefix: string;
  rulesText: string;
  customCommands: Record<string, string>;
}

/** Returns the reply text for a chat command, or null if the message isn't a recognized command. */
export function matchCommand(message: string, ctx: CommandContext): string | null {
  if (!ctx.prefix || !message.startsWith(ctx.prefix)) {
    return null;
  }

  const word = message.trim().split(/\s+/)[0];

  if (word === `${ctx.prefix}help`) {
    const customNames = Object.keys(ctx.customCommands);
    const builtins = [`${ctx.prefix}help`, `${ctx.prefix}rules`];
    return `Commands: ${[...builtins, ...customNames].join(", ")}`;
  }

  if (word === `${ctx.prefix}rules`) {
    return ctx.rulesText || "No rules have been configured for this server.";
  }

  return ctx.customCommands[word] ?? null;
}
