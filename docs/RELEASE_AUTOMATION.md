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
   into ChatGPT for review, and — only on success — points the VPS
   `current` source pointer at the new release directory.

The whole run produces a single, continuous, copy-pasteable transcript
with `===== SECTION =====` headers. No color codes are used, so the
output survives being pasted into anything.

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

If the computed release scope touches neither `apps/api/` nor
`apps/web/` (a docs or tooling-only change), `release.sh`:

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
- Advancing the VPS `current` source pointer only after a verified
  success.

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

This means:

- A failure during pre-flight, image build, database backup, or runtime
  configuration capture/validation happens **before any container is
  touched** — the final status is `FAILED`, and both original containers
  (in a combined API+web release) are simply left running untouched.
- A failure **after** a container has been renamed away — a missing
  startup log line, a wrong image, a missing network, a failed migration
  check, a bad `CREDENTIAL_ENCRYPTION_KEY`, or a failed public URL check
  — triggers automatic rollback and the final status is `ROLLED_BACK`.
  In a combined release, both the API and web original containers are
  restored, not just the one that failed.

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
