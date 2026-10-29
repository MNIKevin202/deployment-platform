# Update discovery & installation — immediacy

Investigation + fixes for the "~15 minutes before a new release is applied" delay.

## Where the delay actually comes from

Three separate stages, investigated independently:

1. **Discovery (Check for Updates)** — `/platform/updates/check` → `runCheck()` →
   `fetchAndVerifyManifest()` fetches the channel pointer fresh on every click and
   overwrites the status cache. It never served a stale *application* result.
   The only residual risk was **HTTP/CDN caching** of the pointer file.
   → **Fixed**: the default manifest/signature fetch now sends `cache: "no-store"`
   + `Cache-Control: no-cache, no-store` / `Pragma: no-cache`, so no intermediary
   serves a cached copy. (No query-param cache-buster: the default pointer host is
   GitHub release downloads, which can 404 on unexpected query strings; replacing a
   pointer asset already yields fresh content by object id.)

2. **Install (Update Now / Install Update)** — `/platform/updates/apply` already
   re-verifies at click time, writes the canonical `platform_update_apply_request`
   (trigger: "manual", which the resolver treats as operator-requested and which
   bypasses the policy/window), and **immediately pokes the host update-trigger
   bridge** so the updater runs one tick right now. It does NOT wait for the timer.
   → The ~15-minute wait observed in production is the **fallback path**: when the
   host **update-trigger bridge is unavailable**, `/apply` returns
   `202 { immediateTrigger: false, fallback: "scheduled" }` and the 15-minute timer
   applies the (already-authorized) request. This is a **host-provisioning gap, not
   an app bug** — see below.

3. **Status visibility** — the badge keyed off the installer **state machine**
   (`state.state`), which reports `idle` whenever it isn't actively working, even
   right after discovery finds an update. So it could read **"Up to date"** next to
   a "Latest available X" line and an Update button.
   → **Fixed**: the badge now reconciles the state machine with discovery — while
   checking or mid-install the live state wins; otherwise, if a check found an
   update, it reads **"Update available"**. No more contradictory messaging.

## The install bridge (why immediacy needs a one-time host step)

`/apply` triggers an immediate updater tick by connecting to a root-owned Unix
socket at `/run/deployment-platform/trigger.sock` (see
`update-trigger-bridge.ts`). For that to work the host needs:

- the socket units installed + enabled
  (`deployment-platform-update-trigger.socket` + `@.service` + the tmpfiles rule —
  installed by `installer/lib/scheduler.sh::install_update_trigger_bridge`), and
- the API container started with `-v /run/deployment-platform:/run/deployment-platform`
  (added by `installer/lib/platform.sh`; re-injected by `release-remote.sh` on each
  API recreate).

These are **host assets**, provisioned by the installer/bootstrap — they are NOT
shipped inside the application image, so installing a new app version cannot by
itself enable the bridge on a box where it was never provisioned.

**One-time host enablement** (run once on the server, then every future
"Update Now" is immediate):

```bash
cd /opt/deployment-platform && sudo git pull && sudo bash scripts/bootstrap-production.sh --apply
```

(`--apply` is an idempotent host refresh — no cutover. It installs/enables the
trigger socket bridge and recreates the API container with the socket mount.)

Automatic scheduled checks remain as the fallback; manual check and manual apply
operate independently of that schedule. No continuous aggressive polling was added.
