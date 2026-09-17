import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { listMigrations } from "../migrations/index.js";

// Locate the migration SOURCE dir (apps/api/src/migrations) regardless of
// whether tests run from src/ or dist/ — walk up to the apps/api root.
function findMigrationsSourceDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(d, "src", "migrations");
    if (existsSync(join(d, "package.json")) && existsSync(candidate)) return candidate;
    d = dirname(d);
  }
  throw new Error("could not locate apps/api/src/migrations from the test file");
}

// Mirrors, EXACTLY, the parser release-remote.sh uses during the post-swap
// migration verification (and the updater's pre-cutover verify-migrations.mjs):
// files matching /^[0-9]+.*\.ts$/, each with an `export const ...: Migration = {`
// header, reading `version` from the header slice before `up(`.
const HEADER_RE = /export\s+const\s+\w+\s*:\s*Migration\s*=\s*\{/;
function parseSourceVersions(dir: string): number[] {
  const files = readdirSync(dir)
    .filter((f) => /^[0-9]+.*\.ts$/.test(f))
    .sort();
  const versions: number[] = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const header = HEADER_RE.exec(text);
    assert.ok(header, `migration source ${file} has no exported ": Migration = {" object (release-remote could not parse it)`);
    const bodyStart = header.index + header[0].length;
    const upIndex = text.indexOf("up(", bodyStart);
    const slice = upIndex === -1 ? text.slice(bodyStart) : text.slice(bodyStart, upIndex);
    const versionMatch = /version\s*:\s*(\d+)/.exec(slice);
    assert.ok(versionMatch, `migration source ${file} has no parseable version`);
    versions.push(Number(versionMatch[1]));
  }
  return versions;
}

// The image ships apps/api/src/migrations (Dockerfile COPY) so the updater's
// pre-cutover check and release-remote.sh's post-swap check can parse it. If
// the source ever becomes unparseable, or drifts from the compiled list, a
// release would extract a payload that verification later rejects — the class
// of failure that broke the first production cutover (an empty/mismatched
// migration dir). This is the CI-run guard against shipping that.
describe("migration source is shippable and matches the compiled list", () => {
  const sourceVersions = parseSourceVersions(findMigrationsSourceDir()).sort((a, b) => a - b);
  const compiledVersions = listMigrations().map((m) => m.version).sort((a, b) => a - b);

  test("every migration source file is parseable by release-remote's parser", () => {
    assert.ok(sourceVersions.length > 0, "no parseable migration source files found");
  });

  test("the parsed source version set equals the compiled migration set", () => {
    assert.deepEqual(sourceVersions, compiledVersions);
  });

  test("source versions are unique and contiguous from 1", () => {
    const expected = Array.from({ length: compiledVersions.length }, (_, i) => i + 1);
    assert.deepEqual(sourceVersions, expected);
  });
});
