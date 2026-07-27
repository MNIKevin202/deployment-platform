#!/usr/bin/env bash
#
# source.sh — acquires the platform's own source code into a new,
# immutable release directory (section 12) — the same
# "${INSTALL_ROOT}/source/releases/release-<timestamp>-<sha>/" shape
# release.sh already uses, so the two tools stay compatible.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "source.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

# Never copied into a release directory, regardless of source method —
# matches release.sh's own exclusion list and generate-auth.sh's
# never-committed status.
SOURCE_RSYNC_EXCLUDES=(
  --exclude=.git
  --exclude=node_modules
  --exclude=dist
  --exclude=.env
  --exclude=.env.*
  --exclude=auth.env
  --exclude=generate-auth.sh
  --exclude=*.log
  --exclude=*.swp
  --exclude=.DS_Store
  --exclude=release.config
  --exclude=.idea
  --exclude=.vscode
)

RELEASE_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Recorded inside every release directory so a later resume can tell
# whether the source it is about to copy is already the current release.
SOURCE_IDENTITY_MARKER=".deployment-platform-source-identity"

# ============================================================
# Source identity
# ============================================================
#
# A Git checkout identifies itself by commit SHA. A directory rsync'd
# onto the server has no .git at all, and the installer previously
# recorded that as the literal string "unknown" — which then flowed into
# the image tag (deployment-platform-api:bootstrap-unknown) and into the
# image-reuse comparison. Two completely unrelated source trees both
# hash to "unknown", so the reuse check ("same source commit?") would
# happily match them and skip a rebuild that was genuinely needed. A
# content fingerprint fixes both problems: it names what was actually
# deployed, and it differs whenever the deployed content differs.

# Hashes stdin, printing lowercase hex. openssl is already a required
# installer package, so the final branch always exists; sha256sum and
# shasum are preferred when present because they are cheaper.
_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | awk '{print $NF}'
  else
    return 1
  fi
}

# The same content the release copy and the Docker build context will
# see — deliberately mirroring SOURCE_RSYNC_EXCLUDES, so an excluded
# file (a stray .env, a log, node_modules churn) can never change the
# identity of an otherwise-identical tree.
_source_fingerprint_file_list() {
  find . -type f \
    ! -path './.git/*' \
    ! -path '*/node_modules/*' \
    ! -path '*/dist/*' \
    ! -path '*/logs/*' \
    ! -path '*/.idea/*' \
    ! -path '*/.vscode/*' \
    ! -name '.env' \
    ! -name '.env.*' \
    ! -name 'auth.env' \
    ! -name 'generate-auth.sh' \
    ! -name 'release.config' \
    ! -name '*.log' \
    ! -name '*.swp' \
    ! -name '.DS_Store' \
    2>/dev/null
}

# Prints the full lowercase sha256 of the tree's selected content.
#
# Deterministic by construction: LC_ALL=C sort fixes the ordering, and
# only relative paths and file bytes are fed to the hash — never
# mtimes, ownership, permissions, or absolute paths, so copying the same
# tree to a different directory (or re-rsyncing it) yields the same
# fingerprint, while editing any included file changes it. One hash
# process total, not one per file.
compute_source_content_fingerprint() {
  local root="$1"
  local file_list
  file_list="$(cd "$root" 2>/dev/null && _source_fingerprint_file_list | LC_ALL=C sort)" || return 1
  [ -n "$file_list" ] || return 1

  local fingerprint
  fingerprint="$(
    cd "$root" || exit 1
    {
      while IFS= read -r relative_path; do
        [ -n "$relative_path" ] || continue
        # Path then bytes. The path is included so a pure rename changes
        # the identity; a fixed record separator keeps concatenation of
        # a file that lacks a trailing newline unambiguous.
        printf '%s\n' "$relative_path"
        cat "$relative_path" 2>/dev/null
        printf '\n--dp-source-record--\n'
      done <<EOF
$file_list
EOF
    } | _sha256_stream
  )" || return 1

  case "$fingerprint" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  printf '%s' "$fingerprint"
}

# Resolves a local source directory to a stable identity string:
# a real 40-char Git SHA when Git metadata is usable, otherwise
# local-<full sha256 of content>. Only ever returns "unknown" when both
# are genuinely impossible, and warns loudly when that happens.
resolve_local_source_identity() {
  local resolved="$1"

  if [ -d "$resolved/.git" ] && command -v git >/dev/null 2>&1; then
    local git_sha
    git_sha="$(git -C "$resolved" rev-parse HEAD 2>/dev/null || true)"
    case "$git_sha" in
      '') : ;;
      *[!0-9a-f]*) : ;;
      *) printf '%s' "$git_sha"; return 0 ;;
    esac
  fi

  local fingerprint
  if fingerprint="$(compute_source_content_fingerprint "$resolved")"; then
    printf 'local-%s' "$fingerprint"
    return 0
  fi

  log_warn "Could not compute a content fingerprint for the local source at $resolved. Falling back to an unidentified source; images built from it will not be reused by later runs."
  printf 'unknown'
}

# The identity recorded inside an existing release directory, if any.
release_dir_identity() {
  local release_dir="$1"
  [ -f "${release_dir}/${SOURCE_IDENTITY_MARKER}" ] || return 1
  local recorded
  recorded="$(head -n 1 "${release_dir}/${SOURCE_IDENTITY_MARKER}" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$recorded" ] || return 1
  printf '%s' "$recorded"
}

# The release directory source/current currently points at, if any.
current_release_dir() {
  local current_link="${INSTALL_ROOT}/source/current"
  [ -L "$current_link" ] || [ -d "$current_link" ] || return 1
  local resolved
  resolved="$(cd "$current_link" 2>/dev/null && pwd -P)" || return 1
  [ -n "$resolved" ] || return 1
  printf '%s' "$resolved"
}

# True when source/current already holds exactly this identity — the
# check that stops a DNS-only resume from copying an identical tree into
# yet another release-<timestamp> directory on every attempt.
current_release_matches_identity() {
  local identity="$1"
  [ -n "$identity" ] || return 1
  [ "$identity" != "unknown" ] || return 1
  local current recorded
  current="$(current_release_dir)" || return 1
  recorded="$(release_dir_identity "$current")" || return 1
  [ "$recorded" = "$identity" ]
}

# ============================================================
# Source acquisition contract
# ============================================================
#
# These functions assign caller-owned globals and must be called
# DIRECTLY — never as SOMETHING="$(acquire_source_...)". Command
# substitution runs the function in a subshell, so every global it sets
# (the resolved identity, the reuse flag) is discarded when that subshell
# exits, and the caller silently keeps its previous value. That is
# exactly what produced "requested: unknown" at the image stage while the
# source stage had just logged a correct local-<sha256> identity: the
# fingerprint was computed inside the subshell and thrown away.
#
# Every log line already goes to the visible-output channel rather than
# stdout (see common.sh _visible_line), so a direct call prints normally
# without needing capture.
#
# Outputs, all set in the caller's shell:
#   SOURCE_RELEASE_DIR     — the release directory to build from
#   RESOLVED_SOURCE_COMMIT — full identity (git SHA or local-<sha256>)
#   SOURCE_IDENTITY_SHORT  — short slug used in release/image naming
#   SOURCE_RELEASE_REUSED  — 1 when an existing release was reused
SOURCE_RELEASE_DIR=""
RESOLVED_SOURCE_COMMIT=""
SOURCE_IDENTITY_SHORT=""
SOURCE_RELEASE_REUSED=0

acquire_source_from_local_path() {
  local source_path="$1"

  # Reject traversal/symlink surprises: resolve to a real absolute path
  # first, and require it to actually be a git checkout of this project
  # (contains package.json + apps/api + apps/web) before trusting it.
  local resolved
  resolved="$(cd "$source_path" 2>/dev/null && pwd -P)" || fatal "Source path does not exist or is not a directory: $source_path"

  if [ ! -f "$resolved/package.json" ] || [ ! -d "$resolved/apps/api" ] || [ ! -d "$resolved/apps/web" ]; then
    fatal "Source path does not look like a Deployment Platform checkout: $resolved"
  fi

  local commit_sha
  commit_sha="$(resolve_local_source_identity "$resolved")"
  RESOLVED_SOURCE_COMMIT="$commit_sha"
  SOURCE_IDENTITY_SHORT="$(release_slug_for_identity "$commit_sha")"
  log_info "Source identity: $commit_sha"

  # Idempotency: if source/current already holds exactly this identity,
  # reuse it instead of writing another byte-identical
  # release-<timestamp>-<identity> directory. Repeatedly resuming a
  # DNS-pending install used to accumulate one duplicate release copy
  # (and one database backup) per attempt.
  if current_release_matches_identity "$commit_sha"; then
    local existing_release
    existing_release="$(current_release_dir)"
    log_pass "Current release already holds this exact source identity — reusing $existing_release (no new release directory created)."
    SOURCE_RELEASE_REUSED=1
    SOURCE_RELEASE_DIR="$existing_release"
    return 0
  fi
  SOURCE_RELEASE_REUSED=0

  local release_dir="${INSTALL_ROOT}/source/releases/release-${RELEASE_TIMESTAMP}-${SOURCE_IDENTITY_SHORT}"
  SOURCE_RELEASE_DIR="$release_dir"

  log_info "Copying source from $resolved into immutable release directory $release_dir"

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would rsync $resolved/ -> $release_dir/ (excluding secrets, .git, node_modules, build output)"
    return 0
  fi

  mkdir -p "$release_dir"
  local status=0
  run_with_progress "Copying source into $release_dir" \
    rsync -a "${SOURCE_RSYNC_EXCLUDES[@]}" "$resolved/" "$release_dir/" || status=$?
  if [ "$status" -ne 0 ]; then
    print_last_output_excerpt "Recent rsync output:"
    fatal "Failed to copy source into $release_dir"
  fi

  record_release_identity "$release_dir" "$commit_sha"
  return 0
}

# Short, filesystem- and Docker-tag-safe slug for a release directory
# name. A git SHA keeps its familiar first 12 hex characters; a content
# fingerprint keeps its "local-" prefix so the directory name still says
# what kind of identity it is.
release_slug_for_identity() {
  local identity="$1"
  case "$identity" in
    local-*)
      local hex="${identity#local-}"
      printf 'local-%s' "${hex:0:12}"
      ;;
    unknown|'')
      printf 'unknown'
      ;;
    *)
      printf '%s' "${identity:0:12}"
      ;;
  esac
}

record_release_identity() {
  local release_dir="$1"
  local identity="$2"
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    return 0
  fi
  printf '%s\n' "$identity" > "${release_dir}/${SOURCE_IDENTITY_MARKER}"
  chmod 644 "${release_dir}/${SOURCE_IDENTITY_MARKER}" 2>/dev/null || true
}

# Only ever an https:// URL — an operator who wants SSH-key-based
# private-repo access should use --source-path against an
# already-cloned checkout instead; this installer does not manage Git
# credentials on the operator's behalf, and never clones as anything
# other than the confirmed public/HTTPS-accessible ref.
acquire_source_from_git() {
  local repo_url="$1"
  local ref="$2"

  if [[ "$repo_url" != https://* ]]; then
    fatal "--source-repository must be an https:// URL. Nothing was changed."
  fi
  if [[ "$repo_url" =~ [\;\&\|\$\`] ]]; then
    fatal "Source repository URL contains characters that are not allowed."
  fi
  if ! is_safe_token "$ref"; then
    fatal "--source-ref contains characters that are not allowed: $ref"
  fi

  local clone_dir
  clone_dir="$(mktemp -d)"

  log_info "Cloning $repo_url at ref '$ref' into a temporary directory."

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: git clone --branch $ref --depth 1 -- $repo_url $clone_dir"
    rm -rf "$clone_dir"
    SOURCE_RELEASE_DIR="${INSTALL_ROOT}/source/releases/release-${RELEASE_TIMESTAMP}-dryrun"
    RESOLVED_SOURCE_COMMIT="${RESOLVED_SOURCE_COMMIT:-unknown}"
    SOURCE_IDENTITY_SHORT="dryrun"
    SOURCE_RELEASE_REUSED=0
    return 0
  fi

  local status=0
  run_with_progress "Cloning $repo_url (ref: $ref)" \
    git clone --branch "$ref" --depth 1 --single-branch -- "$repo_url" "$clone_dir" || status=$?
  if [ "$status" -ne 0 ]; then
    print_last_output_excerpt "Recent git output:"
    rm -rf "$clone_dir"
    fatal "git clone failed for $repo_url at ref '$ref'."
  fi

  local commit_sha
  commit_sha="$(git -C "$clone_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  RESOLVED_SOURCE_COMMIT="$commit_sha"
  SOURCE_IDENTITY_SHORT="$(release_slug_for_identity "$commit_sha")"
  log_info "Source identity: $commit_sha"
  local release_dir="${INSTALL_ROOT}/source/releases/release-${RELEASE_TIMESTAMP}-${SOURCE_IDENTITY_SHORT}"
  SOURCE_RELEASE_DIR="$release_dir"

  mkdir -p "$release_dir"
  status=0
  run_with_progress "Copying cloned source into $release_dir" \
    rsync -a "${SOURCE_RSYNC_EXCLUDES[@]}" "$clone_dir/" "$release_dir/" || status=$?
  if [ "$status" -ne 0 ]; then
    print_last_output_excerpt "Recent rsync output:"
    rm -rf "$clone_dir"
    fatal "Failed to copy cloned source into $release_dir"
  fi
  rm -rf "$clone_dir"

  SOURCE_RELEASE_REUSED=0
  record_release_identity "$release_dir" "$commit_sha"
  return 0
}

# Atomically points source/current at the given release directory —
# only ever called after the images built from it, and the database
# migrations run against it, have already succeeded.
update_current_source_pointer() {
  local release_dir="$1"
  local current_link="${INSTALL_ROOT}/source/current"

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would point $current_link -> $release_dir"
    return 0
  fi

  # Already pointing exactly here (a reused release on resume): leave the
  # symlink untouched rather than replacing it with an identical one.
  local already
  already="$(current_release_dir 2>/dev/null || true)"
  local target
  target="$(cd "$release_dir" 2>/dev/null && pwd -P || printf '%s' "$release_dir")"
  if [ -n "$already" ] && [ "$already" = "$target" ]; then
    log_pass "Current source pointer already -> $release_dir (unchanged)"
    return 0
  fi

  local tmp_link="${current_link}.tmp-${RELEASE_TIMESTAMP}"
  ln -sfn "$release_dir" "$tmp_link"
  mv -T "$tmp_link" "$current_link"

  local resolved
  resolved="$(readlink -f "$current_link" 2>/dev/null || true)"
  local expected
  expected="$(readlink -f "$release_dir" 2>/dev/null || true)"
  if [ "$resolved" != "$expected" ]; then
    fatal "Current source pointer verification failed after update."
  fi

  log_pass "Current source pointer -> $release_dir"
}
