# Self-Update Architecture

This document covers ClovaForge updating **itself** — the platform, not the
customer apps it hosts (see "Hosted apps are different" below). It exists
because the current release process (`release.sh` + `scripts/release-remote.sh`,
documented in [RELEASE_AUTOMATION.md](RELEASE_AUTOMATION.md)) assumes one
person, on one machine, SSHing into one server. That does not scale past a
handful of installations, and it stops working entirely once ClovaForge is
something other people install on their own servers.

**Status of this document**: describes the target architecture and what of
it is actually implemented today. Sections are marked accordingly.
The full self-update system (Phases 1–5) is **implemented and tested** in
this repository. What remains is operational and needs the operator:
provision the release-signing key (§5), publish the first real release
(§14), and run the production bootstrap (§13) on a machine with VPS access.
[RELEASE_AUTOMATION.md](RELEASE_AUTOMATION.md) remains the accurate
description of how *this project's own* production server is released until
that bootstrap runs; it is marked legacy-once-migrated there.

## 1. What exists today (as of this document)

A factual inventory, gathered by reading the actual code rather than
assumed:

- **No Docker Compose anywhere.** Every container is created with plain
  `docker create`/`docker run`/`docker network connect`, both by the
  installer (`installer/lib/*.sh`) and by the release script
  (`scripts/release-remote.sh`).
- **Images are built locally, never pushed to a registry.** Both the
  installer (`installer/lib/images.sh`) and the release script build
  `deployment-platform-api`/`deployment-platform-web` with a plain
  `docker build` directly on the target host. `docker push` does not occur
  anywhere for these two images. GHCR is used only for the unrelated
  `quipora-bot` (irc-bot) image, via `.github/workflows/irc-bot-image.yml`.
- **Versioning was five unrelated things.** `package.json` (`0.1.0`, static,
  unused by anything), a hardcoded API string (`"0.4.0"`, now fixed — see
  §3), a per-box counter computed by incrementing whatever tag happens to
  be running, a source-commit SHA, and the installer's own hardcoded
  `1.0.0`. None of them agreed with each other.
- **Migrations are forward-only**, tracked in a `schema_migrations` table,
  run in-process at API startup (`apps/api/src/migrations/index.ts`). There
  has never been a `down()`.
- **An auto-update mechanism already exists** — and it is exactly the
  shape this document argues against: `installer/templates/deployment-platform-update.template`,
  installed by every fresh install as a systemd service
  (`deployment-platform-update.service`) polling **every 30 seconds**,
  `git clone`s the configured branch's HEAD, and **rebuilds both Docker
  images from source, locally, on that install**, then runs the exact same
  `scripts/release-remote.sh` used for a manual release. There is no
  channel, no policy, no signature, no version floor — every installation
  unconditionally tracks whatever is at the tip of the configured branch,
  as soon as it's pushed. This is worth keeping in mind while reading the
  rest of this document, because most of what follows is about *changing
  the internals of this one mechanism*, not inventing a new one — its
  overall shape (a host-level service, independent of the containers it
  replaces) is exactly right (see §4 for why), it just needs to stop
  cloning-and-rebuilding and start pulling-and-verifying instead.
- **`release-remote.sh` already has excellent safety machinery** that this
  design deliberately reuses rather than replaces: a three-phase container
  swap (capture → stop/rename → create/verify), automatic rollback on any
  failure, a pre-update SQLite backup (`VACUUM INTO`), from-source migration
  verification, immutable-tag enforcement, and full runtime-config
  preservation. None of that needed to change. What changed is documented
  in §5 below.

## 2. End-to-end target flow

```
Development (any machine) --push tag vX.Y.Z--> GitHub
                                                   |
                                          .github/workflows/release.yml
                                          (tests, build, sign, publish)
                                                   |
                              +--------------------+--------------------+
                              |                                         |
                     GHCR: versioned, digest-pinned          GitHub Releases:
                     clovaforge-api / clovaforge-web          signed manifest +
                     images (immutable tag == version)        detached signature,
                                                                per channel
                                                   |
                     Each installation, independently, on its own schedule:
                     fetch channel manifest -> verify signature -> compare
                     version -> (per its own policy) pull by digest ->
                     release-remote.sh --image-source registry -> verify -> live
```

The publishing side (top half) is a single, deliberate act — a version
tag push. The consuming side (bottom half) is many independent, unrelated
actors, each deciding for itself whether and when to act. **CI never
contacts an installed server.** No installation ever depends on the
publisher's machine, credentials, or continued participation to receive an
update — pulling a public, signed artifact from GitHub is all any of them
ever do.

## 3. Versioning — IMPLEMENTED

Root `package.json`'s `"version"` field is the one authoritative source.
Everything else derives from it rather than declaring its own:

- The release workflow (`.github/workflows/release.yml`) requires the
  pushed tag (`vX.Y.Z`) to equal `package.json`'s version, and fails the
  release otherwise — a tag and the source it points at can never quietly
  disagree.
- Both Docker images now take `APP_VERSION`/`SOURCE_COMMIT` build args
  (`apps/api/Dockerfile` — newly added; `apps/web/Dockerfile` already had
  this) and expose them as `APP_VERSION`/`SOURCE_COMMIT` environment
  variables inside the running container.
- `GET /` (the API's own root route) now reports
  `process.env.APP_VERSION ?? "dev"` — previously a hardcoded `"0.4.0"`
  that had silently drifted from everything else in the system
  (`apps/api/src/server.ts`).
- `installer/lib/images.sh` and `scripts/release-remote.sh` both now pass
  the same `APP_VERSION`/`SOURCE_COMMIT` build args to the API image build
  that the web image build already received — previously only the web
  image got them.
- `apps/api/src/services/semver.ts` is the one place `MAJOR.MINOR.PATCH`
  parsing/comparison happens — deliberately narrow (no pre-release/build
  suffixes; this platform never produces or accepts one).

The existing "per-box counter" version scheme in `release.sh`/
`deployment-platform-update.template` (increment whatever's currently
running) is unaffected by this and continues to work exactly as before —
it answers a different question ("what hasn't collided with a local Docker
tag yet") than the release pipeline's canonical version does ("what did
the project actually publish"). Reconciling the two fully is part of
Phase 6 (bootstrapping the current production instance onto real,
CI-published versions).

## 4. Why a host-level agent, not the API updating itself

The API container already has the Docker socket mounted (it needs this to
manage every app it hosts) and could, in principle, pull an image and
recreate its own container using the same `dockerode` calls it already
uses for customer apps. **This does not work for updating itself**: the
moment it stops/renames its own container to swap in the replacement, the
process doing that work is killed mid-operation. There is no way to
finish a swap of your own container from inside that container.

This is exactly why `deployment-platform-update.service` already exists as
a **systemd unit running directly on the host**, independent of every
Docker container it manages — this part of the existing design is
correct and is retained unchanged. It:

- runs as a plain host process, so replacing the API/web containers
  doesn't affect it,
- is `Restart=always` with `StartLimitIntervalSec=0`, so a crash mid-update
  is retried rather than leaving the install permanently stuck,
- serializes with `flock` so a slow update is never run twice concurrently.

The API's role is therefore **advisory, not executive**: it can check for
updates, evaluate a manifest, hold policy settings, and record "please
apply this" — but it never itself pulls an image or touches a container.
It hands that off to the host agent, using the *exact IPC pattern this
project already relies on for another host↔container boundary*: the
existing updater already reads the GitHub App token out of the API's own
SQLite database via `docker exec deployment-platform-api node -e "..."`
(see `installer/templates/deployment-platform-update.template`). The
future host agent will read `platform_settings` (update policy, channel,
and an apply-request record) the same way — no new privilege, no new
communication mechanism, one boundary-crossing convention for the whole
project.

## 5. Release manifest & artifact strategy — IMPLEMENTED (schema, generation,
   verification); Phase 3 wires the consuming side into the live host agent

### Shape

`apps/api/src/schemas/release-manifest.ts` is the one place the manifest's
shape is defined — the release pipeline, the API's checking service, and
(in Phase 3) the host agent all import from it rather than maintaining
independent copies that could drift.

```json
{
  "schemaVersion": 1,
  "version": "1.2.0",
  "channel": "stable",
  "releasedAt": "2026-09-16T20:00:00.000Z",
  "sourceCommit": "<40-char git sha>",
  "api": { "repository": "ghcr.io/owner/clovaforge-api", "digest": "sha256:..." },
  "web": { "repository": "ghcr.io/owner/clovaforge-web", "digest": "sha256:..." },
  "minimumUpgradeVersion": "1.0.0",
  "notesUrl": "https://github.com/owner/repo/releases/tag/v1.2.0",
  "requiresManualApproval": false
}
```

Deliberately **not** in the manifest: a migrations list. An earlier draft
of this design carried one, but which migrations an upgrade will actually
run depends on the *installation's own current version* — a single
manifest can't correctly represent that for every possible starting
point. Instead, every migration in `apps/api/src/migrations/*.ts` declares
its own `risk: "expand" | "breaking"` field (required — an author must
say, not have the platform guess), and
`apps/api/src/migrations/index.ts`'s `computeRollbackSafety(previousMaxVersion)`
answers "would rolling back past here be safe" using the installation's
*own* `schema_migrations` state. This is the same "source of truth lives
in the actual source/database, not a hand-maintained side list" principle
`release-remote.sh`'s existing migration verification step already
follows.

All 27 existing migrations have been classified: 26 as `"expand"`
(pure `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` / index
creation), and migration `002_expand_apps_columns` as `"breaking"` — it
backfills a new column via `UPDATE`, which is not unsafe in itself, but is
exactly the shape of change this classification exists to make someone
positively assert about rather than assume.

### Artifacts

- **Images**: built by the exact same Dockerfiles as today, pushed to
  GHCR (`ghcr.io/<owner>/clovaforge-api`, `ghcr.io/<owner>/clovaforge-web`)
  tagged with the release version — **immutable, never `:latest`**. The
  manifest additionally records each image's content digest
  (`sha256:...`), and every installation pulls **by digest, not by tag** —
  Docker itself refuses the pull if the registry doesn't serve exactly
  those bytes, which is the actual artifact-integrity check; nothing else
  re-verifies image content.
- **Manifest + signature**: published as GitHub Release assets. Every
  tagged release (`vX.Y.Z`) gets its own GitHub Release carrying
  `manifest.json` and `manifest.json.sig`. In addition, a small number of
  **permanent, pre-created releases act as channel pointers**
  (`stable-latest`, and later `beta-latest`/`nightly-latest`) whose two
  assets are overwritten (`gh release upload --clobber`) each time a
  release is promoted to that channel. An installation configured for the
  stable channel always fetches the same fixed URL
  (`.../releases/download/stable-latest/manifest.json`) — it never needs
  to know a specific version tag to check for updates.
- Both are served over plain HTTPS from `github.com`/`objects.githubusercontent.com`
  — no separate release-registry service to run or trust.

### Signing

- **Algorithm**: Ed25519 (`node:crypto`'s built-in support — no external
  dependency). Verified with Node's own `crypto.verify`, unconditionally
  cheap enough to run from a shell one-liner via the sandboxed
  `node:24-alpine` helper container this repo already uses in
  `scripts/release-remote.sh` and `installer/lib/secrets.sh`, consistent
  with the project's existing "no host Node" convention for anything that
  runs on the bare VPS.
- **What's signed**: the manifest's raw JSON bytes, exactly as published —
  never a re-serialization of the parsed object, since key order or
  whitespace could legitimately differ from what was actually signed. The
  signature is a **detached** file (`manifest.json.sig`), never embedded.
- **Where the private key lives**: a GitHub Actions repository secret
  (`RELEASE_SIGNING_PRIVATE_KEY`, base64-encoded PKCS8 PEM). It never
  appears in the repository, in a build artifact, or in any log — the
  release workflow reads it only from `secrets.*` and only within the one
  step that needs it.
- **Where the public keys live**: `installer/trusted-keys/<keyId>.pem` —
  committed SPKI PEM files, the single trust anchor. Loaded from these exact
  bytes by both the **API image** (baked in via `apps/api/Dockerfile`'s
  `COPY installer/trusted-keys ./trusted-keys`, read by
  `apps/api/src/services/trusted-keys.ts`) and the **host updater** (the
  installer copies them to `${INSTALL_ROOT}/config/trusted-keys/`, read by
  `installer/updater/resolve-update.mjs`). "Add a key" = "add a `.pem` file".
  **The directory is currently empty** (only a `.gitkeep`), which is the
  correct fail-closed state until a signing key is provisioned: every
  manifest is rejected `unknown-signing-key`. To provision the first key,
  run **locally** (never on a CI runner), on Windows/Mac/Linux:

  ```
  node scripts/generate-signing-key.mjs clovaforge-release-1
  ```

  That writes the **public** key to `installer/trusted-keys/clovaforge-release-1.pem`
  (commit it) and prints the **private** key (base64 PKCS8 PEM). Then:
  - add the private key as the GitHub Actions repository **secret**
    `RELEASE_SIGNING_PRIVATE_KEY`;
  - set the repository **variable** `RELEASE_SIGNING_KEY_ID` to
    `clovaforge-release-1`;
  - commit the new `.pem` and ship it in a release **before** the first
    signed release, so installations already trust the key when they first
    see a manifest signed with it.
- **Rotation**: run the keygen with a new keyId (e.g.
  `clovaforge-release-2`), commit the new public `.pem` **alongside** the old
  one (both stay trusted, so releases signed before the rotation still
  verify), ship that as an ordinary release, then switch the CI
  secret/`RELEASE_SIGNING_KEY_ID` to the new key for the *next* release. Only
  delete an old `.pem` once every installation you care about has updated
  past every release signed with it.
- **Downgrade protection**: the manifest is the only source of "what's
  current" an installation trusts, and `evaluateUpdateAvailability` only
  ever reports an update when the manifest's version is strictly newer
  (`compareSemVer` — real numeric comparison, not string comparison, so
  `"10.0.0"` is correctly newer than `"9.0.0"`). An attacker who could
  control the manifest URL entirely (not just tamper with its bytes, which
  the signature already prevents) could still serve an old, validly-signed
  manifest — HTTPS plus GitHub's own access controls on who can publish a
  release are what prevents that; there is no separate downgrade-nonce
  scheme in this design because there is no server-side state for one to
  live in.

## 6. Update discovery & status API — IMPLEMENTED

`apps/api/src/routes/platform-updates.ts`, mounted at `/platform/updates/*`:

| Route | Purpose |
|---|---|
| `GET /platform/updates/settings` | Current channel, policy, structured maintenance window, and the derived per-channel manifest URLs |
| `PUT /platform/updates/settings` | Update them (HTTPS-only base URL + validated window enforced by schema) |
| `GET /platform/updates/status` | Last cached check result, the live update state, and the last successful update |
| `POST /platform/updates/check` | Fetch + verify the configured channel's manifest now, cache and return the result |
| `GET /platform/updates/history` | The durable update-attempt history (migration 028) |
| `POST /platform/updates/request-apply` | Record an apply request for the host agent — **never applies anything itself** (see §4) |

Settings, the cached check result, and the live-state mirror are stored via
the existing generic `platform_settings` key-value table
(`getJsonSetting`/`setJsonSetting`). Update **history** is a proper table
(`platform_update_history`, migration 028) so it is queryable and bounded
(`pruneUpdateHistory`). The channel's manifest/signature URLs are *derived*
from a single stored `manifestBaseUrl` + `channel` (`${base}/${channel}-latest/...`),
so switching channel never means re-entering a URL.

`request-apply` deliberately only accepts the version from this
installation's own most recent **verified** `update-available` check
result — never an arbitrary caller-supplied version string. This closes
the obvious hole: without it, anyone who can reach this authenticated
route could request an "update" to a version nobody signed or verified,
turning a status-reporting endpoint into an unauthenticated-content
installer. All routes sit behind the platform's existing session
authentication (the global `onRequest` hook in `apps/api/src/auth.ts`) —
there is no separate auth model for updates.

This is unrelated to `image-update-check-service.ts`, which checks for
newer *registry* images of apps **hosted on** the platform (Postgres,
Redis, a template deploy, ...) — a completely separate concern from the
platform updating itself. See "Hosted apps are different" below.

## 7. Registry pull mode for `release-remote.sh` — IMPLEMENTED

`scripts/release-remote.sh` gained `--image-source build|registry`
(default `build` — **fully backward compatible**, every existing manual
release and the current continuous updater are unaffected) plus
`--api-image-digest`/`--web-image-digest`.

In `registry` mode, the image-build stage does this instead of
`docker build`:

```bash
docker pull "${repo}@${digest}"
docker tag "${repo}@${digest}" "${repo}:${version}"
```

Every later stage — environment/mount capture, the three-phase container
swap, migration verification, rollback, public-URL checks — is completely
unaffected, because they only ever reference `"${repo}:${version}"` once
it exists locally; none of them care how it got there. This is why the
change to a 2,264-line, heavily-tested, production-proven script could be
this small: the pull-vs-build decision was already cleanly isolated to one
stage.

Covered by new argument-validation tests in `scripts/tests/run.sh`
(`--image-source` rejects unrecognized values; `registry` mode requires a
valid `sha256:<64-hex>` digest per component being released; the default
path is untouched).

## 8. Migration safety — IMPLEMENTED (mechanism); ongoing (discipline)

- Every migration file has a required `risk: "expand" | "breaking"` field
  (`apps/api/src/migrations/types.ts`). There is no default — a migration
  author must decide.
- `computeRollbackSafety(previousMaxVersion)` answers "is it safe to roll
  the container back to whatever was running before this install's most
  recent migration run" by checking whether every migration newer than
  `previousMaxVersion` is `"expand"`.
- The **existing** pre-update SQLite backup (`VACUUM INTO`, already part of
  `release-remote.sh`'s stage 3, unchanged by this work) is what actually
  makes a `"breaking"` migration recoverable — rollback-safety being false
  means "swapping the container back is not enough; restore this backup
  instead," not "there is no way to recover."
- **Going forward, the discipline this buys is**: prefer additive changes
  (new nullable column, new table, new index) over anything that drops,
  renames, or tightens a constraint on an existing column whenever a
  migration can be written either way — the difference is exactly what
  determines whether a bad release can be undone with a container swap
  (seconds) or requires a database restore (the pre-update backup,
  correctness-critical but slower and disruptive).

## 9. Hosted apps are different

Nothing in this document changes how ClovaForge deploys or updates the
applications **it hosts for its operators** — GitHub-linked apps, one-click
templates, database connections, and so on all keep working exactly as
they do today. `image-update-check-service.ts` (checks whether a hosted
app's own registry image has moved) is a separate, pre-existing concern
this work leaves untouched. This document is scoped entirely to the
platform (the two `deployment-platform-api`/`deployment-platform-web`
containers) updating itself.

## 10. Implementation phases

**Phase 1 — Foundations (this work; DONE)**
- Canonical version wiring (§3): API Dockerfile build-arg, `GET /` fix,
  both build call sites updated.
- Release manifest schema + semver comparison + signature
  verification service, with unit tests covering malformed manifests, bad
  signatures, unknown keys, tampered content, HTTPS enforcement, and
  numeric (not lexicographic) version comparison.
- Migration `risk` classification mechanism + `computeRollbackSafety`,
  applied to all 27 existing migrations.
- `release-remote.sh` registry pull mode (build-vs-pull now fully
  decoupled from every other stage).
- GitHub Actions release pipeline (`release.yml`): tag-triggered, tests,
  builds + pushes digest-pinned GHCR images, generates and signs the
  manifest, publishes it as both a versioned release and the `stable-latest`
  channel pointer. **Implemented but never triggered this session** — no
  tag has been pushed, and it cannot succeed yet regardless, because no
  signing key has been provisioned (§5 "Signing" — `TRUSTED_SIGNING_KEYS`
  is deliberately empty until that's done).

**Phase 2 — Update status & manual check (this work; DONE)**
- `/platform/updates/*` API surface: settings, cached status, an
  authenticated on-demand check, and an apply-request recorder that
  refuses anything not already verified by this installation's own last
  check.

**Phase 3 — Safe automated apply (DONE)**
- `installer/templates/deployment-platform-update.template` is now the
  registry-based updater (the old git-clone-and-build one is preserved,
  clearly marked legacy, as `deployment-platform-update-legacy-source.template`).
  Per tick it reconciles any interrupted update, reads config from the API
  DB (via `docker exec`), fetches the channel manifest, verifies + decides
  in a sandboxed `node:24-alpine` helper (`resolve-update.mjs`), and for an
  "apply" decision runs preflight → backup → `release-remote.sh
  --image-source registry` → records state + history.
- The source-dependent stages `release-remote.sh` needs (migration
  verification; the `current` pointer's existence checks) are satisfied
  without a host checkout: the updater builds a minimal release dir with
  stub `package.json`/Dockerfiles plus the target image's real migration
  `.ts` files (`docker cp`-ed out of the pulled image, which now bakes
  `apps/api/src/migrations`). No git, no npm, no compiler on the host.
- Durable state machine + reconciliation: `update-state-machine.ts`
  (states + legal transitions + recovery classification), persisted to the
  host file `${INSTALL_ROOT}/state/update-state.json` (source of truth,
  owned by the always-alive host process) and mirrored into the DB for the
  UI. On startup the updater reconciles a pre-cutover interruption
  (abandon, old version untouched) vs a post-cutover one (inspect what's
  actually running; flag `manual_intervention_required` if unhealthy).
- Migration-aware rollback: `release-remote.sh --rollback-safe 0|1`. The
  updater computes safety from the target image's own compiled
  `computeRollbackSafety` before the swap; on a failed health check with a
  breaking migration, `release-remote.sh` refuses the unsafe container
  swap-back and reports `MANUAL_INTERVENTION_REQUIRED` (never a false
  `ROLLED_BACK`).
- Update history: migration 028 `platform_update_history` +
  `update-history-database.ts` repository; the updater writes start/finish
  rows via `docker exec` into the API; `GET /platform/updates/history`
  serves them.

**Phase 4 — Policy & maintenance windows (DONE)**
- `update-policy.ts`: `evaluateAutoApply` (notify_only / automatic_patch /
  automatic, with major-never-automatic and `requiresManualApproval` as a
  hard block) and `isWithinMaintenanceWindow` (timezone-aware, midnight-
  crossing). Enforced by the host updater's decision step
  (`resolve-update.mjs` mirrors the same rules) and surfaced informationally
  by `/platform/updates/check`.
- A manual "Update now" bypasses the window (operator is present) but never
  the manual-approval block (a manual apply *is* the approval).

**Phase 5 — Update settings UI (DONE)**
- `PlatformUpdatesPanel.tsx` (rendered in Settings → Updates): current /
  latest version, live state with honest discrete-state labels (no fake
  percentages), last checked / last successful update, channel + policy
  pickers, an optional maintenance window, Check for Updates, Update Now
  (only for a directly-installable verified update), and the update
  history list.

**Phase 6 — Migrate the current production instance (READY; requires the
operator to run the bootstrap — see §13)**
- The bootstrap script and runbook exist (`scripts/bootstrap-production.sh`,
  §13). It is the one step this environment cannot perform itself (no VPS
  access), and it changes a live server, so it is run deliberately by the
  operator after the signing key is provisioned and the first release is
  published.

## 11. Failure handling reference

Every row is handled by code that exists today.

| Condition | Behavior |
|---|---|
| Release endpoint unreachable / partial download | `curl` fails; updater logs "endpoint unavailable", state returns to `idle`; nothing running is affected |
| Manifest/signature not valid JSON, or fails schema | resolver returns `action:none` with `invalid-json`/`invalid-manifest`/`invalid-signature-envelope`; no apply |
| Signature doesn't match the exact bytes (tampered) | `signature-verification-failed`; no apply (covers corruption and tampering) |
| `keyId` not a trusted `.pem` | `unknown-signing-key`; never falls back to trusting it |
| Manifest/signature URL not HTTPS | Rejected before any request (API), and the updater refuses a non-HTTPS manifest URL |
| Current version older than `minimumUpgradeVersion` | `requiresIncrementalUpgrade`; updater `notify`s, never attempts the jump; UI hides "Update now" |
| Wrong-channel manifest served | resolver rejects a *higher* channel than requested (`channel-mismatch`); stable ⊆ beta accepted |
| Insufficient disk / docker down / image unpullable | Updater preflight fails **before any container is touched**; state `failed`; previous version untouched |
| Digest mismatch on pull | Docker refuses the pull; `release-remote.sh` `fail()` path; no cutover |
| Health check fails after swap, rollback **safe** | `release-remote.sh` restores the previous container → `ROLLED_BACK` → history `rolled_back` |
| Health fails after swap, rollback **unsafe** (breaking migration) | `release-remote.sh` refuses the unsafe swap-back → `MANUAL_INTERVENTION_REQUIRED`; backup + preserved container kept |
| Rollback itself fails | `ROLLBACK_FAILED` → `manual_intervention_required`; treat as an active incident |
| Updater/service restart or host reboot mid-update | On next tick, `reconcile_interrupted_update` inspects real container state and settles honestly (idle if healthy, else manual intervention); `flock` + `manual_intervention_required` prevent stacking a second update |
| Concurrent ticks / stale lock | The loop's `flock` serializes ticks; a slow update simply delays the next tick |

## 12. Emergency manual recovery

The updater and `release-remote.sh` never delete a rollback container, a
database backup, or a release directory automatically. To recover a server
stuck in `manual_intervention_required` (the platform may be down):

1. Read `${INSTALL_ROOT}/logs/update.log` — it names the failure stage, the
   preserved rollback container(s), and the pre-update backup path
   (`/data/backups/backup-<ts>.sqlite`, inside the `deployment-platform-api-data`
   volume).
2. **If a breaking migration ran** (log says automatic rollback was unsafe):
   restore the backup into the volume, then restore the previous container:
   ```
   # inspect what's preserved
   docker ps -a --filter "name=-rollback-"
   # restore the DB backup (from inside the api data volume) — example:
   docker run --rm -v deployment-platform-api-data:/data alpine \
     sh -c 'cp /data/backups/backup-<ts>.sqlite /data/deployment-platform.sqlite'
   # bring back the previous container
   docker rename deployment-platform-api-rollback-<ver>-<ts> deployment-platform-api
   docker start deployment-platform-api
   ```
   (do the same for `-web` if it was swapped), then confirm health.
3. **If no breaking migration ran**, the previous image is safe on the
   current schema: just rename the preserved rollback container back to its
   live name and start it — no DB restore needed.
4. Once healthy, clear the stuck state so automatic checks resume — from
   Settings → Updates press **Check for updates** (this re-enters the state
   machine), or reset it directly:
   ```
   docker exec deployment-platform-api node --input-type=module -e '
   import { createAppDatabase } from "/app/apps/api/dist/database.js";
   const db = createAppDatabase(process.env.DATABASE_PATH || "/data/deployment-platform.sqlite");
   db.setJsonSetting("platform_update_state", { state:"idle", targetVersion:null, detail:"manually cleared", updatedAt:new Date().toISOString() });
   db.close();'
   rm -f /opt/deployment-platform/state/update-state.json
   ```
5. Preserved rollback containers, backups, and release directories are a
   deliberate record — remove them by hand once you're confident.

## 13. Production bootstrap (migrating the existing server)

This is the one-time migration of a server currently on the manual
`release.sh` / legacy-git-updater model onto the signed registry model. It
is scripted as `scripts/bootstrap-production.sh` and must be run **on a
machine with SSH access to the VPS** (this project's Windows dev box does
not have that). Prerequisites: the signing key is provisioned (§5) and the
first real release is published (§14).

`scripts/bootstrap-production.sh` is **inspect-first and idempotent**. Run
it with `--check` first — it inspects the live install (version,
containers, volumes, disk, updater service, configured channel) and prints
what a real run would change, touching nothing. Then run it with `--apply`
to:

1. take a full platform backup and verify it,
2. install the trusted signing key(s) into `${INSTALL_ROOT}/config/trusted-keys/`,
3. install the registry updater assets (`resolve-update.mjs`,
   `release-remote.sh`) into `${INSTALL_ROOT}/updater/`,
4. replace `/usr/local/bin/deployment-platform-update` with the registry
   updater and reload the systemd unit,
5. seed the update settings (channel — `beta` for this project's own box,
   `stable` for everyone else; policy — a safe default of `notify_only`
   until you're confident, then `automatic_patch`),
6. run `deployment-platform-update --check-only` to prove the whole
   discover → fetch → verify → decide chain works end to end **without
   applying anything**.

It never deletes data, never removes a volume, and never force-replaces a
container. What it changes is limited to the host-side updater wiring and
the update-settings row. The existing platform containers keep running
throughout; the first *actual* registry update happens afterwards, on the
updater's normal schedule or via a manual "Update now".

## 14. Publishing a release (the everyday workflow)

Once the signing key is provisioned, publishing a new ClovaForge release —
from any machine with the repo, no Mac/VPS/rsync required — is:

1. Bump `"version"` in the root `package.json` (this is the one
   authoritative version — the tag must match it).
2. Commit and push to `main`.
3. Tag and push the tag:
   ```
   git tag v1.5.0
   git push origin v1.5.0
   ```
4. GitHub Actions (`release.yml`) then, entirely in the cloud: validates the
   tag matches `package.json`, runs the API + web test suites, builds and
   pushes digest-pinned `clovaforge-api`/`clovaforge-web` images to GHCR,
   generates + signs the manifest, publishes a GitHub Release for the
   version, and advances the `stable-latest` and `beta-latest` channel
   pointers.
5. Every installation discovers it on its own schedule and channel, verifies
   the signature, and installs it per its own policy. You SSH into nothing.

To ship a **beta-only** pre-release (e.g. to your own box before promoting
to stable), publish with `RELEASE_CHANNEL: beta` and update only the
`beta-latest` pointer — see `release.yml`. Promote it to stable later by
publishing the same version normally.

Do **not** hand-build a one-off image to "test" this — exercising the real
tag → Actions → GHCR → signed manifest → updater chain is the point.
