#!/usr/bin/env bash
#
# caddy.sh — renders the main Caddyfile from the template and manages
# the Caddy container (section 14).

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "caddy.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

CADDY_CONTAINER_NAME="deployment-platform-caddy"
CADDY_IMAGE="caddy:2-alpine"
API_INTERNAL_PORT=3001
WEB_INTERNAL_PORT=80

render_caddyfile() {
  local panel_domain="$1"
  local template_file="${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/Caddyfile.template"
  local out_file="${INSTALL_ROOT}/caddy/Caddyfile"

  sed \
    -e "s|__PANEL_DOMAIN__|${panel_domain}|g" \
    -e "s|__API_CONTAINER__|deployment-platform-api|g" \
    -e "s|__API_PORT__|${API_INTERNAL_PORT}|g" \
    -e "s|__WEB_CONTAINER__|deployment-platform-web|g" \
    -e "s|__WEB_PORT__|${WEB_INTERNAL_PORT}|g" \
    "$template_file" > "$out_file"

  chmod 644 "$out_file"
  log_pass "Rendered $out_file"
}

validate_caddyfile() {
  local caddyfile="${INSTALL_ROOT}/caddy/Caddyfile"
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would validate Caddyfile with: docker run --rm -v $caddyfile:/etc/caddy/Caddyfile:ro $CADDY_IMAGE caddy validate --config /etc/caddy/Caddyfile"
    return 0
  fi
  if ! docker run --rm \
    -v "${caddyfile}:/etc/caddy/Caddyfile:ro" \
    -v "${INSTALL_ROOT}/caddy/routes:/etc/caddy/routes:ro" \
    "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    fatal "Caddyfile failed validation. Check $caddyfile"
  fi
  log_pass "Caddyfile validated."
}

ensure_caddy_container() {
  if docker inspect "$CADDY_CONTAINER_NAME" >/dev/null 2>&1; then
    log_pass "Container already exists: $CADDY_CONTAINER_NAME — reloading configuration."
    if [ "$DRY_RUN" -ne 1 ]; then
      docker exec "$CADDY_CONTAINER_NAME" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
        || docker restart "$CADDY_CONTAINER_NAME" >/dev/null
    fi
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would create and start $CADDY_CONTAINER_NAME ($CADDY_IMAGE), attached to $PLATFORM_NETWORK_NAME and $APPS_NETWORK_NAME, publishing 80/443."
    return 0
  fi

  docker create --name "$CADDY_CONTAINER_NAME" \
    --network "$PLATFORM_NETWORK_NAME" \
    --restart unless-stopped \
    -p 80:80 -p 443:443 \
    -v "${INSTALL_ROOT}/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "${INSTALL_ROOT}/caddy/routes:/etc/caddy/routes:ro" \
    -v "caddy-data:/data" \
    -v "caddy-config:/config" \
    "$CADDY_IMAGE" >/dev/null

  docker network connect "$APPS_NETWORK_NAME" "$CADDY_CONTAINER_NAME" >/dev/null

  docker start "$CADDY_CONTAINER_NAME" >/dev/null
  log_pass "Started $CADDY_CONTAINER_NAME"
}

setup_caddy() {
  log_stage "CADDY"
  local panel_domain="$1"

  render_caddyfile "$panel_domain"
  validate_caddyfile
  ensure_caddy_container
}
