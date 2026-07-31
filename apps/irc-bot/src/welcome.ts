/** Renders a welcome message template, substituting `{nick}` for the joining user's nick. */
export function renderWelcomeMessage(template: string, nick: string): string | null {
  if (!template.trim()) {
    return null;
  }
  return template.replaceAll("{nick}", nick);
}
