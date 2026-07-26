import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateBuildBrief, type BuildBriefInput } from "../services/build-brief-service.js";

function baseInput(overrides: Partial<BuildBriefInput> = {}): BuildBriefInput {
  return {
    appName: "my-app",
    domain: "my-app.apps.hookstats.com",
    containerPort: 3000,
    runtime: "nodejs",
    environmentVariables: [],
    storageMounts: [],
    ...overrides
  };
}

describe("generateBuildBrief", () => {
  test("states the app has not been deployed yet", () => {
    const brief = generateBuildBrief(baseInput());
    assert.match(brief, /has NOT been deployed yet/);
  });

  test("includes environment variable keys and marks secrets without ever including a value", () => {
    const brief = generateBuildBrief(
      baseInput({
        environmentVariables: [
          { key: "API_URL", isSecret: false },
          { key: "DB_PASSWORD", isSecret: true }
        ]
      })
    );

    assert.match(brief, /API_URL/);
    assert.match(brief, /DB_PASSWORD/);
    assert.match(brief, /DB_PASSWORD — secret/);
    // Nothing resembling a secret VALUE could appear — the input type only
    // ever carries a key and a boolean, so there is no string to leak.
    assert.doesNotMatch(brief, /hunter2/);
  });

  test("includes persistent storage paths", () => {
    const brief = generateBuildBrief(
      baseInput({
        storageMounts: [
          { containerPath: "/data", readOnly: false },
          { containerPath: "/config", readOnly: true }
        ]
      })
    );

    assert.match(brief, /\/data \(read-write\)/);
    assert.match(brief, /\/config \(read-only\)/);
  });

  test("requires binding to 0.0.0.0 on the selected container port", () => {
    const brief = generateBuildBrief(baseInput({ containerPort: 4321 }));
    assert.match(brief, /0\.0\.0\.0/);
    assert.match(brief, /4321/);
  });

  test("reflects the selected runtime/framework", () => {
    const nodeBrief = generateBuildBrief(baseInput({ runtime: "nodejs" }));
    assert.match(nodeBrief, /Node\.js/);

    const pythonBrief = generateBuildBrief(baseInput({ runtime: "python" }));
    assert.match(pythonBrief, /Python/);

    const staticBrief = generateBuildBrief(baseInput({ runtime: "static" }));
    assert.match(staticBrief, /Static site/);
  });

  test("distinguishes platform-provided configuration from what Claude must prepare and what needs confirmation", () => {
    const brief = generateBuildBrief(baseInput());

    assert.match(
      brief,
      /Configuration the platform already provides — do not implement these yourself/
    );
    assert.match(brief, /## What you need to prepare/);
    assert.match(brief, /## Please confirm with the user before proceeding/);
  });

  test("explicitly tells Claude not to manage TLS and that routing is automatic", () => {
    const brief = generateBuildBrief(baseInput());
    assert.match(brief, /must NOT attempt to manage TLS/);
    assert.match(brief, /Domain routing to this app is automatic/);
  });

  test("warns against host bind mounts, Docker socket access, and hard-coded secrets", () => {
    const brief = generateBuildBrief(baseInput());
    assert.match(brief, /no host bind mounts and no Docker socket access/);
    assert.match(brief, /Do not hard-code any production secret values/);
  });

  test("includes an explicit note when no environment variables or storage are configured", () => {
    const brief = generateBuildBrief(baseInput());
    assert.match(brief, /No environment variables are configured yet/);
    assert.match(brief, /No persistent storage is configured/);
  });

  test("includes the app name and planned public URL", () => {
    const brief = generateBuildBrief(
      baseInput({ appName: "widgets", domain: "widgets.apps.hookstats.com" })
    );
    assert.match(brief, /App name: widgets/);
    assert.match(brief, /https:\/\/widgets\.apps\.hookstats\.com/);
  });

  test("includes an optional description when provided", () => {
    const brief = generateBuildBrief(
      baseInput({ description: "Internal reporting dashboard." })
    );
    assert.match(brief, /Notes from the person deploying this app/);
    assert.match(brief, /Internal reporting dashboard\./);
  });

  test("mentions the startCommand and healthCheckPath when provided", () => {
    const brief = generateBuildBrief(
      baseInput({ startCommand: "node server.js", healthCheckPath: "/healthz" })
    );
    assert.match(brief, /node server\.js/);
    assert.match(brief, /\/healthz/);
  });
});
