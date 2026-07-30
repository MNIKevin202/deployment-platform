/**
 * Browser-only update detection. The running tab knows which JS bundle it
 * actually loaded; the server's index.html always references the currently
 * deployed bundle. If those differ, a newer version has been deployed — the
 * "update" is simply reloading the tab. No server, build, or infra changes
 * are involved: everything happens in the browser.
 */

/** The file name (last path segment) of a URL. */
export function basename(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  return withoutQuery.split("/").pop() ?? withoutQuery;
}

/** Extracts the entry bundle file name from an index.html string. */
export function extractEntryBundle(html: string): string | null {
  // Prefer the ES-module entry script; fall back to any /assets/*.js script.
  const moduleMatch = html.match(
    /<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i
  ) ?? html.match(/<script[^>]*\bsrc=["']([^"']*\/assets\/[^"']+\.js)["']/i);

  return moduleMatch ? basename(moduleMatch[1]) : null;
}

/** The bundle the current tab is actually running, read from the live DOM. */
export function getRunningBundle(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const scripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[src]')
  ).map((script) => script.src);

  const entry = scripts.find((src) => /\/assets\/[^/]+\.js(\?|#|$)/.test(src)) ?? scripts[0];
  return entry ? basename(entry) : null;
}

/** The bundle the server currently serves, from a fresh index.html fetch. */
export async function fetchServedBundle(): Promise<string | null> {
  const response = await fetch(`/?_=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return extractEntryBundle(await response.text());
}

export interface UpdateStatus {
  running: string | null;
  served: string | null;
  updateAvailable: boolean;
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const running = getRunningBundle();
  const served = await fetchServedBundle();
  const updateAvailable = Boolean(running && served && running !== served);
  return { running, served, updateAvailable };
}
