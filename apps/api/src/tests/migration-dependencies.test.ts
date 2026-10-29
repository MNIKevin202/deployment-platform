import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeDependencies, findAppDependencies } from "../migration/dependencies.js";
import { makeApp, makeFacts, PLANTED_SECRET } from "./migration-fixtures.js";

const findingFor = (analysis: ReturnType<typeof analyzeDependencies>, id: string) =>
  analysis.findings.find((finding) => finding.id === id);

describe("dependency analysis: uses", () => {
  test("moving an app away from the database it addresses over Docker DNS is a blocker", () => {
    const analysis = analyzeDependencies(makeFacts(), 1, { operation: "move" });
    const finding = findingFor(analysis, "uses:app:2:DATABASE_URL");

    assert.ok(finding);
    assert.equal(finding.severity, "blocker");
    assert.equal(finding.handling, "must-move-together"); // db is internal-only
    assert.equal(finding.relatedApp, "app:2");
    assert.deepEqual(analysis.suggestedAdditions, ["app:2", "app:3"]);
    assert.ok(analysis.blockers >= 1);
  });

  test("copying has the same blocker: the destination cannot resolve this server's private names", () => {
    const analysis = analyzeDependencies(makeFacts(), 1, { operation: "copy" });

    assert.equal(findingFor(analysis, "uses:app:2:DATABASE_URL")?.severity, "blocker");
  });

  test("selecting the dependency to move together resolves the blocker", () => {
    const analysis = analyzeDependencies(makeFacts(), 1, { operation: "move", selection: [2, 3] });
    const finding = findingFor(analysis, "uses:app:2:DATABASE_URL");

    assert.equal(finding?.severity, "info");
    assert.equal(finding?.handling, "info");
    assert.equal(analysis.blockers, 0);
    assert.deepEqual(analysis.suggestedAdditions, []);
    assert.deepEqual(analysis.selection, [1, 2, 3]);
  });

  test("a public dependency is 'reconfigure', not 'must-move-together'", () => {
    const facts = makeFacts();
    facts.apps[1] = { ...facts.apps[1]!, internalOnly: false, domain: "db.example.test" };

    assert.equal(findingFor(analyzeDependencies(facts, 1, { operation: "move" }), "uses:app:2:DATABASE_URL")?.handling, "reconfigure");
  });

  test("an independent app has no dependency blockers", () => {
    const analysis = analyzeDependencies(makeFacts(), 4, { operation: "move" });

    assert.equal(analysis.blockers, 0);
    assert.deepEqual(analysis.suggestedAdditions, []);
  });

  test("references through the GLOBAL environment are found and labelled as such", () => {
    const facts = makeFacts();
    facts.globalEnv.push({ key: "SHARED_DB", value: "host=app-db port=5432", isSecret: false, enabled: true });
    const analysis = analyzeDependencies(facts, 4, { operation: "move" });
    const finding = findingFor(analysis, "uses:app:2:SHARED_DB");

    assert.ok(finding);
    assert.match(finding.evidence, /global environment variable SHARED_DB/);
  });

  test("disabled variables are ignored", () => {
    const facts = makeFacts();
    facts.apps[0]!.env[0]!.enabled = false;

    assert.equal(findingFor(analyzeDependencies(facts, 1, { operation: "move" }), "uses:app:2:DATABASE_URL"), undefined);
  });
});

describe("dependency analysis: hostname matching is precise", () => {
  const withValue = (value: string) => {
    const facts = makeFacts();
    facts.apps[3] = makeApp({ id: 4, name: "static", env: [{ key: "X", value, isSecret: false, enabled: true }] });
    return analyzeDependencies(facts, 4, { operation: "move" });
  };

  test("matches whole host names in URLs and connection strings", () => {
    for (const value of ["postgres://u:p@app-db:5432/x", "http://app-db/", "app-db", "host=app-db", "x@app-db"]) {
      assert.ok(findingFor(withValue(value), "uses:app:2:X"), value);
    }
  });

  test("does not match look-alikes", () => {
    for (const value of ["app-db2", "myapp-db", "app-db.example.com", "not-app-db-here", "app_db"]) {
      assert.equal(findingFor(withValue(value), "uses:app:2:X"), undefined, value);
    }
  });

  test("a match on the bare app name (not the container name) is only a warning", () => {
    const facts = makeFacts();
    facts.apps.push(makeApp({ id: 5, name: "cache", internalOnly: true }));
    facts.apps[3] = makeApp({
      id: 4,
      name: "static",
      env: [{ key: "X", value: "http://cache:6379", isSecret: false, enabled: true }]
    });
    const finding = findingFor(analyzeDependencies(facts, 4, { operation: "move" }), "uses:app:5:X");

    assert.equal(finding?.severity, "warning");
    assert.equal(finding?.handling, "acknowledge");
  });

  test("very short app names are not matched by bare name (too many false positives)", () => {
    // "db" is a 2-character name; the bare word is far too common to treat as a reference.
    assert.equal(findingFor(withValue("http://db:5432"), "uses:app:2:X"), undefined);
  });

  test("findAppDependencies distinguishes strong and weak references", () => {
    const facts = makeFacts();
    const result = findAppDependencies(facts, 1);

    assert.deepEqual(result.strong, [2]);
    assert.deepEqual(findAppDependencies(facts, 3).strong, [1]);
    assert.deepEqual(findAppDependencies(facts, 99), { strong: [], weak: [] });
  });
});

describe("dependency analysis: used by", () => {
  test("moving the web app breaks the worker that addresses it", () => {
    const analysis = analyzeDependencies(makeFacts(), 1, { operation: "move" });
    const finding = findingFor(analysis, "used-by:app:3:WEB_URL");

    assert.equal(finding?.severity, "blocker");
    assert.equal(finding?.handling, "reconfigure");
    assert.ok(analysis.suggestedAdditions.includes("app:3"));
  });

  test("copying does not break dependents — the original keeps running", () => {
    const analysis = analyzeDependencies(makeFacts(), 1, { operation: "copy" });
    const finding = findingFor(analysis, "used-by:app:3:WEB_URL");

    assert.equal(finding?.severity, "info");
    assert.equal(finding?.handling, "info");
  });

  test("a dependent that moves together is informational", () => {
    const analysis = analyzeDependencies(makeFacts(), 1, { operation: "move", selection: [2, 3] });

    assert.equal(findingFor(analysis, "used-by:app:3:WEB_URL")?.severity, "info");
  });
});

describe("dependency analysis: external effects and resources", () => {
  const analysis = analyzeDependencies(makeFacts(), 1, { operation: "copy" });

  test("flags an external database both servers could write to", () => {
    const finding = findingFor(analysis, "external-db:MONGODB_URI");

    assert.equal(finding?.severity, "warning");
    assert.match(finding!.evidence, /both write to that database|both servers/);
    assert.match(finding!.evidence, /Atlas cluster/);
  });

  test("lists the side effects a non-owner copy must keep off", () => {
    const kinds = analysis.sideEffects.map((effect) => effect.kind).sort();

    assert.deepEqual(kinds, ["auto-deploy", "cron", "external-database", "health-check", "public-domain", "published-port"]);
    assert.ok(analysis.sideEffects.every((effect) => effect.disabledOnNonOwner === true));

    const cron = analysis.sideEffects.find((effect) => effect.kind === "cron")!;
    assert.deepEqual(cron.names, ["nightly-sync"]); // the disabled job is not a live side effect
    assert.equal(cron.mayContactExternal, true); // heuristic: the command calls curl/https
  });

  test("records credentials, ports, domain, limits and version history", () => {
    assert.ok(findingFor(analysis, "credential:github"));
    assert.ok(findingFor(analysis, "port:25565/udp"));
    assert.equal(findingFor(analysis, "domain")?.severity, "warning"); // copy needs another domain
    assert.ok(findingFor(analysis, "resource-limits"));
    assert.match(findingFor(analysis, "version-history")!.evidence, /2 retained build/);
    assert.match(findingFor(analysis, "credential:github")!.remedy!, /never transferred/);

    const move = analyzeDependencies(makeFacts(), 1, { operation: "move" });
    assert.equal(findingFor(move, "domain")?.severity, "info");
  });

  test("lists inherited global variables by name only", () => {
    assert.match(findingFor(analysis, "inherits:global-env")!.evidence, /TZ/);
  });

  test("an unknown app is an error", () => {
    assert.throws(() => analyzeDependencies(makeFacts(), 99, { operation: "copy" }), /not found/);
  });
});

describe("dependency analysis: secrets never leak", () => {
  test("no finding, evidence, remedy or side effect contains an environment value or a cron command", () => {
    for (const operation of ["copy", "move"] as const) {
      for (const appId of [1, 2, 3, 4]) {
        const serialized = JSON.stringify(analyzeDependencies(makeFacts(), appId, { operation }));

        assert.ok(!serialized.includes(PLANTED_SECRET), `leak for app ${appId} (${operation})`);
        assert.ok(!serialized.includes("Authorization"), "cron command text leaked");
        assert.ok(!serialized.includes("api.example.test"), "cron command text leaked");
        assert.ok(!serialized.includes("cluster.example.test"), "connection string leaked");
      }
    }
  });
});
