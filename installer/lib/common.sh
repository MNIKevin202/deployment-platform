#!/usr/bin/env bash
#
# common.sh — logging, sanitization, and small shared helpers used by
# every other installer library. Sourced first by install.sh; every
# other lib/*.sh file assumes these functions already exist.
#
# This file must never be executed directly.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "common.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

# ============================================================
# Logging
# ============================================================
#
# Console output uses [PASS]/[WARN]/[FAIL]/[INFO]/[ACTION REQUIRED]
# markers (section 26). Every line is also appended, timestamped, to
# the installer log file — but never a line that might carry a secret;
# callers are responsible for only ever passing already-sanitized text
# to these functions. log_redact() exists as a defense-in-depth second
# pass for anything logged from a less-trusted code path.

INSTALLER_LOG_FILE="${INSTALLER_LOG_FILE:-/opt/deployment-platform/logs/installer.log}"
INSTALLER_LOG_MAX_BYTES=$((10 * 1024 * 1024))

log_redact() {
  # Defense in depth only — every caller is expected to already pass
  # sanitized text. Strips anything that looks like it could be a
  # secret value assignment before it ever reaches disk or the console.
  sed -E \
    -e 's/(PASSWORD[A-Z_]*=)[^ ]+/\1[redacted]/gi' \
    -e 's/(SECRET[A-Z_]*=)[^ ]+/\1[redacted]/gi' \
    -e 's/(TOKEN[A-Z_]*=)[^ ]+/\1[redacted]/gi' \
    -e 's/(KEY[A-Z_]*=)[^ ]+/\1[redacted]/gi' \
    -e 's/(HASH[A-Z_]*=)[^ ]+/\1[redacted]/gi'
}

_log_line() {
  local marker="$1"
  local message="$2"
  local sanitized
  sanitized="$(printf '%s' "$message" | log_redact)"

  printf '%s\n' "[$marker] $sanitized"

  if [ -n "${INSTALLER_LOG_FILE:-}" ]; then
    mkdir -p "$(dirname "$INSTALLER_LOG_FILE")" 2>/dev/null || true
    printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$marker" "$sanitized" >> "$INSTALLER_LOG_FILE" 2>/dev/null || true
    _rotate_log_if_needed
  fi
}

_rotate_log_if_needed() {
  [ -f "$INSTALLER_LOG_FILE" ] || return 0
  local size
  size="$(wc -c < "$INSTALLER_LOG_FILE" 2>/dev/null || echo 0)"
  if [ "${size:-0}" -gt "$INSTALLER_LOG_MAX_BYTES" ]; then
    mv -f "$INSTALLER_LOG_FILE" "${INSTALLER_LOG_FILE}.1" 2>/dev/null || true
    : > "$INSTALLER_LOG_FILE" 2>/dev/null || true
  fi
}

log_info() { _log_line "INFO" "$1"; }
log_pass() { _log_line "PASS" "$1"; }
log_warn() { _log_line "WARN" "$1"; }
log_fail() { _log_line "FAIL" "$1"; }
log_action() { _log_line "ACTION REQUIRED" "$1"; }

log_stage() {
  printf '\n===== %s =====\n' "$1"
  _log_line "INFO" "Stage: $1"
}

fatal() {
  log_fail "$1"
  exit 1
}

# ============================================================
# Command execution wrapper
# ============================================================
#
# Every mutating command in the installer should go through run_cmd (or
# be a direct, reviewed exception) so dry-run mode has exactly one
# choke point — never a scattered set of "if dry_run" checks that could
# drift out of sync.

DRY_RUN="${DRY_RUN:-0}"

run_cmd() {
  local description="$1"
  shift

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: $description"
    return 0
  fi

  log_info "Running: $description"
  if "$@"; then
    return 0
  fi
  local status=$?
  log_fail "Command failed ($description), exit code $status"
  return "$status"
}

# ============================================================
# Small validation/utility helpers
# ============================================================

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fatal "This installer must be run as root (try: sudo ./installer/install.sh). Nothing was changed."
  fi
}

confirm_yes_no() {
  local prompt="$1"
  local answer=""
  printf '%s [y/N]: ' "$prompt"
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# A tightly bounded, POSIX-portable "is this a safe simple token"
# check — used before any value derived from user input is placed into
# a filename, directory name, or template substitution. Domains have
# their own stricter validator in prompts.sh; this is the generic
# fallback for anything else (e.g. --source-ref).
is_safe_token() {
  [[ "$1" =~ ^[A-Za-z0-9._/-]{1,255}$ ]] && [[ "$1" != *..* ]] && [[ "$1" != /* ]]
}

now_iso8601() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

bytes_to_human() {
  local bytes="$1"
  if [ "$bytes" -ge $((1024 * 1024 * 1024)) ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.1f GB", b / 1073741824 }'
  elif [ "$bytes" -ge $((1024 * 1024)) ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.0f MB", b / 1048576 }'
  else
    printf '%s bytes' "$bytes"
  fi
}
