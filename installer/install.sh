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
OPT_GITHUB_TOKEN_FILE=""
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
  --github-token-file PATH        Configure GitHub PAT from a mode-600 file.

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
    --non-interactive) NON_INTERACTIVE=1; shift ;;
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
    --github-token-file) OPT_GITHUB_TOKEN_FILE="$2"; shift 2 ;;
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

if [ "$MODE" = "interactive" ] && [ "$NON_INTERACTIVE" -eq 1 ]; then
  MODE="install"
fi

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
  # Captured explicitly rather than relying on errexit: the exit status
  # must be the verifier's normalized 0/1 verdict, reached only after
  # every check has run and the summary has printed. `deployment-platform
  # verify` execs this path, so this is exactly what the operator's shell
  # sees — it must never be a raw probe status like curl's 7.
  VERIFY_ONLY_STATUS=0
  run_full_verification "$panel_domain" || VERIFY_ONLY_STATUS=$?
  exit "$VERIFY_ONLY_STATUS"
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
  log_info "Resuming installation (last stage: $(state_get_stage), last failed stage: $(state_read_field lastFailedStage || echo none))."

  # The plaintext administrator password is deliberately never stored in
  # installer state, and the temp file that held it during the original
  # run was (correctly) removed on exit. If this resume will still need
  # to generate secrets — i.e. no valid auth.env exists yet, which
  # covers a failure at packages, docker, filesystem, or secrets alike —
  # the password must be collected again NOW, before any long-running
  # stage executes, not discovered missing mid-SECRETS. Interactive
  # resume re-prompts (hidden, confirmed); non-interactive resume
  # requires a valid --admin-password-file or fails here, early.
  collect_resume_admin_password
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
# Called DIRECTLY, never as RELEASE_DIR="$(acquire_source_...)". Command
# substitution would run the helper in a subshell, so the identity it
# computes — and the reuse flag the database stage depends on — would be
# discarded and this shell would keep its previous (empty) values. That
# is precisely what made the source stage log a correct
# local-<sha256> identity while the image stage received "unknown".
# The helpers set SOURCE_RELEASE_DIR / RESOLVED_SOURCE_COMMIT /
# SOURCE_IDENTITY_SHORT / SOURCE_RELEASE_REUSED in this shell.
if [ -n "$OPT_SOURCE_PATH" ]; then
  acquire_source_from_local_path "$OPT_SOURCE_PATH"
elif [ -n "$OPT_SOURCE_REPOSITORY" ]; then
  acquire_source_from_git "$OPT_SOURCE_REPOSITORY" "$OPT_SOURCE_REF"
else
  fatal "No source specified — pass --source-path or --source-repository (or answer the interactive prompt)."
fi
RELEASE_DIR="$SOURCE_RELEASE_DIR"

# Invariant check before anything is built or tagged. Catching a lost or
# contradictory identity here — with an internal-state diagnostic —
# beats surfacing it later as a confusing "remove the image yourself"
# instruction for an image tag that was only wrong because the installer
# dropped its own state.
if [ -z "$RELEASE_DIR" ]; then
  fatal "Internal state error: source acquisition did not report a release directory (SOURCE_RELEASE_DIR is empty). Nothing was built."
fi
if [ -z "${RESOLVED_SOURCE_COMMIT:-}" ]; then
  fatal "Internal state error: source acquisition did not report a source identity (RESOLVED_SOURCE_COMMIT is empty). Nothing was built."
fi
if [ "$RESOLVED_SOURCE_COMMIT" = "unknown" ] && [ -n "$OPT_SOURCE_PATH" ] && [ -d "$OPT_SOURCE_PATH" ]; then
  fatal "Internal state error: the local source at $OPT_SOURCE_PATH is readable, so it must have produced a content fingerprint, but the identity is 'unknown'. This indicates lost installer state rather than a problem with your source. Nothing was built."
fi
if [ -z "${SOURCE_IDENTITY_SHORT:-}" ]; then
  fatal "Internal state error: source acquisition did not report a short identity slug. Nothing was built."
fi

log_info "Source identity in use for images and state: ${RESOLVED_SOURCE_COMMIT} (short: ${SOURCE_IDENTITY_SHORT})"
state_set_field "sourceCommit" "$RESOLVED_SOURCE_COMMIT"
state_set_stage "source-complete"

INSTALLER_FAILED_STAGE="images"
build_platform_images "$RELEASE_DIR" "$RESOLVED_SOURCE_COMMIT"
state_set_field "apiImage" "$BUILT_API_IMAGE"
state_set_field "webImage" "$BUILT_WEB_IMAGE"
state_set_stage "images-complete"

INSTALLER_FAILED_STAGE="database"
log_stage "DATABASE"
# Skipped only when this run provably changes nothing that could touch
# the database: the same source identity is already the current release
# AND both images already exist with that identity, so no new image is
# deployed and no migration can run. Repeatedly resuming a DNS-pending
# install used to leave one redundant backup per attempt. Any real
# upgrade or image change still takes a pre-deployment backup.
if [ "${SOURCE_RELEASE_REUSED:-0}" -eq 1 ] && [ "${IMAGES_ALL_REUSED:-0}" -eq 1 ]; then
  log_pass "Source identity and both images are unchanged — no deployment change will occur, so no pre-deployment backup is needed. Existing backups are untouched."
else
  backup_database
fi
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
# Every substitution uses the `g` flag. __APPS_DOMAIN__ appears TWICE on
# a single template line ("Apps base domain: X (apps are served at
# <app-name>.X)"), and sed's s/// without `g` replaces only the first
# match per line — which is exactly why the live summary printed
# "<app-name>.__APPS_DOMAIN__". Applying `g` uniformly fixes that and
# keeps any future template line with a repeated token correct.
sed \
  -e "s|__STATUS__|Installed|g" \
  -e "s|__PANEL_DOMAIN__|${OPT_PANEL_DOMAIN}|g" \
  -e "s|__APPS_DOMAIN__|${OPT_APPS_DOMAIN}|g" \
  -e "s|__ADMIN_USERNAME__|${OPT_ADMIN_USERNAME}|g" \
  -e "s|__SOURCE_IDENTITY__|${RESOLVED_SOURCE_COMMIT:-unknown}|g" \
  -e "s|__SOURCE_IDENTITY_SHORT__|${SOURCE_IDENTITY_SHORT:-unknown}|g" \
  -e "s|__API_IMAGE__|${BUILT_API_IMAGE:-unknown}|g" \
  -e "s|__WEB_IMAGE__|${BUILT_WEB_IMAGE:-unknown}|g" \
  -e "s|__CADDY_IMAGE__|${CADDY_IMAGE:-caddy:2-alpine}|g" \
  -e "s|__API_DATA_VOLUME__|${API_DATA_VOLUME_NAME}|g" \
  -e "s|__BACKUP_PATH__|${BACKUP_PATH_RESULT:-none yet}|g" \
  -e "s|__INSTALL_ROOT__|${INSTALL_ROOT}|g" \
  -e "s|__STATE_FILE__|${STATE_FILE}|g" \
  -e "s|__VERIFICATION_RESULT__|$([ "$VERIFY_FAILURES" -eq 0 ] 2>/dev/null && echo "all checks passed" || echo "see log for details")|g" \
  "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/install-summary.template" > "$SUMMARY_FILE"
chmod 600 "$SUMMARY_FILE"

# Fail loudly rather than handing the operator a summary with a raw
# __PLACEHOLDER__ in it — the previous silent-leftover is what made the
# apps-domain bug survive a full successful install.
if grep -q '__[A-Z_]\{2,\}__' "$SUMMARY_FILE" 2>/dev/null; then
  log_warn "The installation summary still contains unreplaced template placeholder(s):"
  grep -o '__[A-Z_]\{2,\}__' "$SUMMARY_FILE" | sort -u | while IFS= read -r leftover; do
    log_warn "  ${leftover}"
  done
  log_warn "The installation itself is unaffected — this is a summary-rendering bug. Please report it."
fi

state_set_stage "installation-complete"
INSTALLER_FAILED_STAGE=""

echo
cat "$SUMMARY_FILE"
echo
log_pass "Installation complete. Summary saved to $SUMMARY_FILE"
