#!/usr/bin/env bash
#
# uninstall.sh — safe uninstall / uninstall-preview (section 22).
# Default behavior is conservative: it removes what this installer is
# solely responsible for (its own containers, unused networks, images
# it built, its own Caddy config, its own source releases) and
# preserves everything that represents operator data (the database and
# its volume, secrets, app containers, app volumes) unless the operator
# passes an explicit, narrowly-scoped destructive flag.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "uninstall.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

PURGE_CONFIRMATION_PHRASE="DELETE EVERYTHING"

describe_uninstall_plan() {
  local delete_platform_data="$1"
  local delete_app_containers="$2"
  local delete_app_volumes="$3"
  local delete_secrets="$4"

  echo "The following will be REMOVED:"
  echo "  - Containers: $API_CONTAINER_NAME, $WEB_CONTAINER_NAME, $CADDY_CONTAINER_NAME"
  echo "  - Networks (only if no other containers are attached): $PLATFORM_NETWORK_NAME, $APPS_NETWORK_NAME"
  echo "  - Images built by this installer (tag prefix: bootstrap-*)"
  echo "  - Caddy configuration: ${INSTALL_ROOT}/caddy/Caddyfile and ${INSTALL_ROOT}/caddy/routes/*"
  echo "  - Source release directories under ${INSTALL_ROOT}/source/releases/"
  echo
  echo "The following will be PRESERVED unless an explicit destructive flag is given:"
  echo "  - Database volume: $API_DATA_VOLUME_NAME $( [ "$delete_platform_data" -eq 1 ] && echo "-> WILL BE DELETED (--delete-platform-data)" )"
  echo "  - Deployed app containers $( [ "$delete_app_containers" -eq 1 ] && echo "-> WILL BE DELETED (--delete-app-containers)" )"
  echo "  - Deployed app volumes $( [ "$delete_app_volumes" -eq 1 ] && echo "-> WILL BE DELETED (--delete-app-volumes)" )"
  echo "  - Secrets (${INSTALL_ROOT}/config/) $( [ "$delete_secrets" -eq 1 ] && echo "-> WILL BE DELETED (--delete-secrets)" )"
  echo "  - Database backups (${INSTALL_ROOT}/backups/) — never deleted by this uninstaller, remove manually if truly intended"
}

uninstall_preview() {
  log_stage "UNINSTALL PREVIEW (no changes made)"
  describe_uninstall_plan "${OPT_DELETE_PLATFORM_DATA:-0}" "${OPT_DELETE_APP_CONTAINERS:-0}" "${OPT_DELETE_APP_VOLUMES:-0}" "${OPT_DELETE_SECRETS:-0}"
}

_remove_container_if_exists() {
  local name="$1"
  if docker inspect "$name" >/dev/null 2>&1; then
    docker rm -f "$name" >/dev/null 2>&1 && log_pass "Removed container: $name" || log_warn "Could not remove container: $name"
  fi
}

_remove_network_if_unused() {
  local name="$1"
  if ! docker network inspect "$name" >/dev/null 2>&1; then
    return 0
  fi
  local attached
  attached="$(docker network inspect "$name" --format '{{ len .Containers }}' 2>/dev/null || echo 1)"
  if [ "${attached:-1}" -eq 0 ]; then
    docker network rm "$name" >/dev/null 2>&1 && log_pass "Removed unused network: $name"
  else
    log_warn "Network $name still has $attached container(s) attached (likely deployed apps) — left in place."
  fi
}

run_uninstall() {
  local purge_all="${OPT_PURGE_ALL:-0}"
  local delete_platform_data="${OPT_DELETE_PLATFORM_DATA:-0}"
  local delete_app_containers="${OPT_DELETE_APP_CONTAINERS:-0}"
  local delete_app_volumes="${OPT_DELETE_APP_VOLUMES:-0}"
  local delete_secrets="${OPT_DELETE_SECRETS:-0}"

  if [ "$purge_all" -eq 1 ]; then
    delete_platform_data=1
    delete_app_containers=1
    delete_app_volumes=1
    delete_secrets=1
  fi

  log_stage "UNINSTALL"
  describe_uninstall_plan "$delete_platform_data" "$delete_app_containers" "$delete_app_volumes" "$delete_secrets"
  echo

  if [ "$purge_all" -eq 1 ]; then
    if [ "${NON_INTERACTIVE:-0}" -eq 1 ]; then
      if [ "${OPT_CONFIRM_PURGE:-0}" -ne 1 ]; then
        fatal "--purge-all in non-interactive mode also requires --confirm-purge. Nothing was changed."
      fi
    else
      echo "This will permanently delete the database, all app data, and all secrets."
      printf 'Type "%s" to confirm: ' "$PURGE_CONFIRMATION_PHRASE"
      local typed=""
      read -r typed || typed=""
      if [ "$typed" != "$PURGE_CONFIRMATION_PHRASE" ]; then
        fatal "Confirmation phrase did not match. Nothing was changed."
      fi
    fi
  elif ! confirm_yes_no "Proceed with uninstall as described above?"; then
    log_info "Uninstall cancelled. Nothing was changed."
    exit 0
  fi

  _remove_container_if_exists "$CADDY_CONTAINER_NAME"
  _remove_container_if_exists "$WEB_CONTAINER_NAME"
  _remove_container_if_exists "$API_CONTAINER_NAME"

  if [ "$delete_app_containers" -eq 1 ]; then
    log_warn "Removing app containers on the managed-apps network (--delete-app-containers)."
    local ids
    ids="$(docker ps -aq --filter "network=${APPS_NETWORK_NAME}" 2>/dev/null || true)"
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086
      docker rm -f $ids >/dev/null 2>&1 || true
    fi
  fi

  _remove_network_if_unused "$PLATFORM_NETWORK_NAME"
  _remove_network_if_unused "$APPS_NETWORK_NAME"

  local image_id
  for image_id in $(docker images "${API_IMAGE_REPO}:bootstrap-*" -q 2>/dev/null || true) $(docker images "${WEB_IMAGE_REPO}:bootstrap-*" -q 2>/dev/null || true); do
    docker rmi "$image_id" >/dev/null 2>&1 || true
  done
  log_pass "Removed installer-built images (bootstrap-* tags)."

  rm -f "${INSTALL_ROOT}/caddy/Caddyfile"
  rm -rf "${INSTALL_ROOT}/caddy/routes"/*.caddy 2>/dev/null || true
  rm -rf "${INSTALL_ROOT}/source/releases"/*
  rm -f "${INSTALL_ROOT}/source/current"
  log_pass "Removed Caddy configuration and source release directories."

  if [ "$delete_platform_data" -eq 1 ]; then
    docker volume rm "$API_DATA_VOLUME_NAME" >/dev/null 2>&1 && log_pass "Deleted database volume: $API_DATA_VOLUME_NAME (--delete-platform-data)"
  else
    log_pass "Preserved database volume: $API_DATA_VOLUME_NAME"
  fi

  if [ "$delete_app_volumes" -eq 1 ]; then
    log_warn "Deleting app-managed Docker volumes (--delete-app-volumes) — this is destructive and cannot be undone."
    local vol
    for vol in $(docker volume ls -q --filter "label=com.deployment-platform.managed=true" 2>/dev/null || true); do
      docker volume rm "$vol" >/dev/null 2>&1 || true
    done
  fi

  if [ "$delete_secrets" -eq 1 ]; then
    rm -f "${INSTALL_ROOT}/config/auth.env"
    log_warn "Deleted secrets (--delete-secrets). Any stored provider credentials encrypted with the old CREDENTIAL_ENCRYPTION_KEY are now permanently unreadable."
  else
    log_pass "Preserved secrets: ${INSTALL_ROOT}/config/auth.env"
  fi

  log_pass "Database backups under ${INSTALL_ROOT}/backups/ were never touched."
  log_pass "Uninstall complete."
}
