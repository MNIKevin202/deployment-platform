const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");

const projectRoot = resolve(__dirname, "../..");
const updater = join(projectRoot, "installer/templates/deployment-platform-update.template");

function executable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("manager installs the canonical updater shipped by the installer", () => {
  const main = readFileSync(join(projectRoot, "macos-installer/src/main.js"), "utf8");
  assert.match(main, /installer\/templates\/deployment-platform-update\.template \/usr\/local\/bin\/deployment-platform-update/);
  assert.doesNotMatch(main, /DP_UPDATE_SCRIPT/);
});

test("updater skips occupied image tags and records the deployed commit", () => {
  const root = mkdtempSync(join(tmpdir(), "deployment-platform-updater-test-"));
  try {
    const installRoot = join(root, "opt/deployment-platform");
    const fakeBin = join(root, "bin");
    mkdirSync(join(installRoot, "state"), { recursive: true });
    mkdirSync(join(installRoot, "logs"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(installRoot, "state/installer-state.json"), JSON.stringify({
      sourceRepository: "https://github.com/example/private.git",
      sourceRef: "main",
      sourceCommit: "old-commit",
      panelDomain: "panel.example.com"
    }));

    executable(join(fakeBin, "docker"), `#!/usr/bin/env bash
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then echo "deployment-platform-api:bootstrap-old"; exit 0; fi
if [ "$1" = "inspect" ]; then exit 1; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  case "$3" in *:0.1.0) exit 0;; *) exit 1;; esac
fi
exit 1
`);
    executable(join(fakeBin, "git"), `#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  destination="\${@: -1}"
  mkdir -p "$destination/scripts"
  cat > "$destination/scripts/release-remote.sh" <<'RELEASE'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$UPDATER_ARGS_FILE"
RELEASE
  chmod 755 "$destination/scripts/release-remote.sh"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then echo "new-commit-123"; exit 0; fi
exit 1
`);
    executable(join(fakeBin, "chown"), "#!/usr/bin/env bash\nexit 0\n");

    const argsFile = join(root, "release-args");
    const result = spawnSync("bash", [updater], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        INSTALL_ROOT: installRoot,
        STATE_FILE: join(installRoot, "state/installer-state.json"),
        LOG_FILE: join(installRoot, "logs/update.log"),
        UPDATER_ARGS_FILE: argsFile
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(argsFile), true, result.stdout || result.stderr);
    const releaseArgs = readFileSync(argsFile, "utf8");
    assert.match(releaseArgs, /--api-version\n0\.1\.1/);
    assert.match(releaseArgs, /--web-version\n0\.1\.1/);
    const state = JSON.parse(readFileSync(join(installRoot, "state/installer-state.json"), "utf8"));
    assert.equal(state.sourceCommit, "new-commit-123");
    assert.equal(state.apiImage, "deployment-platform-api:0.1.1");
    assert.equal(state.webImage, "deployment-platform-web:0.1.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updater retrieves private GitHub credentials without putting a token in argv", () => {
  const source = readFileSync(updater, "utf8");
  assert.match(source, /resolveGithubToken/);
  assert.match(source, /credential\.helper=\$credential_helper/);
  assert.match(source, /> "\$token_file" 2>\/dev\/null/);
  assert.doesNotMatch(source, /https:\/\/[^\s"']*\$token/);
});
