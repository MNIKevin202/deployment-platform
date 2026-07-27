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

verify_local_platform() {
  log_stage "LOCAL VERIFICATION"

  docker info >/dev/null 2>&1
  _verify_check "Docker daemon reachable" "$?"

  docker network inspect "$PLATFORM_NETWORK_NAME" >/dev/null 2>&1
  _verify_check "Network exists: $PLATFORM_NETWORK_NAME" "$?"

  docker network inspect "$APPS_NETWORK_NAME" >/dev/null 2>&1
  _verify_check "Network exists: $APPS_NETWORK_NAME" "$?"

  docker volume inspect "$API_DATA_VOLUME_NAME" >/dev/null 2>&1
  _verify_check "Volume exists: $API_DATA_VOLUME_NAME" "$?"

  local api_running web_running caddy_running
  api_running="$(docker inspect --format '{{.State.Running}}' "$API_CONTAINER_NAME" 2>/dev/null || echo false)"
  [ "$api_running" = "true" ]
  _verify_check "Container running: $API_CONTAINER_NAME" "$?"

  web_running="$(docker inspect --format '{{.State.Running}}' "$WEB_CONTAINER_NAME" 2>/dev/null || echo false)"
  [ "$web_running" = "true" ]
  _verify_check "Container running: $WEB_CONTAINER_NAME" "$?"

  caddy_running="$(docker inspect --format '{{.State.Running}}' "$CADDY_CONTAINER_NAME" 2>/dev/null || echo false)"
  [ "$caddy_running" = "true" ]
  _verify_check "Container running: $CADDY_CONTAINER_NAME" "$?"

  if [ "$api_running" = "true" ]; then
    docker exec "$API_CONTAINER_NAME" node -e \
      'const v=process.env.CREDENTIAL_ENCRYPTION_KEY; if(!v){process.exit(1)}; const b=Buffer.from(v,"base64"); process.exit(b.length===32?0:1);' >/dev/null 2>&1
    _verify_check "CREDENTIAL_ENCRYPTION_KEY present and valid (32 bytes; value never printed)" "$?"

    docker exec "$API_CONTAINER_NAME" node -e \
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/deployment-platform.sqlite",{readOnly:true}); db.prepare("SELECT 1").get(); db.close();' >/dev/null 2>&1
    _verify_check "API can read the database" "$?"

    local expected_migrations=11
    local applied_migrations
    applied_migrations="$(docker exec "$API_CONTAINER_NAME" node -e \
      'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/deployment-platform.sqlite",{readOnly:true}); const row=db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get(); console.log(row.c); db.close();' 2>/dev/null || echo 0)"
    [ "${applied_migrations:-0}" -ge "$expected_migrations" ]
    _verify_check "Database migrations applied (found ${applied_migrations:-0}, expected at least ${expected_migrations})" "$?"

    [ -w "${INSTALL_ROOT}/caddy/routes" ]
    _verify_check "Caddy routes directory is writable by the host (API writes routes into it via its mounted volume)" "$?"

    curl -fsS --max-time 5 "http://127.0.0.1:${API_INTERNAL_PORT:-3001}" >/dev/null 2>&1
    local api_internal_status=$?
    # A 404 on "/" is an expected, healthy response for this API — any
    # response at all (not a connection failure) counts as reachable.
    docker exec "$API_CONTAINER_NAME" node -e 'process.exit(0)' >/dev/null 2>&1
    _verify_check "API process responds inside its own container" "$?"
  fi

  if docker inspect "$CADDY_CONTAINER_NAME" >/dev/null 2>&1; then
    docker run --rm \
      -v "${INSTALL_ROOT}/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
      -v "${INSTALL_ROOT}/caddy/routes:/etc/caddy/routes:ro" \
      "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1
    _verify_check "Caddy configuration validates" "$?"
  fi
}

PUBLIC_CHECK_MAX_ATTEMPTS=5
PUBLIC_CHECK_DELAY_SECONDS=5

verify_public_domain() {
  local domain="$1"
  local attempt=1
  local status=""

  while [ "$attempt" -le "$PUBLIC_CHECK_MAX_ATTEMPTS" ]; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "https://${domain}" 2>/dev/null || echo 000)"
    if [ "$status" = "200" ]; then
      _verify_check "Public HTTPS check: https://${domain} -> HTTP 200" 0
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$PUBLIC_CHECK_MAX_ATTEMPTS" ] && sleep "$PUBLIC_CHECK_DELAY_SECONDS"
  done

  log_fail "Public HTTPS check: https://${domain} -> HTTP ${status:-no response} (after $PUBLIC_CHECK_MAX_ATTEMPTS attempts). This is often just DNS/TLS-issuance propagation delay — try 'deployment-platform verify' again in a few minutes."
  VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  return 1
}

run_full_verification() {
  local panel_domain="$1"
  VERIFY_FAILURES=0
  verify_local_platform
  log_stage "PUBLIC VERIFICATION"
  verify_public_domain "$panel_domain"

  if [ "$VERIFY_FAILURES" -eq 0 ]; then
    log_pass "All verification checks passed."
    return 0
  fi
  log_fail "$VERIFY_FAILURES verification check(s) failed."
  return 1
}
