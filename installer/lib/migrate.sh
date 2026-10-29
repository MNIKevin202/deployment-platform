#!/usr/bin/env bash
#
# migrate.sh — host-side launcher for the ClovaForge migration tooling.
#
# SCOPE: read-only inspection (describe, preflight, verify-bundle) and EXPORT
# (export, recover, signing-key). `import` is deliberately not implemented yet; it
# prints a clear message and changes nothing.
#
# `export` reads the installation and writes ONE new encrypted bundle. To take a
# consistent snapshot it may briefly stop or pause an application, and it always
# restarts it: the engine restores on any failure, a durable journal allows recovery
# after a hard kill, and THIS launcher runs recovery itself if the export container
# ends abnormally. It never imports, restores, replaces or hands over anything.
#
# How it works: the inspection code lives in the platform's API image. This
# script runs it in a short-lived, disposable container started from the SAME
# image the platform is running. It does NOT docker exec into, stop, restart,
# recreate or reconfigure any existing container, and it never touches the update
# schedule. The disposable container is locked down:
#
#   --network none           no network at all
#   --read-only + tmpfs      the container filesystem cannot be written
#   --cap-drop ALL           no Linux capabilities
#   no-new-privileges        cannot gain privileges
#   --pull never             never fetches an image
#
# Mounts: the platform data volume (the database is opened through a read-only
# handle; see docs/MIGRATION_DESIGN.md §8 for the one SQLite -shm caveat), the
# Docker socket (the inspection code is limited by its TYPE to query calls, and
# that is enforced by tests), and — only when you pass them — the bundle, the
# passphrase file and a destination descriptor, each mounted READ-ONLY.
#
# The credential encryption key is passed to the container BY NAME (the value
# travels in this process's environment, never on a command line). A passphrase
# is only ever accepted as a file, never as an argument.
#
# Sourced by /usr/local/bin/deployment-platform (and by the test suite); it defines
# functions only and has no side effects when sourced.

MIGRATE_API_CONTAINER="${MIGRATE_API_CONTAINER:-deployment-platform-api}"
MIGRATE_DATA_VOLUME="${MIGRATE_DATA_VOLUME:-deployment-platform-api-data}"
MIGRATE_CLI_JS="/app/apps/api/dist/migration/cli.js"

migrate_usage() {
  cat <<'USAGE'
Usage: deployment-platform migrate <command> [options]

Read-only commands (they change nothing on this server):
  describe                  Print this server's description (JSON). Run it on a destination and give the
                            result to a source with --destination-descriptor.
  preflight                 Readiness report. Use --role source (default) or --role destination.
  verify-bundle             Verify a bundle's integrity and authenticity.

Export (writes one new ENCRYPTED bundle; an app may be briefly stopped/paused and is always restarted):
  export                    --output-dir DIR  --passphrase-file FILE  [--scope platform|application --app NAME --with NAME,...]
                            [--mode rehearsal|cutover] [--strategy auto|stop|freeze|live|hook] [--app-strategy NAME=...]
                            [--hooks-file FILE] [--accept-risk NAME=LEVEL] [--signing-key-file FILE] [--bundle-name N] ...
  recover                   Restart anything an interrupted export left stopped or paused (--force if you are sure it is dead).
  signing-key generate --output-dir DIR     Create the key that signs bundles (prints its fingerprint).
  signing-key fingerprint --key-file FILE

Not available yet (prints a message and changes nothing):
  import

preflight / verify-bundle options:
  --scope platform|application    --app <id|name>    --with <id|name>[,...]
  --operation backup|copy|move    --destination-descriptor FILE
  --output-dir DIR                (free space is measured on this directory)
  --bundle DIR  --passphrase-file FILE  [--expect-signer FINGERPRINT] [--require-signature] [--deep]
  --format text|json

The passphrase is read ONLY from a file (mode 600). It is never accepted as an argument.
Exit codes: 0 ready, 10 ready with warnings, 20 blocked, 2 usage error, 3 internal error.

Environment: DP_MIGRATE_IMAGE=<image> runs the tooling from a specific API image instead of the
one the platform is running.
USAGE
}

_migrate_err() {
  printf 'migrate: %s\n' "$*" >&2
}

_migrate_abs_dir() {
  ( cd "$1" 2>/dev/null && pwd -P )
}

_migrate_abs_file() {
  local dir base
  dir="$(_migrate_abs_dir "$(dirname "$1")")" || return 1
  base="$(basename "$1")"
  printf '%s/%s' "$dir" "$base"
}

_migrate_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

_migrate_is_linux() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ]
}

# Paths are embedded in `-v host:container:ro`, so a colon would corrupt the mount spec.
_migrate_path_is_mountable() {
  case "$1" in
    *:*|*$'\n'*) return 1 ;;
    *) return 0 ;;
  esac
}

_migrate_resolve_image() {
  if [ -n "${DP_MIGRATE_IMAGE:-}" ]; then
    case "$DP_MIGRATE_IMAGE" in
      [A-Za-z0-9]*) ;;
      *) return 1 ;;
    esac
    printf '%s' "$DP_MIGRATE_IMAGE"
    return 0
  fi

  docker inspect --format '{{.Image}}' "$MIGRATE_API_CONTAINER" 2>/dev/null
}

_migrate_app_version() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$MIGRATE_API_CONTAINER" 2>/dev/null |
    sed -n 's/^APP_VERSION=//p' | head -n 1
}

_migrate_credential_key() {
  local file line
  file="${MIGRATE_AUTH_ENV:-${INSTALL_ROOT:-/opt/deployment-platform}/config/auth.env}"
  [ -r "$file" ] || return 1
  line="$(grep -m1 '^CREDENTIAL_ENCRYPTION_KEY=' "$file" || true)"
  [ -n "$line" ] || return 1
  line="${line#CREDENTIAL_ENCRYPTION_KEY=}"
  line="${line%\"}"
  line="${line#\"}"
  [ -n "$line" ] || return 1
  printf '%s' "$line"
}

_migrate_run_tool() {
  local sub="$1"
  shift

  command -v docker >/dev/null 2>&1 || { _migrate_err "docker is not installed or not on PATH."; return 3; }

  local -a tool_args=("$sub")
  local -a mounts=()
  local free_bytes=""
  local dir file mode
  local out_dir_host=""

  # What kind of run this is. Phase 0 commands are read-only; `export` writes ONE new bundle and
  # may briefly stop/pause an app (always restoring it); `recover` undoes an interrupted export;
  # `signing-key` needs neither Docker nor the platform data.
  local kind="readonly"
  case "$sub" in
    export) kind="export" ;;
    recover) kind="recover" ;;
    signing-key) kind="keygen" ;;
  esac

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --helper-image|--helper-image=*)
        _migrate_err "--helper-image is chosen automatically (the platform's own image) and cannot be overridden here."
        return 2
        ;;
      --signing-key-file=*|--key-file=*|--hooks-file=*|--bundle-name=*)
        _migrate_err "write '${1%%=*} <value>' as two separate arguments."
        return 2
        ;;
      --signing-key-file|--key-file)
        [ "$#" -ge 2 ] || { _migrate_err "$1 needs a file."; return 2; }
        [ -f "$2" ] || { _migrate_err "$1: not a file: $2"; return 2; }
        file="$(_migrate_abs_file "$2")" || return 2
        _migrate_path_is_mountable "$file" || { _migrate_err "$1: the path may not contain ':' or a newline."; return 2; }
        if _migrate_is_linux; then
          mode="$(_migrate_file_mode "$file")"
          if [ -n "$mode" ] && [ $(( 8#$mode & 8#077 )) -ne 0 ]; then
            _migrate_err "the key file is readable by other users. Restrict it first: chmod 600 $2"
            return 2
          fi
        fi
        mounts+=(-v "${file}:/run/secrets/migration-signing-key:ro")
        tool_args+=("$1" /run/secrets/migration-signing-key)
        shift 2
        ;;
      --hooks-file)
        [ "$#" -ge 2 ] || { _migrate_err "--hooks-file needs a file."; return 2; }
        [ -f "$2" ] || { _migrate_err "--hooks-file: not a file: $2"; return 2; }
        file="$(_migrate_abs_file "$2")" || return 2
        _migrate_path_is_mountable "$file" || { _migrate_err "--hooks-file: the path may not contain ':' or a newline."; return 2; }
        mounts+=(-v "${file}:/migration/hooks.json:ro")
        tool_args+=(--hooks-file /migration/hooks.json)
        shift 2
        ;;
      --bundle-name)
        [ "$#" -ge 2 ] || { _migrate_err "--bundle-name needs a name."; return 2; }
        case "$2" in
          ''|*[!A-Za-z0-9._-]*|.*|-*) _migrate_err "--bundle-name may contain only letters, digits, '.', '_' and '-', and may not start with '.' or '-'."; return 2 ;;
        esac
        tool_args+=(--bundle-name "$2")
        shift 2
        ;;
      --passphrase|--passphrase=*|--password|--password=*|--passphrase-value|--passphrase-value=*)
        # Refused here, before anything reaches docker's argv (visible in the process list).
        _migrate_err "a passphrase is never accepted as an argument. Put it in a mode-600 file and pass --passphrase-file."
        return 2
        ;;
      --bundle=*|--passphrase-file=*|--destination-descriptor=*|--output-dir=*)
        _migrate_err "write '${1%%=*} <value>' as two separate arguments."
        return 2
        ;;
      --bundle)
        [ "$#" -ge 2 ] || { _migrate_err "--bundle needs a directory."; return 2; }
        dir="$(_migrate_abs_dir "$2")" || { _migrate_err "--bundle: not a directory: $2"; return 2; }
        _migrate_path_is_mountable "$dir" || { _migrate_err "--bundle: the path may not contain ':' or a newline."; return 2; }
        mounts+=(-v "${dir}:/migration/bundle:ro")
        tool_args+=(--bundle /migration/bundle)
        shift 2
        ;;
      --passphrase-file)
        [ "$#" -ge 2 ] || { _migrate_err "--passphrase-file needs a file."; return 2; }
        [ -f "$2" ] || { _migrate_err "--passphrase-file: not a file: $2"; return 2; }
        file="$(_migrate_abs_file "$2")" || return 2
        _migrate_path_is_mountable "$file" || { _migrate_err "--passphrase-file: the path may not contain ':' or a newline."; return 2; }
        if _migrate_is_linux; then
          mode="$(_migrate_file_mode "$file")"
          if [ -n "$mode" ] && [ $(( 8#$mode & 8#077 )) -ne 0 ]; then
            _migrate_err "the passphrase file is readable by other users. Restrict it first: chmod 600 $2"
            return 2
          fi
        fi
        mounts+=(-v "${file}:/run/secrets/migration-passphrase:ro")
        tool_args+=(--passphrase-file /run/secrets/migration-passphrase)
        shift 2
        ;;
      --destination-descriptor)
        [ "$#" -ge 2 ] || { _migrate_err "--destination-descriptor needs a file."; return 2; }
        [ -f "$2" ] || { _migrate_err "--destination-descriptor: not a file: $2"; return 2; }
        file="$(_migrate_abs_file "$2")" || return 2
        _migrate_path_is_mountable "$file" || { _migrate_err "--destination-descriptor: the path may not contain ':' or a newline."; return 2; }
        mounts+=(-v "${file}:/migration/destination.json:ro")
        tool_args+=(--destination-descriptor /migration/destination.json)
        shift 2
        ;;
      --output-dir)
        [ "$#" -ge 2 ] || { _migrate_err "--output-dir needs a directory."; return 2; }
        dir="$(_migrate_abs_dir "$2")" || { _migrate_err "--output-dir: not a directory: $2"; return 2; }
        if [ "$kind" = "export" ] || [ "$kind" = "keygen" ]; then
          # The one place anything is WRITTEN: a bundle (or a key) is created inside this directory.
          _migrate_path_is_mountable "$dir" || { _migrate_err "--output-dir: the path may not contain ':' or a newline."; return 2; }
          [ -w "$dir" ] || { _migrate_err "--output-dir is not writable: $2"; return 2; }
          out_dir_host="$dir"
          mounts+=(-v "${dir}:/migration/output:rw")
          tool_args+=(--output-dir /migration/output)
        else
          # The container cannot see this directory, so measure free space here and pass the number.
          free_bytes="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 { printf "%.0f", $4 * 1024 }')"
          [ -n "$free_bytes" ] || { _migrate_err "--output-dir: could not measure free space on $2"; return 2; }
        fi
        shift 2
        ;;
      *)
        tool_args+=("$1")
        shift
        ;;
    esac
  done

  if [ -n "$free_bytes" ]; then
    tool_args+=(--output-free-bytes "$free_bytes")
  fi

  local image
  image="$(_migrate_resolve_image)" || true
  if [ -z "$image" ]; then
    _migrate_err "could not find the ClovaForge API image (is the platform installed?). Set DP_MIGRATE_IMAGE to use a specific image."
    return 3
  fi

  # The tooling ships inside the API image; an older release does not have it yet.
  if ! docker run --rm --pull never --network none --entrypoint test "$image" -f "$MIGRATE_CLI_JS" >/dev/null 2>&1; then
    _migrate_err "this ClovaForge release does not include the migration tooling yet."
    _migrate_err "Update to a release that does, or set DP_MIGRATE_IMAGE to an image that includes it."
    return 3
  fi

  local -a docker_args=(
    run --rm --pull never
    --network none
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --cap-drop ALL --security-opt no-new-privileges
    --label "com.deployment-platform.migration-tool=${kind}"
  )

  # Writing runs get a proper init (so signals reach the exporter) and DAC_OVERRIDE (so root can
  # write into an output directory owned by another user). Read-only runs get neither.
  if [ "$kind" != "readonly" ]; then
    docker_args+=(--init)
  fi
  if [ "$kind" = "export" ] || [ "$kind" = "keygen" ]; then
    docker_args+=(--cap-add DAC_OVERRIDE)
  fi

  # A key-generation run needs neither Docker nor the platform's data.
  if [ "$kind" != "keygen" ]; then
    docker_args+=(
      -v /var/run/docker.sock:/var/run/docker.sock
      -e DATABASE_PATH=/data/deployment-platform.sqlite
    )

    # `docker run -v NAME:/data` silently CREATES a missing volume, which would be a change.
    # Only mount it if it already exists. Reading commands then report "no platform database";
    # writing commands refuse, since there is nothing to export or recover.
    if docker volume inspect "$MIGRATE_DATA_VOLUME" >/dev/null 2>&1; then
      docker_args+=(-v "${MIGRATE_DATA_VOLUME}:/data")
    elif [ "$kind" = "export" ] || [ "$kind" = "recover" ]; then
      _migrate_err "the platform data volume (${MIGRATE_DATA_VOLUME}) does not exist; there is nothing to ${sub}."
      return 3
    fi
  fi

  if [ "$kind" = "export" ] || [ "$kind" = "recover" ]; then
    # The recovery journal and the temporary database snapshot live here, on the HOST, so a
    # crashed export can always be recovered even if its container is gone.
    local state_root="${INSTALL_ROOT:-/opt/deployment-platform}/state/migration"
    mkdir -p "$state_root" 2>/dev/null && chmod 700 "$state_root" 2>/dev/null || true
    [ -d "$state_root" ] || { _migrate_err "could not create the state directory ${state_root}."; return 3; }
    docker_args+=(
      -v "${state_root}:/migration/state:rw"
      -e DP_MIGRATE_STATE_DIR=/migration/state
      -e "DP_MIGRATE_HELPER_IMAGE=${image}"
    )
  fi

  if [ "$kind" = "export" ]; then
    # The platform's configuration (secrets included) and proxy routes are READ-ONLY inputs.
    local host_root="${INSTALL_ROOT:-/opt/deployment-platform}"
    [ -d "${host_root}/config" ] && docker_args+=(-v "${host_root}/config:/migration/host/config:ro")
    [ -d "${host_root}/caddy/routes" ] && docker_args+=(-v "${host_root}/caddy/routes:/migration/host/caddy-routes:ro")
    # A named container: a second export started at the same time is refused by Docker itself.
    docker_args+=(--name "cfmig-export-$$")
  fi

  local version
  version="$(_migrate_app_version || true)"
  if [ -n "$version" ]; then
    docker_args+=(-e "APP_VERSION=${version}")
  fi

  # (Guarded: expanding an empty array is an error under `set -u` on older bash.)
  if [ "${#mounts[@]}" -gt 0 ]; then
    docker_args+=("${mounts[@]}")
  fi

  local key=""
  if [ "$kind" = "readonly" ] || [ "$kind" = "export" ]; then
    key="$(_migrate_credential_key || true)"
  fi

  case "$kind" in
    readonly) _migrate_err "inspecting in a disposable, read-only container; no service is stopped or modified." ;;
    export) _migrate_err "exporting in a disposable container. An app may be briefly stopped or paused for a consistent snapshot and is always restarted. Ctrl-C is safe." ;;
    recover) _migrate_err "checking for applications an interrupted export left stopped or paused…" ;;
    keygen) _migrate_err "key generation (no Docker access, no platform data)." ;;
  esac

  local rc=0
  if [ -n "$key" ]; then
    # Passed by NAME: the value is in this process's environment, never in argv.
    CREDENTIAL_ENCRYPTION_KEY="$key" docker "${docker_args[@]}" -e CREDENTIAL_ENCRYPTION_KEY \
      --entrypoint node "$image" "$MIGRATE_CLI_JS" "${tool_args[@]}" || rc=$?
  else
    docker "${docker_args[@]}" --entrypoint node "$image" "$MIGRATE_CLI_JS" "${tool_args[@]}" || rc=$?
  fi

  if [ "$kind" = "export" ]; then
    # 0/10 = done, 20 = refused before anything was touched, 2 = usage, 4/5 = the engine itself
    # already restored (or reported failing to restore) everything. Anything ELSE means the
    # container died abnormally — killed, out of memory — with no chance to clean up. The
    # container has exited, so no export is alive: recover right now rather than leave an app down.
    case "$rc" in
      0|10|20|2|4|5) ;;
      *)
        _migrate_err "the export container ended abnormally (status ${rc}). Checking whether any application was left stopped or paused…"
        _migrate_run_tool recover --force || true
        ;;
    esac
  fi

  return "$rc"
}

migrate_main() {
  local sub="${1:-}"
  [ "$#" -gt 0 ] && shift

  case "$sub" in
    describe|preflight|verify-bundle|export|recover|signing-key)
      _migrate_run_tool "$sub" "$@"
      ;;
    import)
      _migrate_err "'migrate import' is not available yet. Nothing was changed."
      _migrate_err "This release can inspect, verify and EXPORT; importing arrives in a later phase."
      return 2
      ;;
    ""|help|--help|-h)
      migrate_usage
      ;;
    *)
      _migrate_err "unknown command: ${sub}"
      migrate_usage >&2
      return 2
      ;;
  esac
}
