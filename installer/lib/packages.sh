#!/usr/bin/env bash
#
# packages.sh — installs only the host packages the installer and the
# platform genuinely need. Idempotent: an already-installed package is
# a no-op, not a failure.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "packages.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

REQUIRED_APT_PACKAGES=(
  ca-certificates
  curl
  git
  jq
  openssl
  rsync
  sqlite3
  gnupg
)

package_is_installed() {
  dpkg -s "$1" >/dev/null 2>&1
}

install_base_packages() {
  log_stage "PACKAGES"

  local missing=()
  local pkg
  for pkg in "${REQUIRED_APT_PACKAGES[@]}"; do
    if package_is_installed "$pkg"; then
      log_info "Already installed: $pkg"
    else
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    log_pass "All required base packages are already installed."
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: apt-get update && apt-get install -y ${missing[*]}"
    return 0
  fi

  log_info "Installing missing packages: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  if ! apt-get update -qq; then
    fatal "apt-get update failed. Check network connectivity and package sources."
  fi
  if ! apt-get install -y -qq "${missing[@]}"; then
    fatal "Failed to install required packages: ${missing[*]}"
  fi

  log_pass "Base packages installed."
}
