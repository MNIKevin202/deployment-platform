#!/usr/bin/env bash
#
# packages.sh — installs only the host packages the installer and the
# platform genuinely need. Idempotent: an already-installed package is
# a no-op, not a failure.
#
# When apt fails, this file's job is to make the *real* reason visible
# immediately rather than leaving the operator to go read the log. It
# deliberately does not attempt to "fix" apt: the only automatic
# recovery here is bounded lock-waiting (delegated to apt's own
# DPkg::Lock::Timeout) and a metadata refresh before the first install.
# Anything else — an interrupted dpkg state, a missing repository
# component, a package configuration failure — is reported with the
# exact command to run, because blindly running repair commands on
# someone else's server is how a routine install becomes an outage.

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

# Bounded wait for the dpkg/apt lock, implemented by apt itself rather
# than by this script poking at lock files with fuser/lsof (which would
# add a psmisc dependency and race anyway). Supported by apt 2.0+, which
# every Ubuntu release this installer targets ships.
APT_LOCK_TIMEOUT_SECONDS=120

# apt/dpkg options applied to every apt-get invocation in this installer:
#   DPkg::Lock::Timeout — the bounded lock wait described above.
#   Dpkg::Use-Pty=0     — stop dpkg drawing a pty-based progress UI, so
#                         captured output is clean readable lines rather
#                         than carriage-return redraw fragments.
# A plain indexed array (Bash 3.2-safe) expanded as
# "${APT_COMMON_OPTIONS[@]}" — the argument boundaries survive exactly,
# with no re-splitting and no eval. Also used by docker.sh, which is
# sourced after this file.
APT_COMMON_OPTIONS=(
  -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}"
  -o "Dpkg::Use-Pty=0"
)

package_is_installed() {
  dpkg -s "$1" >/dev/null 2>&1
}

# Detects (and only reports) an interrupted dpkg state. This is a very
# common cause of "apt-get install fails for no visible reason" and the
# operator cannot guess it from an exit code alone. The repair command
# is printed, never executed — `dpkg --configure -a` can trigger
# maintainer scripts across unrelated packages, which is not this
# installer's call to make on a machine it does not own.
report_dpkg_interrupted_state() {
  local audit
  audit="$(dpkg --audit 2>/dev/null | head -n 20 || true)"
  [ -n "$audit" ] || return 0

  log_warn "dpkg reports packages in an inconsistent or half-configured state. This commonly makes apt-get install fail until it is resolved:"
  printf '%s\n' "$audit" | while IFS= read -r line; do
    [ -n "$line" ] && log_warn "  ${line}"
  done
  log_warn "Resolve it deliberately (this installer will not run repair commands on your behalf):"
  log_warn "  sudo dpkg --configure -a"
}

# Distinguishes "this package name does not exist in any configured
# repository" (a metadata/repository problem) from "the package exists
# but installing or configuring it failed" (a different problem
# entirely). This is real diagnosis from apt's own view of the world —
# not a guess at a workaround.
report_package_availability() {
  local pkg candidate
  _visible_line ""
  _visible_line "Availability of each requested package (apt-cache policy):"
  for pkg in "$@"; do
    candidate="$(apt-cache policy "$pkg" 2>/dev/null | awk -F': ' '/Candidate:/ {print $2; exit}')"
    if [ -z "$candidate" ]; then
      _visible_line "$(printf '  %-18s not found in any configured repository' "$pkg")"
    elif [ "$candidate" = "(none)" ]; then
      _visible_line "$(printf '  %-18s known, but no installable candidate version' "$pkg")"
    else
      _visible_line "$(printf '  %-18s candidate %s' "$pkg" "$candidate")"
    fi
  done
}

# The concise, self-contained failure block the operator sees on the
# terminal. Bounded output — the complete apt/dpkg output always goes to
# the installer log, which this never replaces or truncates.
print_package_failure_diagnostics() {
  local operation="$1"
  local status="$2"
  shift 2
  local packages="$*"

  _visible_line ""
  log_fail "${operation} failed (exit code ${status})."

  if [ -n "$packages" ]; then
    _visible_line ""
    _visible_line "Packages:"
    _visible_line "  ${packages}"
  fi

  print_last_output_excerpt "Recent apt output:"

  if [ -n "$packages" ]; then
    # shellcheck disable=SC2086
    report_package_availability $packages
  fi

  report_dpkg_interrupted_state

  _visible_line ""
  _visible_line "Full log:"
  _visible_line "  ${INSTALLER_LOG_FILE}"
  _visible_line ""
  _visible_line "Safe next diagnostic command (read-only, changes nothing):"
  if [ -n "$packages" ]; then
    _visible_line "  sudo apt-get install --simulate ${packages}"
  else
    _visible_line "  sudo apt-get update"
  fi
  _visible_line ""
  _visible_line "Resume after correcting the problem:"
  _visible_line "  sudo ./installer/install.sh --resume"
  _visible_line ""
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

  log_info "Missing packages to install: ${missing[*]}"

  # Reported up front, before the first apt call: if dpkg is already in
  # a broken state, the operator learns that now instead of after
  # watching a spinner fail.
  report_dpkg_interrupted_state

  local status=0

  # DEBIAN_FRONTEND is set for the apt command only, via env, rather
  # than exported process-wide — nothing else in this installer should
  # inherit a noninteractive frontend.
  run_with_progress "Updating apt package metadata" \
    env DEBIAN_FRONTEND=noninteractive apt-get "${APT_COMMON_OPTIONS[@]}" update || status=$?
  if [ "$status" -ne 0 ]; then
    print_package_failure_diagnostics "apt-get update" "$status"
    fatal "Could not update apt package metadata. Nothing was installed."
  fi

  status=0
  run_with_progress "Installing packages: ${missing[*]}" \
    env DEBIAN_FRONTEND=noninteractive apt-get "${APT_COMMON_OPTIONS[@]}" install -y "${missing[@]}" || status=$?
  if [ "$status" -ne 0 ]; then
    print_package_failure_diagnostics "Package installation" "$status" "${missing[*]}"
    fatal "Failed to install required packages: ${missing[*]}"
  fi

  # Trust dpkg, not apt's exit code, for the final answer on whether
  # every package is actually present and configured.
  local still_missing=()
  for pkg in "${missing[@]}"; do
    package_is_installed "$pkg" || still_missing+=("$pkg")
  done
  if [ "${#still_missing[@]}" -ne 0 ]; then
    print_package_failure_diagnostics "Package installation" "0" "${still_missing[*]}"
    fatal "apt-get reported success but these packages are still not installed: ${still_missing[*]}"
  fi

  log_pass "Base packages installed: ${missing[*]}"
}
