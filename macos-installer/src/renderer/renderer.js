const steps = ["VPS Access", "Platform Setup", "Source & Updates", "Review", "Install"];
const stageLabels = ["Connected to VPS", "Preflight passed", "Packages ready", "Docker ready", "Filesystem ready", "Secrets configured", "Source prepared", "API image", "Web image", "Caddy", "Platform", "Verify"];
let currentStep = 0;
let profiles = [];
let selectedProfile = null;
let running = false;
let startedAt = null;
let selectedCredentials = {};
let uninstallRunning = false;
let uninstallMode = "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const form = $("#install-form");
const log = $("#log");
const dashboardLog = $("#dashboard-log");

function formObject() {
  const data = new FormData(form);
  return {
    host: data.get("host"),
    sshUser: data.get("sshUser"),
    authMethod: data.get("authMethod"),
    sshPassword: data.get("sshPassword"),
    sudoPassword: data.get("sudoPassword"),
    privateKey: data.get("privateKey"),
    panelDomain: data.get("panelDomain"),
    appsDomain: data.get("appsDomain"),
    adminUsername: data.get("adminUsername"),
    adminPassword: data.get("adminPassword"),
    adminPasswordConfirm: data.get("adminPasswordConfirm"),
    repository: data.get("repository"),
  sourceRef: data.get("sourceRef"),
    githubToken: data.get("githubToken"),
    githubAccount: data.get("githubAccount"),
    githubRepository: data.get("githubRepository"),
    name: data.get("name"),
    enableAutoUpdates: data.has("enableAutoUpdates"),
    continueWithoutDns: data.has("continueWithoutDns")
  };
}

function selectedConfig() {
  return {
    ...selectedProfile,
    sshPassword: $("[name='sshPassword']").value,
    sudoPassword: $("[name='sudoPassword']").value,
    privateKey: selectedCredentials.privateKey || $("[name='privateKey']").value,
    sshPassword: selectedCredentials.sshPassword || $("[name='sshPassword']").value,
    sudoPassword: selectedCredentials.sudoPassword || $("[name='sudoPassword']").value
  };
}

function mmss(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function append(target, payload) {
  const source = payload.source ? `[${payload.source}] ` : "";
  const stamp = $("#timestamps")?.checked ? `${new Date().toLocaleTimeString()} ` : "";
  target.textContent += `${stamp}${source}${payload.text}`;
  const scrollToggle = target === log ? $("#autoscroll") : $("#dashboard-autoscroll");
  if (scrollToggle?.checked) target.scrollTop = target.scrollHeight;
}

function renderStepper() {
  $("#stepper").innerHTML = steps.map((step, index) => `<button type="button" class="${index === currentStep ? "active" : ""}" data-step-target="${index}">${index + 1}. ${step}</button>`).join("");
  $$(".step").forEach((node) => node.classList.toggle("hidden", Number(node.dataset.step) !== currentStep));
  $("#back-step").disabled = currentStep === 0 || running;
  $("#next-step").classList.toggle("hidden", currentStep === steps.length - 1);
  $("#install-button").classList.toggle("hidden", currentStep !== steps.length - 1);
  if (currentStep === 3) renderReview();
}

function renderStages(doneText = "") {
  $("#stage-list").innerHTML = stageLabels.map((label) => {
    const done = doneText.toLowerCase().includes(label.split(" ")[0].toLowerCase());
    return `<div class="stage ${done ? "done" : ""}"><span>${done ? "✓" : "○"}</span>${label}</div>`;
  }).join("");
}

function renderReview() {
  const data = formObject();
  $("#review-summary").innerHTML = `
    <dl>
      <dt>Server</dt><dd>${data.name || data.panelDomain || data.host}</dd>
      <dt>SSH</dt><dd>${data.sshUser}@${data.host} using ${data.authMethod}</dd>
      <dt>Panel</dt><dd>https://${data.panelDomain}</dd>
      <dt>Apps</dt><dd>*.${data.appsDomain}</dd>
      <dt>Source</dt><dd>${data.repository} @ ${data.sourceRef}</dd>
      <dt>Auto updates</dt><dd>${data.enableAutoUpdates ? "Enabled on VPS, every 30 minutes" : "Disabled"}</dd>
    </dl>`;
}

function renderProfiles() {
  const list = $("#profile-list");
  if (!profiles.length) {
    list.innerHTML = `<div class="empty">No saved servers yet.</div>`;
    showInstall();
    return;
  }
  list.innerHTML = profiles.map((profile) => `
    <button class="profile ${selectedProfile?.id === profile.id ? "active" : ""}" data-profile="${profile.id}" type="button">
      <strong>${profile.name}</strong>
      <span>${profile.panelDomain || profile.host}</span>
    </button>`).join("");
}

function showInstall(profile = null) {
  selectedProfile = profile;
  $("#install-view").classList.remove("hidden");
  $("#dashboard-view").classList.add("hidden");
  $("#section-eyebrow").textContent = "Installer";
  $("#page-title").textContent = "Add a server";
  $("#open-dashboard").disabled = true;
  if (profile) {
    for (const [name, value] of Object.entries({ host: profile.host, sshUser: profile.sshUser, panelDomain: profile.panelDomain, appsDomain: profile.appsDomain, repository: profile.repository, sourceRef: profile.sourceRef, name: profile.name })) {
      const field = $("[name='" + name + "']");
      if (field && value) field.value = value;
    }
  }
}

async function showDashboard(profile) {
  selectedProfile = profile;
  selectedCredentials = await window.installer.getCredentials(profile.id);
  $("#install-view").classList.add("hidden");
  $("#dashboard-view").classList.remove("hidden");
  $("#section-eyebrow").textContent = "Manager";
  $("#page-title").textContent = profile.name;
  $("#open-dashboard").disabled = false;
  $("#open-dashboard").onclick = () => window.open(`https://${profile.panelDomain}`);
  renderInstallationState(null);
  renderStatusCards();
  refreshStatus();
}

function renderInstallationState(installed) {
  const checking = installed === null;
  $("#installed-options").classList.toggle("hidden", !installed);
  $("#not-installed-view").classList.toggle("hidden", installed !== false);
  $("#dashboard-actions").classList.toggle("hidden", !installed);
  $("#open-dashboard").disabled = !installed;
  if (checking) $("#status-updated").textContent = "Checking installation...";
}

function renderStatusCards(status = {}) {
  const profile = selectedProfile || {};
  $("#status-cards").innerHTML = [
    ["Panel", profile.panelDomain ? `https://${profile.panelDomain}` : "Not set", "healthy"],
    ["VPS", profile.host || "Not set", "neutral"],
    ["Platform", status.api?.state || "Unknown", status.api?.state?.toLowerCase().includes("up") ? "healthy" : "warning"],
    ["GitHub", status.github?.connected ? "Connected as " + (status.github.username || "account") : "Disconnected", status.github?.connected ? "healthy" : "warning"],
    ["Auto Updates", status.updater?.enabled ? "Enabled" : "Unknown", status.updater?.enabled ? "healthy" : "warning"],
    ["Installed Version", status.api?.image || "Unknown", "neutral"]
  ].map(([label, value, tone]) => `<div class="status-row"><span class="status-label">${label}</span><strong class="status-value ${tone}"><i></i>${value}</strong></div>`).join("");
}

async function refreshStatus() {
  if (!selectedProfile) return;
  dashboardLog.textContent = "";
  const result = await window.installer.serverStatus(selectedConfig());
  if (result.code !== 0 || result.status?.installed === null) {
    renderInstallationState(null);
    $("#status-updated").textContent = "Could not check installation.";
    return;
  }
  renderInstallationState(result.status.installed);
  if (!result.status.installed) return;
  if (result.status) renderStatusCards(result.status);
  $("#status-updated").textContent = "Updated just now";
  const enabled = result.output?.includes("active") || result.output?.includes("enabled");
  $("#toggle-updates").dataset.command = enabled ? "disableUpdates" : "enableUpdates";
  $("#toggle-updates").textContent = enabled ? "Disable Auto Updates" : "Enable Auto Updates";
}

function setRunning(value) {
  running = value;
  $("#cancel-task").disabled = !value;
  $("#install-button").disabled = value;
  $("#next-step").disabled = value;
  if (value) {
    startedAt = Date.now();
    tickElapsed();
  }
}

function tickElapsed() {
  if (!running || !startedAt) return;
  $("#elapsed").textContent = mmss(Date.now() - startedAt);
  requestAnimationFrame(tickElapsed);
}

$("#next-step").addEventListener("click", () => {
  currentStep = Math.min(currentStep + 1, steps.length - 1);
  renderStepper();
});
$("#back-step").addEventListener("click", () => {
  currentStep = Math.max(currentStep - 1, 0);
  renderStepper();
});
$("#stepper").addEventListener("click", (event) => {
  const target = event.target.closest("[data-step-target]");
  if (!target || running) return;
  currentStep = Number(target.dataset.stepTarget);
  renderStepper();
});
$("#add-server").addEventListener("click", () => showInstall());
$("#install-on-server").addEventListener("click", () => {
  if (!selectedProfile) return;
  showInstall(selectedProfile);
  currentStep = 0;
  renderStepper();
});
$("#change-github").addEventListener("click", () => {
  if (!selectedProfile) return;
  const profile = selectedProfile;
  showInstall(profile);
  currentStep = 2;
  renderStepper();
});
async function openCredentialEditor() {
  if (!selectedProfile) return;
  const stored = await window.installer.getCredentials(selectedProfile.id);
  const editor = $("#credentials-form");
  editor.credentialHost.value = selectedProfile.host || "";
  editor.credentialUser.value = selectedProfile.sshUser || "";
  editor.credentialPassword.value = "";
  editor.credentialKey.value = "";
  editor.credentialSudo.value = "";
  editor.dataset.profileId = selectedProfile.id;
  $("#credential-result").textContent = stored ? "Existing secrets are stored securely. Blank fields keep them unchanged." : "";
  $("#credentials-modal").classList.remove("hidden");
}
function closeCredentialEditor() { $("#credentials-modal").classList.add("hidden"); }
function credentialInput() {
  const data = new FormData($("#credentials-form"));
  return { host: data.get("credentialHost"), sshUser: data.get("credentialUser"), authMethod: data.get("credentialAuth"), sshPassword: data.get("credentialPassword"), privateKey: data.get("credentialKey"), sudoPassword: data.get("credentialSudo") };
}
$("#edit-credentials").addEventListener("click", openCredentialEditor);
$("#close-credentials").addEventListener("click", closeCredentialEditor);
$("#cancel-credentials").addEventListener("click", closeCredentialEditor);
$$("#credentials-form input[name='credentialAuth']").forEach((input) => input.addEventListener("change", () => {
  const key = input.value === "key";
  $("#credential-password-field").classList.toggle("hidden", key);
  $("#credential-key-field").classList.toggle("hidden", !key);
  $("#credential-passphrase-field").classList.toggle("hidden", !key);
}));
$("#test-credentials").addEventListener("click", async () => {
  const result = await window.installer.testConnection(credentialInput());
  $("#credential-result").textContent = result.success ? "Connection succeeded." : "Connection failed: " + result.message;
  $("#credential-result").className = "inline-state " + (result.success ? "success" : "error");
});
$("#credentials-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = credentialInput();
  const resultNode = $("#credential-result");
  const test = await window.installer.testConnection(input);
  if (!test.success) {
    resultNode.textContent = "Test the new credentials successfully before saving.";
    resultNode.className = "inline-state error";
    return;
  }
  await window.installer.saveCredentials({ id: $("#credentials-form").dataset.profileId, credentials: input });
  selectedCredentials = input;
  selectedProfile.host = input.host;
  selectedProfile.sshUser = input.sshUser;
  profiles = profiles.map((profile) => profile.id === selectedProfile.id ? { ...profile, host: input.host, sshUser: input.sshUser } : profile);
  await window.installer.saveProfile(selectedProfile);
  renderProfiles();
  closeCredentialEditor();
  refreshStatus();
});
$("#test-connection").addEventListener("click", async () => {
  $("#connection-result").textContent = "Testing...";
  const result = await window.installer.testConnection(formObject());
  $("#connection-result").textContent = result.success ? `Connected. ${result.output || ""}` : `Connection failed: ${result.message}`;
  $("#connection-result").className = `inline-state ${result.success ? "success" : "error"}`;
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  currentStep = 4;
  renderStepper();
  renderStages();
  log.textContent = "";
  setRunning(true);
  await window.installer.start(formObject());
});
$("#cancel-task").addEventListener("click", () => window.installer.cancel());
$("#clear-log").addEventListener("click", () => { log.textContent = ""; });
$("#dashboard-clear").addEventListener("click", () => { dashboardLog.textContent = ""; });
function copyWithFeedback(button, text) {
  const original = button.textContent;
  navigator.clipboard.writeText(text).then(() => {
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 2200);
  });
}
$("#copy-log").addEventListener("click", (event) => copyWithFeedback(event.currentTarget, log.textContent));
$("#dashboard-copy").addEventListener("click", (event) => copyWithFeedback(event.currentTarget, dashboardLog.textContent));
$("#save-log").addEventListener("click", () => window.installer.saveLog(log.textContent));
$("#dashboard-save").addEventListener("click", () => window.installer.saveLog(dashboardLog.textContent));

$("#profile-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-profile]");
  if (!button) return;
  const profile = profiles.find((item) => item.id === button.dataset.profile);
  if (profile) showDashboard(profile);
  renderProfiles();
});

$$("[data-command]").forEach((button) => button.addEventListener("click", () => {
  if (!selectedProfile) return;
  dashboardLog.textContent = "";
  window.installer.serverCommand({ config: selectedConfig(), command: button.dataset.command });
}));
$$("[data-log]").forEach((button) => button.addEventListener("click", () => {
  if (!selectedProfile) return;
  dashboardLog.textContent = "";
  window.installer.startLogs({ config: selectedConfig(), kind: button.dataset.log, follow: false });
}));
$("#preview-uninstall").addEventListener("click", () => {
  if (!selectedProfile) return;
  if (uninstallRunning) return;
  uninstallMode = "preview";
  uninstallRunning = true;
  $("#preview-uninstall").disabled = true;
  $("#run-uninstall").disabled = true;
  $("#uninstall-status").textContent = "Preparing uninstall preview...";
  $("#uninstall-status").className = "task-status running";
  dashboardLog.textContent = "";
  append(dashboardLog, { source: "local", text: "Starting uninstall preview...\n" });
  window.installer.previewUninstall(selectedConfig());
});
$("#run-uninstall").addEventListener("click", () => {
  if (!selectedProfile) return;
  if (uninstallRunning) return;
  if (!window.confirm("Are you sure you want to uninstall Deployment Platform from this VPS?")) return;
  uninstallMode = "run";
  uninstallRunning = true;
  $("#preview-uninstall").disabled = true;
  $("#run-uninstall").disabled = true;
  $("#run-uninstall").textContent = "Uninstalling...";
  $("#uninstall-status").textContent = "Uninstall in progress. Keep this window open while the VPS is being changed...";
  $("#uninstall-status").className = "task-status running";
  dashboardLog.textContent = "";
  append(dashboardLog, { source: "local", text: "Starting uninstall...\n" });
  window.installer.uninstall({
    config: selectedConfig(),
    options: {
      deletePlatformData: $("#delete-platform-data").checked,
      deleteAppContainers: $("#delete-app-containers").checked,
      deleteAppVolumes: $("#delete-app-volumes").checked,
      deleteSecrets: $("#delete-secrets").checked,
      purgeAll: $("#purge-all").checked,
      confirmPhrase: $("#confirm-phrase").value
    }
  });
});

window.installer.onLog((payload) => {
  append(log, payload);
  renderStages(log.textContent);
  const line = payload.text.split("\n").filter(Boolean).pop();
  if (line) {
    const status = line.replace(/^\[[0-9/]+\]\s*/, "");
    const current = $("#current-stage");
    current.textContent = status;
    current.title = status;
    current.classList.toggle("long", status.length > 96);
  }
});
$("#test-github").addEventListener("click", async () => {
  const resultNode = $("#github-result");
  resultNode.textContent = "Testing account, repository visibility, branch, and contents access...";
  resultNode.className = "inline-state";
  const result = await window.installer.testGithub(formObject());
  resultNode.textContent = result.success
    ? "Connected as " + result.account + ". " + result.repositoryCount + " repositories accessible. " + (result.privateAccess ? "Private repository access confirmed. " : "") + "Contents: read permission confirmed."
    : result.message;
  resultNode.className = "inline-state " + (result.success ? "success" : "error");
  if (result.success && result.repositories) {
    $("#github-repository").innerHTML = '<option value="">Use first accessible repository</option>' + result.repositories.map((repo) => '<option value="' + repo.fullName + '">' + repo.fullName + (repo.private ? " (private)" : "") + "</option>").join("");
  }
});
window.installer.onServerLog((payload) => append(dashboardLog, payload));
window.installer.onLogsLog((payload) => append(dashboardLog, payload));
window.installer.onUninstallLog((payload) => append(dashboardLog, payload));
window.installer.onUninstallDone(({ code }) => {
  uninstallRunning = false;
  $("#preview-uninstall").disabled = false;
  $("#run-uninstall").disabled = false;
  $("#run-uninstall").textContent = "Run Uninstall";
  const status = $("#uninstall-status");
  if (code === 0) {
    status.textContent = uninstallMode === "preview" ? "Preview complete. No changes were made." : "Uninstall completed successfully.";
    status.className = "task-status success";
    append(dashboardLog, { source: "local", text: uninstallMode === "preview" ? "\nUninstall preview complete. No changes were made.\n" : "\nUninstall completed successfully.\n" });
    if (uninstallMode === "run") renderInstallationState(false);
  } else {
    status.textContent = uninstallMode === "preview" ? "Preview failed. Review the console for details." : "Uninstall failed. Review the console for details.";
    status.className = "task-status error";
    append(dashboardLog, { source: "local", text: uninstallMode === "preview" ? "\nUninstall preview failed.\n" : "\nUninstall failed.\n" });
  }
});
window.installer.onDone(async ({ code }) => {
  setRunning(false);
  append(log, { source: "local", text: code === 0 ? "\nInstall finished successfully.\n" : `\nInstall failed with exit code ${code}.\n` });
  profiles = await window.installer.listProfiles();
  selectedProfile = profiles[profiles.length - 1] || null;
  renderProfiles();
  if (code === 0 && selectedProfile) await window.installer.saveCredentials({ id: selectedProfile.id, credentials: formObject() });
  if (code === 0 && selectedProfile) showDashboard(selectedProfile);
});
window.installer.onServerDone(({ status }) => { if (status) renderStatusCards(status); });

(async function init() {
  profiles = await window.installer.listProfiles();
  selectedProfile = profiles[0] || null;
  renderStepper();
  renderStages();
  renderProfiles();
  if (selectedProfile) showDashboard(selectedProfile);
})();
