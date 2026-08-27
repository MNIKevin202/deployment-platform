const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { Client } = require("ssh2");
const { buildProfile, parseStatus, redactSecrets, validateInstallInput } = require("./lib/core");

let mainWindow = null;
let activeSession = null;
const GITHUB_API = "https://api.github.com";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 940,
    minHeight: 660,
    title: "Deployment Platform Manager",
    backgroundColor: "#0a0d14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function profilesPath() {
  return path.join(app.getPath("userData"), "profiles.json");
}

function readProfiles() {
  try {
    return JSON.parse(fs.readFileSync(profilesPath(), "utf8"));
  } catch {
    return [];
  }
}

function writeProfiles(profiles) {
  fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
  fs.writeFileSync(profilesPath(), JSON.stringify(profiles, null, 2), { mode: 0o600 });
}

const KEYCHAIN_SERVICE = "com.deploymentplatform.manager";
function keychainAccount(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}
function readProfileCredentials(id) {
  try {
    return JSON.parse(execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(id), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return {};
  }
}
function writeProfileCredentials(id, credentials) {
  const existing = readProfileCredentials(id);
  const payload = JSON.stringify({
    authMethod: credentials.authMethod || existing.authMethod || "password",
    sshPassword: String(credentials.sshPassword || existing.sshPassword || ""),
    privateKey: String(credentials.privateKey || existing.privateKey || ""),
    sudoPassword: String(credentials.sudoPassword || existing.sudoPassword || "")
  });
  execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(id), "-w", payload], { stdio: "ignore" });
}

function saveProfile(profile) {
  const profiles = readProfiles();
  const index = profiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) profiles[index] = { ...profiles[index], ...profile, updatedAt: new Date().toISOString() };
  else profiles.push(profile);
  writeProfiles(profiles);
  return profiles;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function emit(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function makeSecrets(config) {
  return [config.sshPassword, config.privateKey, config.sudoPassword, config.adminPassword, config.githubToken].filter(Boolean);
}

async function githubRequest(token, pathname) {
  const response = await fetch(`${GITHUB_API}${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "DeploymentPlatform-Mac-Installer/1.0" }
  });
  if (response.status === 401) throw new Error("Token is invalid or expired.");
  if (response.status === 403) throw new Error("Token is valid, but GitHub denied this capability or rate limit was reached.");
  if (response.status === 404) throw new Error("The selected repository is outside the token's repository scope.");
  if (!response.ok) throw new Error("GitHub could not complete the requested check.");
  return response.json();
}

async function testGithubToken(input) {
  const token = String(input.githubToken || "").trim();
  if (!token) return { success: false, message: "Enter a GitHub fine-grained personal access token." };
  try {
    const account = await githubRequest(token, "/user");
    const repositories = await githubRequest(token, "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    if (!Array.isArray(repositories) || repositories.length === 0) {
      return { success: false, message: `Connected as ${account.login}, but no repositories are accessible.` };
    }
    const requested = String(input.githubRepository || "").trim();
    const candidate = requested.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)\.git$/i) || requested.match(/^([^/]+)\/([^/]+)$/);
    const repo = candidate ? repositories.find((item) => item.full_name.toLowerCase() === `${candidate[1]}/${candidate[2]}`.toLowerCase()) : repositories[0];
    if (candidate && !repo) return { success: false, message: "The selected repository is outside the token's repository scope." };
    const target = repo || repositories[0];
    await githubRequest(token, `/repos/${encodeURIComponent(target.owner.login)}/${encodeURIComponent(target.name)}`);
    await githubRequest(token, `/repos/${encodeURIComponent(target.owner.login)}/${encodeURIComponent(target.name)}/git/ref/heads/${encodeURIComponent(target.default_branch)}`);
    await githubRequest(token, `/repos/${encodeURIComponent(target.owner.login)}/${encodeURIComponent(target.name)}/contents/?ref=${encodeURIComponent(target.default_branch)}`);
    return { success: true, account: account.login, repositoryCount: repositories.length, privateAccess: repositories.some((item) => item.private), contentsAccess: true, repositories: repositories.slice(0, 100).map((item) => ({ fullName: item.full_name, private: item.private, defaultBranch: item.default_branch })) };
  } catch (error) {
    return { success: false, message: redactSecrets(error.message || "GitHub connection failed.", [token]) };
  }
}

class SshTransport {
  constructor(config, secrets) {
    this.config = config;
    this.secrets = secrets;
    this.client = new Client();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const connection = {
        host: this.config.host,
        username: this.config.sshUser,
        readyTimeout: 15000
      };
      if (this.config.authMethod === "key") {
        connection.privateKey = this.config.privateKey;
        if (this.config.sshPassword) connection.passphrase = this.config.sshPassword;
      } else {
        connection.password = this.config.sshPassword;
      }
      this.client.once("ready", resolve).once("error", reject).connect(connection);
    });
  }

  run(command, input, handlers = {}) {
    return new Promise((resolve, reject) => {
      this.client.exec(command, { pty: true }, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        activeSession = stream;
        stream.on("data", (chunk) => handlers.stdout?.(redactSecrets(chunk.toString(), this.secrets)));
        stream.stderr.on("data", (chunk) => handlers.stderr?.(redactSecrets(chunk.toString(), this.secrets)));
        stream.on("close", (code) => {
          activeSession = null;
          resolve(code ?? 0);
        });
        stream.end(input || "");
      });
    });
  }

  end() {
    this.client.end();
  }
}

function installUpdaterScript() {
  return `install -m 755 /dev/stdin /usr/local/bin/deployment-platform-update <<'DP_UPDATE_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
INSTALL_ROOT="/opt/deployment-platform"
STATE_FILE="\${INSTALL_ROOT}/state/installer-state.json"
LOG_FILE="\${INSTALL_ROOT}/logs/update.log"
mkdir -p "\${INSTALL_ROOT}/logs"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) deployment-platform update ====="

json_field() { jq -r --arg f "$1" '.[$f] // empty' "$STATE_FILE"; }
current_image_tag() { docker inspect --format '{{.Config.Image}}' "$1" 2>/dev/null | awk -F: '{print $NF}'; }
is_semver() { [[ "$1" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; }
next_version() {
  local current="$1"
  if is_semver "$current"; then IFS=. read -r major minor patch <<< "$current"; printf '%s.%s.%s' "$major" "$minor" "$((patch + 1))"; else printf '0.1.0'; fi
}

repo="$(json_field sourceRepository)"
ref="$(json_field sourceRef)"
panel_domain="$(json_field panelDomain)"
current_commit="$(json_field sourceCommit)"
[ -n "$repo" ] && [ -n "$ref" ] || { echo "No source repository/ref recorded; cannot auto-update."; exit 0; }

latest_commit="$(git ls-remote "$repo" "refs/heads/$ref" | awk '{print $1}' | head -n 1)"
[ -n "$latest_commit" ] || latest_commit="$(git ls-remote "$repo" "$ref" | awk '{print $1}' | head -n 1)"
[ -n "$latest_commit" ] || { echo "Could not resolve latest commit for $repo@$ref."; exit 1; }
[ "$latest_commit" != "$current_commit" ] || { echo "Already current at $current_commit."; exit 0; }

tmp="$(mktemp -d /tmp/deployment-platform-update.XXXXXX)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
git clone --branch "$ref" --depth 1 --single-branch -- "$repo" "$tmp/source"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
short_commit="\${latest_commit:0:12}"
release_dir="\${INSTALL_ROOT}/source/releases/release-\${timestamp}-\${short_commit}"
mkdir -p "$release_dir"
rsync -a --exclude=.git --exclude=node_modules --exclude='**/dist' "$tmp/source/" "$release_dir/"

previous_api="$(current_image_tag deployment-platform-api)"
previous_web="$(current_image_tag deployment-platform-web)"
next_api="$(next_version "$previous_api")"
next_web="$(next_version "$previous_web")"

bash "$release_dir/scripts/release-remote.sh" \\
  --mode both --source-dir "$release_dir" \\
  --auth-file "\${INSTALL_ROOT}/config/auth.env" \\
  --platform-env-file "\${INSTALL_ROOT}/config/platform.env" \\
  --caddy-routes-dir "\${INSTALL_ROOT}/caddy/routes" \\
  --deploy-installer --install-root "$INSTALL_ROOT" \\
  --api-container deployment-platform-api --web-container deployment-platform-web \\
  --api-image-repo deployment-platform-api --web-image-repo deployment-platform-web \\
  --platform-network deployment-platform --apps-network deployment-apps \\
  --api-data-volume deployment-platform-api-data \\
  --api-version "$next_api" --web-version "$next_web" \\
  --previous-api-version "$previous_api" --previous-web-version "$previous_web" \\
  --url-panel "https://\${panel_domain}" \\
  --current-symlink "\${INSTALL_ROOT}/source/current"
DP_UPDATE_SCRIPT

cat > /etc/systemd/system/deployment-platform-update.service <<'DP_UPDATE_SERVICE'
[Unit]
Description=Update Deployment Platform from its configured source repository
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/deployment-platform-update
DP_UPDATE_SERVICE

cat > /etc/systemd/system/deployment-platform-update.timer <<'DP_UPDATE_TIMER'
[Unit]
Description=Check for Deployment Platform updates every 30 minutes

[Timer]
OnBootSec=10min
OnUnitActiveSec=30min
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
DP_UPDATE_TIMER

systemctl daemon-reload
systemctl enable --now deployment-platform-update.timer
echo "Automatic updater installed and enabled."
`;
}

function buildInstallScript(config) {
  const continueFlag = config.continueWithoutDns ? "--continue-without-dns" : "";
  return `set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
WORK_DIR="$(mktemp -d /tmp/deployment-platform-install.XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; rm -f "/tmp/deployment-platform-github-token"; }
trap cleanup EXIT

echo "[1/8] Preparing packages..."
apt-get update
apt-get install -y git curl ca-certificates jq rsync

echo "[2/8] Cloning Deployment Platform source..."
git clone --branch ${shellQuote(config.sourceRef)} --depth 1 --single-branch -- ${shellQuote(config.repository)} "$WORK_DIR/source"

echo "[3/8] Writing temporary administrator password file..."
install -m 600 /dev/null "$WORK_DIR/admin-password"
cat > "$WORK_DIR/admin-password" <<'DP_ADMIN_PASSWORD'
${config.adminPassword}
DP_ADMIN_PASSWORD
chmod 600 "$WORK_DIR/admin-password"

echo "[4/8] Running non-destructive platform installer..."
bash "$WORK_DIR/source/installer/install.sh" \\
  --non-interactive \\
  --panel-domain ${shellQuote(config.panelDomain)} \\
  --apps-domain ${shellQuote(config.appsDomain)} \\
  --admin-username ${shellQuote(config.adminUsername)} \\
  --admin-password-file "$WORK_DIR/admin-password" \\
  --source-repository ${shellQuote(config.repository)} \\
  --source-ref ${shellQuote(config.sourceRef)} \\
  ${continueFlag}
rm -f "$WORK_DIR/admin-password"

echo "[5/8] Configuring VPS-local automatic updates..."
${config.enableAutoUpdates ? installUpdaterScript() : "echo \"Automatic updater skipped by operator.\""}

if [ -s ${shellQuote(config.githubTokenPath || "/tmp/deployment-platform-github-token")} ]; then
  echo "[6/8] Saving GitHub access in the platform credential store..."
  deployment-platform configure-github --token-file ${shellQuote(config.githubTokenPath || "/tmp/deployment-platform-github-token")}
  rm -f ${shellQuote(config.githubTokenPath || "/tmp/deployment-platform-github-token")}
else
  echo "[6/8] GitHub access not configured (no token supplied)."
fi

echo "[7/8] Capturing service status..."
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep '^deployment-platform-' || true
systemctl status deployment-platform-update.timer --no-pager || true

echo "[8/8] Verifying installation..."
deployment-platform verify
echo "Installation complete. Open: https://${config.panelDomain}"
`;
}

function buildStatusScript() {
  return `set -Eeuo pipefail
echo "__DP_SECTION__:containers"
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep '^deployment-platform-' || true
echo "__DP_SECTION__:state"
[ -f /opt/deployment-platform/state/installer-state.json ] && cat /opt/deployment-platform/state/installer-state.json || true
echo
echo "__DP_SECTION__:updater"
systemctl is-enabled deployment-platform-update.timer 2>/dev/null || true
systemctl is-active deployment-platform-update.timer 2>/dev/null || true
systemctl list-timers deployment-platform-update.timer --no-pager 2>/dev/null || true
echo "__DP_SECTION__:github"
deployment-platform github-status 2>/dev/null || true
echo "__DP_SECTION__:remote"
repo="$(jq -r '.sourceRepository // empty' /opt/deployment-platform/state/installer-state.json 2>/dev/null || true)"
ref="$(jq -r '.sourceRef // empty' /opt/deployment-platform/state/installer-state.json 2>/dev/null || true)"
current="$(jq -r '.sourceCommit // empty' /opt/deployment-platform/state/installer-state.json 2>/dev/null || true)"
latest=""
if [ -n "$repo" ] && [ -n "$ref" ]; then
  latest="$(git ls-remote "$repo" "refs/heads/$ref" | awk '{print $1}' | head -n 1)"
  [ -n "$latest" ] || latest="$(git ls-remote "$repo" "$ref" | awk '{print $1}' | head -n 1)"
fi
printf 'current=%s\\nlatest=%s\\n' "$current" "$latest"
`;
}

function buildLogScript(kind, follow) {
  const followFlag = follow ? "-f" : "";
  if (kind === "installer") return `tail ${followFlag} -n 400 /opt/deployment-platform/logs/installer.log 2>/dev/null || true`;
  if (kind === "updater") return `tail ${followFlag} -n 400 /opt/deployment-platform/logs/update.log 2>/dev/null || true`;
  if (["api", "web", "caddy"].includes(kind)) return `docker logs ${followFlag} --tail 300 deployment-platform-${kind}`;
  return "deployment-platform verify";
}

function buildUninstallScript(options = {}) {
  const flags = ["--uninstall", "--non-interactive"];
  if (options.deletePlatformData) flags.push("--delete-platform-data");
  if (options.deleteAppContainers) flags.push("--delete-app-containers");
  if (options.deleteAppVolumes) flags.push("--delete-app-volumes");
  if (options.deleteSecrets) flags.push("--delete-secrets");
  if (options.purgeAll && options.confirmPhrase === "DELETE EVERYTHING") flags.push("--purge-all", "--confirm-purge");
  const confirmation = flags.includes("--purge-all") ? "DELETE EVERYTHING\n" : "y\n";
  return `printf ${shellQuote(confirmation)} | bash /opt/deployment-platform/installer/install.sh ${flags.join(" ")}`;
}

function shellInput(script) {
  const value = String(script || "");
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function runRemote(config, script, eventPrefix, options = {}) {
  const secrets = makeSecrets(config);
  const transport = new SshTransport(config, secrets);
  emit(`${eventPrefix}:log`, { source: "local", text: "Opening SSH connection...\n" });
  let output = "";
  try {
    await transport.connect();
    emit(`${eventPrefix}:log`, { source: "local", text: "SSH connection established.\n" });
    const command = config.sshUser === "root" ? "bash -s" : "sudo -S -p '' bash -s";
    const input = config.sshUser === "root" ? shellInput(script) : `${config.sudoPassword || config.sshPassword}\n${shellInput(script)}`;
    const code = await transport.run(command, input, {
      stdout: (text) => { output += text; emit(`${eventPrefix}:log`, { source: "stdout", text }); },
      stderr: (text) => { output += text; emit(`${eventPrefix}:log`, { source: "stderr", text }); }
    });
    if (code === 0 && options.profile) saveProfile(options.profile);
    const payload = { code, output, status: parseStatus(output) };
    emit(`${eventPrefix}:done`, payload);
    return payload;
  } catch (error) {
    const message = redactSecrets(error.message || String(error), secrets);
    emit(`${eventPrefix}:log`, { source: "local", text: `ERROR: ${message}\n` });
    emit(`${eventPrefix}:done`, { code: 1, message, output });
    return { code: 1, message, output };
  } finally {
    transport.end();
  }
}

function connectionConfig(raw) {
  return {
    host: raw.host,
    sshUser: raw.sshUser,
    authMethod: raw.authMethod || "password",
    sshPassword: raw.sshPassword || "",
    privateKey: raw.privateKey || "",
    sudoPassword: raw.sudoPassword || ""
  };
}

ipcMain.handle("profiles:list", () => readProfiles());
ipcMain.handle("profiles:remove", (_event, id) => {
  writeProfiles(readProfiles().filter((profile) => profile.id !== id));
  return readProfiles();
});
ipcMain.handle("profiles:save", (_event, profile) => saveProfile(profile));
ipcMain.handle("profiles:credentials", (_event, id) => readProfileCredentials(id));
ipcMain.handle("profiles:saveCredentials", (_event, { id, credentials }) => {
  writeProfileCredentials(id, credentials);
  return { saved: true };
});

ipcMain.handle("ssh:test", async (_event, rawInput) => {
  const config = connectionConfig(rawInput);
  const transport = new SshTransport(config, makeSecrets(config));
  try {
    await transport.connect();
    const chunks = [];
    const code = await transport.run("printf 'connected\\n'; uname -a", "", {
      stdout: (text) => chunks.push(text),
      stderr: (text) => chunks.push(text)
    });
    return { success: code === 0, output: chunks.join("") };
  } catch (error) {
    return { success: false, message: redactSecrets(error.message || String(error), makeSecrets(config)) };
  } finally {
    transport.end();
  }
});
ipcMain.handle("github:test", async (_event, rawInput) => testGithubToken(rawInput));

ipcMain.handle("install:start", async (_event, rawInput) => {
  const config = validateInstallInput(rawInput);
  const tokenPath = "/tmp/deployment-platform-github-token";
  config.githubTokenPath = tokenPath;
  const secrets = makeSecrets(config);
  const transport = new SshTransport(config, secrets);
  emit("install:log", { source: "local", text: "Opening SSH connection...\n" });
  try {
    await transport.connect();
    emit("install:log", { source: "local", text: "SSH connection established.\n" });
    if (config.githubToken) {
      const tokenCode = await transport.run(`umask 077; install -m 600 /dev/stdin ${shellQuote(tokenPath)}`, config.githubToken);
      if (tokenCode !== 0) throw new Error("Could not securely transfer the GitHub token to the VPS.");
    }
    let output = "";
    const command = config.sshUser === "root" ? "bash -s" : "sudo -S -p '' bash -s";
    const installInput = config.sshUser === "root" ? buildInstallScript(config) : String(config.sudoPassword || config.sshPassword) + "\n" + buildInstallScript(config);
    const code = await transport.run(command, installInput, { stdout: (text) => { output += text; emit("install:log", { source: "stdout", text }); }, stderr: (text) => { output += text; emit("install:log", { source: "stderr", text }); } });
    if (code === 0) saveProfile(buildProfile({ ...config, githubAccount: rawInput.githubAccount || "", githubRepository: rawInput.githubRepository || "" }));
    const payload = { code, output, status: parseStatus(output), githubConfigured: Boolean(config.githubToken) };
    emit("install:done", payload);
    return payload;
  } catch (error) {
    const message = redactSecrets(error.message || String(error), secrets);
    emit("install:log", { source: "local", text: `ERROR: ${message}\n` });
    emit("install:done", { code: 1, message, output: "" });
    return { code: 1, message, output: "" };
  } finally {
    transport.end();
  }
});

ipcMain.handle("server:status", async (_event, config) => runRemote(connectionConfig(config), buildStatusScript(), "server"));
ipcMain.handle("server:command", async (_event, { config, command }) => {
  const commands = {
    verify: "deployment-platform verify",
    restart: "docker restart deployment-platform-api deployment-platform-web deployment-platform-caddy",
    update: "deployment-platform-update",
    enableUpdates: "systemctl enable --now deployment-platform-update.timer",
    disableUpdates: "systemctl disable --now deployment-platform-update.timer"
  };
  return runRemote(connectionConfig(config), commands[command] || commands.verify, "server");
});
ipcMain.handle("logs:start", async (_event, { config, kind, follow }) => runRemote(connectionConfig(config), buildLogScript(kind, follow), "logs"));
ipcMain.handle("uninstall:preview", async (_event, config) => runRemote(connectionConfig(config), "bash /opt/deployment-platform/installer/install.sh --uninstall-preview", "uninstall"));
ipcMain.handle("uninstall:start", async (_event, { config, options }) => runRemote(connectionConfig(config), buildUninstallScript(options), "uninstall"));
ipcMain.handle("dialog:saveLog", async (_event, text) => {
  const result = await dialog.showSaveDialog(mainWindow, { title: "Save Log", defaultPath: "deployment-platform.log" });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, text);
  return { saved: true, path: result.filePath };
});
ipcMain.handle("task:cancel", async () => {
  if (activeSession) {
    activeSession.close();
    activeSession = null;
  }
  return { ok: true };
});
