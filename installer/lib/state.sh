#!/usr/bin/env bash
#
# state.sh — the installer's persistent state machine
# (/opt/deployment-platform/state/installer-state.json).
#
# Deliberately Bash-3.2-compatible (macOS ships 3.2 as /bin/bash and
# this installer must run there, not just on a newer Linux bash): no
# associative arrays (`declare -A`), no `mapfile`/`readarray`, no
# `${var,,}`/`${var^^}`, no namerefs. The state schema is small and
# fixed, so it is held as a set of plain named variables (STATE_*)
# rather than an associative array — a `state_set_field` dispatches on
# the field name via a `case` statement (never `eval`, never dynamic
# variable-name construction) so adding a new field means adding one
# `case` arm and one `printf` line in state_write_from_fields, not
# rearchitecting anything.
#
# Every write is atomic: write to a temp file in the same directory
# (so the rename is on the same filesystem), fsync it, then rename over
# the real path. A reader can never observe a half-written file.
#
# The state file is a record of *what the installer believes it did* —
# it is never the sole source of truth. Every stage that resume/verify
# relies on also re-inspects real system state (a Docker network, a
# container, a file on disk) before trusting the state file's claim
# that the stage completed; see verify.sh and the idempotency checks
# throughout the other lib files.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "state.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

STATE_DIR="${INSTALL_ROOT:-/opt/deployment-platform}/state"
STATE_FILE="${STATE_DIR}/installer-state.json"

STATE_STAGES=(
  "initialized"
  "preflight-complete"
  "packages-complete"
  "docker-complete"
  "filesystem-complete"
  "secrets-complete"
  "source-complete"
  "images-complete"
  "database-complete"
  "caddy-complete"
  "platform-started"
  "dns-pending"
  "verification-complete"
  "installation-complete"
  "failed"
)

# ============================================================
# The fixed state schema — plain variables, not an associative array.
# ============================================================

STATE_installerVersion=""
STATE_panelDomain=""
STATE_appsDomain=""
STATE_adminUsername=""
STATE_installMode=""
STATE_sourcePath=""
STATE_sourceRepository=""
STATE_sourceRef=""
STATE_sourceCommit=""
STATE_apiImage=""
STATE_webImage=""
STATE_currentStage=""
STATE_lastUpdatedAt=""
STATE_lastFailedStage=""
STATE_failureSummary=""
# Space-separated, ordered, deduplicated list of completed stage names —
# converted to a JSON array only at write time (see
# build_completed_stages_json). A plain string instead of an array
# specifically so nothing here depends on Bash 4 array features either.
STATE_completedStagesList=""

state_init_dir() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
}

json_escape() {
  # Sufficient for this file's known value set (domains, versions,
  # commit SHAs, image tags, short already-capped/redacted messages) —
  # never used on secret values, and never expected to carry embedded
  # newlines (state_set_failed's summary is a single sanitized line).
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

build_completed_stages_json() {
  local json="[" first=1 stage
  for stage in $STATE_completedStagesList; do
    if [ "$first" -eq 1 ]; then
      first=0
    else
      json="${json},"
    fi
    json="${json}\"$(json_escape "$stage")\""
  done
  json="${json}]"
  printf '%s' "$json"
}

# Writes the state file atomically. Never called with secret values —
# only the sanitized fields listed in section 17 (domains, stage names,
# commit SHAs, resource names, timestamps — never passwords, keys,
# tokens, or raw command output) ever flow into STATE_* variables.
state_write() {
  state_init_dir
  local tmp_file
  tmp_file="$(mktemp "${STATE_DIR}/.installer-state.XXXXXX")"
  chmod 600 "$tmp_file"

  cat > "$tmp_file"

  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import json,sys; json.load(open('$tmp_file'))" >/dev/null 2>&1; then
      rm -f "$tmp_file"
      fatal "Refusing to write a malformed installer state file — this is an installer bug, not a system problem."
    fi
  elif command -v jq >/dev/null 2>&1; then
    if ! jq empty "$tmp_file" >/dev/null 2>&1; then
      rm -f "$tmp_file"
      fatal "Refusing to write a malformed installer state file — this is an installer bug, not a system problem."
    fi
  fi

  # fsync where practical — a plain `sync` on the file is the closest
  # POSIX-portable approximation available from a shell script; the
  # rename() itself is what actually guarantees atomicity from a
  # reader's point of view.
  sync "$tmp_file" 2>/dev/null || true
  mv -f "$tmp_file" "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

state_write_from_fields() {
  local completed_json
  completed_json="$(build_completed_stages_json)"

  {
    printf '{\n'
    printf '  "installerVersion": "%s",\n' "$(json_escape "$STATE_installerVersion")"
    printf '  "panelDomain": "%s",\n' "$(json_escape "$STATE_panelDomain")"
    printf '  "appsDomain": "%s",\n' "$(json_escape "$STATE_appsDomain")"
    printf '  "adminUsername": "%s",\n' "$(json_escape "$STATE_adminUsername")"
    printf '  "installMode": "%s",\n' "$(json_escape "$STATE_installMode")"
    printf '  "sourcePath": "%s",\n' "$(json_escape "$STATE_sourcePath")"
    printf '  "sourceRepository": "%s",\n' "$(json_escape "$STATE_sourceRepository")"
    printf '  "sourceRef": "%s",\n' "$(json_escape "$STATE_sourceRef")"
    printf '  "sourceCommit": "%s",\n' "$(json_escape "$STATE_sourceCommit")"
    printf '  "apiImage": "%s",\n' "$(json_escape "$STATE_apiImage")"
    printf '  "webImage": "%s",\n' "$(json_escape "$STATE_webImage")"
    printf '  "currentStage": "%s",\n' "$(json_escape "$STATE_currentStage")"
    printf '  "lastUpdatedAt": "%s",\n' "$(json_escape "$STATE_lastUpdatedAt")"
    printf '  "lastFailedStage": "%s",\n' "$(json_escape "$STATE_lastFailedStage")"
    printf '  "failureSummary": "%s",\n' "$(json_escape "$STATE_failureSummary")"
    printf '  "completedStages": %s\n' "$completed_json"
    printf '}\n'
  } | state_write
}

# Dispatches by field name via a plain case statement — never eval,
# never a dynamically-constructed variable name. Call sites (install.sh)
# already pass literal field-name strings, so this is a closed,
# reviewable set, not open-ended dynamic assignment.
state_set_field() {
  local key="$1"
  local value="$2"
  case "$key" in
    installerVersion) STATE_installerVersion="$value" ;;
    panelDomain) STATE_panelDomain="$value" ;;
    appsDomain) STATE_appsDomain="$value" ;;
    adminUsername) STATE_adminUsername="$value" ;;
    installMode) STATE_installMode="$value" ;;
    sourcePath) STATE_sourcePath="$value" ;;
    sourceRepository) STATE_sourceRepository="$value" ;;
    sourceRef) STATE_sourceRef="$value" ;;
    sourceCommit) STATE_sourceCommit="$value" ;;
    apiImage) STATE_apiImage="$value" ;;
    webImage) STATE_webImage="$value" ;;
    *)
      fatal "state_set_field: unknown field '$key' — the installer state schema is fixed (this is an installer bug)."
      ;;
  esac
}

_state_stage_in_list() {
  local stage="$1"
  case " $STATE_completedStagesList " in
    *" $stage "*) return 0 ;;
    *) return 1 ;;
  esac
}

_state_mark_stage_completed() {
  local stage="$1"
  if ! _state_stage_in_list "$stage"; then
    if [ -z "$STATE_completedStagesList" ]; then
      STATE_completedStagesList="$stage"
    else
      STATE_completedStagesList="$STATE_completedStagesList $stage"
    fi
  fi
}

state_set_stage() {
  local stage="$1"
  STATE_currentStage="$stage"
  STATE_lastUpdatedAt="$(now_iso8601)"
  _state_mark_stage_completed "$stage"
  state_write_from_fields
}

state_set_failed() {
  local failed_stage="$1"
  local sanitized_summary="$2"
  STATE_currentStage="failed"
  STATE_lastFailedStage="$failed_stage"
  STATE_failureSummary="$(printf '%s' "$sanitized_summary" | log_redact)"
  STATE_lastUpdatedAt="$(now_iso8601)"
  state_write_from_fields
}

# ============================================================
# Reading — used at process start (fresh process, no in-memory
# STATE_* values yet) to bootstrap --resume and --verify-only from
# whatever was last written to disk. Uses jq when available (the
# installer's own required-package list guarantees jq on a real target
# VPS) and falls back to a bounded grep/sed pass otherwise, so this
# still works in a test environment that may not have jq installed.
# ============================================================

state_read_field() {
  local field="$1"
  [ -f "$STATE_FILE" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f] // empty' "$STATE_FILE" 2>/dev/null
  else
    grep -oE "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$STATE_FILE" 2>/dev/null \
      | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' \
      | head -n 1
  fi
}

state_get_stage() {
  state_read_field "currentStage"
}

state_exists() {
  [ -f "$STATE_FILE" ]
}

state_stage_completed() {
  local stage="$1"
  [ -f "$STATE_FILE" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg s "$stage" '.completedStages // [] | index($s) != null' "$STATE_FILE" >/dev/null 2>&1
  else
    grep -q "\"$stage\"" "$STATE_FILE" 2>/dev/null
  fi
}
