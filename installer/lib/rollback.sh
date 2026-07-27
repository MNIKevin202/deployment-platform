#!/usr/bin/env bash
#
# rollback.sh — failure-handling policy (section 19). The installer
# deliberately does NOT attempt a full automatic teardown on failure —
# most of what it creates (secrets, the database, source releases,
# backups) is exactly what section 19 lists as "never automatically
# delete". Only resources this specific run created AND that are
# provably unused (a half-created container that never started, a
# stray temp directory) are cleaned up automatically.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "rollback.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

INSTALLER_TEMP_DIRS=()
INSTALLER_TEMP_FILES=()
INSTALLER_CREATED_CONTAINERS_UNSTARTED=()

track_temp_dir() {
  INSTALLER_TEMP_DIRS+=("$1")
}

track_temp_file() {
  INSTALLER_TEMP_FILES+=("$1")
}

cleanup_on_exit() {
  local exit_code=$?

  # Restore the terminal and reap any wrapped command still running,
  # before anything else — otherwise an interrupted long-running step
  # could leave the cursor hidden or a child process orphaned.
  if command -v progress_cleanup >/dev/null 2>&1; then
    progress_cleanup
  fi

  local path
  for path in "${INSTALLER_TEMP_DIRS[@]:-}"; do
    [ -n "$path" ] || continue
    # Historically this list only ever handled directories, so a tracked
    # *file* (install.sh tracks the short-lived plaintext admin-password
    # file here) was silently never removed on a failure path. Handle
    # both shapes, so a tracked path is always cleaned up regardless of
    # which helper recorded it.
    if [ -d "$path" ]; then
      rm -rf "$path"
    elif [ -f "$path" ]; then
      rm -f "$path"
    fi
  done

  for path in "${INSTALLER_TEMP_FILES[@]:-}"; do
    [ -n "$path" ] && [ -f "$path" ] && rm -f "$path"
  done

  if [ "$exit_code" -ne 0 ] && [ "${INSTALLER_FAILED_STAGE:-}" != "" ]; then
    print_failure_report "$exit_code"
  fi

  return 0
}

print_failure_report() {
  local exit_code="$1"

  echo
  log_fail "Installation did not complete (stage: ${INSTALLER_FAILED_STAGE:-unknown})."
  echo
  echo "Preserved (never automatically removed):"
  echo "  - Any existing database and its Docker volume ($API_DATA_VOLUME_NAME)"
  echo "  - Any generated secrets (${INSTALL_ROOT}/config/auth.env)"
  echo "  - Any already-created source release directories"
  echo "  - Any database backups"
  echo "  - Installer state (${STATE_FILE:-${INSTALL_ROOT}/state/installer-state.json})"
  echo
  echo "Resume with:"
  echo "  sudo ./installer/install.sh --resume"
  echo
  echo "Full log: ${INSTALLER_LOG_FILE:-${INSTALL_ROOT}/logs/installer.log}"
  echo

  state_set_failed "${INSTALLER_FAILED_STAGE:-unknown}" "Installation stopped with exit code ${exit_code}."
}

install_trap_handlers() {
  trap cleanup_on_exit EXIT
}
