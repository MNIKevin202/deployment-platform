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
CADDY_ROUTES_DIR=""
DEPLOY_CADDY_CONFIG=0
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
    --caddy-routes-dir) CADDY_ROUTES_DIR="$2"; shift 2 ;;
    --deploy-caddy-config) DEPLOY_CADDY_CONFIG=1; shift ;;
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

# "caddy" is a CONFIG-ONLY mode: it deploys a regenerated Caddyfile and
# reloads Caddy, and builds/swaps no images at all. It exists because a
# Caddy routing change is a real, deployable change to a running server
# that touches neither apps/api nor apps/web — previously such a change
# was classified as local-only and silently never reached the VPS, which
# is how a broken /api prefix stayed live.
case "${MODE}" in
  api|web|both) ;;
  caddy)
    DEPLOY_CADDY_CONFIG=1
    ;;
  *)
    printf 'ERROR: --mode must be one of: api, web, both, caddy (got: %s)\n' "${MODE}" >&2
    exit 1
    ;;
esac

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
for required in SOURCE_DIR AUTH_FILE CADDY_ROUTES_DIR API_CONTAINER WEB_CONTAINER \
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
  info "API image built: ${API_IMAGE_REPO}:${API_VERSION}"
fi

if [ "${MODE}" = "web" ] || [ "${MODE}" = "both" ]; then
  info "Building ${WEB_IMAGE_REPO}:${WEB_VERSION}..."
  if ! docker build -f "${SOURCE_DIR}/apps/web/Dockerfile" -t "${WEB_IMAGE_REPO}:${WEB_VERSION}" "${SOURCE_DIR}"; then
    fail "Web image build failed."
  fi
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

# Merges CREDENTIAL_ENCRYPTION_KEY from the external auth file into a
# captured env file, without ever printing either file's contents and
# without duplicating the key if it is already present.
merge_encryption_key() {
  local env_file="$1"
  local key_line
  key_line="$(grep -E '^CREDENTIAL_ENCRYPTION_KEY=' "${AUTH_FILE}" | tail -n 1 || true)"

  if [ -z "${key_line}" ]; then
    fail "CREDENTIAL_ENCRYPTION_KEY not found in ${AUTH_FILE}"
  fi

  local without_key
  without_key="$(grep -v -E '^CREDENTIAL_ENCRYPTION_KEY=' "${env_file}" || true)"
  {
    printf '%s\n' "${without_key}"
    printf '%s\n' "${key_line}"
  } > "${env_file}.merged"
  mv "${env_file}.merged" "${env_file}"
  chmod 600 "${env_file}"
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
  capture_env_file "${API_CONTAINER}" "${API_ENV_FILE}"
  merge_encryption_key "${API_ENV_FILE}"

  capture_mounts "${API_CONTAINER}"
  API_MOUNT_ARGS=("${MOUNT_ARGS[@]}")

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

restore_caddy_config_on_failure() {
  if [ "${CADDY_CONFIG_REPLACED}" -eq 1 ] && [ -n "${CADDY_CONFIG_BACKUP}" ] && [ -f "${CADDY_CONFIG_BACKUP}" ]; then
    info "Restoring the previous Caddyfile and reloading Caddy..."
    if cp "${CADDY_CONFIG_BACKUP}" "${CADDY_CONFIG_FILE}" 2>/dev/null &&
       docker exec "${CADDY_CONTAINER}" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      info "Previous Caddyfile restored and reloaded."
      CADDY_CONFIG_REPLACED=0
    else
      info "WARNING: could not automatically restore the previous Caddyfile. It is preserved at ${CADDY_CONFIG_BACKUP}"
    fi
  fi
}

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

    if ! docker exec "${CADDY_CONTAINER}" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      restore_caddy_config_on_failure
      fail "Caddy reload failed with the new configuration; the previous Caddyfile was restored."
    fi
    info "Caddy reloaded with the new configuration."
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

check_public_url() {
  local url="$1"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --retry 3 --retry-delay 2 "${url}" || printf '000')"
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
