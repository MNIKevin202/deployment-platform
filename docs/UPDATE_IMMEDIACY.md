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

### Blast radius of `bootstrap-production.sh --apply`

`--apply` is explicitly non-destructive to containers: it takes a verified DB
backup, provisions the host updater runtime dirs, installs the updater assets
(`resolve-update.mjs`, `release-remote.sh`, trusted keys), the updater command,
and the scheduler (timer + oneshot service + **the socket bridge**), seeds the
update channel/policy (merged, existing settings preserved), and runs a
`--check-only` probe. It does **not** recreate/stop/restart any container
(platform or managed app), change Docker config, networking, or volumes, or
touch your applications. The only systemd restarts are of the updater *timer*
and *socket* units — not containers. It is idempotent.

Because it does not recreate the API container, bootstrap by itself does not add
the `/run/deployment-platform` mount to the **running** API container either — it
refreshes the host so the **next** image update injects that mount.

### Minimal, scoped enablement (socket bridge only)

To enable **only** the socket bridge (no updater reprovisioning, no settings
changes), use the narrow, idempotent script — it installs the 3 systemd files +
tmpfiles rule and nothing else, and reports whether the container mount is
present:

```bash
cd /opt/deployment-platform && sudo git pull
sudo bash scripts/enable-update-bridge.sh --check   # inspect only, changes nothing
sudo bash scripts/enable-update-bridge.sh --apply   # install the socket bridge (no container touched)
```

The two halves of the bridge and their blast radius:
- **Socket units** — zero impact: no container is touched; only the root-owned
  socket (mode 0660; connecting runs exactly one updater tick, no payload, no
  arbitrary command) is enabled.
- **API container mount** (`/run/deployment-platform`) — needed for the API to
  reach the socket. Added only at container-create time, so a running API
  container gets it when recreated. If `enable-update-bridge.sh` reports the
  mount is already present, the bridge works immediately after installing the
  units. If not, the next signed image update injects it (then every later
  "Update now" is immediate); `bootstrap --apply` refreshes the host so that
  injection is reliable. **Managed app containers are never recreated or
  restarted by any of this.**

Rollback: `systemctl disable --now deployment-platform-update-trigger.socket; rm -f /etc/systemd/system/deployment-platform-update-trigger.socket /etc/systemd/system/deployment-platform-update-trigger@.service /etc/tmpfiles.d/deployment-platform-update.conf; systemctl daemon-reload`.

Automatic scheduled checks remain as the fallback; manual check and manual apply
operate independently of that schedule. No continuous aggressive polling was added.
