#!/usr/bin/env bash
#
# secrets.sh — generates and stores the platform's secrets
# (CREDENTIAL_ENCRYPTION_KEY, SESSION_SECRET, the administrator
# password hash). This is the most security-sensitive file in the
# installer; read it carefully before changing it.
#
# Reuses this repository's existing authentication format exactly
# (generate-auth.sh: ADMIN_USERNAME / ADMIN_PASSWORD_HASH /
# SESSION_SECRET / COOKIE_SECURE, salt:hash hex via Node's scrypt) —
# this does not invent a second password-hash format. Because the host
# deliberately has no Node installed (matching the rest of this
# project's "no host Node" convention — see scripts/release-remote.sh),
# the scrypt computation runs inside the same sandboxed, pinned
# node:24-alpine helper container pattern already used there: no
# network, no added capabilities, no Docker socket, read-only root
# filesystem, the password passed via a mode-600 temp file (never
# argv, never an environment variable that could leak through `docker
# inspect`).

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "secrets.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

AUTH_FILE_PATH="${INSTALL_ROOT}/config/auth.env"
NODE_HELPER_IMAGE="node:24-alpine"

ensure_node_helper_image() {
  if docker image inspect "$NODE_HELPER_IMAGE" >/dev/null 2>&1; then
    return 0
  fi
  log_info "Pulling runtime helper image $NODE_HELPER_IMAGE (used only to compute the admin password hash; never used for anything else)."
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  # Only the image name is involved here — no password, hash, or secret
  # is passed to, or produced by, this command, so its output is safe to
  # capture and log like any other. The password itself is handled
  # separately by compute_password_hash, which is deliberately NOT
  # wrapped in progress reporting.
  local status=0
  run_with_progress --show-output-tail "Pulling helper image $NODE_HELPER_IMAGE" \
    docker pull "$NODE_HELPER_IMAGE" || status=$?
  if [ "$status" -ne 0 ]; then
    print_last_output_excerpt "Recent docker pull output:"
    fatal "Unable to pull $NODE_HELPER_IMAGE, required to generate the administrator password hash."
  fi
}

# Portable octal file mode: GNU form first (GNU stat's -f means
# "filesystem info" and can misleadingly succeed), BSD form as the
# fallback. Same pattern as the test suite's get_file_mode.
_password_file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
    return
  fi
  stat -f '%Lp' "$1" 2>/dev/null
}

# Validates an operator-supplied admin password file. Logs the specific
# reason on failure (path included — the operator chose this path, so
# naming it is help, not a leak; the CONTENTS are never printed).
admin_password_file_is_valid() {
  local f="$1"
  if [ -z "$f" ]; then
    log_fail "No administrator password file was provided."
    return 1
  fi
  if [ -d "$f" ]; then
    log_fail "Administrator password file is a directory, not a file: $f"
    return 1
  fi
  if [ ! -f "$f" ]; then
    log_fail "Administrator password file does not exist or is not a regular file: $f"
    return 1
  fi
  if [ ! -r "$f" ]; then
    log_fail "Administrator password file is not readable by the installer: $f"
    return 1
  fi
  if [ ! -s "$f" ]; then
    log_fail "Administrator password file is empty: $f"
    return 1
  fi
  local mode
  mode="$(_password_file_mode "$f")"
  case "$mode" in
    *00) : ;;
    *)
      log_fail "Administrator password file must be mode 600 or stricter (found ${mode:-unknown}): $f — fix with: chmod 600 $f"
      return 1
      ;;
  esac
  # $(cat) strips trailing newlines, which only makes this stricter than
  # the helper's strip-exactly-one-\n behaviour — never more permissive.
  local content
  content="$(cat "$f")"
  if [ "${#content}" -lt 12 ]; then
    log_fail "Administrator password in the provided file is shorter than 12 characters."
    return 1
  fi
  return 0
}

# Called at the start of a --resume run, before any stage executes.
# Resume state deliberately never stores the plaintext administrator
# password, and the mode-600 temp file a fresh interactive run wrote it
# to is (correctly) deleted on every exit path — so a resumed run that
# has not yet produced a valid auth.env must collect the password again
# NOW, not discover mid-SECRETS that its input file no longer exists.
# This runs immediately after resume state loads, before any
# long-running or destructive stage.
collect_resume_admin_password() {
  # Dry-run never generates real secrets, so it never needs the password.
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    return 0
  fi

  if auth_file_looks_valid; then
    log_info "Existing valid secrets found at $AUTH_FILE_PATH — the administrator password is not needed for this resume."
    return 0
  fi

  if [ -f "$AUTH_FILE_PATH" ]; then
    fatal "$AUTH_FILE_PATH exists but is missing required fields. Refusing to overwrite it automatically — inspect it by hand, or remove it deliberately if you intend to generate fresh secrets (this will invalidate any already-stored provider credentials)."
  fi

  # An explicitly provided password file (e.g. --admin-password-file on
  # the resume command line) is honored in both modes — but only if it
  # actually passes validation. A provided-but-broken file is an error,
  # never silently ignored in favor of a prompt.
  if [ -n "${OPT_ADMIN_PASSWORD_FILE:-}" ]; then
    if admin_password_file_is_valid "$OPT_ADMIN_PASSWORD_FILE"; then
      return 0
    fi
    fatal "The provided administrator password file is not usable (reason above). Nothing was changed."
  fi

  if [ "${NON_INTERACTIVE:-0}" -eq 1 ]; then
    log_fail "Administrator password is required to resume before secrets are generated."
    fatal "Provide it through --admin-password-file <mode-600-file>, or run resume interactively."
  fi

  log_action "Administrator password required to resume secret generation."
  local resume_password
  resume_password="$(prompt_password "Re-enter administrator password (min. 12 characters)")"
  OPT_ADMIN_PASSWORD_FILE="$(mktemp)"
  chmod 600 "$OPT_ADMIN_PASSWORD_FILE"
  printf '%s' "$resume_password" > "$OPT_ADMIN_PASSWORD_FILE"
  unset resume_password
  if command -v track_temp_file >/dev/null 2>&1; then
    track_temp_file "$OPT_ADMIN_PASSWORD_FILE"
  fi
  log_info "Password captured to a mode-600 temporary file. It is removed automatically when the installer exits and is never written to installer state."
}

# Computes salt:hash (hex) for a password, without ever putting the
# password on the command line, in an environment variable passed to
# `docker run`, or in any log line.
#
# Deliberately NOT wrapped in run_with_progress: its stdout carries the
# derived hash, which must never pass through the generic
# capture-and-log pipeline.
compute_password_hash() {
  local password_file="$1"

  # Pre-validation before docker is ever invoked (and before any temp
  # file is created): a missing/unreadable/empty input must fail here
  # with a clear message, not surface later as an inscrutable helper
  # error — and never reach `docker run` at all, where a stale -v style
  # mount of a missing path would silently create a directory. The
  # message intentionally does not print the path: for a resumed run it
  # is a meaningless deleted temp filename.
  if [ -z "$password_file" ] || [ -d "$password_file" ] || [ ! -f "$password_file" ] \
    || [ ! -r "$password_file" ] || [ ! -s "$password_file" ]; then
    fatal "Administrator password input file is unavailable. Resume must collect the password again before secret generation."
  fi
  local input_mode
  input_mode="$(_password_file_mode "$password_file")"
  case "$input_mode" in
    *00) : ;;
    *) fatal "Administrator password input file has permissive permissions (must be mode 600 or stricter). Refusing to use it." ;;
  esac

  local script_file
  script_file="$(mktemp)"
  chmod 600 "$script_file"

  cat > "$script_file" <<'NODE_EOF'
const fs = require("fs");
const { scryptSync, randomBytes } = require("node:crypto");

const password = fs.readFileSync(process.argv[2], "utf8").replace(/\n$/, "");
const salt = randomBytes(32);
const derivedKey = scryptSync(password, salt, 64);
process.stdout.write(`${salt.toString("hex")}:${derivedKey.toString("hex")}`);
NODE_EOF

  # stderr goes to a mode-600 diagnostic file: on failure it reaches the
  # installer log (redacted), never the terminal verbatim, and never
  # includes the password or hash (the helper script writes neither to
  # stderr). stdout — the hash — is captured only into this variable.
  local diag_file
  diag_file="$(mktemp)"
  chmod 600 "$diag_file"

  # `--mount type=bind` (not -v): docker errors out if the host source
  # path is missing instead of silently creating a directory in its
  # place. Sandbox unchanged: no network, no capabilities, no privilege
  # escalation, read-only root, tmpfs /tmp, non-root uid, no Docker
  # socket, auto-removal — the one password file is the only host
  # secret the helper can see.
  local docker_status=0
  local hash_output=""
  hash_output="$(docker run --rm \
    --network none \
    --user "$(id -u):$(id -g)" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --read-only \
    --tmpfs /tmp \
    --mount "type=bind,src=${script_file},dst=/work/script.js,readonly" \
    --mount "type=bind,src=${password_file},dst=/work/data/password,readonly" \
    "$NODE_HELPER_IMAGE" \
    node /work/script.js /work/data/password < /dev/null 2>"$diag_file")" || docker_status=$?

  rm -f "$script_file"

  if [ "$docker_status" -ne 0 ] || [ -z "$hash_output" ] || [[ "$hash_output" != *:* ]]; then
    log_fail "Password hash helper failed (exit code ${docker_status})."
    if grep -qiE 'ENOENT|EACCES|no such file|permission denied' "$diag_file" 2>/dev/null; then
      log_fail "The helper could not read its mounted password input."
    fi
    _log_plain "FAIL password-hash helper exit=${docker_status} — helper stderr follows (redacted):"
    _append_output_to_log "$diag_file"
    rm -f "$diag_file"
    log_fail "Full diagnostic details were written to the installer log with secret values redacted."
    fatal "Failed to compute the administrator password hash."
  fi

  rm -f "$diag_file"
  printf '%s' "$hash_output"
}

auth_file_looks_valid() {
  [ -f "$AUTH_FILE_PATH" ] || return 1
  grep -q '^ADMIN_USERNAME=' "$AUTH_FILE_PATH" 2>/dev/null || return 1
  grep -q '^ADMIN_PASSWORD_HASH=' "$AUTH_FILE_PATH" 2>/dev/null || return 1
  grep -q '^SESSION_SECRET=' "$AUTH_FILE_PATH" 2>/dev/null || return 1
  grep -q '^CREDENTIAL_ENCRYPTION_KEY=' "$AUTH_FILE_PATH" 2>/dev/null || return 1
  return 0
}

# `admin_username` and a readable `admin_password_file` (mode 600,
# deleted by the caller once this returns) are the only inputs — the
# password itself is never accepted as a function/CLI argument.
generate_secrets() {
  log_stage "SECRETS"

  local admin_username="$1"
  local admin_password_file="$2"

  if auth_file_looks_valid; then
    log_pass "Existing valid secrets found at $AUTH_FILE_PATH — reusing them. CREDENTIAL_ENCRYPTION_KEY is never silently rotated: doing so would make any already-stored provider credentials unreadable."
    return 0
  fi

  if [ -f "$AUTH_FILE_PATH" ]; then
    fatal "$AUTH_FILE_PATH exists but is missing required fields. Refusing to overwrite it automatically — inspect it by hand, or remove it deliberately if you intend to generate fresh secrets (this will invalidate any already-stored provider credentials)."
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would generate CREDENTIAL_ENCRYPTION_KEY, SESSION_SECRET, and an administrator password hash, then write $AUTH_FILE_PATH (mode 600)."
    return 0
  fi

  ensure_node_helper_image

  # The hash is computed FIRST: it is the step most likely to fail (it
  # needs the password input and a working helper container), and
  # nothing — not the encryption key, not the session secret — is
  # generated or held in memory until it has succeeded. auth.env is
  # only ever written whole, atomically, further down.
  log_info "Computing administrator password hash (scrypt, inside a sandboxed helper container)."
  local password_hash
  if ! password_hash="$(compute_password_hash "$admin_password_file")"; then
    # compute_password_hash runs in a command-substitution subshell, so
    # its fatal() cannot stop this process directly — this check is what
    # actually stops the stage. Its diagnostics have already printed.
    fatal "Administrator password hashing failed — no secrets were generated or written."
  fi

  log_info "Generating CREDENTIAL_ENCRYPTION_KEY (32 random bytes, base64) via openssl."
  local encryption_key
  encryption_key="$(openssl rand -base64 32)"

  log_info "Generating SESSION_SECRET (32 random bytes, hex) via openssl."
  local session_secret
  session_secret="$(openssl rand -hex 32)"

  local template_file="${DEPLOYMENT_PLATFORM_INSTALLER_ROOT}/templates/auth.env.template"
  local tmp_auth_file
  tmp_auth_file="$(mktemp "${INSTALL_ROOT}/config/.auth.env.XXXXXX")"
  chmod 600 "$tmp_auth_file"

  # sed with a delimiter that can never appear in these generated
  # values (base64/hex output never contains "|") — substitution, not
  # eval, so nothing in these values is ever interpreted as shell.
  sed \
    -e "s|__ADMIN_USERNAME__|${admin_username}|" \
    -e "s|__ADMIN_PASSWORD_HASH__|${password_hash}|" \
    -e "s|__SESSION_SECRET__|${session_secret}|" \
    -e "s|__CREDENTIAL_ENCRYPTION_KEY__|${encryption_key}|" \
    "$template_file" > "$tmp_auth_file"

  chmod 600 "$tmp_auth_file"
  mv -f "$tmp_auth_file" "$AUTH_FILE_PATH"
  chmod 600 "$AUTH_FILE_PATH"

  # Never held in a shell variable a moment longer than necessary, and
  # never printed — but bash cannot force early memory zeroing, so the
  # real safety property here is "never written to argv, env dump, or
  # a log line", which the code above already guarantees.
  unset encryption_key session_secret password_hash

  log_pass "Secrets generated and stored at $AUTH_FILE_PATH (mode 600). Values are never printed or logged."
}

# ============================================================
# Administrator password rotation
# ============================================================
#
# Backs `deployment-platform reset-admin-password`.
#
# Rotation must RECREATE the API container, not merely restart it:
# auth.env is supplied via `docker create --env-file`, and Docker reads
# that file once, at creation time. A `docker restart` would keep serving
# the old hash from the container's baked-in environment and the
# rotation would silently appear to do nothing.
#
# Everything except ADMIN_PASSWORD_HASH is preserved byte-for-byte —
# ADMIN_USERNAME, SESSION_SECRET, COOKIE_SECURE, and especially
# CREDENTIAL_ENCRYPTION_KEY, which must never be rotated here: doing so
# would make every stored provider credential permanently undecryptable.
#
# The plaintext password never reaches argv, a log line, the environment
# of any container, or Git. It exists only in a mode-600 temp file that
# is removed on every exit path, exactly as during a fresh install.

# Rewrites auth.env with a new ADMIN_PASSWORD_HASH, atomically, keeping
# every other line untouched and in order.
_write_rotated_auth_file() {
  local new_hash="$1"
  local tmp_auth_file
  tmp_auth_file="$(mktemp "${INSTALL_ROOT}/config/.auth.env.XXXXXX")"
  chmod 600 "$tmp_auth_file"

  # Replaces only the hash line; every other line is copied verbatim, so
  # unknown/future keys survive a rotation untouched.
  local replaced=0
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ADMIN_PASSWORD_HASH=*)
        printf 'ADMIN_PASSWORD_HASH=%s\n' "$new_hash" >> "$tmp_auth_file"
        replaced=1
        ;;
      *)
        printf '%s\n' "$line" >> "$tmp_auth_file"
        ;;
    esac
  done < "$AUTH_FILE_PATH"

  if [ "$replaced" -ne 1 ]; then
    rm -f "$tmp_auth_file"
    fatal "Could not find an ADMIN_PASSWORD_HASH line in $AUTH_FILE_PATH. Refusing to guess; nothing was changed."
  fi

  chmod 600 "$tmp_auth_file"
  sync "$tmp_auth_file" 2>/dev/null || true
  mv -f "$tmp_auth_file" "$AUTH_FILE_PATH"
  chmod 600 "$AUTH_FILE_PATH"
}

# Recreates the API container with exactly the arguments
# ensure_api_container uses, so the rotated auth.env is read afresh.
_recreate_api_container_for_rotation() {
  local api_image="$1"
  local platform_env_file="${INSTALL_ROOT}/config/platform.env"

  docker rm -f "$API_CONTAINER_NAME" >/dev/null 2>&1 || true

  docker create --name "$API_CONTAINER_NAME" \
    --network "$PLATFORM_NETWORK_NAME" \
    --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${API_DATA_VOLUME_NAME}:/data" \
    -v "${INSTALL_ROOT}/caddy/routes:/app/caddy-routes" \
    --env-file "${INSTALL_ROOT}/config/auth.env" \
    --env-file "$platform_env_file" \
    "$api_image" >/dev/null || return 1

  docker network connect "$APPS_NETWORK_NAME" "$API_CONTAINER_NAME" >/dev/null 2>&1 || true
  docker start "$API_CONTAINER_NAME" >/dev/null || return 1

  wait_for_log_marker "$API_CONTAINER_NAME" "listening at" \
    "Waiting for the API to restart with the rotated password"
}

# Confirms the API came back up AND that the login handler actually
# runs — a wrong password must be rejected by the handler with its own
# message, not by the authentication hook. No password is sent.
_verify_rotation_health() {
  local status=0
  verify_api_http_responds || status=$?
  if [ "$status" -ne 0 ]; then
    log_fail "API session route did not respond correctly after rotation: ${API_HTTP_CHECK_DETAIL:-no diagnostic}"
    return 1
  fi

  # Deliberately uses a throwaway wrong password, never the real one.
  local login_probe
  login_probe="$(docker exec \
    -e DP_PROBE_PORT="${API_INTERNAL_PORT:-3001}" \
    "$API_CONTAINER_NAME" node -e '
const http = require("node:http");
const payload = JSON.stringify({ username: "rotation-probe", password: "definitely-not-the-password" });
const request = http.request(
  { host: "127.0.0.1", port: Number(process.env.DP_PROBE_PORT), path: "/auth/login", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 5000 },
  (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (c) => { if (body.length < 4096) { body += c; } });
    response.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
      const message = parsed && typeof parsed.message === "string" ? parsed.message : "";
      process.stdout.write("status=" + response.statusCode + " message=" + message);
      process.exit(0);
    });
  }
);
request.on("timeout", () => { request.destroy(); process.stdout.write("status=timeout"); process.exit(0); });
request.on("error", () => { process.stdout.write("status=error"); process.exit(0); });
request.write(payload);
request.end();' 2>&1 || true)"

  case "$login_probe" in
    *"Invalid username or password"*)
      log_pass "Login handler is reachable and rejects wrong credentials correctly."
      return 0
      ;;
    *"Authentication required"*)
      log_fail "The login route is being intercepted by the authentication hook — routing is broken, not the password."
      return 1
      ;;
    *)
      log_fail "Login handler did not respond as expected after rotation (${login_probe})."
      return 1
      ;;
  esac
}

rotate_admin_password() {
  log_stage "ADMIN PASSWORD ROTATION"

  local password_file_option="${1:-}"

  require_root

  if ! auth_file_looks_valid; then
    fatal "No valid secrets file at $AUTH_FILE_PATH — nothing to rotate. Run the installer first."
  fi
  if ! docker inspect "$API_CONTAINER_NAME" >/dev/null 2>&1; then
    fatal "API container not found: $API_CONTAINER_NAME. Start the platform before rotating the password."
  fi

  local api_image
  api_image="$(docker inspect --format '{{.Config.Image}}' "$API_CONTAINER_NAME" 2>/dev/null || true)"
  [ -n "$api_image" ] || fatal "Could not determine the running API image; refusing to recreate the container."
  log_info "Current API image: $api_image (unchanged by this operation)"

  # --- collect the new password ---
  local password_file=""
  local created_password_file=0
  if [ -n "$password_file_option" ]; then
    # Non-interactive path: a mode-600 file only. A plaintext password is
    # never accepted as a command-line argument.
    if ! admin_password_file_is_valid "$password_file_option"; then
      fatal "The provided administrator password file is not usable (reason above). Nothing was changed."
    fi
    password_file="$password_file_option"
  else
    log_action "Enter a NEW administrator password. It is never echoed, logged, or stored in plaintext."
    local new_password
    new_password="$(prompt_password "New administrator password (min. 12 characters)")"
    password_file="$(mktemp)"
    chmod 600 "$password_file"
    printf '%s' "$new_password" > "$password_file"
    unset new_password
    created_password_file=1
    if command -v track_temp_file >/dev/null 2>&1; then
      track_temp_file "$password_file"
    fi
  fi

  ensure_node_helper_image

  log_info "Computing the new password hash (scrypt, inside the sandboxed helper container)."
  local new_hash
  if ! new_hash="$(compute_password_hash "$password_file")"; then
    [ "$created_password_file" -eq 1 ] && rm -f "$password_file"
    fatal "Failed to compute the new password hash. Nothing was changed."
  fi
  [ "$created_password_file" -eq 1 ] && rm -f "$password_file"

  # --- back up, write, recreate, verify, roll back on failure ---
  local auth_backup="${AUTH_FILE_PATH}.backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$AUTH_FILE_PATH" "$auth_backup"
  chmod 600 "$auth_backup"
  log_info "Previous secrets file backed up (mode 600) alongside $AUTH_FILE_PATH"

  _write_rotated_auth_file "$new_hash"
  unset new_hash
  log_pass "Secrets file updated. ADMIN_USERNAME, SESSION_SECRET, COOKIE_SECURE and CREDENTIAL_ENCRYPTION_KEY are unchanged."

  log_info "Recreating the API container so it reads the rotated secrets file..."
  if ! _recreate_api_container_for_rotation "$api_image"; then
    log_fail "The API container did not come back up with the new password. Restoring the previous secrets file..."
    cp "$auth_backup" "$AUTH_FILE_PATH"
    chmod 600 "$AUTH_FILE_PATH"
    _recreate_api_container_for_rotation "$api_image" || true
    fatal "Password rotation failed and the previous password was restored. The backup remains at $auth_backup"
  fi

  if ! _verify_rotation_health; then
    log_fail "Post-rotation verification failed. Restoring the previous secrets file..."
    cp "$auth_backup" "$AUTH_FILE_PATH"
    chmod 600 "$AUTH_FILE_PATH"
    _recreate_api_container_for_rotation "$api_image" || true
    fatal "Password rotation was rolled back. The backup remains at $auth_backup"
  fi

  log_pass "Administrator password rotated successfully."
  log_info "The previous secrets file is preserved at $auth_backup — delete it yourself once you have confirmed the new password works."
  log_action "Log in at your panel with the new password to confirm."
}
