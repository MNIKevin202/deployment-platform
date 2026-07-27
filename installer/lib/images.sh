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

image_tag_for_commit() {
  local short_sha="$1"
  printf 'bootstrap-%s' "${short_sha:0:12}"
}

# Refuses to silently overwrite an existing tag unless it can confirm
# the existing image was built from the exact same source commit
# (recorded in a label at build time) — matching the same
# never-overwrite-an-immutable-tag rule scripts/release-remote.sh
# already enforces for ordinary releases.
build_platform_image() {
  local repo="$1"
  local dockerfile="$2"
  local context_dir="$3"
  local commit_sha="$4"

  local tag
  tag="$(image_tag_for_commit "$commit_sha")"
  local image_ref="${repo}:${tag}"

  if docker image inspect "$image_ref" >/dev/null 2>&1; then
    local existing_commit
    existing_commit="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "com.deployment-platform.source-commit" }}' 2>/dev/null || true)"
    if [ "$existing_commit" = "$commit_sha" ]; then
      log_pass "$image_ref already exists and was built from the same source commit — reusing it."
      printf '%s' "$image_ref"
      return 0
    fi
    fatal "$image_ref already exists but was built from a different source commit ($existing_commit). Refusing to overwrite an immutable image tag. Remove it deliberately (docker rmi $image_ref) if you intend to rebuild it."
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: DOCKER_BUILDKIT=1 docker build -f $dockerfile -t $image_ref --label com.deployment-platform.source-commit=$commit_sha $context_dir"
    printf '%s' "$image_ref"
    return 0
  fi

  log_info "Building $image_ref (this can take a few minutes)..."
  local build_log
  build_log="$(mktemp)"

  if ! DOCKER_BUILDKIT=1 docker build \
    -f "$dockerfile" \
    -t "$image_ref" \
    --label "com.deployment-platform.source-commit=${commit_sha}" \
    --label "com.deployment-platform.built-by=installer" \
    "$context_dir" > "$build_log" 2>&1; then
    log_fail "Build failed for $image_ref. Last 40 log lines:"
    tail -n 40 "$build_log" | while IFS= read -r line; do log_fail "  $(printf '%s' "$line" | log_redact)"; done
    rm -f "$build_log"
    fatal "Image build failed for $image_ref."
  fi

  rm -f "$build_log"
  log_pass "Built $image_ref"
  printf '%s' "$image_ref"
}

build_platform_images() {
  log_stage "IMAGE BUILD"

  local release_dir="$1"
  local commit_sha="$2"

  if [ ! -f "$release_dir/apps/api/Dockerfile" ] || [ ! -f "$release_dir/apps/web/Dockerfile" ]; then
    fatal "Release directory is missing apps/api/Dockerfile or apps/web/Dockerfile: $release_dir"
  fi

  BUILT_API_IMAGE="$(build_platform_image "$API_IMAGE_REPO" "$release_dir/apps/api/Dockerfile" "$release_dir" "$commit_sha")"
  BUILT_WEB_IMAGE="$(build_platform_image "$WEB_IMAGE_REPO" "$release_dir/apps/web/Dockerfile" "$release_dir" "$commit_sha")"

  log_pass "Images ready: $BUILT_API_IMAGE, $BUILT_WEB_IMAGE"
}
