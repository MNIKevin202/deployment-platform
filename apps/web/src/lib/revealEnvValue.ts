/**
 * Fetches one environment variable's plaintext from its admin-gated reveal
 * endpoint (global: /api/environment/global/:id/reveal, or per-app:
 * /api/apps/:id/environment/:variableId/reveal). The value is requested only on
 * an explicit "Show" click and is never part of a list response. Throws on any
 * non-OK response or missing value so the UI can show "Could not reveal".
 */
export async function revealEnvValue(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Reveal failed (${response.status})`);
  }
  const body = (await response.json()) as { success?: boolean; value?: string | null };
  if (!body.success || typeof body.value !== "string") {
    throw new Error("Reveal returned no value");
  }
  return body.value;
}
