import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createAppDatabase } from "../database.js";
import { appsDomainRoot, buildAppDomain, resolveAppsDomainRoot } from "../domain.js";

describe("buildAppDomain", () => {
  test("appends the apps domain root to the app name", () => {
    assert.equal(
      buildAppDomain("sqlite-test"),
      `sqlite-test.${appsDomainRoot}`
    );
  });
});

describe("resolveAppsDomainRoot", () => {
  test("uses APPS_DOMAIN, the value the installer actually writes", () => {
    assert.equal(
      resolveAppsDomainRoot({ APPS_DOMAIN: "apps.devminted.com" }),
      "apps.devminted.com"
    );
  });

  test("APPS_DOMAIN takes precedence over the legacy APPS_DOMAIN_ROOT alias", () => {
    assert.equal(
      resolveAppsDomainRoot({
        APPS_DOMAIN: "apps.devminted.com",
        APPS_DOMAIN_ROOT: "apps.legacy.example"
      }),
      "apps.devminted.com"
    );
  });

  test("falls back to the legacy APPS_DOMAIN_ROOT alias when APPS_DOMAIN is unset", () => {
    assert.equal(
      resolveAppsDomainRoot({ APPS_DOMAIN_ROOT: "apps.legacy.example" }),
      "apps.legacy.example"
    );
  });

  test("uses a non-production fallback (never a real domain) when neither is set", () => {
    assert.equal(resolveAppsDomainRoot({}), "apps.localhost");
  });
});

describe("domain persistence", () => {
  test("createApp stores the generated domain and rejects duplicates", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "deployment-platform-test-"));
    const dbPath = join(tempDir, `${randomUUID()}.sqlite`);
    const appDatabase = createAppDatabase(dbPath);

    const domain = buildAppDomain("sqlite-test");

    const created = appDatabase.createApp({
      name: "sqlite-test",
      image: "nginx:alpine",
      containerPort: 80,
      containerName: "app-sqlite-test",
      domain
    });

    assert.equal(created.domain, domain);

    const fetchedByDomain = appDatabase.getAppByDomain(domain);
    assert.equal(fetchedByDomain?.id, created.id);

    assert.throws(() => {
      appDatabase.createApp({
        name: "sqlite-test-2",
        image: "nginx:alpine",
        containerPort: 80,
        containerName: "app-sqlite-test-2",
        domain
      });
    });

    appDatabase.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
});
