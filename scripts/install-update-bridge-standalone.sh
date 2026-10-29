#!/usr/bin/env bash
#
# install-update-bridge-standalone.sh
# ===================================
# Fully self-contained installer for the ClovaForge immediate update-trigger
# socket bridge. It bundles the systemd socket/service/tmpfiles content inline,
# so it needs NOTHING from the repo: no installer libraries, no `git pull`, no
# clean checkout. Copy THIS ONE FILE to the server and run it.
#
# What the bridge does: lets the running API container ask the host to run ONE
# updater tick immediately (instead of waiting for the ~15-minute timer) when an
# admin clicks "Update now". Connecting to the socket is the ONLY capability it
# grants — no command, no arguments, no target version can be passed. The host
# updater remains the sole authority (it re-verifies the signed release, backs
# up, swaps, health-checks, and rolls back) and applies something ONLY when a
# valid admin-written platform_update_apply_request row exists; a bare tick with
# no pending request is a safe no-op.
#
# It does NOT: recreate/stop/restart any container (platform OR app), change
# Docker config/networking/volumes, touch managed apps, or modify any database
# or update setting. The only system changes are three root-owned systemd files
# and enabling the socket unit.
#
# Usage (run ON the server, as root):
#     sudo bash install-update-bridge-standalone.sh --check     # read-only; changes nothing
#     sudo bash install-update-bridge-standalone.sh --apply     # install the socket bridge (idempotent)
#     sudo bash install-update-bridge-standalone.sh --verify    # prove the installed bridge actually works
#
set -Eeuo pipefail

# ---- Paths / config (overridable via env for non-default layouts) ------------
SOCKET_UNIT="${SOCKET_UNIT:-/etc/systemd/system/deployment-platform-update-trigger.socket}"
SERVICE_UNIT="${SERVICE_UNIT:-/etc/systemd/system/deployment-platform-update-trigger@.service}"
TMPFILES_CONF="${TMPFILES_CONF:-/etc/tmpfiles.d/deployment-platform-update.conf}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/deployment-platform}"
SOCKET_PATH="${SOCKET_PATH:-${RUNTIME_DIR}/trigger.sock}"
UPDATER_CMD="${DP_UPDATE_CMD:-/usr/local/bin/deployment-platform-update}"
TICK_CMD="${DP_UPDATE_TICK:-/usr/local/bin/deployment-platform-update-tick}"
LOCK_FILE="${DP_UPDATE_LOCK:-/run/lock/deployment-platform-update.lock}"
API_CONTAINER="${API_CONTAINER:-deployment-platform-api}"
UPDATER_RELEASE_REMOTE="${UPDATER_RELEASE_REMOTE:-/opt/deployment-platform/updater/release-remote.sh}"

# ---- Minimal logging (no external libs) --------------------------------------
stage() { printf '\n== %s ==\n' "$*"; }
info()  { printf '   %s\n' "$*"; }
ok()    { printf '   [ok]   %s\n' "$*"; }
warn()  { printf '   [warn] %s\n' "$*" >&2; }
die()   { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

MODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --apply) MODE="apply"; shift ;;
    --verify) MODE="verify"; shift ;;
    -h|--help) MODE="help"; shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done
if [ "$MODE" = "help" ] || [ -z "$MODE" ]; then
  sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "Must run as root (writes /etc/systemd/system and manages systemd)."
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] \
  || die "systemd is required for the socket bridge (this host does not appear to use systemd)."

# ---- Choose how the trigger runs ONE tick, sharing the timer's lock ----------
# Prefer the shipped flock'd tick wrapper (identical locking to the scheduled
# timer). If it is absent, invoke the updater command under the SAME flock file
# the tick wrapper uses, so a triggered tick can never overlap a scheduled one.
choose_execstart() {
  if [ -x "$TICK_CMD" ]; then
    printf '%s' "$TICK_CMD"
  else
    printf '%s' "/usr/bin/flock -n -E 75 ${LOCK_FILE} ${UPDATER_CMD}"
  fi
}

# ---- Bundled unit contents (printed to stdout; written to files on --apply) --
emit_socket_unit() {
  cat <<EOF
[Unit]
Description=ClovaForge update-trigger socket (connecting requests exactly one updater tick)
Documentation=https://github.com/MNIKevin202/deployment-platform

[Socket]
# The API container connects here to ask the host to run ONE updater tick now.
# Connecting is the ONLY capability: no command/args/version can be passed (the
# activated service ignores the connection). The real authorization to APPLY is
# the admin-written platform_update_apply_request row, which the updater
# re-verifies; a bare tick with no pending request is a safe no-op.
ListenStream=${SOCKET_PATH}
Accept=yes
# Root-owned, 0660: reachable only by host root and the API container (root),
# which already holds the equivalent docker.sock capability. No new privilege.
SocketUser=root
SocketGroup=root
SocketMode=0660

[Install]
WantedBy=sockets.target
EOF
}

emit_service_unit() {
  local exec_start="$1"
  cat <<EOF
[Unit]
Description=ClovaForge update trigger — run exactly one updater tick
Documentation=https://github.com/MNIKevin202/deployment-platform
Requires=deployment-platform-update-trigger.socket
After=deployment-platform-update-trigger.socket

[Service]
Type=oneshot
# The ENTIRE capability: run one lock-protected updater tick. No shell, no args
# derived from the connection; the client's bytes are not even readable
# (StandardInput=null), so nothing a caller sends can change what runs. Shares
# the scheduled timer's flock, so a triggered tick never overlaps a scheduled
# one. The updater stays the sole authority for verify/backup/swap/health/rollback.
ExecStart=${exec_start}
StandardInput=null
EOF
}

emit_tmpfiles() {
  cat <<EOF
# ClovaForge update-trigger runtime dir. Holds ONLY the trigger socket. Created
# at boot so the socket unit and the API container's narrow bind mount of this
# one directory have a stable parent. Root-owned; the API container (root) mounts it.
d ${RUNTIME_DIR} 0755 root root -
EOF
}

# ---- Read-only diagnosis -----------------------------------------------------
api_mount_present() {
  docker inspect "$API_CONTAINER" --format '{{range .Mounts}}{{println .Destination}}{{end}}' 2>/dev/null \
    | grep -qx "$RUNTIME_DIR"
}
next_update_injects_mount() {
  [ -f "$UPDATER_RELEASE_REMOTE" ] && grep -q "$RUNTIME_DIR" "$UPDATER_RELEASE_REMOTE" 2>/dev/null
}

diagnose() {
  stage "INSPECT (read-only)"
  local updater_ok="MISSING"; [ -x "$UPDATER_CMD" ] && updater_ok="present"
  local tick_ok="absent (will use flock+updater)"; [ -x "$TICK_CMD" ] && tick_ok="present (shared flock)"
  local sock_unit="absent"; [ -f "$SOCKET_UNIT" ] && sock_unit="installed"
  local sock_active; sock_active="$(systemctl is-active deployment-platform-update-trigger.socket 2>/dev/null || echo inactive)"
  local api_present="no"; docker inspect "$API_CONTAINER" >/dev/null 2>&1 && api_present="yes"
  local mount="no"; api_mount_present && mount="yes"
  local inject="no"; next_update_injects_mount && inject="yes"

  info "Updater command (${UPDATER_CMD}): ${updater_ok}"
  info "Tick wrapper (${TICK_CMD}): ${tick_ok}"
  info "Socket unit: ${sock_unit} / ${sock_active}"
  info "API container '${API_CONTAINER}': ${api_present}"
  info "API has '${RUNTIME_DIR}' mount: ${mount}"
  info "Next normal update will inject the mount: ${inject}  (updater's release-remote.sh at ${UPDATER_RELEASE_REMOTE})"
  info "Trigger will run: $(choose_execstart)"
}

explain_mount() {
  stage "ABOUT THE API CONTAINER MOUNT (the bridge's second half)"
  info "The API must also have '${RUNTIME_DIR}' bind-mounted to reach the socket."
  info "A bind mount can only be added when a container is CREATED, so a running"
  info "container gets it the next time it is recreated. This script never"
  info "recreates it (that is intentionally out of scope)."
  if api_mount_present; then
    ok "The API container ALREADY has the mount — the bridge is fully usable now."
  elif next_update_injects_mount; then
    info "Your installed updater (release-remote.sh) DOES inject this mount on the API"
    info "swap, so the mount is added automatically during your NEXT normal signed"
    info "update. From the update AFTER that, every 'Update now' is immediate."
  else
    warn "Your installed updater's release-remote.sh does NOT appear to inject this"
    warn "mount (expected on an older/dirty checkout). Until it does, the socket"
    warn "bridge is installed but unreachable from the API. To add the mount without"
    warn "this script (each is a separate, deliberate step — not done here):"
    warn "  * refresh the updater's release-remote.sh to a current version (it adds the"
    warn "    mount on the next swap), OR"
    warn "  * recreate ONLY the API container with '-v ${RUNTIME_DIR}:${RUNTIME_DIR}' added,"
    warn "    preserving its existing image/env/mounts/networks (API-only restart;"
    warn "    managed app containers are unaffected)."
  fi
}

rollback_note() {
  stage "ROLLBACK (if ever needed)"
  info "systemctl disable --now deployment-platform-update-trigger.socket"
  info "rm -f ${SOCKET_UNIT} ${SERVICE_UNIT} ${TMPFILES_CONF}"
  info "systemctl daemon-reload"
  info "(Removing these units cannot affect containers or the scheduled updater.)"
}

case "$MODE" in
  check)
    diagnose
    stage "WOULD WRITE (no changes made)"
    info "--- ${SOCKET_UNIT} ---";  emit_socket_unit | sed 's/^/   /'
    info "--- ${SERVICE_UNIT} ---"; emit_service_unit "$(choose_execstart)" | sed 's/^/   /'
    info "--- ${TMPFILES_CONF} ---"; emit_tmpfiles | sed 's/^/   /'
    explain_mount
    rollback_note
    stage "CHECK COMPLETE — nothing was changed. Re-run with --apply to install."
    ;;

  apply)
    diagnose
    [ -x "$UPDATER_CMD" ] || die "Required updater executable not found at ${UPDATER_CMD}. Refusing to install a socket that would trigger a missing updater. Nothing was changed."
    stage "INSTALL (socket bridge only; no container is touched)"
    umask 022
    emit_socket_unit  > "$SOCKET_UNIT"
    emit_service_unit "$(choose_execstart)" > "$SERVICE_UNIT"
    emit_tmpfiles     > "$TMPFILES_CONF"
    chmod 644 "$SOCKET_UNIT" "$SERVICE_UNIT" "$TMPFILES_CONF"
    ok "Wrote ${SOCKET_UNIT}, ${SERVICE_UNIT}, ${TMPFILES_CONF}"
    systemd-tmpfiles --create "$TMPFILES_CONF" >/dev/null 2>&1 || mkdir -p "$RUNTIME_DIR"
    systemctl daemon-reload
    systemctl enable deployment-platform-update-trigger.socket >/dev/null 2>&1 || true
    systemctl restart deployment-platform-update-trigger.socket
    if [ "$(systemctl is-active deployment-platform-update-trigger.socket 2>/dev/null)" = "active" ]; then
      ok "Socket bridge installed and active (listening at ${SOCKET_PATH})."
    else
      die "The socket unit did not become active. Check: systemctl status deployment-platform-update-trigger.socket"
    fi
    explain_mount
    rollback_note
    stage "NEXT: run '--verify' to confirm the bridge works end-to-end."
    ;;

  verify)
    stage "VERIFY"
    [ -S "$SOCKET_PATH" ] || die "Socket ${SOCKET_PATH} does not exist. Run --apply first."
    [ "$(systemctl is-active deployment-platform-update-trigger.socket 2>/dev/null)" = "active" ] \
      || die "The trigger socket unit is not active. Run --apply first."
    ok "Socket unit is active and ${SOCKET_PATH} exists."
    if ! api_mount_present; then
      warn "The API container does not have the '${RUNTIME_DIR}' mount yet, so the API"
      warn "cannot reach the socket. The host socket itself is correct; the bridge"
      warn "becomes end-to-end usable once the mount is present (see --check output)."
      exit 0
    fi
    info "Testing the FULL path (API container -> host socket) the real app uses."
    info "This connect runs one updater tick; with no pending apply request it is a safe no-op."
    if docker exec "$API_CONTAINER" node -e "
const net=require('node:net');
const s=net.connect('${SOCKET_PATH}',()=>{s.end();});
s.on('error',e=>{console.error(e.message);process.exit(1);});
s.on('close',()=>process.exit(0));
setTimeout(()=>{console.error('timeout');process.exit(1);},4000);
"; then
      ok "The API container successfully connected to the trigger socket."
      ok "The bridge works: a web-UI 'Update now' will now trigger an updater tick immediately."
      info "(Confirm the tick fired, if you like: journalctl -u 'deployment-platform-update*' --since '1 min ago' --no-pager)"
    else
      die "The API container could NOT connect to ${SOCKET_PATH}. Check the mount and socket permissions."
    fi
    ;;
esac
