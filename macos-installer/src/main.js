const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

let mainWindow = null;
let activeInstall = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 840,
    minHeight: 640,
    title: "Deployment Platform Installer",
    backgroundColor: "#090d16",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requireField(input, key) {
  const value = String(input[key] ?? "").trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function validateDomain(value, label) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value)) {
    throw new Error(`${label} must be a real domain, like panel.example.com.`);
  }
}

function validateInstallInput(input) {
  const host = requireField(input, "host");
  const sshUser = requireField(input, "sshUser");
  const sshPassword = String(input.sshPassword ?? "");
  const panelDomain = requireField(input, "panelDomain");
  const appsDomain = requireField(input, "appsDomain");
  const adminUsername = requireField(input, "adminUsername");
  const adminPassword = String(input.adminPassword ?? "");
  const repository = requireField(input, "repository");
  const sourceRef = requireField(input, "sourceRef");

  if (!sshPassword) {
    throw new Error("sshPassword is required.");
  }
  if (adminPassword.length < 12) {
    throw new Error("Administrator password must be at least 12 characters.");
  }
  validateDomain(panelDomain, "Panel domain");
  validateDomain(appsDomain, "Apps base domain");
  if (panelDomain === appsDomain) {
    throw new Error("Panel domain and apps base domain must be different.");
  }
  if (!/^https:\/\/.+/.test(repository)) {
    throw new Error("Repository must be an https:// Git URL.");
  }
  if (!/^[A-Za-z0-9._/:-]+$/.test(sourceRef)) {
    throw new Error("Source ref contains unsupported characters.");
  }

  return {
    host,
    sshUser,
    sshPassword,
    panelDomain,
    appsDomain,
    adminUsername,
    adminPassword,
    repository,
    sourceRef,
    continueWithoutDns: Boolean(input.continueWithoutDns),
    enableAutoUpdates: input.enableAutoUpdates !== false
  };
}

function buildRemoteScript(config) {
  const continueFlag = config.continueWithoutDns ? "--continue-without-dns" : "";
  const autoUpdateFlag = config.enableAutoUpdates ? "1" : "0";

  return `set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
WORK_DIR="$(mktemp -d /tmp/deployment-platform-install.XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "[1/6] Preparing packages..."
apt-get update
apt-get install -y git curl ca-certificates

echo "[2/6] Cloning Deployment Platform..."
git clone --branch ${shellQuote(config.sourceRef)} --depth 1 --single-branch -- ${shellQuote(config.repository)} "$WORK_DIR/source"

echo "[3/6] Writing temporary administrator password file..."
install -m 600 /dev/null "$WORK_DIR/admin-password"
cat > "$WORK_DIR/admin-password" <<'DP_ADMIN_PASSWORD'
${config.adminPassword}
DP_ADMIN_PASSWORD
chmod 600 "$WORK_DIR/admin-password"

echo "[4/6] Installing Deployment Platform..."
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

if [ "${autoUpdateFlag}" = "1" ]; then
  echo "[5/6] Installing automatic updater..."
  install -m 755 /dev/stdin /usr/local/bin/deployment-platform-update <<'DP_UPDATE_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
INSTALL_ROOT="/opt/deployment-platform"
STATE_FILE="\${INSTALL_ROOT}/state/installer-state.json"
LOG_FILE="\${INSTALL_ROOT}/logs/update.log"
mkdir -p "\${INSTALL_ROOT}/logs"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) deployment-platform update ====="

json_field() {
  jq -r --arg f "$1" '.[$f] // empty' "$STATE_FILE"
}

current_image_tag() {
  docker inspect --format '{{.Config.Image}}' "$1" 2>/dev/null | awk -F: '{print $NF}'
}

is_semver() {
  [[ "$1" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]
}

next_version() {
  local current="$1"
  if is_semver "$current"; then
    IFS=. read -r major minor patch <<< "$current"
    printf '%s.%s.%s' "$major" "$minor" "$((patch + 1))"
  else
    printf '0.1.0'
  fi
}

repo="$(json_field sourceRepository)"
ref="$(json_field sourceRef)"
panel_domain="$(json_field panelDomain)"
current_commit="$(json_field sourceCommit)"

if [ -z "$repo" ] || [ -z "$ref" ]; then
  echo "No source repository/ref recorded; this install cannot auto-update."
  exit 0
fi

latest_commit="$(git ls-remote "$repo" "refs/heads/$ref" | awk '{print $1}' | head -n 1)"
if [ -z "$latest_commit" ]; then
  latest_commit="$(git ls-remote "$repo" "$ref" | awk '{print $1}' | head -n 1)"
fi
if [ -z "$latest_commit" ]; then
  echo "Could not resolve latest commit for $repo@$ref."
  exit 1
fi
if [ "$latest_commit" = "$current_commit" ]; then
  echo "Already current at $current_commit."
  exit 0
fi

tmp="$(mktemp -d /tmp/deployment-platform-update.XXXXXX)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
git clone --branch "$ref" --depth 1 --single-branch -- "$repo" "$tmp/source"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
short_commit="\${latest_commit:0:12}"
release_dir="\${INSTALL_ROOT}/source/releases/release-\${timestamp}-\${short_commit}"
mkdir -p "$release_dir"
rsync -a \\
  --exclude=.git \\
  --exclude=node_modules \\
  --exclude='**/dist' \\
  "$tmp/source/" "$release_dir/"

previous_api="$(current_image_tag deployment-platform-api)"
previous_web="$(current_image_tag deployment-platform-web)"
next_api="$(next_version "$previous_api")"
next_web="$(next_version "$previous_web")"

bash "$release_dir/scripts/release-remote.sh" \\
  --mode both \\
  --source-dir "$release_dir" \\
  --auth-file "\${INSTALL_ROOT}/config/auth.env" \\
  --platform-env-file "\${INSTALL_ROOT}/config/platform.env" \\
  --caddy-routes-dir "\${INSTALL_ROOT}/caddy/routes" \\
  --deploy-installer \\
  --install-root "$INSTALL_ROOT" \\
  --api-container deployment-platform-api \\
  --web-container deployment-platform-web \\
  --api-image-repo deployment-platform-api \\
  --web-image-repo deployment-platform-web \\
  --platform-network deployment-platform \\
  --apps-network deployment-apps \\
  --api-data-volume deployment-platform-api-data \\
  --api-version "$next_api" \\
  --web-version "$next_web" \\
  --previous-api-version "$previous_api" \\
  --previous-web-version "$previous_web" \\
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
else
  echo "[5/6] Automatic updater skipped."
fi

echo "[6/6] Verifying installation..."
deployment-platform verify
echo "Installation complete. Open: https://${config.panelDomain}"
`;
}

function buildExpectScript(config, remoteScriptPath) {
  return `set timeout 10
log_user 1
set password ${JSON.stringify(config.sshPassword)}
set script_path ${JSON.stringify(remoteScriptPath)}
set sent_script 0
spawn ssh -tt -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=~/.ssh/known_hosts ${config.sshUser}@${config.host} "cat > /tmp/deployment-platform-install.sh && chmod 700 /tmp/deployment-platform-install.sh && sudo bash /tmp/deployment-platform-install.sh; status=\\$?; rm -f /tmp/deployment-platform-install.sh; exit \\$status"
expect {
  -re "(?i)password:" {
    send -- "$password\\r"
    exp_continue
  }
  -re "(?i)are you sure you want to continue connecting" {
    send -- "yes\\r"
    exp_continue
  }
  timeout {
    if {$sent_script == 0} {
      set fh [open $script_path r]
      set body [read $fh]
      close $fh
      send -- "$body"
      send -- "\\004"
      set sent_script 1
      set timeout -1
    }
    exp_continue
  }
  eof {
    catch wait result
    if {[llength $result] >= 4} {
      exit [lindex $result 3]
    }
  }
}
`;
}

ipcMain.handle("install:start", async (_event, rawInput) => {
  if (activeInstall) {
    throw new Error("An installation is already running.");
  }

  const config = validateInstallInput(rawInput);
  const remoteScript = buildRemoteScript(config);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-platform-mac-installer-"));
  const remoteScriptPath = path.join(tempDir, "remote-install.sh");
  fs.writeFileSync(remoteScriptPath, remoteScript, { mode: 0o600 });
  const expectScript = buildExpectScript(config, remoteScriptPath);

  return await new Promise((resolve) => {
    const child = spawn("/usr/bin/expect", ["-c", expectScript], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeInstall = child;

    const sendLog = (chunk) => {
      mainWindow?.webContents.send("install:log", chunk.toString());
    };

    child.stdout.on("data", sendLog);
    child.stderr.on("data", sendLog);

    child.on("close", (code) => {
      activeInstall = null;
      fs.rmSync(tempDir, { recursive: true, force: true });
      mainWindow?.webContents.send("install:done", { code });
      resolve({ code });
    });
  });
});

ipcMain.handle("install:cancel", async () => {
  if (activeInstall) {
    activeInstall.kill("SIGTERM");
    activeInstall = null;
  }
  return { ok: true };
});
