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
echo "=== State file: atomic writes and stage tracking ==="
state_init_dir
state_set_field "installerVersion" "1.0.0"
state_set_field "panelDomain" "panel.example.com"
state_set_stage "initialized"
assert_eq "state file was created" "yes" "$([ -f "$STATE_FILE" ] && echo yes || echo no)"
assert_eq "state file is not world-readable" "600" "$(stat -f '%Lp' "$STATE_FILE" 2>/dev/null || stat -c '%a' "$STATE_FILE" 2>/dev/null)"
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
