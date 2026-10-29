import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Phase 1 may only EXPORT. These static checks keep it that way: the export modules
 * contain no import, restore, replace, hand-over or cutover capability, and the only
 * door to Docker is one small file whose verbs are enumerated here.
 */

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migration");
const read = (file: string): string => readFileSync(join(dir, file), "utf8");

function strip(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

/** Every module that exists to export. */
const EXPORT_MODULES = [
  "export.ts",
  "export-docker.ts",
  "export-journal.ts",
  "export-plan.ts",
  "export-cli.ts",
  "quiesce.ts",
  "hooks.ts",
  "app-definition.ts",
  "streams.ts"
];

describe("export code has no import, restore, replace or cutover capability", () => {
  const forbiddenDocker =
    /\.(createVolume|createNetwork|loadImage|importImage|putArchive|buildImage|pull|connect|disconnect|commit|rename|update\s*\(\s*\{|createService|swarm)\b|\bgetVolume\([^)]*\)\.(remove|create)|getNetwork\(/;
  const forbiddenIdentifiers =
    /\b(importBundle|importArtifact|restoreVolume|restoreDatabase|applyImport|executeCutover|activateStandby|createStandby|createDormantCopy|promoteDormantCopy|unfence|retire|replaceExisting)\b/;
  const sqlWrites = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|TRUNCATE)\b/;
  const forbiddenFs = /\b(writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|cp|cpSync|chmod|chown|symlink|truncate|unlink|unlinkSync)\s*\(/;
  const network = /node:http|node:https|node:net\b|node:dgram|\bfetch\s*\(/;
  const processSpawn = /child_process|\bexecFile\b|\bspawn\b|\bexecSync\b/;

  for (const file of EXPORT_MODULES) {
    const text = strip(read(file));

    test(`${file}: no volume/network creation, image loading or writes into containers`, () => {
      assert.equal(text.match(forbiddenDocker), null, `${file}: ${text.match(forbiddenDocker)?.[0]}`);
    });
    test(`${file}: no import / restore / ownership-transfer vocabulary`, () => {
      assert.equal(text.match(forbiddenIdentifiers), null, `${file}: ${text.match(forbiddenIdentifiers)?.[0]}`);
    });
    test(`${file}: no SQL writes`, () => {
      assert.equal(text.match(sqlWrites), null, `${file}: ${text.match(sqlWrites)?.[0]}`);
    });
    test(`${file}: no arbitrary file writes, network access or process spawning`, () => {
      // The journal is the ONE module that writes a file of its own: a single durable write helper.
      const checked = file === "export-journal.ts" ? text.replace("handle.writeFile(", "handle.WRITE_ALLOWED(") : text;
      assert.equal(checked.match(forbiddenFs), null, `${file}: ${checked.match(forbiddenFs)?.[0]}`);
      if (file === "export-journal.ts") {
        assert.equal([...text.matchAll(/\bwriteFile\(/g)].length, 1, "exactly one write call, inside writeDurably");
        assert.match(text, /async function writeDurably[\s\S]*?handle\.writeFile[\s\S]*?rename\(temp, path\)/);
      }
      assert.equal(text.match(network), null);
      assert.equal(text.match(processSpawn), null);
    });
    test(`${file}: does not import the import-plan or ownership machinery`, () => {
      assert.ok(!/from "\.\/(ownership|import-plan)\.js"/.test(text), `${file} imports import/ownership code`);
    });
  }

  test("every SQLite handle export opens is READ-ONLY", () => {
    for (const file of EXPORT_MODULES) {
      for (const match of strip(read(file)).matchAll(/new DatabaseSync\(([^)]*)\)/g)) {
        assert.match(match[1]!, /readOnly:\s*true/, `${file} opens a writable database: new DatabaseSync(${match[1]})`);
      }
    }
    // The snapshot's only "write" is VACUUM INTO, which writes a NEW file, never the live database.
    const exportTs = strip(read("export.ts"));
    assert.equal([...exportTs.matchAll(/\.exec\(`VACUUM INTO/g)].length, 1, "exactly one VACUUM INTO statement");
    assert.match(exportTs, /openReadOnly\(this\.input\.dbPath, \{ queryOnly: false \}\)/);
  });

  test("the only deletions are of things this export created: its own bundle directory and its temporary snapshot", () => {
    const text = strip(read("export.ts"));
    const removals = [...text.matchAll(/\brm\(([^)]*)\)/g)].map((m) => m[1]!.split(",")[0]!.trim());

    assert.deepEqual(removals.sort(), ["this.bundlePath", "workDir"]);
    // ...and the bundle deletion is fenced to the output directory.
    assert.match(text, /if \(!this\.bundlePath\.startsWith\(root\)\)/);
  });

  test("the recovery journal only ever removes its own journal file and a provably unfinished bundle", () => {
    const text = strip(read("export-journal.ts"));

    assert.match(text, /existsSync\(join\(bundlePath, HEADER_FILE\)\)/);
    assert.match(text, /existsSync\(join\(bundlePath, MANIFEST_FILE\)\)/, "a bundle with a manifest is complete and must not be deleted");
  });
});

describe("Docker is reached through exactly one file, with enumerated verbs", () => {
  test("only export-docker.ts imports dockerode", () => {
    for (const file of EXPORT_MODULES.filter((name) => name !== "export-docker.ts")) {
      assert.ok(!/from "dockerode"/.test(strip(read(file))), `${file} imports dockerode directly`);
    }
    assert.ok(/from "dockerode"/.test(read("export-docker.ts")));
  });

  test("export-docker.ts calls only the dockerode operations export needs", () => {
    const source = strip(read("export-docker.ts"));
    const used = new Set([...source.matchAll(/\.(\w+)\(/g)].map((match) => match[1]!));

    // Every dockerode operation that could create, change or import state, other than the ones export is allowed.
    const denied = [
      "restart", "update", "rename", "resize", "attach", "commit", "export", "putArchive", "createImage",
      "createVolume", "createNetwork", "buildImage", "pull", "push", "tag", "loadImage", "importImage",
      "pruneContainers", "pruneImages", "pruneVolumes", "pruneNetworks", "connect", "disconnect"
    ];
    for (const verb of denied) {
      assert.ok(!used.has(verb), `export-docker.ts calls dockerode's ${verb}()`);
    }

    // ...and the operations it exists to perform are really in use (so this check cannot pass vacuously).
    for (const verb of ["stop", "start", "pause", "unpause", "getArchive", "createContainer", "exec", "remove", "kill", "wait", "logs", "inspect", "listContainers", "getVolume", "getImage"]) {
      assert.ok(used.has(verb), `export-docker.ts no longer uses ${verb}(): the guard's assumptions are stale`);
    }
  });

  test("containers it creates are helpers: never started for volume reads, always network-less, read-only and labelled", () => {
    const text = strip(read("export-docker.ts"));

    assert.equal([...text.matchAll(/createContainer\(/g)].length, 2, "exactly two helper shapes");
    assert.equal([...text.matchAll(/NetworkMode: "none"/g)].length, 2);
    assert.equal([...text.matchAll(/ReadonlyRootfs: true/g)].length, 2);
    assert.equal([...text.matchAll(/Labels: helperLabels\(\)/g)].length, 2);
    assert.match(text, /Binds: \[`\$\{volumeName\}:\/src:ro`\]/, "the volume is mounted read-only");
    assert.match(text, /remove\(\{ force: true, v: false \}\)/, "removal never removes volumes");
  });
});

describe("Phase 0's read-only modules stay read-only", () => {
  const INSPECT_ONLY = ["probes.ts", "inventory.ts", "preflight.ts", "destination.ts", "dependencies.ts", "import-plan.ts", "consistency.ts", "report.ts", "ownership.ts", "facts.ts"];

  test("none of them imports any export module", () => {
    for (const file of INSPECT_ONLY) {
      const text = strip(read(file));
      assert.ok(!/from "\.\/(export|export-docker|export-journal|quiesce|hooks|app-definition)\.js"/.test(text), `${file} must not depend on export code`);
    }
  });
});
