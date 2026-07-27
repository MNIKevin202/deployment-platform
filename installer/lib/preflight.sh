#!/usr/bin/env bash
#
# preflight.sh — OS/architecture/resource/network checks that must
# pass (or be explicitly acknowledged) before anything on the server
# is changed. Nothing in this file is mutating.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "preflight.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

MIN_CPU_CORES=2
MIN_RAM_MB=3800
MIN_DISK_GB=20
RECOMMENDED_CPU_CORES=4
RECOMMENDED_RAM_MB=7800
RECOMMENDED_DISK_GB=40

SUPPORTED_UBUNTU_VERSIONS=("24.04")
# 26.04 is not yet released as of this installer's writing — accepted
# only with an explicit warning that its package behavior has not been
# validated by this installer, per the task's "if compatible" wording.
PROVISIONAL_UBUNTU_VERSIONS=("26.04")

detect_os() {
  if [ ! -f /etc/os-release ]; then
    fatal "Cannot detect the operating system (/etc/os-release is missing). This installer only supports Ubuntu Server."
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"
}

check_os_supported() {
  detect_os

  if [ "$OS_ID" != "ubuntu" ]; then
    fatal "Unsupported operating system: $OS_ID. This installer only supports Ubuntu Server 24.04 LTS (26.04 LTS provisionally). Nothing was changed."
  fi

  local version
  for version in "${SUPPORTED_UBUNTU_VERSIONS[@]}"; do
    if [ "$OS_VERSION" = "$version" ]; then
      log_pass "Operating system: Ubuntu $OS_VERSION (supported)"
      return 0
    fi
  done
  for version in "${PROVISIONAL_UBUNTU_VERSIONS[@]}"; do
    if [ "$OS_VERSION" = "$version" ]; then
      log_warn "Operating system: Ubuntu $OS_VERSION — provisional support only. Package behavior has not been fully validated for this release. Continuing."
      return 0
    fi
  done

  fatal "Unsupported Ubuntu version: $OS_VERSION. This installer supports Ubuntu Server 24.04 LTS. Nothing was changed."
}

check_architecture() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      log_pass "CPU architecture: $arch (supported)"
      ;;
    aarch64|arm64)
      fatal "CPU architecture $arch (ARM) is not yet supported — project images and dependencies have not been validated on ARM. Nothing was changed."
      ;;
    *)
      fatal "Unsupported CPU architecture: $arch. Nothing was changed."
      ;;
  esac
}

check_resources() {
  local cpu_cores ram_mb disk_gb
  cpu_cores="$(nproc 2>/dev/null || echo 1)"
  ram_mb="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  disk_gb="$(df -Pk "${INSTALL_ROOT_PARENT:-/opt}" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}')"
  disk_gb="${disk_gb:-0}"

  log_info "Detected: ${cpu_cores} CPU cores, ${ram_mb} MB RAM, ${disk_gb} GB free disk at ${INSTALL_ROOT_PARENT:-/opt}"

  if [ "$cpu_cores" -lt "$MIN_CPU_CORES" ]; then
    fatal "At least $MIN_CPU_CORES CPU cores are required (found $cpu_cores). Nothing was changed."
  fi
  if [ "$ram_mb" -lt "$MIN_RAM_MB" ]; then
    fatal "At least ${MIN_RAM_MB} MB of RAM is required (found ${ram_mb} MB). Nothing was changed."
  fi
  if [ "$disk_gb" -lt "$MIN_DISK_GB" ]; then
    fatal "At least ${MIN_DISK_GB} GB of free disk space is required (found ${disk_gb} GB). Nothing was changed."
  fi

  if [ "$cpu_cores" -lt "$RECOMMENDED_CPU_CORES" ] || [ "$ram_mb" -lt "$RECOMMENDED_RAM_MB" ] || [ "$disk_gb" -lt "$RECOMMENDED_DISK_GB" ]; then
    log_warn "This server is below the recommended configuration (${RECOMMENDED_CPU_CORES} cores / ${RECOMMENDED_RAM_MB} MB RAM / ${RECOMMENDED_DISK_GB} GB disk). Minimums are met, so installation will continue."
  else
    log_pass "Resources meet the recommended configuration."
  fi
}

check_systemd() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    log_pass "systemd is available."
  else
    log_warn "systemd was not detected. Docker's own service management will still be used where possible, but this configuration is less tested."
  fi
}

REQUIRED_PORTS=(80 443)

check_ports_available() {
  local port
  local occupied=()
  for port in "${REQUIRED_PORTS[@]}"; do
    if command -v ss >/dev/null 2>&1; then
      if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port"; then
        occupied+=("$port")
      fi
    fi
  done

  if [ "${#occupied[@]}" -gt 0 ]; then
    log_warn "Port(s) ${occupied[*]} already have a listener. If this is an existing Caddy/nginx/apache instance not managed by this installer, resolve the conflict before continuing — Caddy will fail to bind otherwise."
  else
    log_pass "Required ports (${REQUIRED_PORTS[*]}) are free."
  fi
}

run_preflight_checks() {
  log_stage "PREFLIGHT"
  require_root
  log_pass "Running as root."
  check_os_supported
  check_architecture
  check_resources
  check_systemd
  check_ports_available
  log_pass "Preflight checks complete."
}
