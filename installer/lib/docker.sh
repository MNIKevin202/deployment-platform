#!/usr/bin/env bash
#
# docker.sh — installs Docker Engine using Docker's own official
# apt-repository method (never a third-party curl-pipe-bash convenience
# script). Idempotent: an existing, working, sufficiently-recent Docker
# installation is reused; a broken one is reported clearly rather than
# silently reinstalled over.

if [ -z "${DEPLOYMENT_PLATFORM_INSTALLER_ROOT:-}" ]; then
  echo "docker.sh must be sourced by install.sh, not run directly." >&2
  exit 1
fi

DOCKER_GPG_KEY_PATH="/etc/apt/keyrings/docker.asc"
DOCKER_APT_LIST_PATH="/etc/apt/sources.list.d/docker.list"

docker_is_usable() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

docker_compose_plugin_available() {
  docker compose version >/dev/null 2>&1
}

install_docker() {
  log_stage "DOCKER"

  if docker_is_usable; then
    log_pass "Docker is already installed and the daemon is reachable ($(docker --version 2>/dev/null))."
  else
    if command -v docker >/dev/null 2>&1; then
      fatal "A 'docker' command exists but the Docker daemon is not reachable. Investigate the existing installation (systemctl status docker) before re-running — this installer will not attempt to force-replace a broken Docker installation."
    fi

    log_info "Installing Docker Engine using Docker's official apt repository."

    if [ "$DRY_RUN" -eq 1 ]; then
      log_info "[dry-run] Would add Docker's official GPG key and apt repository, then install docker-ce, docker-ce-cli, containerd.io, docker-buildx-plugin, docker-compose-plugin."
    else
      install -m 0755 -d /etc/apt/keyrings

      # Docker's own published GPG key, fetched over TLS with a bounded
      # timeout — never a third-party mirror, never piped into a shell.
      local status=0
      run_with_progress "Downloading Docker's official GPG key" \
        curl -fsSL --connect-timeout 10 --max-time 30 \
        https://download.docker.com/linux/ubuntu/gpg -o "$DOCKER_GPG_KEY_PATH" || status=$?
      if [ "$status" -ne 0 ]; then
        print_last_output_excerpt "Recent curl output:"
        fatal "Unable to download Docker's GPG key. Check network connectivity."
      fi
      chmod a+r "$DOCKER_GPG_KEY_PATH"

      local arch
      arch="$(dpkg --print-architecture)"
      local codename
      codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"

      printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/ubuntu %s stable\n' \
        "$arch" "$DOCKER_GPG_KEY_PATH" "$codename" > "$DOCKER_APT_LIST_PATH"

      status=0
      run_with_progress "Updating apt metadata (with Docker's repository)" \
        env DEBIAN_FRONTEND=noninteractive apt-get "${APT_COMMON_OPTIONS[@]}" update || status=$?
      if [ "$status" -ne 0 ]; then
        print_package_failure_diagnostics "apt-get update (after adding Docker's repository)" "$status"
        fatal "apt-get update failed after adding Docker's repository."
      fi

      local docker_packages="docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      status=0
      run_with_progress "Installing Docker Engine: ${docker_packages}" \
        env DEBIAN_FRONTEND=noninteractive apt-get "${APT_COMMON_OPTIONS[@]}" install -y \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || status=$?
      if [ "$status" -ne 0 ]; then
        print_package_failure_diagnostics "Docker Engine installation" "$status" "$docker_packages"
        fatal "Failed to install Docker Engine."
      fi

      if command -v systemctl >/dev/null 2>&1; then
        run_with_progress "Enabling and starting the Docker service" \
          systemctl enable --now docker || log_warn "Could not enable/start the Docker service via systemctl; checking daemon reachability directly."
      fi
    fi

    if [ "$DRY_RUN" -ne 1 ] && ! docker_is_usable; then
      fatal "Docker was installed but the daemon is not reachable. Check 'systemctl status docker'."
    fi
    log_pass "Docker Engine installed."
  fi

  if [ "$DRY_RUN" -ne 1 ]; then
    if docker_compose_plugin_available; then
      log_pass "Docker Compose plugin is available."
    else
      log_warn "Docker Compose plugin was not detected. It is not required by the current container orchestration (this platform manages containers directly, not via compose files), but is installed for forward compatibility. Continuing."
    fi
  fi

  log_action "Note: the operator's normal SSH user was NOT added to the docker group. Membership in the docker group is equivalent to root access on this host (a member can bind-mount the root filesystem into a container). This installer runs entirely as root instead. If you want a non-root operator to run 'docker' commands directly later, run 'usermod -aG docker <user>' yourself, understanding that this is effectively granting that user root."
}

# ============================================================
# Docker networks and volumes (section 10)
# ============================================================
#
# Matches the exact names release.sh/scripts/release-remote.sh already
# use in the existing production installation, so this installer's
# output is a drop-in match for the current deployment tooling.

PLATFORM_NETWORK_NAME="deployment-platform"
APPS_NETWORK_NAME="deployment-apps"
API_DATA_VOLUME_NAME="deployment-platform-api-data"

ensure_docker_network() {
  local name="$1"
  if docker network inspect "$name" >/dev/null 2>&1; then
    log_pass "Docker network already exists: $name (reusing)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: docker network create $name"
    return 0
  fi
  if ! docker network create "$name" >/dev/null; then
    fatal "Failed to create Docker network: $name"
  fi
  log_pass "Created Docker network: $name"
}

ensure_docker_volume() {
  local name="$1"
  if docker volume inspect "$name" >/dev/null 2>&1; then
    log_pass "Docker volume already exists: $name (reusing — never recreated, never deleted)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[dry-run] Would run: docker volume create $name"
    return 0
  fi
  if ! docker volume create "$name" >/dev/null; then
    fatal "Failed to create Docker volume: $name"
  fi
  log_pass "Created Docker volume: $name"
}

setup_docker_foundation() {
  log_stage "DOCKER NETWORKS AND VOLUMES"
  ensure_docker_network "$PLATFORM_NETWORK_NAME"
  ensure_docker_network "$APPS_NETWORK_NAME"
  ensure_docker_volume "$API_DATA_VOLUME_NAME"
}
