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

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --auth-file) AUTH_FILE="$2"; shift 2 ;;
    --caddy-routes-dir) CADDY_ROUTES_DIR="$2"; shift 2 ;;
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
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

SEMVER_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+$'

is_valid_semver() {
  [[ "$1" =~ ${SEMVER_PATTERN} ]]
}

case "${MODE}" in
  api|web|both) ;;
  *)
    printf 'ERROR: --mode must be one of: api, web, both (got: %s)\n' "${MODE}" >&2
    exit 1
    ;;
esac

for required in SOURCE_DIR AUTH_FILE CADDY_ROUTES_DIR API_CONTAINER WEB_CONTAINER \
  API_IMAGE_REPO WEB_IMAGE_REPO PLATFORM_NETWORK APPS_NETWORK API_DATA_VOLUME \
  URL_PANEL URL_WIZARD_TEST URL_SQLITE_TEST; do
  if [ -z "${!required}" ]; then
    printf 'ERROR: missing required --%s\n' "$(printf '%s' "${required}" | tr '[:upper:]_' '[:lower:]-')" >&2
    exit 1
  fi
done

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

print_header() {
  printf '\n===== %s =====\n' "$1"
}

info() {
  printf '%s\n' "$1"
}

TMP_FILES=()
new_tmp_file() {
  local path
  path="$(mktemp "/tmp/release-remote.XXXXXX")"
  TMP_FILES+=("${path}")
  printf '%s' "${path}"
}

cleanup_tmp_files() {
  local path
  for path in "${TMP_FILES[@]:-}"; do
    [ -n "${path:-}" ] && [ -e "${path}" ] && rm -f "${path}"
  done
}
trap cleanup_tmp_files EXIT

require_tools() {
  local tool
  for tool in docker node curl openssl; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      printf 'ERROR: required tool not found on VPS: %s\n' "${tool}" >&2
      exit 1
    fi
  done
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

emit_summary() {
  # Machine-parseable lines consumed by release.sh. Keep these as the
  # last thing this script prints so release.sh's log-tail parsing is
  # unambiguous.
  printf 'RELEASE_SUMMARY_NEW_API_IMAGE=%s\n' "${1}"
  printf 'RELEASE_SUMMARY_NEW_WEB_IMAGE=%s\n' "${2}"
  printf 'RELEASE_SUMMARY_BACKUP_PATH=%s\n' "${3}"
  printf 'RELEASE_SUMMARY_ROLLBACK_CONTAINERS=%s\n' "${4}"
  printf 'RELEASE_SUMMARY_URL_RESULT_PANEL=%s\n' "${5}"
  printf 'RELEASE_SUMMARY_URL_RESULT_WIZARD=%s\n' "${6}"
  printf 'RELEASE_SUMMARY_URL_RESULT_SQLITE=%s\n' "${7}"
  printf 'RELEASE_SUMMARY_STATUS=%s\n' "${8}"
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
    fi
  fi

  return 0
}

trigger_rollback() {
  local reason="$1"

  if [ "${ROLLBACK_TRIGGERED}" -eq 1 ]; then
    return 0
  fi
  ROLLBACK_TRIGGERED=1

  print_header "AUTOMATIC ROLLBACK"
  info "Reason: ${reason}"

  if ! rollback_component "API" "${API_CONTAINER}" "${API_ROLLBACK_NAME}" "${API_NEW_CREATED}" "${API_NEW_STARTED}"; then
    info "API rollback encountered an error — see above. Do not assume the API container is healthy."
  fi
  if ! rollback_component "web" "${WEB_CONTAINER}" "${WEB_ROLLBACK_NAME}" "${WEB_NEW_CREATED}" "${WEB_NEW_STARTED}"; then
    info "Web rollback encountered an error — see above. Do not assume the web container is healthy."
  fi

  if [ -n "${BACKUP_PATH}" ]; then
    info "Database backup preserved at: ${BACKUP_PATH}"
  fi
  info "Release directory preserved for inspection: ${SOURCE_DIR}"

  local rollback_names=""
  [ -n "${API_ROLLBACK_NAME}" ] && rollback_names="${rollback_names}${API_ROLLBACK_NAME} "
  [ -n "${WEB_ROLLBACK_NAME}" ] && rollback_names="${rollback_names}${WEB_ROLLBACK_NAME} "

  local status="FAILED"
  if [ "${ANY_SWAP_PERFORMED}" -eq 1 ]; then
    status="ROLLED_BACK"
  fi

  print_header "RELEASE COMPLETE"
  emit_summary "n/a" "n/a" "${BACKUP_PATH}" "${rollback_names}" "not reached" "not reached" "not reached" "${status}"
}

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  trigger_rollback "$1"
  exit 1
}

on_err() {
  trigger_rollback "An unexpected command failure occurred during deployment."
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
  API_ROLLBACK_TARGET_NAME="${API_CONTAINER}-rollback-${PREVIOUS_API_VERSION}-${RELEASE_TIMESTAMP}"
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
  WEB_ROLLBACK_TARGET_NAME="${WEB_CONTAINER}-rollback-${PREVIOUS_WEB_VERSION}-${RELEASE_TIMESTAMP}"
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
MOUNT_ARGS=()
capture_mounts() {
  local container="$1"
  MOUNT_ARGS=()

  local mounts_json
  mounts_json="$(docker inspect --format '{{json .Mounts}}' "${container}")"

  local mount_spec
  while IFS= read -r mount_spec || [ -n "${mount_spec}" ]; do
    [ -n "${mount_spec}" ] || continue
    MOUNT_ARGS+=("--mount" "${mount_spec}")
  done < <(printf '%s' "${mounts_json}" | node -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  const mounts = JSON.parse(data || "[]");
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
});
')
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

const container = readJson(process.argv[1]);
const oldImage = readJson(process.argv[2]);
const newImage = readJson(process.argv[3]);

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

  if ! node -e "${RUNTIME_CONFIG_SCRIPT}" "${container_json}" "${old_image_json}" "${new_image_json}" >"${args_file}" 2>"${summary_file}"; then
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
# 5. VERIFICATION
# ============================================================

print_header "VERIFICATION"

if [ "${MODE}" = "api" ] || [ "${MODE}" = "both" ]; then
  info "Verifying database migrations..."

  EXPECTED_MIGRATIONS_FILE="$(new_tmp_file)"
  for migration_file in "${SOURCE_DIR}"/apps/api/src/migrations/[0-9]*.ts; do
    [ -e "${migration_file}" ] || continue
    version="$(grep -E '^\s*version:' "${migration_file}" | head -n 1 | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
    name="$(grep -E '^\s*name:' "${migration_file}" | head -n 1 | sed -E 's/^[^"]*"([^"]*)".*/\1/')"
    if [ -n "${version}" ] && [ -n "${name}" ]; then
      printf '%s\t%s\n' "${version}" "${name}" >> "${EXPECTED_MIGRATIONS_FILE}"
    fi
  done

  if [ ! -s "${EXPECTED_MIGRATIONS_FILE}" ]; then
    fail "Could not determine expected migrations from source at ${SOURCE_DIR}/apps/api/src/migrations."
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

info "Checking public URLs..."
RESULT_PANEL="$(check_public_url "${URL_PANEL}")"
RESULT_WIZARD="$(check_public_url "${URL_WIZARD_TEST}")"
RESULT_SQLITE="$(check_public_url "${URL_SQLITE_TEST}")"

info "  ${URL_PANEL} -> HTTP ${RESULT_PANEL}"
info "  ${URL_WIZARD_TEST} -> HTTP ${RESULT_WIZARD}"
info "  ${URL_SQLITE_TEST} -> HTTP ${RESULT_SQLITE}"

if [ "${RESULT_PANEL}" != "200" ] || [ "${RESULT_WIZARD}" != "200" ] || [ "${RESULT_SQLITE}" != "200" ]; then
  fail "One or more public URL checks did not return HTTP 200."
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

info "Deployment completed successfully."
info "Rollback containers preserved (not removed automatically): ${ROLLBACK_NAMES:-none}"
if [ -n "${BACKUP_PATH}" ]; then
  info "Database backup path: ${BACKUP_PATH}"
fi
info "Release directory (preserved, not deleted): ${SOURCE_DIR}"

emit_summary "${FINAL_NEW_API_IMAGE}" "${FINAL_NEW_WEB_IMAGE}" "${BACKUP_PATH}" "${ROLLBACK_NAMES}" \
  "HTTP ${RESULT_PANEL}" "HTTP ${RESULT_WIZARD}" "HTTP ${RESULT_SQLITE}" "PASS"
