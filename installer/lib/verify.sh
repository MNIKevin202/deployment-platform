#!/usr/bin/env bash
#
# verify.sh — local and public checks (section 20). Used both at the
# end of a fresh install and by `--verify-only` / `deployment-platform
# verify` against an already-running installation. Never mutates
# anything; every check here is read-only.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "verify.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

VERIFY_FAILURES=0

_verify_check() {
  local description="$1"
  local status="$2"
  if [ "$status" -eq 0 ]; then
    log_pass "$description"
  else
    log_fail "$description"
    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  fi
}

# Runs one read-only probe and records its result. EVERY probe in this
# file goes through here.
#
# This exists because of a real production failure: the old code wrote
# probes as bare simple commands —
#     docker info >/dev/null 2>&1
#     _verify_check "Docker daemon reachable" "$?"
# — which is only safe under `set -e` when the whole verifier happens to
# be called from a condition context (`if run_full_verification ...`).
# The installer's final stage did exactly that, so it passed; but
# `deployment-platform verify` calls the verifier directly, where the
# first probe that legitimately returned nonzero killed the script
# before its `$?` was ever read. Capturing status via `|| status=$?`
# inside a function makes each probe safe regardless of how the caller
# invoked the verifier, which is the actual invariant that was missing.
_verify_probe() {
  local description="$1"
  shift
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  _verify_check "$description" "$status"
}

# HTTP reachability check for the API, executed INSIDE the API
# container.
#
# The API deliberately does not publish port 3001 to the host — it sits
# on a private Docker network behind Caddy — so the previous
# `curl http://127.0.0.1:3001` from the host could only ever fail with
# curl exit 7 (connection refused). That probe was testing something
# the architecture guarantees is unreachable.
#
# Node is already present in the API image, so no extra image or network
# change is needed. Any deliberate HTTP status proves the server is
# listening and serving.
#
# The path is the REAL backend route, /auth/session — NOT /api/auth/session.
# The API registers its routes without an /api prefix; the /api prefix is
# a Caddy-facing concern that handle_path strips before proxying. The
# previous probe asked the container for /api/auth/session, which matches
# no route, so the authentication hook answered 401 — and because 401 was
# on the "healthy" list, a completely mis-routed API was reported as
# passing verification. That is exactly how this defect reached a live
# install with every check green.
#
# Correctness is now judged semantically, not just by status class: an
# unauthenticated GET /auth/session must return HTTP 200 with a JSON body
# whose "authenticated" field is exactly false. Anything else is
# classified and reported distinctly — auth-hook rejection, 404, a
# malformed/unparseable body, or a connectivity failure — rather than
# collapsed into "some response arrived, good enough".
#
# Only the parsed shape is inspected. No cookie, header, or body text is
# ever printed; the diagnostic carries a fixed reason token and at most a
# status code.
API_HEALTH_CHECK_PATH="/auth/session"
API_HEALTH_CHECK_TIMEOUT_MS=5000

# The public path the same endpoint is served on through Caddy. Used by
# the public verification stage to prove the /api prefix is stripped.
API_PUBLIC_HEALTH_CHECK_PATH="/api/auth/session"

# The public login path, used by the end-to-end authentication smoke test.
#
# The smoke test posts DELIBERATELY WRONG credentials. The values below are
# fixed, non-secret placeholders that can never be the operator's real
# credentials, so nothing sensitive reaches argv, logs, or the shell
# history. A successful login is NOT tested here — that would require the
# real password, and the operator confirms it interactively instead.
API_PUBLIC_LOGIN_PATH="/api/auth/login"
API_LOGIN_SMOKE_USERNAME="installer-verification-not-a-real-user"
API_LOGIN_SMOKE_PASSWORD="installer-verification-not-a-real-password"

# Bounded, secret-free reason for the last probe attempt. Set by
# verify_api_http_responds and logged only on failure.
API_HTTP_CHECK_DETAIL=""

# Configuration arrives through NAMED ENVIRONMENT VARIABLES, never
# positional arguments.
#
# With `node -e <script> a b c`, process.argv is
# [nodePath, "a", "b", "c"] — there is NO script-name element, so argv[1]
# is the first passed argument, not argv[2]. The previous version read
# argv[2]/argv[3]/argv[4], which made port = "/api/auth/session"
# (Number(...) -> NaN) and timeout = undefined; the request could never
# connect and the probe failed on a perfectly healthy API. Environment
# variables remove that off-by-one class of bug entirely.
_api_http_check_script() {
  cat <<'NODE_EOF'
const http = require("node:http");

const port = Number(process.env.DP_VERIFY_PORT);
const path = process.env.DP_VERIFY_PATH;
const timeoutMs = Number(process.env.DP_VERIFY_TIMEOUT_MS);

if (
  !Number.isInteger(port) || port <= 0 ||
  typeof path !== "string" || path.length === 0 ||
  !Number.isInteger(timeoutMs) || timeoutMs <= 0
) {
  process.stdout.write("reason=bad-probe-configuration");
  process.exit(1);
}

const request = http.request(
  { host: "127.0.0.1", port: port, path: path, method: "GET", timeout: timeoutMs },
  (response) => {
    const code = response.statusCode;

    if (!Number.isInteger(code)) {
      response.resume();
      process.stdout.write("reason=malformed-http-status");
      process.exit(1);
    }

    // The body is read ONLY to confirm the session shape. It is parsed
    // in-process and never printed; an unauthenticated session body
    // contains no secret, and an authenticated one is never produced by
    // this unauthenticated probe.
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      // Bounded: a healthy body is a few dozen bytes. Anything larger is
      // not the endpoint we are looking for.
      if (body.length < 4096) { body += chunk; }
    });
    response.on("end", () => {
      if (code === 404) {
        process.stdout.write("reason=route-not-found status=404 path-not-registered");
        process.exit(1);
      }
      if (code === 401 || code === 403) {
        // The authentication hook answered instead of the session
        // handler. /auth/session is a public route, so this means the
        // request never reached it — the classic mis-routing signature.
        process.stdout.write("reason=auth-hook-rejected status=" + code);
        process.exit(1);
      }
      if (code !== 200) {
        process.stdout.write("reason=unexpected-http-status status=" + code);
        process.exit(1);
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        process.stdout.write("reason=malformed-json-body status=200");
        process.exit(1);
      }

      if (parsed === null || typeof parsed !== "object") {
        process.stdout.write("reason=unexpected-json-shape status=200");
        process.exit(1);
      }
      if (parsed.authenticated !== false) {
        // Either the field is missing (not the session endpoint) or it is
        // true (an unauthenticated probe must never be authenticated).
        process.stdout.write("reason=unexpected-session-state status=200");
        process.exit(1);
      }

      process.stdout.write("reason=unauthenticated-session status=200");
      process.exit(0);
    });
  }
);

request.on("timeout", () => {
  request.destroy();
  process.stdout.write("reason=timeout after-ms=" + timeoutMs);
  process.exit(1);
});

// Only the error CODE (ECONNREFUSED, EHOSTUNREACH, ...) is reported —
// never the message, which could echo back request details.
request.on("error", (error) => {
  const code = error && error.code ? error.code : "unknown";
  process.stdout.write("reason=connection-error code=" + code);
  process.exit(1);
});

request.end();
NODE_EOF
}

verify_api_http_responds() {
  API_HTTP_CHECK_DETAIL=""
  local output=""
  local status=0

  # 2>&1 is captured rather than discarded so a docker-level failure
  # (container gone, exec denied) still yields a usable reason. The
  # result is truncated to one short line before it is ever logged.
  output="$(docker exec \
    -e "DP_VERIFY_PORT=${API_INTERNAL_PORT:-3001}" \
    -e "DP_VERIFY_PATH=${API_HEALTH_CHECK_PATH}" \
    -e "DP_VERIFY_TIMEOUT_MS=${API_HEALTH_CHECK_TIMEOUT_MS}" \
    "$API_CONTAINER_NAME" \
    node -e "$(_api_http_check_script)" 2>&1)" || status=$?

  API_HTTP_CHECK_DETAIL="$(printf '%s' "$output" | tr -d '\r' | head -n 1 | cut -c1-200)"
  if [ -z "$API_HTTP_CHECK_DETAIL" ] && [ "$status" -ne 0 ]; then
    API_HTTP_CHECK_DETAIL="reason=docker-exec-failed exit=${status}"
  fi

  return "$status"
}

verify_local_platform() {
  log_stage "LOCAL VERIFICATION"

  _verify_probe "Docker daemon reachable" docker info
  _verify_probe "Network exists: $PLATFORM_NETWORK_NAME" docker network inspect "$PLATFORM_NETWORK_NAME"
  _verify_probe "Network exists: $APPS_NETWORK_NAME" docker network inspect "$APPS_NETWORK_NAME"
  _verify_probe "Volume exists: $API_DATA_VOLUME_NAME" docker volume inspect "$API_DATA_VOLUME_NAME"

  local api_running web_running caddy_running
  api_running="$(docker inspect --format '{{.State.Running}}' "$API_CONTAINER_NAME" 2>/dev/null || echo false)"
  _verify_probe "Container running: $API_CONTAINER_NAME" test "$api_running" = "true"

  web_running="$(docker inspect --format '{{.State.Running}}' "$WEB_CONTAINER_NAME" 2>/dev/null || echo false)"
  _verify_probe "Container running: $WEB_CONTAINER_NAME" test "$web_running" = "true"

  caddy_running="$(docker inspect --format '{{.State.Running}}' "$CADDY_CONTAINER_NAME" 2>/dev/null || echo false)"
  _verify_probe "Container running: $CADDY_CONTAINER_NAME" test "$caddy_running" = "true"

  if [ "$api_running" = "true" ]; then
    _verify_probe "CREDENTIAL_ENCRYPTION_KEY present and valid (32 bytes; value never printed)" \
      docker exec "$API_CONTAINER_NAME" node -e \
      'const v=process.env.CREDENTIAL_ENCRYPTION_KEY; if(!v){process.exit(1)}; const b=Buffer.from(v,"base64"); process.exit(b.length===32?0:1);'

    _verify_probe "API can read the database" \
      docker exec "$API_CONTAINER_NAME" node -e \
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/deployment-platform.sqlite",{readOnly:true}); db.prepare("SELECT 1").get(); db.close();'

    local expected_migrations=11
    local applied_migrations
    applied_migrations="$(docker exec "$API_CONTAINER_NAME" node -e \
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/deployment-platform.sqlite",{readOnly:true}); const row=db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get(); console.log(row.c); db.close();' 2>/dev/null || echo 0)"
    case "${applied_migrations:-0}" in
      ''|*[!0-9]*) applied_migrations=0 ;;
    esac
    _verify_probe "Database migrations applied (found ${applied_migrations}, expected at least ${expected_migrations})" \
      test "$applied_migrations" -ge "$expected_migrations"

    _verify_probe "Caddy routes directory is writable by the host (API writes routes into it via its mounted volume)" \
      test -w "${INSTALL_ROOT}/caddy/routes"

    # Not via _verify_probe: this probe carries a diagnostic that must be
    # surfaced on failure instead of being swallowed with the output.
    local api_http_status=0
    verify_api_http_responds || api_http_status=$?
    _verify_check "API serves its real backend route inside the container (GET ${API_HEALTH_CHECK_PATH} -> 200 {\"authenticated\":false})" \
      "$api_http_status"
    if [ "$api_http_status" -ne 0 ]; then
      log_fail "  API probe detail: ${API_HTTP_CHECK_DETAIL:-no diagnostic captured}"
      log_fail "  The API is private by design (port ${API_INTERNAL_PORT:-3001} is not published to the host); this check runs inside the container. Inspect with: docker logs ${API_CONTAINER_NAME}"
    fi
  fi

  local caddy_exists=0
  docker inspect "$CADDY_CONTAINER_NAME" >/dev/null 2>&1 || caddy_exists=$?
  if [ "$caddy_exists" -eq 0 ]; then
    _verify_probe "Caddy configuration validates" \
      docker run --rm \
      -v "${INSTALL_ROOT}/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
      -v "${INSTALL_ROOT}/caddy/routes:/etc/caddy/routes:ro" \
      "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile
  fi

  # Always 0: individual results live in VERIFY_FAILURES, so this
  # function's own status can never be mistaken for a verdict.
  return 0
}

PUBLIC_CHECK_MAX_ATTEMPTS=5
PUBLIC_CHECK_DELAY_SECONDS=5

verify_public_domain() {
  local domain="$1"
  local attempt=1
  local status=""
  local start_epoch
  start_epoch="$(date -u +%s)"
  local elapsed=0

  while [ "$attempt" -le "$PUBLIC_CHECK_MAX_ATTEMPTS" ]; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "https://${domain}" 2>/dev/null || echo 000)"
    if [ "$status" = "200" ]; then
      _verify_check "Public HTTPS check: https://${domain} -> HTTP 200" 0
      return 0
    fi
    elapsed=$(( $(date -u +%s) - start_epoch ))
    # Real attempt/elapsed numbers and the actual HTTP status seen —
    # TLS issuance genuinely takes time after DNS first resolves, and
    # the operator should be able to watch it progressing.
    progress_report_attempt \
      "Waiting for https://${domain} (last status: ${status:-none})" \
      "$attempt" "$PUBLIC_CHECK_MAX_ATTEMPTS" "$elapsed" \
      "$PUBLIC_CHECK_DELAY_SECONDS"
    attempt=$((attempt + 1))
    if [ "$attempt" -le "$PUBLIC_CHECK_MAX_ATTEMPTS" ]; then
      sleep "$PUBLIC_CHECK_DELAY_SECONDS"
    fi
  done

  log_fail "Public HTTPS check: https://${domain} -> HTTP ${status:-no response} (after $PUBLIC_CHECK_MAX_ATTEMPTS attempts). This is often just DNS/TLS-issuance propagation delay — try 'deployment-platform verify' again in a few minutes."
  VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  return 1
}

# Runs every local check, then the public check, then reports. Returns
# a normalized 0 (all checks passed) or 1 (at least one failed) — never
# a raw probe status such as curl's 7 or 22, docker's 125, or grep's 1.
#
# Behaves identically whether called directly (`run_full_verification x`)
# or in a condition (`if run_full_verification x; then`): every probe
# captures its own status, and the two section calls below are explicitly
# guarded so a failing section cannot abort the run under `set -e`
# before the summary is printed.
# Proves the /api prefix contract END TO END through Caddy: the panel
# serves the API under /api/*, while the API itself registers the route
# without that prefix. This is the check that would have caught the
# mis-routing that made login impossible — the container-side probe alone
# cannot see it, because the container is served the already-stripped
# path.
#
# Deliberately asserts the SEMANTIC response, not just "some status
# arrived": an unauthenticated GET must yield 200 with
# "authenticated":false. A 401 here means Caddy forwarded /api intact and
# the request fell through to the authentication hook.
verify_public_api_prefix() {
  local domain="$1"
  local url="https://${domain}${API_PUBLIC_HEALTH_CHECK_PATH}"
  local body="" status="" curl_status=0

  # -w appends the status on its own final line so body and status are
  # separated without a second request.
  body="$(curl -sS --connect-timeout 10 --max-time 20 -w '\n%{http_code}' "$url" 2>/dev/null)" || curl_status=$?

  if [ "$curl_status" -ne 0 ] || [ -z "$body" ]; then
    log_fail "Public API prefix check: ${url} -> no response (curl exit ${curl_status})"
    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
    return 1
  fi

  status="$(printf '%s' "$body" | tail -n 1)"
  local payload
  payload="$(printf '%s' "$body" | sed '$d')"

  case "$status" in
    200) ;;
    401|403)
      log_fail "Public API prefix check: ${url} -> HTTP ${status}. The /api prefix is reaching the API instead of being stripped, so the request hit the authentication hook rather than the session route. Check that the generated Caddyfile uses 'handle_path /api/*', not 'handle /api/*'."
      VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
      return 1
      ;;
    404)
      log_fail "Public API prefix check: ${url} -> HTTP 404 (no route matched after proxying)."
      VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
      return 1
      ;;
    *)
      log_fail "Public API prefix check: ${url} -> HTTP ${status} (expected 200)."
      VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
      return 1
      ;;
  esac

  # Shape check only; the unauthenticated body carries no secret.
  case "$payload" in
    *'"authenticated"'*'false'*)
      _verify_check "Public API prefix check: ${url} -> 200 with an unauthenticated session (the /api prefix is stripped correctly)" 0
      return 0
      ;;
  esac

  log_fail "Public API prefix check: ${url} -> HTTP 200 but the body is not an unauthenticated session response."
  VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  return 1
}

# End-to-end authentication smoke test.
#
# Proves that a login attempt actually reaches the login handler and is
# rejected by it — not by the authentication hook, not by a 404. The
# distinction matters: before the /api prefix fix, every login returned
# 401 "Authentication required" from the hook, which is indistinguishable
# from a rejected login unless the message is inspected.
verify_public_login_rejection() {
  local domain="$1"
  local url="https://${domain}${API_PUBLIC_LOGIN_PATH}"
  local body="" status="" payload="" curl_status=0

  # The credentials are the fixed placeholders defined above, passed on
  # stdin rather than argv so no password-shaped string is ever visible in
  # a process listing — even a deliberately invalid one.
  body="$(printf '{"username":"%s","password":"%s"}' \
    "$API_LOGIN_SMOKE_USERNAME" "$API_LOGIN_SMOKE_PASSWORD" \
    | curl -sS --connect-timeout 10 --max-time 20 \
        -X POST -H 'Content-Type: application/json' \
        --data-binary @- -w '\n%{http_code}' "$url" 2>/dev/null)" || curl_status=$?

  if [ "$curl_status" -ne 0 ] || [ -z "$body" ]; then
    log_fail "Login rejection smoke test: ${url} -> no response (curl exit ${curl_status})"
    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
    return 1
  fi

  status="$(printf '%s' "$body" | tail -n 1)"
  payload="$(printf '%s' "$body" | sed '$d')"

  # 429 still proves the request reached the login route: the rate limit is
  # configured on that route only. Treat it as inconclusive, not a failure,
  # so repeated verification runs do not turn red.
  if [ "$status" = "429" ]; then
    _verify_check "Login rejection smoke test: ${url} -> HTTP 429 (rate limited; the login route was reached, retry in a minute for a full check)" 0
    return 0
  fi

  case "$payload" in
    *'Invalid username or password'*)
      _verify_check "Login rejection smoke test: ${url} -> HTTP ${status} 'Invalid username or password' (the login handler ran and rejected the attempt)" 0
      return 0
      ;;
    *'Authentication required'*)
      log_fail "Login rejection smoke test: ${url} -> HTTP ${status} 'Authentication required'. The request was rejected by the authentication hook before reaching the login handler, which means the /api prefix is not being stripped. Check that the generated Caddyfile uses 'handle_path /api/*', not 'handle /api/*'."
      VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
      return 1
      ;;
  esac

  case "$status" in
    404)
      log_fail "Login rejection smoke test: ${url} -> HTTP 404 (no login route matched after proxying)."
      ;;
    200)
      # Must never happen: the placeholder credentials are not real.
      log_fail "Login rejection smoke test: ${url} -> HTTP 200. A deliberately invalid credential pair was ACCEPTED. Treat this as a security incident and rotate the administrator password."
      ;;
    *)
      log_fail "Login rejection smoke test: ${url} -> HTTP ${status} with an unrecognised response body."
      ;;
  esac
  VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  return 1
}

run_full_verification() {
  local panel_domain="$1"
  if [ -z "$panel_domain" ]; then
    # A missing argument is an installer programming error, not a
    # verification failure — the one case that should still be fatal.
    fatal "run_full_verification requires a panel domain argument (installer bug)."
  fi

  VERIFY_FAILURES=0

  verify_local_platform || true

  log_stage "PUBLIC VERIFICATION"
  verify_public_domain "$panel_domain" || true
  verify_public_api_prefix "$panel_domain" || true
  verify_public_login_rejection "$panel_domain" || true

  if [ "$VERIFY_FAILURES" -eq 0 ]; then
    log_pass "All verification checks passed."
    return 0
  fi
  log_fail "$VERIFY_FAILURES verification check(s) failed."
  return 1
}
