#!/usr/bin/env bash
#
# platform.sh — creates the deployment-platform-api and
# deployment-platform-web containers (section 15). Database
# initialization (section 16) is deliberately NOT done here: the API
# process runs its own migration system on startup (the same
# runMigrations() code path used in every environment) — this
# installer never creates tables or maintains a second schema
# definition in shell. This function only starts the container and
# waits for its own startup log marker, then verify.sh independently
# confirms the applied migration count.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "platform.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

API_CONTAINER_NAME="deployment-platform-api"
WEB_CONTAINER_NAME="deployment-platform-web"

API_STARTUP_MAX_ATTEMPTS=20
API_STARTUP_DELAY_SECONDS=2

# Reports true attempt/elapsed numbers on every poll rather than a
# spinner: the operator wants to know how many attempts remain before
# this gives up, and there is no honest percentage for "has the API
# finished migrating and started listening yet".
wait_for_log_marker() {
  local container="$1"
  local marker="$2"
  local description="$3"
  local attempt=1
  local start_epoch
  start_epoch="$(date -u +%s)"
  local elapsed=0

  while [ "$attempt" -le "$API_STARTUP_MAX_ATTEMPTS" ]; do
    if docker logs "$container" 2>&1 | grep -qiE "$marker"; then
      elapsed=$(( $(date -u +%s) - start_epoch ))
      log_pass "${description} (ready after ${elapsed}s, attempt ${attempt}/${API_STARTUP_MAX_ATTEMPTS})"
      return 0
    fi

    # A container that has already exited will never log the marker —
    # fail immediately instead of burning the full retry budget.
    if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)" != "true" ]; then
      log_fail "${container} is no longer running while waiting for it to start."
      return 1
    fi

    elapsed=$(( $(date -u +%s) - start_epoch ))
    progress_report_attempt "$description" "$attempt" "$API_STARTUP_MAX_ATTEMPTS" "$elapsed" "$API_STARTUP_DELAY_SECONDS"
    attempt=$((attempt + 1))
    [ "$attempt" -le "$API_STARTUP_MAX_ATTEMPTS" ] && sleep "$API_STARTUP_DELAY_SECONDS"
  done
  return 1
}

ensure_api_container() {
  local api_image="$1"
  local panel_domain="$2"
  local apps_domain="$3"

  if docker inspect "$API_CONTAINER_NAME" >/dev/null 2>&1; then
    local running
    running="$(docker inspect --format '{{.State.Running}}' "$API_CONTAINER_NAME" 2>/dev/null || echo false)"
    if [ "$running" = "true" ]; then
      log_pass "Container already running: $API_CONTAINER_NAME — leaving it in place. Use the normal release/upgrade path to change its image."
      return 0
    fi
    log_warn "$API_CONTAINER_NAME exists but is not running — starting it."
    if [ "$DRY_RUN" -ne 1 ]; then
      docker start "$API_CONTAINER_NAME" >/dev/null
    fi
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would create and start $API_CONTAINER_NAME from $api_image, with the Docker socket mounted (required: the API manages other apps' containers on this host), the data volume, and the auth file."
    return 0
  fi

  local platform_env_file="${INSTALL_ROOT}/config/platform.env"
  sed \
    -e "s|__PANEL_DOMAIN__|${panel_domain}|" \
    -e "s|__APPS_DOMAIN__|${apps_domain}|" \
    "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/platform.env.template" > "$platform_env_file"
  chmod 644 "$platform_env_file"

  # DOCKER SOCKET SECURITY NOTE (section 15/27): the API container is
  # granted /var/run/docker.sock because the platform's own core
  # feature is managing OTHER Docker containers on this host (creating,
  # starting, stopping, inspecting, building images for deployed apps).
  # This is equivalent to root on the host — anyone who can execute
  # code inside the API container can control every container and
  # volume on this machine, including this platform's own. This is not
  # broadened by the installer; it matches the architecture the rest of
  # this codebase already assumes (see docker-metrics-service.ts,
  # redeploy-service.ts, github-deploy-service.ts). The web and Caddy
  # containers never receive the socket.
  docker create --name "$API_CONTAINER_NAME" \
    --network "$PLATFORM_NETWORK_NAME" \
    --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${API_DATA_VOLUME_NAME}:/data" \
    -v "${INSTALL_ROOT}/caddy/routes:/app/caddy-routes" \
    --env-file "${INSTALL_ROOT}/config/auth.env" \
    --env-file "$platform_env_file" \
    "$api_image" >/dev/null

  docker network connect "$APPS_NETWORK_NAME" "$API_CONTAINER_NAME" >/dev/null

  docker start "$API_CONTAINER_NAME" >/dev/null

  if ! wait_for_log_marker "$API_CONTAINER_NAME" "listening at" \
    "Waiting for the API to start and apply database migrations"; then
    log_fail "The API container did not report a successful startup in time. Its most recent output:"
    docker logs --tail 30 "$API_CONTAINER_NAME" 2>&1 | log_redact | while IFS= read -r line; do
      _visible_line "  ${line}"
    done
    _visible_line ""
    _visible_line "Full container log:"
    _visible_line "  docker logs ${API_CONTAINER_NAME}"
    _visible_line ""
    fatal "API container did not log a startup message in time."
  fi
  log_pass "API container started: $API_CONTAINER_NAME ($api_image)"
}

ensure_web_container() {
  local web_image="$1"

  if docker inspect "$WEB_CONTAINER_NAME" >/dev/null 2>&1; then
    local running
    running="$(docker inspect --format '{{.State.Running}}' "$WEB_CONTAINER_NAME" 2>/dev/null || echo false)"
    if [ "$running" = "true" ]; then
      log_pass "Container already running: $WEB_CONTAINER_NAME — leaving it in place."
      return 0
    fi
    log_warn "$WEB_CONTAINER_NAME exists but is not running — starting it."
    if [ "$DRY_RUN" -ne 1 ]; then
      docker start "$WEB_CONTAINER_NAME" >/dev/null
    fi
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would create and start $WEB_CONTAINER_NAME from $web_image."
    return 0
  fi

  docker create --name "$WEB_CONTAINER_NAME" \
    --network "$PLATFORM_NETWORK_NAME" \
    --restart unless-stopped \
    "$web_image" >/dev/null

  docker start "$WEB_CONTAINER_NAME" >/dev/null
  log_pass "Web container started: $WEB_CONTAINER_NAME ($web_image)"
}

# Backs up the SQLite database (VACUUM INTO, same technique
# release-remote.sh already uses) via a live API container if one is
# running, otherwise via a throwaway container against the existing
# volume — either way, always before migrations run against an
# existing database (section 16), and available on demand via
# `deployment-platform backup-database` (section 23/25).
backup_database() {
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local backup_path="/data/backups/backup-${timestamp}.sqlite"
  local host_backup_note="${INSTALL_ROOT}/backups/backup-${timestamp}.sqlite.info"

  if ! docker volume inspect "$API_DATA_VOLUME_NAME" >/dev/null 2>&1; then
    log_info "No existing database volume — nothing to back up yet."
    return 0
  fi

  if docker inspect "$API_CONTAINER_NAME" >/dev/null 2>&1 && [ "$(docker inspect --format '{{.State.Running}}' "$API_CONTAINER_NAME" 2>/dev/null)" = "true" ]; then
    if docker exec "$API_CONTAINER_NAME" node -e \
      "const {DatabaseSync}=require('node:sqlite'); const fs=require('fs'); fs.mkdirSync('/data/backups',{recursive:true}); const db=new DatabaseSync('/data/deployment-platform.sqlite',{readOnly:true}); db.exec(\"VACUUM INTO '${backup_path}'\"); db.close();" 2>/dev/null; then
      log_pass "Database backed up to (inside ${API_DATA_VOLUME_NAME}): ${backup_path}"
      printf 'Backup recorded inside the %s volume at %s\n' "$API_DATA_VOLUME_NAME" "$backup_path" > "$host_backup_note" 2>/dev/null || true
      BACKUP_PATH_RESULT="$backup_path"
      return 0
    fi
    log_warn "Live-container backup failed; no existing database file to back up is also a normal reason for this on a first install."
    return 0
  fi

  # No running API container yet (e.g. resuming right after packages
  # were installed but before first start) — use a throwaway container
  # against the same volume instead, never against a fresh empty one.
  if ! docker run --rm -v "${API_DATA_VOLUME_NAME}:/data" node:24-alpine \
    test -f /data/deployment-platform.sqlite >/dev/null 2>&1; then
    log_info "No existing database file found in ${API_DATA_VOLUME_NAME} — nothing to back up yet (first install)."
    return 0
  fi

  if docker run --rm -v "${API_DATA_VOLUME_NAME}:/data" node:24-alpine node -e \
    "const {DatabaseSync}=require('node:sqlite'); const fs=require('fs'); fs.mkdirSync('/data/backups',{recursive:true}); const db=new DatabaseSync('/data/deployment-platform.sqlite',{readOnly:true}); db.exec(\"VACUUM INTO '${backup_path}'\"); db.close();" >/dev/null 2>&1; then
    log_pass "Database backed up to (inside ${API_DATA_VOLUME_NAME}): ${backup_path}"
    BACKUP_PATH_RESULT="$backup_path"
  else
    log_warn "Could not back up the existing database before migrations. Investigate before continuing if this is unexpected."
  fi
}

start_platform() {
  log_stage "PLATFORM STARTUP"
  local api_image="$1"
  local web_image="$2"
  local panel_domain="$3"
  local apps_domain="$4"

  ensure_api_container "$api_image" "$panel_domain" "$apps_domain"
  ensure_web_container "$web_image"
}
