#!/usr/bin/env bash
#
# release-remote.sh — VPS-side Docker build/deploy/rollback logic for the
# Deployment Platform. Invoked by release.sh over SSH; never run this
# directly against production unless you understand every flag below.
#
# This script is fully parameterized — it has no hidden dependency on
# release.sh's variable names. Every path/name it needs is passed in as a
# flag. --source-dir is expected to be a release-specific, immutable
# directory (release.sh creates a fresh one per release) — this script
# never deletes or mutates anything outside it, and never deletes it
# either.
#
set -Eeuo pipefail

# ============================================================
# Argument parsing
# ============================================================

MODE=""
SOURCE_DIR=""
AUTH_FILE=""
PLATFORM_ENV_FILE=""
CADDY_ROUTES_DIR=""
DEPLOY_CADDY_CONFIG=0
DEPLOY_INSTALLER=0
INSTALL_ROOT=""
PANEL_DOMAIN=""
CADDY_CONTAINER="deployment-platform-caddy"
CADDY_CONFIG_FILE=""
API_CONTAINER=""
WEB_CONTAINER=""
API_IMAGE_REPO=""
WEB_IMAGE_REPO=""
PLATFORM_NETWORK=""
APPS_NETWORK=""
API_DATA_VOLUME=""
API_VERSION=""
WEB_VERSION=""
PREVIOUS_API_VERSION=""
PREVIOUS_WEB_VERSION=""
URL_PANEL=""
URL_WIZARD_TEST=""
URL_SQLITE_TEST=""
CURRENT_SYMLINK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --auth-file) AUTH_FILE="$2"; shift 2 ;;
    --platform-env-file) PLATFORM_ENV_FILE="$2"; shift 2 ;;
    --caddy-routes-dir) CADDY_ROUTES_DIR="$2"; shift 2 ;;
    --deploy-caddy-config) DEPLOY_CADDY_CONFIG=1; shift ;;
    --deploy-installer) DEPLOY_INSTALLER=1; shift ;;
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --panel-domain) PANEL_DOMAIN="$2"; shift 2 ;;
    --caddy-container) CADDY_CONTAINER="$2"; shift 2 ;;
    --caddy-config-file) CADDY_CONFIG_FILE="$2"; shift 2 ;;
    --api-container) API_CONTAINER="$2"; shift 2 ;;
    --web-container) WEB_CONTAINER="$2"; shift 2 ;;
    --api-image-repo) API_IMAGE_REPO="$2"; shift 2 ;;
    --web-image-repo) WEB_IMAGE_REPO="$2"; shift 2 ;;
    --platform-network) PLATFORM_NETWORK="$2"; shift 2 ;;
    --apps-network) APPS_NETWORK="$2"; shift 2 ;;
    --api-data-volume) API_DATA_VOLUME="$2"; shift 2 ;;
    --api-version) API_VERSION="$2"; shift 2 ;;
    --web-version) WEB_VERSION="$2"; shift 2 ;;
    --previous-api-version) PREVIOUS_API_VERSION="$2"; shift 2 ;;
    --previous-web-version) PREVIOUS_WEB_VERSION="$2"; shift 2 ;;
    --url-panel) URL_PANEL="$2"; shift 2 ;;
    --url-wizard-test) URL_WIZARD_TEST="$2"; shift 2 ;;
    --url-sqlite-test) URL_SQLITE_TEST="$2"; shift 2 ;;
    --current-symlink) CURRENT_SYMLINK="$2"; shift 2 ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

SEMVER_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'

# Sanitizes a previous-version string for use inside a Docker container
# name. PREVIOUS_API_VERSION / PREVIOUS_WEB_VERSION are deliberately NOT
# semver-validated: on the first release after a guided install the
# running tag is legitimately an installer bootstrap tag such as
# bootstrap-unknown or bootstrap-local-<hex>, and the rollback container
# must still be able to preserve it. Those tags are already valid Docker
# name characters, so this only guards the empty case (which would
# otherwise produce an ambiguous "...-rollback--<timestamp>") and any
# stray character a tag could theoretically carry.
container_name_fragment() {
  local raw="$1"
  local cleaned
  cleaned="$(printf '%s' "${raw}" | tr -c 'A-Za-z0-9_.-' '-')"
  if [ -z "${cleaned}" ]; then
    printf 'unknown-version'
    return 0
  fi
  printf '%s' "${cleaned}"
}

is_valid_semver() {
  [[ "$1" =~ ${SEMVER_PATTERN} ]]
}

# "caddy" is a CONFIG-ONLY mode: it deploys a regenerated Caddyfile
# and/or refreshes the installed installer copy, and builds/swaps no
# images at all. It exists because a Caddy routing change is a real,
# deployable change to a running server that touches neither apps/api nor
# apps/web — previously such a change was classified as local-only and
# silently never reached the VPS, which is how a broken /api prefix
# stayed live.
#
# The mode does NOT imply either deploy flag: an installer-only release
# must not be required to supply Caddy arguments, and vice versa. It only
# requires that there is at least one thing to do.
case "${MODE}" in
  api|web|both) ;;
  caddy)
    if [ "${DEPLOY_CADDY_CONFIG}" -eq 0 ] && [ "${DEPLOY_INSTALLER}" -eq 0 ]; then
      printf 'ERROR: --mode caddy requires --deploy-caddy-config, --deploy-installer, or both.\n' >&2
      exit 1
    fi
    ;;
  *)
    printf 'ERROR: --mode must be one of: api, web, both, caddy (got: %s)\n' "${MODE}" >&2
    exit 1
    ;;
esac

if [ "${DEPLOY_INSTALLER}" -eq 1 ] && [ -z "${INSTALL_ROOT}" ]; then
  printf 'ERROR: --deploy-installer requires --install-root\n' >&2
  exit 1
fi

if [ "${DEPLOY_CADDY_CONFIG}" -eq 1 ]; then
  for caddy_required in PANEL_DOMAIN CADDY_CONTAINER CADDY_CONFIG_FILE; do
    if [ -z "${!caddy_required}" ]; then
      printf 'ERROR: --deploy-caddy-config requires --%s\n' "$(printf '%s' "${caddy_required}" | tr '[:upper:]_' '[:lower:]-')" >&2
      exit 1
    fi
  done
fi

# URL_WIZARD_TEST and URL_SQLITE_TEST are deliberately NOT in this list.
# They point at deployed test apps, which do not exist on a freshly
# installed server, so requiring them made the first release after an
# install impossible. Empty means the check is explicitly disabled and is
# reported as SKIPPED. URL_PANEL stays mandatory — it is the platform's
# own dashboard and exists on every installation.
for required in SOURCE_DIR AUTH_FILE PLATFORM_ENV_FILE CADDY_ROUTES_DIR API_CONTAINER WEB_CONTAINER \
  API_IMAGE_REPO WEB_IMAGE_REPO PLATFORM_NETWORK APPS_NETWORK API_DATA_VOLUME \
  URL_PANEL; do
  if [ -z "${!required}" ]; then
    printf 'ERROR: missing required --%s\n' "$(printf '%s' "${required}" | tr '[:upper:]_' '[:lower:]-')" >&2
    exit 1
  fi
done

# Config-only mode builds no image, so it needs no version at all.
if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  is_valid_semver "${API_VERSION}" || { printf 'ERROR: --api-version invalid: %s\n' "${API_VERSION}" >&2; exit 1; }
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  is_valid_semver "${WEB_VERSION}" || { printf 'ERROR: --web-version invalid: %s\n' "${WEB_VERSION}" >&2; exit 1; }
fi

RELEASE_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ============================================================
# Utilities
# ============================================================

CURRENT_STAGE="startup"
print_header() {
  CURRENT_STAGE="$1"
  printf '\n===== %s =====\n' "$1"
}

info() {
  printf '%s\n' "$1"
}

TMP_FILES=()
new_tmp_file() {
  local path
  path="$(mktemp "/tmp/release-remote.XXXXXX")"
  # Explicit, not just relying on umask defaults — these files can hold
  # captured container environments and other sensitive config.
  chmod 600 "${path}"
  TMP_FILES+=("${path}")
  printf '%s' "${path}"
}

cleanup_tmp_files() {
  # Deliberately built with `if` blocks and an explicit final `return 0`
  # rather than a chained `[ -n ] && [ -e ] && rm -f`: the chained form's
  # own exit status (false whenever the last-checked file no longer
  # exists) becomes this function's exit status, and — because `set -E`
  # (errtrace) propagates ERR into trap handlers — a false chain here can
  # re-fire the ERR trap even when every real deployment step already
  # succeeded. This function must never fail, since it also runs as the
  # EXIT trap after a successful release.
  local path
  if [ "${#TMP_FILES[@]}" -gt 0 ]; then
    for path in "${TMP_FILES[@]}"; do
      if [ -n "${path}" ] && [ -e "${path}" ]; then
        rm -f "${path}" || true
      fi
    done
  fi
  return 0
}
trap cleanup_tmp_files EXIT

# This VPS deliberately has no host-level Node installation — Node only
# ever runs inside Docker images (the API image at runtime, and this
# pinned helper image for the structured JSON parsing this script itself
# needs). Only genuinely host-level tools belong here.
require_tools() {
  local tool
  for tool in docker curl openssl; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      printf 'ERROR: required tool not found on VPS: %s\n' "${tool}" >&2
      exit 1
    fi
  done
}

# ============================================================
# Dockerized Node helper — replaces every former host `node` call
# ============================================================
#
# Pinned, non-floating tag: never "latest". Pulled (if missing) during
# remote pre-flight, before any live container is touched, so a pull
# failure is reported as FAILED rather than surfacing partway through a
# swap.
NODE_HELPER_IMAGE="node:24-alpine"

ensure_node_helper_image() {
  if docker image inspect "${NODE_HELPER_IMAGE}" >/dev/null 2>&1; then
    info "Runtime parser: Dockerized Node ${NODE_HELPER_IMAGE} (already present)"
    return 0
  fi

  info "Pulling runtime parser image ${NODE_HELPER_IMAGE}..."
  if ! docker pull "${NODE_HELPER_IMAGE}" >/dev/null; then
    fail "Unable to pull the required runtime-parser image (${NODE_HELPER_IMAGE}). Nothing has been changed yet."
  fi
  info "Runtime parser: Dockerized Node ${NODE_HELPER_IMAGE}"
}

# run_node_helper <script-file> [data-file...]
#
# Executes a Node script inside a throwaway, sandboxed node:24-alpine
# container: no network, no Docker socket, no capabilities, a read-only
# root filesystem (with a small tmpfs for /tmp), and running as the same
# uid/gid as the invoking shell rather than root. The script and every
# data file are bind-mounted read-only under /work by their own
# basenames and passed to the script as argv — nothing is inlined into
# the `docker run` command line itself, so none of the captured
# JSON/config content (which can include environment values) ever
# appears in argv, `ps` output, or shell history. This container only
# ever transforms already-captured text; it never touches Docker itself
# — every real `docker` command stays on the host, in this script.
run_node_helper() {
  local script_file="$1"
  shift

  local -a mounts=(-v "${script_file}:/work/script.js:ro")
  local -a container_args=()
  local arg base

  for arg in "$@"; do
    base="$(basename "${arg}")"
    mounts+=(-v "${arg}:/work/data/${base}:ro")
    container_args+=("/work/data/${base}")
  done

  docker run --rm \
    --network none \
    --user "$(id -u):$(id -g)" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --read-only \
    --tmpfs /tmp \
    "${mounts[@]}" \
    "${NODE_HELPER_IMAGE}" \
    node /work/script.js "${container_args[@]}" < /dev/null
}

# Sanitizes a block of log text before printing it — used for container
# logs, which may otherwise contain tokens, secrets, or cookies.
SANITIZE_PATTERN='token|authorization|password|secret|encryption[ _-]?key|encrypted[ _-]?payload|cookie'

print_sanitized_logs() {
  local raw="$1"
  printf '%s\n' "${raw}" | grep -viE "${SANITIZE_PATTERN}" || true
}

# ============================================================
# Rollback state and trap
# ============================================================

API_ROLLBACK_NAME=""
API_NEW_CREATED=0
API_NEW_STARTED=0
WEB_ROLLBACK_NAME=""
WEB_NEW_CREATED=0
WEB_NEW_STARTED=0
BACKUP_PATH=""
ROLLBACK_TRIGGERED=0
ANY_SWAP_PERFORMED=0

# Set to 1 the moment THIS run finishes building each image. Only an image
# this run created may be discarded on rollback — one that was already on
# the host is never this script's to remove.
API_IMAGE_BUILT_HERE=0
WEB_IMAGE_BUILT_HERE=0

# Set to 1 only once every required success action (container/migration/
# key/public-URL verification AND the current-source-pointer update) has
# completed. The ERR trap checks this before ever triggering a rollback,
# and it is also the point at which the ERR trap itself is disarmed —
# see section 6 below. Never set this early "to suppress an error";
# it must only ever become true after real success.
DEPLOYMENT_COMPLETE=0

emit_summary() {
  # Machine-parseable lines consumed by release.sh. Keep these as the
  # last thing this script prints so release.sh's log-tail parsing is
  # unambiguous. Fields 9-12 were added for rollback-summary accuracy;
  # release.sh parses by key name, so older/newer versions of either
  # script stay compatible.
  printf 'RELEASE_SUMMARY_NEW_API_IMAGE=%s\n' "${1}"
  printf 'RELEASE_SUMMARY_NEW_WEB_IMAGE=%s\n' "${2}"
  printf 'RELEASE_SUMMARY_BACKUP_PATH=%s\n' "${3}"
  printf 'RELEASE_SUMMARY_ROLLBACK_CONTAINERS=%s\n' "${4}"
  printf 'RELEASE_SUMMARY_URL_RESULT_PANEL=%s\n' "${5}"
  printf 'RELEASE_SUMMARY_URL_RESULT_WIZARD=%s\n' "${6}"
  printf 'RELEASE_SUMMARY_URL_RESULT_SQLITE=%s\n' "${7}"
  printf 'RELEASE_SUMMARY_STATUS=%s\n' "${8}"
  printf 'RELEASE_SUMMARY_LIVE_API_IMAGE=%s\n' "${9}"
  printf 'RELEASE_SUMMARY_LIVE_WEB_IMAGE=%s\n' "${10}"
  printf 'RELEASE_SUMMARY_ROLLBACK_CONTAINERS_STATE=%s\n' "${11}"
  printf 'RELEASE_SUMMARY_CURRENT_POINTER=%s\n' "${12}"
}

rollback_component() {
  local label="$1"
  local live_name="$2"
  local rollback_name="$3"
  local new_created="$4"
  local new_started="$5"

  if [ -z "${rollback_name}" ] && [ "${new_created}" -eq 0 ]; then
    return 0
  fi

  info "Rolling back ${label}..."

  if [ "${new_started}" -eq 1 ] || [ "${new_created}" -eq 1 ]; then
    if ! docker stop "${live_name}" >/dev/null 2>&1; then
      info "${label}: WARNING — failed to stop the replacement container ${live_name} during rollback. Check it manually."
    fi
    if ! docker rm "${live_name}" >/dev/null 2>&1; then
      info "${label}: WARNING — failed to remove the replacement container ${live_name} during rollback. Check it manually."
    fi
  fi

  if [ -n "${rollback_name}" ]; then
    if ! docker rename "${rollback_name}" "${live_name}"; then
      info "${label}: ERROR — failed to rename ${rollback_name} back to ${live_name}. It still exists under ${rollback_name} — restore it manually."
      return 1
    fi
    if ! docker start "${live_name}" >/dev/null; then
      info "${label}: ERROR — ${live_name} was restored but failed to start. Check it manually."
      return 1
    fi
    sleep 2
    if [ "$(docker inspect --format '{{.State.Running}}' "${live_name}" 2>/dev/null || true)" = "true" ]; then
      info "${label}: restored ${live_name} from ${rollback_name} and it is running."
    else
      info "${label}: restored ${live_name} from ${rollback_name} but it is NOT running. Manual attention required."
      return 1
    fi
  fi

  return 0
}

# Status semantics, kept distinct and never collapsed together:
#   FAILED          — failed before any live container was touched.
#   ROLLED_BACK     — a swap began, but the previous container(s) were
#                     successfully restored.
#   ROLLBACK_FAILED — a swap began AND restoration itself did not fully
#                     succeed; do not assume either app is healthy.
# An image built by THIS release is unreferenced once the containers are
# back on the previous version — and leaving it behind is not harmless: the
# next attempt computes the same version number from the (unchanged) live
# image and then fails its own "image tag already exists" guard, so a
# release that never shipped blocks every retry until someone deletes the
# tag by hand.
#
# Plain `docker rmi` — never `-f` — so Docker itself refuses if anything
# still references the tag. A failure to remove is reported and tolerated:
# rollback has already happened, and the platform is running.
discard_image_built_here() {
  local label="$1"
  local image="$2"
  local built_here="$3"
  local restored_ok="$4"

  [ "${built_here}" -eq 1 ] || return 0

  if [ "${restored_ok}" -ne 1 ]; then
    info "${label} image kept (container not fully restored, so it may still be in use): ${image}"
    return 0
  fi

  if docker rmi "${image}" >/dev/null 2>&1; then
    info "Removed the ${label} image built by this release: ${image}"
  else
    info "Could not remove the ${label} image built by this release: ${image}"
    info "  Remove it manually before retrying, or the next release will refuse the same tag."
  fi
}

trigger_rollback() {
  local reason="$1"

  if [ "${ROLLBACK_TRIGGERED}" -eq 1 ]; then
    return 0
  fi
  ROLLBACK_TRIGGERED=1

  print_header "AUTOMATIC ROLLBACK"
  info "Reason: ${reason}"

  # A deployed Caddy configuration is rolled back first: it is the
  # cheapest thing to undo and, unlike the containers, leaving it in a
  # new state while the containers revert would be inconsistent.
  if declare -F restore_caddy_config_on_failure >/dev/null 2>&1; then
    restore_caddy_config_on_failure
  fi
  # Same reasoning for the refreshed installer copy and CLI wrapper: the
  # maintenance tooling on disk must match whatever ends up running.
  if declare -F restore_installer_on_failure >/dev/null 2>&1; then
    restore_installer_on_failure
  fi

  local api_rollback_ok=1
  local web_rollback_ok=1

  if ! rollback_component "API" "${API_CONTAINER}" "${API_ROLLBACK_NAME}" "${API_NEW_CREATED}" "${API_NEW_STARTED}"; then
    api_rollback_ok=0
    info "API rollback encountered an error — see above. Do not assume the API container is healthy."
  fi
  if ! rollback_component "web" "${WEB_CONTAINER}" "${WEB_ROLLBACK_NAME}" "${WEB_NEW_CREATED}" "${WEB_NEW_STARTED}"; then
    web_rollback_ok=0
    info "Web rollback encountered an error — see above. Do not assume the web container is healthy."
  fi

  discard_image_built_here "API" "${API_IMAGE_REPO}:${API_VERSION}" "${API_IMAGE_BUILT_HERE}" "${api_rollback_ok}"
  discard_image_built_here "web" "${WEB_IMAGE_REPO}:${WEB_VERSION}" "${WEB_IMAGE_BUILT_HERE}" "${web_rollback_ok}"

  if [ -n "${BACKUP_PATH}" ]; then
    info "Database backup preserved at: ${BACKUP_PATH}"
  fi
  info "Release directory preserved for inspection: ${SOURCE_DIR}"

  local status="FAILED"
  if [ "${ANY_SWAP_PERFORMED}" -eq 1 ]; then
    status="ROLLED_BACK"
    if [ "${api_rollback_ok}" -eq 0 ] || [ "${web_rollback_ok}" -eq 0 ]; then
      status="ROLLBACK_FAILED"
      info "ROLLBACK_FAILED: restoration did not fully succeed — manual intervention required immediately."
    fi
  fi

  # Rollback container names only actually still exist under their
  # rollback-suffixed name if THAT component's restoration did not fully
  # succeed (rename-back failed, or the restored container didn't come
  # back up). Once rollback_component succeeds, the container has been
  # renamed back to its live name and no longer exists under the
  # rollback name — reporting it as "preserved" at that point would be
  # false, since it was consumed by the restore.
  local rollback_names=""
  local rollback_containers_state="n/a (no swap occurred)"
  if [ "${ANY_SWAP_PERFORMED}" -eq 1 ]; then
    if [ -n "${API_ROLLBACK_NAME}" ] && [ "${api_rollback_ok}" -eq 0 ]; then
      rollback_names="${rollback_names}${API_ROLLBACK_NAME} "
    fi
    if [ -n "${WEB_ROLLBACK_NAME}" ] && [ "${web_rollback_ok}" -eq 0 ]; then
      rollback_names="${rollback_names}${WEB_ROLLBACK_NAME} "
    fi
    if [ "${api_rollback_ok}" -eq 1 ] && [ "${web_rollback_ok}" -eq 1 ]; then
      rollback_containers_state="consumed (renamed back to live container names during restore)"
    else
      rollback_containers_state="NOT fully restored — still exists under the rollback name(s) above; manual intervention required"
    fi
  fi

  # Live image accuracy: on a rollback the newly built image is NOT live
  # (even though it still exists as an image on disk). The live image is
  # either the untouched original (no swap happened for this component)
  # or the restored previous version (swap happened and rollback
  # succeeded) or genuinely unknown (rollback for this component failed).
  local live_api_image="n/a"
  local live_web_image="n/a"
  if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
    if [ "${ANY_SWAP_PERFORMED}" -eq 0 ]; then
      live_api_image="${API_IMAGE_REPO}:${PREVIOUS_API_VERSION} (untouched)"
    elif [ "${api_rollback_ok}" -eq 1 ]; then
      live_api_image="${API_IMAGE_REPO}:${PREVIOUS_API_VERSION} (restored)"
    else
      live_api_image="UNKNOWN — restoration did not fully succeed, verify manually"
    fi
  fi
  if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
    if [ "${ANY_SWAP_PERFORMED}" -eq 0 ]; then
      live_web_image="${WEB_IMAGE_REPO}:${PREVIOUS_WEB_VERSION} (untouched)"
    elif [ "${web_rollback_ok}" -eq 1 ]; then
      live_web_image="${WEB_IMAGE_REPO}:${PREVIOUS_WEB_VERSION} (restored)"
    else
      live_web_image="UNKNOWN — restoration did not fully succeed, verify manually"
    fi
  fi

  print_header "RELEASE COMPLETE"
  emit_summary "n/a" "n/a" "${BACKUP_PATH}" "${rollback_names}" "not reached" "not reached" "not reached" "${status}" \
    "${live_api_image}" "${live_web_image}" "${rollback_containers_state}" "unchanged (rollback occurred before any pointer update)"
}

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  trigger_rollback "$1"
  exit 1
}

on_err() {
  local exit_code=$?
  local line_no="${BASH_LINENO[0]:-0}"

  # The deployment already reached full success and disarmed this trap
  # before printing PASS (see section 6); if it still somehow fires past
  # that point (e.g. from best-effort bookkeeping after the trap removal
  # itself), it must never roll back an already-verified, already-live
  # release. This is a backstop, not the fix — the actual fix is
  # disarming the trap and correcting cleanup_tmp_files above.
  if [ "${DEPLOYMENT_COMPLETE}" -eq 1 ]; then
    return 0
  fi

  trigger_rollback "$(printf 'An unexpected command failure occurred during deployment.\nFailure stage: %s\nFailure line: %s\nExit code: %s' "${CURRENT_STAGE}" "${line_no}" "${exit_code}")"
}
trap on_err ERR

require_tools

# ============================================================
# 1. REMOTE PRE-FLIGHT
# ============================================================

print_header "REMOTE PRE-FLIGHT"

info "Mode: ${MODE}"
info "Source directory (immutable release): ${SOURCE_DIR}"

if [ ! -d "${SOURCE_DIR}" ]; then
  fail "Source directory not found on VPS: ${SOURCE_DIR}"
fi

if [ ! -f "${AUTH_FILE}" ]; then
  fail "Auth file not found: ${AUTH_FILE}"
fi

ensure_node_helper_image

check_network_exists() {
  docker network inspect "$1" >/dev/null 2>&1
}

if ! check_network_exists "${PLATFORM_NETWORK}"; then
  fail "Required network not found: ${PLATFORM_NETWORK}"
fi
if ! check_network_exists "${APPS_NETWORK}"; then
  fail "Required network not found: ${APPS_NETWORK}"
fi

API_ROLLBACK_TARGET_NAME=""
WEB_ROLLBACK_TARGET_NAME=""

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  if ! docker inspect "${API_CONTAINER}" >/dev/null 2>&1; then
    fail "API container not found: ${API_CONTAINER}"
  fi
  API_ROLLBACK_TARGET_NAME="${API_CONTAINER}-rollback-$(container_name_fragment "${PREVIOUS_API_VERSION}")-${RELEASE_TIMESTAMP}"
  if docker inspect "${API_ROLLBACK_TARGET_NAME}" >/dev/null 2>&1; then
    fail "Intended API rollback container name already exists: ${API_ROLLBACK_TARGET_NAME}"
  fi
  if docker image inspect "${API_IMAGE_REPO}:${API_VERSION}" >/dev/null 2>&1; then
    fail "API image tag already exists, refusing to overwrite: ${API_IMAGE_REPO}:${API_VERSION}"
  fi
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  if ! docker inspect "${WEB_CONTAINER}" >/dev/null 2>&1; then
    fail "Web container not found: ${WEB_CONTAINER}"
  fi
  WEB_ROLLBACK_TARGET_NAME="${WEB_CONTAINER}-rollback-$(container_name_fragment "${PREVIOUS_WEB_VERSION}")-${RELEASE_TIMESTAMP}"
  if docker inspect "${WEB_ROLLBACK_TARGET_NAME}" >/dev/null 2>&1; then
    fail "Intended web rollback container name already exists: ${WEB_ROLLBACK_TARGET_NAME}"
  fi
  if docker image inspect "${WEB_IMAGE_REPO}:${WEB_VERSION}" >/dev/null 2>&1; then
    fail "Web image tag already exists, refusing to overwrite: ${WEB_IMAGE_REPO}:${WEB_VERSION}"
  fi
fi

info "Pre-flight checks passed."

# ============================================================
# 2. IMAGE BUILD
# ============================================================

print_header "IMAGE BUILD"

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  info "Building ${API_IMAGE_REPO}:${API_VERSION}..."
  if ! docker build -f "${SOURCE_DIR}/apps/api/Dockerfile" -t "${API_IMAGE_REPO}:${API_VERSION}" "${SOURCE_DIR}"; then
    fail "API image build failed."
  fi
  API_IMAGE_BUILT_HERE=1
  info "API image built: ${API_IMAGE_REPO}:${API_VERSION}"
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  info "Building ${WEB_IMAGE_REPO}:${WEB_VERSION}..."
  if ! docker build -f "${SOURCE_DIR}/apps/web/Dockerfile" -t "${WEB_IMAGE_REPO}:${WEB_VERSION}" "${SOURCE_DIR}"; then
    fail "Web image build failed."
  fi
  WEB_IMAGE_BUILT_HERE=1
  info "Web image built: ${WEB_IMAGE_REPO}:${WEB_VERSION}"
fi

# ============================================================
# 3. DATABASE BACKUP
# ============================================================

print_header "DATABASE BACKUP"

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  docker exec "${API_CONTAINER}" mkdir -p /data/backups
  BACKUP_PATH="/data/backups/backup-${RELEASE_TIMESTAMP}.sqlite"

  BACKUP_SCRIPT="const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/data/deployment-platform.sqlite', { readOnly: true }); db.exec(\"VACUUM INTO '${BACKUP_PATH}'\"); db.close();"

  if ! docker exec "${API_CONTAINER}" node -e "${BACKUP_SCRIPT}"; then
    fail "Database backup failed. No container changes have been made yet."
  fi

  info "Database backed up to (inside ${API_DATA_VOLUME}): ${BACKUP_PATH}"
else
  info "Web-only release — no database backup required."
fi

# ============================================================
# Shared helpers used during container swap
# ============================================================

capture_env_file() {
  local container="$1"
  local dest="$2"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${container}" > "${dest}"
  chmod 600 "${dest}"
}

# ============================================================
# API environment: auth.env / platform.env are authoritative
# ============================================================
#
# Historically the replacement API container's environment was built by
# capturing the OUTGOING container's `.Config.Env` wholesale and patching
# in only CREDENTIAL_ENCRYPTION_KEY from auth.env. Every other addition,
# update, or removal in the current auth.env/platform.env was silently
# ignored on every release — the exact defect that made the GitHub App
# integration's config invisible to the API after it was correctly added
# to both files.
#
# Deterministic merge policy (lowest to highest precedence — a key
# present in more than one layer takes the HIGHEST layer's value; a key
# present in NO layer is simply absent from the result):
#
#   1. REQUIRED-KEY FALLBACK — only the documented required keys (see
#      API_REQUIRED_ENV_KEYS below), captured from the OUTGOING
#      container. Defense in depth ONLY: every one of these is always
#      written into auth.env/platform.env by the installer, so layers 3
#      and 4 below normally override this immediately. Deliberately NOT
#      a general "carry everything from the old container forward"
#      fallback — an operator-managed variable that has since been
#      REMOVED from auth.env/platform.env must not silently persist
#      forever just because some earlier container once had it. There is
#      no reliable way to distinguish "an old operator setting that was
#      deliberately removed" from "some other value that should persist"
#      in a flat captured KEY=VALUE list, so this script does not try —
#      only the specifically-required keys get a safety net; everything
#      else must come from the current files or the new image.
#   2. NEW IMAGE DEFAULTS — the replacement image's own `Config.Env`
#      (PATH, NODE_VERSION, and any future image-baked default) is read
#      fresh from the NEW image, never copied from the outgoing
#      container, so an image-default change always takes effect on the
#      very next release.
#   3. platform.env — current operator configuration (PANEL_DOMAIN,
#      APPS_DOMAIN, ROUTING_ENABLED, GITHUB_APP_ID, GITHUB_APP_SLUG,
#      GITHUB_APP_CALLBACK_URL, and any future addition).
#   4. auth.env — current operator secrets (ADMIN_*, SESSION_SECRET,
#      COOKIE_SECURE, CREDENTIAL_ENCRYPTION_KEY, GITHUB_APP_PRIVATE_KEY*)
#      — wins over platform.env on any (theoretical) key collision, as
#      the more sensitive and more deliberately-managed of the two
#      files.
#
# This is read into a fresh env file on EVERY API container replacement
# (release, --deploy-head, resume) — there is no code path left that
# creates the API container from a stale captured snapshot.

API_REQUIRED_ENV_KEYS=(
  ADMIN_USERNAME
  ADMIN_PASSWORD_HASH
  SESSION_SECRET
  COOKIE_SECURE
  PANEL_DOMAIN
  APPS_DOMAIN
  CREDENTIAL_ENCRYPTION_KEY
)

# A plain, sandboxed KEY=VALUE merge (see run_node_helper above for why
# this runs inside the locked-down Node helper rather than raw bash
# string processing): each file is parsed independently — blank lines and
# `#`-comment lines are skipped, every other line must match
# `KEY=VALUE` with a valid shell-identifier KEY (the release refuses to
# proceed rather than silently drop or mis-split a malformed line; values
# are split on the FIRST `=` only, so a base64 value's own `=` padding is
# never truncated). Within a single file, a repeated key is resolved
# deterministically: the LAST occurrence in that file wins (matches this
# script's pre-existing `tail -n 1` convention for
# CREDENTIAL_ENCRYPTION_KEY). Across files, later files (later argv
# positions) win over earlier ones for the same key. Never writes a key's
# value anywhere but the merged output file, and never logs one.
read -r -d '' ENV_MERGE_SCRIPT <<'NODE_EOF' || true
const fs = require("fs");

function parseEnvFile(path) {
  const raw = fs.readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const result = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (/^\s*#/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      console.error(`MALFORMED_ENV_LINE: ${path} line ${i + 1} is not KEY=VALUE`);
      process.exit(1);
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.error(`MALFORMED_ENV_LINE: ${path} line ${i + 1} has an invalid variable name`);
      process.exit(1);
    }
    // Last occurrence within this one file wins — deterministic, documented.
    result.set(key, value);
  }
  return result;
}

const merged = new Map();
for (const path of process.argv.slice(2)) {
  const parsed = parseEnvFile(path);
  for (const [key, value] of parsed) merged.set(key, value);
}

const lines = [];
for (const [key, value] of merged) lines.push(`${key}=${value}`);
process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
NODE_EOF

ENV_MERGE_SCRIPT_FILE="$(new_tmp_file)"
printf '%s' "${ENV_MERGE_SCRIPT}" > "${ENV_MERGE_SCRIPT_FILE}"

# parse_env_file_keys <file> — prints just the KEY names present in
# <file>, one per line, newest-occurrence-agnostic (a name may repeat).
# Never a value. Used only to answer "is this key configured at all?".
parse_env_file_keys() {
  local file="$1"
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "${file}" 2>/dev/null | sed -E 's/=.*$//' | sort -u
}

# merge_env_files <dest> <file1> [file2 ...] — later files win on
# duplicate keys (see ENV_MERGE_SCRIPT above). Writes <dest> mode 600.
# Never prints file contents.
merge_env_files() {
  local dest="$1"
  shift
  run_node_helper "${ENV_MERGE_SCRIPT_FILE}" "$@" > "${dest}"
  chmod 600 "${dest}"
}

# build_api_env_file <dest> <container> <new-image-ref>
#
# Implements the 4-layer precedence documented above. Fails (before
# anything live is touched) if either config file is missing, or if any
# required key is absent from the final merged result.
build_api_env_file() {
  local dest="$1"
  local container="$2"
  local new_image_ref="$3"

  [ -f "${PLATFORM_ENV_FILE}" ] || fail "platform.env not found at ${PLATFORM_ENV_FILE}. Nothing has been changed yet."
  [ -f "${AUTH_FILE}" ] || fail "auth.env not found at ${AUTH_FILE}. Nothing has been changed yet."

  local full_capture required_capture new_image_env
  full_capture="$(new_tmp_file)"
  capture_env_file "${container}" "${full_capture}"

  # Exposed globally (not just used locally below) so
  # resolve_optional_github_key_mount can read the OUTGOING container's
  # own GITHUB_APP_PRIVATE_KEY_PATH afterward, to detect a stale PEM
  # mount left over from a path that has since changed or been removed.
  API_ENV_FULL_CAPTURE_FILE="${full_capture}"

  required_capture="$(new_tmp_file)"
  : > "${required_capture}"
  chmod 600 "${required_capture}"
  local key
  for key in "${API_REQUIRED_ENV_KEYS[@]}"; do
    grep -E "^${key}=" "${full_capture}" | tail -n 1 >> "${required_capture}" || true
  done

  new_image_env="$(new_tmp_file)"
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${new_image_ref}" > "${new_image_env}"
  chmod 600 "${new_image_env}"

  merge_env_files "${dest}" "${required_capture}" "${new_image_env}" "${PLATFORM_ENV_FILE}" "${AUTH_FILE}"

  for key in "${API_REQUIRED_ENV_KEYS[@]}"; do
    if ! grep -q -E "^${key}=" "${dest}"; then
      fail "${key} is missing from the merged API environment after reading ${PLATFORM_ENV_FILE} and ${AUTH_FILE}. Nothing has been changed yet."
    fi
  done
}

# ============================================================
# Optional GitHub App private-key mount
# ============================================================
#
# GITHUB_APP_PRIVATE_KEY_PATH (when set — GitHub App integration is
# always optional) names a host path the API container must be able to
# read the PEM from at that EXACT path (github-app-config.ts reads it
# directly, with no path translation). Docker never mounts a host path
# into a container just because an env var happens to reference it, so
# without this the API process sees a configured-but-unreadable path.
#
# Validated BEFORE Phase B (stopping/renaming the live container) ever
# runs, via Phase A below — an unsafe or missing key fails the release
# with the live containers completely untouched.
#
# GITHUB_APP_PRIVATE_KEY_PATH is the single source of truth for which
# PEM (if any) belongs mounted into the replacement container. When the
# OUTGOING container's own value differs from the current one — a
# different path, or the variable being removed entirely — the OLD
# target is stale: it must not survive into the replacement container
# just because a previous release happened to mount it there. That
# stale target (when there is one) is recorded in
# GITHUB_KEY_STALE_TARGETS so merge_mount_args_by_target (below) drops
# it from the captured mount set, deterministically, on every release —
# never left mounted forever, and never silently re-added.
GITHUB_KEY_MOUNT_ARGS=()
GITHUB_KEY_STALE_TARGETS=()
resolve_optional_github_key_mount() {
  local merged_env_file="$1"
  local prior_env_file="${2:-}"
  GITHUB_KEY_MOUNT_ARGS=()
  GITHUB_KEY_STALE_TARGETS=()

  local key_path
  key_path="$(grep -E '^GITHUB_APP_PRIVATE_KEY_PATH=' "${merged_env_file}" | tail -n 1 | cut -d= -f2- || true)"

  local prior_key_path=""
  if [ -n "${prior_env_file}" ] && [ -f "${prior_env_file}" ]; then
    prior_key_path="$(grep -E '^GITHUB_APP_PRIVATE_KEY_PATH=' "${prior_env_file}" | tail -n 1 | cut -d= -f2- || true)"
  fi

  if [ -n "${prior_key_path}" ] && [ "${prior_key_path}" != "${key_path}" ]; then
    GITHUB_KEY_STALE_TARGETS=("${prior_key_path}")
  fi

  if [ -z "${key_path}" ]; then
    return 0
  fi

  if [ ! -e "${key_path}" ]; then
    fail "GITHUB_APP_PRIVATE_KEY_PATH is configured (${key_path}) but that file does not exist. Nothing has been changed yet."
  fi
  if [ ! -f "${key_path}" ]; then
    fail "GITHUB_APP_PRIVATE_KEY_PATH (${key_path}) exists but is not a regular file. Nothing has been changed yet."
  fi

  # GNU form first (this script normally runs on the Linux VPS); BSD form
  # as a fallback so it also works when exercised directly by the local
  # test suite on macOS. Same pattern as installer/lib/common.sh's
  # portable_file_mode — duplicated here because this script is a
  # standalone file copied to and run on the VPS, not sourced together
  # with the installer.
  local mode
  mode="$(stat -c '%a' "${key_path}" 2>/dev/null || stat -f '%Lp' "${key_path}" 2>/dev/null || true)"
  if [ -z "${mode}" ]; then
    fail "Unable to read the permissions of GITHUB_APP_PRIVATE_KEY_PATH (${key_path}). Nothing has been changed yet."
  fi
  # The low two octal digits are the group and "other" permission bits —
  # both must be clear (mode ...00, e.g. 600 or 400). Anything else means
  # the key is group- or world-readable.
  local group_and_other="${mode: -2}"
  if [ "${group_and_other}" != "00" ]; then
    fail "GITHUB_APP_PRIVATE_KEY_PATH (${key_path}) is group- or world-readable (mode ${mode}). Refusing to mount it until it is restricted (e.g. chmod 600 ${key_path}). Nothing has been changed yet."
  fi

  GITHUB_KEY_MOUNT_ARGS=(--mount "type=bind,source=${key_path},target=${key_path},readonly")
}

# Mounts, including tmpfs mounts, captured generically from whatever the
# live container actually has — never hardcoded to a specific path.
# Parsed by the Dockerized Node helper rather than fragile grep/sed
# against Docker's JSON output.
read -r -d '' MOUNT_PARSE_SCRIPT <<'NODE_EOF' || true
const fs = require("fs");
const raw = fs.readFileSync(process.argv[2], "utf8");
const mounts = JSON.parse(raw || "[]");
for (const m of mounts) {
  const type = m.Type;
  const target = m.Destination;
  if (type === "tmpfs") {
    process.stdout.write(`type=tmpfs,target=${target}\n`);
    continue;
  }
  const source = type === "volume" ? m.Name : m.Source;
  const readOnly = m.RW === false ? ",readonly" : "";
  process.stdout.write(`type=${type},source=${source},target=${target}${readOnly}\n`);
}
NODE_EOF

MOUNT_PARSE_SCRIPT_FILE="$(new_tmp_file)"
printf '%s' "${MOUNT_PARSE_SCRIPT}" > "${MOUNT_PARSE_SCRIPT_FILE}"

MOUNT_ARGS=()
capture_mounts() {
  local container="$1"
  MOUNT_ARGS=()

  local mounts_json_file
  mounts_json_file="$(new_tmp_file)"
  docker inspect --format '{{json .Mounts}}' "${container}" > "${mounts_json_file}"

  local mount_spec
  while IFS= read -r mount_spec || [ -n "${mount_spec}" ]; do
    [ -n "${mount_spec}" ] || continue
    MOUNT_ARGS+=("--mount" "${mount_spec}")
  done < <(run_node_helper "${MOUNT_PARSE_SCRIPT_FILE}" "${mounts_json_file}")
}

# Extracts the "target=..." field from a single --mount spec string (e.g.
# "type=bind,source=/foo,target=/bar,readonly"), by splitting on commas
# and matching the exact "target=" key — never a substring match against
# the raw spec, since a source path can legitimately contain text that
# looks like another mount's target. Prints nothing and returns non-zero
# if the spec has no target field (never expected in practice; treated
# as "cannot be deduplicated" by the caller).
mount_spec_target() {
  local spec="$1"
  local -a fields
  IFS=',' read -ra fields <<< "${spec}"
  local field
  for field in "${fields[@]}"; do
    case "${field}" in
      target=*)
        printf '%s' "${field#target=}"
        return 0
        ;;
    esac
  done
  return 1
}

# merge_mount_args_by_target [extra_stale_target ...]
#
# Merges the globally-captured MOUNT_ARGS (whatever the outgoing
# container actually has) with GITHUB_KEY_MOUNT_ARGS (the authoritative,
# freshly-validated desired GitHub PEM mount, zero or one entries) into
# MERGED_MOUNT_ARGS, deduplicated by DESTINATION PATH ("target="):
#
#   - Any captured mount whose target matches a desired mount's target
#     is dropped from the captured set — the desired mount wins and is
#     appended once, authoritative over whatever was captured (covers
#     "same target, different source/type/read-write" — requirement 2).
#   - Any captured mount whose target matches an extra_stale_target
#     argument (the previous release's GITHUB_APP_PRIVATE_KEY_PATH, when
#     it has since changed or been removed — see
#     resolve_optional_github_key_mount) is ALSO dropped, even though no
#     new mount replaces it.
#   - Every other captured mount (caddy-routes, the Docker socket, the
#     /data volume, and any future unrelated mount) passes through
#     completely untouched, in its original order.
#
# This is what makes mount assembly idempotent across unlimited releases
# — including this exact function being handed its own prior output as
# next release's "captured" input, since a mount already sitting at the
# desired target is excluded exactly the same way a stale one is, then
# re-added exactly once.
MERGED_MOUNT_ARGS=()
merge_mount_args_by_target() {
  local -a extra_stale_targets=("$@")
  MERGED_MOUNT_ARGS=()

  local -a exclude_targets=()
  if [ ${#extra_stale_targets[@]} -gt 0 ]; then
    exclude_targets+=("${extra_stale_targets[@]}")
  fi

  local i target
  i=0
  while [ "${i}" -lt "${#GITHUB_KEY_MOUNT_ARGS[@]}" ]; do
    if [ "${GITHUB_KEY_MOUNT_ARGS[${i}]}" = "--mount" ]; then
      target="$(mount_spec_target "${GITHUB_KEY_MOUNT_ARGS[$((i + 1))]}")" \
        || fail "Internal error: a desired GitHub mount spec has no target. Nothing has been changed yet."
      exclude_targets+=("${target}")
    fi
    i=$((i + 1))
  done

  i=0
  while [ "${i}" -lt "${#MOUNT_ARGS[@]}" ]; do
    if [ "${MOUNT_ARGS[${i}]}" = "--mount" ]; then
      local spec="${MOUNT_ARGS[$((i + 1))]}"
      local captured_target
      captured_target="$(mount_spec_target "${spec}")" || captured_target=""

      local excluded=0
      if [ -n "${captured_target}" ] && [ ${#exclude_targets[@]} -gt 0 ]; then
        local ex
        for ex in "${exclude_targets[@]}"; do
          if [ "${captured_target}" = "${ex}" ]; then
            excluded=1
            break
          fi
        done
      fi

      if [ "${excluded}" -eq 0 ]; then
        MERGED_MOUNT_ARGS+=("--mount" "${spec}")
      fi
      i=$((i + 2))
    else
      i=$((i + 1))
    fi
  done

  if [ ${#GITHUB_KEY_MOUNT_ARGS[@]} -gt 0 ]; then
    MERGED_MOUNT_ARGS+=("${GITHUB_KEY_MOUNT_ARGS[@]}")
  fi
}

# ---------- Runtime configuration capture ----------
#
# Reproduces restart policy, entrypoint/cmd (only when explicitly
# overridden — see below), working directory, user, published/exposed
# ports, resource limits, security options, read-only rootfs, stop
# signal/timeout, healthcheck, labels, DNS, extra hosts, and hostname
# (only when explicitly set). Never touches container ID, IP/MAC,
# network aliases, state, PID, log path, or the old container name —
# those are never read from the source JSON in the first place.
#
# Entrypoint/Cmd handling: if the running container's effective
# Entrypoint/Cmd is identical to what its own image already defaults to,
# the operator never overrode it — the replacement container is created
# with no override, so the *new* image's own defaults apply. If it
# differs, that was an explicit override, and it is reproduced exactly
# (refusing up front if it uses a form Docker's CLI cannot faithfully
# reproduce, such as a multi-element --entrypoint or an exec-form
# healthcheck).
read -r -d '' RUNTIME_CONFIG_SCRIPT <<'NODE_EOF' || true
const fs = require("fs");

function readJson(path) {
  try {
    const raw = fs.readFileSync(path, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function arraysEqual(a, b) {
  const aa = a || [];
  const bb = b || [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

// Run as a real script file inside the Dockerized helper (not via
// `node -e`), so the first data argument is process.argv[2], not [1].
const container = readJson(process.argv[2]);
const oldImage = readJson(process.argv[3]);
const newImage = readJson(process.argv[4]);

if (!container) {
  console.error("Could not read captured container configuration.");
  process.exit(1);
}
if (!newImage) {
  console.error("Could not read the newly built image configuration.");
  process.exit(1);
}

const cfg = container.Config || {};
const host = container.HostConfig || {};
const opts = [];
const cmdArgs = [];
const summary = [];

function opt() {
  for (const t of arguments) opts.push(t);
}

const restartName = (host.RestartPolicy && host.RestartPolicy.Name) || "no";
if (restartName === "on-failure" && host.RestartPolicy.MaximumRetryCount) {
  opt("--restart", `on-failure:${host.RestartPolicy.MaximumRetryCount}`);
} else {
  opt("--restart", restartName || "no");
}
summary.push(`restart policy: ${restartName || "no"}`);

const oldImageCfg = (oldImage && oldImage.Config) || null;
const containerEntrypoint = cfg.Entrypoint || null;
const containerCmd = cfg.Cmd || null;
let commandMode;
if (!oldImageCfg) {
  commandMode = (containerEntrypoint || containerCmd) ? "override" : "default";
} else {
  const entrypointOverridden = !arraysEqual(containerEntrypoint, oldImageCfg.Entrypoint || null);
  const cmdOverridden = !arraysEqual(containerCmd, oldImageCfg.Cmd || null);
  commandMode = (entrypointOverridden || cmdOverridden) ? "override" : "default";
}

if (commandMode === "override") {
  if (containerEntrypoint && containerEntrypoint.length > 1) {
    console.error(`UNSUPPORTED_SETTING: entrypoint override has ${containerEntrypoint.length} elements (${JSON.stringify(containerEntrypoint)}); Docker's --entrypoint flag only supports a single element.`);
    process.exit(1);
  }
  if (containerEntrypoint && containerEntrypoint.length === 1) {
    opt("--entrypoint", containerEntrypoint[0]);
  } else if (containerEntrypoint && containerEntrypoint.length === 0) {
    opt("--entrypoint", "");
  }
  if (containerCmd) {
    for (const c of containerCmd) cmdArgs.push(c);
  }
  summary.push("command mode: override (container-specified entrypoint/cmd preserved)");
} else {
  const newEntrypoint = (newImage.Config && newImage.Config.Entrypoint) || null;
  const newCmd = (newImage.Config && newImage.Config.Cmd) || null;
  if ((!newEntrypoint || newEntrypoint.length === 0) && (!newCmd || newCmd.length === 0)) {
    console.error("UNSUPPORTED_SETTING: the newly built image defines neither ENTRYPOINT nor CMD, and the container does not override either; refusing to create a container with no runnable command.");
    process.exit(1);
  }
  summary.push("command mode: default (new image ENTRYPOINT/CMD will be used)");
}

if (cfg.WorkingDir) {
  opt("--workdir", cfg.WorkingDir);
  summary.push(`workdir: ${cfg.WorkingDir}`);
}

if (cfg.User) {
  opt("--user", cfg.User);
  summary.push(`user: ${cfg.User}`);
}

const exposedPorts = cfg.ExposedPorts || {};
const portBindings = host.PortBindings || {};
for (const portProto of Object.keys(exposedPorts)) {
  if (!portBindings[portProto]) {
    opt("--expose", portProto);
  }
}

for (const portProto of Object.keys(portBindings)) {
  const bindings = portBindings[portProto] || [];
  for (const b of bindings) {
    const hostIp = b.HostIp || "";
    const hostPort = b.HostPort || "";
    if (!hostPort) continue;
    const spec = hostIp ? `${hostIp}:${hostPort}:${portProto}` : `${hostPort}:${portProto}`;
    opt("-p", spec);
    summary.push(`port binding: ${spec}`);
  }
}

if (host.Memory) {
  opt("--memory", String(host.Memory));
  summary.push(`memory: ${host.Memory} bytes`);
}
if (host.MemorySwap && host.MemorySwap !== 0) {
  opt("--memory-swap", String(host.MemorySwap));
  summary.push(`memory swap: ${host.MemorySwap}`);
}
if (host.NanoCpus) {
  opt("--cpus", String(host.NanoCpus / 1e9));
  summary.push(`nano cpus: ${host.NanoCpus}`);
} else {
  if (host.CpuQuota) {
    opt("--cpu-quota", String(host.CpuQuota));
    summary.push(`cpu quota: ${host.CpuQuota}`);
  }
  if (host.CpuPeriod) {
    opt("--cpu-period", String(host.CpuPeriod));
    summary.push(`cpu period: ${host.CpuPeriod}`);
  }
}
if (host.CpuShares && host.CpuShares !== 0) {
  opt("--cpu-shares", String(host.CpuShares));
  summary.push(`cpu shares: ${host.CpuShares}`);
}
if (host.PidsLimit && host.PidsLimit > 0) {
  opt("--pids-limit", String(host.PidsLimit));
  summary.push(`pids limit: ${host.PidsLimit}`);
}

const securityOpt = host.SecurityOpt || [];
for (const s of securityOpt) {
  opt("--security-opt", s);
}
if (securityOpt.length > 0) {
  summary.push(`security opts: ${securityOpt.join(", ")}`);
}

if (host.ReadonlyRootfs) {
  opt("--read-only");
  summary.push("read-only root filesystem: yes");
}

if (cfg.StopSignal) {
  opt("--stop-signal", cfg.StopSignal);
  summary.push(`stop signal: ${cfg.StopSignal}`);
}
if (cfg.StopTimeout !== null && cfg.StopTimeout !== undefined) {
  opt("--stop-timeout", String(cfg.StopTimeout));
  summary.push(`stop timeout: ${cfg.StopTimeout}s`);
}

const hc = cfg.Healthcheck;
if (hc && Array.isArray(hc.Test) && hc.Test.length > 0) {
  const kind = hc.Test[0];
  if (kind === "NONE") {
    opt("--no-healthcheck");
    summary.push("healthcheck: disabled");
  } else if (kind === "CMD-SHELL") {
    opt("--health-cmd", hc.Test[1] || "");
    if (hc.Interval) opt("--health-interval", `${Math.round(hc.Interval / 1e6)}ms`);
    if (hc.Timeout) opt("--health-timeout", `${Math.round(hc.Timeout / 1e6)}ms`);
    if (hc.Retries) opt("--health-retries", String(hc.Retries));
    if (hc.StartPeriod) opt("--health-start-period", `${Math.round(hc.StartPeriod / 1e6)}ms`);
    summary.push(`healthcheck: ${hc.Test[1] || ""}`);
  } else {
    console.error(`UNSUPPORTED_SETTING: healthcheck uses an exec-form test (${JSON.stringify(hc.Test)}); only CMD-SHELL and NONE can be reproduced via the Docker CLI.`);
    process.exit(1);
  }
}

const labels = cfg.Labels || {};
for (const key of Object.keys(labels)) {
  opt("--label", `${key}=${labels[key]}`);
}
if (Object.keys(labels).length > 0) {
  summary.push(`labels: ${Object.keys(labels).length}`);
}

const dns = host.Dns || [];
for (const d of dns) {
  opt("--dns", d);
}
if (dns.length > 0) {
  summary.push(`dns: ${dns.join(", ")}`);
}

const extraHosts = host.ExtraHosts || [];
for (const h of extraHosts) {
  opt("--add-host", h);
}
if (extraHosts.length > 0) {
  summary.push(`extra hosts: ${extraHosts.join(", ")}`);
}

const shortId = (container.Id || "").substring(0, 12);
if (cfg.Hostname && cfg.Hostname !== shortId) {
  opt("--hostname", cfg.Hostname);
  summary.push(`hostname: ${cfg.Hostname}`);
}

for (const o of opts) {
  process.stdout.write(`OPT\t${o}\n`);
}
for (const c of cmdArgs) {
  process.stdout.write(`CMD\t${c}\n`);
}
for (const s of summary) {
  console.error(s);
}
process.exit(0);
NODE_EOF

RUNTIME_CONFIG_SCRIPT_FILE="$(new_tmp_file)"
printf '%s' "${RUNTIME_CONFIG_SCRIPT}" > "${RUNTIME_CONFIG_SCRIPT_FILE}"

RUNTIME_OPTION_ARGS=()
RUNTIME_COMMAND_ARGS=()

# capture_runtime_config <label> <container> <new-image-ref>
#
# Fails (without having touched the live container) if any setting
# cannot be safely reproduced. Prints a concise, labeled summary of what
# will be preserved.
capture_runtime_config() {
  local label="$1"
  local container="$2"
  local new_image_ref="$3"

  local container_json old_image_json new_image_json args_file summary_file old_image_id
  container_json="$(new_tmp_file)"
  old_image_json="$(new_tmp_file)"
  new_image_json="$(new_tmp_file)"
  args_file="$(new_tmp_file)"
  summary_file="$(new_tmp_file)"

  docker inspect --format '{{json .}}' "${container}" > "${container_json}"

  old_image_id="$(docker inspect --format '{{.Image}}' "${container}" 2>/dev/null || true)"
  if [ -n "${old_image_id}" ] && docker image inspect "${old_image_id}" >/dev/null 2>&1; then
    docker inspect --format '{{json .}}' "${old_image_id}" > "${old_image_json}"
  fi

  docker inspect --format '{{json .}}' "${new_image_ref}" > "${new_image_json}"

  if ! run_node_helper "${RUNTIME_CONFIG_SCRIPT_FILE}" "${container_json}" "${old_image_json}" "${new_image_json}" >"${args_file}" 2>"${summary_file}"; then
    fail "Unsupported runtime setting for ${label} (nothing was changed): $(cat "${summary_file}")"
  fi

  info "${label} runtime configuration to preserve:"
  sed 's/^/  /' "${summary_file}"

  RUNTIME_OPTION_ARGS=()
  RUNTIME_COMMAND_ARGS=()
  local type token
  while IFS=$'\t' read -r type token || [ -n "${type}" ]; do
    [ -n "${type}" ] || continue
    case "${type}" in
      OPT) RUNTIME_OPTION_ARGS+=("${token}") ;;
      CMD) RUNTIME_COMMAND_ARGS+=("${token}") ;;
    esac
  done < "${args_file}"
}

wait_for_log_marker() {
  local container="$1"
  local marker="$2"
  local attempts=0

  while [ "${attempts}" -lt 15 ]; do
    if docker logs "${container}" 2>&1 | grep -qiE "${marker}"; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done

  return 1
}

# update_current_pointer — atomically points the VPS "current" source
# symlink at this release directory. Verifies the release directory has
# the files a build needs both before (defense in depth; release.sh and
# the pre-flight/resume paths already checked this) and after the swap
# (the symlink actually resolves to the intended directory).
#
# Deliberately does NOT call fail()/trigger_rollback on error: by the
# time this runs, containers/migrations/keys/public URLs are already
# fully verified and live. Rolling back a healthy, verified deployment
# because a bookkeeping symlink update failed would be destructive and
# would not even fix the underlying problem. Instead this returns 1 and
# lets the caller classify it as a non-fatal warning (PASS_WITH_WARNINGS)
# while leaving the live containers exactly as they are.
CURRENT_POINTER_RESULT=""
CURRENT_POINTER_ERROR=""
update_current_pointer() {
  CURRENT_POINTER_RESULT=""
  CURRENT_POINTER_ERROR=""

  if [ -z "${CURRENT_SYMLINK}" ]; then
    CURRENT_POINTER_RESULT="skipped (no --current-symlink provided)"
    return 0
  fi

  info "Updating current source pointer -> ${SOURCE_DIR}"

  if [ ! -f "${SOURCE_DIR}/package.json" ]; then
    CURRENT_POINTER_ERROR="package.json missing from release directory ${SOURCE_DIR}"
    return 1
  fi
  if [ ! -f "${SOURCE_DIR}/apps/api/Dockerfile" ]; then
    CURRENT_POINTER_ERROR="apps/api/Dockerfile missing from release directory ${SOURCE_DIR}"
    return 1
  fi
  if [ ! -f "${SOURCE_DIR}/apps/web/Dockerfile" ]; then
    CURRENT_POINTER_ERROR="apps/web/Dockerfile missing from release directory ${SOURCE_DIR}"
    return 1
  fi

  local tmp_link="${CURRENT_SYMLINK}.tmp-${RELEASE_TIMESTAMP}"
  if ! ln -sfn "${SOURCE_DIR}" "${tmp_link}"; then
    CURRENT_POINTER_ERROR="failed to create temporary symlink at ${tmp_link}"
    return 1
  fi
  if ! mv -T "${tmp_link}" "${CURRENT_SYMLINK}"; then
    rm -f "${tmp_link}" 2>/dev/null || true
    CURRENT_POINTER_ERROR="failed to atomically move temporary symlink into place at ${CURRENT_SYMLINK}"
    return 1
  fi

  local resolved expected
  resolved="$(readlink -f "${CURRENT_SYMLINK}" 2>/dev/null || true)"
  expected="$(readlink -f "${SOURCE_DIR}" 2>/dev/null || true)"
  if [ -z "${resolved}" ] || [ "${resolved}" != "${expected}" ]; then
    CURRENT_POINTER_ERROR="pointer verification failed: ${CURRENT_SYMLINK} resolves to '${resolved}', expected '${expected}'"
    return 1
  fi

  info "Current source pointer verified: ${CURRENT_SYMLINK} -> ${resolved}"
  CURRENT_POINTER_RESULT="${resolved}"
  return 0
}

verify_container_image() {
  local container="$1"
  local expected_image="$2"
  local actual
  actual="$(docker inspect --format '{{.Config.Image}}' "${container}")"
  [ "${actual}" = "${expected_image}" ]
}

verify_container_network() {
  local container="$1"
  local network="$2"
  docker inspect --format "{{json .NetworkSettings.Networks}}" "${container}" | grep -q "\"${network}\""
}

# ============================================================
# 4. CONTAINER SWAP
# ============================================================

print_header "CONTAINER SWAP"

# ---- Phase A: capture and validate everything, touching nothing live ----

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  info "Capturing API container configuration (no changes made yet)..."

  API_ENV_FILE="$(new_tmp_file)"
  build_api_env_file "${API_ENV_FILE}" "${API_CONTAINER}" "${API_IMAGE_REPO}:${API_VERSION}"

  # Validated against the environment that will actually be used for the
  # replacement container (not a separate read of the raw files), and
  # before Phase B ever stops/renames the live container. Also compares
  # against the OUTGOING container's own GITHUB_APP_PRIVATE_KEY_PATH
  # (API_ENV_FULL_CAPTURE_FILE, set by build_api_env_file above) to
  # detect a stale prior PEM target.
  resolve_optional_github_key_mount "${API_ENV_FILE}" "${API_ENV_FULL_CAPTURE_FILE}"

  # Merged by destination path, not appended blindly — this is what
  # makes the PEM mount idempotent across unlimited releases instead of
  # duplicating (Docker's "Duplicate mount point" failure) on every
  # release after the first one that added it. See
  # merge_mount_args_by_target for the full policy.
  capture_mounts "${API_CONTAINER}"
  if [ ${#GITHUB_KEY_STALE_TARGETS[@]} -gt 0 ]; then
    merge_mount_args_by_target "${GITHUB_KEY_STALE_TARGETS[@]}"
  else
    merge_mount_args_by_target
  fi
  API_MOUNT_ARGS=("${MERGED_MOUNT_ARGS[@]}")

  capture_runtime_config "API" "${API_CONTAINER}" "${API_IMAGE_REPO}:${API_VERSION}"
  # Deliberately not using "${arr[@]:-}" here: when an array is
  # genuinely empty (e.g. no command override), that fallback form
  # expands to one empty-string element instead of zero elements, which
  # would pass Docker a bogus empty CMD argument.
  API_RUNTIME_OPTION_ARGS=()
  if [ ${#RUNTIME_OPTION_ARGS[@]} -gt 0 ]; then
    API_RUNTIME_OPTION_ARGS=("${RUNTIME_OPTION_ARGS[@]}")
  fi
  API_RUNTIME_COMMAND_ARGS=()
  if [ ${#RUNTIME_COMMAND_ARGS[@]} -gt 0 ]; then
    API_RUNTIME_COMMAND_ARGS=("${RUNTIME_COMMAND_ARGS[@]}")
  fi
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  info "Capturing web container configuration (no changes made yet)..."

  capture_mounts "${WEB_CONTAINER}"
  WEB_MOUNT_ARGS=("${MOUNT_ARGS[@]}")

  capture_runtime_config "web" "${WEB_CONTAINER}" "${WEB_IMAGE_REPO}:${WEB_VERSION}"
  WEB_RUNTIME_OPTION_ARGS=()
  if [ ${#RUNTIME_OPTION_ARGS[@]} -gt 0 ]; then
    WEB_RUNTIME_OPTION_ARGS=("${RUNTIME_OPTION_ARGS[@]}")
  fi
  WEB_RUNTIME_COMMAND_ARGS=()
  if [ ${#RUNTIME_COMMAND_ARGS[@]} -gt 0 ]; then
    WEB_RUNTIME_COMMAND_ARGS=("${RUNTIME_COMMAND_ARGS[@]}")
  fi
fi

info "All required configuration captured and validated."

# ---- Phase B: preserve current containers under rollback names ----

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  docker stop "${API_CONTAINER}" >/dev/null
  docker rename "${API_CONTAINER}" "${API_ROLLBACK_TARGET_NAME}"
  API_ROLLBACK_NAME="${API_ROLLBACK_TARGET_NAME}"
  ANY_SWAP_PERFORMED=1
  info "Preserved previous API container as: ${API_ROLLBACK_NAME}"
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  docker stop "${WEB_CONTAINER}" >/dev/null
  docker rename "${WEB_CONTAINER}" "${WEB_ROLLBACK_TARGET_NAME}"
  WEB_ROLLBACK_NAME="${WEB_ROLLBACK_TARGET_NAME}"
  ANY_SWAP_PERFORMED=1
  info "Preserved previous web container as: ${WEB_ROLLBACK_NAME}"
fi

# ---- Phase C: create, connect, start, and verify replacements ----

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  docker create --name "${API_CONTAINER}" --network "${PLATFORM_NETWORK}" \
    "${API_MOUNT_ARGS[@]}" "${API_RUNTIME_OPTION_ARGS[@]}" --env-file "${API_ENV_FILE}" \
    "${API_IMAGE_REPO}:${API_VERSION}" "${API_RUNTIME_COMMAND_ARGS[@]}" >/dev/null
  API_NEW_CREATED=1

  docker network connect "${APPS_NETWORK}" "${API_CONTAINER}"

  docker start "${API_CONTAINER}" >/dev/null
  API_NEW_STARTED=1
  info "Started replacement API container."

  if ! wait_for_log_marker "${API_CONTAINER}" "listening at"; then
    fail "API container did not log a startup message in time."
  fi
  info "API startup log marker found."

  if ! verify_container_image "${API_CONTAINER}" "${API_IMAGE_REPO}:${API_VERSION}"; then
    fail "API container is not running the expected image (${API_IMAGE_REPO}:${API_VERSION})."
  fi
  info "API image verified."

  if ! verify_container_network "${API_CONTAINER}" "${PLATFORM_NETWORK}"; then
    fail "API container is not attached to ${PLATFORM_NETWORK}."
  fi
  if ! verify_container_network "${API_CONTAINER}" "${APPS_NETWORK}"; then
    fail "API container is not attached to ${APPS_NETWORK}."
  fi
  info "API network attachments verified (${PLATFORM_NETWORK}, ${APPS_NETWORK})."
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  docker create --name "${WEB_CONTAINER}" --network "${PLATFORM_NETWORK}" \
    "${WEB_MOUNT_ARGS[@]}" "${WEB_RUNTIME_OPTION_ARGS[@]}" \
    "${WEB_IMAGE_REPO}:${WEB_VERSION}" "${WEB_RUNTIME_COMMAND_ARGS[@]}" >/dev/null
  WEB_NEW_CREATED=1

  docker start "${WEB_CONTAINER}" >/dev/null
  WEB_NEW_STARTED=1
  info "Started replacement web container."

  if ! verify_container_image "${WEB_CONTAINER}" "${WEB_IMAGE_REPO}:${WEB_VERSION}"; then
    fail "Web container is not running the expected image (${WEB_IMAGE_REPO}:${WEB_VERSION})."
  fi
  info "Web image verified."
fi

# ============================================================
# 4b. CADDY CONFIGURATION DEPLOY
# ============================================================
#
# Renders the Caddyfile from the template in THIS release directory,
# validates it with Caddy itself before anything live is touched, backs
# up the current file, installs the new one, and reloads. Any failure
# restores the backup and reloads again, so a bad config can never be
# left serving.
#
# Deliberately config-only: no image is built, no container is
# created/removed, and the Caddy container is reloaded in place rather
# than replaced. Per-app route files under routes/ are never touched.

CADDY_CONFIG_BACKUP=""
CADDY_CONFIG_REPLACED=0

# Applies the on-disk Caddyfile to the running Caddy.
#
# `caddy reload` talks to Caddy's admin API. The platform's generated
# Caddyfile sets `admin off` (the admin endpoint is not wanted on a
# host that also serves customer apps), so reload ALWAYS fails with
# "dial tcp [::1]:2019: connect: connection refused". Restarting the
# container is the supported way to apply a config change on this
# platform — it is exactly what installer/lib/caddy.sh already falls
# back to. TLS certificates survive because they live in the caddy-data
# volume, so the restart costs a couple of seconds of connection
# refusals, not a re-issuance.
#
# Reload is still attempted first: it is zero-downtime, and it will
# start working for free if the admin endpoint is ever enabled.
apply_caddy_config() {
  if docker exec "${CADDY_CONTAINER}" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    info "Caddy reloaded in place (admin API available)."
    return 0
  fi

  info "Caddy's admin API is disabled, so a live reload is not possible — restarting the Caddy container instead."
  if ! docker restart "${CADDY_CONTAINER}" >/dev/null 2>&1; then
    info "ERROR: docker restart ${CADDY_CONTAINER} failed."
    return 1
  fi

  # A config error surfaces as a container that exits immediately, so
  # confirm it is still running before calling this a success.
  caddy_wait=0
  while [ "${caddy_wait}" -lt 15 ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "${CADDY_CONTAINER}" 2>/dev/null)" = "true" ]; then
      sleep 1
      if [ "$(docker inspect -f '{{.State.Running}}' "${CADDY_CONTAINER}" 2>/dev/null)" = "true" ]; then
        info "Caddy restarted and running with the new configuration."
        return 0
      fi
    fi
    caddy_wait=$((caddy_wait + 1))
    sleep 1
  done

  info "ERROR: Caddy did not stay running after the restart."
  return 1
}

restore_caddy_config_on_failure() {
  if [ "${CADDY_CONFIG_REPLACED}" -eq 1 ] && [ -n "${CADDY_CONFIG_BACKUP}" ] && [ -f "${CADDY_CONFIG_BACKUP}" ]; then
    info "Restoring the previous Caddyfile and reloading Caddy..."
    if cp "${CADDY_CONFIG_BACKUP}" "${CADDY_CONFIG_FILE}" 2>/dev/null && apply_caddy_config; then
      info "Previous Caddyfile restored and applied."
      CADDY_CONFIG_REPLACED=0
    else
      info "WARNING: could not automatically restore the previous Caddyfile. It is preserved at ${CADDY_CONFIG_BACKUP}"
    fi
  fi
}

# ============================================================
# 4a. INSTALLER REFRESH
# ============================================================
#
# The guided installer copies itself to ${INSTALL_ROOT}/installer at
# install time, and /usr/local/bin/deployment-platform is a copy of the
# CLI template. Nothing refreshed either afterwards, so every later fix
# to the maintenance commands or the verification checks stayed on the
# operator's laptop while the server kept running the install-day copy.
# That is why a corrected `deployment-platform verify` could pass locally
# and still be absent from the machine it was written for.
#
# The refresh mirrors installer/lib/filesystem.sh exactly (same rsync,
# same --exclude=tests, same CLI copy), stages into a sibling directory,
# syntax-checks it before it becomes live, and swaps by rename so an
# interrupted release can never leave a half-copied installer.

INSTALLER_BACKUP_DIR=""
INSTALLER_REPLACED=0
CLI_BACKUP=""
CLI_REPLACED=0
CLI_TARGET="/usr/local/bin/deployment-platform"
UPDATE_BACKUP=""
UPDATE_REPLACED=0
UPDATE_HAD_PREVIOUS=0
UPDATE_TARGET="/usr/local/bin/deployment-platform-update"

restore_installer_on_failure() {
  if [ "${UPDATE_REPLACED}" -eq 1 ]; then
    if [ "${UPDATE_HAD_PREVIOUS}" -eq 1 ] && [ -n "${UPDATE_BACKUP}" ] && [ -f "${UPDATE_BACKUP}" ]; then
      if cp "${UPDATE_BACKUP}" "${UPDATE_TARGET}" 2>/dev/null; then
        chmod 755 "${UPDATE_TARGET}" 2>/dev/null || true
        info "Previous ${UPDATE_TARGET} restored."
        UPDATE_REPLACED=0
      else
        info "WARNING: could not restore ${UPDATE_TARGET}. It is preserved at ${UPDATE_BACKUP}"
      fi
    else
      rm -f "${UPDATE_TARGET}" 2>/dev/null || true
      UPDATE_REPLACED=0
    fi
  fi
  if [ "${CLI_REPLACED}" -eq 1 ] && [ -n "${CLI_BACKUP}" ] && [ -f "${CLI_BACKUP}" ]; then
    if cp "${CLI_BACKUP}" "${CLI_TARGET}" 2>/dev/null; then
      chmod 755 "${CLI_TARGET}" 2>/dev/null || true
      info "Previous ${CLI_TARGET} restored."
      CLI_REPLACED=0
    else
      info "WARNING: could not restore ${CLI_TARGET}. It is preserved at ${CLI_BACKUP}"
    fi
  fi
  if [ "${INSTALLER_REPLACED}" -eq 1 ] && [ -n "${INSTALLER_BACKUP_DIR}" ] && [ -d "${INSTALLER_BACKUP_DIR}" ]; then
    if rm -rf "${INSTALL_ROOT}/installer" 2>/dev/null &&
       mv "${INSTALLER_BACKUP_DIR}" "${INSTALL_ROOT}/installer" 2>/dev/null; then
      info "Previous installer copy restored."
      INSTALLER_REPLACED=0
    else
      info "WARNING: could not restore the previous installer copy. It is preserved at ${INSTALLER_BACKUP_DIR}"
    fi
  fi
}

if [ "${DEPLOY_INSTALLER}" -eq 1 ]; then
  print_header "INSTALLER REFRESH"

  INSTALLER_SOURCE="${SOURCE_DIR}/installer"
  if [ ! -d "${INSTALLER_SOURCE}" ]; then
    fail "Installer directory not found in this release: ${INSTALLER_SOURCE}"
  fi
  if [ ! -d "${INSTALL_ROOT}/installer" ]; then
    fail "Installed installer copy not found: ${INSTALL_ROOT}/installer"
  fi
  if ! command -v rsync >/dev/null 2>&1; then
    fail "rsync is required to refresh the installer copy but is not installed."
  fi

  INSTALLER_STAGING="${INSTALL_ROOT}/installer.new-${RELEASE_TIMESTAMP}"
  rm -rf "${INSTALLER_STAGING}"
  if ! rsync -a --exclude=tests "${INSTALLER_SOURCE}/" "${INSTALLER_STAGING}/"; then
    rm -rf "${INSTALLER_STAGING}"
    fail "Failed to stage the new installer copy."
  fi

  # Cheap equivalent of `caddy validate` for shell: a syntax error must
  # never become the live maintenance tooling.
  installer_syntax_ok=1
  for installer_script in "${INSTALLER_STAGING}/install.sh" "${INSTALLER_STAGING}"/lib/*.sh; do
    [ -f "${installer_script}" ] || continue
    if ! bash -n "${installer_script}" 2>/dev/null; then
      info "ERROR: syntax check failed for ${installer_script}"
      installer_syntax_ok=0
    fi
  done
  if ! bash -n "${INSTALLER_STAGING}/templates/deployment-platform-cli.template" 2>/dev/null; then
    info "ERROR: syntax check failed for the deployment-platform CLI template."
    installer_syntax_ok=0
  fi
  if ! bash -n "${INSTALLER_STAGING}/templates/deployment-platform-update.template" 2>/dev/null; then
    info "ERROR: syntax check failed for the deployment-platform update template."
    installer_syntax_ok=0
  fi
  if [ "${installer_syntax_ok}" -ne 1 ]; then
    rm -rf "${INSTALLER_STAGING}"
    fail "The new installer copy failed syntax validation; nothing was changed."
  fi

  if diff -r -q "${INSTALL_ROOT}/installer" "${INSTALLER_STAGING}" >/dev/null 2>&1 &&
     cmp -s "${INSTALLER_STAGING}/templates/deployment-platform-cli.template" "${CLI_TARGET}" &&
     cmp -s "${INSTALLER_STAGING}/templates/deployment-platform-update.template" "${UPDATE_TARGET}"; then
    rm -rf "${INSTALLER_STAGING}"
    info "Installed installer copy is already identical to this release — nothing to refresh."
  else
    INSTALLER_BACKUP_DIR="${INSTALL_ROOT}/installer.backup-${RELEASE_TIMESTAMP}"
    rm -rf "${INSTALLER_BACKUP_DIR}"
    if ! mv "${INSTALL_ROOT}/installer" "${INSTALLER_BACKUP_DIR}"; then
      rm -rf "${INSTALLER_STAGING}"
      fail "Could not back up the current installer copy."
    fi
    if ! mv "${INSTALLER_STAGING}" "${INSTALL_ROOT}/installer"; then
      mv "${INSTALLER_BACKUP_DIR}" "${INSTALL_ROOT}/installer" 2>/dev/null || true
      fail "Could not install the new installer copy; the previous one was restored."
    fi
    chmod 755 "${INSTALL_ROOT}/installer/install.sh"
    INSTALLER_REPLACED=1
    info "Installer copy refreshed at ${INSTALL_ROOT}/installer (previous copy: ${INSTALLER_BACKUP_DIR})"

    # The CLI wrapper is a plain copy of the template — same as
    # install_cli_command in installer/lib/filesystem.sh.
    if [ -f "${CLI_TARGET}" ]; then
      CLI_BACKUP="${CLI_TARGET}.backup-${RELEASE_TIMESTAMP}"
      cp "${CLI_TARGET}" "${CLI_BACKUP}"
    fi
    if ! cp "${INSTALL_ROOT}/installer/templates/deployment-platform-cli.template" "${CLI_TARGET}"; then
      restore_installer_on_failure
      fail "Could not install ${CLI_TARGET}; the previous installer copy was restored."
    fi
    chmod 755 "${CLI_TARGET}"
    CLI_REPLACED=1
    info "Management command refreshed: ${CLI_TARGET}"

    if [ -f "${UPDATE_TARGET}" ]; then
      UPDATE_HAD_PREVIOUS=1
      UPDATE_BACKUP="${UPDATE_TARGET}.backup-${RELEASE_TIMESTAMP}"
      cp "${UPDATE_TARGET}" "${UPDATE_BACKUP}"
    fi
    if ! cp "${INSTALL_ROOT}/installer/templates/deployment-platform-update.template" "${UPDATE_TARGET}"; then
      restore_installer_on_failure
      fail "Could not install ${UPDATE_TARGET}; the previous installer copy was restored."
    fi
    chmod 755 "${UPDATE_TARGET}"
    UPDATE_REPLACED=1
    info "Update command refreshed: ${UPDATE_TARGET}"
  fi
fi

if [ "${DEPLOY_CADDY_CONFIG}" -eq 1 ]; then
  print_header "CADDY CONFIGURATION DEPLOY"

  CADDY_TEMPLATE="${SOURCE_DIR}/installer/templates/Caddyfile.template"
  if [ ! -f "${CADDY_TEMPLATE}" ]; then
    fail "Caddy template not found in this release: ${CADDY_TEMPLATE}"
  fi
  if [ ! -f "${CADDY_CONFIG_FILE}" ]; then
    fail "Live Caddyfile not found: ${CADDY_CONFIG_FILE}"
  fi
  if ! docker inspect "${CADDY_CONTAINER}" >/dev/null 2>&1; then
    fail "Caddy container not found: ${CADDY_CONTAINER}"
  fi

  CADDY_CANDIDATE="$(new_tmp_file)"
  # Same substitutions the installer's render_caddyfile performs, so the
  # generated file is byte-identical to what a fresh install produces.
  sed \
    -e "s|__PANEL_DOMAIN__|${PANEL_DOMAIN}|g" \
    -e "s|__API_CONTAINER__|${API_CONTAINER}|g" \
    -e "s|__API_PORT__|3001|g" \
    -e "s|__WEB_CONTAINER__|${WEB_CONTAINER}|g" \
    -e "s|__WEB_PORT__|80|g" \
    "${CADDY_TEMPLATE}" > "${CADDY_CANDIDATE}"

  if grep -q '__[A-Z_]\{2,\}__' "${CADDY_CANDIDATE}"; then
    fail "Rendered Caddyfile still contains unreplaced template placeholders."
  fi

  if cmp -s "${CADDY_CANDIDATE}" "${CADDY_CONFIG_FILE}"; then
    info "Caddy configuration is already identical to the live file — nothing to deploy."
  else
    info "Validating the candidate Caddyfile with Caddy before touching the live file..."
    if ! docker exec -i "${CADDY_CONTAINER}" caddy validate --adapter caddyfile --config - \
      < "${CADDY_CANDIDATE}" >/dev/null 2>&1; then
      info "Candidate Caddyfile failed validation. Live configuration untouched."
      fail "Caddy configuration validation failed; nothing was changed."
    fi
    info "Candidate Caddyfile is valid."

    CADDY_CONFIG_BACKUP="${CADDY_CONFIG_FILE}.backup-${RELEASE_TIMESTAMP}"
    cp "${CADDY_CONFIG_FILE}" "${CADDY_CONFIG_BACKUP}"
    info "Previous Caddyfile backed up to ${CADDY_CONFIG_BACKUP}"

    cp "${CADDY_CANDIDATE}" "${CADDY_CONFIG_FILE}"
    chmod 644 "${CADDY_CONFIG_FILE}"
    CADDY_CONFIG_REPLACED=1
    info "New Caddyfile installed."

    if ! apply_caddy_config; then
      restore_caddy_config_on_failure
      fail "Caddy would not accept the new configuration; the previous Caddyfile was restored."
    fi
  fi
fi

# ============================================================
# 5. VERIFICATION
# ============================================================

print_header "VERIFICATION"

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  info "Verifying database migrations..."

  # Structured, source-aware parsing via the same Dockerized Node helper
  # used elsewhere — not a whole-file grep/sed. Earlier versions matched
  # the FIRST line anywhere in the file starting with `name:`, which for
  # some migrations is an unrelated `name: string;` interface field that
  # appears (unquoted, so the sed substitution silently no-ops) before
  # the real quoted migration name — producing garbage like "name:
  # string;" instead of the actual applied name. This script instead
  # locates each file's own `export const ...: Migration = { ... }`
  # object header and reads version/name only from within that slice.
  read -r -d '' MIGRATION_NAME_PARSE_SCRIPT <<'NODE_EOF' || true
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^[0-9]+.*\.ts$/.test(f));

const HEADER_RE = /export\s+const\s+\w+\s*:\s*Migration\s*=\s*\{/;
const results = [];

for (const file of files.sort()) {
  const full = path.join(dir, file);
  const text = fs.readFileSync(full, "utf8");

  const headerMatch = HEADER_RE.exec(text);
  if (!headerMatch) {
    console.error(`No exported ": Migration = {" object found in ${file}`);
    process.exit(1);
  }

  const bodyStart = headerMatch.index + headerMatch[0].length;
  const upIndex = text.indexOf("up(", bodyStart);
  const headerSlice = upIndex === -1 ? text.slice(bodyStart) : text.slice(bodyStart, upIndex);

  const versionMatch = /version\s*:\s*(\d+)/.exec(headerSlice);
  const nameMatch = /name\s*:\s*"([^"]*)"/.exec(headerSlice) || /name\s*:\s*'([^']*)'/.exec(headerSlice);

  if (!versionMatch) {
    console.error(`Could not find a numeric "version:" field in the migration object header of ${file}`);
    process.exit(1);
  }
  if (!nameMatch || !nameMatch[1]) {
    console.error(`Could not find a quoted, non-empty "name:" field in the migration object header of ${file}`);
    process.exit(1);
  }

  results.push({ version: Number(versionMatch[1]), name: nameMatch[1], file });
}

const seenVersions = new Map();
for (const r of results) {
  if (seenVersions.has(r.version)) {
    console.error(`Duplicate migration version ${r.version} in ${r.file} and ${seenVersions.get(r.version)}`);
    process.exit(1);
  }
  seenVersions.set(r.version, r.file);
}

results.sort((a, b) => a.version - b.version);
for (const r of results) {
  process.stdout.write(`${r.version}\t${r.name}\n`);
}
process.exit(0);
NODE_EOF

  MIGRATION_NAME_PARSE_SCRIPT_FILE="$(new_tmp_file)"
  printf '%s' "${MIGRATION_NAME_PARSE_SCRIPT}" > "${MIGRATION_NAME_PARSE_SCRIPT_FILE}"

  MIGRATIONS_DIR="${SOURCE_DIR}/apps/api/src/migrations"
  EXPECTED_MIGRATIONS_FILE="$(new_tmp_file)"
  if ! run_node_helper "${MIGRATION_NAME_PARSE_SCRIPT_FILE}" "${MIGRATIONS_DIR}" > "${EXPECTED_MIGRATIONS_FILE}"; then
    fail "Could not determine expected migrations from source at ${MIGRATIONS_DIR} (see the runtime-parser error above)."
  fi

  if [ ! -s "${EXPECTED_MIGRATIONS_FILE}" ]; then
    fail "Could not determine expected migrations from source at ${MIGRATIONS_DIR}."
  fi

  MIGRATION_CHECK_SCRIPT='
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const expectedRaw = fs.readFileSync(process.argv[1], "utf8").trim();
const expected = expectedRaw.split("\n").map((line) => {
  const [version, name] = line.split("\t");
  return { version: Number(version), name };
});

const db = new DatabaseSync("/data/deployment-platform.sqlite", { readOnly: true });
const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
db.close();

const seen = new Set();
let duplicate = false;
for (const row of rows) {
  if (seen.has(row.version)) { duplicate = true; }
  seen.add(row.version);
}

const appliedVersions = new Set(rows.map((r) => r.version));
const missing = expected.filter((m) => !appliedVersions.has(m.version));

console.log("Expected migrations:");
for (const m of expected) { console.log(`  ${m.version}\t${m.name}`); }
console.log("Applied migrations:");
for (const r of rows) { console.log(`  ${r.version}\t${r.name}`); }

if (duplicate) {
  console.error("Duplicate migration versions found in schema_migrations.");
  process.exit(1);
}

if (missing.length > 0) {
  console.error(`Missing migrations: ${missing.map((m) => m.version).join(", ")}`);
  process.exit(1);
}

const newestExpected = Math.max(...expected.map((m) => m.version));
const newestApplied = rows.length > 0 ? Math.max(...rows.map((r) => r.version)) : -1;
if (newestApplied !== newestExpected) {
  console.error(`Newest applied migration (${newestApplied}) does not match newest expected migration (${newestExpected}).`);
  process.exit(1);
}

process.exit(0);
'

  CONTAINER_EXPECTED_FILE="/tmp/release-expected-migrations-${RELEASE_TIMESTAMP}"
  docker cp "${EXPECTED_MIGRATIONS_FILE}" "${API_CONTAINER}:${CONTAINER_EXPECTED_FILE}"

  if ! docker exec "${API_CONTAINER}" node -e "${MIGRATION_CHECK_SCRIPT}" "${CONTAINER_EXPECTED_FILE}"; then
    docker exec "${API_CONTAINER}" rm -f "${CONTAINER_EXPECTED_FILE}" >/dev/null 2>&1 || true
    fail "Migration verification failed."
  fi
  docker exec "${API_CONTAINER}" rm -f "${CONTAINER_EXPECTED_FILE}" >/dev/null 2>&1 || true
  info "Migrations verified."

  info "Verifying CREDENTIAL_ENCRYPTION_KEY (value never printed)..."
  KEY_CHECK_SCRIPT='const v = process.env.CREDENTIAL_ENCRYPTION_KEY; if (!v) { process.exit(1); } const b = Buffer.from(v, "base64"); process.exit(b.length === 32 ? 0 : 1);'
  if ! docker exec "${API_CONTAINER}" node -e "${KEY_CHECK_SCRIPT}"; then
    fail "CREDENTIAL_ENCRYPTION_KEY is missing or does not decode to exactly 32 bytes inside the API container."
  fi
  info "CREDENTIAL_ENCRYPTION_KEY present and valid (32 bytes)."
fi

# The containers were recreated moments ago, so the edge can legitimately
# refuse a connection for a few seconds while the proxy re-resolves its
# upstream. That is part of a normal swap, not a failed release, so a URL is
# polled until it answers rather than judged on a single attempt.
URL_CHECK_ATTEMPTS=10
URL_CHECK_DELAY_SECONDS=3

check_public_url() {
  local url="$1"
  local code="000"
  local attempt=1

  while [ "${attempt}" -le "${URL_CHECK_ATTEMPTS}" ]; do
    # Deliberately ONE transfer per attempt, with curl's own --retry unused:
    # curl writes %{http_code} once per transfer, so a retried-then-successful
    # check returns the concatenation "000200", which compares unequal to
    # "200" and rolls back a perfectly healthy release. Retrying in the shell
    # keeps one code per attempt.
    #
    # curl also does not retry exit code 7 (could not connect) without
    # --retry-connrefused — and that is precisely the error a just-swapped
    # container produces, so its --retry would not have fired here anyway.
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${url}" 2>/dev/null)" || code="000"
    [ -n "${code}" ] || code="000"

    if [ "${code}" = "200" ]; then
      if [ "${attempt}" -gt 1 ]; then
        printf '  %s answered 200 on attempt %s.\n' "${url}" "${attempt}" >&2
      fi
      printf '%s' "${code}"
      return 0
    fi

    printf '  %s -> HTTP %s (attempt %s/%s)\n' "${url}" "${code}" "${attempt}" "${URL_CHECK_ATTEMPTS}" >&2
    if [ "${attempt}" -lt "${URL_CHECK_ATTEMPTS}" ]; then
      sleep "${URL_CHECK_DELAY_SECONDS}"
    fi
    attempt=$((attempt + 1))
  done

  printf '%s' "${code}"
}

# Checks one optional smoke-test URL. An unconfigured URL yields the
# literal result "SKIPPED"; a CONFIGURED URL is checked for real and its
# HTTP code returned verbatim, so a network failure surfaces as 000 and
# is treated as a failure below — never as a skip.
check_optional_public_url() {
  local url="$1"
  if [ -z "${url}" ]; then
    printf 'SKIPPED'
    return 0
  fi
  check_public_url "${url}"
}

info "Checking public URLs..."
RESULT_PANEL="$(check_public_url "${URL_PANEL}")"
RESULT_WIZARD="$(check_optional_public_url "${URL_WIZARD_TEST}")"
RESULT_SQLITE="$(check_optional_public_url "${URL_SQLITE_TEST}")"

info "  panel (mandatory): ${URL_PANEL} -> HTTP ${RESULT_PANEL}"
if [ -n "${URL_WIZARD_TEST}" ]; then
  info "  wizard test (configured, mandatory): ${URL_WIZARD_TEST} -> HTTP ${RESULT_WIZARD}"
else
  info "  wizard test: SKIPPED — no --url-wizard-test configured (no wizard test app deployed)"
fi
if [ -n "${URL_SQLITE_TEST}" ]; then
  info "  sqlite test (configured, mandatory): ${URL_SQLITE_TEST} -> HTTP ${RESULT_SQLITE}"
else
  info "  sqlite test: SKIPPED — no --url-sqlite-test configured (no sqlite test app deployed)"
fi

# The panel is always required. Each optional URL is required only when
# configured — and when configured, anything other than 200 (including a
# connection failure reported as 000) fails the release.
URL_CHECK_FAILURES=0
if [ "${RESULT_PANEL}" != "200" ]; then
  info "  FAIL: panel URL check failed: ${URL_PANEL} -> HTTP ${RESULT_PANEL} (expected 200)."
  URL_CHECK_FAILURES=$((URL_CHECK_FAILURES + 1))
fi
if [ -n "${URL_WIZARD_TEST}" ] && [ "${RESULT_WIZARD}" != "200" ]; then
  info "  FAIL: configured wizard test URL check failed: ${URL_WIZARD_TEST} -> HTTP ${RESULT_WIZARD} (expected 200)."
  URL_CHECK_FAILURES=$((URL_CHECK_FAILURES + 1))
fi
if [ -n "${URL_SQLITE_TEST}" ] && [ "${RESULT_SQLITE}" != "200" ]; then
  info "  FAIL: configured sqlite test URL check failed: ${URL_SQLITE_TEST} -> HTTP ${RESULT_SQLITE} (expected 200)."
  URL_CHECK_FAILURES=$((URL_CHECK_FAILURES + 1))
fi
if [ "${URL_CHECK_FAILURES}" -gt 0 ]; then
  fail "${URL_CHECK_FAILURES} public URL check(s) did not return HTTP 200."
fi

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  info ""
  info "Recent API logs (sanitized):"
  print_sanitized_logs "$(docker logs --tail 40 "${API_CONTAINER}" 2>&1)"
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  info ""
  info "Recent web logs (sanitized):"
  print_sanitized_logs "$(docker logs --tail 40 "${WEB_CONTAINER}" 2>&1)"
fi

# ============================================================
# 6. RELEASE COMPLETE
# ============================================================

print_header "RELEASE COMPLETE"

FINAL_NEW_API_IMAGE="n/a"
FINAL_NEW_WEB_IMAGE="n/a"

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  FINAL_NEW_API_IMAGE="${API_IMAGE_REPO}:${API_VERSION}"
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  FINAL_NEW_WEB_IMAGE="${WEB_IMAGE_REPO}:${WEB_VERSION}"
fi

ROLLBACK_NAMES=""
[ -n "${API_ROLLBACK_NAME}" ] && ROLLBACK_NAMES="${ROLLBACK_NAMES}${API_ROLLBACK_NAME} "
[ -n "${WEB_ROLLBACK_NAME}" ] && ROLLBACK_NAMES="${ROLLBACK_NAMES}${WEB_ROLLBACK_NAME} "

# The current source pointer is the last required success action. The
# remote script must not emit PASS until it has completed (or was
# explicitly skipped because no --current-symlink was given) — do not
# print PASS before this point.
FINAL_STATUS="PASS"
if update_current_pointer; then
  info "Current source pointer: ${CURRENT_POINTER_RESULT}"
else
  info "WARNING: current source pointer update did not complete: ${CURRENT_POINTER_ERROR}"
  info "The deployed containers are already verified and healthy — they are NOT being rolled back for this bookkeeping failure."
  info "The VPS 'current' pointer still refers to the previous release. Fix manually before the next release, e.g.:"
  info "  ln -sfn '${SOURCE_DIR}' '${CURRENT_SYMLINK}' && readlink -f '${CURRENT_SYMLINK}'"
  FINAL_STATUS="PASS_WITH_WARNINGS"
  CURRENT_POINTER_RESULT="FAILED: ${CURRENT_POINTER_ERROR} (previous pointer left unchanged)"
fi

# Deployment is now fully complete and verified, including the pointer
# update above. Disarm the ERR trap before any further bookkeeping
# (temp-file cleanup, summary emission) so a nonfatal failure there can
# never be misread as a deployment failure and trigger a destructive
# rollback of an already-successful, already-verified release.
DEPLOYMENT_COMPLETE=1
trap - ERR

info "Deployment completed successfully."
info "Rollback containers preserved (not removed automatically): ${ROLLBACK_NAMES:-none}"
if [ -n "${BACKUP_PATH}" ]; then
  info "Database backup path: ${BACKUP_PATH}"
fi
info "Release directory (preserved, not deleted): ${SOURCE_DIR}"

emit_summary "${FINAL_NEW_API_IMAGE}" "${FINAL_NEW_WEB_IMAGE}" "${BACKUP_PATH}" "${ROLLBACK_NAMES}" \
  "HTTP ${RESULT_PANEL}" "HTTP ${RESULT_WIZARD}" "HTTP ${RESULT_SQLITE}" "${FINAL_STATUS}" \
  "${FINAL_NEW_API_IMAGE}" "${FINAL_NEW_WEB_IMAGE}" "preserved (not renamed back)" "${CURRENT_POINTER_RESULT}"
