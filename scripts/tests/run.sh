#!/usr/bin/env bash
#
# scripts/tests/run.sh — release automation test suite for release.sh and
# scripts/release-remote.sh.
#
# Requires no VPS, no Docker, no network, and never contacts a real host:
# every remote interaction is replaced by a fake `ssh` on PATH, and the
# release config is a temporary fixture. Run with:
#
#   bash scripts/tests/run.sh
set -Eeuo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$TESTS_DIR/../.." && pwd)"
RELEASE_SH="$PROJECT_DIR/release.sh"
REMOTE_SH="$PROJECT_DIR/scripts/release-remote.sh"

echo "=== Bash interpreter ==="
echo "BASH_VERSION: ${BASH_VERSION:-unknown}"
bash --version | head -n 1
echo

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
REAL_PATH="$PATH"

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

# ============================================================
# Loading the version helpers without executing a release
# ============================================================
#
# release.sh is a top-to-bottom script, not a library, so its pure
# helper functions are extracted by sourcing only the region above the
# first executable section. That keeps these unit tests honest: they
# exercise the REAL compute_next_version / is_bootstrap_tag /
# bump_patch / validate_release_version definitions from release.sh
# rather than reimplementations.
HELPERS_FILE="$TMP_ROOT/release-helpers.sh"
awk '
  /^# =+$/ { boundary = 1 }
  /^# Resume-path validation/ { exit }
  { print }
' "$RELEASE_SH" > "$HELPERS_FILE"

# `fail` and `info` are defined near the top of release.sh; confirm the
# extraction captured what these tests need before relying on it.
# shellcheck source=/dev/null
source "$HELPERS_FILE"

echo "=== Extraction sanity: real release.sh helpers are loaded ==="
for fn in is_valid_semver is_bootstrap_tag bump_patch compute_next_version validate_release_version; do
  assert_success "release.sh helper is available: $fn" declare -F "$fn"
done
assert_eq "INITIAL_RELEASE_VERSION is defined by release.sh" "0.1.0" "${INITIAL_RELEASE_VERSION:-}"

echo
echo "=== Initial version matches the project's declared package versions ==="
# The chosen initial version must agree with what the code says about
# itself, not be an arbitrary constant.
ROOT_PKG_VERSION="$(grep -m1 '"version"' "$PROJECT_DIR/package.json" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
API_PKG_VERSION="$(grep -m1 '"version"' "$PROJECT_DIR/apps/api/package.json" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
WEB_PKG_VERSION="$(grep -m1 '"version"' "$PROJECT_DIR/apps/web/package.json" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
assert_eq "INITIAL_RELEASE_VERSION matches root package.json" "$ROOT_PKG_VERSION" "$INITIAL_RELEASE_VERSION"
assert_eq "INITIAL_RELEASE_VERSION matches apps/api package.json" "$API_PKG_VERSION" "$INITIAL_RELEASE_VERSION"
assert_eq "INITIAL_RELEASE_VERSION matches apps/web package.json" "$WEB_PKG_VERSION" "$INITIAL_RELEASE_VERSION"

echo
echo "=== Bootstrap tag recognition ==="
assert_success "recognizes bootstrap-unknown" is_bootstrap_tag "bootstrap-unknown"
assert_success "recognizes bootstrap-local-<12 hex>" is_bootstrap_tag "bootstrap-local-da486e2b7645"
assert_success "recognizes bootstrap-<12 hex>" is_bootstrap_tag "bootstrap-4f3c2b1a0987"
assert_success "recognizes a longer local fingerprint prefix" is_bootstrap_tag "bootstrap-local-da486e2b7645aa"
assert_failure "does not treat a semantic version as a bootstrap tag" is_bootstrap_tag "1.2.3"
assert_failure "does not treat 'latest' as a bootstrap tag" is_bootstrap_tag "latest"
assert_failure "does not treat a bare 'bootstrap' as a bootstrap tag" is_bootstrap_tag "bootstrap"
assert_failure "does not treat non-hex bootstrap suffixes as bootstrap tags" is_bootstrap_tag "bootstrap-zzzzzz"
assert_failure "does not treat an empty tag as a bootstrap tag" is_bootstrap_tag ""
assert_failure "does not treat 'unknown' alone as a bootstrap tag" is_bootstrap_tag "unknown"

echo
echo "=== compute_next_version: bootstrap tags start the version track ==="
assert_eq "bootstrap-unknown -> initial version" "0.1.0" \
  "$(compute_next_version "bootstrap-unknown" "yes" "")"
assert_eq "bootstrap-local-<hex> -> initial version" "0.1.0" \
  "$(compute_next_version "bootstrap-local-da486e2b7645" "yes" "")"
assert_eq "bootstrap-<hex> -> initial version" "0.1.0" \
  "$(compute_next_version "bootstrap-4f3c2b1a0987" "yes" "")"
# The exact live tags from the temporary VPS installation.
assert_eq "live API bootstrap tag -> initial version" "0.1.0" \
  "$(compute_next_version "bootstrap-local-da486e2b7645" "yes" "")"

echo
echo "=== compute_next_version: existing semantic versions patch-bump ==="
assert_eq "0.1.0 patch-bumps" "0.1.1" "$(compute_next_version "0.1.0" "yes" "")"
assert_eq "1.2.3 patch-bumps" "1.2.4" "$(compute_next_version "1.2.3" "yes" "")"
assert_eq "1.2.9 patch-bumps across the digit boundary" "1.2.10" "$(compute_next_version "1.2.9" "yes" "")"
assert_eq "0.0.0 patch-bumps" "0.0.1" "$(compute_next_version "0.0.0" "yes" "")"

echo
echo "=== compute_next_version: unchanged components keep their tag ==="
assert_eq "an unchanged component on a semver keeps it" "1.2.3" \
  "$(compute_next_version "1.2.3" "no" "")"
assert_eq "an unchanged component on a bootstrap tag keeps it" "bootstrap-unknown" \
  "$(compute_next_version "bootstrap-unknown" "no" "")"

echo
echo "=== compute_next_version: explicit override wins ==="
assert_eq "override beats a bootstrap tag" "2.0.0" \
  "$(compute_next_version "bootstrap-unknown" "yes" "2.0.0")"
assert_eq "override beats a semver patch bump" "5.6.7" \
  "$(compute_next_version "1.2.3" "yes" "5.6.7")"
assert_eq "override applies even to an unrecognized tag" "3.0.0" \
  "$(compute_next_version "some-weird-tag" "yes" "3.0.0")"
assert_eq "override applies to an unknown current version" "1.0.0" \
  "$(compute_next_version "unknown" "yes" "1.0.0")"

echo
echo "=== compute_next_version: unrecognized tags are never mangled ==="
# The old bump_patch on a non-semver produced garbage such as
# "bootstrap-unknown..1", which then failed the remote script's semver
# validation after the release had already begun.
for weird in "latest" "some-weird-tag" "v1.2.3" "1.2" "release-2024" "bootstrap"; do
  RESULT="$(compute_next_version "$weird" "yes" "")"
  assert_eq "unrecognized tag '$weird' is returned unchanged" "$weird" "$RESULT"
  assert_not_contains "unrecognized tag '$weird' is not mangled into a fake version" "$RESULT" ".."
done
assert_eq "an unknown current version is returned unchanged" "unknown" \
  "$(compute_next_version "unknown" "yes" "")"

echo
echo "=== validate_release_version: clear failure, never a silent pass ==="
# validate_release_version calls fail(), which exits; run it in a subshell
# and capture the message.
run_validate() {
  local computed="$1" current="$2"
  (
    validate_release_version "API" "$computed" "$current" "--api-version"
  ) 2>&1
}
assert_success "a valid computed semver passes validation" \
  bash -c "source '$HELPERS_FILE'; validate_release_version API 0.1.0 bootstrap-unknown --api-version"
assert_failure "an unrecognized tag fails validation" \
  bash -c "source '$HELPERS_FILE'; validate_release_version API latest latest --api-version"
assert_failure "an unknown current version fails validation" \
  bash -c "source '$HELPERS_FILE'; validate_release_version API unknown unknown --api-version"
VALIDATE_WEIRD_MSG="$(run_validate "latest" "latest" || true)"
assert_contains "the failure names the offending tag" "$VALIDATE_WEIRD_MSG" "latest"
assert_contains "the failure tells the operator how to proceed" "$VALIDATE_WEIRD_MSG" "--api-version"
assert_contains "the failure states nothing was changed" "$VALIDATE_WEIRD_MSG" "Nothing was changed"
VALIDATE_UNKNOWN_MSG="$(run_validate "unknown" "unknown" || true)"
assert_contains "an unreachable-VPS failure explains the cause" "$VALIDATE_UNKNOWN_MSG" "Could not determine"
assert_not_contains "a mangled version is never accepted" \
  "$(bash -c "source '$HELPERS_FILE'; validate_release_version API 'bootstrap-unknown..1' 'bootstrap-unknown' --api-version" 2>&1 || true)" \
  "PASS"

echo
echo "=== No hard-coded hookstats.com labels remain in operator output ==="
# The default panel URL constant may still reference an example host, but
# no operator-facing summary or plan LABEL may hard-code it.
# Only code lines matter here: the default URL constant may still carry
# an example host, and comments may explain the old behaviour, but no
# executable line may print a hard-coded hostname to the operator.
HOOKSTATS_LABEL_HITS="$(grep -n 'hookstats' "$RELEASE_SH" \
  | grep -v '^[0-9]*:[[:space:]]*#' \
  | grep -v '^[0-9]*:PUBLIC_URL_PANEL=' || true)"
assert_eq "no executable line hard-codes a hookstats.com label" "" "$HOOKSTATS_LABEL_HITS"
assert_failure "no info/printf line hard-codes a hookstats.com hostname" \
  bash -c "grep -E '^[[:space:]]*(info|printf|echo)' '$RELEASE_SH' | grep -q hookstats"
assert_failure "release-remote.sh contains no hookstats.com reference" \
  grep -q 'hookstats' "$REMOTE_SH"
assert_contains "the panel summary label renders the configured URL" \
  "$(cat "$RELEASE_SH")" 'info "Panel URL (${PUBLIC_URL_PANEL}):'
assert_contains "an unconfigured optional URL prints an honest skipped label" \
  "$(cat "$RELEASE_SH")" 'skipped (not configured)'

echo
echo "=== Optional smoke-test URL defaults ==="
assert_contains "PUBLIC_URL_WIZARD_TEST defaults to disabled" \
  "$(cat "$RELEASE_SH")" 'PUBLIC_URL_WIZARD_TEST=""'
assert_contains "PUBLIC_URL_SQLITE_TEST defaults to disabled" \
  "$(cat "$RELEASE_SH")" 'PUBLIC_URL_SQLITE_TEST=""'
assert_failure "release-remote.sh no longer requires the wizard URL" \
  bash -c "grep -A3 'for required in SOURCE_DIR' '$REMOTE_SH' | grep -q 'URL_WIZARD_TEST'"
assert_failure "release-remote.sh no longer requires the sqlite URL" \
  bash -c "grep -A3 'for required in SOURCE_DIR' '$REMOTE_SH' | grep -q 'URL_SQLITE_TEST'"
assert_contains "release-remote.sh still requires the panel URL" \
  "$(grep -A5 'for required in SOURCE_DIR' "$REMOTE_SH")" "URL_PANEL"
assert_contains "release.sh only passes the wizard flag when configured" \
  "$(cat "$RELEASE_SH")" 'remote_args+=(--url-wizard-test'
assert_contains "release.sh only passes the sqlite flag when configured" \
  "$(cat "$RELEASE_SH")" 'remote_args+=(--url-sqlite-test'
assert_not_contains "no magic placeholder points an app check at the panel URL" \
  "$(cat "$RELEASE_SH")" '--url-wizard-test "${PUBLIC_URL_PANEL}"'

echo
echo "=== Remote URL gate semantics (real functions, fake curl) ==="
# Extracts the remote script's URL-checking region and exercises the real
# check_optional_public_url plus the real pass/fail gate, with curl faked
# so no network request is ever made.
URL_GATE_FILE="$TMP_ROOT/url-gate.sh"
cat > "$URL_GATE_FILE" <<'GATEEOF'
info() { printf '%s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
GATEEOF
# Pull check_public_url + check_optional_public_url + the whole gate out
# of the real remote script, so the logic under test is the shipped
# logic. Bounded by explicit markers: a bare "fi" would stop at the first
# nested if-block instead of the end of the gate.
awk '
  /^check_public_url\(\) \{/ { capture = 1 }
  capture { print }
  /^fi$/ && capture && seen_gate { exit }
  /^if \[ "\$\{URL_CHECK_FAILURES\}" -gt 0 \]; then$/ { seen_gate = 1 }
' "$REMOTE_SH" >> "$URL_GATE_FILE"
printf 'printf "RESULTS panel=%%s wizard=%%s sqlite=%%s\\n" "${RESULT_PANEL}" "${RESULT_WIZARD}" "${RESULT_SQLITE}"\n' >> "$URL_GATE_FILE"

run_url_gate() {
  # $1 panel url, $2 wizard url, $3 sqlite url, $4 fake http code
  local panel="$1" wizard="$2" sqlite="$3" code="$4"
  (
    URL_PANEL="$panel"
    URL_WIZARD_TEST="$wizard"
    URL_SQLITE_TEST="$sqlite"
    FAKE_HTTP_CODE="$code"
    curl() { printf '%s' "${FAKE_HTTP_CODE}"; }
    # shellcheck source=/dev/null
    source "$URL_GATE_FILE"
  ) 2>&1
}

GATE_ALL_DISABLED="$(run_url_gate "https://panel.example.com" "" "" "200" || true)"
assert_contains "panel is checked when optional URLs are disabled" "$GATE_ALL_DISABLED" "panel (mandatory)"
assert_contains "a disabled wizard check reports SKIPPED with a reason" "$GATE_ALL_DISABLED" "wizard test: SKIPPED"
assert_contains "a disabled sqlite check reports SKIPPED with a reason" "$GATE_ALL_DISABLED" "sqlite test: SKIPPED"
assert_contains "the skip reason names the missing configuration" "$GATE_ALL_DISABLED" "no --url-wizard-test configured"
assert_contains "the release passes with only the panel checked" "$GATE_ALL_DISABLED" "RESULTS panel=200 wizard=SKIPPED sqlite=SKIPPED"
assert_not_contains "a skipped check never reports an HTTP code" "$GATE_ALL_DISABLED" "wizard test: SKIPPED -> HTTP"

GATE_PANEL_FAIL="$(run_url_gate "https://panel.example.com" "" "" "503" || true)"
assert_contains "a failing panel URL fails the release" "$GATE_PANEL_FAIL" "panel URL check failed"
assert_contains "a failing panel URL reports the count" "$GATE_PANEL_FAIL" "public URL check(s) did not return HTTP 200"
assert_not_contains "a failing panel URL never reaches the results line" "$GATE_PANEL_FAIL" "RESULTS panel="

GATE_CONFIGURED_OK="$(run_url_gate "https://panel.example.com" "https://wizard-test.apps.example.com" "https://sqlite-test.apps.example.com" "200" || true)"
assert_contains "configured app URLs are checked" "$GATE_CONFIGURED_OK" "wizard test (configured, mandatory)"
assert_contains "configured sqlite URL is checked" "$GATE_CONFIGURED_OK" "sqlite test (configured, mandatory)"
assert_contains "all-200 configured URLs pass" "$GATE_CONFIGURED_OK" "RESULTS panel=200 wizard=200 sqlite=200"

GATE_CONFIGURED_FAIL="$(run_url_gate "https://panel.example.com" "https://wizard-test.apps.example.com" "" "404" || true)"
assert_contains "a configured app URL returning 404 fails the release" "$GATE_CONFIGURED_FAIL" "configured wizard test URL check failed"
assert_not_contains "a configured failing URL never reaches the results line" "$GATE_CONFIGURED_FAIL" "RESULTS panel="

# A network failure on a CONFIGURED url must fail, never silently skip.
GATE_NETWORK_FAIL="$(run_url_gate "https://panel.example.com" "https://wizard-test.apps.example.com" "" "000" || true)"
assert_contains "a configured URL with no response fails the release" "$GATE_NETWORK_FAIL" "configured wizard test URL check failed"
assert_contains "the network failure is reported as HTTP 000, not skipped" "$GATE_NETWORK_FAIL" "HTTP 000"
assert_not_contains "a network failure is never reported as SKIPPED" "$GATE_NETWORK_FAIL" "wizard test: SKIPPED"

echo
echo "=== Rollback naming tolerates bootstrap previous versions ==="
NAME_FRAGMENT_FILE="$TMP_ROOT/name-fragment.sh"
sed -n "/^container_name_fragment()/,/^}/p" "$REMOTE_SH" > "$NAME_FRAGMENT_FILE"
# shellcheck source=/dev/null
source "$NAME_FRAGMENT_FILE"
assert_eq "a bootstrap-unknown previous version is preserved verbatim" "bootstrap-unknown" \
  "$(container_name_fragment "bootstrap-unknown")"
assert_eq "a bootstrap-local previous version is preserved verbatim" "bootstrap-local-da486e2b7645" \
  "$(container_name_fragment "bootstrap-local-da486e2b7645")"
assert_eq "a semver previous version is preserved verbatim" "1.2.3" \
  "$(container_name_fragment "1.2.3")"
assert_eq "an empty previous version becomes an explicit placeholder" "unknown-version" \
  "$(container_name_fragment "")"
assert_eq "illegal container-name characters are replaced" "weird-tag-x" \
  "$(container_name_fragment "weird:tag/x")"
for previous in "bootstrap-unknown" "bootstrap-local-da486e2b7645" "1.2.3" ""; do
  ROLLBACK_NAME="deployment-platform-api-rollback-$(container_name_fragment "$previous")-20260727T140000Z"
  DOCKER_NAME_OK="no"
  case "$ROLLBACK_NAME" in
    [a-zA-Z0-9]*) DOCKER_NAME_OK="yes" ;;
  esac
  case "$ROLLBACK_NAME" in
    *[!a-zA-Z0-9_.-]*) DOCKER_NAME_OK="no" ;;
  esac
  assert_eq "rollback name for previous='${previous:-<empty>}' is a legal Docker name" "yes" "$DOCKER_NAME_OK"
done
assert_failure "release-remote.sh never semver-validates a previous version" \
  bash -c "grep -q 'is_valid_semver \"\${PREVIOUS' '$REMOTE_SH'"

echo
echo "=== release.sh --plan-only never contacts a real host ==="
# release.sh must run inside a real Git repository, so these tests run
# against THIS repository with a temporary release.config fixture that
# points at an unroutable test host, plus a fake `ssh` on PATH. A fake
# `scp` and `rsync` are also installed: if either is ever invoked it
# records the fact and returns nonzero, so "never contacted the VPS" is
# asserted rather than assumed. The real release.config is created only
# if absent and is always restored afterwards.
FAKE_BIN="$TMP_ROOT/fakebin"
mkdir -p "$FAKE_BIN"
SSH_CALL_LOG="$TMP_ROOT/ssh-calls.log"
: > "$SSH_CALL_LOG"
export SSH_CALL_LOG

cat > "$FAKE_BIN/ssh" <<'FAKESSH'
#!/usr/bin/env bash
# release.sh now invokes ssh as `ssh <opts> user@host bash -s` and sends
# the actual command over STDIN, so this fake reads the command from
# stdin rather than from its own argv. That is the transport contract
# under test: ssh's argv carries nothing but "bash -s".
remote_command="$(cat)"
{
  printf 'ssh argv: %s\n' "$*"
  printf 'ssh stdin: %s\n' "$remote_command"
} >> "$SSH_CALL_LOG"
case "$remote_command" in
  (*Config.Image*)
    case "$remote_command" in
      (*deployment-platform-api*)
        printf 'deployment-platform-api:%s\n' "${FAKE_API_TAG:-bootstrap-local-da486e2b7645}"
        exit 0
        ;;
      (*deployment-platform-web*)
        printf 'deployment-platform-web:%s\n' "${FAKE_WEB_TAG:-bootstrap-local-da486e2b7645}"
        exit 0
        ;;
    esac
    ;;
esac
exit 0
FAKESSH
chmod +x "$FAKE_BIN/ssh"
for forbidden in scp rsync; do
  cat > "$FAKE_BIN/$forbidden" <<FORBID
#!/usr/bin/env bash
printf 'FORBIDDEN_TOOL_INVOKED %s %s\n' "$forbidden" "\$*" >> "\$SSH_CALL_LOG"
exit 90
FORBID
  chmod +x "$FAKE_BIN/$forbidden"
done

: > "$TMP_ROOT/fake-key"
chmod 600 "$TMP_ROOT/fake-key"

REAL_CONFIG="$PROJECT_DIR/release.config"
CONFIG_BACKUP="$TMP_ROOT/release.config.pre-existing"
CONFIG_EXISTED="no"
if [ -f "$REAL_CONFIG" ]; then
  CONFIG_EXISTED="yes"
  cp "$REAL_CONFIG" "$CONFIG_BACKUP"
fi
restore_release_config() {
  if [ "$CONFIG_EXISTED" = "yes" ]; then
    cp "$CONFIG_BACKUP" "$REAL_CONFIG"
  else
    rm -f "$REAL_CONFIG"
  fi
}
trap 'restore_release_config; rm -rf "$TMP_ROOT"' EXIT

write_release_config() {
  # $1 = wizard url, $2 = sqlite url
  cat > "$REAL_CONFIG" <<CFGEOF
LOCAL_PROJECT_DIR=$PROJECT_DIR
VPS_HOST=203.0.113.10
VPS_USER=releasetest
SSH_KEY=$TMP_ROOT/fake-key
VPS_SOURCE_DIR=/opt/deployment-platform/source
AUTH_FILE=/opt/deployment-platform/config/auth.env
CADDY_ROUTES_DIR=/opt/deployment-platform/caddy/routes
API_CONTAINER=deployment-platform-api
WEB_CONTAINER=deployment-platform-web
API_IMAGE_REPOSITORY=deployment-platform-api
WEB_IMAGE_REPOSITORY=deployment-platform-web
PLATFORM_NETWORK=deployment-platform
MANAGED_APPS_NETWORK=deployment-apps
API_DATA_VOLUME=deployment-platform-api-data
PUBLIC_URL_PANEL=https://panel.devminted.com
PUBLIC_URL_WIZARD_TEST=$1
PUBLIC_URL_SQLITE_TEST=$2
CFGEOF
}

count_forbidden_calls() {
  local hits
  hits="$(grep -c 'FORBIDDEN_TOOL_INVOKED' "$SSH_CALL_LOG" 2>/dev/null || true)"
  case "$hits" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$hits" ;;
  esac
}

run_plan_only() {
  # $1 = wizard url, $2 = sqlite url, rest = extra release.sh args
  local wizard="$1" sqlite="$2"
  shift 2
  write_release_config "$wizard" "$sqlite"
  : > "$SSH_CALL_LOG"
  (
    cd "$PROJECT_DIR"
    PATH="$FAKE_BIN:$REAL_PATH"
    export SSH_CALL_LOG
    export FAKE_API_TAG="${FAKE_API_TAG:-bootstrap-local-da486e2b7645}"
    export FAKE_WEB_TAG="${FAKE_WEB_TAG:-bootstrap-local-da486e2b7645}"
    bash ./release.sh --plan-only "$@"
  ) 2>&1 || true
}

# The version-proposal previews below only render when the API is part of
# the release. Rather than depending on whatever the working tree happens
# to contain, this stages a throwaway API-scoped marker file for the
# duration of these tests and removes it immediately afterwards. Without
# it, a tree containing only installer changes would silently skip every
# version assertion.
API_SCOPE_MARKER="$PROJECT_DIR/apps/api/.release-scope-test-marker"
INSTALLER_SCOPE_MARKER="$PROJECT_DIR/installer/.release-scope-test-marker"
cleanup_api_scope_marker() { rm -f "$API_SCOPE_MARKER"; }
cleanup_installer_scope_marker() { rm -f "$INSTALLER_SCOPE_MARKER"; }
trap 'cleanup_api_scope_marker; cleanup_installer_scope_marker; restore_release_config; rm -rf "$TMP_ROOT"' EXIT
printf 'release-scope test marker; safe to delete\n' > "$API_SCOPE_MARKER"

PLAN_DISABLED="$(run_plan_only "" "")"
assert_contains "--plan-only reports the panel URL as mandatory" "$PLAN_DISABLED" "Panel (mandatory):      https://panel.devminted.com"
assert_contains "--plan-only reports a disabled wizard check" "$PLAN_DISABLED" "Wizard test:            skipped (not configured)"
assert_contains "--plan-only reports a disabled sqlite check" "$PLAN_DISABLED" "SQLite test:            skipped (not configured)"
assert_not_contains "--plan-only prints no hookstats.com label" "$PLAN_DISABLED" "hookstats.com"
assert_contains "--plan-only states it performed no deploy" "$PLAN_DISABLED" "no build, tests, staging, commit, sync, or deploy performed"
assert_eq "--plan-only never invokes scp or rsync" "0" "$(count_forbidden_calls)"

PLAN_ENABLED="$(run_plan_only "https://wizard-test.apps.devminted.com" "https://sqlite-test.apps.devminted.com")"
assert_contains "--plan-only shows a configured wizard URL as enabled" "$PLAN_ENABLED" "Wizard test (enabled):  https://wizard-test.apps.devminted.com"
assert_contains "--plan-only shows a configured sqlite URL as enabled" "$PLAN_ENABLED" "SQLite test (enabled):  https://sqlite-test.apps.devminted.com"
assert_contains "--plan-only says configured URLs must return 200" "$PLAN_ENABLED" "must return HTTP 200"
assert_eq "--plan-only with configured URLs still never invokes scp or rsync" "0" "$(count_forbidden_calls)"

echo
echo "=== Live bootstrap transition, end to end through release.sh ==="
# The fake ssh reports exactly the tags currently running on the
# temporary VPS, so this exercises the real live scenario.
PLAN_BOOTSTRAP="$(FAKE_API_TAG=bootstrap-local-da486e2b7645 FAKE_WEB_TAG=bootstrap-local-da486e2b7645 run_plan_only "" "")"
assert_contains "the running bootstrap API image is reported" "$PLAN_BOOTSTRAP" "deployment-platform-api:bootstrap-local-da486e2b7645"
assert_contains "a changed API on a bootstrap tag is offered the initial version" "$PLAN_BOOTSTRAP" "Proposed API version: 0.1.0"
assert_contains "the bootstrap transition is announced to the operator" "$PLAN_BOOTSTRAP" "First release for the API off installer bootstrap tag"
assert_not_contains "no mangled bootstrap version is ever proposed" "$PLAN_BOOTSTRAP" "bootstrap-local-da486e2b7645..1"
assert_not_contains "no bootstrap tag is proposed as a release version" "$PLAN_BOOTSTRAP" "Proposed API version: bootstrap"

PLAN_UNKNOWN_TAG="$(FAKE_API_TAG=bootstrap-unknown FAKE_WEB_TAG=bootstrap-unknown run_plan_only "" "")"
assert_contains "a bootstrap-unknown API is offered the initial version" "$PLAN_UNKNOWN_TAG" "Proposed API version: 0.1.0"
assert_not_contains "bootstrap-unknown is never proposed as a version" "$PLAN_UNKNOWN_TAG" "Proposed API version: bootstrap-unknown"

PLAN_SEMVER="$(FAKE_API_TAG=1.4.2 FAKE_WEB_TAG=1.4.2 run_plan_only "" "")"
assert_contains "an existing semver API patch-bumps" "$PLAN_SEMVER" "Proposed API version: 1.4.3"
assert_not_contains "a semver transition is not announced as a bootstrap transition" "$PLAN_SEMVER" "off installer bootstrap tag"

PLAN_WEIRD="$(FAKE_API_TAG=latest FAKE_WEB_TAG=latest run_plan_only "" "")"
assert_contains "an unrecognized tag is flagged as blocking" "$PLAN_WEIRD" "A real release would STOP here"
assert_contains "the unrecognized-tag warning names the override flag" "$PLAN_WEIRD" "--api-version"

PLAN_OVERRIDE="$(FAKE_API_TAG=latest FAKE_WEB_TAG=latest run_plan_only "" "" --api-version 2.0.0 --web-version 2.0.0)"
assert_contains "an explicit override is honored over an unrecognized tag" "$PLAN_OVERRIDE" "Proposed API version: 2.0.0"
assert_not_contains "an honored override produces no blocking warning" "$PLAN_OVERRIDE" "A real release would STOP here"

PLAN_OVERRIDE_BOOTSTRAP="$(FAKE_API_TAG=bootstrap-unknown run_plan_only "" "" --api-version 3.1.4)"
assert_contains "an explicit override beats the bootstrap initial version" "$PLAN_OVERRIDE_BOOTSTRAP" "Proposed API version: 3.1.4"

assert_failure "an invalid override is rejected before anything runs" \
  bash -c "cd '$PROJECT_DIR' && PATH='$FAKE_BIN:$REAL_PATH' bash ./release.sh --plan-only --api-version not-a-version"

# The plan must always report the Caddy scope, whatever the tree holds.
cleanup_api_scope_marker
PLAN_CADDY_SCOPE="$(run_plan_only "" "")"
assert_contains "the plan reports the Caddy configuration scope" "$PLAN_CADDY_SCOPE" "Caddy configuration changed:"

# An installer-only change must reach the VPS, not be committed locally
# and forgotten — that is how the server kept running the install-day
# copy of `deployment-platform verify`. A throwaway marker under
# installer/ makes this deterministic regardless of the working tree.
printf 'release-scope test marker; safe to delete\n' > "$INSTALLER_SCOPE_MARKER"
PLAN_INSTALLER_SCOPE="$(run_plan_only "" "")"
cleanup_installer_scope_marker
assert_contains "the plan reports the installer scope" "$PLAN_INSTALLER_SCOPE" "Installer changed: yes"
assert_contains "an installer-only change is not documentation/script-only" "$PLAN_INSTALLER_SCOPE" "docs/script-only: no"
assert_contains "the plan says it would refresh the installed installer copy" "$PLAN_INSTALLER_SCOPE" \
  "Refresh /opt/deployment-platform/installer and /usr/local/bin/deployment-platform"
assert_not_contains "an installer-only change is not announced as local-only" "$PLAN_INSTALLER_SCOPE" \
  "committed locally only"

echo "=== release-remote.sh argument validation with optional URLs ==="
# Direct argument-validation regression: the first release after an
# install passes neither --url-wizard-test nor --url-sqlite-test. The
# script must get PAST validation. It still fails later here for
# unrelated reasons (no Docker, no source dir), which is expected.
REMOTE_NO_OPTIONAL_URLS="$(
  bash "$REMOTE_SH" \
    --mode api \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --api-version 0.1.0 \
    --web-version 0.1.0 \
    --previous-api-version bootstrap-local-da486e2b7645 \
    --previous-web-version bootstrap-local-da486e2b7645 \
    --url-panel https://panel.devminted.com \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_not_contains "no 'missing required --url-wizard-test' error" "$REMOTE_NO_OPTIONAL_URLS" "missing required --url-wizard-test"
assert_not_contains "no 'missing required --url-sqlite-test' error" "$REMOTE_NO_OPTIONAL_URLS" "missing required --url-sqlite-test"
assert_not_contains "a bootstrap previous version is never rejected" "$REMOTE_NO_OPTIONAL_URLS" "previous-api-version invalid"

REMOTE_NO_PANEL="$(
  bash "$REMOTE_SH" \
    --mode api \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --api-version 0.1.0 \
    --web-version 0.1.0 \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_contains "the panel URL is still mandatory" "$REMOTE_NO_PANEL" "missing required --url-panel"

REMOTE_BAD_VERSION="$(
  bash "$REMOTE_SH" \
    --mode api \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --api-version bootstrap-unknown \
    --web-version 0.1.0 \
    --url-panel https://panel.devminted.com \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_contains "a bootstrap tag sent as --api-version is still rejected" "$REMOTE_BAD_VERSION" "--api-version invalid"

# An UNCHANGED component may legitimately still carry a bootstrap tag:
# in api-only mode the web version is never validated.
REMOTE_UNCHANGED_WEB="$(
  bash "$REMOTE_SH" \
    --mode api \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --api-version 0.1.0 \
    --web-version bootstrap-local-da486e2b7645 \
    --url-panel https://panel.devminted.com \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_not_contains "an unchanged component's bootstrap tag is not validated in api-only mode" \
  "$REMOTE_UNCHANGED_WEB" "--web-version invalid"


echo "=== Remote argv integrity (fake ssh + real remote bash fixture) ==="
# ssh does not transport an argv array: it joins its command arguments
# into ONE string for the remote LOGIN shell to re-parse. These tests
# prove release.sh's transport survives that, by routing the real
# ssh_run/ssh_quiet through a fake ssh that models the join faithfully
# and then hands the result to DASH — so a regression that depends on
# the login shell being bash fails here rather than in production.

ARGV_DIR="$TMP_ROOT/argv"
mkdir -p "$ARGV_DIR"

# Models real ssh: strips its own options, joins the remaining command
# arguments with spaces, and executes that string with the LOGIN shell
# (deliberately dash), with our stdin passed straight through.
cat > "$ARGV_DIR/ssh" <<'FAKESSH'
#!/usr/bin/env bash
args=(); seen_host=0; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$seen_host" = 1 ]; then args+=("$a"); continue; fi
  case "$a" in
    (-i|-o) skip=1; continue ;;
    (-*) continue ;;
    (*@*) seen_host=1 ;;
  esac
done
printf '%s\n' "${args[*]}" >> "$SSH_JOINED_LOG"
exec /bin/dash -c "${args[*]}"
FAKESSH
chmod +x "$ARGV_DIR/ssh"

# The controlled "remote" program: reports the argv it actually received.
cat > "$ARGV_DIR/recorder" <<'RECORDER'
#!/usr/bin/env bash
printf 'ARGC=%d\n' "$#"
i=0
for a in "$@"; do
  i=$((i + 1))
  printf 'ARG%d=[%s]\n' "$i" "$a"
done
RECORDER
chmod +x "$ARGV_DIR/recorder"

# Exits with whatever status it is told, to prove status propagation.
cat > "$ARGV_DIR/exiter" <<'EXITER'
#!/usr/bin/env bash
echo "exiter stdout"
echo "exiter stderr" >&2
exit "$1"
EXITER
chmod +x "$ARGV_DIR/exiter"

export SSH_JOINED_LOG="$ARGV_DIR/joined.log"
: > "$SSH_JOINED_LOG"

# The real multiline template from release.sh's plan-only preview. Its
# "nano cpus:" line is what previously became a separate remote command
# and launched the nano editor.
ARGV_TEMPLATE='  restart policy: {{.HostConfig.RestartPolicy.Name}}
  entrypoint: {{json .Config.Entrypoint}}
  cmd: {{json .Config.Cmd}}
  memory: {{.HostConfig.Memory}}
  nano cpus: {{.HostConfig.NanoCpus}}
  mounts: {{range .Mounts}}{{.Destination}} {{end}}
  networks: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'

run_argv_case() {
  (
    SSH_KEY=/dev/null
    VPS_USER=root
    VPS_HOST=argv.test.invalid
    PATH="$ARGV_DIR:$REAL_PATH"
    export SSH_JOINED_LOG
    ssh_run "$@"
  ) 2>/dev/null
}

# --- ordinary arguments ---
ARGV_PLAIN="$(run_argv_case "$ARGV_DIR/recorder" inspect --format '{{.Config.Image}}' deployment-platform-api)"
assert_contains "ordinary arguments arrive with the right count" "$ARGV_PLAIN" "ARGC=4"
assert_contains "a simple Go template arrives intact" "$ARGV_PLAIN" "ARG3=[{{.Config.Image}}]"
assert_contains "the container name arrives intact" "$ARGV_PLAIN" "ARG4=[deployment-platform-api]"

# --- an argument containing spaces ---
ARGV_SPACES="$(run_argv_case "$ARGV_DIR/recorder" "one two  three")"
assert_contains "an argument with spaces stays a single argument" "$ARGV_SPACES" "ARGC=1"
assert_contains "internal spacing is preserved exactly" "$ARGV_SPACES" "ARG1=[one two  three]"

# --- the real multiline docker inspect template ---
ARGV_TMPL="$(run_argv_case "$ARGV_DIR/recorder" inspect --format "$ARGV_TEMPLATE" deployment-platform-api)"
assert_contains "the multiline template stays ONE argument" "$ARGV_TMPL" "ARGC=4"
assert_contains "the template keeps its first line" "$ARGV_TMPL" "ARG3=[  restart policy: {{.HostConfig.RestartPolicy.Name}}"
assert_contains "the template keeps its embedded newlines" "$ARGV_TMPL" "  nano cpus: {{.HostConfig.NanoCpus}}"
assert_contains "the template keeps its range/pipeline syntax" "$ARGV_TMPL" "{{range .Mounts}}{{.Destination}} {{end}}"
assert_contains "the container name still follows the template" "$ARGV_TMPL" "ARG4=[deployment-platform-api]"
# The exact regression: "nano cpus:" must be DATA, never a remote command.
assert_not_contains "the nano editor is never launched" "$ARGV_TMPL" "[ New File ]"
assert_not_contains "no template line becomes a 'command not found'" "$ARGV_TMPL" "not found"

# --- an empty argument ---
ARGV_EMPTY="$(run_argv_case "$ARGV_DIR/recorder" alpha "" omega)"
assert_contains "an empty argument is preserved, not dropped" "$ARGV_EMPTY" "ARGC=3"
assert_contains "the empty argument is empty" "$ARGV_EMPTY" "ARG2=[]"
assert_contains "arguments after the empty one keep their position" "$ARGV_EMPTY" "ARG3=[omega]"

# --- shell metacharacters must remain data ---
ARGV_META="$(run_argv_case "$ARGV_DIR/recorder" \
  "sin'gle" 'dou"ble' '$dollar' '${brace}' 'semi;colon' 'pipe|char' 'amp&&and' '`backtick`' '$(subshell)' '*glob*' 'new
line' 'tab	sep')"
assert_contains "all metacharacter arguments arrive" "$ARGV_META" "ARGC=12"
assert_contains "a single quote is data" "$ARGV_META" "ARG1=[sin'gle]"
assert_contains "a double quote is data" "$ARGV_META" 'ARG2=[dou"ble]'
assert_contains "a dollar sign is not expanded" "$ARGV_META" 'ARG3=[$dollar]'
assert_contains "a brace expansion is not expanded" "$ARGV_META" 'ARG4=[${brace}]'
assert_contains "a semicolon is data" "$ARGV_META" "ARG5=[semi;colon]"
assert_contains "a pipe is data" "$ARGV_META" "ARG6=[pipe|char]"
assert_contains "an ampersand pair is data" "$ARGV_META" "ARG7=[amp&&and]"
assert_contains "a backtick is not executed" "$ARGV_META" 'ARG8=[`backtick`]'
assert_contains "a command substitution is not executed" "$ARGV_META" 'ARG9=[$(subshell)]'
assert_contains "a glob is not expanded" "$ARGV_META" "ARG10=[*glob*]"
assert_contains "an embedded newline is preserved" "$ARGV_META" "ARG11=[new"
assert_contains "an embedded tab is preserved" "$ARGV_META" "ARG12=[tab	sep]"

# --- no accidental execution of injected syntax ---
ARGV_INJECT_MARKER="$ARGV_DIR/injection-marker"
rm -f "$ARGV_INJECT_MARKER"
ARGV_INJECT="$(run_argv_case "$ARGV_DIR/recorder" "harmless; touch $ARGV_INJECT_MARKER" '$(touch '"$ARGV_INJECT_MARKER"')')"
assert_eq "injected shell syntax is never executed remotely" "absent" \
  "$([ -e "$ARGV_INJECT_MARKER" ] && echo present || echo absent)"
assert_contains "the injection attempt arrives as literal data" "$ARGV_INJECT" "ARG1=[harmless; touch"

# --- the transport does not depend on the remote login shell ---
# The fake ssh executes the joined string with dash. The command text
# therefore has to reach an explicitly named bash.
ARGV_JOINED="$(cat "$SSH_JOINED_LOG")"
assert_contains "ssh receives only a trivial 'bash -s' command line" "$ARGV_JOINED" "bash -s"
assert_not_contains "the template never appears in ssh's own argv" "$ARGV_JOINED" "nano cpus"
assert_contains "release.sh invokes bash explicitly on the remote" "$(cat "$RELEASE_SH")" 'bash -s'
assert_failure "ssh_run no longer passes the argv array straight to ssh" \
  bash -c "grep -q 'VPS_HOST}\" \"\\\$@\"' '$RELEASE_SH'"

# --- ssh_quiet: exit status and output suppression ---
run_quiet_case() {
  (
    SSH_KEY=/dev/null
    VPS_USER=root
    VPS_HOST=argv.test.invalid
    PATH="$ARGV_DIR:$REAL_PATH"
    export SSH_JOINED_LOG
    ssh_quiet "$ARGV_DIR/exiter" "$1"
  )
}
for expected_status in 0 1 7 42; do
  QUIET_STATUS=0
  QUIET_OUTPUT="$(run_quiet_case "$expected_status" 2>&1)" || QUIET_STATUS=$?
  assert_eq "ssh_quiet propagates remote exit status $expected_status" "$expected_status" "$QUIET_STATUS"
  assert_eq "ssh_quiet suppresses all output for status $expected_status" "" "$QUIET_OUTPUT"
done
assert_contains "ssh_quiet still sets BatchMode=yes" "$(cat "$RELEASE_SH")" "BatchMode=yes"
assert_contains "ssh_quiet still sets ConnectTimeout=10" "$(cat "$RELEASE_SH")" "ConnectTimeout=10"

# --- ssh_run propagates exit status too ---
for expected_status in 0 3 9; do
  RUN_STATUS=0
  (
    SSH_KEY=/dev/null
    VPS_USER=root
    VPS_HOST=argv.test.invalid
    PATH="$ARGV_DIR:$REAL_PATH"
    export SSH_JOINED_LOG
    ssh_run "$ARGV_DIR/exiter" "$expected_status"
  ) >/dev/null 2>&1 || RUN_STATUS=$?
  assert_eq "ssh_run propagates remote exit status $expected_status" "$expected_status" "$RUN_STATUS"
done

# --- build_remote_command quoting is reversible by bash ---
assert_eq "an empty argument is quoted, not omitted" "'' " "$(build_remote_command "")"
ROUNDTRIP="$(build_remote_command "a b" "c'd")"
assert_contains "quoting escapes an embedded single quote" "$ROUNDTRIP" "c\\'d"

# --- SSH_KEY whitespace guard (rsync -e is split on spaces) ---
assert_failure "an SSH_KEY containing whitespace is rejected up front" \
  bash -c "source '$HELPERS_FILE'; SSH_KEY='/tmp/my key'; validate_ssh_key_path"
assert_success "an ordinary SSH_KEY path is accepted" \
  bash -c "source '$HELPERS_FILE'; SSH_KEY='/Users/x/.ssh/id_ed25519'; validate_ssh_key_path"


echo "=== Caddy configuration deployment scope ==="
# A Caddy routing change touches neither apps/api nor apps/web, so the
# old scope logic classified it as documentation/script-only, committed
# it locally, and never contacted the VPS. That is how a broken /api
# prefix stayed live. These assertions pin the corrected contract.
assert_success "release.sh classifies the Caddy template as config" \
  bash -c "source '$HELPERS_FILE'; is_caddy_config_path installer/templates/Caddyfile.template"
assert_success "release.sh classifies the Caddy library as config" \
  bash -c "source '$HELPERS_FILE'; is_caddy_config_path installer/lib/caddy.sh"
assert_failure "an unrelated installer file is not a Caddy config change" \
  bash -c "source '$HELPERS_FILE'; is_caddy_config_path installer/lib/packages.sh"
assert_failure "an API source file is not a Caddy config change" \
  bash -c "source '$HELPERS_FILE'; is_caddy_config_path apps/api/src/server.ts"
assert_failure "a doc is not a Caddy config change" \
  bash -c "source '$HELPERS_FILE'; is_caddy_config_path docs/RELEASE_AUTOMATION.md"

RELEASE_TEXT="$(cat "$RELEASE_SH")"
assert_contains "a Caddy config change is excluded from the local-only path" "$RELEASE_TEXT" \
  '[ "${CADDY_CONFIG_CHANGED}" = "no" ]'
assert_contains "a Caddy-only change selects the config-only deploy mode" "$RELEASE_TEXT" 'DEPLOY_MODE="caddy"'
assert_contains "the deploy passes the caddy config flag" "$RELEASE_TEXT" "--deploy-caddy-config"
assert_contains "the deploy passes the panel domain" "$RELEASE_TEXT" "--panel-domain"
assert_contains "the deploy passes the caddy container" "$RELEASE_TEXT" "--caddy-container"
assert_contains "the deploy passes the live Caddyfile path" "$RELEASE_TEXT" "--caddy-config-file"
assert_contains "change detection reports the Caddy scope" "$RELEASE_TEXT" "Caddy configuration changed:"

REMOTE_TEXT="$(cat "$REMOTE_SH")"
assert_contains "the remote script accepts the caddy mode" "$REMOTE_TEXT" "api, web, both, caddy"
assert_contains "the remote validates the candidate before touching the live file" "$REMOTE_TEXT" "caddy validate --adapter caddyfile --config -"
assert_contains "the remote backs up the previous Caddyfile" "$REMOTE_TEXT" "CADDY_CONFIG_BACKUP"
assert_contains "the remote reloads Caddy rather than replacing the container" "$REMOTE_TEXT" "caddy reload --config /etc/caddy/Caddyfile"
assert_contains "a failed reload restores the previous configuration" "$REMOTE_TEXT" "restore_caddy_config_on_failure"

# `caddy reload` speaks to the admin API, and the platform's generated
# Caddyfile sets `admin off` — so reload can never succeed and a
# reload-only deploy stage fails 100% of the time. The restart fallback
# is the actual mechanism, exactly as installer/lib/caddy.sh already does.
assert_contains "applying a config change has a single entry point" "$REMOTE_TEXT" "apply_caddy_config()"
assert_contains "a failed reload falls back to restarting Caddy" "$REMOTE_TEXT" 'docker restart "${CADDY_CONTAINER}"'
assert_contains "the fallback explains why reload cannot work here" "$REMOTE_TEXT" "admin API is disabled"
assert_contains "the restart is confirmed to have left Caddy running" "$REMOTE_TEXT" "did not stay running after the restart"
assert_contains "the restore path uses the same apply mechanism" "$REMOTE_TEXT" "apply_caddy_config; then"
# Exactly one reload call must exist: the one inside apply_caddy_config.
assert_eq "only one caddy reload call remains in the remote script" "1" \
  "$(grep -c 'caddy reload --config' "$REMOTE_SH")"
CADDY_TEMPLATE_SRC="$(cat "$PROJECT_DIR/installer/templates/Caddyfile.template")"
assert_contains "the template documents that admin off forbids reload" "$CADDY_TEMPLATE_SRC" "can NEVER succeed here"
assert_contains "the installer applies config changes by restarting too" \
  "$(cat "$PROJECT_DIR/installer/lib/caddy.sh")" 'docker restart "$CADDY_CONTAINER_NAME"'
assert_contains "config rollback is wired into the automatic rollback path" "$REMOTE_TEXT" "restore_caddy_config_on_failure"
assert_contains "the rendered candidate is checked for leftover placeholders" "$REMOTE_TEXT" "unreplaced template placeholders"
assert_contains "an identical config is a no-op" "$REMOTE_TEXT" "already identical to the live file"
assert_contains "caddy mode requires the panel domain" "$REMOTE_TEXT" "--deploy-caddy-config requires --"

# Config-only mode must build and swap nothing.
assert_failure "caddy mode is not treated as an image-building mode" \
  bash -c "grep -qE '\\\[ \"\\\$\\{MODE\\}\" = \"caddy\" \\\] \\|\\| \\\[ \"\\\$\\{MODE\\}\" = \"both\" \\\]' '$REMOTE_SH'"

# Argument validation: caddy mode needs no semantic version at all.
REMOTE_CADDY_ARGS="$(
  bash "$REMOTE_SH" \
    --mode caddy \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --url-panel https://panel.example.com \
    --deploy-caddy-config \
    --panel-domain panel.example.com \
    --caddy-container deployment-platform-caddy \
    --caddy-config-file /nonexistent/Caddyfile \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_not_contains "caddy mode does not demand an api version" "$REMOTE_CADDY_ARGS" "--api-version invalid"
assert_not_contains "caddy mode does not demand a web version" "$REMOTE_CADDY_ARGS" "--web-version invalid"
assert_not_contains "caddy mode is an accepted mode" "$REMOTE_CADDY_ARGS" "--mode must be one of"

REMOTE_CADDY_MISSING="$(
  bash "$REMOTE_SH" \
    --mode caddy \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --url-panel https://panel.example.com \
    --deploy-caddy-config \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_contains "a Caddy config deploy without a panel domain is rejected" "$REMOTE_CADDY_MISSING" "requires --panel-domain"

echo
echo "=== Installer refresh deployment scope ==="
# /opt/deployment-platform/installer and /usr/local/bin/deployment-platform
# are install-time COPIES. Nothing refreshed them, so a corrected
# `deployment-platform verify` or a new maintenance command could be
# committed, tested, and released while the server kept running the
# install-day version.
assert_contains "an installer change is no longer classified local-only" "$RELEASE_TEXT" \
  '[ "${INSTALLER_CHANGED}" = "no" ]; then'
assert_contains "release.sh passes the installer refresh flag" "$RELEASE_TEXT" "--deploy-installer"
# Staleness of the server-side copy is a property of the SERVER, not of
# the current diff, so the refresh must not be conditional on it.
assert_not_contains "the refresh is not gated on the diff touching installer/" "$RELEASE_TEXT" \
  '  if [ "${INSTALLER_CHANGED}" = "yes" ]; then
    remote_args+=('
assert_contains "an explicit config-only deploy flag exists" "$RELEASE_TEXT" "--deploy-config)"
assert_contains "--deploy-config forces the configuration scope" "$RELEASE_TEXT" \
  "the configuration stages will run regardless of the computed diff scope"
assert_contains "--deploy-config works on a clean tree" "$RELEASE_TEXT" "SKIP_COMMIT=1"
# An empty candidate list is legitimate under --deploy-config, and an
# unguarded array expansion under `set -u` aborted the run at that point.
assert_contains "an empty candidate list is handled" "$RELEASE_TEXT" \
  'if [ "${#CANDIDATE_FILES[@]}" -eq 0 ]; then'
CLEAN_TREE_CONFIG_PLAN="$(
  cd "$PROJECT_DIR" && PATH="$FAKE_BIN:$REAL_PATH" \
    bash ./release.sh --plan-only --deploy-config 2>&1 || true
)"
assert_not_contains "--deploy-config on a clean tree does not hit an unbound variable" \
  "$CLEAN_TREE_CONFIG_PLAN" "unbound variable"
assert_contains "release.sh passes the install root" "$RELEASE_TEXT" "--install-root"
assert_contains "INSTALL_ROOT is a configurable key" "$RELEASE_TEXT" "INSTALL_ROOT) INSTALL_ROOT="
assert_contains "the example config documents INSTALL_ROOT" \
  "$(cat "$PROJECT_DIR/release.config.example")" "INSTALL_ROOT=/opt/deployment-platform"
assert_contains "the example config documents CADDY_CONTAINER" \
  "$(cat "$PROJECT_DIR/release.config.example")" "CADDY_CONTAINER=deployment-platform-caddy"

assert_contains "the remote script accepts the installer refresh flag" "$REMOTE_TEXT" "--deploy-installer) DEPLOY_INSTALLER=1"
assert_contains "the refresh mirrors the installer's own rsync" "$REMOTE_TEXT" 'rsync -a --exclude=tests'
assert_contains "the refresh stages before it swaps" "$REMOTE_TEXT" "installer.new-"
assert_contains "the staged copy is syntax-checked before going live" "$REMOTE_TEXT" "failed syntax validation"
assert_contains "the previous installer copy is kept" "$REMOTE_TEXT" "installer.backup-"
assert_contains "the CLI wrapper is refreshed too" "$REMOTE_TEXT" "/usr/local/bin/deployment-platform"
assert_contains "the CLI wrapper is backed up" "$REMOTE_TEXT" 'CLI_BACKUP="${CLI_TARGET}.backup-'
assert_contains "an identical installer copy is a no-op" "$REMOTE_TEXT" "already identical to this release"
assert_contains "installer restore is wired into the automatic rollback path" "$REMOTE_TEXT" "restore_installer_on_failure"

# The mode must not force either deploy flag on: an installer-only
# release supplies no Caddy arguments, and vice versa.
assert_contains "caddy mode requires something to actually do" "$REMOTE_TEXT" \
  "--mode caddy requires --deploy-caddy-config, --deploy-installer, or both."
assert_contains "the installer refresh requires an install root" "$REMOTE_TEXT" \
  "--deploy-installer requires --install-root"

REMOTE_INSTALLER_ONLY="$(
  bash "$REMOTE_SH" \
    --mode caddy \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --url-panel https://panel.example.com \
    --deploy-installer \
    --install-root /nonexistent/install-root \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_not_contains "an installer-only release needs no Caddy arguments" \
  "$REMOTE_INSTALLER_ONLY" "requires --panel-domain"
assert_not_contains "an installer-only release is an accepted mode" \
  "$REMOTE_INSTALLER_ONLY" "--mode must be one of"

REMOTE_NOTHING_TO_DO="$(
  bash "$REMOTE_SH" \
    --mode caddy \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --url-panel https://panel.example.com \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_contains "a config-only release with nothing to do is rejected" \
  "$REMOTE_NOTHING_TO_DO" "requires --deploy-caddy-config, --deploy-installer, or both"

REMOTE_INSTALLER_NO_ROOT="$(
  bash "$REMOTE_SH" \
    --mode caddy \
    --source-dir /nonexistent/release-dir \
    --auth-file /nonexistent/auth.env \
    --caddy-routes-dir /nonexistent/routes \
    --api-container deployment-platform-api \
    --web-container deployment-platform-web \
    --api-image-repo deployment-platform-api \
    --web-image-repo deployment-platform-web \
    --platform-network deployment-platform \
    --apps-network deployment-apps \
    --api-data-volume deployment-platform-api-data \
    --url-panel https://panel.example.com \
    --deploy-installer \
    --current-symlink /nonexistent/current 2>&1 || true
)"
assert_contains "an installer refresh without an install root is rejected" \
  "$REMOTE_INSTALLER_NO_ROOT" "requires --install-root"


echo "=== Secrets never appear in release output ==="
for secret_token in ADMIN_PASSWORD_HASH SESSION_SECRET CREDENTIAL_ENCRYPTION_KEY GITHUB_TOKEN; do
  assert_not_contains "--plan-only output contains no ${secret_token}" "$PLAN_DISABLED" "$secret_token"
  assert_not_contains "bootstrap plan output contains no ${secret_token}" "$PLAN_BOOTSTRAP" "$secret_token"
done
assert_not_contains "the SSH key path is never echoed with its contents" "$PLAN_DISABLED" "BEGIN OPENSSH"
assert_not_contains "no SSH key material is echoed" "$PLAN_DISABLED" "PRIVATE KEY"
assert_contains "release.config.example still warns against putting secrets in it" \
  "$(cat "$PROJECT_DIR/release.config.example")" "must never contain secrets"

echo "=== --deploy-head: committed-HEAD release mode ==="
# Runs release.sh with arbitrary args against the fake VPS transport. The
# incompatibility guards and the clean-tree/branch gate all fire before any
# real work, so these never build, deploy, or contact a real host.
run_release_raw() {
  write_release_config "" ""
  : > "$SSH_CALL_LOG"
  (
    cd "$PROJECT_DIR"
    PATH="$FAKE_BIN:$REAL_PATH"
    export SSH_CALL_LOG
    bash ./release.sh "$@"
  ) 2>&1 || true
}

# Mode incompatibilities are rejected (these exit during argument handling,
# before config load, VPS contact, or any Git mutation).
assert_contains "--deploy-head + --resume-release is rejected" \
  "$(run_release_raw --deploy-head --resume-release /opt/deployment-platform/source/releases/release-x-y)" \
  "cannot be combined with --resume-release"
assert_contains "--deploy-head + --deploy-config is rejected" \
  "$(run_release_raw --deploy-head --deploy-config)" \
  "cannot be combined with --deploy-config"
assert_contains "--deploy-head + --no-deploy is rejected" \
  "$(run_release_raw --deploy-head --no-deploy)" \
  "cannot be combined with --no-deploy"
assert_contains "--deploy-head + --message is rejected (it never commits)" \
  "$(run_release_raw --deploy-head --message "should not be allowed")" \
  "does not create a commit"
assert_contains "--allow-branch-drift without --deploy-head is rejected" \
  "$(run_release_raw --allow-branch-drift)" \
  "only applies to --deploy-head"

# Clean-tree gate: a deliberately-untracked file makes the tree dirty
# regardless of ambient state, and --deploy-head must refuse it without
# contacting the VPS.
DEPLOY_HEAD_DIRTY_MARKER="$PROJECT_DIR/.deploy-head-dirty-marker"
printf 'throwaway dirty marker for the deploy-head clean-tree test\n' > "$DEPLOY_HEAD_DIRTY_MARKER"
DEPLOY_HEAD_DIRTY_OUT="$(run_release_raw --deploy-head --plan-only)"
DEPLOY_HEAD_DIRTY_SSH="$(cat "$SSH_CALL_LOG")"
rm -f "$DEPLOY_HEAD_DIRTY_MARKER"
assert_contains "--deploy-head refuses a dirty working tree" \
  "$DEPLOY_HEAD_DIRTY_OUT" "requires a clean working tree"
assert_not_contains "--deploy-head dirty-tree refusal never contacted the VPS" \
  "$DEPLOY_HEAD_DIRTY_SSH" "ssh stdin"

# Help + source-level guarantees for the mode's behavior.
DEPLOY_HEAD_HELP="$(cd "$PROJECT_DIR" && bash ./release.sh --help 2>&1 || true)"
assert_contains "help documents --deploy-head" "$DEPLOY_HEAD_HELP" "--deploy-head"
assert_contains "help documents --allow-branch-drift" "$DEPLOY_HEAD_HELP" "--allow-branch-drift"

RELEASE_SH_TEXT="$(cat "$RELEASE_SH")"
assert_contains "--deploy-head forces an API rebuild" "$RELEASE_SH_TEXT" 'API_CHANGED="yes"'
assert_contains "--deploy-head forces a web rebuild" "$RELEASE_SH_TEXT" 'WEB_CHANGED="yes"'
assert_contains "--deploy-head skips the commit stage (no new commit)" \
  "$RELEASE_SH_TEXT" "deploy the current committed HEAD without creating a commit"
assert_contains "--deploy-head enforces HEAD == origin/main" \
  "$RELEASE_SH_TEXT" "does not match origin/main"
assert_contains "--deploy-head has an explicit branch-drift override" \
  "$RELEASE_SH_TEXT" "branch-drift check overridden"

echo
echo "=== Syntax validation ==="
SYNTAX_FAILURES=0
for f in "$RELEASE_SH" "$REMOTE_SH" "$TESTS_DIR/run.sh"; do
  if ! bash -n "$f" 2>/dev/null; then
    SYNTAX_FAILURES=$((SYNTAX_FAILURES + 1))
    printf '[FAIL] bash -n: %s\n' "$f"
  fi
done
assert_eq "release automation scripts have valid bash syntax" "0" "$SYNTAX_FAILURES"

echo
echo "=== Results ==="
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
