# CLOVA_TEST_INSTRUCTIONS

Reboot-triggered test briefing. On the next reboot, exercise the **Docker
embedded-DNS re-registration fix** for GitHub deployment promotion/rollback.

## Why this exists

On Docker 29 / Ubuntu 24.04, `docker rename` does **not** reliably update a
user-defined bridge network's embedded DNS (`127.0.0.11`). After ClovaForge
renamed a candidate container to the canonical `app-<name>`, Caddy's lookup of
that hostname either failed —

    dial tcp: lookup app-<name> on 127.0.0.11:53: server misbehaving

— or resolved to the **wrong IP** (observed: Caddy's own `deployment-apps`
address, e.g. `172.23.0.2`, instead of the app's `172.23.0.5`). The public
route then returned HTTP 502 and the deploy rolled back; rollback hit the same
hazard because it renames the previous container back to the canonical name.

## The fix under test (code)

- `apps/api/src/services/redeploy-service.ts` — `refreshNetworkEndpoint(id, net)`
  disconnects + reconnects a container BY ID on a network (no EndpointConfig),
  forcing Docker to rebuild its DNSNames.
- `apps/api/src/services/github-deploy-service.ts` — after the promotion rename
  (and the rollback rename), it refreshes the endpoint, re-reads the container's
  actual `deployment-apps` IP, then runs a **bounded DNS readiness loop** that
  requires the canonical hostname to resolve (from the API's own
  `deployment-apps` context — the same embedded DNS Caddy uses) to that **exact
  IP**. The public route check runs only after readiness passes. A readiness
  failure is reported as a specific *"Docker network/DNS readiness failure"*,
  not a generic 502.

## Briefing steps (run against a real GitHub-linked app, e.g. `yumbot`)

1. **Candidate deployment** — trigger a GitHub deploy; confirm the candidate
   starts under its temporary name and passes the internal port check.
2. **Promotion to canonical identity** — confirm the candidate is renamed to
   `app-<name>`.
3. **Endpoint re-registration** — in `docker logs deployment-platform-api`,
   confirm a `"Refreshing managed-network endpoint after rename"` log line for
   the promoted container ID on network `deployment-apps`.
4. **Caddy-side DNS resolution** — confirm `"Deploy DNS readiness attempt"`
   logs, each showing `resolvedIps` and `matches`.
5. **Resolved IP exactly matches promoted app's `deployment-apps` IP** —
   `docker inspect app-<name>` → `NetworkSettings.Networks["deployment-apps"].IPAddress`
   equals the `expectedIp` in the readiness log, and readiness ends `matches:true`.
6. **Hostname never resolves to Caddy's own IP** — from a `deployment-apps`
   peer: `getent hosts app-<name>` (or `nslookup`) must return the app IP, never
   `deployment-platform-caddy`'s IP. If it ever returns Caddy's IP, the deploy
   MUST fail readiness (not pass), reported as a Docker DNS readiness failure.
7. **Successful public route verification** — the deploy reaches
   `updating-route` and succeeds; the public domain returns a non-5xx status.
8. **Rollback restoration** — force a failing deploy (e.g. a build/health
   failure) and confirm the previous container is renamed back and restored.
9. **Restored hostname resolves to restored container's exact IP** — confirm a
   rollback `"Refreshing managed-network endpoint after rename"` log for the
   restored container ID, and the `github-deploy-rolled-back` event metadata has
   `rollbackDnsReady: true`.
10. **No recurrence** of: `lookup app-<name> on 127.0.0.11:53: server misbehaving`.
11. **No HTTP 502** caused by Docker DNS during the promotion window.

## Guardrails to verify (must remain true)

- Only the **promoted/restored app container** is ever disconnected/reconnected
  — never `deployment-platform-caddy`, `deployment-platform-api`, the rollback
  container, or any unrelated container.
- Only the `deployment-apps` network is touched; other attachments are intact.
- `app-<name>` is only ever the app container's hostname — never a Caddy alias.
- Caddy is **not** restarted as part of this fix (no ACME/cert churn).

## Automated coverage (already added)

- `apps/api/src/tests/github-deploy-rollback.test.ts` — promotion endpoint
  refresh (exact ID), wrong-IP rejection (public route never attempted),
  transient-retry, permanent-failure diagnostic, rollback endpoint refresh + IP
  validation.
- `apps/api/src/tests/redeploy-docker-ops.test.ts` — `refreshNetworkEndpoint`
  disconnect→connect ordering, by ID, with no copied EndpointConfig.
