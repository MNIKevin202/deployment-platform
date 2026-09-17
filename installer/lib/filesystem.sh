#!/usr/bin/env bash
#
# filesystem.sh — creates the production directory layout with
# least-privilege ownership/permissions (section 7, 8). Idempotent: an
# existing directory with correct ownership passes; one with wrong
# ownership is fixed, never silently ignored.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "filesystem.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

INSTALL_ROOT="${INSTALL_ROOT:-/opt/deployment-platform}"

# name -> mode, relative to INSTALL_ROOT. Secrets live in config/ (700);
# everything the platform itself writes at runtime (the database) lives
# in the deployment-platform-api-data Docker volume, not a host bind
# mount, per section 7.
ensure_dir() {
  local path="$1"
  local mode="$2"

  if [ -d "$path" ]; then
    log_info "Directory already exists: $path"
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      log_info "[dry-run] Would create directory: $path (mode $mode)"
      return 0
    fi
    if ! mkdir -p "$path"; then
      fatal "Failed to create directory: $path"
    fi
    log_pass "Created directory: $path"
  fi

  if [ "$DRY_RUN" -ne 1 ]; then
    chmod "$mode" "$path"
    chown root:root "$path"
  fi
}

setup_filesystem() {
  log_stage "FILESYSTEM"

  ensure_dir "$INSTALL_ROOT" 755
  ensure_dir "$INSTALL_ROOT/source" 755
  ensure_dir "$INSTALL_ROOT/source/releases" 755
  ensure_dir "$INSTALL_ROOT/config" 700
  ensure_dir "$INSTALL_ROOT/config/trusted-keys" 700
  ensure_dir "$INSTALL_ROOT/caddy" 755
  ensure_dir "$INSTALL_ROOT/caddy/routes" 755
  ensure_dir "$INSTALL_ROOT/installer" 755
  ensure_dir "$INSTALL_ROOT/updater" 755
  ensure_dir "$INSTALL_ROOT/logs" 750
  ensure_dir "$INSTALL_ROOT/backups" 700
  ensure_dir "$INSTALL_ROOT/state" 700

  install_installer_copy
  install_cli_command
  install_update_command
  install_updater_assets
  install_update_scheduler

  log_pass "Filesystem layout ready at $INSTALL_ROOT"
}

# Resolves scripts/release-remote.sh from either a source checkout
# (installer/../scripts) or the installer copy that carries it alongside the
# updater assets. Prints the path, or nothing if it cannot be found.
find_release_remote_script() {
  local candidate
  for candidate in \
    "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/../scripts/release-remote.sh" \
    "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/updater/release-remote.sh"; do
    if [ -f "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  printf ''
}

# Installs the registry-based self-updater's host assets: the verify/decide
# script, the deploy engine it invokes, and the trusted release-signing public
# keys. These let the updater fetch, verify, and install a signed release with
# NO source checkout and NO build toolchain on the host.
install_updater_assets() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install updater assets into ${INSTALL_ROOT}/updater and trusted keys into ${INSTALL_ROOT}/config/trusted-keys"
    return 0
  fi

  # Ship the resolver and every db-*.mjs raw-SQL helper (these let the updater
  # read/write config and record history against ANY API version, including a
  # legacy image predating getJsonSetting — see the updater header comment).
  local mjs
  for mjs in "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}"/updater/*.mjs; do
    [ -f "$mjs" ] || continue
    cp "$mjs" "${INSTALL_ROOT}/updater/"
  done
  chmod 755 "${INSTALL_ROOT}/updater/"*.mjs 2>/dev/null || true

  local release_remote
  release_remote="$(find_release_remote_script)"
  if [ -n "$release_remote" ]; then
    cp "$release_remote" "${INSTALL_ROOT}/updater/release-remote.sh"
    chmod 755 "${INSTALL_ROOT}/updater/release-remote.sh"
    log_pass "Installed self-updater deploy engine: ${INSTALL_ROOT}/updater/release-remote.sh"
  else
    log_warn "release-remote.sh not found next to the installer — the self-updater cannot apply updates until it is placed at ${INSTALL_ROOT}/updater/release-remote.sh."
  fi

  # Trusted signing keys (public only). An empty set is valid and means the
  # updater will refuse every release until a key is provisioned (fail closed).
  local key count=0
  if compgen -G "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/trusted-keys/*.pem" >/dev/null 2>&1; then
    for key in "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}"/trusted-keys/*.pem; do
      cp "$key" "${INSTALL_ROOT}/config/trusted-keys/"
      count=$((count + 1))
    done
  fi
  chmod 600 "${INSTALL_ROOT}/config/trusted-keys/"*.pem 2>/dev/null || true
  if [ "$count" -gt 0 ]; then
    log_pass "Installed ${count} trusted release-signing key(s)."
  else
    log_warn "No trusted release-signing keys were installed. Automatic updates will refuse every release until a key is provisioned (this is fail-closed by design)."
  fi
}

# Copies the installer's own scripts into the install root so
# 'deployment-platform resume-install/verify/...' and a later
# uninstall can find them without depending on wherever the operator
# originally downloaded/checked out the installer from.
install_installer_copy() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would copy the installer into $INSTALL_ROOT/installer"
    return 0
  fi
  rsync -a --exclude=tests "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/" "${INSTALL_ROOT}/installer/"
  chmod 755 "${INSTALL_ROOT}/installer/install.sh"

  # Carry release-remote.sh into the installer copy so a later resume/update
  # (which runs from ${INSTALL_ROOT}/installer, with no sibling scripts/ dir)
  # can still find the deploy engine — see find_release_remote_script.
  if [ -f "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/../scripts/release-remote.sh" ]; then
    mkdir -p "${INSTALL_ROOT}/installer/updater"
    cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/../scripts/release-remote.sh" "${INSTALL_ROOT}/installer/updater/release-remote.sh"
    chmod 755 "${INSTALL_ROOT}/installer/updater/release-remote.sh"
  fi
  log_pass "Installer copied to ${INSTALL_ROOT}/installer"
}

install_cli_command() {
  local target="/usr/local/bin/deployment-platform"
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install $target"
    return 0
  fi
  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-cli.template" "$target"
  chmod 755 "$target"
  log_pass "Installed management command: $target"
}

install_update_command() {
  local target="/usr/local/bin/deployment-platform-update"
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install $target"
    return 0
  fi
  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-update.template" "$target"
  chmod 755 "$target"
  log_pass "Installed update command: $target"
}
