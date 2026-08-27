function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const PROVIDER_TOKEN_SCRIPT = [
  'import { createAppDatabase } from "/app/apps/api/dist/database.js";',
  'import { loadGithubAppConfig } from "/app/apps/api/dist/services/github-app-config.js";',
  'import { resolveGithubToken } from "/app/apps/api/dist/services/github-token-service.js";',
  'const database = createAppDatabase(process.env.DATABASE_PATH || "/data/deployment-platform.sqlite");',
  'try {',
  '  const result = await resolveGithubToken({ appDatabase: database, githubAppConfig: loadGithubAppConfig() });',
  '  if (!result.success) process.exit(2);',
  '  process.stdout.write(result.token);',
  '} finally { database.close(); }'
].join("\n");

function uninstallFlags(options = {}) {
  const flags = ["--uninstall", "--non-interactive"];
  if (options.deletePlatformData) flags.push("--delete-platform-data");
  if (options.deleteAppContainers) flags.push("--delete-app-containers");
  if (options.deleteAppVolumes) flags.push("--delete-app-volumes");
  if (options.deleteSecrets) flags.push("--delete-secrets");
  if (options.purgeAll && options.confirmPhrase === "DELETE EVERYTHING") flags.push("--purge-all", "--confirm-purge");
  return flags;
}

function buildUninstallScript(options = {}, paths = {}, preview = false) {
  const installRoot = paths.installRoot || "/opt/deployment-platform";
  const stateFile = paths.stateFile || `${installRoot}/state/installer-state.json`;
  const installerPath = paths.installerPath || `${installRoot}/installer/install.sh`;
  const reusableCheckout = paths.reusableCheckout || `${installRoot}/source/repository`;
  const flags = uninstallFlags(options);
  const confirmation = flags.includes("--purge-all") ? "DELETE EVERYTHING\n" : "y\n";
  const runCommand = preview
    ? 'bash "$INSTALLER_PATH" --uninstall-preview'
    : `printf ${shellQuote(confirmation)} | bash "$INSTALLER_PATH" ${flags.join(" ")}`;

  return `set -Eeuo pipefail
INSTALL_ROOT=${shellQuote(installRoot)}
STATE_FILE=${shellQuote(stateFile)}
INSTALLER_PATH=${shellQuote(installerPath)}
REUSABLE_CHECKOUT=${shellQuote(reusableCheckout)}
REFRESH_ERROR="Could not refresh the Deployment Platform uninstaller from the configured source. Uninstall was not started."
WORK_DIR="$(mktemp -d /tmp/deployment-platform-uninstall-refresh.XXXXXX)"
cleanup_refresh() { rm -rf "$WORK_DIR"; }
trap cleanup_refresh EXIT
refresh_failed() { echo "$REFRESH_ERROR" >&2; exit 1; }

echo "Refreshing the Deployment Platform uninstaller from the configured source..."
[ -r "$STATE_FILE" ] || refresh_failed
repo="$(jq -r '.sourceRepository // empty' "$STATE_FILE" 2>/dev/null)" || refresh_failed
ref="$(jq -r '.sourceRef // empty' "$STATE_FILE" 2>/dev/null)" || refresh_failed
[ -n "$repo" ] && [ -n "$ref" ] || refresh_failed
case "$repo" in https://*) ;; *) refresh_failed ;; esac
repo_authority="\${repo#https://}"
repo_authority="\${repo_authority%%/*}"
case "$repo_authority" in *@*) refresh_failed ;; esac

token_file="$WORK_DIR/github-token"
credential_helper=""
umask 077
if [ "$repo_authority" = "github.com" ] && \
  docker inspect deployment-platform-api >/dev/null 2>&1 && \
  docker exec deployment-platform-api node --input-type=module -e ${shellQuote(PROVIDER_TOKEN_SCRIPT)} > "$token_file" 2>/dev/null && \
  [ -s "$token_file" ]; then
  credential_helper="$WORK_DIR/git-credential-helper.sh"
  cat > "$credential_helper" <<DP_CREDENTIAL_HELPER
#!/bin/sh
if [ "\\$1" = "get" ]; then
  printf 'username=x-access-token\\npassword='
  cat "$token_file"
  printf '\\n'
fi
exit 0
DP_CREDENTIAL_HELPER
  chmod 700 "$credential_helper"
else
  rm -f "$token_file"
fi

git_auth=()
[ -z "$credential_helper" ] || git_auth=(-c "credential.helper=$credential_helper")
fresh_installer="$WORK_DIR/install.sh"
if [ -d "$REUSABLE_CHECKOUT/.git" ] && [ "$(git -C "$REUSABLE_CHECKOUT" remote get-url origin 2>/dev/null || true)" = "$repo" ]; then
  git "\${git_auth[@]}" -C "$REUSABLE_CHECKOUT" fetch --quiet --depth 1 origin "$ref" || refresh_failed
  git -C "$REUSABLE_CHECKOUT" show FETCH_HEAD:installer/install.sh > "$fresh_installer" || refresh_failed
else
  checkout="$WORK_DIR/source"
  git "\${git_auth[@]}" clone --quiet --branch "$ref" --depth 1 --single-branch --no-tags -- "$repo" "$checkout" || refresh_failed
  [ -f "$checkout/installer/install.sh" ] || refresh_failed
  cp "$checkout/installer/install.sh" "$fresh_installer" || refresh_failed
fi

[ -s "$fresh_installer" ] || refresh_failed
mkdir -p "$(dirname "$INSTALLER_PATH")" || refresh_failed
install -m 755 "$fresh_installer" "$INSTALLER_PATH.new" || refresh_failed
mv -f "$INSTALLER_PATH.new" "$INSTALLER_PATH" || refresh_failed
[ -x "$INSTALLER_PATH" ] || refresh_failed
echo "Deployment Platform uninstaller refreshed."

${runCommand}`;
}

function buildUninstallPreviewScript(paths = {}) {
  return buildUninstallScript({}, paths, true);
}

module.exports = { buildUninstallPreviewScript, buildUninstallScript, uninstallFlags };
