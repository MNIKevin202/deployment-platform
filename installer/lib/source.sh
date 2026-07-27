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

  local commit_sha="unknown"
  if [ -d "$resolved/.git" ] && command -v git >/dev/null 2>&1; then
    commit_sha="$(git -C "$resolved" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi

  local short_sha="${commit_sha:0:12}"
  [ "$short_sha" = "unknown" ] || [ -n "$short_sha" ] || short_sha="local"
  local release_dir="${INSTALL_ROOT}/source/releases/release-${RELEASE_TIMESTAMP}-${short_sha:-local}"

  log_info "Copying source from $resolved into immutable release directory $release_dir"

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would rsync $resolved/ -> $release_dir/ (excluding secrets, .git, node_modules, build output)"
    printf '%s' "$release_dir"
    return 0
  fi

  mkdir -p "$release_dir"
  if ! rsync -a "${SOURCE_RSYNC_EXCLUDES[@]}" "$resolved/" "$release_dir/"; then
    fatal "Failed to copy source into $release_dir"
  fi

  RESOLVED_SOURCE_COMMIT="$commit_sha"
  printf '%s' "$release_dir"
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
    printf '%s' "${INSTALL_ROOT}/source/releases/release-${RELEASE_TIMESTAMP}-dryrun"
    return 0
  fi

  if ! git clone --branch "$ref" --depth 1 --single-branch -- "$repo_url" "$clone_dir" >/dev/null 2>&1; then
    rm -rf "$clone_dir"
    fatal "git clone failed for $repo_url at ref '$ref'."
  fi

  local commit_sha
  commit_sha="$(git -C "$clone_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  local short_sha="${commit_sha:0:12}"
  local release_dir="${INSTALL_ROOT}/source/releases/release-${RELEASE_TIMESTAMP}-${short_sha:-unknown}"

  mkdir -p "$release_dir"
  if ! rsync -a "${SOURCE_RSYNC_EXCLUDES[@]}" "$clone_dir/" "$release_dir/"; then
    rm -rf "$clone_dir"
    fatal "Failed to copy cloned source into $release_dir"
  fi
  rm -rf "$clone_dir"

  RESOLVED_SOURCE_COMMIT="$commit_sha"
  printf '%s' "$release_dir"
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
