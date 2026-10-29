#!/usr/bin/env bash
#
# enable-update-bridge.sh — enable ONLY the immediate update-trigger socket
# bridge, so a web-UI "Update now" runs the updater tick immediately instead of
# waiting for the 15-minute timer.
#
# This is the NARROW alternative to `bootstrap-production.sh --apply`: it installs
# just the socket-activated bridge (3 systemd files + a tmpfiles rule) and nothing
# else. It does NOT:
#   * recreate, stop, or restart any container (platform OR managed app),
#   * change Docker configuration, networking, or volumes,
#   * touch your managed applications,
#   * modify update channel/policy or any DB setting,
#   * install the updater command/scheduler or reseed anything.
# The only systemd action is enabling + restarting the root-owned trigger SOCKET
# (socket activation — no long-running process). Idempotent; safe to re-run.
#
# Usage (run ON the server, as root, from a checkout of this repo):
#     sudo bash scripts/enable-update-bridge.sh --check    # inspect only, no changes
#     sudo bash scripts/enable-update-bridge.sh --apply    # install the socket bridge
#
# IMPORTANT — the second half of the bridge is a container mount:
# The API container must also have `/run/deployment-platform` bind-mounted so it
# can reach the socket. That mount is added at container-create time, so a RUNNING
# API container only gets it when it is recreated. This script reports whether the
# mount is already present and, if not, tells you the least-disruptive way to get
# it. Installing the socket units here is always safe; it simply has no effect
# until the API container also has the mount.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DEPLOYMENT_PLATFORM_INSTALLER_ROOT="$REPO_ROOT/installer"

INSTALL_ROOT="${INSTALL_ROOT:-/opt/deployment-platform}"
export INSTALL_ROOT
API_CONTAINER="${API_CONTAINER:-deployment-platform-api}"
MOUNT_DIR="/run/deployment-platform"

MODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) MODE="help"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$MODE" = "help" ] || [ -z "$MODE" ]; then
  sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "This must run as root (it writes systemd units under /etc/systemd/system)." >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then DRY_RUN=1; else DRY_RUN=0; fi
export DRY_RUN

# shellcheck source=../installer/lib/common.sh
source "$DEPLOYMENT_PLATFORM_INSTALLER_ROOT/lib/common.sh"
# scheduler.sh defines install_update_trigger_bridge + the unit paths + systemd_available.
# shellcheck source=../installer/lib/scheduler.sh
source "$DEPLOYMENT_PLATFORM_INSTALLER_ROOT/lib/scheduler.sh"

# ------------------------------------------------------------------
# Diagnose (always; read-only).
# ------------------------------------------------------------------
log_stage "INSPECT (read-only)"

if ! systemd_available; then
  log_warn "systemd is not available on this host. The immediate-'Update now' socket bridge needs systemd."
  log_warn "Without systemd, manual applies are picked up by the per-minute cron tick instead; nothing to install here."
  exit 0
fi

socket_installed="no"; [ -f "$UPDATE_TRIGGER_SOCKET_UNIT" ] && socket_installed="yes"
socket_active="$(systemctl is-active deployment-platform-update-trigger.socket 2>/dev/null || echo inactive)"

mount_present="no"
if docker inspect "$API_CONTAINER" >/dev/null 2>&1; then
  if docker inspect "$API_CONTAINER" \
      --format '{{range .Mounts}}{{println .Destination}}{{end}}' 2>/dev/null \
      | grep -qx "$MOUNT_DIR"; then
    mount_present="yes"
  fi
  api_found="yes"
else
  api_found="no"
fi

log_info "Socket unit installed:      ${socket_installed}  (${UPDATE_TRIGGER_SOCKET_UNIT})"
log_info "Socket unit active:         ${socket_active}"
log_info "API container present:      ${api_found}  (${API_CONTAINER})"
log_info "API has ${MOUNT_DIR} mount: ${mount_present}"

# ------------------------------------------------------------------
# Install the socket bridge (units only — never touches a container).
# ------------------------------------------------------------------
log_stage "SOCKET BRIDGE"
# DRY_RUN=1 (--check) makes this print "[dry-run] Would ..." and change nothing.
install_update_trigger_bridge

# ------------------------------------------------------------------
# Report + guidance on the container mount.
# ------------------------------------------------------------------
if [ "$MODE" = "check" ]; then
  log_stage "CHECK COMPLETE — nothing was changed"
  log_info "Re-run with --apply to install the socket bridge (units only; no container is touched)."
fi

if [ "$mount_present" = "yes" ]; then
  log_pass "The API container already has the ${MOUNT_DIR} mount. Once the socket bridge is installed, a web-UI 'Update now' triggers immediately — no container recreate needed."
else
  log_warn "The API container does NOT yet have the ${MOUNT_DIR} mount, so the socket bridge cannot be reached from the API until it does."
  log_warn "Least-disruptive ways to add the mount (managed apps are never affected either way):"
  log_warn "  1. Do nothing extra: the next signed image update injects the mount during the API swap (release-remote.sh adds it when absent). From the update AFTER that, every 'Update now' is immediate."
  log_warn "  2. Or run 'sudo bash scripts/bootstrap-production.sh --apply' once — it refreshes the host updater assets (so the next update reliably injects the mount) without recreating any container or touching your apps."
fi

log_info "Rollback (if ever needed): systemctl disable --now deployment-platform-update-trigger.socket; rm -f ${UPDATE_TRIGGER_SOCKET_UNIT} ${UPDATE_TRIGGER_SERVICE_UNIT} ${UPDATE_TRIGGER_TMPFILES}; systemctl daemon-reload"
