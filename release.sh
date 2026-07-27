#!/usr/bin/env bash
#
# release.sh — Mac-side release orchestrator for the Deployment Platform.
#
# Usage:
#   cd /Users/kevinpoulos/Documents/Projects/DeploymentPlatform
#   ./release.sh [options]
#
# Run ./release.sh --help for the full option list.
#
set -Eeuo pipefail

# ============================================================
# Fixed project configuration
#
# These can be overridden by a "release.config" file placed next to this
# script (see release.config.example). release.config is never required
# and is never created automatically.
# ============================================================

LOCAL_PROJECT_DIR="/Users/kevinpoulos/Documents/Projects/DeploymentPlatform"
VPS_HOST="94.130.73.188"
VPS_USER="kevin"
SSH_KEY="/Users/kevinpoulos/.ssh/hetzner_deployment"
VPS_SOURCE_DIR="/opt/deployment-platform/source"
AUTH_FILE="/opt/deployment-platform/config/auth.env"
CADDY_ROUTES_DIR="/opt/deployment-platform/caddy/routes"
API_CONTAINER="deployment-platform-api"
WEB_CONTAINER="deployment-platform-web"
API_IMAGE_REPOSITORY="deployment-platform-api"
WEB_IMAGE_REPOSITORY="deployment-platform-web"
PLATFORM_NETWORK="deployment-platform"
MANAGED_APPS_NETWORK="deployment-apps"
API_DATA_VOLUME="deployment-platform-api-data"
# The panel URL is MANDATORY: it is the platform's own dashboard, it
# exists on every installation, and a release that cannot serve it is not
# a successful release.
PUBLIC_URL_PANEL="https://panel.hookstats.com"

# The two app smoke-test URLs are OPTIONAL, and default to disabled.
# They point at deployed test apps, which do not exist on a freshly
# installed server — the Caddy routes directory is empty until an app is
# created — so requiring them made the first release after an install
# impossible. Set them in release.config to enable the checks; leave them
# empty (or unset) to disable.
#
# Disabled means SKIPPED and reported as such — never silently passed,
# and never quietly substituted with the panel URL, which would claim
# test-app coverage that did not happen. A URL that IS configured stays
# strictly mandatory: it must return HTTP 200, and a network failure is a
# failure, not a skip.
PUBLIC_URL_WIZARD_TEST=""
PUBLIC_URL_SQLITE_TEST=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SCRIPT_LOCAL_PATH="${SCRIPT_DIR}/scripts/release-remote.sh"
CONFIG_FILE="${SCRIPT_DIR}/release.config"

# Files that must never be staged, committed, or synced to the VPS, no
# matter what the operator passes on the command line.
readonly EXCLUDED_FILENAME_GENERATE_AUTH="generate-auth.sh"

RELEASE_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ============================================================
# Small safe utilities
# ============================================================

TMP_PATHS=()
REMOTE_SCRIPT_REMOTE_PATH=""
REMOTE_CLEANUP_DONE=0

cleanup() {
  local path
  for path in "${TMP_PATHS[@]:-}"; do
    if [ -n "${path:-}" ] && [ -e "${path}" ]; then
      rm -f "${path}"
    fi
  done

  if [ "${REMOTE_CLEANUP_DONE}" -eq 0 ] && [ -n "${REMOTE_SCRIPT_REMOTE_PATH}" ]; then
    ssh_quiet rm -f "${REMOTE_SCRIPT_REMOTE_PATH}" || true
    REMOTE_CLEANUP_DONE=1
  fi
}
trap cleanup EXIT

new_tmp_file() {
  local path
  path="$(mktemp "${TMPDIR:-/tmp}/release-sh.XXXXXX")"
  TMP_PATHS+=("${path}")
  printf '%s' "${path}"
}

print_header() {
  printf '\n===== %s =====\n' "$1"
}

info() {
  printf '%s\n' "$1"
}

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

# --yes support — unchanged behavior:
#   - auto-confirms the stage/commit prompt
#   - auto-confirms the deployment prompt
#   - never invents a commit message
#   - every other safety check still runs exactly as before
confirm() {
  local prompt="$1"

  if [ "${AUTO_YES}" -eq 1 ]; then
    printf '%s [auto-confirmed via --yes]\n' "${prompt}"
    return 0
  fi

  local answer=""
  printf '%s [y/N]: ' "${prompt}"
  read -r answer || answer=""
  case "${answer}" in
    y|Y|yes|YES|Yes)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# ssh/rsync wrappers — always use the configured identity file and default
# host-key checking behavior (never disabled).
# ============================================================
# Remote command transport
# ============================================================
#
# ssh does NOT transport an argv array. Given `ssh host a b c` it joins
# its command arguments with single spaces into ONE string and hands that
# to the remote LOGIN shell, which re-parses it. Any structure in an
# argument — spaces, newlines, quotes, $, ;, braces, Go template syntax —
# is therefore lost or, worse, re-interpreted as remote shell syntax.
#
# That is not theoretical. The plan-only runtime preview passes a
# multiline `docker inspect --format` template; after joining, its
# newlines became remote command separators, so the line
#   "  nano cpus: {{.HostConfig.NanoCpus}}"
# ran the remote **nano editor** with the argument "cpus:" — producing
# the blank screen and "[ New File ]" the operator saw, while the real
# docker inspect on the first line received a mangled format string and
# failed into "(unable to inspect deployment-platform-api)".
#
# The fix has two halves, and both are required:
#
#   1. Quote every argument with printf '%q' so the remote shell
#      reconstructs the exact original argv.
#   2. Deliver that text over STDIN to an explicitly invoked remote
#      `bash -s`, not as ssh command arguments.
#
# Half 2 matters for two independent reasons. First, ssh's own argv here
# is just the two harmless tokens `bash -s`, so the join-and-reparse step
# has nothing to damage; the command text travels as raw bytes that ssh
# never touches. Second, bash's %q emits ANSI-C quoting ($'a\nb') for
# arguments containing newlines, and that is a bashism — this host's
# /bin/sh is dash, which does not understand it. Naming `bash`
# explicitly means correctness no longer depends on what the remote
# login shell happens to be.
#
# No eval anywhere: the remote text is executed by bash as a script read
# from stdin, exactly like any other shell script.
#
# Note: because stdin carries the script, a remote command cannot also
# read the caller's stdin. No call site in this file needs that.

build_remote_command() {
  local quoted="" piece arg
  for arg in "$@"; do
    # printf -v avoids a subshell per argument, and (unlike command
    # substitution) cannot strip a trailing newline from the result.
    printf -v piece '%q' "${arg}"
    quoted="${quoted}${piece} "
  done
  printf '%s' "${quoted}"
}

# Runs a command on the VPS with argv preserved exactly. Returns the
# remote command's own exit status (ssh is last in the pipeline).
ssh_run() {
  build_remote_command "$@" \
    | ssh -i "${SSH_KEY}" -o BatchMode=yes "${VPS_USER}@${VPS_HOST}" bash -s
}

# As ssh_run, but silent. Retains BatchMode=yes, ConnectTimeout=10, full
# output suppression, and the exact remote exit status.
ssh_quiet() {
  build_remote_command "$@" \
    | ssh -i "${SSH_KEY}" -o BatchMode=yes -o ConnectTimeout=10 "${VPS_USER}@${VPS_HOST}" bash -s >/dev/null 2>&1
}

require_tools() {
  local tool
  for tool in git npm ssh rsync sed grep awk curl; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      fail "Required tool not found on PATH: ${tool}"
    fi
  done
}

# Restricted KEY=VALUE loader for release.config — never sourced/evaluated.
# Only the known configuration keys below are accepted.
load_config_file() {
  local file="$1"
  local line key value

  if [ ! -f "${file}" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      ''|'#'*)
        continue
        ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "${key}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    value="$(printf '%s' "${value}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

    case "${key}" in
      LOCAL_PROJECT_DIR) LOCAL_PROJECT_DIR="${value}" ;;
      VPS_HOST) VPS_HOST="${value}" ;;
      VPS_USER) VPS_USER="${value}" ;;
      SSH_KEY) SSH_KEY="${value}" ;;
      VPS_SOURCE_DIR) VPS_SOURCE_DIR="${value}" ;;
      AUTH_FILE) AUTH_FILE="${value}" ;;
      CADDY_ROUTES_DIR) CADDY_ROUTES_DIR="${value}" ;;
      API_CONTAINER) API_CONTAINER="${value}" ;;
      WEB_CONTAINER) WEB_CONTAINER="${value}" ;;
      API_IMAGE_REPOSITORY) API_IMAGE_REPOSITORY="${value}" ;;
      WEB_IMAGE_REPOSITORY) WEB_IMAGE_REPOSITORY="${value}" ;;
      PLATFORM_NETWORK) PLATFORM_NETWORK="${value}" ;;
      MANAGED_APPS_NETWORK) MANAGED_APPS_NETWORK="${value}" ;;
      API_DATA_VOLUME) API_DATA_VOLUME="${value}" ;;
      PUBLIC_URL_PANEL) PUBLIC_URL_PANEL="${value}" ;;
      PUBLIC_URL_WIZARD_TEST) PUBLIC_URL_WIZARD_TEST="${value}" ;;
      PUBLIC_URL_SQLITE_TEST) PUBLIC_URL_SQLITE_TEST="${value}" ;;
      *)
        fail "release.config contains an unrecognized key: ${key}"
        ;;
    esac
  done < "${file}"

  validate_ssh_key_path
}

# The source-sync step passes the key inside an rsync `-e` transport
# string ("ssh -i <key>"), and rsync splits that value on whitespace —
# so a key path containing a space would be silently torn into separate
# arguments. Nested quoting inside -e is handled inconsistently across
# rsync versions, so this refuses the input up front with a clear
# message instead of failing confusingly mid-sync.
validate_ssh_key_path() {
  case "${SSH_KEY}" in
    *[[:space:]]*)
      fail "SSH_KEY must not contain whitespace (rsync's -e transport string is split on spaces): ${SSH_KEY}"
      ;;
  esac
}

print_help() {
  cat <<'EOF'
Usage: ./release.sh [options]

Options:
  --message "text"        Commit message to use (skips the interactive prompt)
  --api-version X.Y.Z     Override the computed API image version
  --web-version X.Y.Z     Override the computed web image version
  --verify-only           Run local checks (build + tests) and print the
                          release plan only. Does not stage, commit, sync,
                          or deploy.
  --plan-only             Show the release plan (candidate files, scope,
                          proposed versions, and the runtime settings that
                          would be preserved on the VPS) without building,
                          testing, staging, committing, syncing, or
                          deploying anything.
  --no-deploy             Run checks, stage, and commit. Stops before
                          syncing source or contacting the VPS.
  --yes                   Auto-confirm the two interactive prompts (stage
                          and commit; proceed with remote deployment)
                          instead of waiting for y/N input. A commit
                          message is still required — pass --message, or
                          the script will fail cleanly asking for one
                          rather than guessing at one.
  --resume-release PATH   Redeploy an already-committed, already-synced
                          immutable release directory on the VPS, instead
                          of staging/committing/syncing anything new. PATH
                          must be under VPS_SOURCE_DIR/releases/ and match
                          the release-<timestamp>-<sha> naming convention.
                          See docs/RELEASE_AUTOMATION.md for details.
  --resume-mode MODE      Which component(s) the resumed release touches:
                          api, web, or both (default: both).
  --resume-commit SHA     Commit SHA (or prefix) the release directory is
                          expected to correspond to. Defaults to the
                          current local HEAD. The release directory's own
                          commit suffix must match this, or the resume is
                          refused.
  --help                  Show this help text.

Run with no options from the project root for the full interactive
release workflow.
EOF
}

# ============================================================
# Pure/small logic functions (kept standalone and side-effect-free
# where practical, so they can be inspected or exercised in isolation)
# ============================================================

SECRET_LIKE_PATTERN='(^|/)(\.env(\..*)?|auth\.env|.*\.pem|.*_rsa|id_rsa.*|.*\.key|credentials.*\.json|.*\.p12|.*\.pfx)$'

is_secret_like_path() {
  local path="$1"
  [ "${path}" = "release.config" ] && return 1
  [[ "${path}" =~ ${SECRET_LIKE_PATTERN} ]]
}

# Generated/runtime installer paths that must never be auto-staged even
# though they live under the otherwise-allowed installer/ tree — none of
# these should ever actually appear inside this git checkout (the real
# installer only ever writes them under /opt/deployment-platform on a
# target VPS), but this is checked first, unconditionally, as a defense
# -in-depth guard against ever committing a stray secret or generated
# artifact if one somehow ended up here (e.g. a test run against the
# wrong INSTALL_ROOT, or a manual local install attempt from this
# checkout).
is_installer_generated_runtime_path() {
  local path="$1"
  case "${path}" in
    installer/logs/*|installer/state/*|*/auth.env|*/platform.env|*/install-summary.txt|*/installer-state.json|*.log|*.tmp|*/.installer-state.*)
      return 0
      ;;
  esac
  return 1
}

# Paths allowed to be picked up automatically when untracked (initial
# development of the release tooling itself, plus normal project trees).
# Anything untracked outside these roots is reported but never
# auto-staged.
is_allowed_untracked_path() {
  local path="$1"

  if is_installer_generated_runtime_path "${path}"; then
    return 1
  fi

  case "${path}" in
    apps/*|packages/*|scripts/*|docs/*|installer/*|release.sh|release.config.example|README.md|*.md)
      return 0
      ;;
  esac
  return 1
}

classify_path_scope() {
  local path="$1"
  case "${path}" in
    apps/api/*)
      printf 'api'
      ;;
    apps/web/*)
      printf 'web'
      ;;
    package.json|package-lock.json|.dockerignore)
      printf 'both'
      ;;
    *)
      printf 'none'
      ;;
  esac
}

extract_tag() {
  local image_ref="$1"
  printf '%s' "${image_ref##*:}"
}

SEMVER_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'

is_valid_semver() {
  [[ "$1" =~ ${SEMVER_PATTERN} ]]
}

# Tags the guided installer produces for its first-boot images. It has no
# release history to bump from, so it identifies images by source content
# instead of by version:
#   bootstrap-unknown            — pre-fingerprint installs
#   bootstrap-local-<hex>        — local source, content fingerprint
#   bootstrap-<hex>              — git source, commit prefix
# These are legitimate running tags, but they are NOT versions.
BOOTSTRAP_TAG_PATTERN='^bootstrap-(unknown|local-[0-9a-f]{6,}|[0-9a-f]{6,})$'

is_bootstrap_tag() {
  [[ "$1" =~ ${BOOTSTRAP_TAG_PATTERN} ]]
}

# The version assigned when a component transitions off a bootstrap tag
# onto the normal release track. 0.1.0 matches the version already
# declared in package.json at the repository root and in both
# apps/api/package.json and apps/web/package.json, so the first release
# agrees with what the code says about itself rather than inventing a
# different starting point.
INITIAL_RELEASE_VERSION="0.1.0"

bump_patch() {
  local version="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<< "${version}"
  printf '%s.%s.%s' "${major}" "${minor}" "$((patch + 1))"
}

# compute_next_version <current-tag-or-"unknown"> <changed:yes/no> <override>
#
# Returns the version to release for one component. Only ever bumps a
# real semantic version: bump_patch on a non-semver string used to emit
# garbage (IFS='.' read on "bootstrap-unknown" leaves patch empty, so
# $((patch + 1)) produced "bootstrap-unknown..1"), which then failed
# release-remote.sh's semver validation after the release had already
# started doing work.
#
# An unrecognized tag is returned UNCHANGED rather than mangled or
# silently replaced, so validate_release_version can name the actual tag
# in its error. That check is what turns this into a hard failure.
compute_next_version() {
  local current="$1" changed="$2" override="$3"

  # An explicit --api-version/--web-version always wins. Already
  # validated as semver during argument parsing.
  if [ -n "${override}" ]; then
    printf '%s' "${override}"
    return 0
  fi

  if [ "${changed}" != "yes" ]; then
    printf '%s' "${current}"
    return 0
  fi

  if is_valid_semver "${current}"; then
    bump_patch "${current}"
    return 0
  fi

  # First release after a guided install: start the version track.
  if is_bootstrap_tag "${current}"; then
    printf '%s' "${INITIAL_RELEASE_VERSION}"
    return 0
  fi

  printf '%s' "${current}"
}

# States the public-URL contract up front, so an operator can see before
# deploying which checks will actually gate this release and which are
# disabled — rather than discovering a skipped check in the summary.
print_public_url_plan() {
  info "Public URL checks this release will enforce:"
  info "  Panel (mandatory):      ${PUBLIC_URL_PANEL}"
  if [ -n "${PUBLIC_URL_WIZARD_TEST}" ]; then
    info "  Wizard test (enabled):  ${PUBLIC_URL_WIZARD_TEST} — must return HTTP 200"
  else
    info "  Wizard test:            skipped (not configured)"
  fi
  if [ -n "${PUBLIC_URL_SQLITE_TEST}" ]; then
    info "  SQLite test (enabled):  ${PUBLIC_URL_SQLITE_TEST} — must return HTTP 200"
  else
    info "  SQLite test:            skipped (not configured)"
  fi
}

# Renders one optional smoke-test URL line for the operator summary.
# Distinguishes three genuinely different outcomes and never conflates
# them: a disabled check (no URL configured), a check that ran and
# produced an HTTP result, and a configured check whose result never came
# back (which is a problem, not a skip).
report_optional_url_result() {
  local label="$1" configured_url="$2" result="$3"

  if [ -z "${configured_url}" ]; then
    info "${label}: skipped (not configured)"
    return 0
  fi
  if [ -z "${result}" ]; then
    info "${label} (${configured_url}): not checked"
    return 0
  fi
  if [ "${result}" = "SKIPPED" ]; then
    # The remote script only reports SKIPPED for an unconfigured URL, so
    # this combination means local and remote config disagree.
    info "${label} (${configured_url}): SKIPPED — but this URL IS configured locally; the remote script did not receive it."
    return 0
  fi
  info "${label} (${configured_url}): ${result}"
}

# Gate between "what we computed" and "what we send to the VPS". Any
# changed component must end up with a real semantic version; anything
# else stops the release before a single remote action is taken, and says
# exactly how to proceed.
validate_release_version() {
  local component="$1" computed="$2" current="$3" override_flag="$4"

  if is_valid_semver "${computed}"; then
    return 0
  fi

  info ""
  if [ "${current}" = "unknown" ] || [ -z "${current}" ]; then
    fail "Could not determine the currently running ${component} version, so no release version can be derived. Re-run once the VPS and the ${component} container are reachable, or pass an explicit ${override_flag} <major.minor.patch>."
  fi
  fail "The running ${component} image tag '${current}' is neither a semantic version nor a recognized installer bootstrap tag, so ${component} cannot be version-bumped automatically. Pass an explicit ${override_flag} <major.minor.patch> to choose the release version deliberately. Nothing was changed."
}

# ============================================================
# Resume-path validation (--resume-release)
# ============================================================
#
# Deliberately restrictive: only a path that is exactly
# "${VPS_SOURCE_DIR}/releases/release-<timestamp>-<12 hex chars>" is
# accepted. No traversal, no shell metacharacters, no arbitrary path —
# this string is later passed as --source-dir to the remote script and
# used directly in `docker build`/file-existence checks on the VPS.
validate_resume_release_path() {
  local path="$1"
  local expected_prefix="${VPS_SOURCE_DIR}/releases/"

  case "${path}" in
    "${expected_prefix}"*) ;;
    *)
      fail "--resume-release must be a path under ${expected_prefix} (got: ${path})"
      ;;
  esac

  case "${path}" in
    *'..'*|*'`'*|*'$'*|*';'*|*'|'*|*'&'*|*'"'*|*"'"*|*$'\n'*|*'*'*|*'?'*|*'~'*)
      fail "--resume-release contains disallowed characters."
      ;;
  esac

  local dir_name="${path#"${expected_prefix}"}"
  case "${dir_name}" in
    release-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      ;;
    *)
      fail "--resume-release directory name does not match the expected release-<timestamp>-<sha> pattern: ${dir_name}"
      ;;
  esac

  RESUME_DIR_COMMIT_SUFFIX="${dir_name: -12}"
}

# ============================================================
# Shared remote-invocation + reporting
#
# Used by both the normal flow and --resume-release, so the two paths
# can never drift out of sync on status handling. Expects the caller to
# have already set: DEPLOY_MODE, REMOTE_RELEASE_DIR, COMMIT_SHA,
# API_CHANGED, WEB_CHANGED, PREVIOUS_API_IMAGE, PREVIOUS_WEB_IMAGE,
# PREVIOUS_API_VERSION, PREVIOUS_WEB_VERSION, NEW_API_VERSION,
# NEW_WEB_VERSION. Prints its own "REMOTE PRE-FLIGHT" / "RELEASE
# COMPLETE" headers and returns 0 only for an exact PASS status.
# ============================================================

run_remote_deploy_and_report() {
  print_header "REMOTE PRE-FLIGHT"

  info "Deploy mode: ${DEPLOY_MODE}"
  info "API: ${PREVIOUS_API_VERSION} -> ${NEW_API_VERSION}"
  info "Web: ${PREVIOUS_WEB_VERSION} -> ${NEW_WEB_VERSION}"

  if ! confirm "Proceed with the remote build and deployment described above?"; then
    info "Aborted by operator before deployment. Commit ${COMMIT_SHA} and the synced release directory (${REMOTE_RELEASE_DIR}) are unaffected — re-run to try again."
    return 1
  fi

  if [ ! -f "${REMOTE_SCRIPT_LOCAL_PATH}" ]; then
    fail "Remote deployment script not found: ${REMOTE_SCRIPT_LOCAL_PATH}"
  fi

  REMOTE_SCRIPT_REMOTE_PATH="$(ssh_run mktemp /tmp/release-remote.XXXXXX)"
  scp -i "${SSH_KEY}" "${REMOTE_SCRIPT_LOCAL_PATH}" "${VPS_USER}@${VPS_HOST}:${REMOTE_SCRIPT_REMOTE_PATH}" >/dev/null
  ssh_run chmod 700 "${REMOTE_SCRIPT_REMOTE_PATH}"

  local remote_args=(
    "${REMOTE_SCRIPT_REMOTE_PATH}"
    --mode "${DEPLOY_MODE}"
    --source-dir "${REMOTE_RELEASE_DIR}"
    --auth-file "${AUTH_FILE}"
    --caddy-routes-dir "${CADDY_ROUTES_DIR}"
    --api-container "${API_CONTAINER}"
    --web-container "${WEB_CONTAINER}"
    --api-image-repo "${API_IMAGE_REPOSITORY}"
    --web-image-repo "${WEB_IMAGE_REPOSITORY}"
    --platform-network "${PLATFORM_NETWORK}"
    --apps-network "${MANAGED_APPS_NETWORK}"
    --api-data-volume "${API_DATA_VOLUME}"
    --api-version "${NEW_API_VERSION}"
    --web-version "${NEW_WEB_VERSION}"
    --previous-api-version "${PREVIOUS_API_VERSION}"
    --previous-web-version "${PREVIOUS_WEB_VERSION}"
    --url-panel "${PUBLIC_URL_PANEL}"
    --current-symlink "${VPS_SOURCE_DIR}/current"
  )

  # Optional smoke-test URLs are only passed when actually configured.
  # Passing an empty value would look like a supplied-but-blank required
  # argument; omitting the flag lets the remote script treat the check as
  # explicitly disabled and report it as SKIPPED.
  if [ -n "${PUBLIC_URL_WIZARD_TEST}" ]; then
    remote_args+=(--url-wizard-test "${PUBLIC_URL_WIZARD_TEST}")
  fi
  if [ -n "${PUBLIC_URL_SQLITE_TEST}" ]; then
    remote_args+=(--url-sqlite-test "${PUBLIC_URL_SQLITE_TEST}")
  fi

  # Same transport contract as ssh_run: %q-quote every argument, then
  # deliver the text over stdin to an explicitly invoked remote `bash -s`.
  # This call previously passed the quoted string as an ssh command
  # argument, which left correctness dependent on the remote LOGIN shell
  # understanding bash's %q output — and %q emits $'...' ANSI-C quoting,
  # which this host's /bin/sh (dash) does not support. Naming bash
  # explicitly removes that dependency.
  local remote_command
  remote_command="$(build_remote_command "${remote_args[@]}")"

  local remote_log
  remote_log="$(new_tmp_file)"
  local deploy_exit_code=0
  printf '%s\n' "${remote_command}" \
    | ssh -i "${SSH_KEY}" -o BatchMode=yes "${VPS_USER}@${VPS_HOST}" bash -s 2>&1 \
    | tee "${remote_log}" || deploy_exit_code=$?

  ssh_quiet rm -f "${REMOTE_SCRIPT_REMOTE_PATH}" || true
  REMOTE_CLEANUP_DONE=1

  print_header "RELEASE COMPLETE"

  local summary_status summary_new_api_image summary_new_web_image summary_backup_path
  local summary_rollback_containers summary_url_panel summary_url_wizard summary_url_sqlite
  local summary_live_api_image summary_live_web_image summary_rollback_state summary_current_pointer

  read_summary_value() {
    local key="$1"
    grep -E "^RELEASE_SUMMARY_${key}=" "${remote_log}" | tail -n 1 | sed -e "s/^RELEASE_SUMMARY_${key}=//"
  }

  summary_new_api_image="$(read_summary_value NEW_API_IMAGE)"
  summary_new_web_image="$(read_summary_value NEW_WEB_IMAGE)"
  summary_backup_path="$(read_summary_value BACKUP_PATH)"
  summary_rollback_containers="$(read_summary_value ROLLBACK_CONTAINERS)"
  summary_url_panel="$(read_summary_value URL_RESULT_PANEL)"
  summary_url_wizard="$(read_summary_value URL_RESULT_WIZARD)"
  summary_url_sqlite="$(read_summary_value URL_RESULT_SQLITE)"
  summary_status="$(read_summary_value STATUS)"
  summary_live_api_image="$(read_summary_value LIVE_API_IMAGE)"
  summary_live_web_image="$(read_summary_value LIVE_WEB_IMAGE)"
  summary_rollback_state="$(read_summary_value ROLLBACK_CONTAINERS_STATE)"
  summary_current_pointer="$(read_summary_value CURRENT_POINTER)"

  # Never invent a success: if the remote script didn't emit a status at
  # all (e.g. the SSH connection dropped), or it reported PASS/
  # PASS_WITH_WARNINGS but the invocation's own exit code was nonzero,
  # treat it as FAILED rather than trusting a possibly-incomplete summary.
  if [ -z "${summary_status}" ]; then
    summary_status="FAILED"
  fi
  if [ "${deploy_exit_code}" -ne 0 ]; then
    case "${summary_status}" in
      PASS|PASS_WITH_WARNINGS) summary_status="FAILED" ;;
    esac
  fi

  # The remote script now owns updating the VPS "current" source pointer
  # itself, as the last required step before it ever emits PASS — it is
  # not re-done here, and a rollback never reaches this point with the
  # pointer changed (the remote script only updates it after every other
  # verification step already succeeded).
  info "Current source pointer: ${summary_current_pointer:-unchanged}"

  info "Commit SHA: ${COMMIT_SHA}"
  info "API changed: ${API_CHANGED}"
  info "Web changed: ${WEB_CHANGED}"
  info "Previous API image: ${PREVIOUS_API_IMAGE:-unknown}"
  info "New API image (built): ${summary_new_api_image:-n/a}"
  info "Live API image: ${summary_live_api_image:-n/a}"
  info "Previous web image: ${PREVIOUS_WEB_IMAGE:-unknown}"
  info "New web image (built): ${summary_new_web_image:-n/a}"
  info "Live web image: ${summary_live_web_image:-n/a}"
  info "Database backup path: ${summary_backup_path:-none}"
  info "Rollback containers: ${summary_rollback_containers:-none} (${summary_rollback_state:-n/a})"
  info "Release directory: ${REMOTE_RELEASE_DIR}"
  # Labels come from the configured URLs, never hard-coded hostnames: the
  # operator-facing summary previously printed hookstats.com regardless of
  # which server was actually deployed to.
  info "Panel URL (${PUBLIC_URL_PANEL}): ${summary_url_panel:-not checked}"
  report_optional_url_result "Wizard test URL" "${PUBLIC_URL_WIZARD_TEST}" "${summary_url_wizard}"
  report_optional_url_result "SQLite test URL" "${PUBLIC_URL_SQLITE_TEST}" "${summary_url_sqlite}"

  # Status meanings, kept distinct and never collapsed together:
  #   PASS                 — deployment succeeded, verified, and the
  #                          current source pointer was updated.
  #   PASS_WITH_WARNINGS   — deployment succeeded and is live and
  #                          verified, but a non-critical post-success
  #                          step (currently: the current source
  #                          pointer) did not complete. Live containers
  #                          were NOT rolled back for this.
  #   FAILED               — failed before any live container was touched.
  #   ROLLED_BACK          — a swap began, but the previous container(s)
  #                          were successfully restored.
  #   ROLLBACK_FAILED      — a swap began and restoration did NOT fully
  #                          succeed; treat as an incident requiring
  #                          immediate manual attention.
  info "Status: ${summary_status}"

  case "${summary_status}" in
    PASS)
      return 0
      ;;
    PASS_WITH_WARNINGS)
      info "PASS_WITH_WARNINGS: the deployment itself is live and verified. Review the warning above (likely the current source pointer) and fix it manually before the next release."
      return 0
      ;;
    ROLLBACK_FAILED)
      info "ROLLBACK_FAILED: do not assume either container is healthy — check the VPS manually right away."
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

# ============================================================
# CLI argument parsing
# ============================================================

COMMIT_MESSAGE=""
API_VERSION_OVERRIDE=""
WEB_VERSION_OVERRIDE=""
VERIFY_ONLY=0
PLAN_ONLY=0
NO_DEPLOY=0
AUTO_YES=0
RESUME_RELEASE_DIR=""
RESUME_MODE="both"
RESUME_COMMIT_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --message)
      [ "$#" -ge 2 ] || fail "--message requires a value"
      COMMIT_MESSAGE="$2"
      shift 2
      ;;
    --api-version)
      [ "$#" -ge 2 ] || fail "--api-version requires a value"
      API_VERSION_OVERRIDE="$2"
      shift 2
      ;;
    --web-version)
      [ "$#" -ge 2 ] || fail "--web-version requires a value"
      WEB_VERSION_OVERRIDE="$2"
      shift 2
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --plan-only)
      PLAN_ONLY=1
      shift
      ;;
    --no-deploy)
      NO_DEPLOY=1
      shift
      ;;
    --yes)
      AUTO_YES=1
      shift
      ;;
    --resume-release)
      [ "$#" -ge 2 ] || fail "--resume-release requires a value"
      RESUME_RELEASE_DIR="$2"
      shift 2
      ;;
    --resume-mode)
      [ "$#" -ge 2 ] || fail "--resume-mode requires a value"
      RESUME_MODE="$2"
      shift 2
      ;;
    --resume-commit)
      [ "$#" -ge 2 ] || fail "--resume-commit requires a value"
      RESUME_COMMIT_OVERRIDE="$2"
      shift 2
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      print_help
      exit 1
      ;;
  esac
done

if [ "${VERIFY_ONLY}" -eq 1 ] && [ "${PLAN_ONLY}" -eq 1 ]; then
  fail "Use either --verify-only or --plan-only, not both."
fi

if [ -n "${API_VERSION_OVERRIDE}" ] && ! is_valid_semver "${API_VERSION_OVERRIDE}"; then
  fail "--api-version must be a semantic version like 1.2.3 (got: ${API_VERSION_OVERRIDE})"
fi

if [ -n "${WEB_VERSION_OVERRIDE}" ] && ! is_valid_semver "${WEB_VERSION_OVERRIDE}"; then
  fail "--web-version must be a semantic version like 1.2.3 (got: ${WEB_VERSION_OVERRIDE})"
fi

if [ -n "${RESUME_RELEASE_DIR}" ]; then
  case "${RESUME_MODE}" in
    api|web|both) ;;
    *) fail "--resume-mode must be one of: api, web, both (got: ${RESUME_MODE})" ;;
  esac
  if [ "${VERIFY_ONLY}" -eq 1 ] || [ "${PLAN_ONLY}" -eq 1 ] || [ "${NO_DEPLOY}" -eq 1 ]; then
    fail "--resume-release cannot be combined with --verify-only, --plan-only, or --no-deploy."
  fi
  if [ -n "${COMMIT_MESSAGE}" ]; then
    fail "--resume-release does not create a commit — --message has no effect and cannot be combined with it."
  fi
fi

load_config_file "${CONFIG_FILE}"
require_tools

# ============================================================
# --resume-release: redeploy an already-committed, already-synced
# release directory without touching local Git state.
# ============================================================

if [ -n "${RESUME_RELEASE_DIR}" ]; then
  print_header "LOCAL PRE-FLIGHT (resume)"

  REPO_TOPLEVEL="$(cd "${SCRIPT_DIR}" && git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "${REPO_TOPLEVEL}" ]; then
    fail "This does not look like a Git repository: ${SCRIPT_DIR}"
  fi

  EXPECTED_TOPLEVEL="$(cd "${LOCAL_PROJECT_DIR}" && pwd -P)"
  ACTUAL_TOPLEVEL="$(cd "${REPO_TOPLEVEL}" && pwd -P)"
  if [ "${ACTUAL_TOPLEVEL}" != "${EXPECTED_TOPLEVEL}" ]; then
    fail "release.sh must run from ${LOCAL_PROJECT_DIR} (found repo at ${ACTUAL_TOPLEVEL})"
  fi

  cd "${LOCAL_PROJECT_DIR}"
  info "Repository: ${LOCAL_PROJECT_DIR}"
  info "Resume mode: skipping local build, tests, staging, commit, and source sync."
  info "The already-committed, already-synced release directory below is used as-is."

  print_header "RESUME RELEASE"

  validate_resume_release_path "${RESUME_RELEASE_DIR}"

  RESUME_EXPECTED_COMMIT="${RESUME_COMMIT_OVERRIDE:-$(git rev-parse HEAD)}"
  RESUME_EXPECTED_COMMIT_SHORT="${RESUME_EXPECTED_COMMIT:0:12}"

  if [ "${RESUME_DIR_COMMIT_SUFFIX}" != "${RESUME_EXPECTED_COMMIT_SHORT}" ]; then
    fail "Release directory commit suffix (${RESUME_DIR_COMMIT_SUFFIX}) does not match the expected commit (${RESUME_EXPECTED_COMMIT_SHORT}). Pass --resume-commit <sha> to override if this is intentional, or check out the matching commit first."
  fi
  info "Commit match confirmed: ${RESUME_EXPECTED_COMMIT_SHORT}"

  if ! ssh_quiet true; then
    fail "Could not reach the VPS (${VPS_HOST})."
  fi

  if ! ssh_quiet test -d "${RESUME_RELEASE_DIR}"; then
    fail "Release directory not found on VPS: ${RESUME_RELEASE_DIR}"
  fi

  for check_path in "package.json" "apps/api/Dockerfile" "apps/web/Dockerfile"; do
    if ! ssh_quiet test -f "${RESUME_RELEASE_DIR}/${check_path}"; then
      fail "Expected file missing in release directory: ${RESUME_RELEASE_DIR}/${check_path}"
    fi
  done
  info "Release directory verified on VPS (package.json, both Dockerfiles present)."

  DEPLOY_MODE="${RESUME_MODE}"
  API_CHANGED="no"
  WEB_CHANGED="no"
  if [ "${DEPLOY_MODE}" = "api" ] || [ "${DEPLOY_MODE}" = "both" ]; then
    API_CHANGED="yes"
  fi
  if [ "${DEPLOY_MODE}" = "web" ] || [ "${DEPLOY_MODE}" = "both" ]; then
    WEB_CHANGED="yes"
  fi

  PREVIOUS_API_IMAGE=""
  PREVIOUS_WEB_IMAGE=""
  PREVIOUS_API_VERSION="unknown"
  PREVIOUS_WEB_VERSION="unknown"

  if [ "${API_CHANGED}" = "yes" ]; then
    PREVIOUS_API_IMAGE="$(ssh_run docker inspect --format '{{.Config.Image}}' "${API_CONTAINER}" 2>/dev/null || true)"
    [ -n "${PREVIOUS_API_IMAGE}" ] && PREVIOUS_API_VERSION="$(extract_tag "${PREVIOUS_API_IMAGE}")"
    if [ "${PREVIOUS_API_VERSION}" = "unknown" ]; then
      fail "Could not inspect the current API container/image on the VPS."
    fi
  fi

  if [ "${WEB_CHANGED}" = "yes" ]; then
    PREVIOUS_WEB_IMAGE="$(ssh_run docker inspect --format '{{.Config.Image}}' "${WEB_CONTAINER}" 2>/dev/null || true)"
    [ -n "${PREVIOUS_WEB_IMAGE}" ] && PREVIOUS_WEB_VERSION="$(extract_tag "${PREVIOUS_WEB_IMAGE}")"
    if [ "${PREVIOUS_WEB_VERSION}" = "unknown" ]; then
      fail "Could not inspect the current web container/image on the VPS."
    fi
  fi

  NEW_API_VERSION="${PREVIOUS_API_VERSION}"
  NEW_WEB_VERSION="${PREVIOUS_WEB_VERSION}"
  [ "${API_CHANGED}" = "yes" ] && NEW_API_VERSION="$(compute_next_version "${PREVIOUS_API_VERSION}" "yes" "${API_VERSION_OVERRIDE}")"
  [ "${WEB_CHANGED}" = "yes" ] && NEW_WEB_VERSION="$(compute_next_version "${PREVIOUS_WEB_VERSION}" "yes" "${WEB_VERSION_OVERRIDE}")"

  info "Current API image: ${PREVIOUS_API_IMAGE:-unknown}"
  info "Current web image: ${PREVIOUS_WEB_IMAGE:-unknown}"
  info "Proposed API version: ${NEW_API_VERSION} (included: ${API_CHANGED})"
  info "Proposed web version: ${NEW_WEB_VERSION} (included: ${WEB_CHANGED})"

  COMMIT_SHA="${RESUME_EXPECTED_COMMIT}"
  REMOTE_RELEASE_DIR="${RESUME_RELEASE_DIR}"

  if run_remote_deploy_and_report; then
    exit 0
  else
    exit 1
  fi
fi

# ============================================================
# 1. LOCAL PRE-FLIGHT
# ============================================================

print_header "LOCAL PRE-FLIGHT"

REPO_TOPLEVEL="$(cd "${SCRIPT_DIR}" && git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${REPO_TOPLEVEL}" ]; then
  fail "This does not look like a Git repository: ${SCRIPT_DIR}"
fi

EXPECTED_TOPLEVEL="$(cd "${LOCAL_PROJECT_DIR}" && pwd -P)"
ACTUAL_TOPLEVEL="$(cd "${REPO_TOPLEVEL}" && pwd -P)"
if [ "${ACTUAL_TOPLEVEL}" != "${EXPECTED_TOPLEVEL}" ]; then
  fail "release.sh must run from ${LOCAL_PROJECT_DIR} (found repo at ${ACTUAL_TOPLEVEL})"
fi

cd "${LOCAL_PROJECT_DIR}"
info "Repository: ${LOCAL_PROJECT_DIR}"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${CURRENT_BRANCH}" != "main" ]; then
  fail "Releases may only run from the 'main' branch (current: ${CURRENT_BRANCH})"
fi
info "Branch: main"

if [ -f "${EXCLUDED_FILENAME_GENERATE_AUTH}" ]; then
  STAGED_GENERATE_AUTH="$(git diff --cached --name-only -- "${EXCLUDED_FILENAME_GENERATE_AUTH}" || true)"
  if [ -n "${STAGED_GENERATE_AUTH}" ]; then
    fail "${EXCLUDED_FILENAME_GENERATE_AUTH} is staged. Unstage it before running a release (this file is never allowed in a release)."
  fi
fi

# Collect git status once; every downstream step reads from this snapshot.
STATUS_FILE="$(new_tmp_file)"
git status --porcelain=v1 -- . > "${STATUS_FILE}"

MODIFIED_TRACKED=()
DELETED_TRACKED=()
UNTRACKED=()

while IFS= read -r line || [ -n "${line}" ]; do
  [ -n "${line}" ] || continue

  index_status="${line:0:1}"
  tree_status="${line:1:1}"
  path="${line:3}"

  case "${path}" in
    *' -> '*)
      path="${path#*-> }"
      ;;
  esac

  if [ "${index_status}" = "?" ] && [ "${tree_status}" = "?" ]; then
    UNTRACKED+=("${path}")
  elif [ "${tree_status}" = "D" ] || [ "${index_status}" = "D" ]; then
    DELETED_TRACKED+=("${path}")
  else
    MODIFIED_TRACKED+=("${path}")
  fi
done < "${STATUS_FILE}"

# git collapses a wholly-untracked directory into one entry ("docs/")
# rather than listing its files individually. Expand any such entry into
# the exact files it contains, so every later report/stage/secret-scan
# step ever sees real file paths — never a directory.
EXPANDED_UNTRACKED=()
for path in "${UNTRACKED[@]:-}"; do
  [ -n "${path:-}" ] || continue
  case "${path}" in
    */)
      while IFS= read -r nested_path || [ -n "${nested_path}" ]; do
        [ -n "${nested_path}" ] || continue
        EXPANDED_UNTRACKED+=("${nested_path}")
      done < <(git ls-files --others --exclude-standard -- "${path}")
      ;;
    *)
      EXPANDED_UNTRACKED+=("${path}")
      ;;
  esac
done
UNTRACKED=()
if [ ${#EXPANDED_UNTRACKED[@]} -gt 0 ]; then
  UNTRACKED=("${EXPANDED_UNTRACKED[@]}")
fi

# Secret-like untracked files must block the release outright. This list
# is deliberately conservative — a false positive just means the operator
# removes/renames the file or adds it to .gitignore.
for path in "${UNTRACKED[@]:-}"; do
  [ -n "${path:-}" ] || continue
  if is_secret_like_path "${path}"; then
    fail "Refusing to continue: untracked secret-like file present (${path}). Remove it or add it to .gitignore before releasing."
  fi
done

CHANGED_TRACKED_PATHS=()
for path in "${MODIFIED_TRACKED[@]:-}" "${DELETED_TRACKED[@]:-}"; do
  [ -n "${path:-}" ] || continue
  CHANGED_TRACKED_PATHS+=("${path}")
done

# Deliberately built as a real (possibly-empty) array above rather than
# inlining "${MODIFIED_TRACKED[@]:-}" "${DELETED_TRACKED[@]:-}" into the
# git invocation below: when both source arrays are empty, that fallback
# form passes git two empty-string pathspec arguments instead of zero,
# and git rejects an empty pathspec outright.
if [ ${#CHANGED_TRACKED_PATHS[@]} -gt 0 ]; then
  if ! git diff --check -- "${CHANGED_TRACKED_PATHS[@]}" 2>/dev/null; then
    fail "git diff --check found whitespace/conflict-marker issues. Fix them before releasing."
  fi
fi

info "Tracked modifications: ${#MODIFIED_TRACKED[@]}"
info "Tracked deletions: ${#DELETED_TRACKED[@]}"
info "Untracked files: ${#UNTRACKED[@]}"

# ============================================================
# 2. CHANGE DETECTION
# ============================================================

print_header "CHANGE DETECTION"

ALL_CHANGED_PATHS=()
for path in "${MODIFIED_TRACKED[@]:-}" "${DELETED_TRACKED[@]:-}"; do
  [ -n "${path:-}" ] || continue
  ALL_CHANGED_PATHS+=("${path}")
done

CANDIDATE_UNTRACKED=()
IGNORED_UNTRACKED=()
for path in "${UNTRACKED[@]:-}"; do
  [ -n "${path:-}" ] || continue
  if [ "${path}" = "${EXCLUDED_FILENAME_GENERATE_AUTH}" ]; then
    continue
  fi
  if is_allowed_untracked_path "${path}"; then
    CANDIDATE_UNTRACKED+=("${path}")
    ALL_CHANGED_PATHS+=("${path}")
  else
    IGNORED_UNTRACKED+=("${path}")
  fi
done

if [ ${#IGNORED_UNTRACKED[@]} -gt 0 ]; then
  info "Untracked files outside recognized project paths (not staged automatically, never counted as a change):"
  for path in "${IGNORED_UNTRACKED[@]}"; do
    info "  - ${path}"
  done
fi

if [ -f "${EXCLUDED_FILENAME_GENERATE_AUTH}" ]; then
  info "Note: ${EXCLUDED_FILENAME_GENERATE_AUTH} is present but permanently excluded — it never counts as a change."
fi

API_CHANGED="no"
WEB_CHANGED="no"
INSTALLER_CHANGED="no"

for path in "${ALL_CHANGED_PATHS[@]:-}"; do
  [ -n "${path:-}" ] || continue
  case "$(classify_path_scope "${path}")" in
    api) API_CHANGED="yes" ;;
    web) WEB_CHANGED="yes" ;;
    both) API_CHANGED="yes"; WEB_CHANGED="yes" ;;
  esac
  case "${path}" in
    installer/*)
      INSTALLER_CHANGED="yes"
      ;;
  esac
done

DOCS_ONLY="no"
if [ "${API_CHANGED}" = "no" ] && [ "${WEB_CHANGED}" = "no" ]; then
  DOCS_ONLY="yes"
fi

info "API changed: ${API_CHANGED}"
info "Web changed: ${WEB_CHANGED}"
info "Installer changed: ${INSTALLER_CHANGED}"
info "Documentation/script-only change: ${DOCS_ONLY}"

# The exact set of files this release would stage. Computed here (not
# just at commit time) so the no-change gate and --plan-only can both
# rely on it.
CANDIDATE_FILES=()
for path in "${MODIFIED_TRACKED[@]:-}" "${DELETED_TRACKED[@]:-}" "${CANDIDATE_UNTRACKED[@]:-}"; do
  [ -n "${path:-}" ] || continue
  [ "${path}" = "${EXCLUDED_FILENAME_GENERATE_AUTH}" ] && continue
  CANDIDATE_FILES+=("${path}")
done

has_releasable_changes() {
  [ ${#CANDIDATE_FILES[@]} -gt 0 ]
}

if ! has_releasable_changes; then
  print_header "NO CHANGES"
  info "No releasable changes were found (permanently-excluded and unrecognized untracked files do not count)."
  info "Nothing to release."
  exit 0
fi

info ""
info "Candidate files for this release:"
for path in "${CANDIDATE_FILES[@]}"; do
  info "  - ${path}"
done

# ============================================================
# --plan-only: preview and stop
# ============================================================

if [ "${PLAN_ONLY}" -eq 1 ]; then
  print_header "RELEASE PLAN (--plan-only)"

  info "Release scope — API changed: ${API_CHANGED}, Web changed: ${WEB_CHANGED}, docs/script-only: ${DOCS_ONLY}"

  if [ "${DOCS_ONLY}" = "yes" ]; then
    info ""
    info "This is a documentation/script-only change. A real run would stage"
    info "and commit these files locally and would NOT contact the VPS."
    info ""
    info "--plan-only: no build, tests, staging, commit, sync, or deploy performed."
    exit 0
  fi

  VPS_REACHABLE=0
  if ssh_quiet true; then
    VPS_REACHABLE=1
  fi

  info ""
  if [ "${VPS_REACHABLE}" -eq 0 ]; then
    info "VPS unreachable — cannot preview current versions or runtime configuration."
  else
    if [ "${API_CHANGED}" = "yes" ]; then
      PLAN_PREVIOUS_API_IMAGE="$(ssh_run docker inspect --format '{{.Config.Image}}' "${API_CONTAINER}" 2>/dev/null || true)"
      PLAN_PREVIOUS_API_VERSION="unknown"
      [ -n "${PLAN_PREVIOUS_API_IMAGE}" ] && PLAN_PREVIOUS_API_VERSION="$(extract_tag "${PLAN_PREVIOUS_API_IMAGE}")"
      info "Current API image: ${PLAN_PREVIOUS_API_IMAGE:-unknown}"
      PLAN_NEW_API_VERSION="$(compute_next_version "${PLAN_PREVIOUS_API_VERSION}" "yes" "${API_VERSION_OVERRIDE}")"
      info "Proposed API version: ${PLAN_NEW_API_VERSION}"
      if is_bootstrap_tag "${PLAN_PREVIOUS_API_VERSION}"; then
        info "  First release for the API off installer bootstrap tag '${PLAN_PREVIOUS_API_VERSION}' — the version track would start at ${PLAN_NEW_API_VERSION}."
      elif ! is_valid_semver "${PLAN_NEW_API_VERSION}"; then
        info "  WARNING: '${PLAN_PREVIOUS_API_VERSION}' is neither a semantic version nor a recognized installer bootstrap tag. A real release would STOP here unless you pass --api-version <major.minor.patch>."
      fi
      info ""
      info "API container runtime settings that would be inspected and preserved:"
      ssh_run docker inspect --format '  restart policy: {{.HostConfig.RestartPolicy.Name}}
  entrypoint: {{json .Config.Entrypoint}}
  cmd: {{json .Config.Cmd}}
  workdir: {{.Config.WorkingDir}}
  user: {{.Config.User}}
  memory: {{.HostConfig.Memory}}
  nano cpus: {{.HostConfig.NanoCpus}}
  pids limit: {{.HostConfig.PidsLimit}}
  read-only rootfs: {{.HostConfig.ReadonlyRootfs}}
  mounts: {{range .Mounts}}{{.Destination}} {{end}}
  port bindings: {{json .HostConfig.PortBindings}}
  networks: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${API_CONTAINER}" 2>/dev/null || info "  (unable to inspect ${API_CONTAINER})"
      info ""
      info "The exact arguments used to reproduce this configuration are"
      info "computed at deploy time, against the newly built image — this is a"
      info "preview only."
    fi

    if [ "${WEB_CHANGED}" = "yes" ]; then
      PLAN_PREVIOUS_WEB_IMAGE="$(ssh_run docker inspect --format '{{.Config.Image}}' "${WEB_CONTAINER}" 2>/dev/null || true)"
      PLAN_PREVIOUS_WEB_VERSION="unknown"
      [ -n "${PLAN_PREVIOUS_WEB_IMAGE}" ] && PLAN_PREVIOUS_WEB_VERSION="$(extract_tag "${PLAN_PREVIOUS_WEB_IMAGE}")"
      info ""
      info "Current web image: ${PLAN_PREVIOUS_WEB_IMAGE:-unknown}"
      PLAN_NEW_WEB_VERSION="$(compute_next_version "${PLAN_PREVIOUS_WEB_VERSION}" "yes" "${WEB_VERSION_OVERRIDE}")"
      info "Proposed web version: ${PLAN_NEW_WEB_VERSION}"
      if is_bootstrap_tag "${PLAN_PREVIOUS_WEB_VERSION}"; then
        info "  First release for the web app off installer bootstrap tag '${PLAN_PREVIOUS_WEB_VERSION}' — the version track would start at ${PLAN_NEW_WEB_VERSION}."
      elif ! is_valid_semver "${PLAN_NEW_WEB_VERSION}"; then
        info "  WARNING: '${PLAN_PREVIOUS_WEB_VERSION}' is neither a semantic version nor a recognized installer bootstrap tag. A real release would STOP here unless you pass --web-version <major.minor.patch>."
      fi
      info ""
      info "Web container runtime settings that would be inspected and preserved:"
      ssh_run docker inspect --format '  restart policy: {{.HostConfig.RestartPolicy.Name}}
  entrypoint: {{json .Config.Entrypoint}}
  cmd: {{json .Config.Cmd}}
  mounts: {{range .Mounts}}{{.Destination}} {{end}}
  port bindings: {{json .HostConfig.PortBindings}}
  networks: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${WEB_CONTAINER}" 2>/dev/null || info "  (unable to inspect ${WEB_CONTAINER})"
    fi
  fi

  info ""
  print_public_url_plan
  info ""
  info "Sync/deploy steps a real run would take:"
  info "  1. Sync committed source into a new immutable release directory on the VPS."
  info "  2. Build the changed image(s) from that directory."
  info "  3. Back up the database (VACUUM INTO) if the API changed."
  info "  4. Preserve the current container(s) under a rollback name, then swap."
  info "  5. Verify image/network/migration/health, then run public URL checks."
  info "  6. On success, point the VPS 'current' source symlink at the new release."
  info ""
  info "--plan-only: no build, tests, staging, commit, sync, or deploy performed."
  exit 0
fi

# ============================================================
# 2b. INSTALLER TESTS
# ============================================================
#
# Runs whenever this release touches installer/ — before the npm
# build/tests, before staging, before commit — so a broken installer
# change is caught as early and cheaply as possible. Never run for a
# release that doesn't touch installer/ at all (installer/tests/run.sh
# needs no Docker/root/VPS, but there is no reason to pay even its
# small runtime for an unrelated API/web-only release). This same code
# path also covers --verify-only, which stops before staging/commit
# further down but must still report on and run installer tests first.

if [ "${INSTALLER_CHANGED}" = "yes" ]; then
  print_header "INSTALLER TESTS"

  if [ ! -x "installer/tests/run.sh" ] && [ ! -f "installer/tests/run.sh" ]; then
    fail "installer/ changed but installer/tests/run.sh was not found."
  fi

  info "Running: bash installer/tests/run.sh"
  INSTALLER_TEST_LOG="$(new_tmp_file)"
  if bash installer/tests/run.sh > "${INSTALLER_TEST_LOG}" 2>&1; then
    info "Installer tests passed."
  else
    cat "${INSTALLER_TEST_LOG}" >&2
    fail "Installer tests failed. Nothing was staged, committed, synced, or deployed."
  fi
fi

# ============================================================
# 3. BUILD
# ============================================================

print_header "BUILD"

BUILD_LOG="$(new_tmp_file)"
info "Running: npm run build"
if ! npm run build > "${BUILD_LOG}" 2>&1; then
  tail -n 60 "${BUILD_LOG}" >&2
  fail "npm run build failed. See output above."
fi
info "npm run build completed successfully."

# ============================================================
# 4. TESTS
# ============================================================

print_header "TESTS"

TEST_LOG="$(new_tmp_file)"
info "Running: npm run test --workspace=@deployment-platform/api"
TEST_EXIT_CODE=0
npm run test --workspace=@deployment-platform/api > "${TEST_LOG}" 2>&1 || TEST_EXIT_CODE=$?

TEST_SUMMARY_PASS="$(grep -E '^# pass ' "${TEST_LOG}" | tail -n 1 || true)"
TEST_SUMMARY_FAIL="$(grep -E '^# fail ' "${TEST_LOG}" | tail -n 1 || true)"
TEST_SUMMARY_TOTAL="$(grep -E '^# tests ' "${TEST_LOG}" | tail -n 1 || true)"

if [ -n "${TEST_SUMMARY_TOTAL}" ]; then
  info "${TEST_SUMMARY_TOTAL}"
fi
if [ -n "${TEST_SUMMARY_PASS}" ]; then
  info "${TEST_SUMMARY_PASS}"
fi
if [ -n "${TEST_SUMMARY_FAIL}" ]; then
  info "${TEST_SUMMARY_FAIL}"
fi

if [ "${TEST_EXIT_CODE}" -ne 0 ]; then
  tail -n 80 "${TEST_LOG}" >&2
  fail "Backend tests failed (exit code ${TEST_EXIT_CODE}). See output above."
fi
info "Tests passed."

# ============================================================
# 5. RELEASE PLAN
# ============================================================

print_header "RELEASE PLAN"

VPS_REACHABLE=0
PREVIOUS_API_IMAGE=""
PREVIOUS_WEB_IMAGE=""
PREVIOUS_API_VERSION="unknown"
PREVIOUS_WEB_VERSION="unknown"

if [ "${DOCS_ONLY}" = "yes" ]; then
  if [ "${INSTALLER_CHANGED}" = "yes" ]; then
    info "Installer/script-only change."
  else
    info "Documentation/script-only change."
  fi
  info "This release will be committed locally only."
  info "The VPS will not be contacted."
  info "API and Web versions will not change."
else
  if ssh_quiet true; then
    VPS_REACHABLE=1
  fi

  remote_current_image_tag() {
    local container="$1"
    ssh_run docker inspect --format '{{.Config.Image}}' "${container}" 2>/dev/null || true
  }

  if [ "${VPS_REACHABLE}" -eq 1 ]; then
    PREVIOUS_API_IMAGE="$(remote_current_image_tag "${API_CONTAINER}")"
    PREVIOUS_WEB_IMAGE="$(remote_current_image_tag "${WEB_CONTAINER}")"
    [ -n "${PREVIOUS_API_IMAGE}" ] && PREVIOUS_API_VERSION="$(extract_tag "${PREVIOUS_API_IMAGE}")"
    [ -n "${PREVIOUS_WEB_IMAGE}" ] && PREVIOUS_WEB_VERSION="$(extract_tag "${PREVIOUS_WEB_IMAGE}")"
  fi

  VERSION_LOOKUP_MISSING=0
  if [ "${VPS_REACHABLE}" -eq 0 ]; then
    VERSION_LOOKUP_MISSING=1
  fi
  if [ "${API_CHANGED}" = "yes" ] && [ "${PREVIOUS_API_VERSION}" = "unknown" ]; then
    VERSION_LOOKUP_MISSING=1
  fi
  if [ "${WEB_CHANGED}" = "yes" ] && [ "${PREVIOUS_WEB_VERSION}" = "unknown" ]; then
    VERSION_LOOKUP_MISSING=1
  fi

  if [ "${VERSION_LOOKUP_MISSING}" -eq 1 ]; then
    if [ "${VERIFY_ONLY}" -eq 1 ]; then
      info "VPS unreachable or a needed container was not found — versions cannot be confirmed in --verify-only mode."
    else
      fail "Could not reach the VPS (${VPS_HOST}) or find the container(s) this release needs, to inspect the running image versions. Aborting before making any Git changes."
    fi
  fi

  NEW_API_VERSION="$(compute_next_version "${PREVIOUS_API_VERSION}" "${API_CHANGED}" "${API_VERSION_OVERRIDE}")"
  NEW_WEB_VERSION="$(compute_next_version "${PREVIOUS_WEB_VERSION}" "${WEB_CHANGED}" "${WEB_VERSION_OVERRIDE}")"

  info "Current API image: ${PREVIOUS_API_IMAGE:-unknown}"
  info "Current web image: ${PREVIOUS_WEB_IMAGE:-unknown}"
  info "Proposed API version: ${NEW_API_VERSION} (rebuild: ${API_CHANGED})"
  info "Proposed web version: ${NEW_WEB_VERSION} (rebuild: ${WEB_CHANGED})"

  if [ "${API_CHANGED}" = "yes" ] && is_bootstrap_tag "${PREVIOUS_API_VERSION}"; then
    info "First release for the API off installer bootstrap tag '${PREVIOUS_API_VERSION}' — starting the version track at ${NEW_API_VERSION}."
  fi
  if [ "${WEB_CHANGED}" = "yes" ] && is_bootstrap_tag "${PREVIOUS_WEB_VERSION}"; then
    info "First release for the web app off installer bootstrap tag '${PREVIOUS_WEB_VERSION}' — starting the version track at ${NEW_WEB_VERSION}."
  fi
fi

if [ "${VERIFY_ONLY}" -eq 1 ]; then
  info ""
  info "--verify-only: stopping before staging, committing, syncing, or deploying."
  exit 0
fi

# Past this point a real deployment will happen, so every version that
# will be sent to the VPS must already be a valid semantic version.
# --verify-only exits above precisely so it can still report on an
# unreachable VPS without tripping this gate.
if [ "${API_CHANGED}" = "yes" ]; then
  validate_release_version "API" "${NEW_API_VERSION}" "${PREVIOUS_API_VERSION}" "--api-version"
fi
if [ "${WEB_CHANGED}" = "yes" ]; then
  validate_release_version "web" "${NEW_WEB_VERSION}" "${PREVIOUS_WEB_VERSION}" "--web-version"
fi

# ============================================================
# 6. COMMIT
# ============================================================

print_header "COMMIT"

if [ ${#CHANGED_TRACKED_PATHS[@]} -gt 0 ]; then
  info "Diff stat:"
  git diff --stat -- "${CHANGED_TRACKED_PATHS[@]}" || true
  info ""
fi

info "Release scope — API changed: ${API_CHANGED}, Web changed: ${WEB_CHANGED}, docs/script-only: ${DOCS_ONLY}"

if [ -z "${COMMIT_MESSAGE}" ]; then
  printf '\nCommit message: '
  read -r COMMIT_MESSAGE || COMMIT_MESSAGE=""
fi

COMMIT_MESSAGE="$(printf '%s' "${COMMIT_MESSAGE}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "${COMMIT_MESSAGE}" ]; then
  fail "Commit message must not be empty."
fi

if [ "${#COMMIT_MESSAGE}" -gt 200 ]; then
  fail "Commit message is too long (${#COMMIT_MESSAGE} characters, max 200)."
fi

info ""
info "Proposed commit message: ${COMMIT_MESSAGE}"

if ! confirm "Stage and commit the files listed above?"; then
  info "Aborted by operator before committing."
  exit 1
fi

git add -- "${CANDIDATE_FILES[@]}"

if ! git diff --cached --check; then
  git reset -- "${CANDIDATE_FILES[@]}" >/dev/null 2>&1 || true
  fail "git diff --cached --check found issues in the staged changes. Nothing was committed."
fi

STAGED_GENERATE_AUTH_CHECK="$(git diff --cached --name-only -- "${EXCLUDED_FILENAME_GENERATE_AUTH}" || true)"
if [ -n "${STAGED_GENERATE_AUTH_CHECK}" ]; then
  git reset -- "${EXCLUDED_FILENAME_GENERATE_AUTH}" >/dev/null 2>&1 || true
  fail "${EXCLUDED_FILENAME_GENERATE_AUTH} ended up staged unexpectedly. Aborting without committing."
fi

if ! git commit -m "${COMMIT_MESSAGE}" >/dev/null; then
  fail "git commit failed. Nothing was deployed."
fi

COMMIT_SHA="$(git rev-parse HEAD)"
info "Committed: ${COMMIT_SHA}"

if [ "${DOCS_ONLY}" = "yes" ]; then
  print_header "RELEASE COMPLETE"
  info "Commit SHA: ${COMMIT_SHA}"
  info "API changed: no"
  info "Web changed: no"
  info "Installer changed: ${INSTALLER_CHANGED}"
  info "Local-only release: documentation/script-only change committed. The VPS was not contacted. API and Web image versions were not changed."
  info "Status: PASS"
  exit 0
fi

if [ "${NO_DEPLOY}" -eq 1 ]; then
  info ""
  info "--no-deploy: stopping before syncing source or contacting the VPS."
  exit 0
fi

# ============================================================
# 7. SOURCE SYNC
# ============================================================

print_header "SOURCE SYNC"

if [ "${VPS_REACHABLE}" -eq 0 ]; then
  fail "VPS is unreachable — commit ${COMMIT_SHA} was created locally, but source cannot be synced. Re-run with --no-deploy to inspect, or fix connectivity and re-run."
fi

# Every release is synced into its own, brand-new remote directory —
# never into a long-lived shared tree — so there is no --delete/exclude
# balancing act and no way for a stale file from an earlier release to
# influence this build's Docker context.
RELEASE_DIR_NAME="release-${RELEASE_TIMESTAMP}-${COMMIT_SHA:0:12}"
REMOTE_RELEASE_DIR="${VPS_SOURCE_DIR}/releases/${RELEASE_DIR_NAME}"

RSYNC_EXCLUDES=(
  --exclude=node_modules
  --exclude=dist
  --exclude=.git
  --exclude=.env
  --exclude=.env.*
  --exclude=auth.env
  --exclude="${EXCLUDED_FILENAME_GENERATE_AUTH}"
  --exclude=release-*.log
  --exclude=*.log
  --exclude=*.swp
  --exclude=.DS_Store
  --exclude=release.config
)

info "Creating immutable release directory: ${REMOTE_RELEASE_DIR}"
ssh_run mkdir -p "${REMOTE_RELEASE_DIR}"

info "Syncing ${LOCAL_PROJECT_DIR} -> ${VPS_USER}@${VPS_HOST}:${REMOTE_RELEASE_DIR}"
rsync -az -e "ssh -i ${SSH_KEY}" "${RSYNC_EXCLUDES[@]}" "${LOCAL_PROJECT_DIR}/" "${VPS_USER}@${VPS_HOST}:${REMOTE_RELEASE_DIR}/"

REMOTE_CHECK_PATHS=(
  "package.json"
  "package-lock.json"
  "apps/api/Dockerfile"
  "apps/web/Dockerfile"
  "apps/api/src/migrations/index.ts"
)

for check_path in "${REMOTE_CHECK_PATHS[@]}"; do
  if ! ssh_quiet test -f "${REMOTE_RELEASE_DIR}/${check_path}"; then
    fail "Expected file missing in the new release directory after sync: ${REMOTE_RELEASE_DIR}/${check_path}"
  fi
done

info "Source sync verified. This release will build from ${REMOTE_RELEASE_DIR} only."

# ============================================================
# 8. REMOTE PRE-FLIGHT / DEPLOY / RELEASE COMPLETE
# ============================================================

DEPLOY_MODE="api"
if [ "${API_CHANGED}" = "yes" ] && [ "${WEB_CHANGED}" = "yes" ]; then
  DEPLOY_MODE="both"
elif [ "${WEB_CHANGED}" = "yes" ]; then
  DEPLOY_MODE="web"
fi

if run_remote_deploy_and_report; then
  exit 0
else
  exit 1
fi
