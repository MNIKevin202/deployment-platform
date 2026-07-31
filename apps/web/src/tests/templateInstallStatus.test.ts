import { describe, expect, test } from "vitest";
import { APP_TEMPLATES } from "../lib/appTemplates";
import { findInstalledTemplateApp, requiredDatabaseStatus } from "../lib/templateInstallStatus";

describe("findInstalledTemplateApp", () => {
  test("matches an existing app on bare image repo name, ignoring tag", () => {
    const match = findInstalledTemplateApp(
      { image: "postgres:16-alpine" },
      [{ id: 3, name: "my-db", image: "postgres:15-alpine" }]
    );
    expect(match).toEqual({ appId: 3, appName: "my-db" });
  });

  test("matches ignoring registry/namespace path", () => {
    const match = findInstalledTemplateApp(
      { image: "jellyfin/jellyfin:latest" },
      [{ id: 9, name: "media", image: "docker.io/jellyfin/jellyfin:10.9" }]
    );
    expect(match).toEqual({ appId: 9, appName: "media" });
  });

  test("returns null when no app runs a matching image", () => {
    const match = findInstalledTemplateApp(
      { image: "redis:7-alpine" },
      [{ id: 1, name: "web", image: "nginx:alpine" }]
    );
    expect(match).toBeNull();
  });

  test("returns null with an empty app list", () => {
    expect(findInstalledTemplateApp({ image: "postgres:16-alpine" }, [])).toBeNull();
  });

  test("returns the first match when multiple apps run the same image", () => {
    const match = findInstalledTemplateApp(
      { image: "redis:7-alpine" },
      [
        { id: 1, name: "cache-a", image: "redis:6" },
        { id: 2, name: "cache-b", image: "redis:7-alpine" }
      ]
    );
    expect(match?.appId).toBe(1);
  });
});

describe("requiredDatabaseStatus", () => {
  const joomla = APP_TEMPLATES.find((t) => t.id === "joomla")!;
  const wikijs = APP_TEMPLATES.find((t) => t.id === "wikijs")!;
  const redis = APP_TEMPLATES.find((t) => t.id === "redis")!;

  test("returns null when the template has no database requirement", () => {
    expect(requiredDatabaseStatus(redis, [])).toBeNull();
  });

  test("flags the requirement as unmet when no matching app exists", () => {
    const status = requiredDatabaseStatus(joomla, []);
    expect(status).not.toBeNull();
    expect(status!.template.id).toBe("mariadb");
    expect(status!.installed).toBe(false);
  });

  test("flags the requirement as met once a matching app exists", () => {
    const status = requiredDatabaseStatus(joomla, [
      { id: 5, name: "mariadb", image: "mariadb:11" }
    ]);
    expect(status!.installed).toBe(true);
  });

  test("resolves a different required template correctly (Postgres for Wiki.js)", () => {
    const status = requiredDatabaseStatus(wikijs, [
      { id: 5, name: "mariadb", image: "mariadb:11" }
    ]);
    // MariaDB alone doesn't satisfy Wiki.js's Postgres requirement.
    expect(status!.template.id).toBe("postgres");
    expect(status!.installed).toBe(false);
  });
});
