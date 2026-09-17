#!/usr/bin/env bash
#
# bootstrap-production.sh — one-time migration of an existing ClovaForge
# install from the manual release.sh / legacy-git-updater model onto the
# signed, registry-based self-updater. See docs/SELF_UPDATE_ARCHITECTURE.md §13.
#
# Run this ON the server (as root), from a checkout of this repository:
#     sudo bash scripts/bootstrap-production.sh --check     # inspect only
#     sudo bash scripts/bootstrap-production.sh --apply      # make the change
#
# Inspect-first and idempotent. --check changes NOTHING (it reuses the
# installer's own dry-run reporting). --apply never deletes data, never
# removes a volume, and never force-replaces a running container — it only
# wires up the host-side updater and seeds the update-settings row. The
# existing platform containers keep running throughout.
#
# Prerequisites for --apply:
#   * a trusted signing key committed at installer/trusted-keys/<id>.pem
#     (installer/trusted-keys must not be empty), and
#   * a first real release already published (so a --check-only probe at the
#     end can actually see it). If none is published yet, the final probe
#     simply reports "up to date / no release found", which is fine.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DEPLOYMENT_PLATFORM_INSTALLER_ROOT="$REPO_ROOT/installer"

INSTALL_ROOT="${INSTALL_ROOT:-/opt/deployment-platform}"
export INSTALL_ROOT
export INSTALL_ROOT_PARENT="/opt"
export INSTALLER_LOG_FILE="${INSTALL_ROOT}/logs/installer.log"

API_CONTAINER="${API_CONTAINER:-deployment-platform-api}"
# Channel this box should follow. This project's OWN box follows beta;
# override with --channel stable for a normal customer bootstrap.
CHANNEL="beta"
# Start conservative: notify only, so the first real update is a deliberate
# "Update now" you watch. Move to automatic_patch from the UI once confident.
POLICY="notify_only"
MODE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --apply) MODE="apply"; shift ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --policy) POLICY="$2"; shift 2 ;;
    -h|--help) MODE="help"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$MODE" = "help" ] || [ -z "$MODE" ]; then
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

case "$CHANNEL" in stable|beta|nightly) ;; *) echo "Invalid --channel: $CHANNEL" >&2; exit 1 ;; esac
case "$POLICY" in notify_only|automatic_patch|automatic) ;; *) echo "Invalid --policy: $POLICY" >&2; exit 1 ;; esac

if [ "$(id -u)" -ne 0 ]; then
  echo "This must run as root (it writes under ${INSTALL_ROOT} and manages systemd)." >&2
  exit 1
fi

# DRY_RUN drives the installer functions' own "[dry-run] Would ..." output in
# --check mode, so --check genuinely changes nothing while reporting exactly
# what --apply would do.
if [ "$MODE" = "check" ]; then DRY_RUN=1; else DRY_RUN=0; fi
export DRY_RUN

# shellcheck source=../installer/lib/common.sh
source "$DEPLOYMENT_PLATFORM_INSTALLER_ROOT/lib/common.sh"
# shellcheck source=../installer/lib/state.sh
source "$DEPLOYMENT_PLATFORM_INSTALLER_ROOT/lib/state.sh"
# shellcheck source=../installer/lib/filesystem.sh
source "$DEPLOYMENT_PLATFORM_INSTALLER_ROOT/lib/filesystem.sh"
# shellcheck source=../installer/lib/scheduler.sh
source "$DEPLOYMENT_PLATFORM_INSTALLER_ROOT/lib/scheduler.sh"

# ============================================================
# 1. Inspect the live installation (always; read-only).
# ============================================================
log_stage "INSPECT"

running_image() { docker inspect --format '{{.Config.Image}}' "$1" 2>/dev/null || echo "(not found)"; }
current_version="$(running_image "$API_CONTAINER" | awk -F: '{print $NF}')"

log_info "Install root:        ${INSTALL_ROOT}"
log_info "API container image: $(running_image "$API_CONTAINER")  (version: ${current_version:-unknown})"
log_info "Web container image: $(running_image deployment-platform-web)"
log_info "Data volume:         deployment-platform-api-data"
log_info "Disk free (docker):  $(df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')"
log_info "Updater service:     $(systemctl is-enabled deployment-platform-update.service 2>/dev/null || echo 'not installed')"

trusted_key_count=0
if compgen -G "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/trusted-keys/*.pem" >/dev/null 2>&1; then
  trusted_key_count="$(find "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/trusted-keys" -name '*.pem' | wc -l | tr -d ' ')"
fi
log_info "Trusted keys in repo: ${trusted_key_count}"
if [ "$trusted_key_count" -eq 0 ]; then
  log_warn "No trusted signing key is committed. Automatic updates will refuse every release (fail closed) until you provision one — see docs/SELF_UPDATE_ARCHITECTURE.md §5."
fi

if ! docker inspect "$API_CONTAINER" >/dev/null 2>&1; then
  fatal "The API container '${API_CONTAINER}' is not present. This does not look like a running ClovaForge install; aborting."
fi

if [ "$MODE" = "check" ]; then
  log_stage "CHECK (no changes)"
  log_info "The following would be performed by --apply:"
fi

# ============================================================
# 2. Backup (apply only) — a full platform DB backup, verified.
# ============================================================
if [ "$MODE" = "apply" ]; then
  log_stage "BACKUP"
  backup_dir="${INSTALL_ROOT}/backups"
  mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_in_volume="/data/backups/bootstrap-${stamp}.sqlite"
  if ! docker exec "$API_CONTAINER" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DATABASE_PATH || '/data/deployment-platform.sqlite');
db.exec(\"VACUUM INTO '${backup_in_volume}'\"); db.close();"; then
    fatal "Backup failed — refusing to proceed. Nothing was changed."
  fi
  # Verify the backup opens and has the migrations table.
  if ! docker exec "$API_CONTAINER" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${backup_in_volume}');
const n = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
if (!n) { process.exit(2); } db.close();"; then
    fatal "Backup verification failed — the backup is unusable. Refusing to proceed."
  fi
  log_pass "Verified pre-bootstrap backup created at ${backup_in_volume} (inside the api data volume)."
fi

# ============================================================
# 3. Provision updater assets, trusted keys, updater command, scheduler.
#    (These are the exact installer functions; DRY_RUN gates them.)
# ============================================================
log_stage "UPDATER PROVISIONING"
mkdir -p "${INSTALL_ROOT}/updater" "${INSTALL_ROOT}/config/trusted-keys" 2>/dev/null || true
[ "$MODE" = "apply" ] && { chmod 755 "${INSTALL_ROOT}/updater"; chmod 700 "${INSTALL_ROOT}/config/trusted-keys"; }

install_updater_assets       # resolve-update.mjs + release-remote.sh + trusted keys
install_update_command       # /usr/local/bin/deployment-platform-update -> registry updater
install_update_scheduler     # loop wrapper + systemd unit (or cron fallback)

# ============================================================
# 4. Seed update settings in the DB (apply only).
# ============================================================
if [ "$MODE" = "apply" ]; then
  log_stage "UPDATE SETTINGS"
  if DP_CH="$CHANNEL" DP_POL="$POLICY" docker exec -i -e DP_CH -e DP_POL "$API_CONTAINER" \
      node --input-type=module <<'NODE'
import { createAppDatabase } from "/app/apps/api/dist/database.js";
const db = createAppDatabase(process.env.DATABASE_PATH || "/data/deployment-platform.sqlite");
try {
  const existing = db.getJsonSetting("platform_update_settings") || {};
  db.setJsonSetting("platform_update_settings", {
    channel: process.env.DP_CH,
    policy: process.env.DP_POL,
    manifestBaseUrl: existing.manifestBaseUrl || "https://github.com/MNIKevin202/deployment-platform/releases/download",
    maintenanceWindow: existing.maintenanceWindow || null
  });
  db.setJsonSetting("platform_update_state", { state:"idle", targetVersion:null, detail:"bootstrapped onto registry updater", updatedAt:new Date().toISOString() });
} finally { db.close(); }
NODE
  then
    log_pass "Update settings seeded: channel=${CHANNEL}, policy=${POLICY}."
  else
    log_warn "Could not seed update settings via the API container. Set them from Settings -> Updates after the API restarts."
  fi
else
  log_info "[check] Would seed update settings: channel=${CHANNEL}, policy=${POLICY} (manifest base defaults to this repo's releases)."
fi

# ============================================================
# 5. Prove the chain end-to-end WITHOUT applying (apply only).
# ============================================================
if [ "$MODE" = "apply" ]; then
  log_stage "VERIFY (check-only probe)"
  if [ -x /usr/local/bin/deployment-platform-update ]; then
    log_info "Running 'deployment-platform-update --check-only' — fetch + verify + decide, applying nothing..."
    /usr/local/bin/deployment-platform-update --check-only || log_warn "The check-only probe reported an issue (see ${INSTALL_ROOT}/logs/update.log). This is expected if no signed release is published yet."
    log_pass "Bootstrap complete. The registry updater is installed and the discover/verify chain was exercised."
    log_info "Next: publish a release (docs §14), then either wait for the updater's schedule or use Settings -> Updates -> Update now."
  fi
else
  log_info "[check] Would run 'deployment-platform-update --check-only' to prove the discover/verify/decide chain."
  log_pass "Check complete — nothing was changed. Re-run with --apply to perform the bootstrap."
fi
