import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Static guard for the Phase-0 promise that preflight is READ-ONLY. It cannot
 * prove the absence of every bug, but it makes the obvious regressions — someone
 * adding a Docker mutation, an SQL write, a filesystem write or a process spawn to
 * a module that must only inspect — fail the build instead of reaching a server.
 */

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migration");

/** Modules that run during preflight and therefore must never mutate anything. */
const INSPECT_ONLY = [
  "probes.ts",
  "inventory.ts",
  "preflight.ts",
  "destination.ts",
  "dependencies.ts",
  "import-plan.ts",
  "consistency.ts",
  "report.ts",
  "ownership.ts",
  "facts.ts"
];

function source(file: string): string {
  return readFileSync(join(migrationDir, file), "utf8");
}

/** Removes comments so prose such as "never starts a container" cannot trip the scan. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

describe("inspect-only modules cannot mutate anything", () => {
  const dockerMutations =
    /\.(start|stop|kill|restart|pause|unpause|remove|prune|pull|run|commit|connect|disconnect|createContainer|createVolume|createNetwork|createImage|buildImage|loadImage|importImage|putArchive)\s*\(/;
  // Call form only: "rename" is also the name of an import resolution (a plain string), not a call.
  const fileWrites =
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|truncate|chmod|chown|symlink)\s*\(/;
  const sqlWrites = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|VACUUM|ATTACH|TRUNCATE|CREATE)\b/;
  const processSpawns = /child_process|\bexecFile\b|\bexecSync\b|\bspawn\b|\bfork\s*\(/;
  const network = /\bfetch\s*\(|node:http|node:https|node:net\b|node:dgram/;

  const rules: Array<[string, RegExp]> = [
    ["Docker mutation", dockerMutations],
    ["SQL write", sqlWrites],
    ["filesystem write", fileWrites],
    ["process spawn", processSpawns],
    ["network access", network]
  ];

  for (const file of INSPECT_ONLY) {
    for (const [name, pattern] of rules) {
      test(`${file} contains no ${name}`, () => {
        const match = stripComments(source(file)).match(pattern);

        assert.equal(match, null, `${file} contains a forbidden ${name}: ${match?.[0]}`);
      });
    }
  }

  test("exec() is only ever SQLite's read-only pragma, so nothing can exec inside a container", () => {
    for (const file of INSPECT_ONLY) {
      const calls = [...stripComments(source(file)).matchAll(/\.exec\(\s*([^)]*)\)/g)].map((match) => match[1]);

      if (file === "inventory.ts") {
        assert.deepEqual(calls, ['"PRAGMA query_only = ON"']);
      } else {
        assert.deepEqual(calls, [], `${file} calls exec()`);
      }
    }
  });

  test("filesystem imports are limited to the read-only statfs call", () => {
    for (const file of INSPECT_ONLY) {
      const imports = [
        ...stripComments(source(file)).matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)
      ].flatMap((match) =>
        (match[1] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      );

      assert.ok(
        imports.every((name) => name === "statfsSync"),
        `${file} imports fs: ${imports.join(", ")}`
      );
    }
  });

  test("every SQL string the inventory contains is a SELECT or a read-only pragma", () => {
    const text = stripComments(source("inventory.ts"));
    const literals = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? "").trim());
    const sql = literals.filter((literal) =>
      /^(SELECT|PRAGMA|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|REPLACE|VACUUM)\b/i.test(literal)
    );

    assert.ok(sql.length >= 12, `expected the inventory's queries to be found (found ${sql.length})`);
    for (const statement of sql) {
      assert.match(statement, /^(SELECT\b|PRAGMA (quick_check|query_only = ON)$)/, statement);
    }
  });
});

describe("the Docker client type exposes queries only", () => {
  test("ReadOnlyDockerClient lists exactly the allowed operations", () => {
    const text = source("probes.ts");
    const body = text.slice(text.indexOf("export interface ReadOnlyDockerClient {"));
    const block = body.slice(0, body.indexOf("\n}"));
    const methods = [...block.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]).sort();

    assert.deepEqual(methods, [
      "df",
      "getContainer",
      "getImage",
      "info",
      "listContainers",
      "listImages",
      "listVolumes",
      "version"
    ]);
  });

  test("the inner handles expose only inspect()", () => {
    const text = source("probes.ts");

    assert.deepEqual(
      [...text.matchAll(/getContainer\(id: string\): \{ (\w+)\(/g)].map((match) => match[1]),
      ["inspect"]
    );
    assert.deepEqual(
      [...text.matchAll(/getImage\(name: string\): \{ (\w+)\(/g)].map((match) => match[1]),
      ["inspect"]
    );
  });
});

describe("the guard itself can fail", () => {
  test("its patterns catch the mutations they exist to catch", () => {
    const catches = (pattern: RegExp, sample: string): boolean => pattern.test(sample);

    assert.ok(catches(/\.(start|stop|kill)\s*\(/, "container.stop()"));
    assert.ok(catches(/\b(INSERT|UPDATE)\b/, "INSERT INTO apps"));
    assert.ok(catches(/\b(writeFileSync|rm)\s*\(/, "writeFileSync(path, data)"));
    assert.ok(!catches(/\b(writeFileSync|rm)\s*\(/, 'resolutions: ["rename", "abort"]'));
  });
});
