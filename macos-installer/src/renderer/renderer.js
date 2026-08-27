const steps = ["VPS Access", "Platform Setup", "Source & Updates", "Review", "Install"];
const stageLabels = ["Connected to VPS", "Preflight passed", "Packages ready", "Docker ready", "Filesystem ready", "Secrets configured", "Source prepared", "API image", "Web image", "Caddy", "Platform", "Verify"];
let currentStep = 0;
let profiles = [];
let selectedProfile = null;
let running = false;
let startedAt = null;

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
    privateKey: $("[name='privateKey']").value
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

function showInstall() {
  selectedProfile = null;
  $("#install-view").classList.remove("hidden");
  $("#dashboard-view").classList.add("hidden");
  $("#section-eyebrow").textContent = "Installer";
  $("#page-title").textContent = "Add a server";
  $("#open-dashboard").disabled = true;
}

function showDashboard(profile) {
  selectedProfile = profile;
  $("#install-view").classList.add("hidden");
  $("#dashboard-view").classList.remove("hidden");
  $("#section-eyebrow").textContent = "Manager";
  $("#page-title").textContent = profile.name;
  $("#open-dashboard").disabled = false;
  $("#open-dashboard").onclick = () => window.open(`https://${profile.panelDomain}`);
  renderStatusCards();
  refreshStatus();
}

function renderStatusCards(status = {}) {
  const profile = selectedProfile || {};
  $("#status-cards").innerHTML = [
    ["Panel", profile.panelDomain ? `https://${profile.panelDomain}` : "Not set"],
    ["VPS", profile.host || "Not set"],
    ["Source", `${profile.repository || "repo"} @ ${profile.sourceRef || "main"}`],
    ["API", status.api?.state || "Unknown"],
    ["Web", status.web?.state || "Unknown"],
    ["Caddy", status.caddy?.state || "Unknown"]
  ].map(([label, value]) => `<article class="card"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

async function refreshStatus() {
  if (!selectedProfile) return;
  dashboardLog.textContent = "";
  const result = await window.installer.serverStatus(selectedConfig());
  if (result.status) renderStatusCards(result.status);
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
$("#add-server").addEventListener("click", showInstall);
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
$("#copy-log").addEventListener("click", () => navigator.clipboard.writeText(log.textContent));
$("#dashboard-copy").addEventListener("click", () => navigator.clipboard.writeText(dashboardLog.textContent));
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
  dashboardLog.textContent = "";
  window.installer.previewUninstall(selectedConfig());
});
$("#run-uninstall").addEventListener("click", () => {
  if (!selectedProfile) return;
  dashboardLog.textContent = "";
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
  if (line) $("#current-stage").textContent = line.replace(/^\[[0-9/]+\]\s*/, "").slice(0, 90);
});
window.installer.onServerLog((payload) => append(dashboardLog, payload));
window.installer.onLogsLog((payload) => append(dashboardLog, payload));
window.installer.onUninstallLog((payload) => append(dashboardLog, payload));
window.installer.onDone(async ({ code }) => {
  setRunning(false);
  append(log, { source: "local", text: code === 0 ? "\nInstall finished successfully.\n" : `\nInstall failed with exit code ${code}.\n` });
  profiles = await window.installer.listProfiles();
  selectedProfile = profiles[profiles.length - 1] || null;
  renderProfiles();
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
