# Release Automation

`release.sh` automates the Deployment Platform's verify → commit → sync →
build → deploy → verify workflow. It is designed to be run by an operator
sitting at the keyboard, not by CI, and it stops and asks before every
step that changes shared state.

## Normal usage

```bash
cd /Users/kevinpoulos/Documents/Projects/DeploymentPlatform
./release.sh
```

This runs the full workflow, interactively:

1. **Local pre-flight** — confirms you're in the right repo, on `main`,
   with no secret-like files lying around.
2. **Change detection** — classifies the pending change as API, web,
   both, or documentation/script-only, and computes the exact candidate
   file list. If there is nothing releasable, the script stops here with
   a clear **no changes** result — it never runs the build or tests for
   an empty release.
3. **Build** — `npm run build`.
4. **Tests** — `npm run test --workspace=@deployment-platform/api`.
5. **Release plan** — shows the current and proposed image versions
   (skipped for documentation/script-only changes — see below).
6. **Commit** — shows the exact files it intends to stage, asks for a
   commit message (unless `--message` was passed), asks for confirmation,
   then commits.
7. **Source sync** — rsyncs the committed source into a brand-new,
   immutable release directory on the VPS (skipped entirely for
   documentation/script-only changes).
8. **Remote deploy** — builds new Docker image(s), backs up the
   database, swaps containers while preserving their runtime
   configuration, and verifies the result.
9. **Release complete** — prints one final report you can paste back
   into ChatGPT for review. The remote script itself atomically updates
   the VPS `current` source pointer, as the very last required step
   before it reports success — see "Current source pointer update" and
   "Rollback behavior" below.

The whole run produces a single, continuous, copy-pasteable transcript
with `===== SECTION =====` headers. No color codes are used, so the
output survives being pasted into anything.

## `--yes` (no interactive confirmation)

```bash
./release.sh --message "Fix the thing" --yes
```

Auto-confirms the two `y/N` prompts (staging/committing, and proceeding
with the remote build/deploy) instead of waiting for input. A commit
message is still required — pass it with `--message`. If you omit
`--message` under `--yes`, the script does not invent one; it fails
cleanly at the empty-commit-message check instead of guessing at what
happened. `--yes` does not change anything else about the workflow —
every check, build, test, and safety gate still runs exactly as before;
it only removes the two points that would otherwise wait for a human to
type `y`.

## Resuming an already-committed, already-synced release

If a release makes it through local verification, commit, and source
sync, but then fails during remote pre-flight/build/swap/verification
(for example, a missing host-level dependency on the VPS) — the commit
and the immutable release directory it created are both left in place,
untouched. There is no need to make a fake code change just to get
another deployment attempt.

```bash
./release.sh \
  --resume-release /opt/deployment-platform/source/releases/release-20260726T191815Z-ac3bbc13ae2b \
  --api-version 1.2.1 \
  --web-version 1.1.2 \
  --yes
```

`--resume-release` redeploys that exact, already-synced directory
instead of staging, committing, or syncing anything new. It:

- **only** accepts a path under `${VPS_SOURCE_DIR}/releases/` that
  matches the `release-<timestamp>-<12 hex sha>` naming convention
  release.sh itself uses — anything else (a different directory,
  `..` traversal, shell metacharacters, a path outside `releases/`) is
  rejected outright, before any SSH call is made;
- verifies, over SSH, that the directory actually exists on the VPS and
  that `package.json`, `apps/api/Dockerfile`, and `apps/web/Dockerfile`
  are all present inside it;
- extracts the 12-character commit suffix from the directory name and
  requires it to match the current local `git rev-parse HEAD` (or an
  explicit `--resume-commit <sha>` override) — refusing if they don't,
  so you can't accidentally resume a directory that doesn't correspond
  to the commit you think it does;
- skips local build, tests, staging, commit, and source sync entirely —
  nothing in your working tree is touched;
- still inspects the **currently running** API/web image versions on
  the VPS (exactly like a normal release does) and shows them before
  asking for confirmation;
- still requires the same explicit confirmation as a normal deploy
  (`--yes` still works here, exactly as documented above);
- still runs every remote pre-flight, image-build, backup, migration,
  container-swap, verification, and automatic-rollback protection in
  `scripts/release-remote.sh` — including its existing refusal to
  overwrite an image tag that already exists, and its refusal if the
  intended rollback container name is already taken;
- never accepts an arbitrary remote command — the resumed directory is
  passed to the exact same, fixed `--source-dir` flag a normal release
  uses.

`--resume-mode api|web|both` (default `both`) controls which
component(s) the resumed release rebuilds and swaps — set this to match
what the original, interrupted release was actually meant to touch.

`--api-version`/`--web-version` behave exactly as in a normal release:
if you omit them, the next patch version is computed from whatever is
currently live. Passing them explicitly (as in the example above) is
recommended for a resume, since it makes the intended target version
unambiguous.

## No-change behavior

Once the release tooling itself (`release.sh`, `scripts/release-remote.sh`,
`release.config.example`, `docs/RELEASE_AUTOMATION.md`) has been
committed once, running `./release.sh` again on an otherwise-clean
repository does **not** appear dirty just because `generate-auth.sh` sits
there untracked. The no-change check only counts:

- tracked modifications,
- tracked deletions, and
- untracked files inside a recognized project path (`apps/`, `packages/`,
  `scripts/`, `docs/`, or a few known root files).

`generate-auth.sh` and any other untracked file outside those paths are
reported for visibility but never counted as a change. If none of the
above produced anything, you get:

```
===== NO CHANGES =====
No releasable changes were found (permanently-excluded and unrecognized
untracked files do not count).
Nothing to release.
```

and the script exits `0` before touching the build, tests, Git, or the
VPS.

## `--verify-only`

```bash
./release.sh --verify-only
```

Runs local pre-flight, change detection, the no-change check, build,
tests, and prints the release plan (including a best-effort look at the
currently running image versions on the VPS, skipped for
documentation/script-only changes). **Nothing is staged, committed,
synced, or deployed.** Use this to sanity-check a change before you're
ready to release it. This is the safest first command to run.

## `--plan-only`

```bash
./release.sh --plan-only
```

A lighter, faster preview than `--verify-only`: local pre-flight, change
detection, the no-change check, candidate files, release scope, proposed
versions, and — when the VPS is reachable — a read-only look at the
*current* API/web container's runtime configuration (restart policy,
entrypoint/cmd, working directory, resource limits, mounts, port
bindings, attached networks). It also prints, in plain language, what
the sync/build/swap/verify steps would do.

**`--plan-only` never builds, tests, stages, commits, syncs, or deploys
anything.** It does not even run `npm run build`. The runtime-settings
preview it shows is informational — the exact `docker create` arguments
that will actually be used are only ever computed for real inside
`scripts/release-remote.sh`, against the image that has just been built,
immediately before that specific container is touched.

Use `--plan-only` when you just want to see what a release *would* do;
use `--verify-only` when you also want the build and test suite to
actually run.

## `--no-deploy`

```bash
./release.sh --no-deploy
```

Runs everything through the commit step — local pre-flight, build,
tests, staging, and a real local commit — then stops. Source is not
synced and the VPS is not contacted. Use this when you want the commit
made now but want to deploy later (or deploy manually).

## Script-only / documentation-only releases

If the computed release scope touches neither `apps/api/`, `apps/web/`,
nor any Caddy configuration source (a docs or tooling-only change),
`release.sh`:

- still runs the full local build and test suite (`--verify-only`
  behavior is unaffected),
- **does not** SSH to the VPS to inspect current image versions,
- **does not** prompt for or compute an API/web version number,
- stages and commits the change locally exactly like any other release,
  and then
- **stops** — it does not sync source, build an image, or contact the
  VPS at all.

You'll see a `Local-only release` summary instead of a deployment
report. There is currently no flag to force a script-only change to also
contact the VPS — that is intentionally left for a future, explicit
option rather than being inferred automatically.

## Caddy configuration releases

A change to the reverse-proxy configuration is neither an API change nor
a web change, but it still has to reach the server. Without an explicit
scope for it, a Caddyfile fix would be classified as script-only and
committed locally forever while the live server kept its old routing.

`release.sh` therefore recognises a third deployable scope. These paths
are Caddy configuration sources:

- `installer/templates/Caddyfile.template`
- `installer/lib/caddy.sh`

When one of them changes and no application code does, the plan reports:

```
API changed: no
Web changed: no
Caddy configuration changed: yes
Documentation/script-only change: no
```

and the release runs in `caddy` deploy mode:

- no image is built, and **no version number is requested** — there is
  no artifact to version,
- source is still synced into a new immutable release directory, so the
  server's checkout matches the commit,
- the Caddyfile is re-rendered on the server **from the synced
  template**, never hand-edited, with the same placeholder substitution
  the installer performs,
- rendering fails loudly if any `__PLACEHOLDER__` survives,
- the result is validated with the running Caddy binary
  (`caddy validate --adapter caddyfile`) *before* it is installed,
- an identical render is a no-op (no reload, no backup churn),
- the previous file is backed up to
  `<Caddyfile>.backup-<release-timestamp>` and restored automatically if
  installation, reload, or verification fails,
- the restore is also the first action taken by the normal rollback path,
  so a Caddy change can never be left half-applied,
- verification runs exactly as it does for an application release.

If the same release also changes application code, the Caddy stage runs
in addition to the image deploy, immediately before verification.

## The `/api` prefix contract

The panel's browser bundle calls the API at `/api/...`. The API itself
registers its routes **without** a prefix (`/auth/login`, `/auth/session`,
`/apps`, …). Caddy is the component responsible for reconciling the two,
and the generated Caddyfile does it with:

```
handle_path /api/* {
	reverse_proxy <api-container>:<api-port>
}

handle {
	reverse_proxy <web-container>:<web-port>
}
```

`handle_path` is `handle` plus an implicit `uri strip_prefix /api`, so
exactly one leading `/api` segment is removed and the remainder of the
path — and the entire query string — is forwarded unchanged:

| Public request        | Reaches the API as |
| --------------------- | ------------------ |
| `/api/auth/login`     | `/auth/login`      |
| `/api/auth/session`   | `/auth/session`    |
| `/api/apps?x=1`       | `/apps?x=1`        |
| `/api/api/apps`       | `/api/apps`        |

Two deliberate properties:

- **Bare `/api` (no trailing slash) is not matched.** Caddy's `/api/*`
  path matcher matches `/api/` and below, not `/api` itself, so a bare
  `/api` falls through to the web app like any other non-API path. The
  frontend never requests it; leaving it with the web app avoids
  advertising the backend at a path nothing uses.
- **Per-app routes are unaffected.** `import /etc/caddy/routes/*.caddy`
  brings in each managed app's own site block, which is matched by host
  before any of these path handlers are considered.

This belongs in Caddy, not in the API. The historical failure mode was
`handle /api/*`, which forwarded the prefix unchanged: the API saw
`/api/auth/login`, no route matched, and the authentication hook returned
`401 {"message":"Authentication required"}` for every login attempt. The
tempting "fix" — adding `/api/auth/login` to the authentication hook's
public path allowlist — would have papered over a proxy defect by
widening the security boundary, and would have left every other endpoint
(`/api/apps`, `/api/health`, …) broken. `installer/tests/run.sh` asserts
that no such allowlist entry exists.

## Version overrides

```bash
./release.sh --api-version 1.3.0
./release.sh --web-version 1.2.0
./release.sh --message "Add repository search filter"
```

By default, `release.sh` inspects the image tag currently running on the
VPS for each component and bumps the patch version of only the
components that actually changed (API-only changes bump only the API
version; web-only changes bump only the web version; changes to root
`package.json`/`package-lock.json`/`.dockerignore` conservatively bump
both). `--api-version`/`--web-version` override the computed value with
an explicit one. Both must be valid `X.Y.Z` semantic versions — anything
else is rejected before any Git or Docker state changes.

Regardless of where a version number comes from, the remote script
refuses to build an image tag that already exists on the VPS. There is
no override for that check in this version — if you need to reuse a
tag, do it manually and deliberately, outside this script.

### First release after a guided install (bootstrap tags)

The guided installer has no release history to bump from, so it tags its
first-boot images by source content rather than by version:

| Tag shape | Meaning |
|---|---|
| `bootstrap-unknown` | installed before source fingerprinting existed |
| `bootstrap-local-<hex>` | built from a local source tree, content fingerprint |
| `bootstrap-<hex>` | built from a git checkout, commit prefix |

These are legitimate running tags but they are **not** versions. On the
first `release.sh` run after an install, a changed component whose
running tag is any of the above starts the semantic version track at
**0.1.0** — matching the version already declared in `package.json` at
the repository root and in both `apps/api` and `apps/web`. The proposed
version and the transition are both stated in the release plan:

```
Current API image: deployment-platform-api:bootstrap-local-da486e2b7645
Proposed API version: 0.1.0
  First release for the API off installer bootstrap tag
  'bootstrap-local-da486e2b7645' — the version track would start at 0.1.0.
```

Subsequent releases patch-bump normally (0.1.0 -> 0.1.1 -> ...).

If a running tag is **neither** a semantic version nor a recognized
bootstrap tag (for example `latest`), `release.sh` stops before touching
Git, Docker, or the VPS and asks for an explicit
`--api-version`/`--web-version`. It never guesses, and it never passes a
non-version through to the remote script.

Rollback is unaffected by bootstrap tags: the previous version is only
used to name the preserved rollback container, is never required to be a
semantic version, and is sanitized for Docker naming — so a release off
`bootstrap-unknown` can still be rolled back to that exact image.

## Public URL verification contract

After the containers are swapped and verified, the remote script checks
public URLs. The contract is explicit about what is enforced:

| Config key | Required? | Behaviour |
|---|---|---|
| `PUBLIC_URL_PANEL` | **Mandatory** | Must return HTTP 200 or the release fails. |
| `PUBLIC_URL_WIZARD_TEST` | Optional | Empty/unset -> reported `SKIPPED` with a reason. Set -> must return HTTP 200. |
| `PUBLIC_URL_SQLITE_TEST` | Optional | Empty/unset -> reported `SKIPPED` with a reason. Set -> must return HTTP 200. |

The two app URLs point at deployed **test apps**, which do not exist on a
freshly installed server — the Caddy routes directory is empty until an
app is created. Requiring them made the first release after an install
impossible, so they now default to disabled.

Important properties:

- A **disabled** check is reported as `SKIPPED`, never as a pass.
- A **configured** check is mandatory. A connection failure (HTTP `000`,
  TLS failure, DNS failure) **fails the release** — it is never
  downgraded to a skip.
- Release summaries distinguish `PASS`, `FAIL`, and `SKIPPED`.
- Existing production configs that set both app URLs keep checking them
  exactly as before.

Do **not** point the app URLs at the panel URL to make them pass. That
would claim test-app coverage that never happened. Enable them once the
test apps are actually deployed.

Operator-facing summary labels are rendered from the configured URLs, so
the summary always names the server actually being deployed to:

```
Panel URL (https://panel.example.com): 200
Wizard test URL: skipped (not configured)
SQLite test URL: skipped (not configured)
```

## Immutable release directories

Every release that reaches the VPS is synced into its own,
never-reused directory:

```
${VPS_SOURCE_DIR}/releases/release-<UTC timestamp>-<short commit sha>/
```

Docker images are built with that exact directory as the build context
— never against a shared, long-lived source tree. This means there is
no `rsync --delete` to reason about and no way for a file left over from
an earlier release to influence this build: a brand-new directory has
no earlier files to begin with.

`${VPS_SOURCE_DIR}/current` is a symlink that only ever gets updated
**after** a deployment has been fully verified — it is left untouched if
the deployment fails or rolls back, so it always points at the last
release that actually passed. Old release directories are never deleted
by this script; they accumulate on the VPS (same philosophy as rollback
containers) so a previous release's exact source is always available
for comparison or a manual rebuild. Nothing outside
`${VPS_SOURCE_DIR}/releases/...` and the `current` symlink is ever
touched by the sync step — `AUTH_FILE`, `CADDY_ROUTES_DIR`, Docker
volumes, and database backups all live elsewhere and are never in its
path.

### Current source pointer update

`scripts/release-remote.sh` (not `release.sh`) owns updating
`${VPS_SOURCE_DIR}/current`, via `--current-symlink` (which `release.sh`
always passes). It is the **last required success action** — the script
does not print `PASS` until it has completed:

1. Verifies the release directory still has `package.json`,
   `apps/api/Dockerfile`, and `apps/web/Dockerfile`.
2. Points a temporary symlink at the release directory
   (`ln -sfn`), then atomically renames it into place over `current`
   (`mv -T`) — never a direct, non-atomic overwrite.
3. Resolves `current` with `readlink -f` and verifies it matches the
   release directory exactly.

If any of those steps fails, the script does **not** roll back the
already-verified, already-live containers — by this point the
deployment itself is healthy, and undoing it wouldn't fix a symlink
problem anyway. Instead it reports `PASS_WITH_WARNINGS` (see "Rollback
behavior" below) and tells you the exact manual command to run.

## Required host tools

**On the Mac** (`release.sh`): `git`, `npm`, `ssh`, `rsync`, `sed`,
`grep`, `awk`, `curl`.

**On the VPS** (`scripts/release-remote.sh`): `docker`, `curl`,
`openssl`, plus the standard POSIX/Linux utilities the script already
relies on (`sed`, `grep`, `tr`, `date`, `mktemp`, `id`). **The VPS
deliberately has no host-level Node.js installation, and this tooling
never requires one.** Node only ever runs two ways:

1. Inside the API image itself at runtime (and, briefly, inside the
   already-running API container via `docker exec` for the database
   backup, migration check, and `CREDENTIAL_ENCRYPTION_KEY` check — all
   three use that container's own bundled Node, never the host).
2. Inside a throwaway, pinned `node:24-alpine` container the remote
   script runs itself — see below.

If you ever see `required tool not found on VPS: node`, it means an
older copy of `scripts/release-remote.sh` is on the VPS or was invoked
directly; do not "fix" this by installing Node on the host — re-sync
the current script instead (a normal `./release.sh` run always
overwrites it via `scp` before every remote invocation).

## Dockerized Node runtime parser

Two things this tooling does — parsing a captured container's mount
list, and computing the exact `docker create` arguments needed to
reproduce a container's runtime configuration — need real structured
JSON parsing, not `grep`/`sed` against Docker's JSON output. Both run
inside a small, sandboxed helper container instead of requiring Node on
the host:

- **Image**: `node:24-alpine` — a fixed, non-floating tag, never
  `latest`. `scripts/release-remote.sh` checks for it during remote
  pre-flight (before any live container is touched) and pulls it if
  missing; a pull failure is reported as `FAILED` at that point, not
  partway through a swap. You'll see a line like:

  ```
  Runtime parser: Dockerized Node node:24-alpine
  ```

- **Isolation**: the helper container runs with `--network none`, no
  added capabilities (`--cap-drop ALL`), `--security-opt
  no-new-privileges`, a read-only root filesystem, and as the same
  uid/gid as the invoking shell rather than root. **It is never given
  access to the Docker socket** — it cannot start, stop, or inspect any
  container itself; every real `docker` command stays on the host, in
  `scripts/release-remote.sh`.
- **Input handling**: the Node script and every data file it needs
  (captured container/image JSON, the mounts list) are bind-mounted
  into the container read-only, each under its own path, and passed to
  the script as plain file-path arguments. Nothing is inlined into the
  `docker run` command line itself, so none of that captured
  content — which can include environment values — ever appears in
  `argv`, `ps` output, or shell history.
- **Temporary files**: every file this involves (the Node scripts
  themselves, captured JSON, argument/summary output) is created with
  `mktemp` and `chmod 600`, and removed by a `trap`-based cleanup on
  exit — success or failure.

A third script also runs through this same helper: determining the
**expected** migration versions/names from source, for the migration
verification step. It locates each `apps/api/src/migrations/NNN_*.ts`
file's own `export const ...: Migration = { ... }` object header and
reads `version`/`name` only from within that slice (up to the file's
`up(` function) — never from a whole-file text match. This matters
because some migration files also contain an unrelated, unquoted
`name: string;` field (part of a local row-typing `interface`, not the
migration's own name) that a naive `grep '^\s*name:'` would match first
and silently pass through unchanged.

## Existing-image retry policy

`scripts/release-remote.sh` refuses, during pre-flight, to build an
image tag that already exists — this is unconditional and has no
override:

```
ERROR: API image tag already exists, refusing to overwrite: deployment-platform-api:1.2.1
```

If a previous attempt already built (and possibly deployed and rolled
back) `deployment-platform-api:1.2.1` / `deployment-platform-web:1.1.2`,
a retry must target the **next** patch versions instead of reusing
those tags — even if the previous attempt's containers are no longer
live:

```bash
./release.sh --resume-release <release-dir> --api-version 1.2.2 --web-version 1.1.3 --yes
```

This is deliberately the simple, safe option: it never risks silently
overwriting a tag that might still be referenced by a preserved rollback
container, and it costs nothing (patch version bumps are free on this
project).

## What is automated

- Verifying the repo/branch, scanning for secret-like files, running the
  build and API test suite.
- Detecting whether the API, the web app, or both changed, and whether
  there's a releasable change at all.
- Building a safe, explicit list of files to stage (never `git add -A`).
- Committing locally (this script **never runs `git push`**).
- Syncing committed source into a fresh, immutable release directory on
  the VPS.
- Building Docker image(s), backing up the SQLite database with
  `VACUUM INTO`, swapping containers while preserving their runtime
  configuration (see below) under a rollback name, and re-attaching the
  correct Docker networks.
- Verifying the new container's image, network attachments, applied
  database migrations, and the presence/shape of
  `CREDENTIAL_ENCRYPTION_KEY` — without ever printing its value.
- Checking that all three public URLs return HTTP 200.
- Automatically rolling back to the preserved container(s) if any of the
  above verification steps fails.
- Advancing the VPS `current` source pointer atomically, as the last
  required step before reporting success (see "Current source pointer
  update" above) — never before every other verification has passed,
  and never rolling back an already-verified deployment if only this
  bookkeeping step fails (`PASS_WITH_WARNINGS` instead).

## What still requires your confirmation

- The exact set of files about to be staged, and the commit message.
- The proposed API/web image versions, immediately before any Docker
  build or container swap happens.

Nothing is committed, synced, or deployed without an explicit `y` at
these two prompts (or `--message`/`--api-version`/`--web-version` for
the values they cover — those still don't skip the confirmation
prompts themselves).

## Preserved container runtime configuration

Before replacing a container, `scripts/release-remote.sh` inspects the
**currently running** container and reproduces, on the replacement:

- restart policy (always — this is the one setting that is never
  skipped, even if everything else is empty),
- entrypoint and command — see "Entrypoint and command handling" below,
- working directory and user,
- published port bindings and exposed ports without a binding,
- resource limits: memory, memory swap, CPU quota, CPU period, CPU
  shares, `--cpus` (from `NanoCpus`), and pids limit,
- security options and a read-only root filesystem flag,
- mounts, including tmpfs mounts,
- stop signal and stop timeout,
- healthcheck configuration (`CMD-SHELL` or explicitly disabled forms),
- labels,
- DNS servers and extra hosts, and
- hostname — but only when it was explicitly set (i.e., it differs from
  Docker's own auto-assigned short container ID).

It deliberately never reproduces the container ID, IP address, MAC
address, runtime-generated network aliases, container state, PID, log
path, or the old container's name — none of that is configuration, and
carrying any of it forward would be meaningless or actively wrong on a
brand-new container.

### Entrypoint and command handling

The replacement container's command is decided by comparing the
**currently running container's** effective entrypoint/cmd against the
defaults baked into the image it was actually built from:

- If they're identical, nothing was ever overridden at the container
  level — the replacement is created with no override, so the **new**
  image's own `ENTRYPOINT`/`CMD` take effect. The transcript shows
  `command mode: default`.
- If they differ, an operator explicitly overrode the command when this
  container was created — that exact override is reproduced on the
  replacement. The transcript shows `command mode: override`.

In "default" mode, the newly built image is required to define an
`ENTRYPOINT` or a `CMD` (or both) — the script refuses, before touching
the live container, to create a replacement that would have neither.

### When it refuses instead of guessing

`scripts/release-remote.sh` fails **before stopping the live
container**, printing exactly which setting it can't reproduce, when:

- an entrypoint override has more than one element (Docker's
  `--entrypoint` flag can only carry a single value — a multi-word
  override on the *original* container isn't something the CLI can
  recreate on the replacement),
- the newly built image defines neither `ENTRYPOINT` nor `CMD` and the
  container doesn't override either (nothing would ever run), or
- the container's healthcheck uses the exec form (`["CMD", ...]`) rather
  than `CMD-SHELL` or `NONE` — only those two are representable via
  `docker create` flags.

None of these refusals stop or modify anything that was already
running — they happen during the capture-and-validate phase, which
completes in full for every component in the release *before* any
container is stopped.

## Rollback behavior

Before touching a live container, the remote script captures and
validates everything it will need for the replacement — mounts, the
environment file, and the full runtime-configuration comparison above —
for *every* component in the release. Only once all of that has
succeeded does it rename the current container(s) to
`<container>-rollback-<previous-version>-<timestamp>` and create the
replacement(s).

The final status is always exactly one of five values, and
`release.sh` displays whichever one the remote script actually reported
— it never collapses two of these into one label:

- **`PASS`** — the deployment succeeded, was fully verified, and the
  `current` source pointer was updated.
- **`PASS_WITH_WARNINGS`** — the deployment itself succeeded and is
  live and fully verified (containers, migrations, encryption key,
  public URLs), but a non-critical post-success step — currently, only
  the `current` source pointer update — did not complete. The live
  containers are **not** rolled back for this; `release.sh` treats it as
  a success (exit code `0`) and prints the warning and the manual fix
  command.
- **`FAILED`** — something failed during pre-flight, image build,
  database backup, or runtime configuration capture/validation, all of
  which happen **before any container is touched**. Both original
  containers (in a combined API+web release) are simply left running,
  untouched.
- **`ROLLED_BACK`** — a failure happened **after** a container had
  already been renamed away — a missing startup log line, a wrong
  image, a missing network, a failed migration check, a bad
  `CREDENTIAL_ENCRYPTION_KEY`, or a failed public URL check — and the
  previous container(s) were successfully restored. In a combined
  release, both the API and web original containers are restored, not
  just the one that failed.
- **`ROLLBACK_FAILED`** — a swap had begun (as above), automatic
  rollback was attempted, but restoring the previous container did
  **not** fully succeed (it could not be renamed back, could not be
  restarted, or came back up not running). Treat this as an active
  incident: do not assume either the API or the web container is
  healthy, and check the VPS by hand immediately.

The remote script guards against ever rolling back a deployment that has
already fully succeeded: it only sets an internal "deployment complete"
flag, and disarms its own automatic-rollback trap, immediately before
printing `PASS`/`PASS_WITH_WARNINGS` — after the current source pointer
update above, which is itself the last required step. Any error trapped
before that point still triggers the automatic rollback described below;
nothing after it can.

When an unexpected failure does trigger the automatic rollback, the
transcript now includes the specific stage, source line, and exit code,
for example:

```
===== AUTOMATIC ROLLBACK =====
Reason: An unexpected command failure occurred during deployment.
Failure stage: CONTAINER SWAP
Failure line: 842
Exit code: 1
```

This never includes environment values, auth-file contents, encryption
keys, tokens, or captured Docker environment file contents — only the
stage name (from the same `===== SECTION =====` headers already printed
throughout the run), the failing line number, and the exit code.

On rollback, the script:

- stops and removes only the newly created replacement container(s),
- renames the preserved container(s) back to their original names and
  restarts them, printing a clear warning line if any individual rename,
  stop, or restart step itself fails,
- verifies they're running again,
- leaves the newly built Docker image(s) in place for you to inspect,
- leaves the database backup in place,
- leaves the release's source directory in place,
- prints a prominent `AUTOMATIC ROLLBACK` section, and
- exits with a non-zero status.

**Rollback containers, database backups, and release directories are
never removed automatically — by this script, ever.** They accumulate
on the VPS across releases until you clean them up by hand once you're
confident you no longer need them:

```bash
ssh -i /Users/kevinpoulos/.ssh/hetzner_deployment kevin@94.130.73.188 \
  docker ps -a --filter "name=-rollback-"
```

Temporary files created *during* a run (captured env files, captured
`docker inspect` JSON, the runtime-config argument list) live under
`/tmp` on the VPS and are always removed on exit — success or failure —
by a `trap`-based cleanup. That cleanup never touches rollback
containers, database backups, or release directories; those are a
deliberate, permanent record, not scratch space.

Inspect a preserved rollback container directly with
`docker logs`/`docker inspect` against its rollback name before removing
it.

## Secret handling

- The script never prints GitHub tokens, encryption keys, the contents
  of `auth.env`, or a captured container's environment file.
- The API container's captured environment file is written with `chmod
  600` to a `mktemp`-generated path and removed on exit, success or
  failure.
- `CREDENTIAL_ENCRYPTION_KEY` is merged in from the external auth file
  by line-matching, never by printing or logging either file.
- Container logs printed during verification are filtered to drop any
  line containing (case-insensitively) `token`, `authorization`,
  `password`, `secret`, `encryption key`, `encrypted payload`, or
  `cookie`.
- `release.config` (if you create one) is excluded from the rsync
  upload and cannot itself hold secrets — see `release.config.example`.

## Recovering from a failed deployment

1. Read the `AUTOMATIC ROLLBACK` and `RELEASE COMPLETE` sections of the
   transcript — they name the exact rollback container(s), the database
   backup path, and the release directory.
2. Confirm the live container is the restored one and is healthy:
   `docker ps` should show it under its original name, `Up`.
3. The newly built (bad) image and the release's source directory are
   still on the VPS — use `docker logs <rollback-container-name>` and
   the new image directly (`docker run --rm -it <repo>:<version> sh`,
   etc.) to debug without touching the live container again.
4. Fix the underlying issue locally, then run `./release.sh` again — it
   will compute the next patch version on top of the version that just
   failed (the failed tag is never reused), and will sync into yet
   another fresh release directory.
5. The database backup taken before the swap is left in place inside
   the API data volume, under `/data/backups/`, for manual recovery if
   you ever need to restore it — this script never restores a database
   automatically.

## Why `generate-auth.sh` is excluded

`generate-auth.sh` is permanently excluded from every candidate file
list, every `git add`, and every `rsync` upload — unconditionally, with
no flag to override it, and it never counts toward "is there anything to
release." It generates/handles authentication material, and this release
tooling is intentionally not the place that decides whether that belongs
in a commit. If you actually intend to change or commit it, do that
yourself, deliberately, outside this script.

## This script does not push

The first version of `release.sh` commits locally and stops there — it
never runs `git push`, to any remote, under any flag. Pushing (if and
when you want it) is a separate, deliberate step you run yourself.
