# ClovaForge Migration & Disaster Recovery — Design

Status: **Phase 0 (foundation) and Phase 1 (export) implemented and released in ClovaForge 1.10.0.** Phases 2+ are
design only and require explicit approval before they begin.

Companion documents:

- [MIGRATION_BUNDLE_FORMAT.md](MIGRATION_BUNDLE_FORMAT.md) — the on-disk bundle
  format, the encryption and key-management model, and the integrity vs
  authenticity distinction. **Read this before touching bundle code.**
- [SELF_UPDATE_ARCHITECTURE.md](SELF_UPDATE_ARCHITECTURE.md) — the updater whose
  host-side/durable-state pattern migration deliberately copies.

## 1. Goals and non-goals

ClovaForge needs one reusable, production-quality way to move state between
servers. It must not be hardcoded to any hosting provider. There are two
user-facing workflows, and **they share one engine**:

| Workflow | Scope | Typical use |
|---|---|---|
| **Migrate Entire Server** | `platform` | Move the whole installation to a new VPS; disaster recovery |
| **Migrate to Another Server** (per-app) | `application` | Move or copy one app, plus what it depends on, to another ClovaForge server |

Non-goals for the foundation: cross-architecture image conversion, merging two
platform databases, and live (zero-downtime) replication of arbitrary databases.
Where an application cannot be moved with a guarantee, the system **says so**
instead of guessing.

### Hard requirements (from the project owner)

1. The **entire bundle is encrypted by default** — databases, volumes, images,
   configuration and secrets alike. Not just the secrets directory.
2. **Stopping a container is not proof of an application-consistent backup.**
   Consistency is a graded, evidence-based classification (§5).
3. Imports are **resumable and idempotent**, with explicit protection against
   overwriting existing application data or creating duplicate resources (§7).
4. **Integrity and authenticity are different properties** and are reported
   separately (see the format document).
5. All development and tests use **synthetic applications and test data**.
   No production server is accessed or modified.
6. Phase 0 and every `preflight` thereafter are **read-only** and never alter
   running services (§8).

## 2. Existing architecture this builds on

| Existing piece | Role in migration |
|---|---|
| `services/backup-service.ts` — `VACUUM INTO` snapshot, validated staging, atomic swap | Pattern for the consistent DB snapshot and the "stage, validate, then swap" restore. It is DB-only and excludes the encryption key, which is why it cannot move an installation. |
| `update-trigger-bridge.ts` + admin-written request rows | Pattern for UI → privileged host action: connect-only socket, no payload, authorization lives in a verifiable DB row. Migration gets its own sibling bridge (Phase 5). |
| Updater state machine + durable state file mirrored to the DB | Pattern for the migration **journal** (checkpoints, crash reconciliation). |
| `docker.ts` (dockerode on the host socket) | The only way app state (containers, volumes, local images) is reached. |
| `app_volumes`, `app_deployments.image_tag`, `app_sources`, `app_environment_variables`, `cron_jobs`, `app_published_ports` | Together these are the complete inventory of what an app needs. |
| `crypto-service.ts` (AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`) | Provider credentials are encrypted with a **per-installation** key. App-scope migration must therefore **re-wrap** credentials for the destination key (§6.3). |

Findings that shape the design:

- Nothing reconciles apps to Docker on startup; restored apps come back *down*
  with *empty* volumes unless data and containers are brought across explicitly.
- Managed apps are arbitrary images. There is no first-party database template,
  so "application-consistent" cannot mean one hardcoded dump command.
- Internal-only apps (e.g. a Postgres) are reached by sibling apps over Docker DNS
  on the shared `deployment-apps` network by **container name**. That reference
  lives in environment variable values and is the dependency signal (§6.2).
- The platform database stores some secrets in plaintext columns (e.g.
  `database_connections.connection_string`, `app_environment_variables.value`).
  The **bundle** is therefore the protection boundary: it is always encrypted.

## 3. Architecture

```
          ┌──────────────── UI wizard (Phase 7) ───────────────┐
          │  App wizard            Server wizard                │
          └───────────────┬───────────────────┬─────────────────┘
                          │  (same job model, same components)
                 ┌────────▼───────────────────▼────────┐
                 │  API: migration-service / routes     │  starts jobs, reads state
                 └────────┬─────────────────────────────┘  never moves volumes itself
        narrow bridge     │  (connect-only; authorization = verifiable DB row)
                 ┌────────▼─────────────────────────────┐
                 │  Host-side engine (privileged)        │
                 │  snapshot • transfer • validate •     │
                 │  import • journal • rollback          │
                 └────────┬─────────────────────────────┘
        ┌─────────────────┴──────────────────┐
   scope: platform                     scope: application
```

**Why one engine.** Both workflows are "select subjects → snapshot them
consistently → seal into an encrypted, verifiable bundle → move it → validate →
import idempotently → hand over ownership → roll back if needed". They differ
only in *which subjects are selected* and *which ownership rules apply*. The
manifest carries a `scope`, the engine takes a *subject set*, and ownership
rules are a separate small state machine (§6.4).

**Why host-side.** The platform cannot safely stop itself, swap its own
database, or stream large volumes from inside its own container. The updater
solved this by running host-side; migration does the same. The API layer only
starts jobs and reports status.

## 4. Shared infrastructure (what every workflow reuses)

| Component | Responsibility | Phase |
|---|---|---|
| Bundle format & crypto | Streamed, chunked AEAD encryption of every artifact; wrapped bundle key; optional origin signature | **0** |
| Manifest | Scope-aware inventory, hashes, versions, consistency evidence, accepted risks, ownership/transfer metadata | **0** |
| Verification report | One schema for preflight, bundle verification, import verification | **0** |
| Consistency model | Graded levels + evidence + policy | **0** |
| Dependency & side-effect analysis | What an app needs, what needs it, what could fire twice | **0** |
| Ownership state machine | Which server owns the live app; move vs copy rules | **0** (types + pure transitions) |
| Import plan & journal model | Idempotent steps, conflict detection, resume | **0** (model + planner) |
| Snapshot engine | Per-subject quiesce, hook execution, evidence capture | 1 |
| Export writer | Streams artifacts into a sealed bundle | 1 |
| Import executor | Applies a plan with checkpoints and rollback | 2 |
| Peer transport | Server pairing, direct encrypted streaming, resumable | 4 |
| Incremental sync | Delta transfer for a live move | 5 |

## 5. Application consistency

`stop` alone is **not** evidence. Consistency is classified, never assumed:

| Level | Meaning | Reached by |
|---|---|---|
| `application-consistent` | The application's own tooling vouches for the data | A **verified** logical dump, a verified clean-shutdown marker, a passed application integrity check, or a verified application-native snapshot |
| `crash-consistent` | State is what the app would see after power loss | Freeze/pause snapshot, or a stop that ended in a kill/OOM |
| `quiesced-unverified` | App was stopped cleanly, but nothing verified the data | `stop` + clean exit with no application-level evidence |
| `inconsistent` | Copied while writable with no quiesce | `live` |
| `not-applicable` | No persistent state | — |

`quiesced-unverified` is deliberately a **separate, weaker** level so a report
can never read "consistent" because a container was merely stopped.

**Data profiles.** From metadata only (image name, mount paths, env var *names*)
the preflight classifies each app as `postgres`, `mysql`, `mariadb`, `mongodb`,
`redis`, `unknown-stateful`, or `stateless`. It never reads volume contents in
Phase 0. A profile carries the evidence an application-consistent export needs
(for example `pg_dump` + verification, or a verified clean `pg_controldata`
state).

**Policy.** For a *rehearsal* export, any level is allowed and recorded. For a
*cutover-grade* export, a database or `unknown-stateful` app below
`application-consistent` is **blocked unless the operator explicitly accepts the
risk for that app**. The acceptance is recorded in the manifest, so the verification
report always states what was and was not proven.

## 6. Application-level migration

### 6.1 Operations

| | **Copy** | **Move** |
|---|---|---|
| Source app after completion | Stays live and unchanged | **Fenced**, then retired (retained for the rollback window) |
| Destination app | A **dormant copy**: schedulers, cron, auto-deploy and webhooks disabled; public domain not routed unless the operator chooses one | Becomes the live app only at commit |
| Identity | New lineage | Same lineage; ownership epoch increments |
| Rollback | Delete the copy | Unfence the source; discard the destination standby |

### 6.2 Dependencies and side effects (analysed read-only in Phase 0)

For the selected app the analysis reports:

- **Uses** — other managed apps referenced from this app's environment values
  (container name / Docker DNS name). Handling: *must move together* or
  *reconfigure*.
- **Used by** — other apps that reference this one. Moving it away breaks them
  unless they move too or are reconfigured.
- **Global environment** inherited by the app, and the database-connection
  registry entries pushed into it.
- **Credentials** — a GitHub source needs the provider credential on the
  destination.
- **Published host ports** and **domains** — must be free on the destination;
  two servers must never serve the same domain at once.
- **Side-effect inventory** — enabled cron jobs, auto-deploy, health-check
  notifications, retained version history. These are the things that could fire on
  **both** servers and are therefore disabled on any non-owner copy.

Values are scanned in memory to detect references. **Values never appear in
reports**; evidence names only the variable key and the referenced app.

### 6.3 Credentials and keys at app scope

An existing destination server has its own `CREDENTIAL_ENCRYPTION_KEY`, which must
not be replaced. App-scope migration therefore does **not** transfer the key. The
credentials an app needs are decrypted with the source key in memory, carried
inside the encrypted bundle, and **re-encrypted with the destination's key** on
import. The operator may instead choose to re-authenticate on the destination.
(At platform scope the whole key is carried, because the destination is being
*replaced*, not merged.)

### 6.4 Ownership and fencing

Every migratable subject has one ownership record:

`{ subject, ownerServerId, epoch, state }` where state is one of
`live`, `frozen-for-migration`, `standby`, `dormant-copy`, `retired-after-move`.

Rules enforced by a pure state machine (`ownership.ts`):

- Only `live` serves traffic and runs schedulers.
- A move fences the source (`live → frozen-for-migration`) **before** the final
  snapshot, so no write can occur after the snapshot is taken.
- The destination may only go `standby → live` for a move once it presents the
  source's fence receipt for the matching `migrationId` and `epoch`.
- The invariant "a moved subject is never `live` on both servers" is checkable
  and is tested.
- Rollback is only possible while the source is still `frozen-for-migration`
  (before commit); after commit the source is `retired-after-move`.

The UI always shows **which server currently owns the live application**, derived
from this record, never inferred.

### 6.5 Live-move protocol

1. **Preflight** (read-only): compatibility, resources, dependencies, side effects.
2. **Initial transfer (seed):** a rehearsal-grade snapshot is taken while the source
   keeps running. It is allowed to be `crash-consistent` or `inconsistent` *because
   it is never promoted* — it only reduces the final delta.
3. **Validate on destination:** import into an isolated, dormant state; smoke start on
   an isolated network with schedulers, cron and outbound-triggering features off.
4. **Choose:** a controlled maintenance window (single final pass), or a short
   final synchronisation (delta since the seed).
5. **Cutover:** fence the source → final consistent snapshot (cutover-grade policy
   applies) → import delta → verify → `standby → live` with the fence receipt → switch
   routing/DNS.
6. **Rollback window:** the source stays `frozen-for-migration`; `rollback` unfences it
   and discards the destination standby. **Commit** retires the source.

### 6.6 Status model

One job model for both scopes: `phase`, `progress`, `verification results`,
`actionable errors` (stable code + plain-language remedy), and `owner`. The wizard
is a *view over this durable job*; closing the browser tab does not stop or lose a
migration, and a job can be resumed.

## 7. Idempotent, resumable import

(Model and planner implemented in Phase 0; executor in Phase 2.)

- Every step has a **deterministic id** derived from the bundle and artifact
  (`volume:<artifactId>`), so replays hit the same step.
- Every resource the importer creates is **labelled** with the migration id and the
  artifact digest. Ownership of a resource is therefore *provable*, never guessed from
  its name.
- The planner computes, per step: `create` · `already-applied` · `resume` ·
  `conflict`. A **conflict** is any pre-existing resource that is not provably ours
  (no matching labels, or a different digest). Conflicts are **never overwritten**;
  the resolutions offered are *rename*, *abort*, or (later, explicit, typed
  confirmation, with an automatic backup) *replace*.
- A resource that *is* provably ours but incomplete (never reached `done` in the
  journal) is safe to wipe and redo, because it was never live.
- The journal records `pending | in-progress | done | failed` per step plus attempt
  count, and the reducer that decides the next actions is a pure function.
- Container creation checks name/label first, so a retry cannot create a duplicate.

## 8. Read-only guarantee for preflight

Preflight and `describe` must not alter running services. This is enforced three ways:

1. **API surface:** the Docker probe interface exposes only read operations
   (`ping/info`, `inspect`, `list`, `df`). There is no method that starts, stops,
   creates, removes, execs or pulls.
2. **Database:** opened with `readOnly: true` and `PRAGMA query_only`; migrations are
   never run against the source (the normal application opener *does* run them, so it
   is deliberately not used).
3. **Tests:** a recording fake asserts only read calls were made; a database file
   hash is compared before and after; and a static scan fails the build if a mutating
   verb appears in the preflight modules.

One honest caveat: any SQLite reader of a WAL database touches the shared-memory
index file (`-shm`). That is normal multi-reader behaviour and changes no data page,
but it is the only filesystem effect a preflight can have.

## 9. Implementation phases

| Phase | Deliverable | Status |
|---|---|---|
| **0** | Format & crypto library; scope-aware manifest; verification report; consistency, dependency and ownership models; import planner and journal model; read-only preflight (platform + application scope) and destination descriptor; host `deployment-platform migrate preflight / describe / verify-bundle`; docs; tests | **Done — approved, released in 1.10.0** |
| 1 | Snapshot engine + `migrate export` (platform and application scope), hook runner with evidence capture, source signing key management | **Done — released in 1.10.0** (§13); verified on native Linux (1797 API tests, 760 installer tests) and against a real Docker engine (12 integration tests) |
| 2 | `migrate import` executor: journal on disk, checkpoints, rollback, labelled resources, schema replay | Not started |
| 3 | Reconcile-on-start; isolated smoke-start verification; full round-trip tests | Not started |
| 4 | Peer pairing + direct encrypted server-to-server transport (resumable) | Not started |
| 5 | App-level engine: copy/move, ownership/fencing, seed + final sync, cutover, rollback | Not started |
| 6 | Platform cutover protocol: source fence, cutover token, `MIGRATED-TO` marker | Not started |
| 7 | UI: shared wizard framework, **Migrate to Another Server** (app menu) and **Migrate Entire Server** | Not started |
| 8 | Hardening: scheduled DR exports, retention, hook presets, large-volume tuning | Not started |

Phases are gated: **none begins without explicit approval.**

## 10. Wizard design (Phase 7 — design only)

A real wizard is a *state machine over a durable server-side job*, not buttons that
shell out. Common shell: stepper, persistent job banner ("Live on: this server"),
resumable from any step, every step has a read-only review before anything acts.

**Migrate to Another Server** (entry: app page and the three-dot menu)

1. **Operation** — Copy or Move, with a plain statement of what each leaves behind.
2. **Destination** — choose a paired server, or pair a new one (shows its fingerprint
   for out-of-band confirmation).
3. **Compatibility** — versions, architecture, free disk/RAM, port and domain
   conflicts; blockers are actionable ("free 14 GB", "choose another domain").
4. **Dependencies** — the §6.2 analysis as a checklist: *move together*, *reconfigure*,
   *acknowledge*. A move cannot proceed with unresolved blockers.
5. **Data safety** — per-volume consistency strategy, with each database-looking
   volume called out and the evidence it will produce; risk acceptance is explicit.
6. **Strategy** — maintenance window vs live seed + final sync, with a downtime
   estimate.
7. **Review** — one screen: what moves, what is disabled on the copy, what will be
   fenced, what rollback looks like.
8. **Seed → Validate** — live progress; verification results with remedies.
9. **Cutover** — explicit, typed confirmation; shows the fence being applied.
10. **Done / Rollback window** — which server owns the app, commit or roll back.

**Migrate Entire Server** uses the same shell and steps 2, 3, 5, 7, 8, 9, 10 with
platform-scope content, and adds the DNS checklist and the source-fence step.

The UI contains no migration logic; it renders the verification report and job state
the engine produces.

## 11. Testing strategy

- Everything runs on **synthetic apps and test data**; no network, no production host.
- Crypto: round-trip across chunk boundaries, tamper/truncate/reorder/replay,
  wrong key/passphrase, header substitution.
- Bundle: integrity vs authenticity as independent outcomes, signer pinning,
  stripped-signature handling.
- Preflight: real schema (the real migrations run into a temp database), fake Docker
  probe, read-only proofs, secret-redaction proof.
- Planner/ownership: conflict handling, resume, the no-double-live invariant.

## 12. Phase 0 — what exists now

Nothing in Phase 0 changes the running platform: `server.ts` does not import the migration
module, no route was added, no schema migration was added, and no container or volume is
touched. The module is compiled into the API image and is reachable only through the CLI.

### 12.1 Commands (all read-only)

```bash
sudo deployment-platform migrate describe                      # this server, as JSON
sudo deployment-platform migrate preflight                     # whole-server readiness (source)
sudo deployment-platform migrate preflight --scope application --app web --operation move \
     --with db,worker --destination-descriptor dest.json --output-dir /var/backups
sudo deployment-platform migrate preflight --role destination \
     --bundle ./bundle --passphrase-file ./pass --expect-signer sha256:… --deep
sudo deployment-platform migrate verify-bundle --bundle ./bundle --passphrase-file ./pass --deep
```

`export` and `import` print "not available yet" and make no docker calls. The passphrase is
read only from a mode-600 file; passing it as an argument is refused before anything reaches
`docker`.

### 12.2 Code map (`apps/api/src/migration/`)

| File | Responsibility |
|---|---|
| `crypto.ts`, `passphrase.ts` | scrypt KEK, key slots, per-artifact HKDF keys, chunked AES-256-GCM stream |
| `signing.ts` | Ed25519 manifest signature, fingerprints, pinning helpers |
| `manifest.ts` | Strict scope-aware manifest schema, compatibility rules |
| `bundle.ts` | Bundle writer/reader and `verifyBundle` (integrity and authenticity reported separately) |
| `consistency.ts` | Consistency levels, evidence, data profiles, cutover policy |
| `dependencies.ts` | Uses / used-by / side-effect analysis for application scope |
| `ownership.ts` | Live / frozen / standby / dormant / retired state machine, fence receipts |
| `destination.ts` | Destination descriptor, requirements, conflict detection, evaluation |
| `import-plan.ts` | Idempotent plan (`create` / `already-applied` / `resume` / `conflict`) and journal reducer |
| `inventory.ts`, `probes.ts` | The only data access: read-only SQLite and a query-only Docker client |
| `preflight.ts`, `report.ts` | Source and destination preflight; the shared verification report |
| `cli.ts` | Argument handling, exit codes, injectable environment |
| `installer/lib/migrate.sh` | Host launcher (disposable, network-less, read-only container) |

### 12.3 How the requirements are met

| Requirement | Where it is enforced |
|---|---|
| Whole bundle encrypted by default | There is no unencrypted writer: `BundleWriter` always encrypts every artifact and the manifest. A test asserts no plaintext, app name, volume name or secret marker is recoverable from any file in a bundle. |
| A stop is not proof of consistency | `classifyConsistency`: no strategy and no process-level evidence can yield `application-consistent`; a clean stop is `quiesced-unverified`. Preflight reports this for every database-looking or unknown stateful app. A cutover policy blocks it unless application-level evidence exists or the risk is explicitly accepted; a live copy can never be accepted. |
| Resumable, idempotent, no overwrite | `planImport` + journal reducer. Ownership is proven by labels, never names. A simulated crash at every step boundary resumes without redoing finished work. |
| Integrity ≠ authenticity | Reported as two separate results. Tests cover valid-origin + damaged-data and intact-data + no-origin. Unpinned signatures are explicitly reported as not establishing origin; stripped signatures fail when a signer is pinned. |
| Synthetic data only | Fixtures build a real SQLite schema from the real migrations and use a recording fake Docker client. |
| Preflight is read-only | Type-narrowed Docker client, `readOnly` + `query_only` SQLite handle, a static guard test, recorded-call tests, database-file hash tests, and launcher tests that assert the exact set of `docker` subcommands used. Each guard was mutation-tested (an injected `stop` / `DELETE` / `docker stop` fails the suite). |

### 12.4 Known limitations and trade-offs (Phase 0)

- **Availability.** The tooling ships in the API image. Releases published before this work do not
  contain it, so the launcher reports "this release does not include the migration tooling yet".
  It can be run against an older installation only by pointing `DP_MIGRATE_IMAGE` at an image
  built from this code, which starts a short-lived container on that host — a step that needs
  explicit approval and has **not** been taken anywhere.
- **Metadata only.** Preflight never reads volume contents, so consistency classification relies
  on image names, mount paths and env var *names*. An app that keeps SQLite files in a volume
  shows as `unknown-stateful`, which is the conservative answer.
- **Sizes** come from Docker's disk-usage report, which can be slow on hosts with many volumes and
  can be unavailable; the report then says sizes are approximate.
- **Launcher trust boundary.** The disposable container mounts the Docker socket, exactly as the
  API container does. It has no network, a read-only filesystem and no capabilities, and the code
  is limited by type to query calls — but the socket is root-equivalent, so the image it runs is
  the trust boundary. The data volume is mounted read-write because the database uses WAL mode: a
  read-only SQLite handle still maintains the shared-memory index (`-shm`) file. That is the only
  filesystem effect; no data page is written.
- **Import is not implemented**, so a destination always reports "cannot import yet" as a warning.
- **Descriptor trust.** A destination descriptor is validated strictly but is self-reported by the
  destination; in Phase 4 it will be fetched over the authenticated, pinned peer link.
- **Platform scope vs `server.ts`.** Reconcile-on-start (so restored apps come up without a manual
  redeploy) is Phase 3 and is the first change that will touch the running server.

## 13. Phase 1 — export

Phase 1 adds `migrate export`, `migrate recover` and `migrate signing-key`. It still changes no
installation state: `server.ts` is untouched, no route or schema migration was added, and nothing
is imported, restored, replaced or handed over. An export READS the installation and writes one new
encrypted bundle directory. The one thing it may do to a running app is stop or pause it for a
consistent snapshot, and it always undoes that.

### 13.1 Pipeline

```
 preflight (Phase 0, read-only)  ──blocked──►  stop; nothing touched
        │
 plan (pure) ── refusals ──────────────────►  stop; nothing touched
        │       strategy per app, cutover policy, dependencies, unexported data,
        │       quiesce windows (dependents first), disk estimate
        ▼
 recover any earlier interrupted export  →  refuse if another export is alive
        ▼
 non-disruptive artifacts: app definitions · DB snapshot · config · routes · images ·
                           verified dumps · live copies
        ▼
 quiesce windows:  journal ▸ stop/pause ▸ stream volumes ▸ gather evidence ▸ gate ▸ restore
        ▼
 finalize (encrypted manifest, optional signature) → deep verification → clear journal
```

Every stage streams: a volume is `Docker archive → gzip → AES-GCM → file` with backpressure, never
held in memory and never staged as a full-size copy. Peak memory and peak on-disk size are asserted
in tests (a 320 MiB volume exports with bounded memory and no intermediate file).

### 13.2 Consistency, and what counts as evidence

The levels and the rule that **a stop proves nothing** are as in §5. What Phase 1 adds is the actual
evidence gathering:

| Route | Evidence recorded | Level |
|---|---|---|
| **Verified dump** of a running database (`hook`) | `logical-dump-verified`: the tool exited 0, produced a plausible number of bytes, **and** its own completion marker is at the end of the stream (a truncated dump would lack it) | `application-consistent` |
| **Stop + `pg_controldata`** (PostgreSQL) | `clean-shutdown-marker-verified`: run from the app's own image, read-only, against the stopped data directory; must report exactly "shut down" | `application-consistent` |
| Stop, clean exit, nothing else | `clean-exit` (process-level only) | `quiesced-unverified` |
| Stop that was killed / OOM / unknown | `forced-kill` | `crash-consistent` |
| Pause (cgroup freezer) | `frozen` | `crash-consistent` |
| Live copy | none | `inconsistent` |

Built-in hooks exist **only** where a verifiable completion marker exists: PostgreSQL (`pg_dumpall`),
MySQL and MariaDB (`--single-transaction`, InnoDB). MongoDB, Redis and anything unrecognised have no
preset on purpose. An operator supplies a hook (`--hooks-file`) which must state how its output is
verified: a trailer regular expression, or an explicit `exitStatusOnly` that is then recorded in the
evidence text exactly as such.

The **cutover policy** is enforced twice: by the planner before anything is touched, and again at run
time against the evidence actually obtained (a PostgreSQL stop whose `pg_controldata` does not say
"shut down" is not claimed consistent; the gate aborts and the app is restored). A database or unknown
stateful app below `application-consistent` is refused unless the operator records
`--accept-risk NAME=LEVEL`, which is written into the manifest. A live copy is never acceptable.

### 13.3 Failure handling: an export never leaves an app disrupted

1. **Journal first.** Before any app is stopped or paused, an entry is written durably (temp file →
   fsync → rename) to a journal on the host. If the process dies at any point, the journal already says
   what may be disrupted. Writes are serialized and a closed journal cannot be recreated.
2. **Restore in `finally`.** Each quiesce window restores its apps in reverse order (dependencies
   first) as soon as its volumes are read, and **verifies** each is running (it does not trust a
   successful `start` call). An app is therefore down only for its own window; a test asserts this.
3. **One failure path.** Any error, cancellation, timeout or full disk funnels into one handler that
   restores everything, disposes helper containers, deletes the half-written bundle (only the directory
   this run created, fenced to the output directory) and reports whether restoration succeeded.
4. **Bounds.** An app is never held down longer than `--max-disruption-minutes`; the output disk is
   watched and the export aborts *before* it fills; Ctrl-C / SIGTERM abort the export, which then
   restores everything.
5. **After a hard kill.** `migrate recover` (and the start of the next export, automatically) reads the
   journal, restores whatever it lists, removes the provably unfinished bundle and helper containers.
   The launcher also runs it itself when the export container ends abnormally. A journal with a recent
   heartbeat is never recovered out from under a live export.
6. **Loud failure.** If an app cannot be restored the exit code is 5, the apps are named, and the journal
   is kept.

### 13.4 Dependencies, shared services and unexported data

Application scope reuses Phase 0's analysis: unresolved dependencies refuse a copy or move (a plain
backup only warns); apps migrating together are quiesced in **dependency order** in one window (or one
window each with `--quiesce sequential`); external databases are called out. Data the export **cannot**
carry is never dropped silently: bind mounts, Docker volumes ClovaForge has no record of, and a GitHub
App installation are listed in the app's definition artifact and in the report, and a cutover refuses
unless `--allow-unexported` says otherwise.

### 13.5 How it is tested (all synthetic)

| Suite | What it proves |
|---|---|
| Fault sweeps | A failure injected at **every** Docker call and **every** export step, and a cancellation at every one, leaves every app running, no helper container, no partial bundle and no journal |
| Hard kill | A real `SIGKILL` of an exporter mid-snapshot with an app stopped; a different process recovers from the on-disk journal alone |
| Targeted faults | Refused stop, failed helper creation, stream dying mid-volume, hung read (deadline), disk filling, unverifiable dumps (non-zero exit / no marker / empty / truncated), restore failing then `recover` fixing it, concurrent exports |
| Real Docker client | The dockerode client over HTTP against a fake engine: exec upgrade handshake, multiplexed frames, 304 handling, read-only never-started helpers |
| Streaming | Bounded memory and no staging copy for large volumes; bit-for-bit round trip |
| Separation | Static checks that export code cannot create volumes/networks, load images, write into containers, open the database writable, or touch import/ownership code |
| Launcher | Mount layout (config and routes read-only), refusals, exit-code passthrough, automatic recovery after an abnormal exit |

Each guard above was mutation-tested (disable the safety → a test fails). That process also found and
fixed real defects in the implementation (a journal write race that could resurrect a deleted journal,
a helper-container leak after a failed removal, a result computed after the journal was deleted).

### 13.6 Known limitations (Phase 1)

- **No real Docker daemon was available** where this was built, so the Docker client is verified against
  a protocol-faithful fake engine, not a live one. Behaviours that only a real daemon exhibits (e.g. how
  long `docker stop` really takes, `pg_dumpall` against a real PostgreSQL) are NOT exercised.
- **Linux-only behaviours** (file-mode checks, symlink handling) are covered by tests that run on POSIX
  and are skipped on Windows.
- **Recovery needs the host state directory** (`/opt/deployment-platform/state/migration`). Losing it
  after a hard kill loses the record of what was stopped; `migrate preflight` would still show the app
  as not running.
- **A dump of an app with several volumes** is only offered when the hook covers every volume.
- **Credentials at application scope are carried decrypted inside the encrypted bundle** (to be
  re-encrypted with the destination's key). The passphrase is therefore the single secret protecting them.
- **Compression** is gzip-then-encrypt for volumes, dumps, the database and config; images are not
  recompressed.
- **Import is still not implemented.** A bundle can be created and verified but not restored.
