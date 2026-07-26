import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createAppDatabase } from "../database.js";
import { appsDomainRoot, buildAppDomain } from "../domain.js";

describe("buildAppDomain", () => {
  test("appends the apps domain root to the app name", () => {
    assert.equal(
      buildAppDomain("sqlite-test"),
      `sqlite-test.${appsDomainRoot}`
    );
  });

  test("defaults to apps.hookstats.com when APPS_DOMAIN_ROOT is unset", () => {
    assert.equal(appsDomainRoot, "apps.hookstats.com");
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
