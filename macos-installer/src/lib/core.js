const SECRET_PATTERNS = [
  /(password\s*[:=]\s*)([^\s]+)/gi,
  /(token\s*[:=]\s*)([^\s]+)/gi,
  /(secret\s*[:=]\s*)([^\s]+)/gi,
  /(key\s*[:=]\s*)([^\s]+)/gi,
  /(ADMIN_PASSWORD_HASH=)([^\s]+)/g,
  /(SESSION_SECRET=)([^\s]+)/g,
  /(CREDENTIAL_ENCRYPTION_KEY=)([^\s]+)/g,
  /(gh[pousr]_[A-Za-z0-9_]+)/g
];

const INSTALL_STAGES = [
  { id: "connect", label: "Connected to VPS", match: /SSH connection established|Connected to VPS/i },
  { id: "preflight", label: "Preflight passed", match: /PRE-FLIGHT|pre-flight checks passed|Resources meet/i },
  { id: "packages", label: "Packages ready", match: /Installing base packages|Preparing packages|Packages/i },
  { id: "docker", label: "Docker ready", match: /Docker|docker daemon/i },
  { id: "filesystem", label: "Filesystem ready", match: /FILESYSTEM|filesystem/i },
  { id: "secrets", label: "Secrets configured", match: /SECRETS|secret/i },
  { id: "source", label: "Source prepared", match: /SOURCE|Cloning Deployment Platform|Source identity/i },
  { id: "api-image", label: "API image built", match: /API image built|deployment-platform-api/i },
  { id: "web-image", label: "Web image built", match: /Web image built|deployment-platform-web/i },
  { id: "caddy", label: "Caddy ready", match: /CADDY|Caddy/i },
  { id: "platform", label: "Platform started", match: /PLATFORM STARTUP|Platform started|container started/i },
  { id: "verify", label: "Verification passed", match: /VERIFICATION|Verification complete|Installation complete/i }
];

function redactSecrets(text, explicitSecrets = []) {
  let redacted = String(text ?? "");
  for (const secret of explicitSecrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix) => `${prefix ?? ""}[redacted]`);
  }
  redacted = redacted.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  redacted = redacted.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
  return redacted;
}

function updateStagesFromOutput(stages, output) {
  const next = stages.map((stage) => ({ ...stage }));
  let highestCompleted = -1;
  for (let index = 0; index < INSTALL_STAGES.length; index += 1) {
    if (INSTALL_STAGES[index].match.test(output)) {
      highestCompleted = index;
    }
  }
  if (highestCompleted < 0) {
    return next;
  }
  for (let index = 0; index <= highestCompleted; index += 1) {
    next[index].status = "done";
  }
  if (highestCompleted + 1 < next.length) {
    next[highestCompleted + 1].status = "active";
  }
  return next;
}

function initialStages() {
  return INSTALL_STAGES.map((stage, index) => ({
    id: stage.id,
    label: stage.label,
    status: index === 0 ? "active" : "pending"
  }));
}

function validateDomain(value, label) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value)) {
    throw new Error(`${label} must be a real domain, like panel.example.com.`);
  }
}

function requireField(input, key, label = key) {
  const value = String(input[key] ?? "").trim();
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function validateInstallInput(input) {
  const host = requireField(input, "host", "VPS host");
  const sshUser = requireField(input, "sshUser", "SSH username");
  const authMethod = input.authMethod === "key" ? "key" : "password";
  const sshPassword = String(input.sshPassword ?? "");
  const privateKey = String(input.privateKey ?? "");
  const sudoPassword = String(input.sudoPassword ?? "");
  const panelDomain = requireField(input, "panelDomain", "Panel domain");
  const appsDomain = requireField(input, "appsDomain", "Apps base domain");
  const adminUsername = requireField(input, "adminUsername", "Admin username");
  const adminPassword = String(input.adminPassword ?? "");
  const adminPasswordConfirm = String(input.adminPasswordConfirm ?? input.adminPassword ?? "");
  const repository = requireField(input, "repository", "GitHub repository");
  const sourceRef = requireField(input, "sourceRef", "Branch/tag/ref");

  if (authMethod === "password" && !sshPassword) {
    throw new Error("SSH password is required.");
  }
  if (authMethod === "key" && !privateKey.trim()) {
    throw new Error("SSH private key is required.");
  }
  if (adminPassword.length < 12) {
    throw new Error("Administrator password must be at least 12 characters.");
  }
  if (adminPassword !== adminPasswordConfirm) {
    throw new Error("Administrator passwords do not match.");
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
    authMethod,
    sshPassword,
    privateKey,
    sudoPassword,
    panelDomain,
    appsDomain,
    adminUsername,
    adminPassword,
    repository,
    sourceRef,
    continueWithoutDns: Boolean(input.continueWithoutDns),
    enableAutoUpdates: input.enableAutoUpdates !== false,
    name: String(input.name ?? panelDomain).trim() || panelDomain
  };
}

function parseStatus(raw) {
  const text = String(raw ?? "");
  const image = (name) => text.match(new RegExp(`${name}\\s+(\\S+)\\s+([^\\n]+)`, "i"));
  const api = image("deployment-platform-api");
  const web = image("deployment-platform-web");
  const caddy = image("deployment-platform-caddy");
  return {
    api: api ? { image: api[1], state: api[2].trim() } : null,
    web: web ? { image: web[1], state: web[2].trim() } : null,
    caddy: caddy ? { image: caddy[1], state: caddy[2].trim() } : null
  };
}

function buildProfile(input) {
  return {
    id: input.id || `server-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: input.name || input.panelDomain || input.host,
    host: input.host,
    sshUser: input.sshUser,
    authMethod: input.authMethod || "password",
    panelDomain: input.panelDomain,
    appsDomain: input.appsDomain,
    repository: input.repository,
    sourceRef: input.sourceRef || "main",
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  INSTALL_STAGES,
  buildProfile,
  initialStages,
  parseStatus,
  redactSecrets,
  updateStagesFromOutput,
  validateInstallInput
};
