// verify-migrations.mjs — PRE-CUTOVER migration-payload verification for the
// registry self-updater. Run INSIDE the target release image (which ships both
// the migration SOURCE at apps/api/src/migrations and the COMPILED list at
// apps/api/dist/migrations/index.js), it proves — before any live container is
// touched — that the migration set the release ships is real, parseable by the
// exact same parser release-remote.sh uses during the swap, internally
// consistent (source matches compiled), and compatible with this database's
// applied max. Any failure exits non-zero so the updater aborts BEFORE the
// container swap, instead of discovering a packaging problem post-cutover and
// relying on rollback.
//
// It is deliberately dependency-free and also runnable OUTSIDE a container
// (for tests) via env overrides, so the verification logic has a single source
// of truth exercised against the real migration source.
//
// Env:
//   DP_MIGRATIONS_DIR   source dir to parse   (default /app/apps/api/src/migrations)
//   DP_COMPILED_INDEX   compiled migrations index (default /app/apps/api/dist/migrations/index.js)
//   DP_APPLIED          this DB's applied max migration version (default 0)
//   DP_EXPECT_COUNT     optional: assert exactly this many migrations (host-extraction cross-check)
// On success: prints one line of JSON { count, max, toRun } and exits 0.
// Exit codes: 2 usage/read, 3 unparseable source, 4 source/compiled mismatch,
//             5 DB ahead of target (downgrade), 6 expected-count mismatch.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function die(code, msg) {
  process.stderr.write(`verify-migrations: ${msg}\n`);
  process.exit(code);
}

const migrationsDir = process.env.DP_MIGRATIONS_DIR || "/app/apps/api/src/migrations";
const compiledIndex = process.env.DP_COMPILED_INDEX || "/app/apps/api/dist/migrations/index.js";
const applied = Number(process.env.DP_APPLIED || "0");
const expectCount = process.env.DP_EXPECT_COUNT ? Number(process.env.DP_EXPECT_COUNT) : null;

if (!existsSync(migrationsDir)) die(2, `migrations source dir does not exist: ${migrationsDir}`);

// --- Parse the migration SOURCE with the SAME rules release-remote.sh uses ---
// (files matching /^[0-9]+.*\.ts$/, each with an `export const ...: Migration = {`
// header, reading version/name only from within that object's header slice).
let files;
try {
  files = readdirSync(migrationsDir).filter((f) => /^[0-9]+.*\.ts$/.test(f)).sort();
} catch (e) {
  die(2, `cannot read migrations dir ${migrationsDir}: ${e instanceof Error ? e.message : String(e)}`);
}
if (files.length === 0) {
  die(3, `no migration source files (^[0-9]+.*\\.ts$) found in ${migrationsDir} — an empty/failed extraction is NOT "no migrations"`);
}

const HEADER_RE = /export\s+const\s+\w+\s*:\s*Migration\s*=\s*\{/;
const sourceVersions = [];
for (const file of files) {
  const text = readFileSync(join(migrationsDir, file), "utf8");
  const header = HEADER_RE.exec(text);
  if (!header) die(3, `no exported ": Migration = {" object found in ${file}`);
  const bodyStart = header.index + header[0].length;
  const upIndex = text.indexOf("up(", bodyStart);
  const slice = upIndex === -1 ? text.slice(bodyStart) : text.slice(bodyStart, upIndex);
  const versionMatch = /version\s*:\s*(\d+)/.exec(slice);
  if (!versionMatch) die(3, `could not parse a numeric version from ${file}`);
  sourceVersions.push(Number(versionMatch[1]));
}
const sourceSorted = [...sourceVersions].sort((a, b) => a - b);

// --- Cross-check against the COMPILED migration list the running image uses ---
let listMigrations;
try {
  ({ listMigrations } = await import(pathToFileURL(resolve(compiledIndex)).href));
} catch (e) {
  die(2, `cannot import compiled migrations index ${compiledIndex}: ${e instanceof Error ? e.message : String(e)}`);
}
const compiled = listMigrations().map((m) => m.version).sort((a, b) => a - b);

const sameSet =
  compiled.length === sourceSorted.length && compiled.every((v, i) => v === sourceSorted[i]);
if (!sameSet) {
  die(4, `migration source does not match the compiled list — source=${JSON.stringify(sourceSorted)} compiled=${JSON.stringify(compiled)}`);
}

if (expectCount !== null && expectCount !== compiled.length) {
  die(6, `host-extracted migration count (${expectCount}) != target image migration count (${compiled.length}) — incomplete extraction`);
}

const max = compiled[compiled.length - 1];
if (Number.isFinite(applied) && applied > max) {
  die(5, `this database's applied max (${applied}) is HIGHER than the target release's max migration (${max}) — refusing a downgrade`);
}

const toRun = compiled.filter((v) => v > applied);
process.stdout.write(JSON.stringify({ count: compiled.length, max, toRun: toRun.length }));
