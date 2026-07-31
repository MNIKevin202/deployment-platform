import { describe, expect, test } from "vitest";
import { findInstalledTemplateApp } from "../lib/templateInstallStatus";

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
