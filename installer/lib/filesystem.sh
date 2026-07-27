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
  ensure_dir "$INSTALL_ROOT/caddy" 755
  ensure_dir "$INSTALL_ROOT/caddy/routes" 755
  ensure_dir "$INSTALL_ROOT/installer" 755
  ensure_dir "$INSTALL_ROOT/logs" 750
  ensure_dir "$INSTALL_ROOT/backups" 700
  ensure_dir "$INSTALL_ROOT/state" 700

  install_installer_copy
  install_cli_command

  log_pass "Filesystem layout ready at $INSTALL_ROOT"
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
