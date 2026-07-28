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

# Human-readable installer output goes to the operator's terminal
# channel — NOT to stdout. stdout is reserved for the one value a
# function returns to its caller, exactly as it is for the prompt_*
# functions, because several installer functions are invoked through
# command substitution:
#   RELEASE_DIR="$(acquire_source_from_local_path ...)"
#   BUILT_API_IMAGE="$(build_platform_image ...)"
# Those functions also log progress as they work. If a log line went to
# stdout it would be captured into the caller's variable alongside the
# real return value, so RELEASE_DIR would become
# "[INFO] Copying source from ...\n/opt/.../release-..." instead of a
# usable path. Writing log lines to the terminal channel keeps captured
# stdout clean, and is identical from the operator's point of view (both
# stdout and stderr land on their terminal).
# The 2>/dev/null comes BEFORE the append on purpose. Redirections are
# applied left to right, so stderr is already discarded by the time the
# append to /dev/tty is attempted. With the two in the other order, a
# session that has no controlling terminal — `ssh host deployment-platform
# verify`, cron, a CI runner — printed a shell-level
#   /dev/tty: No such device or address
# in front of EVERY log line, because that message is emitted by the
# failing redirection itself and never saw the 2>/dev/null. The fallback
# to stderr already handled the output correctly; only the noise was the
# problem, and it made a completely healthy verification run look broken.
_visible_line() {
  printf '%s\n' "$1" 2>/dev/null >> "${PROMPT_OUTPUT_PATH:-/dev/tty}" || printf '%s\n' "$1" >&2
}

_log_line() {
  local marker="$1"
  local message="$2"
  local sanitized
  sanitized="$(printf '%s' "$message" | log_redact)"

  _visible_line "[$marker] $sanitized"

  if [ -n "${INSTALLER_LOG_FILE:-}" ]; then
    mkdir -p "$(dirname "$INSTALLER_LOG_FILE")" 2>/dev/null || true
    # 2>/dev/null before the append, for the same reason as _visible_line:
    # an unwritable log path must fail silently, not print a shell error
    # in front of the operator's output.
    printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$marker" "$sanitized" 2>/dev/null >> "$INSTALLER_LOG_FILE" || true
    _rotate_log_if_needed
  fi
}

# Log-file-only entry: never shown on the terminal, always plain text
# with no ANSI/carriage-return animation. Used for the structured
# START/COMMAND/DONE/FAIL records run_with_progress writes around each
# long-running command.
_log_plain() {
  local sanitized
  sanitized="$(printf '%s' "$1" | log_redact)"
  if [ -n "${INSTALLER_LOG_FILE:-}" ]; then
    mkdir -p "$(dirname "$INSTALLER_LOG_FILE")" 2>/dev/null || true
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sanitized" >> "$INSTALLER_LOG_FILE" 2>/dev/null || true
    _rotate_log_if_needed
  fi
}

# Appends a captured command's full output to the installer log,
# indented and redacted. `tr -d '\r'` matters: apt and docker both emit
# carriage-return-based progress redraws, and without stripping them the
# log would fill with overwritten animation fragments instead of
# readable lines.
_append_output_to_log() {
  local file="$1"
  [ -f "$file" ] || return 0
  [ -n "${INSTALLER_LOG_FILE:-}" ] || return 0
  mkdir -p "$(dirname "$INSTALLER_LOG_FILE")" 2>/dev/null || true
  tr -d '\r' < "$file" | log_redact | sed 's/^/    | /' >> "$INSTALLER_LOG_FILE" 2>/dev/null || true
  _rotate_log_if_needed
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
  _visible_line ""
  _visible_line "===== $1 ====="
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

# ============================================================
# TTY-aware prompt I/O
# ============================================================
#
# install.sh collects interactive answers with e.g.
# OPT_X="$(prompt_domain ...)" — command substitution, which captures
# everything a prompt function writes to stdout. If a prompt function
# printed its own label/help/error text to stdout, that text would be
# swallowed into the captured variable instead of shown to the
# operator, and the terminal would appear to hang at a blank prompt
# waiting for input to a question the operator never saw. So: stdout
# is reserved exclusively for the one, final, selected value a prompt
# function returns; everything visible (labels, choices, validation
# errors, confirmation text) goes through prompt_output, and all
# interactive input is read through prompt_read/prompt_read_secret.
#
# Input and output are two independently overridable paths — not one
# shared path — both defaulting to /dev/tty in production. A single
# shared path cannot be tested honestly: a fixture file pre-loaded
# with simulated answers necessarily already contains that input
# before the prompt runs, so asserting "the password never appears in
# the visible channel" against that same file is testing nothing.
# Separate paths let tests point input at a fixture pre-loaded with
# answers and output at a different, initially-empty fixture, exactly
# mirroring how a real terminal is one device but visible-output
# assertions and input-injection are conceptually distinct concerns.
PROMPT_INPUT_PATH="${PROMPT_INPUT_PATH:-/dev/tty}"
PROMPT_OUTPUT_PATH="${PROMPT_OUTPUT_PATH:-/dev/tty}"

# Tracks descriptor 3's readiness ("yes"/"no") *and* which path it is
# currently bound to. Opened lazily and kept open across multiple
# reads within the same input path — re-opening on every single read
# would reset a fixture file's position back to the start each time,
# breaking any prompt that needs more than one line (e.g.
# prompt_password's confirmation line). But caching readiness without
# tracking the bound path is a correctness bug: if PROMPT_INPUT_PATH
# changes between calls (as it does between tests, or between a real
# --resume-style flow and a later prompt), a stale descriptor 3 left
# over from the *previous* path would be silently reused — including
# reusing a descriptor already sitting at EOF, which reads as an empty
# value instead of failing over to stdin. PROMPT_INPUT_FD_PATH is
# compared against PROMPT_INPUT_PATH on every read; a mismatch closes
# the stale descriptor and reopens against the new path. The sentinel
# default can never equal a real path (even an intentionally empty
# PROMPT_INPUT_PATH), so the very first read always attempts to open.
PROMPT_INPUT_FD_READY=""
PROMPT_INPUT_FD_PATH="__prompt_input_fd_unset__"

_prompt_ensure_input_fd() {
  if [ "$PROMPT_INPUT_FD_PATH" != "$PROMPT_INPUT_PATH" ]; then
    # Close whatever was previously open on 3, if anything — safe as a
    # no-op when nothing is open there yet.
    exec 3<&- 2>/dev/null || true
    # `exec 3< ...` as an if-condition is safe under `set -e`: a
    # failing redirection here (no controlling terminal, e.g. ENXIO,
    # or a fixture path that doesn't exist) is exempt from triggering
    # errexit because it's the condition of an if statement, not a
    # standalone command. It also can never block: opening a TTY
    # device or a real file either succeeds or fails immediately — it
    # does not wait for input.
    if exec 3< "$PROMPT_INPUT_PATH" 2>/dev/null; then
      PROMPT_INPUT_FD_READY="yes"
    else
      PROMPT_INPUT_FD_READY="no"
    fi
    PROMPT_INPUT_FD_PATH="$PROMPT_INPUT_PATH"
  fi
}

# Test-only convenience so callers never need to poke
# PROMPT_INPUT_FD_READY/PROMPT_INPUT_FD_PATH directly: closes any
# cached descriptor and clears the cache, so the next prompt_read/
# prompt_read_secret call re-attempts opening PROMPT_INPUT_PATH from
# scratch. Not required for correctness across a PROMPT_INPUT_PATH
# change (_prompt_ensure_input_fd already detects that on its own),
# but useful to force a clean, known state between unrelated test
# cases without depending on which path they used last.
reset_prompt_io_state() {
  exec 3<&- 2>/dev/null || true
  PROMPT_INPUT_FD_READY=""
  PROMPT_INPUT_FD_PATH="__prompt_input_fd_unset__"
}

# Visible prompt output (labels, choices, validation errors,
# confirmation messages) — never the selected value itself, and never
# the password/secret value in prompt_password. Writes to
# PROMPT_OUTPUT_PATH (normally /dev/tty) when it's actually open-able,
# falling back to stderr otherwise; deliberately attempts the real
# write and falls back on failure rather than pre-checking with
# `[ -w PROMPT_OUTPUT_PATH ]`, since a tty device's own inode
# permission bits can look writable even with no controlling terminal
# at all, which would otherwise abort under `set -e` when the open
# then actually failed. Using `>>` rather than `>` matters only for a
# file-backed PROMPT_OUTPUT_PATH override in tests (a real tty has no
# meaningful truncation semantics either way) — it lets a test
# accumulate everything a multi-line prompt (e.g. prompt_choice) wrote
# across several calls instead of each call erasing the last.
prompt_output() {
  printf '%s' "$*" >> "$PROMPT_OUTPUT_PATH" 2>/dev/null || printf '%s' "$*" >&2
}

# Validates a printf -v destination name before it's ever used as an
# assignment target: must be a plain Bash identifier
# (^[a-zA-Z_][a-zA-Z0-9_]*$) — no array syntax ([...]), no command
# substitution, no whitespace, no shell metacharacters. This is a
# belt-and-suspenders check, not a substitute for avoiding eval/
# namerefs (this file uses neither) — printf -v itself already refuses
# most malformed names, but rejecting anything non-identifier-shaped
# up front means prompt_read/prompt_read_secret fail cleanly and
# predictably instead of relying on printf's own error behavior.
_prompt_valid_destination_name() {
  case "$1" in
    '') return 1 ;;
    [0-9]*) return 1 ;;
    *[!a-zA-Z0-9_]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Reads one line of interactive input into the variable named by $1,
# from PROMPT_INPUT_PATH when available, falling back to stdin
# otherwise. Uses `printf -v` (a plain fixed-name assignment target,
# available since Bash 3.1) rather than eval or indirect expansion.
#
# Every local this function declares is namespaced with a
# function-specific prefix (__prompt_read_dest, __prompt_read_buffer)
# — deliberately never a plain name like `value` or even a generic
# name like `__result_var`. prompt_read is called as `prompt_read
# value` / `prompt_read result` / `prompt_read answer` / even
# `prompt_read __result_var` throughout the prompt functions and their
# tests; Bash's dynamic scoping means a `local <name>` declared
# *inside* this function shadows a caller's own `local <name>` one
# frame up, so if this function's own destination-holder were itself
# named e.g. `__result_var`, a caller destination literally named
# "__result_var" would collide with prompt_read's *own* internal
# variable, not just a scratch buffer. Namespacing both internal
# locals with a `__prompt_read_` prefix specific to this function
# means no plausible caller-chosen destination name can ever collide.
# Callers must never name a destination variable __prompt_read_dest or
# __prompt_read_buffer — those two names are reserved for this file.
prompt_read() {
  local __prompt_read_dest="$1"
  local __prompt_read_buffer=""

  if ! _prompt_valid_destination_name "$__prompt_read_dest"; then
    return 1
  fi

  _prompt_ensure_input_fd
  if [ "$PROMPT_INPUT_FD_READY" = "yes" ]; then
    IFS= read -r __prompt_read_buffer <&3 || __prompt_read_buffer=""
  else
    IFS= read -r __prompt_read_buffer || __prompt_read_buffer=""
  fi
  printf -v "$__prompt_read_dest" '%s' "$__prompt_read_buffer"
}

# Same as prompt_read, but with echo suppressed (`read -s`) for hidden
# input such as passwords. `-s` only has an effect when the descriptor
# being read from is actually a terminal — reading from a file-backed
# PROMPT_INPUT_PATH override in tests is unaffected (there's no echo
# to suppress on a regular file). Uses its own distinctly-named locals
# (__prompt_read_secret_dest, __prompt_read_secret_buffer) for the
# same shadowing reason as prompt_read above — callers commonly name
# their destination `password` or `secret`, and must never use these
# two reserved names.
prompt_read_secret() {
  local __prompt_read_secret_dest="$1"
  local __prompt_read_secret_buffer=""

  if ! _prompt_valid_destination_name "$__prompt_read_secret_dest"; then
    return 1
  fi

  _prompt_ensure_input_fd
  if [ "$PROMPT_INPUT_FD_READY" = "yes" ]; then
    IFS= read -rs __prompt_read_secret_buffer <&3 || __prompt_read_secret_buffer=""
  else
    IFS= read -rs __prompt_read_secret_buffer || __prompt_read_secret_buffer=""
  fi
  printf -v "$__prompt_read_secret_dest" '%s' "$__prompt_read_secret_buffer"
}

confirm_yes_no() {
  local prompt="$1"
  local answer=""
  prompt_output "${prompt} [y/N]: "
  prompt_read answer
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ============================================================
# Progress reporting for long-running commands
# ============================================================
#
# Every operation that can take more than a couple of seconds (apt,
# docker build, git clone, rsync, image pulls, health waits) runs
# through run_with_progress so the installer is never silently frozen.
#
# Honesty rule: this never displays a percentage. None of these
# operations can report a trustworthy completion fraction to a shell
# wrapper, so the display is deliberately indeterminate — a spinner,
# the operation description, and real elapsed time. Where genuine
# progress information does exist it is surfaced as-is instead of being
# reduced to a made-up number: --show-output-tail echoes the command's
# own latest output line (real docker build stage names), and the
# attempt-based waits report true attempt counters via
# progress_report_attempt.
#
# Layout: the wrapped command runs in the background with its output
# redirected to a mode-600 temp file, and the spinner is drawn by this
# (foreground) function while polling the child. That means exactly one
# extra process exists — the command itself — and no separate spinner
# process can ever be orphaned.

PROGRESS_HEARTBEAT_SECONDS=15
PROGRESS_EXCERPT_LINES=30

# Set after each run_with_progress call, for callers that want to add
# their own domain-specific failure diagnostics (see packages.sh).
# PROGRESS_LAST_OUTPUT_EXCERPT holds the redacted tail of the command's
# output; the temp file itself is always deleted before returning, so
# PROGRESS_LAST_OUTPUT_FILE is only the (now-removed) path, kept for
# cleanup assertions.
PROGRESS_LAST_OUTPUT_FILE=""
PROGRESS_LAST_OUTPUT_EXCERPT=""
PROGRESS_LAST_DURATION_SECONDS=0

PROGRESS_ACTIVE_PID=""
PROGRESS_CURSOR_HIDDEN=0
PROGRESS_FD=2

# Terminal animation goes to the same visible channel prompts use, and
# only when that channel is a real terminal. Opening fd 4 and testing
# `[ -t 4 ]` is an exact check (a fixture file or a redirected pipe is
# not a tty), which is what makes non-TTY fallback automatic rather
# than guessed — including in the test suite, which points
# PROMPT_OUTPUT_PATH at a plain file.
_progress_open_output_fd() {
  PROGRESS_FD=2
  if exec 4>>"${PROMPT_OUTPUT_PATH:-/dev/tty}" 2>/dev/null; then
    PROGRESS_FD=4
  fi
}

_progress_close_output_fd() {
  exec 4>&- 2>/dev/null || true
  PROGRESS_FD=2
}

# Explicit branches rather than `>&"$PROGRESS_FD"` so the redirection
# target is always a literal digit — unambiguous on Bash 3.2.
_progress_write() {
  if [ "$PROGRESS_FD" = "4" ]; then
    printf '%s' "$1" >&4
  else
    printf '%s' "$1" >&2
  fi
}

_progress_write_line() {
  if [ "$PROGRESS_FD" = "4" ]; then
    printf '%s\n' "$1" >&4
  else
    printf '%s\n' "$1" >&2
  fi
}

_progress_elapsed_label() {
  local total="$1"
  printf '%02d:%02d' "$((total / 60))" "$((total % 60))"
}

# Actual terminal width, detected once per run_with_progress call while
# animating. This is what keeps the animation on ONE line: a rendered
# frame longer than the terminal is wide gets soft-wrapped by the
# terminal onto a second row, and `\r` then only returns to the start
# of that LAST row — so every frame strands the previous row on screen
# and the "single redrawn line" degenerates into dozens of stacked
# copies of the description (exactly what the Docker-install spinner
# did on an 80-column SSH session). Every frame is therefore truncated
# to strictly less than the detected width so it can never wrap.
PROGRESS_TERM_COLS=80

_progress_detect_columns() {
  local cols=""
  # stty reads the terminal on its stdin; point it at the same device
  # the animation writes to.
  cols="$(stty size < "${PROMPT_OUTPUT_PATH:-/dev/tty}" 2>/dev/null | awk '{print $2}')"
  [ -n "$cols" ] || cols="${COLUMNS:-}"
  case "$cols" in
    ''|*[!0-9]*) cols=80 ;;
  esac
  [ "$cols" -ge 20 ] || cols=80
  PROGRESS_TERM_COLS="$cols"
}

_progress_hide_cursor() {
  _progress_write $'\033[?25l'
  PROGRESS_CURSOR_HIDDEN=1
}

_progress_show_cursor() {
  if [ "$PROGRESS_CURSOR_HIDDEN" -eq 1 ]; then
    _progress_write $'\033[?25h'
    PROGRESS_CURSOR_HIDDEN=0
  fi
}

# Erases the animated line so the following [PASS]/[FAIL] line starts
# on a clean row instead of overwriting spinner remnants.
_progress_clear_line() {
  _progress_write $'\r\033[K'
}

_progress_render() {
  local description="$1" frame="$2" elapsed="$3" show_tail="$4" output_file="$5"
  local frames='|/-\'
  local line
  line="$(printf '%s [ %s ] %s' "$description" "${frames:$frame:1}" "$(_progress_elapsed_label "$elapsed")")"

  if [ "$show_tail" -eq 1 ] && [ -f "$output_file" ]; then
    local tail_line
    tail_line="$(tr -d '\r' < "$output_file" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 || true)"
    if [ -n "$tail_line" ]; then
      line="${line}  $(printf '%s' "$tail_line" | cut -c1-58)"
    fi
  fi

  # Truncated to strictly under the terminal width so the frame can
  # never soft-wrap — see _progress_detect_columns for why wrapping
  # breaks single-line redrawing entirely. No newline is ever written
  # while animating; the single line is redrawn in place via \r.
  _progress_write $'\r\033[K'
  _progress_write "$(printf '%s' "$line" | cut -c1-$((PROGRESS_TERM_COLS - 1)))"
}

# Restores terminal state and reaps any still-running wrapped command.
# Called both from the INT/TERM handler and from cleanup_on_exit, so a
# Ctrl+C or an unexpected exit can never leave the cursor hidden or a
# child process running.
progress_cleanup() {
  if [ -n "${PROGRESS_ACTIVE_PID:-}" ]; then
    kill "$PROGRESS_ACTIVE_PID" 2>/dev/null || true
    wait "$PROGRESS_ACTIVE_PID" 2>/dev/null || true
    PROGRESS_ACTIVE_PID=""
  fi
  _progress_show_cursor
  _progress_close_output_fd
  return 0
}

_progress_on_interrupt() {
  progress_cleanup
  _visible_line ""
  log_fail "Interrupted by the operator. The step in progress was stopped; nothing beyond it was changed."
  exit 130
}

# run_with_progress [--show-output-tail] "Description" command [args...]
#
# Runs command with its exact argument array (no eval, no re-quoting,
# no shell re-parsing), shows indeterminate progress, logs the full
# output, and returns the command's own exit status.
run_with_progress() {
  local show_tail=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --show-output-tail) show_tail=1; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done

  local description="$1"
  shift

  if [ "$#" -eq 0 ]; then
    log_fail "run_with_progress was called without a command to run (installer bug)."
    return 1
  fi

  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    log_info "[dry-run] Would run: ${description}"
    log_info "[dry-run]   command: $*"
    return 0
  fi

  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/deployment-platform-progress.XXXXXX")"
  chmod 600 "$output_file"
  if command -v track_temp_file >/dev/null 2>&1; then
    track_temp_file "$output_file"
  fi
  PROGRESS_LAST_OUTPUT_FILE="$output_file"
  PROGRESS_LAST_OUTPUT_EXCERPT=""

  _log_plain "START ${description}"
  _log_plain "COMMAND $*"

  local start_epoch
  start_epoch="$(date -u +%s)"

  _progress_open_output_fd
  local animate=0
  if [ "${INSTALLER_PROGRESS_ANIMATION:-auto}" != "off" ] && [ -t "$PROGRESS_FD" ]; then
    animate=1
    _progress_detect_columns
  fi

  # stdin comes from /dev/null deliberately. A wrapped command that
  # decided to prompt for something would otherwise block forever with a
  # spinner cheerfully animating next to it — reproducing the exact
  # "installer looks frozen" failure this whole mechanism exists to
  # prevent. With /dev/null it gets EOF and fails fast instead.
  # `4>&-` closes the progress output descriptor in the child, so the
  # wrapped command never inherits a handle on the operator's terminal
  # and can never write into the middle of the animated line.
  "$@" < /dev/null > "$output_file" 2>&1 4>&- &
  local cmd_pid=$!
  PROGRESS_ACTIVE_PID="$cmd_pid"
  trap '_progress_on_interrupt' INT TERM

  if [ "$animate" -eq 1 ]; then
    _progress_hide_cursor
  else
    # Plain, non-animated fallback: one honest start line, then a
    # periodic heartbeat. No carriage returns, no ANSI, so this is safe
    # when output is a pipe, a file, or a CI log.
    _progress_write_line "${description} ... (running)"
  fi

  local frame=0 elapsed=0 last_heartbeat=0
  while kill -0 "$cmd_pid" 2>/dev/null; do
    elapsed=$(( $(date -u +%s) - start_epoch ))
    if [ "$animate" -eq 1 ]; then
      _progress_render "$description" "$frame" "$elapsed" "$show_tail" "$output_file"
      frame=$(( (frame + 1) % 4 ))
      sleep 0.2
    else
      if [ $((elapsed - last_heartbeat)) -ge "$PROGRESS_HEARTBEAT_SECONDS" ]; then
        last_heartbeat="$elapsed"
        _progress_write_line "  ... still running: ${description} (${elapsed}s elapsed)"
      fi
      sleep 1
    fi
  done

  # `wait` as an if-condition keeps the real exit status while staying
  # safe under `set -e`. No pipeline is involved anywhere in this
  # function, so there is no PIPESTATUS ambiguity about whose status
  # this is — it is the wrapped command's own.
  local status=0
  if wait "$cmd_pid"; then
    status=0
  else
    status=$?
  fi

  PROGRESS_ACTIVE_PID=""
  trap - INT TERM

  elapsed=$(( $(date -u +%s) - start_epoch ))
  PROGRESS_LAST_DURATION_SECONDS="$elapsed"

  if [ "$animate" -eq 1 ]; then
    _progress_clear_line
    _progress_show_cursor
  fi

  _append_output_to_log "$output_file"
  PROGRESS_LAST_OUTPUT_EXCERPT="$(tr -d '\r' < "$output_file" 2>/dev/null | tail -n "$PROGRESS_EXCERPT_LINES" | log_redact || true)"
  rm -f "$output_file"

  if [ "$status" -eq 0 ]; then
    log_pass "${description} (completed in $(_progress_elapsed_label "$elapsed"))"
    _log_plain "DONE ${description} exit=0 duration=${elapsed}s"
  else
    log_fail "${description} failed (exit code ${status}, after $(_progress_elapsed_label "$elapsed"))"
    _log_plain "FAIL ${description} exit=${status} duration=${elapsed}s"
  fi

  _progress_close_output_fd
  return "$status"
}

# Prints the redacted tail of the last wrapped command's output as an
# indented block. Bounded by PROGRESS_EXCERPT_LINES so a failure never
# dumps hundreds of lines to the terminal — the complete output is
# always in the installer log regardless.
print_last_output_excerpt() {
  local heading="${1:-Recent output:}"
  _visible_line ""
  _visible_line "${heading}"
  if [ -n "${PROGRESS_LAST_OUTPUT_EXCERPT:-}" ]; then
    printf '%s\n' "$PROGRESS_LAST_OUTPUT_EXCERPT" | while IFS= read -r line; do
      _visible_line "  ${line}"
    done
  else
    _visible_line "  (no output was captured)"
  fi
}

# Honest per-attempt reporting for bounded retry/wait loops: real
# attempt numbers, real elapsed seconds, real next-delay — never an
# invented percentage or ETA.
progress_report_attempt() {
  local description="$1" attempt="$2" max_attempts="$3" elapsed="$4" next_delay="${5:-}"
  local line="${description}: attempt ${attempt}/${max_attempts}, elapsed ${elapsed}s"
  if [ -n "$next_delay" ]; then
    line="${line}, next check in ${next_delay}s"
  fi
  log_info "$line"
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

# Portable octal file mode: GNU form first (GNU stat's -f means
# "filesystem info" and can misleadingly succeed on some platforms), BSD
# form as the fallback. Same pattern as secrets.sh's _password_file_mode
# and the test suite's get_file_mode — needed because this installer's
# own test suite runs on macOS (BSD stat) even though the installer
# itself always targets a Linux VPS.
portable_file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
    return
  fi
  stat -f '%Lp' "$1" 2>/dev/null
}

# ============================================================
# Optional GitHub App private-key mount
# ============================================================
#
# Shared by platform.sh's ensure_api_container (first install) and
# secrets.sh's _recreate_api_container_for_rotation (password rotation) —
# both create the API container directly, and both need the exact same
# validation and mount as the release path (scripts/release-remote.sh's
# resolve_optional_github_key_mount, a separate implementation only
# because it runs on the Mac-invoked-over-SSH release script, a different
# execution boundary from this installer). GitHub App integration is
# always optional: no GITHUB_APP_PRIVATE_KEY_PATH configured is a silent
# no-op.
#
# Sets GITHUB_KEY_MOUNT_ARGS to a `-v <path>:<path>:ro` bind mount at the
# EXACT same path inside the container as on the host (the API reads
# GITHUB_APP_PRIVATE_KEY_PATH directly, with no translation), after
# validating:
#   - the path exists and is a regular file
#   - its mode is not group- or world-readable
# Calls fatal() on any problem — the caller must invoke this BEFORE
# stopping/removing any existing container, so a bad key path never
# leaves the platform down.
GITHUB_KEY_MOUNT_ARGS=()
resolve_github_app_key_mount_args() {
  local platform_env_file="$1"
  local auth_env_file="$2"
  GITHUB_KEY_MOUNT_ARGS=()

  local key_path=""
  local file
  for file in "$platform_env_file" "$auth_env_file"; do
    [ -f "$file" ] || continue
    local line
    line="$(grep -E '^GITHUB_APP_PRIVATE_KEY_PATH=' "$file" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      key_path="${line#GITHUB_APP_PRIVATE_KEY_PATH=}"
    fi
  done

  if [ -z "$key_path" ]; then
    return 0
  fi

  if [ ! -e "$key_path" ]; then
    fatal "GITHUB_APP_PRIVATE_KEY_PATH is configured ($key_path) but that file does not exist."
  fi
  if [ ! -f "$key_path" ]; then
    fatal "GITHUB_APP_PRIVATE_KEY_PATH ($key_path) exists but is not a regular file."
  fi

  local mode
  mode="$(portable_file_mode "$key_path" || true)"
  if [ -z "$mode" ]; then
    fatal "Unable to read the permissions of GITHUB_APP_PRIVATE_KEY_PATH ($key_path)."
  fi
  local group_and_other="${mode: -2}"
  if [ "$group_and_other" != "00" ]; then
    fatal "GITHUB_APP_PRIVATE_KEY_PATH ($key_path) is group- or world-readable (mode $mode). Restrict it first (e.g. chmod 600 $key_path)."
  fi

  GITHUB_KEY_MOUNT_ARGS=(-v "${key_path}:${key_path}:ro")
}
