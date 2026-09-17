#!/usr/bin/env bash
#
# scheduler.sh — installs the auto-updater's scheduling. There is ONE
# authoritative cadence mechanism (Option A): a systemd TIMER
# (deployment-platform-update.timer) fires a oneshot SERVICE
# (deployment-platform-update.service) every interval, which runs a single
# flock-protected tick (deployment-platform-update-tick) and exits. No
# long-running sleep loop. On a host without systemd it falls back to a cron.d
# entry that runs the same lock-protected one-shot tick. Idempotent: re-running
# the installer (or an update) reinstalls the units/wrapper and re-enables the
# timer, and MIGRATES any older continuous-loop install (a Type=simple
# …update.service plus a …update-loop wrapper) onto the timer model.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "scheduler.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

INSTALL_ROOT="${INSTALL_ROOT:-/opt/deployment-platform}"

UPDATE_TICK_BIN="/usr/local/bin/deployment-platform-update-tick"
UPDATE_LOOP_BIN="/usr/local/bin/deployment-platform-update-loop"   # legacy (removed on migrate)
UPDATE_SERVICE_UNIT="/etc/systemd/system/deployment-platform-update.service"
UPDATE_TIMER_UNIT="/etc/systemd/system/deployment-platform-update.timer"
UPDATE_CRON_FILE="/etc/cron.d/deployment-platform-update"

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

install_update_tick_wrapper() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install $UPDATE_TICK_BIN (one flock-protected tick; no sleep loop)"
    return 0
  fi
  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-update-tick.template" "$UPDATE_TICK_BIN"
  chmod 755 "$UPDATE_TICK_BIN"
  log_pass "Installed updater tick wrapper: $UPDATE_TICK_BIN"
}

install_update_scheduler_systemd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install deployment-platform-update.service (oneshot) + .timer, retire any legacy loop, and enable the TIMER"
    return 0
  fi

  # Migrate off the older continuous-loop model FIRST, using whatever unit
  # definition is currently loaded, so its long-running process is stopped
  # before we replace the unit file underneath it. Idempotent when absent.
  systemctl stop deployment-platform-update.service >/dev/null 2>&1 || true

  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-update.service.template" "$UPDATE_SERVICE_UNIT"
  cp "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/deployment-platform-update.timer.template" "$UPDATE_TIMER_UNIT"
  chmod 644 "$UPDATE_SERVICE_UNIT" "$UPDATE_TIMER_UNIT"

  # A stale cron fallback and the legacy loop wrapper would each double up with
  # the timer, so remove them whenever we take the systemd path.
  rm -f "$UPDATE_CRON_FILE" "$UPDATE_LOOP_BIN"

  systemctl daemon-reload
  # The TIMER owns cadence AND boot-start. The oneshot service is triggered by
  # it and must NOT be enabled on its own (a boot-enabled oneshot would just run
  # once at boot outside the timer). Disable any leftover boot-enablement of the
  # service from the old loop model.
  systemctl disable deployment-platform-update.service >/dev/null 2>&1 || true
  systemctl enable deployment-platform-update.timer >/dev/null 2>&1 || true
  systemctl restart deployment-platform-update.timer
  log_pass "Enabled signed-release auto-updates (systemd timer every 15 min → oneshot flock'd tick)."
}

install_update_scheduler_cron() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would install $UPDATE_CRON_FILE (per-minute one-shot tick fallback)"
    return 0
  fi
  # No systemd: cron owns the cadence and runs the SAME lock-protected one-shot
  # tick (no sleep loop). flock -n keeps a slow apply from overlapping the next
  # minute's run. Remove any legacy loop wrapper for consistency.
  rm -f "$UPDATE_LOOP_BIN"
  cat > "$UPDATE_CRON_FILE" <<'CRON'
# Deployment Platform auto-updater (cron fallback for hosts without systemd).
# Runs one lock-protected update tick per minute; the tick exits early after a
# cheap signed-manifest check unless a newer release its policy permits exists.
* * * * * root /usr/local/bin/deployment-platform-update-tick >/dev/null 2>&1
CRON
  chmod 644 "$UPDATE_CRON_FILE"
  log_pass "Enabled auto-updates (cron fallback: one lock-protected tick per minute)."
}

# Installs whichever scheduler this host supports. Called from
# setup_filesystem after the update command itself is in place.
install_update_scheduler() {
  install_update_tick_wrapper
  if systemd_available; then
    install_update_scheduler_systemd
  else
    log_warn "systemd not detected — using a per-minute cron fallback (one lock-protected tick per run) for auto-updates."
    install_update_scheduler_cron
  fi
}
