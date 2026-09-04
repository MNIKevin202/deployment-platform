#!/usr/bin/env bash
#
# scheduler.sh — installs the continuous auto-updater that keeps every
# install converged on the latest source. On a systemd host this is a
# long-running service (deployment-platform-update.service) that loops the
# one-shot update command every few seconds; on a host without systemd it
# falls back to a per-minute cron.d entry. Idempotent: re-running the
# installer (or an update) reinstalls the unit/wrapper and re-enables it, so
# an existing install self-heals onto the schedule.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "scheduler.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

INSTALL_ROOT="${INSTALL_ROOT:-/opt/deployment-platform}"

UPDATE_LOOP_BIN="/usr/local/bin/deployment-platform-update-loop"
UPDATE_SERVICE_UNIT="/etc/systemd/system/deployment-platform-update.service"
UPDATE_CRON_FILE="/etc/cron.d/deployment-platform-update"

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

install_update_loop_wrapper() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install $UPDATE_LOOP_BIN"
    return 0
  fi
  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-update-loop.template" "$UPDATE_LOOP_BIN"
  chmod 755 "$UPDATE_LOOP_BIN"
  log_pass "Installed continuous updater loop: $UPDATE_LOOP_BIN"
}

install_update_scheduler_systemd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install and enable deployment-platform-update.service"
    return 0
  fi
  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-update.service.template" "$UPDATE_SERVICE_UNIT"
  chmod 644 "$UPDATE_SERVICE_UNIT"
  # A stale cron fallback from an earlier systemd-less state would double up
  # with the service, so remove it whenever we take the systemd path.
  rm -f "$UPDATE_CRON_FILE"
  systemctl daemon-reload
  # enable --now both installs the boot symlink and starts it immediately;
  # restart (not just start) picks up a changed unit on a reinstall.
  systemctl enable deployment-platform-update.service >/dev/null 2>&1 || true
  systemctl restart deployment-platform-update.service
  log_pass "Enabled continuous auto-updates (systemd service, checks every 30s)."
}

install_update_scheduler_cron() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install $UPDATE_CRON_FILE (per-minute fallback)"
    return 0
  fi
  # No systemd: fall back to cron's finest granularity (one minute). flock
  # keeps a slow rebuild from overlapping the next minute's run.
  cat > "$UPDATE_CRON_FILE" <<'CRON'
# Deployment Platform continuous auto-updater (cron fallback for hosts
# without systemd). Checks every minute; the update command itself exits
# early via `git ls-remote` unless upstream has actually moved.
* * * * * root flock -n /run/lock/deployment-platform-update.lock /usr/local/bin/deployment-platform-update >/dev/null 2>&1
CRON
  chmod 644 "$UPDATE_CRON_FILE"
  log_pass "Enabled continuous auto-updates (cron fallback, checks every minute)."
}

# Installs whichever scheduler this host supports. Called from
# setup_filesystem after the update command itself is in place.
install_update_scheduler() {
  install_update_loop_wrapper
  if systemd_available; then
    install_update_scheduler_systemd
  else
    log_warn "systemd not detected — using a per-minute cron fallback for auto-updates instead of a continuous service."
    install_update_scheduler_cron
  fi
}
