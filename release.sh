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
PUBLIC_URL_PANEL="https://panel.hookstats.com"
PUBLIC_URL_WIZARD_TEST="https://wizard-test.apps.hookstats.com"
PUBLIC_URL_SQLITE_TEST="https://sqlite-test.apps.hookstats.com"

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

confirm() {
  local prompt="$1"
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
ssh_run() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes "${VPS_USER}@${VPS_HOST}" "$@"
}

ssh_quiet() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o ConnectTimeout=10 "${VPS_USER}@${VPS_HOST}" "$@" >/dev/null 2>&1
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

# Paths allowed to be picked up automatically when untracked (initial
# development of the release tooling itself, plus normal project trees).
# Anything untracked outside these roots is reported but never
# auto-staged.
is_allowed_untracked_path() {
  local path="$1"
  case "${path}" in
    apps/*|packages/*|scripts/*|docs/*|release.sh|release.config.example|README.md|*.md)
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

bump_patch() {
  local version="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<< "${version}"
  printf '%s.%s.%s' "${major}" "${minor}" "$((patch + 1))"
}

# compute_next_version <current-version-or-"unknown"> <changed:yes/no> <override>
compute_next_version() {
  local current="$1" changed="$2" override="$3"

  if [ -n "${override}" ]; then
    printf '%s' "${override}"
    return 0
  fi

  if [ "${changed}" = "yes" ] && [ "${current}" != "unknown" ] && [ -n "${current}" ]; then
    bump_patch "${current}"
    return 0
  fi

  printf '%s' "${current}"
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

load_config_file "${CONFIG_FILE}"
require_tools

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

for path in "${ALL_CHANGED_PATHS[@]:-}"; do
  [ -n "${path:-}" ] || continue
  case "$(classify_path_scope "${path}")" in
    api) API_CHANGED="yes" ;;
    web) WEB_CHANGED="yes" ;;
    both) API_CHANGED="yes"; WEB_CHANGED="yes" ;;
  esac
done

DOCS_ONLY="no"
if [ "${API_CHANGED}" = "no" ] && [ "${WEB_CHANGED}" = "no" ]; then
  DOCS_ONLY="yes"
fi

info "API changed: ${API_CHANGED}"
info "Web changed: ${WEB_CHANGED}"
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
      info "Proposed API version: $(compute_next_version "${PLAN_PREVIOUS_API_VERSION}" "yes" "${API_VERSION_OVERRIDE}")"
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
      info "Proposed web version: $(compute_next_version "${PLAN_PREVIOUS_WEB_VERSION}" "yes" "${WEB_VERSION_OVERRIDE}")"
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
  info "Documentation/script-only change — skipping remote version inspection."
  info "This release will be committed locally only; the VPS will not be contacted."
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
fi

if [ "${VERIFY_ONLY}" -eq 1 ]; then
  info ""
  info "--verify-only: stopping before staging, committing, syncing, or deploying."
  exit 0
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
  info "Local-only release: documentation/script-only change committed. The VPS was not contacted."
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
REMOTE_CURRENT_SYMLINK="${VPS_SOURCE_DIR}/current"

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
# 8. REMOTE PRE-FLIGHT / DEPLOY
# ============================================================

print_header "REMOTE PRE-FLIGHT"

DEPLOY_MODE="api"
if [ "${API_CHANGED}" = "yes" ] && [ "${WEB_CHANGED}" = "yes" ]; then
  DEPLOY_MODE="both"
elif [ "${WEB_CHANGED}" = "yes" ]; then
  DEPLOY_MODE="web"
fi

info "Deploy mode: ${DEPLOY_MODE}"
info "API: ${PREVIOUS_API_VERSION} -> ${NEW_API_VERSION}"
info "Web: ${PREVIOUS_WEB_VERSION} -> ${NEW_WEB_VERSION}"

if ! confirm "Proceed with the remote build and deployment described above?"; then
  info "Aborted by operator before deployment. Commit ${COMMIT_SHA} was already created and source was already synced to ${REMOTE_RELEASE_DIR}."
  exit 1
fi

if [ ! -f "${REMOTE_SCRIPT_LOCAL_PATH}" ]; then
  fail "Remote deployment script not found: ${REMOTE_SCRIPT_LOCAL_PATH}"
fi

REMOTE_SCRIPT_REMOTE_PATH="$(ssh_run mktemp /tmp/release-remote.XXXXXX)"
scp -i "${SSH_KEY}" "${REMOTE_SCRIPT_LOCAL_PATH}" "${VPS_USER}@${VPS_HOST}:${REMOTE_SCRIPT_REMOTE_PATH}" >/dev/null
ssh_run chmod 700 "${REMOTE_SCRIPT_REMOTE_PATH}"

REMOTE_ARGS=(
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
  --url-wizard-test "${PUBLIC_URL_WIZARD_TEST}"
  --url-sqlite-test "${PUBLIC_URL_SQLITE_TEST}"
)

# Build a safely quoted remote command string. Every argument is our own
# fixed configuration or a validated semver string — none of it is
# operator-supplied free text that reaches the shell unquoted.
REMOTE_COMMAND=""
for arg in "${REMOTE_ARGS[@]}"; do
  REMOTE_COMMAND="${REMOTE_COMMAND}$(printf '%q ' "${arg}")"
done

REMOTE_LOG="$(new_tmp_file)"
DEPLOY_EXIT_CODE=0
ssh -i "${SSH_KEY}" -o BatchMode=yes "${VPS_USER}@${VPS_HOST}" "${REMOTE_COMMAND}" 2>&1 | tee "${REMOTE_LOG}" || DEPLOY_EXIT_CODE=$?

ssh_quiet rm -f "${REMOTE_SCRIPT_REMOTE_PATH}" || true
REMOTE_CLEANUP_DONE=1

# ============================================================
# 9. RELEASE COMPLETE
# ============================================================

print_header "RELEASE COMPLETE"

read_summary_value() {
  local key="$1"
  grep -E "^RELEASE_SUMMARY_${key}=" "${REMOTE_LOG}" | tail -n 1 | sed -e "s/^RELEASE_SUMMARY_${key}=//"
}

SUMMARY_NEW_API_IMAGE="$(read_summary_value NEW_API_IMAGE)"
SUMMARY_NEW_WEB_IMAGE="$(read_summary_value NEW_WEB_IMAGE)"
SUMMARY_BACKUP_PATH="$(read_summary_value BACKUP_PATH)"
SUMMARY_ROLLBACK_CONTAINERS="$(read_summary_value ROLLBACK_CONTAINERS)"
SUMMARY_URL_PANEL="$(read_summary_value URL_RESULT_PANEL)"
SUMMARY_URL_WIZARD="$(read_summary_value URL_RESULT_WIZARD)"
SUMMARY_URL_SQLITE="$(read_summary_value URL_RESULT_SQLITE)"
SUMMARY_STATUS="$(read_summary_value STATUS)"

DEPLOY_SUCCEEDED=1
if [ "${DEPLOY_EXIT_CODE}" -ne 0 ] || [ "${SUMMARY_STATUS}" = "ROLLED_BACK" ] || [ "${SUMMARY_STATUS}" = "FAILED" ] || [ -z "${SUMMARY_STATUS}" ]; then
  DEPLOY_SUCCEEDED=0
fi

if [ "${DEPLOY_SUCCEEDED}" -eq 1 ]; then
  info "Deployment verified successfully — updating the VPS 'current' source pointer."
  if ssh_run ln -sfn "${REMOTE_RELEASE_DIR}" "${REMOTE_CURRENT_SYMLINK}"; then
    info "current -> ${REMOTE_RELEASE_DIR}"
  else
    info "WARNING: deployment succeeded but updating the 'current' symlink failed. The release directory is still ${REMOTE_RELEASE_DIR}."
  fi
else
  info "Deployment did not succeed — the VPS 'current' source pointer was left unchanged."
fi

info "Commit SHA: ${COMMIT_SHA}"
info "API changed: ${API_CHANGED}"
info "Web changed: ${WEB_CHANGED}"
info "Previous API image: ${PREVIOUS_API_IMAGE:-unknown}"
info "New API image: ${SUMMARY_NEW_API_IMAGE:-n/a}"
info "Previous web image: ${PREVIOUS_WEB_IMAGE:-unknown}"
info "New web image: ${SUMMARY_NEW_WEB_IMAGE:-n/a}"
info "Database backup path: ${SUMMARY_BACKUP_PATH:-none}"
info "Rollback containers preserved: ${SUMMARY_ROLLBACK_CONTAINERS:-none}"
info "Release directory: ${REMOTE_RELEASE_DIR}"
info "panel.hookstats.com: ${SUMMARY_URL_PANEL:-not checked}"
info "wizard-test.apps.hookstats.com: ${SUMMARY_URL_WIZARD:-not checked}"
info "sqlite-test.apps.hookstats.com: ${SUMMARY_URL_SQLITE:-not checked}"

if [ "${DEPLOY_SUCCEEDED}" -eq 0 ]; then
  info "Status: FAILED/ROLLED BACK"
  exit 1
fi

info "Status: PASS"
exit 0
