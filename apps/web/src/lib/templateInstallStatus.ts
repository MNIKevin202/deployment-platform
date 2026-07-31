import { imageRepoName } from "./appKind";

export interface InstalledTemplateMatch {
  appId: number;
  appName: string;
}

/**
 * The first existing app running the same image as this template, if any.
 * Matched on the bare image repository name (registry/namespace/tag
 * stripped) so a template pinned to postgres:16-alpine still matches an
 * existing app running postgres:15 — same software, different tag.
 */
export function findInstalledTemplateApp(
  template: { image: string },
  storedApps: ReadonlyArray<{ id: number; name: string; image: string }>
): InstalledTemplateMatch | null {
  const repo = imageRepoName(template.image);
  const match = storedApps.find((app) => imageRepoName(app.image) === repo);
  return match ? { appId: match.id, appName: match.name } : null;
}
