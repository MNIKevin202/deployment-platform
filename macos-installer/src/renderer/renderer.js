const form = document.querySelector("#install-form");
const installButton = document.querySelector("#install-button");
const cancelButton = document.querySelector("#cancel-button");
const copyButton = document.querySelector("#copy-log");
const statusText = document.querySelector("#status");
const logEl = document.querySelector("#log");

function appendLog(text) {
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  installButton.disabled = running;
  cancelButton.disabled = !running;
  statusText.textContent = running ? "Installing..." : "Ready.";
}

function collectForm() {
  const data = new FormData(form);
  return {
    host: data.get("host"),
    sshUser: data.get("sshUser"),
    sshPassword: data.get("sshPassword"),
    panelDomain: data.get("panelDomain"),
    appsDomain: data.get("appsDomain"),
    adminUsername: data.get("adminUsername"),
    adminPassword: data.get("adminPassword"),
    repository: data.get("repository"),
    sourceRef: data.get("sourceRef"),
    continueWithoutDns: data.has("continueWithoutDns"),
    enableAutoUpdates: data.has("enableAutoUpdates")
  };
}

window.installer.onLog((chunk) => appendLog(chunk));

window.installer.onDone(({ code }) => {
  setRunning(false);
  if (code === 0) {
    statusText.textContent = "Install complete.";
    appendLog("\nInstall finished successfully.\n");
  } else {
    statusText.textContent = `Install failed with exit code ${code}.`;
    appendLog(`\nInstall failed with exit code ${code}.\n`);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  logEl.textContent = "";
  setRunning(true);

  try {
    await window.installer.start(collectForm());
  } catch (error) {
    setRunning(false);
    statusText.textContent = error instanceof Error ? error.message : "Install failed.";
    appendLog(`${statusText.textContent}\n`);
  }
});

cancelButton.addEventListener("click", async () => {
  await window.installer.cancel();
  setRunning(false);
  statusText.textContent = "Cancelled.";
  appendLog("\nInstall cancelled.\n");
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(logEl.textContent);
  copyButton.textContent = "Copied";
  setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1200);
});
