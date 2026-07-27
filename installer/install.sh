#!/usr/bin/env bash
#
# install.sh — Deployment Platform guided installer entry point.
#
# Usage:
#   sudo ./installer/install.sh                    # interactive
#   sudo ./installer/install.sh --non-interactive \
#     --panel-domain panel.example.com \
#     --apps-domain apps.example.com \
#     --admin-username admin \
#     --admin-password-file /root/platform-admin-password \
#     --source-ref main
#   sudo ./installer/install.sh --resume
#   sudo ./installer/install.sh --verify-only
#   sudo ./installer/install.sh --dry-run
#   sudo ./installer/install.sh --uninstall-preview
#   sudo ./installer/install.sh --uninstall [--delete-platform-data ...] [--purge-all]
#   sudo ./installer/install.sh --help
#
# This script only orchestrates — every real stage lives in
# installer/lib/*.sh. Keep this file readable; if a stage needs more
# than a few lines here, that logic belongs in its own lib file.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEPLOYMENT_PLATFORM_INSTALLER_ROOT="$SCRIPT_DIR"
export INSTALLER_VERSION="1.0.0"

INSTALL_ROOT="/opt/deployment-platform"
export INSTALL_ROOT
export INSTALL_ROOT_PARENT="/opt"
export INSTALLER_LOG_FILE="${INSTALL_ROOT}/logs/installer.log"

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/state.sh
source "$SCRIPT_DIR/lib/state.sh"
# shellcheck source=lib/prompts.sh
source "$SCRIPT_DIR/lib/prompts.sh"
# shellcheck source=lib/preflight.sh
source "$SCRIPT_DIR/lib/preflight.sh"
# shellcheck source=lib/packages.sh
source "$SCRIPT_DIR/lib/packages.sh"
# shellcheck source=lib/docker.sh
source "$SCRIPT_DIR/lib/docker.sh"
# shellcheck source=lib/filesystem.sh
source "$SCRIPT_DIR/lib/filesystem.sh"
# shellcheck source=lib/secrets.sh
source "$SCRIPT_DIR/lib/secrets.sh"
# shellcheck source=lib/source.sh
source "$SCRIPT_DIR/lib/source.sh"
# shellcheck source=lib/images.sh
source "$SCRIPT_DIR/lib/images.sh"
# shellcheck source=lib/dns.sh
source "$SCRIPT_DIR/lib/dns.sh"
# shellcheck source=lib/caddy.sh
source "$SCRIPT_DIR/lib/caddy.sh"
# shellcheck source=lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"
# shellcheck source=lib/verify.sh
source "$SCRIPT_DIR/lib/verify.sh"
# shellcheck source=lib/uninstall.sh
source "$SCRIPT_DIR/lib/uninstall.sh"
# shellcheck source=lib/rollback.sh
source "$SCRIPT_DIR/lib/rollback.sh"

# ============================================================
# Argument parsing
# ============================================================

MODE="interactive"
NON_INTERACTIVE=0
DRY_RUN=0
OPT_PANEL_DOMAIN=""
OPT_APPS_DOMAIN=""
OPT_ADMIN_USERNAME=""
OPT_ADMIN_PASSWORD_FILE=""
OPT_SOURCE_PATH=""
OPT_SOURCE_REPOSITORY=""
OPT_SOURCE_REF="main"
OPT_BACKUPS_ENABLED=1
OPT_BACKUP_RETENTION=14
OPT_CONTINUE_WITHOUT_DNS=0
OPT_DELETE_PLATFORM_DATA=0
OPT_DELETE_APP_CONTAINERS=0
OPT_DELETE_APP_VOLUMES=0
OPT_DELETE_SECRETS=0
OPT_PURGE_ALL=0
OPT_CONFIRM_PURGE=0

print_help() {
  cat <<'EOF'
Deployment Platform installer

Modes:
  sudo ./installer/install.sh                  Interactive installation
  sudo ./installer/install.sh --non-interactive [options]
  sudo ./installer/install.sh --resume          Resume an interrupted installation
  sudo ./installer/install.sh --verify-only     Validate an existing installation
  sudo ./installer/install.sh --dry-run         Print planned actions, change nothing
  sudo ./installer/install.sh --uninstall-preview
  sudo ./installer/install.sh --uninstall [--delete-platform-data] [--delete-app-containers]
                                             [--delete-app-volumes] [--delete-secrets] [--purge-all]
  sudo ./installer/install.sh --help

Non-interactive options:
  --panel-domain DOMAIN
  --apps-domain DOMAIN
  --admin-username NAME
  --admin-password-file PATH     Never pass a password directly as an argument.
  --source-path PATH             Build from an already-checked-out local copy.
  --source-repository URL        Clone from a Git repository (https:// only).
  --source-ref REF               Branch/tag to clone (default: main).
  --no-backups                   Disable automatic database backups.
  --backup-retention N           Days of daily backups to keep (default: 14).
  --continue-without-dns         Proceed even if DNS is not confirmed yet.

Uninstall flags (each is independently opt-in; all default to "preserve"):
  --delete-platform-data         Delete the platform database volume.
  --delete-app-containers        Delete deployed app containers.
  --delete-app-volumes           Delete deployed app volumes (irreversible).
  --delete-secrets                Delete generated secrets (breaks stored credentials).
  --purge-all                    All of the above; requires a typed confirmation
                                  (interactive) or --confirm-purge (non-interactive).

See installer/README.md for the full walkthrough.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --non-interactive) MODE="install"; NON_INTERACTIVE=1; shift ;;
    --resume) MODE="resume"; shift ;;
    --verify-only) MODE="verify"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --uninstall-preview) MODE="uninstall-preview"; shift ;;
    --help|-h) print_help; exit 0 ;;
    --panel-domain) OPT_PANEL_DOMAIN="$2"; shift 2 ;;
    --apps-domain) OPT_APPS_DOMAIN="$2"; shift 2 ;;
    --admin-username) OPT_ADMIN_USERNAME="$2"; shift 2 ;;
    --admin-password-file) OPT_ADMIN_PASSWORD_FILE="$2"; shift 2 ;;
    --source-path) OPT_SOURCE_PATH="$2"; shift 2 ;;
    --source-repository) OPT_SOURCE_REPOSITORY="$2"; shift 2 ;;
    --source-ref) OPT_SOURCE_REF="$2"; shift 2 ;;
    --no-backups) OPT_BACKUPS_ENABLED=0; shift ;;
    --backup-retention) OPT_BACKUP_RETENTION="$2"; shift 2 ;;
    --continue-without-dns) OPT_CONTINUE_WITHOUT_DNS=1; shift ;;
    --delete-platform-data) OPT_DELETE_PLATFORM_DATA=1; shift ;;
    --delete-app-containers) OPT_DELETE_APP_CONTAINERS=1; shift ;;
    --delete-app-volumes) OPT_DELETE_APP_VOLUMES=1; shift ;;
    --delete-secrets) OPT_DELETE_SECRETS=1; shift ;;
    --purge-all) OPT_PURGE_ALL=1; shift ;;
    --confirm-purge) OPT_CONFIRM_PURGE=1; shift ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

if [ "$MODE" != "uninstall-preview" ]; then
  install_trap_handlers
fi

# ============================================================
# Uninstall / verify-only / dry-run dispatch (no install flow needed)
# ============================================================

if [ "$MODE" = "uninstall-preview" ]; then
  require_root
  uninstall_preview
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  require_root
  run_uninstall
  exit 0
fi

if [ "$MODE" = "verify" ]; then
  require_root
  panel_domain="$(state_read_field panelDomain)"
  [ -n "$panel_domain" ] || fatal "No installer state found — nothing to verify. Run the installer first."
  run_full_verification "$panel_domain"
  exit $?
fi

# ============================================================
# Interactive collection (skipped in --non-interactive / --resume)
# ============================================================

run_preflight_checks

if [ "$MODE" = "resume" ]; then
  state_exists || fatal "No installer state found at ${STATE_FILE} — there is nothing to resume. Run without --resume to start a fresh installation."
  OPT_PANEL_DOMAIN="$(state_read_field panelDomain)"
  OPT_APPS_DOMAIN="$(state_read_field appsDomain)"
  OPT_ADMIN_USERNAME="$(state_read_field adminUsername)"
  OPT_SOURCE_PATH="$(state_read_field sourcePath)"
  OPT_SOURCE_REPOSITORY="$(state_read_field sourceRepository)"
  OPT_SOURCE_REF="$(state_read_field sourceRef)"
  [ -n "$OPT_SOURCE_REF" ] || OPT_SOURCE_REF="main"
  log_info "Resuming installation (last stage: $(state_get_stage))."
elif [ "$NON_INTERACTIVE" -eq 1 ]; then
  [ -n "$OPT_PANEL_DOMAIN" ] || fatal "--non-interactive requires --panel-domain."
  [ -n "$OPT_APPS_DOMAIN" ] || fatal "--non-interactive requires --apps-domain."
  [ -n "$OPT_ADMIN_USERNAME" ] || fatal "--non-interactive requires --admin-username."
  [ -n "$OPT_ADMIN_PASSWORD_FILE" ] || fatal "--non-interactive requires --admin-password-file (a plaintext password is never accepted as a command-line argument)."
  [ -f "$OPT_ADMIN_PASSWORD_FILE" ] || fatal "Admin password file not found: $OPT_ADMIN_PASSWORD_FILE"

  if ! OPT_PANEL_DOMAIN="$(validate_domain "$OPT_PANEL_DOMAIN")"; then
    fatal "Invalid --panel-domain: $OPT_PANEL_DOMAIN"
  fi
  if ! OPT_APPS_DOMAIN="$(validate_domain "$OPT_APPS_DOMAIN")"; then
    fatal "Invalid --apps-domain: $OPT_APPS_DOMAIN"
  fi
  if ! validate_domain_pair "$OPT_PANEL_DOMAIN" "$OPT_APPS_DOMAIN" >/dev/null; then
    fatal "$(validate_domain_pair "$OPT_PANEL_DOMAIN" "$OPT_APPS_DOMAIN")"
  fi
else
  log_stage "GUIDED SETUP"
  echo "This wizard will ask a few questions, then show a summary before changing anything."
  echo

  OPT_PANEL_DOMAIN="$(prompt_domain "Panel domain (e.g. panel.example.com)")"
  OPT_APPS_DOMAIN="$(prompt_domain "Apps base domain (e.g. apps.example.com)")"
  echo "Deployed apps will be reachable at <app-name>.${OPT_APPS_DOMAIN}"

  while ! validate_domain_pair "$OPT_PANEL_DOMAIN" "$OPT_APPS_DOMAIN" >/dev/null; do
    validate_domain_pair "$OPT_PANEL_DOMAIN" "$OPT_APPS_DOMAIN" || true
    OPT_APPS_DOMAIN="$(prompt_domain "Apps base domain (must differ from the panel domain)")"
  done

  OPT_ADMIN_USERNAME="$(prompt_text "Administrator username" "admin")"

  ADMIN_PASSWORD_PLAINTEXT="$(prompt_password "Administrator password (min. 12 characters)")"
  OPT_ADMIN_PASSWORD_FILE="$(mktemp)"
  chmod 600 "$OPT_ADMIN_PASSWORD_FILE"
  printf '%s' "$ADMIN_PASSWORD_PLAINTEXT" > "$OPT_ADMIN_PASSWORD_FILE"
  unset ADMIN_PASSWORD_PLAINTEXT
  track_temp_dir "$OPT_ADMIN_PASSWORD_FILE"

  source_method="$(prompt_choice "Source installation method:" \
    "Build from this checked-out repository" \
    "Clone from a Git repository and ref" \
    "Use a local source path")"
  case "$source_method" in
    "Build from this checked-out repository")
      OPT_SOURCE_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
      ;;
    "Clone from a Git repository and ref")
      OPT_SOURCE_REPOSITORY="$(prompt_text "Git repository URL (https://...)")"
      OPT_SOURCE_REF="$(prompt_text "Git ref (branch or tag)" "main")"
      ;;
    "Use a local source path")
      OPT_SOURCE_PATH="$(prompt_text "Local source path")"
      ;;
  esac

  if confirm_yes_no "Enable automatic daily database backups? (recommended)"; then
    OPT_BACKUPS_ENABLED=1
  else
    OPT_BACKUPS_ENABLED=0
  fi
  if [ "$OPT_BACKUPS_ENABLED" -eq 1 ]; then
    OPT_BACKUP_RETENTION="$(prompt_text "Backup retention (days)" "14")"
  fi

  echo
  log_stage "INSTALLATION PLAN"
  echo "Panel domain:        $OPT_PANEL_DOMAIN"
  echo "Apps base domain:    $OPT_APPS_DOMAIN"
  echo "Administrator user:  $OPT_ADMIN_USERNAME"
  echo "Administrator pass:  [hidden]"
  echo "Source:              ${OPT_SOURCE_PATH:-${OPT_SOURCE_REPOSITORY} @ ${OPT_SOURCE_REF}}"
  echo "Automatic backups:   $([ "$OPT_BACKUPS_ENABLED" -eq 1 ] && echo "enabled, retaining ${OPT_BACKUP_RETENTION} days" || echo "disabled")"
  echo
  if ! confirm_yes_no "Proceed with installation?"; then
    log_info "Installation cancelled. Nothing was changed."
    exit 0
  fi
fi

# ============================================================
# Persist initial state
# ============================================================

state_set_field "installerVersion" "$INSTALLER_VERSION"
state_set_field "panelDomain" "$OPT_PANEL_DOMAIN"
state_set_field "appsDomain" "$OPT_APPS_DOMAIN"
state_set_field "adminUsername" "$OPT_ADMIN_USERNAME"
state_set_field "installMode" "$MODE"
state_set_field "sourcePath" "$OPT_SOURCE_PATH"
state_set_field "sourceRepository" "$OPT_SOURCE_REPOSITORY"
state_set_field "sourceRef" "$OPT_SOURCE_REF"
state_set_stage "initialized"

INSTALLER_FAILED_STAGE="preflight"
state_set_stage "preflight-complete"

INSTALLER_FAILED_STAGE="packages"
install_base_packages
state_set_stage "packages-complete"

INSTALLER_FAILED_STAGE="docker"
install_docker
setup_docker_foundation
state_set_stage "docker-complete"

INSTALLER_FAILED_STAGE="filesystem"
setup_filesystem
state_set_stage "filesystem-complete"

INSTALLER_FAILED_STAGE="secrets"
generate_secrets "$OPT_ADMIN_USERNAME" "$OPT_ADMIN_PASSWORD_FILE"
[ -f "${OPT_ADMIN_PASSWORD_FILE:-}" ] && rm -f "$OPT_ADMIN_PASSWORD_FILE"
state_set_stage "secrets-complete"

INSTALLER_FAILED_STAGE="source"
if [ -n "$OPT_SOURCE_PATH" ]; then
  RELEASE_DIR="$(acquire_source_from_local_path "$OPT_SOURCE_PATH")"
elif [ -n "$OPT_SOURCE_REPOSITORY" ]; then
  RELEASE_DIR="$(acquire_source_from_git "$OPT_SOURCE_REPOSITORY" "$OPT_SOURCE_REF")"
else
  fatal "No source specified — pass --source-path or --source-repository (or answer the interactive prompt)."
fi
state_set_field "sourceCommit" "${RESOLVED_SOURCE_COMMIT:-unknown}"
state_set_stage "source-complete"

INSTALLER_FAILED_STAGE="images"
build_platform_images "$RELEASE_DIR" "${RESOLVED_SOURCE_COMMIT:-unknown}"
state_set_field "apiImage" "$BUILT_API_IMAGE"
state_set_field "webImage" "$BUILT_WEB_IMAGE"
state_set_stage "images-complete"

INSTALLER_FAILED_STAGE="database"
log_stage "DATABASE"
backup_database
state_set_stage "database-complete"

INSTALLER_FAILED_STAGE="caddy"
setup_caddy "$OPT_PANEL_DOMAIN"
state_set_stage "caddy-complete"

INSTALLER_FAILED_STAGE="platform"
start_platform "$BUILT_API_IMAGE" "$BUILT_WEB_IMAGE" "$OPT_PANEL_DOMAIN" "$OPT_APPS_DOMAIN"
update_current_source_pointer "$RELEASE_DIR"
state_set_stage "platform-started"

INSTALLER_FAILED_STAGE="dns"
run_dns_readiness_flow "$OPT_PANEL_DOMAIN" "$OPT_APPS_DOMAIN" "$OPT_CONTINUE_WITHOUT_DNS"

INSTALLER_FAILED_STAGE="verification"
if run_full_verification "$OPT_PANEL_DOMAIN"; then
  state_set_stage "verification-complete"
else
  log_warn "Some verification checks did not pass. Local setup is preserved — investigate, then re-run 'deployment-platform verify' or 'sudo ./installer/install.sh --resume'."
fi

INSTALLER_FAILED_STAGE="summary"
SUMMARY_FILE="${INSTALL_ROOT}/state/install-summary.txt"
sed \
  -e "s|__STATUS__|Installed|" \
  -e "s|__PANEL_DOMAIN__|${OPT_PANEL_DOMAIN}|g" \
  -e "s|__APPS_DOMAIN__|${OPT_APPS_DOMAIN}|" \
  -e "s|__ADMIN_USERNAME__|${OPT_ADMIN_USERNAME}|" \
  -e "s|__SOURCE_COMMIT__|${RESOLVED_SOURCE_COMMIT:-unknown}|" \
  -e "s|__API_IMAGE__|${BUILT_API_IMAGE:-unknown}|" \
  -e "s|__WEB_IMAGE__|${BUILT_WEB_IMAGE:-unknown}|" \
  -e "s|__CADDY_IMAGE__|${CADDY_IMAGE:-caddy:2-alpine}|" \
  -e "s|__API_DATA_VOLUME__|${API_DATA_VOLUME_NAME}|" \
  -e "s|__BACKUP_PATH__|${BACKUP_PATH_RESULT:-none yet}|" \
  -e "s|__INSTALL_ROOT__|${INSTALL_ROOT}|" \
  -e "s|__STATE_FILE__|${STATE_FILE}|" \
  -e "s|__VERIFICATION_RESULT__|$([ "$VERIFY_FAILURES" -eq 0 ] 2>/dev/null && echo "all checks passed" || echo "see log for details")|" \
  "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/install-summary.template" > "$SUMMARY_FILE"
chmod 600 "$SUMMARY_FILE"

state_set_stage "installation-complete"
INSTALLER_FAILED_STAGE=""

echo
cat "$SUMMARY_FILE"
echo
log_pass "Installation complete. Summary saved to $SUMMARY_FILE"
