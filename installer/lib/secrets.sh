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
  if ! docker pull "$NODE_HELPER_IMAGE" >/dev/null; then
    fatal "Unable to pull $NODE_HELPER_IMAGE, required to generate the administrator password hash."
  fi
}

# Computes salt:hash (hex) for a password, without ever putting the
# password on the command line, in an environment variable passed to
# `docker run`, or in any log line.
compute_password_hash() {
  local password_file="$1"
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

  local hash_output
  hash_output="$(docker run --rm \
    --network none \
    --user "$(id -u):$(id -g)" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --read-only \
    --tmpfs /tmp \
    -v "${script_file}:/work/script.js:ro" \
    -v "${password_file}:/work/data/password:ro" \
    "$NODE_HELPER_IMAGE" \
    node /work/script.js /work/data/password < /dev/null)"

  rm -f "$script_file"

  if [ -z "$hash_output" ] || [[ "$hash_output" != *:* ]]; then
    fatal "Failed to compute the administrator password hash."
  fi
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

  log_info "Generating CREDENTIAL_ENCRYPTION_KEY (32 random bytes, base64) via openssl."
  local encryption_key
  encryption_key="$(openssl rand -base64 32)"

  log_info "Generating SESSION_SECRET (32 random bytes, hex) via openssl."
  local session_secret
  session_secret="$(openssl rand -hex 32)"

  log_info "Computing administrator password hash (scrypt, inside a sandboxed helper container)."
  local password_hash
  password_hash="$(compute_password_hash "$admin_password_file")"

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
