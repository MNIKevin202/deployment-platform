#!/usr/bin/env bash
#
# images.sh — builds the API and web images from an immutable release
# directory, tagged deterministically from the source commit rather
# than "latest" (section 13).

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "images.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

API_IMAGE_REPO="deployment-platform-api"
WEB_IMAGE_REPO="deployment-platform-web"

# Derives the immutable image tag from the source identity, which is
# either a Git commit SHA or local-<sha256 content fingerprint>. The
# "local-" prefix is preserved in the tag so a fingerprinted build is
# visibly distinct from a Git build — and, critically, so it can never
# collide with a legacy "bootstrap-unknown" image left over from before
# fingerprinting existed. All characters produced here (lowercase hex,
# hyphens) are valid in a Docker tag.
image_tag_for_commit() {
  local identity="$1"
  case "$identity" in
    local-*)
      local hex="${identity#local-}"
      printf 'bootstrap-local-%s' "${hex:0:12}"
      ;;
    ''|unknown)
      printf 'bootstrap-unknown'
      ;;
    *)
      printf 'bootstrap-%s' "${identity:0:12}"
      ;;
  esac
}

# Refuses to silently overwrite an existing tag unless it can confirm
# the existing image was built from the exact same source commit
# (recorded in a label at build time) — matching the same
# never-overwrite-an-immutable-tag rule scripts/release-remote.sh
# already enforces for ordinary releases.
#
# Assigns BUILT_IMAGE_REF rather than printing the ref, so callers invoke
# it directly instead of through command substitution. A $() call would
# run this in a subshell, where its own `fatal` could not stop the parent
# and any global it set would be discarded — the same scope trap that
# silently dropped the source identity.
BUILT_IMAGE_REF=""

build_platform_image() {
  local repo="$1"
  local dockerfile="$2"
  local context_dir="$3"
  local commit_sha="$4"

  local tag
  tag="$(image_tag_for_commit "$commit_sha")"
  local image_ref="${repo}:${tag}"

  local image_exists=0
  docker image inspect "$image_ref" >/dev/null 2>&1 || image_exists=$?
  if [ "$image_exists" -eq 0 ]; then
    local existing_commit
    existing_commit="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "com.deployment-platform.source-commit" }}' 2>/dev/null || true)"

    # An unidentified source must never satisfy a reuse check. Before
    # content fingerprinting, every non-Git local tree recorded the
    # literal identity "unknown", so two completely unrelated source
    # trees compared equal here and the second one silently reused the
    # first one's image. Legacy bootstrap-unknown images may stay on
    # disk, but they can never be selected for a new build.
    if [ "$commit_sha" = "unknown" ] || [ "$existing_commit" = "unknown" ] || [ -z "$existing_commit" ]; then
      fatal "$image_ref already exists but its source identity is not verifiable (recorded: ${existing_commit:-none}, requested: ${commit_sha}). Refusing to reuse or overwrite it. Remove it deliberately (docker rmi $image_ref) if you intend to rebuild."
    fi

    # Exact, full-identity comparison — a 12-character tag collision is
    # not enough to justify reuse.
    if [ "$existing_commit" = "$commit_sha" ]; then
      log_pass "$image_ref already exists and was built from the same source identity — reusing it."
      IMAGE_WAS_REUSED=1
      BUILT_IMAGE_REF="$image_ref"
      return 0
    fi
    fatal "$image_ref already exists but was built from a different source identity ($existing_commit). Refusing to overwrite an immutable image tag. Remove it deliberately (docker rmi $image_ref) if you intend to rebuild it."
  fi
  IMAGE_WAS_REUSED=0

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: DOCKER_BUILDKIT=1 docker build -f $dockerfile -t $image_ref --label com.deployment-platform.source-commit=$commit_sha $context_dir"
    BUILT_IMAGE_REF="$image_ref"
    return 0
  fi

  # --progress=plain makes BuildKit emit one line per build step instead
  # of an interactive redraw, which gives --show-output-tail real stage
  # names to display ("#8 [api 4/9] RUN npm ci") rather than a made-up
  # percentage, and keeps the captured log readable.
  local status=0
  run_with_progress --show-output-tail "Building $image_ref" \
    env DOCKER_BUILDKIT=1 docker build \
    --progress=plain \
    -f "$dockerfile" \
    -t "$image_ref" \
    --label "com.deployment-platform.source-commit=${commit_sha}" \
    --label "com.deployment-platform.built-by=installer" \
    "$context_dir" || status=$?

  if [ "$status" -ne 0 ]; then
    print_last_output_excerpt "Recent docker build output:"
    _visible_line ""
    _visible_line "Full log:"
    _visible_line "  ${INSTALLER_LOG_FILE}"
    _visible_line ""
    fatal "Image build failed for $image_ref (exit code ${status})."
  fi

  BUILT_IMAGE_REF="$image_ref"
  return 0
}

# True when the image already exists AND its recorded source identity
# matches exactly. Evaluated in the caller's shell (not a subshell) so
# the result can drive later decisions such as whether this run will
# change any deployed image at all.
image_matches_identity() {
  local image_ref="$1"
  local identity="$2"
  [ -n "$identity" ] || return 1
  [ "$identity" != "unknown" ] || return 1
  docker image inspect "$image_ref" >/dev/null 2>&1 || return 1
  local existing
  existing="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "com.deployment-platform.source-commit" }}' 2>/dev/null || true)"
  [ -n "$existing" ] || return 1
  [ "$existing" = "$identity" ]
}

build_platform_images() {
  log_stage "IMAGE BUILD"

  local release_dir="$1"
  local commit_sha="$2"

  if [ ! -f "$release_dir/apps/api/Dockerfile" ] || [ ! -f "$release_dir/apps/web/Dockerfile" ]; then
    fatal "Release directory is missing apps/api/Dockerfile or apps/web/Dockerfile: $release_dir"
  fi

  # Both images' reuse state is determined up front, before either build
  # runs, so the caller can tell whether this run will change any deployed
  # image at all (which drives the pre-deployment backup decision).
  local tag
  tag="$(image_tag_for_commit "$commit_sha")"
  IMAGES_ALL_REUSED=0
  if image_matches_identity "${API_IMAGE_REPO}:${tag}" "$commit_sha" \
    && image_matches_identity "${WEB_IMAGE_REPO}:${tag}" "$commit_sha"; then
    IMAGES_ALL_REUSED=1
  fi

  # Direct calls, not $(...): a subshell would discard BUILT_IMAGE_REF and
  # neuter build_platform_image's own fatal().
  build_platform_image "$API_IMAGE_REPO" "$release_dir/apps/api/Dockerfile" "$release_dir" "$commit_sha"
  BUILT_API_IMAGE="$BUILT_IMAGE_REF"
  build_platform_image "$WEB_IMAGE_REPO" "$release_dir/apps/web/Dockerfile" "$release_dir" "$commit_sha"
  BUILT_WEB_IMAGE="$BUILT_IMAGE_REF"

  log_pass "Images ready: $BUILT_API_IMAGE, $BUILT_WEB_IMAGE"
}
