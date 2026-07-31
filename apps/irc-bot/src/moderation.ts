/** Returns the first banned word found as a case-insensitive substring of the message, or null. */
export function findBannedWord(message: string, bannedWords: string[]): string | null {
  const lower = message.toLowerCase();
  for (const word of bannedWords) {
    const trimmed = word.trim();
    if (trimmed && lower.includes(trimmed.toLowerCase())) {
      return trimmed;
    }
  }
  return null;
}
