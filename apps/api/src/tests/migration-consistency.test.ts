import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ceilingWithoutEvidence,
  classifyConsistency,
  classifyDataProfile,
  evaluateConsistencyPolicy,
  meetsLevel,
  weakestLevel,
  EVIDENCE_KINDS,
  SNAPSHOT_STRATEGIES,
  type ConsistencyEvidence,
  type EvidenceKind
} from "../migration/consistency.js";

const ev = (...kinds: EvidenceKind[]): ConsistencyEvidence[] => kinds.map((kind) => ({ kind }));

describe("consistency classification: stopping a container is NOT proof", () => {
  test("a clean stop with no application evidence is only 'quiesced-unverified'", () => {
    assert.equal(
      classifyConsistency({ strategy: "stop", hasPersistentState: true, evidence: ev("clean-exit") }),
      "quiesced-unverified"
    );
  });

  test("a stop never reaches application-consistent without application-level evidence", () => {
    for (const evidence of [ev(), ev("clean-exit"), ev("forced-kill"), ev("frozen"), ev("clean-exit", "frozen")]) {
      const level = classifyConsistency({ strategy: "stop", hasPersistentState: true, evidence });
      assert.notEqual(level, "application-consistent", JSON.stringify(evidence));
    }
  });

  test("no strategy alone ever yields application-consistent", () => {
    for (const strategy of SNAPSHOT_STRATEGIES) {
      for (const process of [ev(), ev("clean-exit"), ev("forced-kill"), ev("frozen")]) {
        assert.notEqual(
          classifyConsistency({ strategy, hasPersistentState: true, evidence: process }),
          "application-consistent",
          `${strategy} ${JSON.stringify(process)}`
        );
      }
    }
  });

  test("application-level evidence is what earns application-consistent", () => {
    for (const kind of ["logical-dump-verified", "integrity-check-passed", "app-snapshot-verified"] as const) {
      for (const strategy of ["stop", "hook", "live", "freeze"] as const) {
        assert.equal(
          classifyConsistency({ strategy, hasPersistentState: true, evidence: ev(kind) }),
          "application-consistent",
          `${kind} via ${strategy}`
        );
      }
    }
  });

  test("a clean-shutdown marker only counts when the app was actually stopped", () => {
    assert.equal(
      classifyConsistency({ strategy: "stop", hasPersistentState: true, evidence: ev("clean-exit", "clean-shutdown-marker-verified") }),
      "application-consistent"
    );
    assert.notEqual(
      classifyConsistency({ strategy: "live", hasPersistentState: true, evidence: ev("clean-shutdown-marker-verified") }),
      "application-consistent"
    );
    assert.notEqual(
      classifyConsistency({ strategy: "freeze", hasPersistentState: true, evidence: ev("clean-shutdown-marker-verified") }),
      "application-consistent"
    );
  });

  test("forced kills, unknown exits, freezes and live copies get the honest weaker levels", () => {
    const classify = (strategy: Parameters<typeof classifyConsistency>[0]["strategy"], evidence: ConsistencyEvidence[]) =>
      classifyConsistency({ strategy, hasPersistentState: true, evidence });

    assert.equal(classify("stop", ev("forced-kill")), "crash-consistent");
    assert.equal(classify("stop", ev("clean-exit", "forced-kill")), "crash-consistent");
    assert.equal(classify("stop", ev()), "crash-consistent"); // exit status unknown
    assert.equal(classify("freeze", ev("frozen")), "crash-consistent");
    assert.equal(classify("live", ev()), "inconsistent");
    assert.equal(classify("none", ev()), "inconsistent");
    assert.equal(classify("hook", ev()), "inconsistent"); // a hook that proved nothing proves nothing
  });

  test("no persistent state is not-applicable regardless of evidence", () => {
    assert.equal(
      classifyConsistency({ strategy: "live", hasPersistentState: false, evidence: ev("logical-dump-verified") }),
      "not-applicable"
    );
  });

  test("the ceiling without evidence never exceeds quiesced-unverified", () => {
    for (const strategy of SNAPSHOT_STRATEGIES) {
      assert.notEqual(ceilingWithoutEvidence(strategy), "application-consistent");
    }
    assert.equal(ceilingWithoutEvidence("stop"), "quiesced-unverified");
  });

  test("every evidence kind is accounted for", () => {
    assert.equal(EVIDENCE_KINDS.length, 7);
  });
});

describe("level ordering", () => {
  test("meetsLevel and weakestLevel agree on ordering", () => {
    assert.ok(meetsLevel("application-consistent", "quiesced-unverified"));
    assert.ok(meetsLevel("quiesced-unverified", "crash-consistent"));
    assert.ok(!meetsLevel("crash-consistent", "quiesced-unverified"));
    assert.ok(!meetsLevel("quiesced-unverified", "application-consistent"));

    assert.equal(weakestLevel(["application-consistent", "crash-consistent", "quiesced-unverified"]), "crash-consistent");
    assert.equal(weakestLevel(["not-applicable", "application-consistent"]), "application-consistent");
    assert.equal(weakestLevel([]), "not-applicable");
    assert.equal(weakestLevel(["not-applicable"]), "not-applicable");
  });
});

describe("data profile detection (metadata only)", () => {
  const profile = (image: string, mountPaths: string[] = [], envKeys: string[] = [], hasVolumes = true) =>
    classifyDataProfile({ image, mountPaths, envKeys, hasVolumes });

  test("recognises common engines from the image name, including registries and tags", () => {
    assert.equal(profile("postgres:16").kind, "postgres");
    assert.equal(profile("docker.io/library/postgres@sha256:abc").kind, "postgres");
    assert.equal(profile("registry.example.test/team/timescaledb:latest-pg16").kind, "postgres");
    assert.equal(profile("mariadb:11").kind, "mariadb");
    assert.equal(profile("mysql:8").kind, "mysql");
    assert.equal(profile("mongo:7").kind, "mongodb");
    assert.equal(profile("redis:7-alpine").kind, "redis");
    assert.equal(profile("valkey/valkey:8").kind, "redis");
    assert.equal(profile("postgres:16").isDatabase, true);
  });

  test("falls back to mount paths, then environment variable NAMES", () => {
    assert.equal(profile("custom/app:1", ["/var/lib/postgresql/data"]).kind, "postgres");
    assert.equal(profile("custom/app:1", ["/var/lib/mysql"]).kind, "mysql");
    assert.equal(profile("custom/app:1", ["/data/db"]).kind, "mongodb");
    assert.equal(profile("custom/app:1", ["/srv"], ["POSTGRES_PASSWORD"]).kind, "postgres");
    assert.equal(profile("custom/app:1", ["/srv"], ["MONGO_INITDB_ROOT_USERNAME"]).kind, "mongodb");
    assert.match(profile("custom/app:1", ["/var/lib/mysql"]).reasons.join(" "), /\/var\/lib\/mysql/);
  });

  test("an unrecognised app with volumes is 'unknown-stateful', never assumed safe", () => {
    const unknown = profile("someone/cms:3", ["/uploads"]);
    assert.equal(unknown.kind, "unknown-stateful");
    assert.equal(unknown.isDatabase, false);
    assert.equal(unknown.hasPersistentState, true);
  });

  test("an app with no volumes is stateless", () => {
    const stateless = profile("nginx:alpine", [], [], false);
    assert.equal(stateless.kind, "stateless");
    assert.equal(stateless.hasPersistentState, false);
  });

  test("a recognised database always carries concrete guidance", () => {
    assert.match(profile("postgres:16").recommendation, /pg_dump|pg_controldata/);
    assert.match(profile("redis:7").recommendation, /redis-check-rdb/);
  });
});

describe("consistency policy", () => {
  const pg = classifyDataProfile({ image: "postgres:16", mountPaths: [], envKeys: [], hasVolumes: true });
  const unknown = classifyDataProfile({ image: "x/y", mountPaths: ["/d"], envKeys: [], hasVolumes: true });
  const stateless = classifyDataProfile({ image: "nginx", mountPaths: [], envKeys: [], hasVolumes: false });

  test("rehearsals allow anything but never hide a weak level", () => {
    const verdict = evaluateConsistencyPolicy({ profile: pg, level: "quiesced-unverified", mode: "rehearsal", accepted: false });

    assert.equal(verdict.allowed, true);
    assert.equal(verdict.severity, "warn");
    assert.match(verdict.message, /must not be used for cutover/);
  });

  test("cutover blocks a stopped-but-unverified database", () => {
    const verdict = evaluateConsistencyPolicy({ profile: pg, level: "quiesced-unverified", mode: "cutover", accepted: false });

    assert.equal(verdict.allowed, false);
    assert.equal(verdict.severity, "fail");
    assert.equal(verdict.requiresAcceptance, true);
  });

  test("cutover proceeds only on explicit acceptance, and still says so", () => {
    const verdict = evaluateConsistencyPolicy({ profile: pg, level: "quiesced-unverified", mode: "cutover", accepted: true });

    assert.equal(verdict.allowed, true);
    assert.equal(verdict.severity, "warn");
    assert.match(verdict.message, /explicitly accepted/);
  });

  test("a live, unquiesced copy can never be accepted at cutover", () => {
    for (const profile of [pg, unknown]) {
      const verdict = evaluateConsistencyPolicy({ profile, level: "inconsistent", mode: "cutover", accepted: true });
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.requiresAcceptance, false);
    }
  });

  test("unknown stateful apps are held to the same standard as databases", () => {
    const verdict = evaluateConsistencyPolicy({ profile: unknown, level: "crash-consistent", mode: "cutover", accepted: false });

    assert.equal(verdict.allowed, false);
    assert.equal(verdict.requiresAcceptance, true);
  });

  test("application-consistent passes, and stateless apps are always fine", () => {
    assert.equal(
      evaluateConsistencyPolicy({ profile: pg, level: "application-consistent", mode: "cutover", accepted: false }).severity,
      "pass"
    );
    assert.equal(
      evaluateConsistencyPolicy({ profile: stateless, level: "not-applicable", mode: "cutover", accepted: false }).allowed,
      true
    );
  });
});
