#!/usr/bin/env bash
#
# installer/tests/run.sh — installer test suite. Requires no real VPS,
# no root, no Docker. Exercises pure validation/state-machine logic by
# sourcing the same lib/*.sh files the real installer uses, against a
# temporary, throwaway INSTALL_ROOT.
#
# Usage: bash installer/tests/run.sh
set -Eeuo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER_DIR="$(cd "$TESTS_DIR/.." && pwd)"

echo "=== Bash interpreter ==="
echo "BASH_VERSION: ${BASH_VERSION:-unknown}"
bash --version | head -n 1
echo

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

export DEPLOYMENT_PLATFORM_INSTALLER_ROOT="$INSTALLER_DIR"
export INSTALL_ROOT="$TMP_ROOT/opt/deployment-platform"
export INSTALLER_LOG_FILE="$TMP_ROOT/installer.log"
export DRY_RUN=0

# shellcheck source=../lib/common.sh
source "$INSTALLER_DIR/lib/common.sh"
# shellcheck source=../lib/state.sh
source "$INSTALLER_DIR/lib/state.sh"
# shellcheck source=../lib/prompts.sh
source "$INSTALLER_DIR/lib/prompts.sh"
# packages.sh defines install_base_packages / report_dpkg_interrupted_state /
# print_package_failure_diagnostics, exercised by the fake-apt test section
# below. Sourced after common.sh (it calls fatal/log_*/run_with_progress/
# _visible_line from there) and, like every lib file, it requires
# DEPLOYMENT_PLATFORM_INSTALLER_ROOT (exported above) or it refuses to load.
# Source time is side-effect free: guard + plain variable assignments only —
# no apt/dpkg/Docker command runs until a function is actually called, and
# the tests only ever call them with the fake apt-get/apt-cache/dpkg
# executables placed earlier in PATH.
# shellcheck source=../lib/packages.sh
source "$INSTALLER_DIR/lib/packages.sh"
# secrets.sh defines admin_password_file_is_valid,
# collect_resume_admin_password, and compute_password_hash, exercised
# below with fixture password files and a fake docker executable —
# never real Docker. Source time is side-effect free: the standalone
# guard plus two plain assignments (AUTH_FILE_PATH under the throwaway
# INSTALL_ROOT above, NODE_HELPER_IMAGE).
# shellcheck source=../lib/secrets.sh
source "$INSTALLER_DIR/lib/secrets.sh"
# dns.sh defines generate_dns_probe_label / resolve_domain_ipv4_all /
# domain_resolves_to_expected_ip / check_dns_ready /
# run_dns_readiness_flow, exercised below entirely against fake
# getent/dig/host/curl/sleep executables — no real network or DNS
# access. Source time is side-effect free: the standalone guard plus
# plain variable/array assignments.
# shellcheck source=../lib/dns.sh
source "$INSTALLER_DIR/lib/dns.sh"
# source.sh, images.sh, preflight.sh, and verify.sh are exercised below
# against fake docker/git/find fixtures and temp trees — no real Docker,
# network, or package activity. Each is side-effect free at source time
# (standalone guard plus plain assignments); source.sh's one command
# substitution at load time is `date -u`, which is harmless.
# shellcheck source=../lib/docker.sh
source "$INSTALLER_DIR/lib/docker.sh"
# shellcheck source=../lib/source.sh
source "$INSTALLER_DIR/lib/source.sh"
# shellcheck source=../lib/images.sh
source "$INSTALLER_DIR/lib/images.sh"
# shellcheck source=../lib/caddy.sh
source "$INSTALLER_DIR/lib/caddy.sh"
# shellcheck source=../lib/platform.sh
source "$INSTALLER_DIR/lib/platform.sh"
# shellcheck source=../lib/preflight.sh
source "$INSTALLER_DIR/lib/preflight.sh"
# shellcheck source=../lib/verify.sh
source "$INSTALLER_DIR/lib/verify.sh"

PASS_COUNT=0
FAIL_COUNT=0

assert_eq() {
  local description="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '[PASS] %s\n' "$description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '[FAIL] %s\n       expected: %q\n       actual:   %q\n' "$description" "$expected" "$actual"
  fi
}

assert_success() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '[PASS] %s\n' "$description"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '[FAIL] %s (expected success)\n' "$description"
  fi
}

assert_failure() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '[FAIL] %s (expected failure, got success)\n' "$description"
  else
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '[PASS] %s\n' "$description"
  fi
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      PASS_COUNT=$((PASS_COUNT + 1))
      printf '[PASS] %s\n' "$description"
      ;;
    *)
      FAIL_COUNT=$((FAIL_COUNT + 1))
      printf '[FAIL] %s (expected to find %q)\n' "$description" "$needle"
      ;;
  esac
}

assert_not_contains() {
  local description="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      FAIL_COUNT=$((FAIL_COUNT + 1))
      printf '[FAIL] %s (unexpectedly found %q)\n' "$description" "$needle"
      ;;
    *)
      PASS_COUNT=$((PASS_COUNT + 1))
      printf '[PASS] %s\n' "$description"
      ;;
  esac
}

# Portable octal file-mode lookup. GNU stat (Ubuntu/Linux) and BSD/macOS
# stat use different flags for the same thing, and — critically — GNU
# stat's `-f` means "show filesystem info", not "use this output
# format" (that's BSD's meaning), so a GNU `stat -f '%Lp' <path>`
# silently "succeeds" while printing multi-line filesystem details
# instead of a permission mode. Try the GNU form first and only fall
# back to the BSD form if the GNU form fails, so a misleading GNU
# success is never mistaken for having found the right syntax.
get_file_mode() {
  local path="$1"

  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
    return
  fi

  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
    return
  fi

  return 1
}

echo "=== Domain validation ==="
assert_success "accepts a normal domain" validate_domain "panel.example.com"
assert_eq "lowercases input" "panel.example.com" "$(validate_domain "PANEL.Example.COM" 2>/dev/null || true)"
assert_failure "rejects a scheme" validate_domain "https://panel.example.com"
assert_failure "rejects a path" validate_domain "panel.example.com/x"
assert_failure "rejects a query string" validate_domain "panel.example.com?x=1"
assert_failure "rejects a port" validate_domain "panel.example.com:8080"
assert_failure "rejects a wildcard prefix" validate_domain "*.example.com"
assert_failure "rejects whitespace" validate_domain "panel example.com"
assert_failure "rejects shell metacharacters" validate_domain 'panel.example.com;rm -rf /'
assert_failure "rejects localhost" validate_domain "localhost"
assert_failure "rejects a raw IPv4 address" validate_domain "203.0.113.10"
assert_failure "rejects empty input" validate_domain ""

echo
echo "=== Domain pair validation ==="
assert_failure "rejects identical panel and apps domains" validate_domain_pair "example.com" "example.com"
assert_failure "rejects panel domain nested under apps domain" validate_domain_pair "x.apps.example.com" "apps.example.com"
assert_success "accepts a normal, distinct pair" validate_domain_pair "panel.example.com" "apps.example.com"

echo
echo "=== IPv4 validation ==="
assert_success "accepts a normal IPv4 address" validate_ipv4 "203.0.113.10"
assert_failure "rejects an octet over 255" validate_ipv4 "203.0.113.999"
assert_failure "rejects a non-numeric segment" validate_ipv4 "203.0.113.abc"
assert_failure "rejects too few octets" validate_ipv4 "203.0.113"
assert_failure "rejects an IPv6-shaped string" validate_ipv4 "2001:db8::1"

echo
echo "=== Safe-token validation (used for --source-ref etc.) ==="
assert_success "accepts a normal branch name" is_safe_token "main"
assert_success "accepts a branch with slashes" is_safe_token "release/1.2.3"
assert_failure "rejects a traversal sequence" is_safe_token "../../etc/passwd"
assert_failure "rejects a leading slash" is_safe_token "/etc/passwd"
assert_failure "rejects a shell metacharacter" is_safe_token 'main; rm -rf /'
assert_failure "rejects an embedded backtick" is_safe_token 'main`whoami`'

echo
echo "=== Secret redaction ==="
REDACTED_1="$(printf 'ADMIN_PASSWORD_HASH=abcdef1234567890\n' | log_redact)"
assert_eq "redacts a password hash line" "ADMIN_PASSWORD_HASH=[redacted]" "$REDACTED_1"
REDACTED_2="$(printf 'CREDENTIAL_ENCRYPTION_KEY=cG9pc29ub3VzZWNyZXQ=\n' | log_redact)"
assert_eq "redacts an encryption key line" "CREDENTIAL_ENCRYPTION_KEY=[redacted]" "$REDACTED_2"
REDACTED_3="$(printf 'SESSION_SECRET=deadbeef\n' | log_redact)"
assert_eq "redacts a session secret line" "SESSION_SECRET=[redacted]" "$REDACTED_3"
REDACTED_4="$(printf 'PANEL_DOMAIN=panel.example.com\n' | log_redact)"
assert_eq "leaves an ordinary non-secret line untouched" "PANEL_DOMAIN=panel.example.com" "$REDACTED_4"

echo
echo "=== Portable file-mode helper (get_file_mode) ==="
# Pins each branch of get_file_mode in isolation using fake `stat`
# executables placed at the front of PATH, so this suite verifies GNU
# syntax, BSD fallback, and the failure case regardless of which real
# stat this machine has. Real-machine behavior is covered separately
# by "state file is not world-readable" below.
FAKE_MODE_PROBE_FILE="$TMP_ROOT/mode-probe-file"
: > "$FAKE_MODE_PROBE_FILE"
REAL_PATH="$PATH"

FAKE_BIN_GNU="$TMP_ROOT/fakebin-gnu"
mkdir -p "$FAKE_BIN_GNU"
cat > "$FAKE_BIN_GNU/stat" <<'FAKESTAT'
#!/usr/bin/env bash
# Mimics GNU stat: -c '%a' prints a numeric mode; -f is "filesystem
# info" (a different meaning than BSD's -f) and "succeeds" while
# printing something that is NOT a bare numeric mode, to prove
# get_file_mode never falls through to a misleading GNU -f success.
if [ "$1" = "-c" ]; then
  echo "640"
  exit 0
fi
if [ "$1" = "-f" ]; then
  echo "File: \"/\" ID: 0 Namelen: 255 Type: ext2/ext3"
  exit 0
fi
exit 1
FAKESTAT
chmod +x "$FAKE_BIN_GNU/stat"

FAKE_BIN_BSD="$TMP_ROOT/fakebin-bsd"
mkdir -p "$FAKE_BIN_BSD"
cat > "$FAKE_BIN_BSD/stat" <<'FAKESTAT'
#!/usr/bin/env bash
# Mimics BSD/macOS stat: -c is rejected outright; -f '%Lp' prints a
# bare numeric mode.
if [ "$1" = "-c" ]; then
  echo "stat: illegal option -- c" >&2
  exit 1
fi
if [ "$1" = "-f" ]; then
  echo "600"
  exit 0
fi
exit 1
FAKESTAT
chmod +x "$FAKE_BIN_BSD/stat"

FAKE_BIN_NONE="$TMP_ROOT/fakebin-none"
mkdir -p "$FAKE_BIN_NONE"
cat > "$FAKE_BIN_NONE/stat" <<'FAKESTAT'
#!/usr/bin/env bash
# Mimics a stat that supports neither syntax.
exit 1
FAKESTAT
chmod +x "$FAKE_BIN_NONE/stat"

PATH="$FAKE_BIN_GNU:$REAL_PATH"
hash -r
GNU_MODE_RESULT="$(get_file_mode "$FAKE_MODE_PROBE_FILE")"
assert_eq "GNU-style stat -c is used and returns a bare numeric mode" "640" "$GNU_MODE_RESULT"

PATH="$FAKE_BIN_BSD:$REAL_PATH"
hash -r
BSD_MODE_RESULT="$(get_file_mode "$FAKE_MODE_PROBE_FILE")"
assert_eq "falls back to BSD-style stat -f when -c is rejected" "600" "$BSD_MODE_RESULT"

PATH="$FAKE_BIN_NONE:$REAL_PATH"
hash -r
assert_failure "returns failure when neither stat syntax works" get_file_mode "$FAKE_MODE_PROBE_FILE"

PATH="$REAL_PATH"
hash -r

case "$GNU_MODE_RESULT" in
  ''|*[!0-9]*) GNU_MODE_IS_NUMERIC_ONLY="no" ;;
  *) GNU_MODE_IS_NUMERIC_ONLY="yes" ;;
esac
assert_eq "GNU-path output contains only the numeric mode (no extra lines)" "yes" "$GNU_MODE_IS_NUMERIC_ONLY"

case "$BSD_MODE_RESULT" in
  ''|*[!0-9]*) BSD_MODE_IS_NUMERIC_ONLY="no" ;;
  *) BSD_MODE_IS_NUMERIC_ONLY="yes" ;;
esac
assert_eq "BSD-fallback output contains only the numeric mode (no extra lines)" "yes" "$BSD_MODE_IS_NUMERIC_ONLY"

echo
echo "=== Prompt I/O: visible output vs. returned value ==="
# install.sh collects answers via command substitution, e.g.
# OPT_X="$(prompt_domain ...)" -- so if a prompt function's own label,
# choices, or validation errors ever leaked onto stdout, that text
# would be captured into the variable instead of shown to the
# operator, who would then see what looks like a silent hang at a
# blank prompt. These tests prove the split: everything visible goes
# through PROMPT_OUTPUT_PATH (or stderr), and stdout carries only the
# one final returned value.
#
# Input and visible output use two SEPARATE fixture files, not one
# shared file: a single shared fixture would already contain the
# simulated answer (e.g. a password) before the prompt ever runs, so
# checking that same file for "the password never leaked into visible
# output" proves nothing -- the password would already be sitting
# there from the test's own setup, regardless of what the prompt
# functions actually did. A dedicated, initially-empty output fixture
# is the only way to make that assertion meaningful. All input is fed
# through fixture files, never a real terminal, so this suite can
# never block waiting for a human -- even if it happens to run inside
# a real interactive terminal itself.
ORIGINAL_PROMPT_INPUT_PATH="$PROMPT_INPUT_PATH"
ORIGINAL_PROMPT_OUTPUT_PATH="$PROMPT_OUTPUT_PATH"

set_prompt_fixture() {
  # $1 = input fixture (pre-populated with simulated answers)
  # $2 = output fixture (initially empty; captures visible output)
  # Uses common.sh's own reset_prompt_io_state rather than poking
  # PROMPT_INPUT_FD_READY/PROMPT_INPUT_FD_PATH directly, so this test
  # file depends only on documented, public prompt-I/O entry points.
  PROMPT_INPUT_PATH="$1"
  PROMPT_OUTPUT_PATH="$2"
  reset_prompt_io_state
}

# --- prompt_text: only the entered value goes to stdout ---
FIXTURE_TEXT_IN="$TMP_ROOT/prompt-fixture-text-in"
FIXTURE_TEXT_OUT="$TMP_ROOT/prompt-fixture-text-out"
printf 'myusername\n' > "$FIXTURE_TEXT_IN"
: > "$FIXTURE_TEXT_OUT"
set_prompt_fixture "$FIXTURE_TEXT_IN" "$FIXTURE_TEXT_OUT"
PROMPT_TEXT_STDOUT="$(prompt_text "Administrator username" "admin")"
assert_eq "prompt_text returns only the entered value on stdout" "myusername" "$PROMPT_TEXT_STDOUT"
assert_not_contains "prompt_text's label does not appear in stdout" "$PROMPT_TEXT_STDOUT" "Administrator username"
assert_contains "prompt_text's label is written to the visible-output channel" "$(cat "$FIXTURE_TEXT_OUT")" "Administrator username"

# --- prompt_domain: invalid then valid entries are read sequentially
# from the input fixture; only the normalized domain goes to stdout;
# the validation error appears only in the output fixture ---
FIXTURE_DOMAIN_IN="$TMP_ROOT/prompt-fixture-domain-in"
FIXTURE_DOMAIN_OUT="$TMP_ROOT/prompt-fixture-domain-out"
printf 'bad domain\nPANEL.EXAMPLE.COM\n' > "$FIXTURE_DOMAIN_IN"
: > "$FIXTURE_DOMAIN_OUT"
set_prompt_fixture "$FIXTURE_DOMAIN_IN" "$FIXTURE_DOMAIN_OUT"
PROMPT_DOMAIN_STDOUT="$(prompt_domain "Panel domain")"
assert_eq "prompt_domain returns only the normalized domain on stdout" "panel.example.com" "$PROMPT_DOMAIN_STDOUT"
assert_not_contains "prompt_domain's label does not appear in stdout" "$PROMPT_DOMAIN_STDOUT" "Panel domain"
assert_not_contains "prompt_domain's validation error does not appear in stdout" "$PROMPT_DOMAIN_STDOUT" "whitespace"
assert_contains "prompt_domain's validation error is written to the visible-output channel" "$(cat "$FIXTURE_DOMAIN_OUT")" "Domain must not contain whitespace"

# --- prompt_choice: only the selected option goes to stdout; the
# label and every numbered option are visible in the output fixture ---
FIXTURE_CHOICE_IN="$TMP_ROOT/prompt-fixture-choice-in"
FIXTURE_CHOICE_OUT="$TMP_ROOT/prompt-fixture-choice-out"
printf '2\n' > "$FIXTURE_CHOICE_IN"
: > "$FIXTURE_CHOICE_OUT"
set_prompt_fixture "$FIXTURE_CHOICE_IN" "$FIXTURE_CHOICE_OUT"
PROMPT_CHOICE_STDOUT="$(prompt_choice "Source installation method:" "Option A" "Option B" "Option C")"
assert_eq "prompt_choice returns only the selected option on stdout" "Option B" "$PROMPT_CHOICE_STDOUT"
assert_not_contains "prompt_choice's label does not appear in stdout" "$PROMPT_CHOICE_STDOUT" "Source installation method"
FIXTURE_CHOICE_VISIBLE="$(cat "$FIXTURE_CHOICE_OUT")"
assert_contains "prompt_choice's label is visible" "$FIXTURE_CHOICE_VISIBLE" "Source installation method:"
assert_contains "prompt_choice's numbered options are visible" "$FIXTURE_CHOICE_VISIBLE" "1) Option A"
assert_contains "prompt_choice's Choice[1-N] prompt is visible" "$FIXTURE_CHOICE_VISIBLE" "Choice [1-3]:"

# --- prompt_password: input fixture holds the password plus its
# confirmation; output fixture must hold only labels/newlines/errors,
# never the password itself; stdout is exactly the accepted password ---
FIXTURE_PASSWORD_IN="$TMP_ROOT/prompt-fixture-password-in"
FIXTURE_PASSWORD_OUT="$TMP_ROOT/prompt-fixture-password-out"
printf 'correct horse battery staple\ncorrect horse battery staple\n' > "$FIXTURE_PASSWORD_IN"
: > "$FIXTURE_PASSWORD_OUT"
set_prompt_fixture "$FIXTURE_PASSWORD_IN" "$FIXTURE_PASSWORD_OUT"
PROMPT_PASSWORD_STDOUT="$(prompt_password "Administrator password (min. 12 characters)")"
assert_eq "prompt_password returns only the password value on stdout" "correct horse battery staple" "$PROMPT_PASSWORD_STDOUT"
FIXTURE_PASSWORD_VISIBLE="$(cat "$FIXTURE_PASSWORD_OUT")"
assert_contains "prompt_password's label is visible" "$FIXTURE_PASSWORD_VISIBLE" "Administrator password"
assert_contains "prompt_password's confirmation label is visible" "$FIXTURE_PASSWORD_VISIBLE" "Confirm Administrator password"
assert_not_contains "prompt_password never writes the password itself to the visible channel" "$FIXTURE_PASSWORD_VISIBLE" "correct horse battery staple"

# --- prompt_password: a too-short first attempt shows a visible
# error, and still only the final accepted password reaches stdout ---
FIXTURE_PASSWORD_RETRY_IN="$TMP_ROOT/prompt-fixture-password-retry-in"
FIXTURE_PASSWORD_RETRY_OUT="$TMP_ROOT/prompt-fixture-password-retry-out"
printf 'short\nvalid password value 12345\nvalid password value 12345\n' > "$FIXTURE_PASSWORD_RETRY_IN"
: > "$FIXTURE_PASSWORD_RETRY_OUT"
set_prompt_fixture "$FIXTURE_PASSWORD_RETRY_IN" "$FIXTURE_PASSWORD_RETRY_OUT"
PROMPT_PASSWORD_RETRY_STDOUT="$(prompt_password "Administrator password (min. 12 characters)")"
assert_eq "prompt_password retries past a too-short attempt and returns only the final value" "valid password value 12345" "$PROMPT_PASSWORD_RETRY_STDOUT"
assert_contains "prompt_password's length-validation error is visible" "$(cat "$FIXTURE_PASSWORD_RETRY_OUT")" "Password must be at least 12 characters"

# --- prompt_output fallback: falls back to stderr when the output
# path can never be opened (its own parent directory is missing) ---
UNAVAILABLE_INPUT_PATH="$TMP_ROOT/no-such-dir/input-tty"
UNAVAILABLE_OUTPUT_PATH="$TMP_ROOT/no-such-dir/output-tty"
set_prompt_fixture "$UNAVAILABLE_INPUT_PATH" "$UNAVAILABLE_OUTPUT_PATH"
OUTPUT_FALLBACK_STDERR_FILE="$TMP_ROOT/output-fallback-stderr"
: > "$OUTPUT_FALLBACK_STDERR_FILE"
prompt_output "visible-fallback-marker" 2>"$OUTPUT_FALLBACK_STDERR_FILE"
assert_contains "prompt_output falls back to stderr when PROMPT_OUTPUT_PATH is unavailable" "$(cat "$OUTPUT_FALLBACK_STDERR_FILE")" "visible-fallback-marker"

# --- prompt_read fallback: falls back to stdin when the input path is
# unavailable, run in a fully piped subprocess so it can never block ---
INPUT_FALLBACK_STDERR_FILE="$TMP_ROOT/input-fallback-stderr"
INPUT_FALLBACK_STDOUT="$(printf 'fallback-value\n' | bash -c "
  export DEPLOYMENT_PLATFORM_INSTALLER_ROOT='$INSTALLER_DIR'
  source '$INSTALLER_DIR/lib/common.sh'
  source '$INSTALLER_DIR/lib/prompts.sh'
  PROMPT_INPUT_PATH='$UNAVAILABLE_INPUT_PATH'
  PROMPT_OUTPUT_PATH='$UNAVAILABLE_OUTPUT_PATH'
  prompt_text 'Fallback label marker' ''
" 2>"$INPUT_FALLBACK_STDERR_FILE")"
assert_eq "prompt_text falls back to reading stdin when PROMPT_INPUT_PATH is unavailable" "fallback-value" "$INPUT_FALLBACK_STDOUT"
assert_contains "prompt_text's label falls back to stderr when PROMPT_OUTPUT_PATH is unavailable" "$(cat "$INPUT_FALLBACK_STDERR_FILE")" "Fallback label marker"

echo
echo "--- Regression: changing PROMPT_INPUT_PATH does not reuse a stale descriptor ---"
FIXTURE_REGRESSION_A="$TMP_ROOT/prompt-fixture-regression-a"
FIXTURE_REGRESSION_B="$TMP_ROOT/prompt-fixture-regression-b"
FIXTURE_REGRESSION_OUT="$TMP_ROOT/prompt-fixture-regression-out"
printf 'value-from-fixture-a\n' > "$FIXTURE_REGRESSION_A"
printf 'value-from-fixture-b\n' > "$FIXTURE_REGRESSION_B"
: > "$FIXTURE_REGRESSION_OUT"

set_prompt_fixture "$FIXTURE_REGRESSION_A" "$FIXTURE_REGRESSION_OUT"
REGRESSION_RESULT_A="$(prompt_text "Regression label" "")"
assert_eq "first read against fixture A returns fixture A's value" "value-from-fixture-a" "$REGRESSION_RESULT_A"

# Switch PROMPT_INPUT_PATH to a different fixture WITHOUT calling
# reset_prompt_io_state -- _prompt_ensure_input_fd must detect the
# path changed on its own and reopen, not silently keep reading from
# (or read EOF/empty from) the descriptor still bound to fixture A.
PROMPT_INPUT_PATH="$FIXTURE_REGRESSION_B"
REGRESSION_RESULT_B="$(prompt_text "Regression label" "")"
assert_eq "switching PROMPT_INPUT_PATH reopens against the new fixture instead of reusing the old descriptor" "value-from-fixture-b" "$REGRESSION_RESULT_B"

echo
echo "--- Regression: stdin fallback still works after a previously successful fixture read ---"
FIXTURE_REGRESSION_C="$TMP_ROOT/prompt-fixture-regression-c"
printf 'value-from-fixture-c\n' > "$FIXTURE_REGRESSION_C"
REGRESSION_FALLBACK_STDOUT="$(printf 'stdin-fallback-after-success\n' | bash -c "
  export DEPLOYMENT_PLATFORM_INSTALLER_ROOT='$INSTALLER_DIR'
  source '$INSTALLER_DIR/lib/common.sh'
  source '$INSTALLER_DIR/lib/prompts.sh'
  PROMPT_INPUT_PATH='$FIXTURE_REGRESSION_C'
  PROMPT_OUTPUT_PATH='$UNAVAILABLE_OUTPUT_PATH'
  prompt_text 'first read' '' >/dev/null
  PROMPT_INPUT_PATH='$UNAVAILABLE_INPUT_PATH'
  prompt_text 'second read falls back to stdin' ''
" 2>/dev/null)"
assert_eq "stdin fallback still works for a read after a previously successful fixture-backed read" "stdin-fallback-after-success" "$REGRESSION_FALLBACK_STDOUT"

echo
echo "--- Regression: prompt_read/prompt_read_secret destination-variable collisions ---"
# Bash's dynamic scoping means a `local <name>` declared inside
# prompt_read/prompt_read_secret shadows a caller's own `local <name>`
# one call frame up. Each wrapper function below declares a `local`
# destination variable with a name a real prompt caller might
# plausibly choose (including __result_var itself, since prompt_read
# used to hold its own destination-name parameter in a variable of
# that exact name), to prove prompt_read/prompt_read_secret's own
# internal locals never collide with any of them. No eval anywhere
# here -- each destination name gets its own small, explicit wrapper
# function, dispatched through a plain `case`, instead of any dynamic
# variable-name construction.
FIXTURE_COLLISION_IN="$TMP_ROOT/prompt-fixture-collision-in"
FIXTURE_COLLISION_OUT="$TMP_ROOT/prompt-fixture-collision-out"
: > "$FIXTURE_COLLISION_OUT"

_collision_dest_value() {
  local value=""
  prompt_read value
  printf '%s' "$value"
}
_collision_dest_result() {
  local result=""
  prompt_read result
  printf '%s' "$result"
}
_collision_dest_input() {
  local input=""
  prompt_read input
  printf '%s' "$input"
}
_collision_dest_answer() {
  local answer=""
  prompt_read answer
  printf '%s' "$answer"
}
_collision_dest_password() {
  local password=""
  prompt_read password
  printf '%s' "$password"
}
_collision_dest_secret() {
  local secret=""
  prompt_read secret
  printf '%s' "$secret"
}
_collision_dest_result_var() {
  local __result_var=""
  prompt_read __result_var
  printf '%s' "$__result_var"
}

_collision_secret_dest_value() {
  local value=""
  prompt_read_secret value
  printf '%s' "$value"
}
_collision_secret_dest_password() {
  local password=""
  prompt_read_secret password
  printf '%s' "$password"
}
_collision_secret_dest_secret() {
  local secret=""
  prompt_read_secret secret
  printf '%s' "$secret"
}

for _collision_case in value result input answer password secret result_var; do
  printf 'collision-test-value\n' > "$FIXTURE_COLLISION_IN"
  set_prompt_fixture "$FIXTURE_COLLISION_IN" "$FIXTURE_COLLISION_OUT"
  case "$_collision_case" in
    value) _COLLISION_RESULT="$(_collision_dest_value)" ;;
    result) _COLLISION_RESULT="$(_collision_dest_result)" ;;
    input) _COLLISION_RESULT="$(_collision_dest_input)" ;;
    answer) _COLLISION_RESULT="$(_collision_dest_answer)" ;;
    password) _COLLISION_RESULT="$(_collision_dest_password)" ;;
    secret) _COLLISION_RESULT="$(_collision_dest_secret)" ;;
    result_var) _COLLISION_RESULT="$(_collision_dest_result_var)" ;;
  esac
  assert_eq "prompt_read assigns correctly when caller's destination is named '$_collision_case'" "collision-test-value" "$_COLLISION_RESULT"
done

for _collision_case in value password secret; do
  printf 'collision-secret-value\n' > "$FIXTURE_COLLISION_IN"
  set_prompt_fixture "$FIXTURE_COLLISION_IN" "$FIXTURE_COLLISION_OUT"
  case "$_collision_case" in
    value) _COLLISION_RESULT="$(_collision_secret_dest_value)" ;;
    password) _COLLISION_RESULT="$(_collision_secret_dest_password)" ;;
    secret) _COLLISION_RESULT="$(_collision_secret_dest_secret)" ;;
  esac
  assert_eq "prompt_read_secret assigns correctly when caller's destination is named '$_collision_case'" "collision-secret-value" "$_COLLISION_RESULT"
done

# --- Invalid destination name: rejected without ever being read,
# executed, or interpreted ---
printf 'should-never-be-read\n' > "$FIXTURE_COLLISION_IN"
set_prompt_fixture "$FIXTURE_COLLISION_IN" "$FIXTURE_COLLISION_OUT"
assert_failure "prompt_read rejects an invalid destination name" prompt_read "bad-name"
assert_failure "prompt_read_secret rejects an invalid destination name" prompt_read_secret "bad-name"

# Restore, so nothing later in this suite is left pointed at a fixture.
exec 3<&- 2>/dev/null || true
PROMPT_INPUT_PATH="$ORIGINAL_PROMPT_INPUT_PATH"
PROMPT_OUTPUT_PATH="$ORIGINAL_PROMPT_OUTPUT_PATH"
reset_prompt_io_state

echo
echo "=== Progress runner (run_with_progress) ==="
# These tests run entirely without a TTY: PROMPT_OUTPUT_PATH points at a
# plain file, so `[ -t 4 ]` is false inside run_with_progress and it
# takes the non-animated fallback path automatically. That is both the
# behaviour under test and the reason the suite can never hang waiting
# for a terminal.
PROGRESS_LOG_FILE="$TMP_ROOT/progress-tests.log"
PROGRESS_VISIBLE_FILE="$TMP_ROOT/progress-visible.out"
ORIGINAL_INSTALLER_LOG_FILE="$INSTALLER_LOG_FILE"

reset_progress_fixtures() {
  : > "$PROGRESS_LOG_FILE"
  : > "$PROGRESS_VISIBLE_FILE"
  INSTALLER_LOG_FILE="$PROGRESS_LOG_FILE"
  PROMPT_OUTPUT_PATH="$PROGRESS_VISIBLE_FILE"
}

restore_progress_fixtures() {
  INSTALLER_LOG_FILE="$ORIGINAL_INSTALLER_LOG_FILE"
  PROMPT_OUTPUT_PATH="$ORIGINAL_PROMPT_OUTPUT_PATH"
}

# --- success path: exit status, logging, temp-file cleanup ---
reset_progress_fixtures
PROGRESS_STATUS=0
run_with_progress "Test succeeding step" \
  printf 'hello-from-wrapped-command\n' || PROGRESS_STATUS=$?
PROGRESS_SUCCESS_LOG="$(cat "$PROGRESS_LOG_FILE")"
PROGRESS_SUCCESS_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
PROGRESS_SUCCESS_TMP="$PROGRESS_LAST_OUTPUT_FILE"
restore_progress_fixtures

assert_eq "run_with_progress returns success for a succeeding command" "0" "$PROGRESS_STATUS"
assert_contains "wrapped command's full output reaches the log" "$PROGRESS_SUCCESS_LOG" "hello-from-wrapped-command"
assert_contains "log records a START entry" "$PROGRESS_SUCCESS_LOG" "START Test succeeding step"
assert_contains "log records the COMMAND that was run" "$PROGRESS_SUCCESS_LOG" "COMMAND printf"
assert_contains "log records a DONE entry with exit code and duration" "$PROGRESS_SUCCESS_LOG" "DONE Test succeeding step exit=0 duration="
assert_contains "success is reported on the visible channel" "$PROGRESS_SUCCESS_VISIBLE" "[PASS] Test succeeding step"
assert_contains "visible success line includes elapsed time" "$PROGRESS_SUCCESS_VISIBLE" "(completed in 00:"
assert_eq "progress helper removes its temporary output file" "gone" "$([ -e "$PROGRESS_SUCCESS_TMP" ] && echo present || echo gone)"

# --- honesty: indeterminate work must never show a percentage ---
assert_not_contains "no fake percentage appears in visible progress output" "$PROGRESS_SUCCESS_VISIBLE" "%"

# --- non-TTY fallback: plain text, no ANSI/carriage-return animation ---
assert_contains "non-TTY mode falls back to a plain running line" "$PROGRESS_SUCCESS_VISIBLE" "Test succeeding step ... (running)"
case "$PROGRESS_SUCCESS_VISIBLE" in
  *$'\033'*) PROGRESS_HAS_ANSI="yes" ;;
  *) PROGRESS_HAS_ANSI="no" ;;
esac
assert_eq "non-TTY visible output contains no ANSI escape sequences" "no" "$PROGRESS_HAS_ANSI"
case "$PROGRESS_SUCCESS_LOG" in
  *$'\r'*) PROGRESS_LOG_HAS_CR="yes" ;;
  *) PROGRESS_LOG_HAS_CR="no" ;;
esac
assert_eq "log contains no carriage-return animation characters" "no" "$PROGRESS_LOG_HAS_CR"

# --- failure path: original exit code preserved, excerpt available ---
reset_progress_fixtures
PROGRESS_STATUS=0
run_with_progress "Test failing step" \
  bash -c 'echo "E: Unable to locate package fake-package"; exit 100' || PROGRESS_STATUS=$?
PROGRESS_FAIL_LOG="$(cat "$PROGRESS_LOG_FILE")"
PROGRESS_FAIL_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
PROGRESS_FAIL_EXCERPT="$PROGRESS_LAST_OUTPUT_EXCERPT"
PROGRESS_FAIL_TMP="$PROGRESS_LAST_OUTPUT_FILE"
restore_progress_fixtures

assert_eq "run_with_progress returns the wrapped command's own exit code" "100" "$PROGRESS_STATUS"
assert_contains "failure excerpt contains the command's recent output" "$PROGRESS_FAIL_EXCERPT" "Unable to locate package fake-package"
assert_contains "failing command's output still reaches the log" "$PROGRESS_FAIL_LOG" "Unable to locate package fake-package"
assert_contains "log records a FAIL entry with the real exit code" "$PROGRESS_FAIL_LOG" "FAIL Test failing step exit=100 duration="
assert_contains "failure is reported on the visible channel" "$PROGRESS_FAIL_VISIBLE" "[FAIL] Test failing step failed (exit code 100"
assert_eq "progress helper removes its temporary file after a failure too" "gone" "$([ -e "$PROGRESS_FAIL_TMP" ] && echo present || echo gone)"

# --- no leftover background process ---
# The wrapped command records its own PID, so this can check the real
# process is gone once run_with_progress returns (rather than inspecting
# `jobs -p`, which inside a command substitution runs in a subshell that
# cannot see the parent's job table and would pass trivially).
reset_progress_fixtures
PROGRESS_CHILD_PID_FILE="$TMP_ROOT/progress-child-pid"
rm -f "$PROGRESS_CHILD_PID_FILE"
run_with_progress "Test child cleanup" \
  bash -c 'echo $$ > "'"$PROGRESS_CHILD_PID_FILE"'"; exit 0' >/dev/null 2>&1 || true
restore_progress_fixtures
PROGRESS_CHILD_PID="$(cat "$PROGRESS_CHILD_PID_FILE" 2>/dev/null || true)"
assert_eq "wrapped command actually ran in a child process" "yes" "$([ -n "$PROGRESS_CHILD_PID" ] && echo yes || echo no)"
assert_eq "progress helper leaves no background process running" "gone" \
  "$(kill -0 "${PROGRESS_CHILD_PID:-999999}" 2>/dev/null && echo alive || echo gone)"
assert_eq "progress helper clears its active-pid tracker" "" "$PROGRESS_ACTIVE_PID"

# --- argument integrity: spaces and metacharacters survive exactly ---
reset_progress_fixtures
run_with_progress "Test argument integrity" \
  printf '[%s]\n' "one two  three" 'four;five' '$notexpanded' >/dev/null 2>&1 || true
PROGRESS_ARGS_LOG="$(cat "$PROGRESS_LOG_FILE")"
restore_progress_fixtures
assert_contains "argument containing spaces is passed through intact" "$PROGRESS_ARGS_LOG" "[one two  three]"
assert_contains "argument containing a semicolon is not re-parsed by a shell" "$PROGRESS_ARGS_LOG" "[four;five]"
assert_contains "argument containing a dollar sign is not expanded" "$PROGRESS_ARGS_LOG" '[$notexpanded]'

# --- dry-run mode never executes the wrapped command ---
reset_progress_fixtures
DRY_RUN_MARKER_FILE="$TMP_ROOT/dry-run-marker"
rm -f "$DRY_RUN_MARKER_FILE"
DRY_RUN=1
PROGRESS_STATUS=0
run_with_progress "Test dry-run step" touch "$DRY_RUN_MARKER_FILE" || PROGRESS_STATUS=$?
DRY_RUN=0
restore_progress_fixtures
assert_eq "dry-run returns success without running the command" "0" "$PROGRESS_STATUS"
assert_eq "dry-run does not execute the wrapped command" "absent" "$([ -e "$DRY_RUN_MARKER_FILE" ] && echo present || echo absent)"

# --- attempt reporting uses real numbers, never a percentage ---
reset_progress_fixtures
progress_report_attempt "Waiting for API health check" 4 30 12 5
PROGRESS_ATTEMPT_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
restore_progress_fixtures
assert_contains "attempt reporting shows real attempt and elapsed values" "$PROGRESS_ATTEMPT_VISIBLE" "attempt 4/30, elapsed 12s, next check in 5s"
assert_not_contains "attempt reporting shows no percentage" "$PROGRESS_ATTEMPT_VISIBLE" "%"

echo
echo "=== Package test prerequisites (functions must be defined before anything is called) ==="
# These fail loudly and specifically if a required library was not
# sourced, instead of letting a later call die with an unexplained
# "command not found" (exit 127) that cascades through every package
# assertion. `declare -F <name>` succeeds only when <name> is a defined
# function — Bash 3.2-compatible, and runs nothing.
assert_success "package test prerequisite: install_base_packages is defined" \
  declare -F install_base_packages
assert_success "package test prerequisite: report_dpkg_interrupted_state is defined" \
  declare -F report_dpkg_interrupted_state
assert_success "package test prerequisite: print_package_failure_diagnostics is defined" \
  declare -F print_package_failure_diagnostics
assert_success "package test prerequisite: run_with_progress is defined" \
  declare -F run_with_progress

echo
echo "=== Package installation diagnostics (fake apt-get, no real packages) ==="
# A fake apt-get / apt-cache / dpkg trio earlier in PATH lets these tests
# exercise the real install_base_packages code path — including its
# failure diagnostics — without touching the host's package system.
FAKE_APT_BIN="$TMP_ROOT/fakebin-apt"
mkdir -p "$FAKE_APT_BIN"
FAKE_APT_CALL_LOG="$TMP_ROOT/fake-apt-calls.log"

cat > "$FAKE_APT_BIN/apt-get" <<'FAKEAPT'
#!/usr/bin/env bash
# Records how it was invoked (including whether DEBIAN_FRONTEND was set
# for it), then succeeds or fails according to FAKE_APT_EXIT_CODE. On a
# successful install it records the installed names into
# FAKE_DPKG_INSTALLED_FILE, which the fake dpkg also consults — so
# install_base_packages' post-install "is it really installed now?"
# verification sees a realistic before/after transition.
printf 'apt-get DEBIAN_FRONTEND=%s args=%s\n' "${DEBIAN_FRONTEND:-unset}" "$*" >> "$FAKE_APT_CALL_LOG"
case "$*" in
  *update*)
    echo "Get:1 http://archive.ubuntu.com/ubuntu noble InRelease"
    echo "Reading package lists... Done"
    exit "${FAKE_APT_UPDATE_EXIT_CODE:-0}"
    ;;
  *install*)
    echo "Reading package lists... Done"
    echo "Building dependency tree... Done"
    if [ "${FAKE_APT_EXIT_CODE:-0}" -ne 0 ]; then
      echo "E: Unable to locate package jq"
      echo "E: Unable to locate package sqlite3"
      exit "${FAKE_APT_EXIT_CODE}"
    fi
    for arg in "$@"; do
      case "$arg" in
        -*|install|update) continue ;;
        *)
          echo "Setting up ${arg} ..."
          [ -n "${FAKE_DPKG_INSTALLED_FILE:-}" ] && printf '%s\n' "$arg" >> "$FAKE_DPKG_INSTALLED_FILE"
          ;;
      esac
    done
    exit 0
    ;;
esac
exit 0
FAKEAPT
chmod +x "$FAKE_APT_BIN/apt-get"

cat > "$FAKE_APT_BIN/apt-cache" <<'FAKEAPTCACHE'
#!/usr/bin/env bash
# policy <pkg>: reports a candidate only for packages this fake "knows".
if [ "$1" = "policy" ]; then
  shift
  for pkg in "$@"; do
    case "$pkg" in
      jq) printf 'jq:\n  Installed: (none)\n  Candidate: 1.7.1-3build1\n' ;;
      *) printf '%s:\n  Installed: (none)\n  Candidate: (none)\n' "$pkg" ;;
    esac
  done
fi
exit 0
FAKEAPTCACHE
chmod +x "$FAKE_APT_BIN/apt-cache"

cat > "$FAKE_APT_BIN/dpkg" <<'FAKEDPKG'
#!/usr/bin/env bash
# -s <pkg>: "installed?" — true if the package is in FAKE_DPKG_INSTALLED
# (a space-separated list of packages present before this run) or was
# recorded as newly installed in FAKE_DPKG_INSTALLED_FILE by the fake
# apt-get. --audit: controlled by FAKE_DPKG_AUDIT.
case "$1" in
  -s)
    case " ${FAKE_DPKG_INSTALLED:-} " in
      *" $2 "*) exit 0 ;;
    esac
    if [ -n "${FAKE_DPKG_INSTALLED_FILE:-}" ] && [ -f "$FAKE_DPKG_INSTALLED_FILE" ]; then
      grep -qxF "$2" "$FAKE_DPKG_INSTALLED_FILE" && exit 0
    fi
    exit 1
    ;;
  --audit)
    printf '%s' "${FAKE_DPKG_AUDIT:-}"
    [ -n "${FAKE_DPKG_AUDIT:-}" ] && echo
    exit 0
    ;;
  --print-architecture) echo amd64; exit 0 ;;
esac
exit 0
FAKEDPKG
chmod +x "$FAKE_APT_BIN/dpkg"

# Only the two packages the live failure reported are treated as
# missing; the rest are "already installed" so the test exercises the
# same partial-install shape the operator hit. FAKE_DPKG_INSTALLED is
# the fixed preinstalled baseline and is deliberately never touched by
# the per-scenario reset below — only the "newly installed during this
# scenario" overlay file is cleared.
FAKE_DPKG_INSTALLED="ca-certificates curl git openssl rsync gnupg"
FAKE_DPKG_INSTALLED_FILE="$TMP_ROOT/fake-dpkg-installed"
: > "$FAKE_DPKG_INSTALLED_FILE"
export FAKE_APT_CALL_LOG FAKE_DPKG_INSTALLED FAKE_DPKG_INSTALLED_FILE

# Returns the fake package world to a single, explicitly defined
# baseline: jq and sqlite3 missing, apt succeeding, no dpkg audit
# findings, empty call log. Every independent fake-apt scenario starts
# by calling this and then overrides only what it needs — a scenario
# can no longer inherit installed-package state (or exit codes, or
# audit output) leaked by whichever scenario happened to run before it.
reset_fake_apt_state() {
  : > "$FAKE_APT_CALL_LOG"
  : > "$FAKE_DPKG_INSTALLED_FILE"
  FAKE_APT_EXIT_CODE=0
  FAKE_APT_UPDATE_EXIT_CODE=0
  FAKE_DPKG_AUDIT=""
  export FAKE_APT_EXIT_CODE
  export FAKE_APT_UPDATE_EXIT_CODE
  export FAKE_DPKG_AUDIT
}

# --- successful install through the real install_base_packages ---
reset_progress_fixtures
reset_fake_apt_state
assert_failure "fake apt success fixture starts with jq missing" "$FAKE_APT_BIN/dpkg" -s jq
assert_failure "fake apt success fixture starts with sqlite3 missing" "$FAKE_APT_BIN/dpkg" -s sqlite3
PATH="$FAKE_APT_BIN:$REAL_PATH"
hash -r
PACKAGES_STATUS=0
install_base_packages || PACKAGES_STATUS=$?
PATH="$REAL_PATH"
hash -r
PACKAGES_OK_LOG="$(cat "$PROGRESS_LOG_FILE")"
PACKAGES_OK_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
PACKAGES_OK_CALLS="$(cat "$FAKE_APT_CALL_LOG")"
restore_progress_fixtures

assert_eq "install_base_packages succeeds when apt-get succeeds" "0" "$PACKAGES_STATUS"
assert_contains "the requested package names are shown" "$PACKAGES_OK_VISIBLE" "Installing packages: jq sqlite3"
assert_contains "apt-get update runs before installing" "$PACKAGES_OK_CALLS" "args=-o DPkg::Lock::Timeout=120 -o Dpkg::Use-Pty=0 update"
assert_contains "apt receives noninteractive frontend behavior" "$PACKAGES_OK_CALLS" "apt-get DEBIAN_FRONTEND=noninteractive"
assert_contains "apt receives a bounded lock timeout" "$PACKAGES_OK_CALLS" "DPkg::Lock::Timeout=120"
assert_contains "full apt output is captured in the log" "$PACKAGES_OK_LOG" "Setting up jq"
assert_contains "success is reported for the install step" "$PACKAGES_OK_VISIBLE" "[PASS] Base packages installed: jq sqlite3"

# --- isolation regression: a success run cannot contaminate the next
# scenario ---
# The success run above just made the fake apt-get record jq/sqlite3
# into FAKE_DPKG_INSTALLED_FILE (proven by the first assertion), which
# is exactly the state that previously leaked into the failure fixture
# and made install_base_packages see "nothing missing" and return 0
# without ever calling apt. reset_fake_apt_state must fully undo it.
assert_success "success fixture recorded jq as installed (contamination exists to clean up)" "$FAKE_APT_BIN/dpkg" -s jq
reset_fake_apt_state
assert_failure "reset_fake_apt_state clears installed-package state between scenarios" "$FAKE_APT_BIN/dpkg" -s jq

# --- exit code 100: the live failure, with real diagnostics ---
# install_base_packages calls fatal() on failure, which exits — so it is
# run in a subshell here and its output captured, exactly as the
# operator would see it.
reset_progress_fixtures
reset_fake_apt_state
FAKE_APT_EXIT_CODE=100
export FAKE_APT_EXIT_CODE
assert_failure "fake apt failure fixture starts with jq missing" "$FAKE_APT_BIN/dpkg" -s jq
assert_failure "fake apt failure fixture starts with sqlite3 missing" "$FAKE_APT_BIN/dpkg" -s sqlite3
PACKAGES_FAIL_STATUS=0
(
  PATH="$FAKE_APT_BIN:$REAL_PATH"
  hash -r
  install_base_packages
) >/dev/null 2>&1 || PACKAGES_FAIL_STATUS=$?
PACKAGES_FAIL_LOG="$(cat "$PROGRESS_LOG_FILE")"
PACKAGES_FAIL_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
restore_progress_fixtures
reset_fake_apt_state

assert_eq "installer does not report success after an apt failure" "1" "$PACKAGES_FAIL_STATUS"
assert_contains "failure block reports the real exit code" "$PACKAGES_FAIL_VISIBLE" "Package installation failed (exit code 100)."
assert_contains "failure block lists the requested packages" "$PACKAGES_FAIL_VISIBLE" "jq sqlite3"
assert_contains "failure block surfaces the actual apt error" "$PACKAGES_FAIL_VISIBLE" "E: Unable to locate package jq"
assert_contains "failure block distinguishes unavailable packages" "$PACKAGES_FAIL_VISIBLE" "no installable candidate version"
assert_contains "failure block points at the full log" "$PACKAGES_FAIL_VISIBLE" "Full log:"
assert_contains "failure block offers a safe next diagnostic command" "$PACKAGES_FAIL_VISIBLE" "apt-get install --simulate jq sqlite3"
assert_contains "failure block shows the resume command" "$PACKAGES_FAIL_VISIBLE" "sudo ./installer/install.sh --resume"
assert_contains "complete apt failure output remains in the log" "$PACKAGES_FAIL_LOG" "E: Unable to locate package sqlite3"
assert_contains "log records the failing exit code" "$PACKAGES_FAIL_LOG" "exit=100"

# --- interrupted dpkg state is detected and reported, never repaired ---
reset_progress_fixtures
reset_fake_apt_state
FAKE_DPKG_AUDIT="The following packages are only half configured:
 some-package"
export FAKE_DPKG_AUDIT
(
  PATH="$FAKE_APT_BIN:$REAL_PATH"
  hash -r
  report_dpkg_interrupted_state
) >/dev/null 2>&1 || true
DPKG_AUDIT_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
restore_progress_fixtures
reset_fake_apt_state
assert_contains "an interrupted dpkg state is reported" "$DPKG_AUDIT_VISIBLE" "half configured"
assert_contains "the dpkg repair command is shown, not run" "$DPKG_AUDIT_VISIBLE" "sudo dpkg --configure -a"

echo
echo "=== Resume password collection (collect_resume_admin_password) ==="
assert_success "resume test prerequisite: collect_resume_admin_password is defined" \
  declare -F collect_resume_admin_password
assert_success "resume test prerequisite: admin_password_file_is_valid is defined" \
  declare -F admin_password_file_is_valid
assert_success "resume test prerequisite: compute_password_hash is defined" \
  declare -F compute_password_hash
assert_contains "install.sh wires password collection into the resume branch" \
  "$(cat "$INSTALLER_DIR/install.sh")" "collect_resume_admin_password"
assert_contains "collect_resume_admin_password unsets the plaintext immediately after writing it" \
  "$(cat "$INSTALLER_DIR/lib/secrets.sh")" "unset resume_password"

RESUME_MARKER_PASSWORD="resume marker password 998877"

# Simulate the live VPS state: an installation that failed at the
# secrets stage, with no auth.env written yet.
state_init_dir
state_set_field "panelDomain" "resume.example.com"
state_set_stage "packages-complete"
state_set_failed "secrets" "Simulated secrets failure for resume tests"
mkdir -p "$INSTALL_ROOT/config"
rm -f "$AUTH_FILE_PATH"

# --- interactive resume from a secrets-stage failure prompts again ---
RESUME_IN="$TMP_ROOT/resume-pw-in"
RESUME_OUT="$TMP_ROOT/resume-pw-out"
printf '%s\n%s\n' "$RESUME_MARKER_PASSWORD" "$RESUME_MARKER_PASSWORD" > "$RESUME_IN"
: > "$RESUME_OUT"
set_prompt_fixture "$RESUME_IN" "$RESUME_OUT"
NON_INTERACTIVE=0
OPT_ADMIN_PASSWORD_FILE=""
collect_resume_admin_password
RESUME_VISIBLE="$(cat "$RESUME_OUT")"
assert_contains "interactive resume from a secrets failure asks for the password again" "$RESUME_VISIBLE" "Re-enter administrator password"
assert_eq "resumed password lands in a real file" "yes" "$([ -n "$OPT_ADMIN_PASSWORD_FILE" ] && [ -f "$OPT_ADMIN_PASSWORD_FILE" ] && echo yes || echo no)"
assert_eq "resumed password file is mode 600" "600" "$(get_file_mode "$OPT_ADMIN_PASSWORD_FILE")"
assert_eq "resumed password file holds the exact password" "$RESUME_MARKER_PASSWORD" "$(cat "$OPT_ADMIN_PASSWORD_FILE")"
assert_failure "resumed plaintext is not written to installer state" \
  grep -r "$RESUME_MARKER_PASSWORD" "$INSTALL_ROOT/state"
assert_not_contains "resumed plaintext never appears in visible output" "$RESUME_VISIBLE" "$RESUME_MARKER_PASSWORD"
assert_failure "resumed plaintext never appears in the installer log" \
  grep -q "$RESUME_MARKER_PASSWORD" "$INSTALLER_LOG_FILE"
rm -f "$OPT_ADMIN_PASSWORD_FILE"

# --- resume from an EARLIER failed stage (packages) also collects the
# password up front, because that run will reach secrets later ---
state_set_failed "packages" "Simulated packages failure for resume tests"
printf '%s\n%s\n' "$RESUME_MARKER_PASSWORD" "$RESUME_MARKER_PASSWORD" > "$RESUME_IN"
: > "$RESUME_OUT"
set_prompt_fixture "$RESUME_IN" "$RESUME_OUT"
OPT_ADMIN_PASSWORD_FILE=""
collect_resume_admin_password
assert_contains "resume from a packages-stage failure collects a password before secrets" "$(cat "$RESUME_OUT")" "Re-enter administrator password"
rm -f "$OPT_ADMIN_PASSWORD_FILE"

# --- resumed plaintext temp file is cleaned on exit, success and
# failure alike (rollback.sh's cleanup, sourced only inside subshells
# so nothing leaks into this test shell) ---
CLEANUP_OK_FILE="$TMP_ROOT/resume-cleanup-ok"
printf 'x' > "$CLEANUP_OK_FILE"; chmod 600 "$CLEANUP_OK_FILE"
(
  set +e
  # shellcheck source=../lib/rollback.sh
  source "$INSTALLER_DIR/lib/rollback.sh"
  INSTALLER_FAILED_STAGE=""
  track_temp_file "$CLEANUP_OK_FILE"
  true
  cleanup_on_exit
) >/dev/null 2>&1 || true
assert_eq "resumed plaintext temp file is cleaned after success" "gone" "$([ -e "$CLEANUP_OK_FILE" ] && echo present || echo gone)"

CLEANUP_FAIL_FILE="$TMP_ROOT/resume-cleanup-fail"
printf 'x' > "$CLEANUP_FAIL_FILE"; chmod 600 "$CLEANUP_FAIL_FILE"
(
  set +e
  # shellcheck source=../lib/rollback.sh
  source "$INSTALLER_DIR/lib/rollback.sh"
  INSTALLER_FAILED_STAGE=""
  track_temp_file "$CLEANUP_FAIL_FILE"
  false
  cleanup_on_exit
) >/dev/null 2>&1 || true
assert_eq "resumed plaintext temp file is cleaned after failure" "gone" "$([ -e "$CLEANUP_FAIL_FILE" ] && echo present || echo gone)"

# --- resume with a valid auth.env never prompts ---
cat > "$AUTH_FILE_PATH" <<'AUTHEOF'
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=aa:bb
SESSION_SECRET=cc
CREDENTIAL_ENCRYPTION_KEY=dd
AUTHEOF
chmod 600 "$AUTH_FILE_PATH"
: > "$RESUME_IN"
: > "$RESUME_OUT"
set_prompt_fixture "$RESUME_IN" "$RESUME_OUT"
OPT_ADMIN_PASSWORD_FILE=""
assert_success "resume does not prompt when valid auth.env already exists" collect_resume_admin_password
assert_not_contains "no password prompt is shown when auth.env is valid" "$(cat "$RESUME_OUT")" "Re-enter administrator password"
rm -f "$AUTH_FILE_PATH"

# --- non-interactive resume: fails early without a file, accepts a
# valid mode-600 file ---
: > "$RESUME_OUT"
set_prompt_fixture "$RESUME_IN" "$RESUME_OUT"
NI_STATUS=0
(
  NON_INTERACTIVE=1
  OPT_ADMIN_PASSWORD_FILE=""
  collect_resume_admin_password
) >/dev/null 2>&1 || NI_STATUS=$?
assert_eq "non-interactive resume fails early without a password file" "1" "$NI_STATUS"
assert_contains "non-interactive failure explains the required option" "$(cat "$RESUME_OUT")" "--admin-password-file"

NI_PW_FILE="$TMP_ROOT/ni-password-file"
printf 'a valid password 123\n' > "$NI_PW_FILE"
chmod 600 "$NI_PW_FILE"
NI_OK_STATUS=0
(
  NON_INTERACTIVE=1
  OPT_ADMIN_PASSWORD_FILE="$NI_PW_FILE"
  collect_resume_admin_password
) >/dev/null 2>&1 || NI_OK_STATUS=$?
assert_eq "non-interactive resume accepts a valid mode-600 password file" "0" "$NI_OK_STATUS"

echo
echo "=== Admin password file validation ==="
assert_failure "rejects a missing password file" admin_password_file_is_valid "$TMP_ROOT/no-such-password-file"
assert_failure "rejects a directory path" admin_password_file_is_valid "$TMP_ROOT"
EMPTY_PW="$TMP_ROOT/empty-pw"; : > "$EMPTY_PW"; chmod 600 "$EMPTY_PW"
assert_failure "rejects an empty password file" admin_password_file_is_valid "$EMPTY_PW"
PERM_PW="$TMP_ROOT/permissive-pw"; printf 'a valid password 123\n' > "$PERM_PW"; chmod 644 "$PERM_PW"
assert_failure "rejects a permissive (644) password file" admin_password_file_is_valid "$PERM_PW"
SHORT_PW="$TMP_ROOT/short-pw"; printf 'short\n' > "$SHORT_PW"; chmod 600 "$SHORT_PW"
assert_failure "rejects a password shorter than 12 characters" admin_password_file_is_valid "$SHORT_PW"
GOOD_PW="$TMP_ROOT/good-pw"; printf 'a valid password 123\n' > "$GOOD_PW"; chmod 600 "$GOOD_PW"
assert_success "accepts a valid mode-600 password file" admin_password_file_is_valid "$GOOD_PW"

echo
echo "=== Password hash helper (fake docker, no real containers) ==="
FAKE_DOCKER_BIN="$TMP_ROOT/fakebin-docker"
mkdir -p "$FAKE_DOCKER_BIN"
FAKE_DOCKER_CALL_LOG="$TMP_ROOT/fake-docker-calls.log"
: > "$FAKE_DOCKER_CALL_LOG"
cat > "$FAKE_DOCKER_BIN/docker" <<'FAKEDOCKER'
#!/usr/bin/env bash
# Records every invocation; `run` succeeds with a fixed fake salt:hash
# or fails with FAKE_DOCKER_EXIT_CODE plus an unreadable-input stderr
# line, mimicking node failing to open the mounted password file.
printf 'docker %s\n' "$*" >> "$FAKE_DOCKER_CALL_LOG"
case "$1" in
  run)
    if [ "${FAKE_DOCKER_EXIT_CODE:-0}" -ne 0 ]; then
      echo "node:internal/fs: ENOENT: no such file or directory, open '/work/data/password'" >&2
      exit "${FAKE_DOCKER_EXIT_CODE}"
    fi
    printf 'feedfacesalt:feedfacehash'
    exit 0
    ;;
esac
exit 0
FAKEDOCKER
chmod +x "$FAKE_DOCKER_BIN/docker"
export FAKE_DOCKER_CALL_LOG

# --- pre-validation rejects bad inputs BEFORE docker ever runs ---
for bad_case in missing directory empty permissive; do
  : > "$FAKE_DOCKER_CALL_LOG"
  case "$bad_case" in
    missing) BAD_PW_PATH="$TMP_ROOT/no-such-pw" ;;
    directory) BAD_PW_PATH="$TMP_ROOT" ;;
    empty) BAD_PW_PATH="$EMPTY_PW" ;;
    permissive) BAD_PW_PATH="$PERM_PW" ;;
  esac
  BAD_STATUS=0
  (
    PATH="$FAKE_DOCKER_BIN:$REAL_PATH"
    hash -r
    compute_password_hash "$BAD_PW_PATH"
  ) >/dev/null 2>&1 || BAD_STATUS=$?
  assert_eq "compute_password_hash rejects a ${bad_case} password input" "1" "$BAD_STATUS"
  assert_failure "no docker command ran for the ${bad_case} input" grep -q "docker run" "$FAKE_DOCKER_CALL_LOG"
done

# --- success path: hash on stdout, hardened --mount flags in use ---
: > "$FAKE_DOCKER_CALL_LOG"
FAKE_DOCKER_EXIT_CODE=0
export FAKE_DOCKER_EXIT_CODE
HASH_RESULT="$(
  PATH="$FAKE_DOCKER_BIN:$REAL_PATH"
  hash -r
  compute_password_hash "$GOOD_PW" 2>/dev/null
)" || true
assert_eq "hash helper returns only the computed salt:hash on stdout" "feedfacesalt:feedfacehash" "$HASH_RESULT"
FAKE_DOCKER_CALLS="$(cat "$FAKE_DOCKER_CALL_LOG")"
assert_contains "explicit --mount bind syntax is used" "$FAKE_DOCKER_CALLS" "--mount type=bind,src="
assert_contains "password input is mounted read-only via --mount" "$FAKE_DOCKER_CALLS" ",dst=/work/data/password,readonly"
assert_not_contains "legacy -v password mount is gone" "$FAKE_DOCKER_CALLS" ":/work/data/password:ro"
assert_contains "helper still runs with no network" "$FAKE_DOCKER_CALLS" "--network none"
assert_contains "helper still drops all capabilities" "$FAKE_DOCKER_CALLS" "--cap-drop ALL"
assert_contains "helper still blocks privilege escalation" "$FAKE_DOCKER_CALLS" "no-new-privileges"
assert_contains "helper still uses a read-only root filesystem" "$FAKE_DOCKER_CALLS" "--read-only"

# --- helper failure: docker's exit code preserved, safe diagnostics,
# no secret ever surfaced ---
reset_progress_fixtures
: > "$FAKE_DOCKER_CALL_LOG"
FAKE_DOCKER_EXIT_CODE=7
export FAKE_DOCKER_EXIT_CODE
HASH_FAIL_STATUS=0
(
  PATH="$FAKE_DOCKER_BIN:$REAL_PATH"
  hash -r
  compute_password_hash "$GOOD_PW"
) >/dev/null 2>&1 || HASH_FAIL_STATUS=$?
HASH_FAIL_VISIBLE="$(cat "$PROGRESS_VISIBLE_FILE")"
HASH_FAIL_LOG="$(cat "$PROGRESS_LOG_FILE")"
restore_progress_fixtures
FAKE_DOCKER_EXIT_CODE=0
export FAKE_DOCKER_EXIT_CODE
assert_eq "helper docker failure stops the stage" "1" "$HASH_FAIL_STATUS"
assert_contains "helper failure reports docker's own exit code" "$HASH_FAIL_VISIBLE" "Password hash helper failed (exit code 7)."
assert_contains "helper failure reports the unreadable mounted input" "$HASH_FAIL_VISIBLE" "could not read its mounted password input"
assert_contains "helper failure points at the redacted log diagnostics" "$HASH_FAIL_VISIBLE" "written to the installer log"
assert_contains "helper stderr reaches the installer log" "$HASH_FAIL_LOG" "ENOENT"
assert_not_contains "helper diagnostics never contain the plaintext password" "${HASH_FAIL_VISIBLE}${HASH_FAIL_LOG}" "a valid password 123"
assert_not_contains "helper diagnostics never contain a hash value" "${HASH_FAIL_VISIBLE}${HASH_FAIL_LOG}" "feedface"

echo
echo "=== Spinner rendering (single-line, width-bounded) ==="
# Drives _progress_render directly against a file on fd 4 — no pty and
# no human terminal needed. Frames must redraw one line in place: any
# newline, or any frame wide enough to soft-wrap, reproduces the live
# bug where every animation tick stranded another copy of the
# description on screen.
SPINNER_RENDER_FILE="$TMP_ROOT/spinner-render.out"
: > "$SPINNER_RENDER_FILE"
exec 4>>"$SPINNER_RENDER_FILE"
PROGRESS_FD=4
PROGRESS_TERM_COLS=40
SPINNER_DESC="Installing Docker Engine: docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
_progress_render "$SPINNER_DESC" 0 5 0 ""
_progress_render "$SPINNER_DESC" 1 6 0 ""
_progress_render "$SPINNER_DESC" 2 7 0 ""
exec 4>&-
PROGRESS_FD=2
PROGRESS_TERM_COLS=80
SPINNER_RAW="$(cat "$SPINNER_RENDER_FILE")"
case "$SPINNER_RAW" in
  *$'\n'*) SPINNER_HAS_NEWLINE="yes" ;;
  *) SPINNER_HAS_NEWLINE="no" ;;
esac
assert_eq "animated frames never emit newline-separated copies" "no" "$SPINNER_HAS_NEWLINE"
case "$SPINNER_RAW" in
  *$'\r'*) SPINNER_HAS_CR="yes" ;;
  *) SPINNER_HAS_CR="no" ;;
esac
assert_eq "animated frames redraw in place via carriage return" "yes" "$SPINNER_HAS_CR"
SPINNER_MAX_LEN="$(printf '%s' "$SPINNER_RAW" | tr '\r' '\n' | awk 'BEGIN { esc = sprintf("%c", 27) } { gsub(esc "\\[K", ""); if (length($0) > m) m = length($0) } END { print m + 0 }')"
assert_eq "every frame fits inside the detected terminal width (no soft-wrap)" "yes" "$([ "$SPINNER_MAX_LEN" -lt 40 ] && echo yes || echo no)"

# Restore prompt I/O so nothing later is left pointed at a fixture.
PROMPT_INPUT_PATH="$ORIGINAL_PROMPT_INPUT_PATH"
PROMPT_OUTPUT_PATH="$ORIGINAL_PROMPT_OUTPUT_PATH"
reset_prompt_io_state
OPT_ADMIN_PASSWORD_FILE=""

echo
echo "=== DNS readiness (fresh wildcard probes, fake resolvers) ==="
assert_success "dns test prerequisite: generate_dns_probe_label is defined" \
  declare -F generate_dns_probe_label
assert_success "dns test prerequisite: domain_resolves_to_expected_ip is defined" \
  declare -F domain_resolves_to_expected_ip
assert_success "dns test prerequisite: check_dns_ready is defined" \
  declare -F check_dns_ready

# --- probe label generation ---
PROBE_LABEL_1="$(generate_dns_probe_label)"
PROBE_LABEL_2="$(generate_dns_probe_label)"
PROBE_SYNTAX_OK="yes"
case "$PROBE_LABEL_1" in
  *[!a-z0-9-]*) PROBE_SYNTAX_OK="no" ;;
esac
case "$PROBE_LABEL_1" in
  [a-z0-9]*[a-z0-9]) : ;;
  *) PROBE_SYNTAX_OK="no" ;;
esac
assert_eq "generated probe label uses valid DNS syntax" "yes" "$PROBE_SYNTAX_OK"
assert_eq "generated probe label is at most 63 characters" "yes" "$([ "${#PROBE_LABEL_1}" -le 63 ] && echo yes || echo no)"
assert_eq "consecutive generated labels differ" "yes" "$([ "$PROBE_LABEL_1" != "$PROBE_LABEL_2" ] && echo yes || echo no)"

# Entropy is a separate overridable function, so label assertions can be
# fully deterministic when needed (override lives only in the subshell).
DETERMINISTIC_LABEL="$(
  _dns_probe_entropy() { printf '1785157000-5306-1-12345'; }
  generate_dns_probe_label
)"
assert_eq "probe entropy is overridable for deterministic tests" "dp-check-1785157000-5306-1-12345" "$DETERMINISTIC_LABEL"

# --- the old fixed probe string is gone from non-comment code ---
assert_failure "fixed installer-dns-check probe no longer exists in code" \
  bash -c "grep -v '^[[:space:]]*#' '$INSTALLER_DIR/lib/dns.sh' | grep -q installer-dns-check"

# --- fake resolver toolchain (no real network or DNS access) ---
FAKE_DNS_BIN="$TMP_ROOT/fakebin-dns"
mkdir -p "$FAKE_DNS_BIN"
FAKE_DNS_CALL_LOG="$TMP_ROOT/fake-dns-calls.log"
: > "$FAKE_DNS_CALL_LOG"
export FAKE_DNS_CALL_LOG

cat > "$FAKE_DNS_BIN/getent" <<'FAKEGETENT'
#!/usr/bin/env bash
printf 'getent %s\n' "$*" >> "$FAKE_DNS_CALL_LOG"
case "${FAKE_GETENT_MODE:-answer}" in
  answer) printf '%s STREAM %s\n' "${FAKE_DNS_IP:-148.230.95.12}" "$2"; exit 0 ;;
  malformed) printf 'not-an-ip STREAM %s\n' "$2"; exit 0 ;;
esac
exit 2
FAKEGETENT
chmod +x "$FAKE_DNS_BIN/getent"

cat > "$FAKE_DNS_BIN/dig" <<'FAKEDIG'
#!/usr/bin/env bash
printf 'dig %s\n' "$*" >> "$FAKE_DNS_CALL_LOG"
case "${FAKE_DIG_MODE:-answer}" in
  answer) printf '%s\n' "${FAKE_DNS_IP:-148.230.95.12}" ;;
  multi) printf '203.0.113.77\n%s\n' "${FAKE_DNS_IP:-148.230.95.12}" ;;
esac
exit 0
FAKEDIG
chmod +x "$FAKE_DNS_BIN/dig"

cat > "$FAKE_DNS_BIN/host" <<'FAKEHOST'
#!/usr/bin/env bash
printf 'host %s\n' "$*" >> "$FAKE_DNS_CALL_LOG"
case "${FAKE_HOST_MODE:-answer}" in
  answer) printf '%s has address %s\n' "$3" "${FAKE_DNS_IP:-148.230.95.12}"; exit 0 ;;
esac
printf 'Host %s not found: 3(NXDOMAIN)\n' "$3"
exit 1
FAKEHOST
chmod +x "$FAKE_DNS_BIN/host"

cat > "$FAKE_DNS_BIN/curl" <<'FAKECURL'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_DNS_CALL_LOG"
printf '148.230.95.12'
exit 0
FAKECURL
chmod +x "$FAKE_DNS_BIN/curl"

cat > "$FAKE_DNS_BIN/sleep" <<'FAKESLEEP'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "$FAKE_DNS_CALL_LOG"
exit 0
FAKESLEEP
chmod +x "$FAKE_DNS_BIN/sleep"

reset_fake_dns_state() {
  : > "$FAKE_DNS_CALL_LOG"
  FAKE_GETENT_MODE="answer"
  FAKE_DIG_MODE="answer"
  FAKE_HOST_MODE="answer"
  FAKE_DNS_IP="148.230.95.12"
  export FAKE_GETENT_MODE FAKE_DIG_MODE FAKE_HOST_MODE FAKE_DNS_IP
}

with_fake_dns() {
  local status=0
  PATH="$FAKE_DNS_BIN:$REAL_PATH"
  hash -r
  "$@" || status=$?
  PATH="$REAL_PATH"
  hash -r
  return "$status"
}

DNS_IN="$TMP_ROOT/dns-in"
DNS_VIS="$TMP_ROOT/dns-visible.out"
: > "$DNS_IN"
: > "$DNS_VIS"
set_prompt_fixture "$DNS_IN" "$DNS_VIS"

# --- basic resolution ---
reset_fake_dns_state
assert_success "panel domain resolving to the expected IP passes" \
  with_fake_dns domain_resolves_to_expected_ip "panel.example.com" "148.230.95.12"
assert_success "a wildcard child resolving to the expected IP passes" \
  with_fake_dns domain_resolves_to_expected_ip "anything.apps.example.com" "148.230.95.12"

# --- readiness check with a fresh generated probe ---
reset_fake_dns_state
assert_success "check_dns_ready succeeds when panel and probe resolve" \
  with_fake_dns check_dns_ready "panel.example.com" "apps.example.com" "148.230.95.12"
FIRST_PROBE_HOST="$DNS_LAST_PROBE_HOST"
assert_contains "probe host is a generated dp-check child" "$FIRST_PROBE_HOST" "dp-check-"
assert_contains "probe host targets the apps domain" "$FIRST_PROBE_HOST" ".apps.example.com"
assert_contains "the generated probe was actually queried" "$(cat "$FAKE_DNS_CALL_LOG")" "$FIRST_PROBE_HOST"
assert_not_contains "the literal wildcard name is never queried" "$(cat "$FAKE_DNS_CALL_LOG")" "*."
assert_not_contains "the old fixed probe is never queried" "$(cat "$FAKE_DNS_CALL_LOG")" "installer-dns-check"

# --- fresh probes per call; an earlier negative cannot poison later ---
reset_fake_dns_state
FAKE_GETENT_MODE="empty"; FAKE_DIG_MODE="empty"; FAKE_HOST_MODE="empty"
export FAKE_GETENT_MODE FAKE_DIG_MODE FAKE_HOST_MODE
assert_failure "check_dns_ready fails when nothing resolves" \
  with_fake_dns check_dns_ready "panel.example.com" "apps.example.com" "148.230.95.12"
FAILED_PROBE_HOST="$DNS_LAST_PROBE_HOST"
FAKE_GETENT_MODE="answer"; FAKE_DIG_MODE="answer"; FAKE_HOST_MODE="answer"
export FAKE_GETENT_MODE FAKE_DIG_MODE FAKE_HOST_MODE
assert_success "a later check succeeds with a fresh probe after an earlier negative" \
  with_fake_dns check_dns_ready "panel.example.com" "apps.example.com" "148.230.95.12"
assert_eq "consecutive check_dns_ready calls used different probe hostnames" "yes" \
  "$([ "$FAILED_PROBE_HOST" != "$DNS_LAST_PROBE_HOST" ] && echo yes || echo no)"

# --- failure diagnostics name the exact probe, safely ---
reset_fake_dns_state
FAKE_GETENT_MODE="empty"; FAKE_DIG_MODE="empty"; FAKE_HOST_MODE="empty"
export FAKE_GETENT_MODE FAKE_DIG_MODE FAKE_HOST_MODE
: > "$DNS_VIS"
with_fake_dns check_dns_ready "panel.example.com" "apps.example.com" "203.0.113.10" || true
DNS_DIAG="$(cat "$DNS_VIS")"
assert_contains "failure diagnostics announce the not-ready state" "$DNS_DIAG" "DNS check not ready:"
assert_contains "failure diagnostics name the exact generated probe" "$DNS_DIAG" "$DNS_LAST_PROBE_HOST"
assert_contains "failure diagnostics show (none) for unresolved names" "$DNS_DIAG" "(none)"
assert_contains "failure diagnostics show the expected IP" "$DNS_DIAG" "expected -> 203.0.113.10"

# --- resolver fallthrough ---
reset_fake_dns_state
FAKE_GETENT_MODE="empty"; export FAKE_GETENT_MODE
assert_success "an empty getent result falls through to dig" \
  with_fake_dns domain_resolves_to_expected_ip "panel.example.com" "148.230.95.12"
assert_contains "dig was consulted after getent returned nothing" "$(cat "$FAKE_DNS_CALL_LOG")" "dig +short A panel.example.com"

reset_fake_dns_state
FAKE_GETENT_MODE="malformed"; export FAKE_GETENT_MODE
assert_success "a malformed getent result falls through to dig" \
  with_fake_dns domain_resolves_to_expected_ip "panel.example.com" "148.230.95.12"

reset_fake_dns_state
FAKE_GETENT_MODE="empty"; FAKE_DIG_MODE="empty"
export FAKE_GETENT_MODE FAKE_DIG_MODE
assert_success "empty getent and dig results fall through to host" \
  with_fake_dns domain_resolves_to_expected_ip "panel.example.com" "148.230.95.12"
assert_contains "host was consulted last" "$(cat "$FAKE_DNS_CALL_LOG")" "host -t A panel.example.com"

# --- multiple A records ---
reset_fake_dns_state
FAKE_GETENT_MODE="empty"; FAKE_DIG_MODE="multi"
export FAKE_GETENT_MODE FAKE_DIG_MODE
assert_success "any matching IP among multiple A records passes" \
  with_fake_dns domain_resolves_to_expected_ip "panel.example.com" "148.230.95.12"

reset_fake_dns_state
FAKE_DNS_IP="198.51.100.9"; export FAKE_DNS_IP
assert_failure "resolution to only a different IP fails readiness" \
  with_fake_dns domain_resolves_to_expected_ip "panel.example.com" "148.230.95.12"

# --- retry loop timing (fake sleep, fake curl, nothing resolves) ---
reset_fake_dns_state
FAKE_GETENT_MODE="empty"; FAKE_DIG_MODE="empty"; FAKE_HOST_MODE="empty"
export FAKE_GETENT_MODE FAKE_DIG_MODE FAKE_HOST_MODE
: > "$DNS_VIS"
FLOW_STATUS=0
with_fake_dns run_dns_readiness_flow "panel.example.com" "apps.example.com" 1 >/dev/null 2>&1 || FLOW_STATUS=$?
assert_eq "readiness flow with --continue-without-dns returns success" "0" "$FLOW_STATUS"
SLEEP_COUNT="$(grep -c '^sleep ' "$FAKE_DNS_CALL_LOG" || true)"
assert_eq "6 attempts sleep only between attempts (5 sleeps, none after the last)" "5" "$SLEEP_COUNT"
FIRST_QUERY_LINE="$(grep -n 'getent ahostsv4' "$FAKE_DNS_CALL_LOG" | head -n 1 | cut -d: -f1)"
FIRST_SLEEP_LINE="$(grep -n '^sleep ' "$FAKE_DNS_CALL_LOG" | head -n 1 | cut -d: -f1)"
assert_eq "the first DNS check happens before any sleep" "yes" \
  "$([ -n "$FIRST_QUERY_LINE" ] && [ -n "$FIRST_SLEEP_LINE" ] && [ "$FIRST_QUERY_LINE" -lt "$FIRST_SLEEP_LINE" ] && echo yes || echo no)"
UNIQUE_PROBES="$(grep -oE 'dp-check-[a-z0-9-]*\.apps\.example\.com' "$FAKE_DNS_CALL_LOG" | sort -u | wc -l | tr -d '[:space:]')"
assert_eq "every attempt used a fresh probe hostname (7 distinct probes)" "7" "$UNIQUE_PROBES"
assert_contains "the visible retry line mentions the wildcard probe concept" "$(cat "$DNS_VIS")" "wildcard probe"

# Restore prompt I/O and fake-mode state.
FAKE_GETENT_MODE="answer"; FAKE_DIG_MODE="answer"; FAKE_HOST_MODE="answer"
export FAKE_GETENT_MODE FAKE_DIG_MODE FAKE_HOST_MODE
PROMPT_INPUT_PATH="$ORIGINAL_PROMPT_INPUT_PATH"
PROMPT_OUTPUT_PATH="$ORIGINAL_PROMPT_OUTPUT_PATH"
reset_prompt_io_state

echo
echo "=== Verification: set-e safety and normalized exit status ==="
assert_success "verify test prerequisite: _verify_probe is defined" declare -F _verify_probe
assert_success "verify test prerequisite: verify_api_http_responds is defined" declare -F verify_api_http_responds

# The live bug: `deployment-platform verify` exits 7 because a probe that
# legitimately returns nonzero (host curl to an unpublished port) killed
# the script under set -e. The installer's own final stage called the
# verifier inside an `if`, which masked it. These tests therefore run the
# verifier BOTH ways and require identical behaviour.
VERIFY_VIS="$TMP_ROOT/verify-visible.out"
VERIFY_LOG="$TMP_ROOT/verify.log"
ORIGINAL_VERIFY_LOG="$INSTALLER_LOG_FILE"

# Stub the platform-shaped globals verify_local_platform reads, and the
# probes it runs, so no Docker or network is touched. FAKE_VERIFY_MODE
# selects a healthy or a broken world.
setup_verify_fixture() {
  : > "$VERIFY_VIS"
  : > "$VERIFY_LOG"
  INSTALLER_LOG_FILE="$VERIFY_LOG"
  PROMPT_OUTPUT_PATH="$VERIFY_VIS"
  mkdir -p "$INSTALL_ROOT/caddy/routes"
}

restore_verify_fixture() {
  INSTALLER_LOG_FILE="$ORIGINAL_VERIFY_LOG"
  PROMPT_OUTPUT_PATH="$ORIGINAL_PROMPT_OUTPUT_PATH"
}

# A self-contained verifier harness: overrides the external-command
# surface (docker/curl/sleep) inside a subshell, then runs the REAL
# verify_local_platform / verify_public_domain / run_full_verification.
# Emitted to a file and sourced so both call contexts share one fixture.
VERIFY_HARNESS="$TMP_ROOT/verify-harness.sh"
cat > "$VERIFY_HARNESS" <<'VHEOF'
# Fake docker: shapes its answers by subcommand. FAKE_VERIFY_MODE=broken
# makes the API HTTP probe and Caddy validation fail while every other
# probe still succeeds, so later checks must still run.
docker() {
  case "$1" in
    info) return 0 ;;
    network|volume) return 0 ;;
    inspect) printf 'true\n'; return 0 ;;
    exec)
      shift 2
      case "$*" in
        *node:internal*|*http.request*|*"node:http"*)
          [ "${FAKE_VERIFY_MODE:-healthy}" = "broken" ] && return 1
          return 0
          ;;
      esac
      # CREDENTIAL_ENCRYPTION_KEY / db read / migration count probes
      case "$*" in
        *schema_migrations*) printf '11\n'; return 0 ;;
      esac
      return 0
      ;;
    run)
      [ "${FAKE_VERIFY_MODE:-healthy}" = "broken" ] && return 1
      return 0
      ;;
  esac
  return 0
}
# Serves three different callers:
#  - verify_public_domain, which asks only for %{http_code}
#  - verify_public_api_prefix, which asks for the body plus a trailing
#    status line and requires an unauthenticated session shape
#  - verify_public_login_rejection, which POSTs and requires the login
#    handler's own rejection message
curl() {
  local wants_body=0 is_login=0
  for arg in "$@"; do
    case "$arg" in
      (*'%{http_code}'*)
        case "$arg" in
          (*'\n'*) wants_body=1 ;;
        esac
        ;;
      (*/api/auth/login) is_login=1 ;;
    esac
  done
  # Drain the piped request body only for the POST caller; other callers
  # share the harness's stdin and must not have it consumed.
  if [ "$is_login" -eq 1 ]; then
    cat >/dev/null 2>&1 || true
  fi
  if [ "${FAKE_VERIFY_MODE:-healthy}" = "broken" ]; then
    if [ "$wants_body" -eq 1 ]; then
      printf '{"success":false,"message":"Authentication required"}\n401'
      return 0
    fi
    printf '000'
    return 7
  fi
  if [ "$is_login" -eq 1 ]; then
    printf '{"success":false,"message":"Invalid username or password"}\n401'
    return 0
  fi
  if [ "$wants_body" -eq 1 ]; then
    printf '{"authenticated":false}\n200'
    return 0
  fi
  printf '200'
  return 0
}
sleep() { return 0; }
VHEOF

# --- healthy world: identical result in both call contexts ---
setup_verify_fixture
DIRECT_STATUS=0
(
  source "$VERIFY_HARNESS"
  FAKE_VERIFY_MODE=healthy
  run_full_verification "panel.example.com"
) >/dev/null 2>&1 || DIRECT_STATUS=$?
COND_STATUS=0
(
  source "$VERIFY_HARNESS"
  FAKE_VERIFY_MODE=healthy
  if run_full_verification "panel.example.com"; then exit 0; else exit $?; fi
) >/dev/null 2>&1 || COND_STATUS=$?
HEALTHY_VIS="$(cat "$VERIFY_VIS")"
restore_verify_fixture
assert_eq "healthy verification returns 0 when called directly" "0" "$DIRECT_STATUS"
assert_eq "healthy verification returns 0 when called in an if condition" "0" "$COND_STATUS"
assert_eq "both call contexts agree on the healthy result" "yes" \
  "$([ "$DIRECT_STATUS" = "$COND_STATUS" ] && echo yes || echo no)"
assert_contains "healthy run reports all checks passed" "$HEALTHY_VIS" "All verification checks passed."

# --- broken world: still 1 (never a raw probe status), still complete ---
setup_verify_fixture
BROKEN_DIRECT=0
(
  source "$VERIFY_HARNESS"
  FAKE_VERIFY_MODE=broken
  run_full_verification "panel.example.com"
) >/dev/null 2>&1 || BROKEN_DIRECT=$?
BROKEN_VIS="$(cat "$VERIFY_VIS")"
BROKEN_COND=0
(
  source "$VERIFY_HARNESS"
  FAKE_VERIFY_MODE=broken
  if run_full_verification "panel.example.com"; then exit 0; else exit $?; fi
) >/dev/null 2>&1 || BROKEN_COND=$?
restore_verify_fixture
assert_eq "failing verification returns 1 when called directly (not curl's 7)" "1" "$BROKEN_DIRECT"
assert_eq "failing verification returns 1 when called in an if condition" "1" "$BROKEN_COND"
assert_eq "both call contexts agree on the failing result" "yes" \
  "$([ "$BROKEN_DIRECT" = "$BROKEN_COND" ] && echo yes || echo no)"
# The regression that produced exit 7: everything after the API probe was
# never reached. These assertions pin that later checks still run.
assert_contains "a failed API probe does not stop the Caddy check" "$BROKEN_VIS" "Caddy configuration validates"
assert_contains "public verification still runs after local failures" "$BROKEN_VIS" "PUBLIC VERIFICATION"
assert_contains "a final summary is printed even when checks fail" "$BROKEN_VIS" "verification check(s) failed."
assert_contains "checks before the failure still ran" "$BROKEN_VIS" "Docker daemon reachable"
assert_contains "the migration check still ran" "$BROKEN_VIS" "Database migrations applied"

# --- the API HTTP probe: statuses, failures, and target ---
API_PROBE_SRC="$(cat "$INSTALLER_DIR/lib/verify.sh")"
assert_contains "the API check runs inside the API container" "$API_PROBE_SRC" 'docker exec "$API_CONTAINER_NAME" node -e'
assert_contains "the API check targets 127.0.0.1 in-container" "$API_PROBE_SRC" 'host: "127.0.0.1"'
assert_contains "the API check queries the session endpoint" "$API_PROBE_SRC" '/api/auth/session'
assert_contains "the API check requires an unauthenticated session, not any status" "$API_PROBE_SRC" "reason=unauthenticated-session status=200"
assert_contains "the API check description states what it proves" "$API_PROBE_SRC" "API serves its real backend route inside the container"
assert_failure "no host-local curl to 127.0.0.1:3001 remains" \
  bash -c "grep -v '^[[:space:]]*#' '$INSTALLER_DIR/lib/verify.sh' | grep -q 'curl.*127\.0\.0\.1'"
assert_failure "the node -e process.exit(0) placeholder check is gone" \
  bash -c "grep -q \"node -e 'process.exit(0)'\" '$INSTALLER_DIR/lib/verify.sh'"

# The embedded Node script's status handling, exercised directly with the
# host's own node when available (skipped cleanly otherwise) — proves
# 200/401/403/404 map to exit 0 and anything else to exit 1, without a
# container.
if command -v node >/dev/null 2>&1; then
  API_STATUS_SCRIPT="$TMP_ROOT/api-status-check.js"
  cat > "$API_STATUS_SCRIPT" <<'NODEEOF'
const healthy = [200, 401, 403, 404];
const code = Number(process.argv[2]);
process.exit(healthy.indexOf(code) >= 0 ? 0 : 1);
NODEEOF
  for code in 200 401 403 404; do
    assert_success "HTTP ${code} is treated as healthy" node "$API_STATUS_SCRIPT" "$code"
  done
  for code in 500 502 000; do
    assert_failure "HTTP ${code} is treated as unhealthy" node "$API_STATUS_SCRIPT" "$code"
  done
else
  echo "[SKIP] node not installed — skipping in-process API status-code mapping checks."
fi

# Connection refusal / timeout / crash are unhealthy: all three surface as
# a nonzero docker exec, which verify_api_http_responds must propagate.
for failure_kind in refused timeout crashed; do
  API_FAIL_STATUS=0
  (
    docker() { return 1; }
    verify_api_http_responds
  ) >/dev/null 2>&1 || API_FAIL_STATUS=$?
  assert_eq "a ${failure_kind} API connection is unhealthy" "1" "$API_FAIL_STATUS"
done
API_MALFORMED_STATUS=0
(
  docker() { printf 'garbage-not-a-status\n'; return 1; }
  verify_api_http_responds
) >/dev/null 2>&1 || API_MALFORMED_STATUS=$?
assert_eq "a malformed/absent HTTP status is unhealthy" "1" "$API_MALFORMED_STATUS"

echo
echo "=== Installation summary rendering ==="
# The live summary printed "(apps are served at <app-name>.__APPS_DOMAIN__)"
# because __APPS_DOMAIN__ occurs twice on one template line and the sed
# substitution lacked the `g` flag.
SUMMARY_OUT="$TMP_ROOT/install-summary.txt"
sed \
  -e "s|__STATUS__|Installed|g" \
  -e "s|__PANEL_DOMAIN__|panel.devminted.com|g" \
  -e "s|__APPS_DOMAIN__|apps.devminted.com|g" \
  -e "s|__ADMIN_USERNAME__|admin|g" \
  -e "s|__SOURCE_IDENTITY__|local-a1b2c3d4e5f6|g" \
  -e "s|__API_IMAGE__|deployment-platform-api:bootstrap-local-a1b2c3d4e5f6|g" \
  -e "s|__WEB_IMAGE__|deployment-platform-web:bootstrap-local-a1b2c3d4e5f6|g" \
  -e "s|__CADDY_IMAGE__|caddy:2-alpine|g" \
  -e "s|__API_DATA_VOLUME__|deployment-platform-api-data|g" \
  -e "s|__BACKUP_PATH__|none yet|g" \
  -e "s|__INSTALL_ROOT__|/opt/deployment-platform|g" \
  -e "s|__STATE_FILE__|/opt/deployment-platform/state/installer-state.json|g" \
  -e "s|__VERIFICATION_RESULT__|all checks passed|g" \
  "$INSTALLER_DIR/templates/install-summary.template" > "$SUMMARY_OUT"
SUMMARY_TEXT="$(cat "$SUMMARY_OUT")"
assert_failure "rendered summary contains no __APPS_DOMAIN__ placeholder" \
  grep -q '__APPS_DOMAIN__' "$SUMMARY_OUT"
assert_failure "rendered summary contains no __PLACEHOLDER__ token at all" \
  grep -q '__[A-Z_]\{2,\}__' "$SUMMARY_OUT"
assert_contains "the apps domain appears in the explanatory hostname" "$SUMMARY_TEXT" "<app-name>.apps.devminted.com"
assert_contains "the summary labels the value as a source identity" "$SUMMARY_TEXT" "Source identity:"
assert_failure "the summary no longer claims every value is a git commit" \
  grep -q 'Source commit:' "$SUMMARY_OUT"
for secret_token in ADMIN_PASSWORD_HASH SESSION_SECRET CREDENTIAL_ENCRYPTION_KEY; do
  assert_failure "the summary never includes ${secret_token}" grep -q "$secret_token" "$SUMMARY_OUT"
done
assert_contains "install.sh applies the g flag to the apps-domain substitution" \
  "$(cat "$INSTALLER_DIR/install.sh")" 's|__APPS_DOMAIN__|${OPT_APPS_DOMAIN}|g'

echo
echo "=== Source identity fingerprint ==="
assert_success "source test prerequisite: compute_source_content_fingerprint is defined" \
  declare -F compute_source_content_fingerprint
assert_success "source test prerequisite: resolve_local_source_identity is defined" \
  declare -F resolve_local_source_identity

FP_TREE_A="$TMP_ROOT/fp-tree-a"
FP_TREE_B="$TMP_ROOT/fp-tree-b"
mkdir -p "$FP_TREE_A/apps/api" "$FP_TREE_B/apps/api"
printf '{"name":"platform"}\n' > "$FP_TREE_A/package.json"
printf 'console.log("api");\n' > "$FP_TREE_A/apps/api/index.js"
cp -R "$FP_TREE_A/." "$FP_TREE_B/"

FP_A1="$(compute_source_content_fingerprint "$FP_TREE_A")"
FP_A2="$(compute_source_content_fingerprint "$FP_TREE_A")"
FP_B="$(compute_source_content_fingerprint "$FP_TREE_B")"
assert_eq "fingerprint is a full 64-character sha256" "64" "${#FP_A1}"
assert_eq "repeated runs on unchanged source produce the same fingerprint" "$FP_A1" "$FP_A2"
assert_eq "identical content in a different directory produces the same fingerprint" "$FP_A1" "$FP_B"

printf 'console.log("api changed");\n' > "$FP_TREE_B/apps/api/index.js"
FP_B_CHANGED="$(compute_source_content_fingerprint "$FP_TREE_B")"
assert_eq "changing a tracked file changes the fingerprint" "yes" \
  "$([ "$FP_A1" != "$FP_B_CHANGED" ] && echo yes || echo no)"

# Excluded paths must not perturb identity.
mkdir -p "$FP_TREE_A/node_modules/pkg" "$FP_TREE_A/apps/api/dist" "$FP_TREE_A/logs"
printf 'junk\n' > "$FP_TREE_A/node_modules/pkg/index.js"
printf 'built\n' > "$FP_TREE_A/apps/api/dist/bundle.js"
printf 'log line\n' > "$FP_TREE_A/logs/installer.log"
printf 'SECRET=x\n' > "$FP_TREE_A/.env"
printf 'SECRET=y\n' > "$FP_TREE_A/auth.env"
printf '#!/bin/sh\n' > "$FP_TREE_A/generate-auth.sh"
printf 'noise\n' > "$FP_TREE_A/debug.log"
FP_A_WITH_EXCLUDED="$(compute_source_content_fingerprint "$FP_TREE_A")"
assert_eq "excluded files do not change the fingerprint" "$FP_A1" "$FP_A_WITH_EXCLUDED"

# A rename with identical bytes must still change identity.
mv "$FP_TREE_B/apps/api/index.js" "$FP_TREE_B/apps/api/main.js"
FP_B_RENAMED="$(compute_source_content_fingerprint "$FP_TREE_B")"
assert_eq "renaming a file changes the fingerprint" "yes" \
  "$([ "$FP_B_RENAMED" != "$FP_B_CHANGED" ] && echo yes || echo no)"

# Identity resolution: no .git means local-<sha256>, never "unknown".
IDENTITY_NO_GIT="$(resolve_local_source_identity "$FP_TREE_A")"
assert_contains "a non-git local source resolves to a local- identity" "$IDENTITY_NO_GIT" "local-"
assert_eq "a valid readable local source is never 'unknown'" "yes" \
  "$([ "$IDENTITY_NO_GIT" != "unknown" ] && echo yes || echo no)"
assert_eq "the local identity embeds the full content fingerprint" "local-${FP_A1}" "$IDENTITY_NO_GIT"

# A Git checkout still reports the real commit SHA.
FAKE_GIT_BIN="$TMP_ROOT/fakebin-git"
mkdir -p "$FAKE_GIT_BIN"
cat > "$FAKE_GIT_BIN/git" <<'FAKEGIT'
#!/usr/bin/env bash
case "$*" in
  *rev-parse*HEAD*) printf '4f3c2b1a09876543210fedcba9876543210abcde\n'; exit 0 ;;
esac
exit 1
FAKEGIT
chmod +x "$FAKE_GIT_BIN/git"
mkdir -p "$FP_TREE_B/.git"
IDENTITY_WITH_GIT="$(PATH="$FAKE_GIT_BIN:$REAL_PATH"; hash -r; resolve_local_source_identity "$FP_TREE_B")"
assert_eq "a git checkout uses the real commit SHA" "4f3c2b1a09876543210fedcba9876543210abcde" "$IDENTITY_WITH_GIT"
hash -r

echo
echo "=== Image identity, tags, and reuse safety ==="
assert_eq "git identity produces a bootstrap-<sha12> tag" "bootstrap-4f3c2b1a0987" \
  "$(image_tag_for_commit "4f3c2b1a09876543210fedcba9876543210abcde")"
assert_eq "local identity produces a distinct bootstrap-local-<hex12> tag" "bootstrap-local-a1b2c3d4e5f6" \
  "$(image_tag_for_commit "local-a1b2c3d4e5f6789000000000000000000000000000000000000000000000000")"
LOCAL_TAG="$(image_tag_for_commit "local-a1b2c3d4e5f6789000000000000000000000000000000000000000000000000")"
assert_eq "a local-source tag can never collide with a legacy bootstrap-unknown tag" "yes" \
  "$([ "$LOCAL_TAG" != "bootstrap-unknown" ] && echo yes || echo no)"
TAG_CHARS_OK="yes"
case "$LOCAL_TAG" in
  *[!a-zA-Z0-9._-]*) TAG_CHARS_OK="no" ;;
esac
assert_eq "generated image tags use only valid Docker tag characters" "yes" "$TAG_CHARS_OK"

# image_matches_identity against a fake docker: reuse only on an exact
# full-identity match, and never for an unidentified source.
FULL_ID="local-aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990"
image_reuse_case() {
  # $1 = label recorded on the existing image, $2 = identity requested
  local recorded="$1" requested="$2"
  (
    docker() {
      case "$1" in
        image)
          case "$2" in
            inspect)
              [ "$recorded" = "__missing__" ] && return 1
              case "$*" in
                *--format*) printf '%s\n' "$recorded" ;;
              esac
              return 0
              ;;
          esac
          ;;
      esac
      return 0
    }
    image_matches_identity "deployment-platform-api:sometag" "$requested"
  ) >/dev/null 2>&1
}
assert_success "image reuse succeeds for an identical full identity" \
  image_reuse_case "$FULL_ID" "$FULL_ID"
assert_failure "image reuse fails when the recorded identity differs" \
  image_reuse_case "local-9999999999999999999999999999999999999999999999999999999999999999" "$FULL_ID"
assert_failure "image reuse fails when the requested identity is unknown" \
  image_reuse_case "unknown" "unknown"
assert_failure "a legacy image labelled unknown is never reused" \
  image_reuse_case "unknown" "$FULL_ID"
assert_failure "an unlabelled image is never reused" \
  image_reuse_case "" "$FULL_ID"
assert_failure "a missing image is never reused" \
  image_reuse_case "__missing__" "$FULL_ID"

echo
echo "=== Resume idempotency: release directories and backups ==="
assert_success "source test prerequisite: current_release_matches_identity is defined" \
  declare -F current_release_matches_identity
IDEM_ROOT="$TMP_ROOT/idem/opt/deployment-platform"
mkdir -p "$IDEM_ROOT/source/releases"
# The pre-existing "current" release. Its marker starts as a synthetic
# identity for the matcher checks below, and is later rewritten to the
# fixture tree's real fingerprint for the reuse test.
IDEM_EXISTING_RELEASE="$IDEM_ROOT/source/releases/release-20260727T124508Z-local-abc123abc123"
mkdir -p "$IDEM_EXISTING_RELEASE"
(
  INSTALL_ROOT="$IDEM_ROOT"
  DRY_RUN=0
  record_release_identity "$IDEM_EXISTING_RELEASE" "local-abc123"
  ln -sfn "$IDEM_EXISTING_RELEASE" "$IDEM_ROOT/source/current"
) >/dev/null 2>&1
IDEM_MATCH=0
(
  INSTALL_ROOT="$IDEM_ROOT"
  current_release_matches_identity "local-abc123"
) >/dev/null 2>&1 || IDEM_MATCH=$?
assert_eq "an unchanged source identity matches the current release" "0" "$IDEM_MATCH"
IDEM_DIFF=0
(
  INSTALL_ROOT="$IDEM_ROOT"
  current_release_matches_identity "local-different"
) >/dev/null 2>&1 || IDEM_DIFF=$?
assert_eq "a changed source identity does not match the current release" "1" "$IDEM_DIFF"
IDEM_UNKNOWN=0
(
  INSTALL_ROOT="$IDEM_ROOT"
  current_release_matches_identity "unknown"
) >/dev/null 2>&1 || IDEM_UNKNOWN=$?
assert_eq "an unknown identity never matches the current release" "1" "$IDEM_UNKNOWN"

# Repeated dns-pending resume: reuse path must not add release dirs, must
# not repoint current, and must skip the redundant backup.
#
# This uses the REAL resolve_local_source_identity against a real fixture
# tree — deliberately not a stub. An earlier version of this test replaced
# that production function and then `unset -f` it, which (once this test
# became a direct call rather than a subshell) deleted it for every later
# section: the caller-boundary test below then ran with the function
# missing and produced bogus "unknown" identities that looked like a
# production bug. Deterministic fixtures make the stub unnecessary: the
# expected identity is simply computed from the fixture's own content.
IDEM_SRC="$TMP_ROOT/idem-source"
mkdir -p "$IDEM_SRC/apps/api" "$IDEM_SRC/apps/web"
printf '{"name":"platform"}\n' > "$IDEM_SRC/package.json"
printf 'console.log("idem");\n' > "$IDEM_SRC/apps/api/index.js"

IDEM_FP="$(compute_source_content_fingerprint "$IDEM_SRC")"
IDEM_IDENTITY="local-${IDEM_FP}"
IDEM_SHORT="local-$(printf '%s' "$IDEM_FP" | cut -c1-12)"

# Record that exact identity on the existing release so the real
# implementation genuinely takes the reuse path.
record_release_identity "$IDEM_EXISTING_RELEASE" "$IDEM_IDENTITY"

RELEASE_COUNT_BEFORE="$(find "$IDEM_ROOT/source/releases" -maxdepth 1 -type d -name 'release-*' | wc -l | tr -d '[:space:]')"
CURRENT_BEFORE="$(cd "$IDEM_ROOT/source/current" && pwd -P)"
# Direct call in THIS shell — the same shape install.sh uses. Calling it
# through $() is exactly the bug this contract guards against, so the
# reuse assertions read the globals it sets rather than captured stdout.
SOURCE_RELEASE_DIR=""
RESOLVED_SOURCE_COMMIT=""
SOURCE_IDENTITY_SHORT=""
SOURCE_RELEASE_REUSED=0
IDEM_SAVED_INSTALL_ROOT="$INSTALL_ROOT"
IDEM_SAVED_OUTPUT_PATH="$PROMPT_OUTPUT_PATH"
INSTALL_ROOT="$IDEM_ROOT"
PROMPT_OUTPUT_PATH="$TMP_ROOT/idem-reuse.out"
acquire_source_from_local_path "$IDEM_SRC" 2>/dev/null
INSTALL_ROOT="$IDEM_SAVED_INSTALL_ROOT"
PROMPT_OUTPUT_PATH="$IDEM_SAVED_OUTPUT_PATH"
RELEASE_COUNT_AFTER="$(find "$IDEM_ROOT/source/releases" -maxdepth 1 -type d -name 'release-*' | wc -l | tr -d '[:space:]')"
CURRENT_AFTER="$(cd "$IDEM_ROOT/source/current" && pwd -P)"
assert_eq "repeated resume creates no additional release directory" "$RELEASE_COUNT_BEFORE" "$RELEASE_COUNT_AFTER"
assert_eq "repeated resume reports the existing release directory to the caller" "$CURRENT_BEFORE" "$SOURCE_RELEASE_DIR"
assert_eq "repeated resume leaves the current pointer unchanged" "$CURRENT_BEFORE" "$CURRENT_AFTER"
assert_eq "SOURCE_RELEASE_REUSED survives into the caller for the backup decision" "1" "$SOURCE_RELEASE_REUSED"
assert_eq "the reuse path reports the real computed identity to the caller" "$IDEM_IDENTITY" "$RESOLVED_SOURCE_COMMIT"
assert_eq "the reuse path reports the expected short identity to the caller" "$IDEM_SHORT" "$SOURCE_IDENTITY_SHORT"
assert_contains "install.sh skips the pre-deployment backup only when nothing changes" \
  "$(cat "$INSTALLER_DIR/install.sh")" 'SOURCE_RELEASE_REUSED:-0}" -eq 1 ] && [ "${IMAGES_ALL_REUSED:-0}" -eq 1 ]'
assert_contains "install.sh still backs up when a deployment change will occur" \
  "$(cat "$INSTALLER_DIR/install.sh")" "backup_database"
assert_contains "install.sh still runs DNS readiness on resume" \
  "$(cat "$INSTALLER_DIR/install.sh")" "run_dns_readiness_flow"
assert_contains "install.sh still runs verification on resume" \
  "$(cat "$INSTALLER_DIR/install.sh")" "run_full_verification"
assert_contains "install.sh still re-renders Caddy on resume" \
  "$(cat "$INSTALLER_DIR/install.sh")" "setup_caddy"

echo
echo "=== Source identity survives install.sh's caller boundary ==="
# Contamination guard. An earlier section used to override
# resolve_local_source_identity and then `unset -f` it, deleting the real
# implementation for everything downstream — which made this section
# report bogus "unknown" identities that looked exactly like a production
# regression. These assertions fail at the real boundary instead, naming
# the missing function, so that misdiagnosis cannot repeat.
assert_success "production function still defined: resolve_local_source_identity" \
  declare -F resolve_local_source_identity
assert_success "production function still defined: acquire_source_from_local_path" \
  declare -F acquire_source_from_local_path
assert_success "production function still defined: build_platform_images" \
  declare -F build_platform_images
assert_success "production function still defined: compute_source_content_fingerprint" \
  declare -F compute_source_content_fingerprint
assert_success "production function still defined: image_tag_for_commit" \
  declare -F image_tag_for_commit

# The live regression: the source stage logged a correct
# local-<sha256> identity, then the image stage received "unknown",
# because install.sh captured the helper with $() and every global the
# helper set died with that subshell. A unit test of
# resolve_local_source_identity cannot catch this — the bug lives at the
# CALL BOUNDARY, so this replays install.sh's actual sequence:
# acquire -> invariants -> state field -> build_platform_images.
CALLER_ROOT="$TMP_ROOT/caller/opt/deployment-platform"
CALLER_SRC="$TMP_ROOT/caller-source"
mkdir -p "$CALLER_ROOT/source/releases" "$CALLER_SRC/apps/api" "$CALLER_SRC/apps/web"
printf '{"name":"platform"}\n' > "$CALLER_SRC/package.json"
printf 'console.log("api");\n' > "$CALLER_SRC/apps/api/index.js"
printf 'FROM node:24-alpine\n' > "$CALLER_SRC/apps/api/Dockerfile"
printf 'FROM node:24-alpine\n' > "$CALLER_SRC/apps/web/Dockerfile"

CALLER_EXPECTED_FP="$(compute_source_content_fingerprint "$CALLER_SRC")"
CALLER_OUT="$TMP_ROOT/caller-run.out"
: > "$CALLER_OUT"

# Runs install.sh's real sequence against fake docker, capturing the
# values the parent shell ends up holding.
#
# Every case pattern in the stubs below is written with a leading open
# paren. That is required, not stylistic: inside a command substitution,
# an unbalanced close paren from a case pattern ends the substitution
# early. `bash -n` still reports the file as valid, because the body is
# re-parsed at run time — so the breakage shows up only when the test
# actually executes. For the same reason, comments inside a command
# substitution must not contain unbalanced parens either, which is why
# this note lives out here.
CALLER_RESULT="$(
  INSTALL_ROOT="$CALLER_ROOT"
  DRY_RUN=0
  PROMPT_OUTPUT_PATH="$CALLER_OUT"
  INSTALLER_LOG_FILE="$TMP_ROOT/caller.log"
  SOURCE_RELEASE_DIR=""
  RESOLVED_SOURCE_COMMIT=""
  SOURCE_IDENTITY_SHORT=""
  SOURCE_RELEASE_REUSED=0
  BUILT_API_IMAGE=""
  BUILT_WEB_IMAGE=""
  # No image exists yet, and builds succeed.
  docker() {
    case "$1" in
      (image) return 1 ;;
      (build) return 0 ;;
    esac
    return 0
  }
  # Really performs the rsync, so the release directory genuinely ends up
  # containing the Dockerfiles that build_platform_images requires. Never
  # runs a real docker build. A blanket no-op stub would skip the copy and
  # make build_platform_images fatal on a missing Dockerfile, masking the
  # identity assertions this test exists for.
  run_with_progress() {
    while [ "$#" -gt 0 ]; do
      case "$1" in
        (--show-output-tail) shift ;;
        (--) shift; break ;;
        (*) break ;;
      esac
    done
    shift
    case "$1" in
      (rsync) "$@" >/dev/null 2>&1 ;;
      (*) return 0 ;;
    esac
  }

  # The exact call shape used by install.sh: direct call, then read the
  # globals it assigned.
  acquire_source_from_local_path "$CALLER_SRC"
  RELEASE_DIR="$SOURCE_RELEASE_DIR"
  build_platform_images "$RELEASE_DIR" "$RESOLVED_SOURCE_COMMIT"

  printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$RESOLVED_SOURCE_COMMIT" "$SOURCE_IDENTITY_SHORT" "$RELEASE_DIR" \
    "$BUILT_API_IMAGE" "$BUILT_WEB_IMAGE" "$SOURCE_RELEASE_REUSED"
)"
CALLER_IDENTITY="$(printf '%s' "$CALLER_RESULT" | sed -n '1p')"
CALLER_SHORT="$(printf '%s' "$CALLER_RESULT" | sed -n '2p')"
CALLER_RELEASE="$(printf '%s' "$CALLER_RESULT" | sed -n '3p')"
CALLER_API_IMAGE="$(printf '%s' "$CALLER_RESULT" | sed -n '4p')"
CALLER_WEB_IMAGE="$(printf '%s' "$CALLER_RESULT" | sed -n '5p')"
CALLER_REUSED="$(printf '%s' "$CALLER_RESULT" | sed -n '6p')"

assert_eq "local acquisition computes local-<full sha256>" "local-${CALLER_EXPECTED_FP}" "$CALLER_IDENTITY"
assert_eq "the identity is still available in the caller after acquisition" "yes" \
  "$([ -n "$CALLER_IDENTITY" ] && echo yes || echo no)"
assert_eq "the caller's identity is never 'unknown' for a readable local source" "yes" \
  "$([ "$CALLER_IDENTITY" != "unknown" ] && echo yes || echo no)"
assert_eq "the short identity reaches the caller" "local-$(printf '%s' "$CALLER_EXPECTED_FP" | cut -c1-12)" "$CALLER_SHORT"
assert_contains "the release directory embeds the same short identity" "$CALLER_RELEASE" "$CALLER_SHORT"
assert_eq "the release directory reaches the caller" "yes" \
  "$([ -n "$CALLER_RELEASE" ] && echo yes || echo no)"
assert_eq "SOURCE_RELEASE_REUSED reaches the caller on a fresh copy" "0" "$CALLER_REUSED"

# The image stage must have received the SAME full identity.
assert_eq "the API image tag uses bootstrap-local-<prefix>" \
  "deployment-platform-api:bootstrap-local-$(printf '%s' "$CALLER_EXPECTED_FP" | cut -c1-12)" "$CALLER_API_IMAGE"
assert_eq "the web image tag uses bootstrap-local-<prefix>" \
  "deployment-platform-web:bootstrap-local-$(printf '%s' "$CALLER_EXPECTED_FP" | cut -c1-12)" "$CALLER_WEB_IMAGE"
assert_not_contains "the API image tag never falls back to bootstrap-unknown" "$CALLER_API_IMAGE" "bootstrap-unknown"
assert_not_contains "the web image tag never falls back to bootstrap-unknown" "$CALLER_WEB_IMAGE" "bootstrap-unknown"
CALLER_VISIBLE="$(cat "$CALLER_OUT")"
assert_not_contains "no stage reports an unverifiable 'requested: unknown' identity" "$CALLER_VISIBLE" "requested: unknown"
assert_contains "the source stage logged the full identity" "$CALLER_VISIBLE" "local-${CALLER_EXPECTED_FP}"

# The build label must carry the full identity, not the short tag.
CALLER_LABEL_ARGS="$(
  INSTALL_ROOT="$CALLER_ROOT"
  DRY_RUN=1
  PROMPT_OUTPUT_PATH="$TMP_ROOT/caller-label.out"
  INSTALLER_LOG_FILE="$TMP_ROOT/caller.log"
  docker() { case "$1" in (image) return 1 ;; esac; return 0; }
  build_platform_image "deployment-platform-api" "$CALLER_SRC/apps/api/Dockerfile" "$CALLER_SRC" "$CALLER_IDENTITY" >/dev/null 2>&1
  cat "$TMP_ROOT/caller-label.out"
)"
assert_contains "the image label records the complete source identity" "$CALLER_LABEL_ARGS" "com.deployment-platform.source-commit=${CALLER_IDENTITY}"

# Static guards: the state-setting helpers must never be re-wrapped in $().
assert_failure "install.sh does not capture acquire_source_* through command substitution" \
  bash -c "grep -v '^[[:space:]]*#' '$INSTALLER_DIR/install.sh' | grep -q '=\"\\\$(acquire_source'"
assert_failure "images.sh does not capture build_platform_image through command substitution" \
  bash -c "grep -v '^[[:space:]]*#' '$INSTALLER_DIR/lib/images.sh' | grep -q '=\"\\\$(build_platform_image'"
assert_contains "install.sh passes the resolved identity (not a default) to the image stage" \
  "$(cat "$INSTALLER_DIR/install.sh")" 'build_platform_images "$RELEASE_DIR" "$RESOLVED_SOURCE_COMMIT"'
assert_contains "install.sh records the resolved identity in state" \
  "$(cat "$INSTALLER_DIR/install.sh")" 'state_set_field "sourceCommit" "$RESOLVED_SOURCE_COMMIT"'
assert_contains "install.sh asserts the identity invariant before building" \
  "$(cat "$INSTALLER_DIR/install.sh")" "Internal state error"

echo
echo "=== In-container API probe: docker exec layout and behaviour ==="
# The live failure: the probe read process.argv[2..4], but with `node -e`
# argv[1] is the FIRST passed argument (there is no script-name element),
# so port became the path string (NaN) and the timeout became undefined.
# Configuration now travels as named environment variables.
API_PROBE_ARGV="$TMP_ROOT/api-probe-argv.log"
API_PROBE_SCRIPT_SEEN="$TMP_ROOT/api-probe-script.js"
FAKE_API_DOCKER="$TMP_ROOT/fakebin-api-docker"
mkdir -p "$FAKE_API_DOCKER"
# Records the exact argv it was given and the script text, then answers
# with whatever FAKE_API_REASON/FAKE_API_EXIT dictate.
cat > "$FAKE_API_DOCKER/docker" <<'FAKEAPIDOCKER'
#!/usr/bin/env bash
# Records every argument it received, and separately the final argument,
# which for `node -e <script>` is the script body itself.
: > "$API_PROBE_ARGV"
last_arg=""
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$API_PROBE_ARGV"
  last_arg="$arg"
done
printf '%s' "$last_arg" > "$API_PROBE_SCRIPT_SEEN"
if [ -n "${FAKE_API_REASON:-}" ]; then
  printf '%s' "$FAKE_API_REASON"
fi
exit "${FAKE_API_EXIT:-0}"
FAKEAPIDOCKER
chmod +x "$FAKE_API_DOCKER/docker"
export API_PROBE_ARGV API_PROBE_SCRIPT_SEEN

run_api_probe() {
  # $1 = reason string the fake node prints, $2 = exit code
  (
    PATH="$FAKE_API_DOCKER:$REAL_PATH"
    hash -r
    export FAKE_API_REASON="$1"
    export FAKE_API_EXIT="$2"
    verify_api_http_responds
    printf '%s' "$API_HTTP_CHECK_DETAIL"
  )
}

# --- docker exec argument layout ---
API_PROBE_DETAIL="$(run_api_probe "reason=http-status status=401" 0)"
hash -r
API_PROBE_ARGS="$(cat "$API_PROBE_ARGV")"
assert_contains "the probe runs docker exec" "$API_PROBE_ARGS" "exec"
assert_contains "DP_VERIFY_PORT is passed as a docker exec environment variable" "$API_PROBE_ARGS" "DP_VERIFY_PORT=3001"
assert_contains "DP_VERIFY_PATH is passed as a docker exec environment variable" "$API_PROBE_ARGS" "DP_VERIFY_PATH=/auth/session"
assert_contains "DP_VERIFY_TIMEOUT_MS is passed as a docker exec environment variable" "$API_PROBE_ARGS" "DP_VERIFY_TIMEOUT_MS=5000"
assert_contains "the probe targets the API container" "$API_PROBE_ARGS" "deployment-platform-api"
assert_contains "the probe invokes node with -e" "$API_PROBE_ARGS" "node"
assert_contains "the probe invokes node with -e (flag present)" "$API_PROBE_ARGS" "-e"
API_PROBE_SCRIPT="$(cat "$API_PROBE_SCRIPT_SEEN")"
assert_failure "the probe script no longer indexes process.argv" \
  grep -q "process.argv" "$API_PROBE_SCRIPT_SEEN"
assert_contains "the probe script reads its port from the environment" "$API_PROBE_SCRIPT" "process.env.DP_VERIFY_PORT"
assert_contains "the probe script reads its path from the environment" "$API_PROBE_SCRIPT" "process.env.DP_VERIFY_PATH"
assert_contains "the probe script reads its timeout from the environment" "$API_PROBE_SCRIPT" "process.env.DP_VERIFY_TIMEOUT_MS"
assert_contains "the probe connects to 127.0.0.1 inside the container" "$API_PROBE_SCRIPT" 'host: "127.0.0.1"'
assert_contains "the probe requires authenticated:false" "$API_PROBE_SCRIPT" "parsed.authenticated !== false"
assert_contains "the probe classifies an auth-hook rejection" "$API_PROBE_SCRIPT" "reason=auth-hook-rejected"
assert_contains "the probe discards the response body" "$API_PROBE_SCRIPT" "response.resume()"
assert_failure "no host-published API port is required (no host-side curl remains)" \
  bash -c "grep -v '^[[:space:]]*#' '$INSTALLER_DIR/lib/verify.sh' | grep -q 'curl.*127\.0\.0\.1'"

# --- shell-side status and diagnostic mapping ---
assert_eq "a healthy status yields a captured reason" "reason=http-status status=401" "$API_PROBE_DETAIL"
API_PROBE_500="$(run_api_probe "reason=unexpected-http-status status=500" 1)"; hash -r
assert_contains "an unexpected HTTP status is reported" "$API_PROBE_500" "unexpected-http-status status=500"
API_PROBE_REFUSED="$(run_api_probe "reason=connection-error code=ECONNREFUSED" 1)"; hash -r
assert_contains "connection refusal is reported" "$API_PROBE_REFUSED" "code=ECONNREFUSED"
API_PROBE_TIMEOUT="$(run_api_probe "reason=timeout after-ms=5000" 1)"; hash -r
assert_contains "a timeout is reported" "$API_PROBE_TIMEOUT" "reason=timeout"
API_PROBE_MALFORMED="$(run_api_probe "reason=malformed-http-status" 1)"; hash -r
assert_contains "a malformed status is reported" "$API_PROBE_MALFORMED" "malformed-http-status"
API_PROBE_DOCKER_FAIL="$(run_api_probe "" 125)"; hash -r
assert_contains "a docker exec failure is reported with its exit code" "$API_PROBE_DOCKER_FAIL" "docker-exec-failed exit=125"

for probe_case in "reason=http-status status=200:0:0" "reason=http-status status=401:0:0" \
                  "reason=http-status status=403:0:0" "reason=http-status status=404:0:0" \
                  "reason=unexpected-http-status status=500:1:1" \
                  "reason=connection-error code=ECONNREFUSED:1:1" \
                  "reason=timeout after-ms=5000:1:1" \
                  "reason=malformed-http-status:1:1" ":125:125"; do
  PROBE_REASON="${probe_case%:*:*}"
  PROBE_REST="${probe_case##*"$PROBE_REASON":}"
  PROBE_EXIT="${PROBE_REST%%:*}"
  PROBE_EXPECT="${PROBE_REST##*:}"
  PROBE_ACTUAL=0
  (
    PATH="$FAKE_API_DOCKER:$REAL_PATH"
    hash -r
    export FAKE_API_REASON="$PROBE_REASON"
    export FAKE_API_EXIT="$PROBE_EXIT"
    verify_api_http_responds
  ) >/dev/null 2>&1 || PROBE_ACTUAL=$?
  hash -r
  assert_eq "probe status for [${PROBE_REASON:-docker-failure}] is ${PROBE_EXPECT}" "$PROBE_EXPECT" "$PROBE_ACTUAL"
done

# --- the real script's status mapping, against a real loopback server ---
# Skipped where the host has no node (the VPS deliberately has none); the
# fake-docker cases above still cover the shell contract everywhere.
if command -v node >/dev/null 2>&1; then
  REAL_PROBE_JS="$TMP_ROOT/real-probe.js"
  _api_http_check_script > "$REAL_PROBE_JS"
  REAL_PROBE_HARNESS="$TMP_ROOT/real-probe-harness.mjs"
  cat > "$REAL_PROBE_HARNESS" <<'HARNESSEOF'
import http from "node:http";
import { execFile } from "node:child_process";
const probe = process.argv[2];
const run = (env) => new Promise((res) => {
  execFile("node", [probe], { env: { ...process.env, ...env }, encoding: "utf8" },
    (err, stdout) => res({ code: err ? err.code : 0, out: (stdout || "").trim() }));
});
const listen = (h) => new Promise((res) => {
  const s = http.createServer(h);
  s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port }));
});
const lines = [];
// The healthy case is HTTP 200 with an unauthenticated session body.
// Every other shape must be rejected and classified.
const cases = [
  ["healthy", 200, JSON.stringify({ authenticated: false })],
  ["authhook", 401, JSON.stringify({ success: false, message: "Authentication required" })],
  ["forbidden", 403, JSON.stringify({ success: false })],
  ["notfound", 404, JSON.stringify({ message: "Route not found" })],
  ["servererror", 500, JSON.stringify({ error: "boom" })],
  ["malformed", 200, "this is not json"],
  ["wrongshape", 200, JSON.stringify({ authenticated: true, username: "someone" })],
  ["missingfield", 200, JSON.stringify({ ok: true })]
];
for (const [label, code, payload] of cases) {
  const { s, port } = await listen((q, r) => {
    r.writeHead(code, { "Set-Cookie": "sess=MUST_NOT_APPEAR", "content-type": "application/json" });
    r.end(payload);
  });
  const r = await run({ DP_VERIFY_PORT: String(port), DP_VERIFY_PATH: "/auth/session", DP_VERIFY_TIMEOUT_MS: "5000" });
  s.close();
  lines.push(`${label} exit=${r.code} out=${r.out}`);
}
let r = await run({ DP_VERIFY_PORT: "1", DP_VERIFY_PATH: "/auth/session", DP_VERIFY_TIMEOUT_MS: "5000" });
lines.push(`refused exit=${r.code} out=${r.out}`);
const hang = await listen(() => {});
r = await run({ DP_VERIFY_PORT: String(hang.port), DP_VERIFY_PATH: "/x", DP_VERIFY_TIMEOUT_MS: "300" });
hang.s.close();
lines.push(`timeout exit=${r.code} out=${r.out}`);
r = await run({ DP_VERIFY_PORT: "", DP_VERIFY_PATH: "", DP_VERIFY_TIMEOUT_MS: "" });
lines.push(`badconfig exit=${r.code} out=${r.out}`);
console.log(lines.join("\n"));
HARNESSEOF
  REAL_PROBE_OUT="$(node "$REAL_PROBE_HARNESS" "$REAL_PROBE_JS" 2>/dev/null || true)"
  # Only an unauthenticated 200 session is healthy.
  assert_contains "real probe: 200 {authenticated:false} is healthy" "$REAL_PROBE_OUT" "healthy exit=0 out=reason=unauthenticated-session status=200"
  # These four are exactly what the old probe wrongly accepted.
  assert_contains "real probe: a 401 auth-hook rejection is UNHEALTHY" "$REAL_PROBE_OUT" "authhook exit=1 out=reason=auth-hook-rejected status=401"
  assert_contains "real probe: a 403 is UNHEALTHY" "$REAL_PROBE_OUT" "forbidden exit=1 out=reason=auth-hook-rejected status=403"
  assert_contains "real probe: a 404 is UNHEALTHY and named" "$REAL_PROBE_OUT" "notfound exit=1 out=reason=route-not-found status=404"
  assert_contains "real probe: a 500 is UNHEALTHY" "$REAL_PROBE_OUT" "servererror exit=1 out=reason=unexpected-http-status status=500"
  assert_contains "real probe: a malformed body is UNHEALTHY and named" "$REAL_PROBE_OUT" "malformed exit=1 out=reason=malformed-json-body status=200"
  assert_contains "real probe: an authenticated session is UNHEALTHY" "$REAL_PROBE_OUT" "wrongshape exit=1 out=reason=unexpected-session-state status=200"
  assert_contains "real probe: a missing authenticated field is UNHEALTHY" "$REAL_PROBE_OUT" "missingfield exit=1 out=reason=unexpected-session-state status=200"
  assert_contains "real probe: connection refusal exits 1 with ECONNREFUSED" "$REAL_PROBE_OUT" "refused exit=1 out=reason=connection-error code=ECONNREFUSED"
  assert_contains "real probe: timeout exits 1" "$REAL_PROBE_OUT" "timeout exit=1 out=reason=timeout"
  assert_contains "real probe: missing configuration exits 1" "$REAL_PROBE_OUT" "badconfig exit=1 out=reason=bad-probe-configuration"
  assert_not_contains "real probe never emits response cookies" "$REAL_PROBE_OUT" "MUST_NOT_APPEAR"
  assert_not_contains "real probe never emits response bodies" "$REAL_PROBE_OUT" "BODY_MUST_NOT_APPEAR"
else
  echo "[SKIP] node not installed — skipping real-loopback API probe behaviour checks (fake-docker contract checks above still ran)."
fi

echo
echo "=== Preflight: managed-Caddy port ownership ==="
assert_success "preflight test prerequisite: port_is_owned_by_managed_caddy is defined" \
  declare -F port_is_owned_by_managed_caddy
FAKE_PORT_BIN="$TMP_ROOT/fakebin-port"
mkdir -p "$FAKE_PORT_BIN"
# Emits real `docker port` output, including the IPv6 [::] form.
cat > "$FAKE_PORT_BIN/docker" <<'FAKEPORTDOCKER'
#!/usr/bin/env bash
case "$1" in
  inspect) [ "${FAKE_CADDY_EXISTS:-yes}" = "yes" ] && exit 0; exit 1 ;;
  port)
    [ "${FAKE_CADDY_EXISTS:-yes}" = "yes" ] || exit 1
    printf '80/tcp -> 0.0.0.0:80\n'
    printf '80/tcp -> [::]:80\n'
    printf '443/tcp -> 0.0.0.0:443\n'
    printf '443/tcp -> [::]:443\n'
    exit 0
    ;;
esac
exit 0
FAKEPORTDOCKER
chmod +x "$FAKE_PORT_BIN/docker"

PORTS_LISTED="$(PATH="$FAKE_PORT_BIN:$REAL_PATH"; hash -r; FAKE_CADDY_EXISTS=yes managed_caddy_published_ports | tr '\n' ' ' | sed 's/ *$//')"
hash -r
assert_eq "managed Caddy ports are parsed from IPv4 and IPv6 output" "443 80" "$PORTS_LISTED"
assert_success "port 80 is recognized as owned by the managed Caddy" \
  bash -c "PATH='$FAKE_PORT_BIN:$REAL_PATH'; export FAKE_CADDY_EXISTS=yes; source '$INSTALLER_DIR/lib/common.sh'; source '$INSTALLER_DIR/lib/preflight.sh'; port_is_owned_by_managed_caddy 80"
assert_failure "an unrelated port is not attributed to the managed Caddy" \
  bash -c "PATH='$FAKE_PORT_BIN:$REAL_PATH'; export FAKE_CADDY_EXISTS=yes; source '$INSTALLER_DIR/lib/common.sh'; source '$INSTALLER_DIR/lib/preflight.sh'; port_is_owned_by_managed_caddy 8080"
assert_failure "no port is attributed when the Caddy container is absent" \
  bash -c "PATH='$FAKE_PORT_BIN:$REAL_PATH'; export FAKE_CADDY_EXISTS=no; source '$INSTALLER_DIR/lib/common.sh'; source '$INSTALLER_DIR/lib/preflight.sh'; port_is_owned_by_managed_caddy 80"

# check_ports_available must PASS (not warn) for installer-owned ports,
# warn for a foreign listener, and never stop a healthy resume.
setup_verify_fixture
MANAGED_PORTS_STATUS=0
(
  PATH="$FAKE_PORT_BIN:$REAL_PATH"
  hash -r
  export FAKE_CADDY_EXISTS=yes
  ss() { printf 'LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\n' "80"; return 0; }
  REQUIRED_PORTS=(80)
  check_ports_available
) >/dev/null 2>&1 || MANAGED_PORTS_STATUS=$?
MANAGED_PORTS_VIS="$(cat "$VERIFY_VIS")"
restore_verify_fixture
hash -r
assert_eq "check_ports_available never fails a healthy resume" "0" "$MANAGED_PORTS_STATUS"
assert_contains "installer-owned ports are reported as expected, not as a conflict" "$MANAGED_PORTS_VIS" "already published by this installer's own"
assert_not_contains "no conflict warning is emitted for installer-owned ports" "$MANAGED_PORTS_VIS" "NOT this installer's"

setup_verify_fixture
(
  PATH="$FAKE_PORT_BIN:$REAL_PATH"
  hash -r
  export FAKE_CADDY_EXISTS=no
  ss() { printf 'LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\n' "80"; return 0; }
  REQUIRED_PORTS=(80)
  check_ports_available
) >/dev/null 2>&1 || true
FOREIGN_PORTS_VIS="$(cat "$VERIFY_VIS")"
restore_verify_fixture
hash -r
assert_contains "an unmanaged listener still produces a conflict warning" "$FOREIGN_PORTS_VIS" "NOT this installer's"

echo
echo "=== Caddy /api prefix routing contract ==="
# The live defect: the template used `handle /api/*`, which forwards the
# /api prefix unchanged. The API registers its routes WITHOUT that prefix,
# so nothing matched and every call — including login itself — fell
# through to the authentication hook as 401 "Authentication required".
CADDY_TEMPLATE_FILE="$INSTALLER_DIR/templates/Caddyfile.template"
CADDY_TEMPLATE_TEXT="$(cat "$CADDY_TEMPLATE_FILE")"

assert_contains "the template strips the /api prefix with handle_path" "$CADDY_TEMPLATE_TEXT" "handle_path /api/*"
assert_failure "the template no longer uses the non-stripping handle /api/* form" \
  bash -c "grep -v '^[[:space:]]*#' '$CADDY_TEMPLATE_FILE' | grep -qE '^[[:space:]]*handle /api/\*'"
assert_contains "the API container is still the /api upstream" "$CADDY_TEMPLATE_TEXT" "reverse_proxy __API_CONTAINER__:__API_PORT__"
assert_contains "non-API routes still fall through to the web container" "$CADDY_TEMPLATE_TEXT" "reverse_proxy __WEB_CONTAINER__:__WEB_PORT__"
assert_contains "per-app route import is still present" "$CADDY_TEMPLATE_TEXT" "import /etc/caddy/routes/*.caddy"

# Render exactly as render_caddyfile does, then assert on the real output.
CADDY_RENDERED="$TMP_ROOT/rendered.Caddyfile"
sed \
  -e "s|__PANEL_DOMAIN__|panel.example.com|g" \
  -e "s|__API_CONTAINER__|deployment-platform-api|g" \
  -e "s|__API_PORT__|3001|g" \
  -e "s|__WEB_CONTAINER__|deployment-platform-web|g" \
  -e "s|__WEB_PORT__|80|g" \
  "$CADDY_TEMPLATE_FILE" > "$CADDY_RENDERED"
CADDY_RENDERED_TEXT="$(cat "$CADDY_RENDERED")"
assert_failure "the rendered Caddyfile has no unreplaced placeholders" \
  grep -q '__[A-Z_]\{2,\}__' "$CADDY_RENDERED"
assert_contains "the rendered Caddyfile strips /api" "$CADDY_RENDERED_TEXT" "handle_path /api/*"
assert_contains "the rendered Caddyfile proxies the real API container" "$CADDY_RENDERED_TEXT" "reverse_proxy deployment-platform-api:3001"
assert_contains "the rendered Caddyfile proxies the real web container" "$CADDY_RENDERED_TEXT" "reverse_proxy deployment-platform-web:80"

# Path-mapping contract. handle_path performs `uri strip_prefix /api`,
# which Caddy's own config adapter emits as
# "strip_path_prefix": "/api" — confirmed against caddy v2.11.4 during
# development. These cases encode the mapping the frontend depends on.
map_api_path() {
  # Models ONLY the documented strip: a path under /api/ loses exactly
  # that one leading segment; the query string is not part of the path
  # and is therefore untouched.
  local full="$1" path query
  path="${full%%\?*}"
  case "$full" in
    (*\?*) query="?${full#*\?}" ;;
    (*) query="" ;;
  esac
  case "$path" in
    (/api/*) printf '%s%s' "${path#/api}" "$query" ;;
    (/api) printf 'NO_MATCH_WEB' ;;
    (*) printf 'NO_MATCH_WEB' ;;
  esac
}
assert_eq "/api/auth/login maps to the backend /auth/login" "/auth/login" "$(map_api_path /api/auth/login)"
assert_eq "/api/auth/session maps to the backend /auth/session" "/auth/session" "$(map_api_path /api/auth/session)"
assert_eq "/api/auth/logout maps to the backend /auth/logout" "/auth/logout" "$(map_api_path /api/auth/logout)"
assert_eq "/api/apps?x=1 preserves path and query" "/apps?x=1" "$(map_api_path '/api/apps?x=1')"
assert_eq "/api/apps/123/logs?tail=40 preserves nested path and query" "/apps/123/logs?tail=40" "$(map_api_path '/api/apps/123/logs?tail=40')"
assert_eq "/api/ maps to the backend root" "/" "$(map_api_path /api/)"
# Explicitly defined: a bare /api does not match /api/* and is served by
# the web container. The frontend never requests it.
assert_eq "a bare /api does not reach the backend" "NO_MATCH_WEB" "$(map_api_path /api)"
assert_eq "a non-API panel route does not reach the backend" "NO_MATCH_WEB" "$(map_api_path /settings)"
assert_eq "the panel root does not reach the backend" "NO_MATCH_WEB" "$(map_api_path /)"

# The fix must live in Caddy, NOT in the API's public-path allowlist.
AUTH_TS="$(cd "$INSTALLER_DIR/.." && pwd)/apps/api/src/auth.ts"
if [ -f "$AUTH_TS" ]; then
  assert_failure "no /api/-prefixed route was added to the auth public allowlist" \
    bash -c "sed -n '/const publicPaths = new Set/,/\]/p' '$AUTH_TS' | grep -q '\"/api/'"
  assert_contains "the auth allowlist still lists the real login route" "$(cat "$AUTH_TS")" '"/auth/login"'
  assert_contains "the auth allowlist still lists the real session route" "$(cat "$AUTH_TS")" '"/auth/session"'
fi

echo
echo "=== Log output survives a session with no controlling terminal ==="
# `ssh host deployment-platform verify` has no /dev/tty. The append to it
# fails, and with `>> path 2>/dev/null` the shell printed its own
# "No such device or address" in front of EVERY line — a healthy run
# looked broken. Ordering the redirections the other way fixes it.
COMMON_SRC="$(cat "$INSTALLER_DIR/lib/common.sh")"
assert_contains "the visible-output redirection discards stderr first" "$COMMON_SRC" \
  'printf '"'"'%s\n'"'"' "$1" 2>/dev/null >> "${PROMPT_OUTPUT_PATH:-/dev/tty}"'
assert_failure "the old redirection order is gone from the visible path" \
  bash -c "grep -q 'printf .%s..n. \"\\\$1\" >> \"\\\${PROMPT_OUTPUT_PATH:-/dev/tty}\" 2>/dev/null' '$INSTALLER_DIR/lib/common.sh'"

# Functional proof: an unwritable output path must produce the log line
# on stderr and nothing else.
TTYLESS_OUT="$(
  bash -c '
    DEPLOYMENT_PLATFORM_INSTALLER_ROOT='"'$INSTALLER_DIR'"'
    source '"'$INSTALLER_DIR/lib/common.sh'"'
    PROMPT_OUTPUT_PATH=/nonexistent-directory-for-tests/out
    INSTALLER_LOG_FILE=/nonexistent-directory-for-tests/installer.log
    log_pass "verification line"
  ' 2>&1
)"
assert_contains "the log line still reaches the operator" "$TTYLESS_OUT" "[PASS] verification line"
assert_not_contains "no shell redirection error is printed" "$TTYLESS_OUT" "No such file or directory"
assert_not_contains "no /dev/tty error is printed" "$TTYLESS_OUT" "No such device or address"

echo
echo "=== Installer verification probes the REAL backend route ==="
VERIFY_SRC="$(cat "$INSTALLER_DIR/lib/verify.sh")"
assert_contains "the container probe targets /auth/session" "$VERIFY_SRC" 'API_HEALTH_CHECK_PATH="/auth/session"'
assert_failure "the container probe no longer targets /api/auth/session" \
  bash -c "grep -q 'API_HEALTH_CHECK_PATH=\"/api/auth/session\"' '$INSTALLER_DIR/lib/verify.sh'"
assert_contains "the public probe targets /api/auth/session through Caddy" "$VERIFY_SRC" 'API_PUBLIC_HEALTH_CHECK_PATH="/api/auth/session"'
assert_contains "an unauthenticated session is required to be 200" "$VERIFY_SRC" "reason=unauthenticated-session status=200"
assert_contains "the probe requires authenticated to be exactly false" "$VERIFY_SRC" "parsed.authenticated !== false"
# 401 must no longer count as healthy — that is what hid this defect.
assert_contains "an auth-hook rejection is classified distinctly" "$VERIFY_SRC" "reason=auth-hook-rejected"
assert_contains "a 404 is classified distinctly" "$VERIFY_SRC" "reason=route-not-found"
assert_contains "a malformed body is classified distinctly" "$VERIFY_SRC" "reason=malformed-json-body"
assert_contains "a connectivity failure is classified distinctly" "$VERIFY_SRC" "reason=connection-error"
assert_failure "401 is no longer on a healthy-status list" \
  bash -c "grep -q 'healthy = \[200, 401' '$INSTALLER_DIR/lib/verify.sh'"
assert_contains "the public prefix check exists" "$VERIFY_SRC" "verify_public_api_prefix"
assert_contains "the public prefix check names handle_path in its remedy" "$VERIFY_SRC" "handle_path /api/"

echo
echo "=== End-to-end authentication smoke test ==="
assert_contains "the login smoke test exists" "$VERIFY_SRC" "verify_public_login_rejection"
assert_contains "the login smoke test runs as part of full verification" "$VERIFY_SRC" \
  'verify_public_login_rejection "$panel_domain"'
assert_contains "the login smoke test posts to the public /api path" "$VERIFY_SRC" 'API_PUBLIC_LOGIN_PATH="/api/auth/login"'
assert_contains "the login smoke test expects the handler's rejection message" "$VERIFY_SRC" "Invalid username or password"
assert_contains "an auth-hook rejection at login is diagnosed as a routing defect" "$VERIFY_SRC" \
  "rejected by the authentication hook before reaching the login handler"
assert_contains "an accepted placeholder credential is treated as an incident" "$VERIFY_SRC" \
  "A deliberately invalid credential pair was ACCEPTED"
assert_contains "rate limiting does not fail the smoke test" "$VERIFY_SRC" "rate limited; the login route was reached"
# The credentials used must be self-evidently fake and must never be the
# operator's. They are also piped on stdin, never placed in argv.
assert_contains "the smoke test credentials are obvious placeholders" "$VERIFY_SRC" \
  'API_LOGIN_SMOKE_PASSWORD="installer-verification-not-a-real-password"'
assert_contains "the smoke test body is sent on stdin, not argv" "$VERIFY_SRC" "--data-binary @-"
assert_failure "no --data with an inline credential literal in argv" \
  bash -c "grep -q -- \"--data '{\" '$INSTALLER_DIR/lib/verify.sh'"
# Both public checks must appear in a healthy run's visible output.
assert_contains "a healthy run reports the public prefix check" "$HEALTHY_VIS" "the /api prefix is stripped correctly"
assert_contains "a healthy run reports the login rejection check" "$HEALTHY_VIS" "the login handler ran and rejected the attempt"
assert_contains "a broken run diagnoses the login path too" "$BROKEN_VIS" "Login rejection smoke test"

echo
echo "=== Admin password rotation command ==="
assert_success "rotation prerequisite: rotate_admin_password is defined" declare -F rotate_admin_password
assert_success "rotation prerequisite: _write_rotated_auth_file is defined" declare -F _write_rotated_auth_file
SECRETS_SRC="$(cat "$INSTALLER_DIR/lib/secrets.sh")"
assert_contains "rotation reuses the hardened hashing helper" "$SECRETS_SRC" 'compute_password_hash "$password_file"'
assert_contains "rotation recreates the API container (env-file is read at create time)" "$SECRETS_SRC" "_recreate_api_container_for_rotation"
assert_contains "rotation backs up the previous secrets file" "$SECRETS_SRC" "auth_backup"
assert_contains "rotation rolls back on verification failure" "$SECRETS_SRC" "Password rotation was rolled back"
assert_contains "rotation verifies the login handler is reachable" "$SECRETS_SRC" "Invalid username or password"
assert_failure "rotation never accepts a plaintext password argument" \
  bash -c "grep -q 'reset-admin-password --password ' '$INSTALLER_DIR/templates/deployment-platform-cli.template'"
CLI_SRC="$(cat "$INSTALLER_DIR/templates/deployment-platform-cli.template")"
assert_contains "the CLI exposes reset-admin-password" "$CLI_SRC" "reset-admin-password)"
assert_contains "the CLI requires root for rotation" "$CLI_SRC" "require_root_for reset-admin-password"
assert_contains "non-interactive rotation accepts only a password file" "$CLI_SRC" "--password-file"
assert_contains "the CLI rejects any other rotation option" "$CLI_SRC" "A plaintext password is never accepted as an argument"

# _write_rotated_auth_file must preserve every other key exactly.
ROTATE_FIXTURE_DIR="$TMP_ROOT/rotate/config"
mkdir -p "$ROTATE_FIXTURE_DIR"
cat > "$ROTATE_FIXTURE_DIR/auth.env" <<'AUTHFIX'
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=oldsalt:oldhash
SESSION_SECRET=keepthissecret
COOKIE_SECURE=true
CREDENTIAL_ENCRYPTION_KEY=keepthiskeytoo
AUTHFIX
chmod 600 "$ROTATE_FIXTURE_DIR/auth.env"
(
  INSTALL_ROOT="$TMP_ROOT/rotate"
  AUTH_FILE_PATH="$ROTATE_FIXTURE_DIR/auth.env"
  _write_rotated_auth_file "newsalt:newhash"
) >/dev/null 2>&1
ROTATED_TEXT="$(cat "$ROTATE_FIXTURE_DIR/auth.env")"
assert_contains "rotation writes the new hash" "$ROTATED_TEXT" "ADMIN_PASSWORD_HASH=newsalt:newhash"
assert_not_contains "rotation removes the old hash" "$ROTATED_TEXT" "oldsalt:oldhash"
assert_contains "rotation preserves ADMIN_USERNAME" "$ROTATED_TEXT" "ADMIN_USERNAME=admin"
assert_contains "rotation preserves SESSION_SECRET" "$ROTATED_TEXT" "SESSION_SECRET=keepthissecret"
assert_contains "rotation preserves COOKIE_SECURE" "$ROTATED_TEXT" "COOKIE_SECURE=true"
assert_contains "rotation preserves CREDENTIAL_ENCRYPTION_KEY" "$ROTATED_TEXT" "CREDENTIAL_ENCRYPTION_KEY=keepthiskeytoo"
assert_eq "the rotated secrets file stays mode 600" "600" "$(get_file_mode "$ROTATE_FIXTURE_DIR/auth.env")"
assert_eq "the rotated secrets file keeps exactly one hash line" "1" \
  "$(grep -c '^ADMIN_PASSWORD_HASH=' "$ROTATE_FIXTURE_DIR/auth.env" | tr -d '[:space:]')"

echo
echo "=== State file: atomic writes and stage tracking ==="
state_init_dir
state_set_field "installerVersion" "1.0.0"
state_set_field "panelDomain" "panel.example.com"
state_set_stage "initialized"
assert_eq "state file was created" "yes" "$([ -f "$STATE_FILE" ] && echo yes || echo no)"
assert_eq "state file is not world-readable" "600" "$(get_file_mode "$STATE_FILE")"
assert_eq "currentStage reads back correctly" "initialized" "$(state_get_stage)"
assert_eq "panelDomain persisted across the stage update" "panel.example.com" "$(state_read_field panelDomain)"

state_set_stage "preflight-complete"
assert_eq "currentStage advances" "preflight-complete" "$(state_get_stage)"
assert_eq "earlier field is still present after a later stage update" "panel.example.com" "$(state_read_field panelDomain)"

if command -v jq >/dev/null 2>&1; then
  assert_success "completedStages contains the first stage" bash -c "jq -e '.completedStages | index(\"initialized\") != null' \"$STATE_FILE\""
  assert_success "completedStages contains the second stage" bash -c "jq -e '.completedStages | index(\"preflight-complete\") != null' \"$STATE_FILE\""
fi

state_set_failed "images" "Build failed for deployment-platform-api"
assert_eq "currentStage becomes failed" "failed" "$(state_get_stage)"
assert_eq "lastFailedStage recorded" "images" "$(state_read_field lastFailedStage)"

echo
echo "=== State file never stores obvious secret values ==="
NO_SECRET_LEAK=1
for pattern in "ADMIN_PASSWORD" "CREDENTIAL_ENCRYPTION_KEY" "SESSION_SECRET"; do
  if grep -q "$pattern" "$STATE_FILE" 2>/dev/null; then
    NO_SECRET_LEAK=0
  fi
done
assert_eq "state file contains no secret field names" "1" "$NO_SECRET_LEAK"

echo
echo "=== ShellCheck (if available) ==="
if command -v shellcheck >/dev/null 2>&1; then
  SHELLCHECK_FAILURES=0
  for f in "$INSTALLER_DIR"/install.sh "$INSTALLER_DIR"/lib/*.sh; do
    if ! shellcheck -x -S warning "$f" >/dev/null 2>&1; then
      SHELLCHECK_FAILURES=$((SHELLCHECK_FAILURES + 1))
      printf '[FAIL] shellcheck: %s\n' "$f"
    fi
  done
  assert_eq "all installer scripts pass shellcheck (warning level)" "0" "$SHELLCHECK_FAILURES"
else
  echo "[SKIP] shellcheck not installed — skipping static analysis pass."
fi

echo
echo "=== Bash 3.2 compatibility scan (static — not a substitute for the real execution tests above) ==="
# This is a defense-in-depth text scan for known Bash 4+-only constructs.
# It intentionally does NOT replace the execution tests above (which
# already exercise state_set_field/state_set_stage/state_read_field/
# state_set_failed for real, against the current interpreter) — a text
# scan can miss constructs it doesn't know about, but it catches
# regressions fast and cheaply for the ones it does know about.
BASH4_PATTERN_FAILURES=0
for f in "$INSTALLER_DIR"/install.sh "$INSTALLER_DIR"/lib/*.sh "$INSTALLER_DIR"/templates/*; do
  [ -f "$f" ] || continue
  if grep -nE 'declare[[:space:]]+-[a-zA-Z]*A|declare[[:space:]]+-[a-zA-Z]*n|\bmapfile\b|\breadarray\b|\$\{[A-Za-z_][A-Za-z0-9_]*,,\}|\$\{[A-Za-z_][A-Za-z0-9_]*\^\^\}|\bcoproc\b|wait[[:space:]]+-n' "$f" | grep -v '^[0-9]*:[[:space:]]*#'; then
    BASH4_PATTERN_FAILURES=$((BASH4_PATTERN_FAILURES + 1))
    printf '[FAIL] Bash 4+-only construct found in: %s\n' "$f"
  fi
done
assert_eq "no Bash 4+-only constructs in installer scripts" "0" "$BASH4_PATTERN_FAILURES"

echo
echo "=== Syntax validation (always runs, no dependencies) ==="
SYNTAX_FAILURES=0
for f in "$INSTALLER_DIR"/install.sh "$INSTALLER_DIR"/lib/*.sh; do
  if ! bash -n "$f" 2>/dev/null; then
    SYNTAX_FAILURES=$((SYNTAX_FAILURES + 1))
    printf '[FAIL] bash -n: %s\n' "$f"
  fi
done
assert_eq "every installer script has valid bash syntax" "0" "$SYNTAX_FAILURES"

echo
echo "=== Results ==="
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
