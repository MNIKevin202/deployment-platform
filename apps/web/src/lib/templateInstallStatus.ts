import { imageRepoName } from "./appKind";
import { APP_TEMPLATES, type AppTemplate } from "./appTemplates";

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

export interface RequiredDatabaseStatus {
  /** The required companion template (e.g. MariaDB for Joomla). */
  template: AppTemplate;
  /** Whether an app already running that image was found. */
  installed: boolean;
}

/**
 * A template's companion-database requirement, and whether it's already
 * satisfied. Returns null when the template has no such requirement. Purely
 * informational — never used to block Install, since the user may already
 * have a compatible database running under a different name.
 */
export function requiredDatabaseStatus(
  template: Pick<AppTemplate, "requiresTemplateId">,
  storedApps: ReadonlyArray<{ id: number; name: string; image: string }>
): RequiredDatabaseStatus | null {
  if (!template.requiresTemplateId) {
    return null;
  }

  const dbTemplate = APP_TEMPLATES.find((t) => t.id === template.requiresTemplateId);
  if (!dbTemplate) {
    return null;
  }

  return {
    template: dbTemplate,
    installed: findInstalledTemplateApp(dbTemplate, storedApps) !== null
  };
}
