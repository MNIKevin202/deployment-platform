/**
 * Thin HTTP client for the Quipora Bot's own internal admin API — the bot
 * exposes a small `node:http` server (see apps/irc-bot/src/admin-server.ts)
 * reachable only from other containers on the deployment-apps Docker
 * network, the same network deployment-platform-api itself is attached to.
 * Reaching it is just a normal fetch() by the container's DNS name, the
 * same trick irc-client-service.ts uses for a raw IRC connection.
 */

const REQUEST_TIMEOUT_MS = 5000;

/** Whether an image is our Quipora Bot template, for showing the Bot Settings tab. */
export function isIrcBotImage(image: string): boolean {
  return imageRepoName(image) === "quipora-bot";
}

function imageRepoName(image: string): string {
  let ref = image.trim();

  const at = ref.indexOf("@");
  if (at >= 0) {
    ref = ref.slice(0, at);
  }

  const lastSlash = ref.lastIndexOf("/");
  let name = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;

  const colon = name.indexOf(":");
  if (colon >= 0) {
    name = name.slice(0, colon);
  }

  return name.toLowerCase();
}

export interface BotStatus {
  connected: boolean;
  nick: string;
  nickRegistered: boolean;
  joinedChannels: string[];
}

export interface BotConfig {
  welcomeMessageTemplate: string;
  commandPrefix: string;
  rulesText: string;
  botCommands: Record<string, string>;
  bannedWords: string[];
  moderationAction: "warn" | "kick";
  nickRegistered: boolean;
}

export interface RegisterNickResult {
  ok: boolean;
  message: string;
}

export class BotAdminUnreachableError extends Error {}

function botAdminUrl(containerName: string, containerPort: number, path: string): string {
  return `http://${containerName}:${containerPort}${path}`;
}

async function botFetch(
  containerName: string,
  containerPort: number,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(botAdminUrl(containerName, containerPort, path), {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    throw new BotAdminUnreachableError(
      `Unable to reach the bot's admin API: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getBotStatus(containerName: string, containerPort: number): Promise<BotStatus> {
  const response = await botFetch(containerName, containerPort, "/status");
  if (!response.ok) {
    throw new BotAdminUnreachableError(`Bot admin API returned ${response.status}`);
  }
  return (await response.json()) as BotStatus;
}

export async function getBotConfig(containerName: string, containerPort: number): Promise<BotConfig> {
  const response = await botFetch(containerName, containerPort, "/config");
  if (!response.ok) {
    throw new BotAdminUnreachableError(`Bot admin API returned ${response.status}`);
  }
  return (await response.json()) as BotConfig;
}

export async function updateBotConfig(
  containerName: string,
  containerPort: number,
  patch: Record<string, unknown>
): Promise<{ ok: true; config: BotConfig } | { ok: false; status: number; message: string }> {
  const response = await botFetch(containerName, containerPort, "/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });

  const body = await response.json();
  if (!response.ok) {
    return { ok: false, status: response.status, message: (body as { message?: string }).message ?? "Update failed" };
  }
  return { ok: true, config: body as BotConfig };
}

export async function getBotBlockedChannels(containerName: string, containerPort: number): Promise<string[]> {
  const response = await botFetch(containerName, containerPort, "/blocked-channels");
  if (!response.ok) {
    throw new BotAdminUnreachableError(`Bot admin API returned ${response.status}`);
  }
  const body = (await response.json()) as { channels: string[] };
  return body.channels;
}

export async function blockChannelViaBot(
  containerName: string,
  containerPort: number,
  channel: string
): Promise<{ status: number; result: RegisterNickResult }> {
  const response = await botFetch(containerName, containerPort, "/blocked-channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel })
  });
  const result = (await response.json()) as RegisterNickResult;
  return { status: response.status, result };
}

export async function unblockChannelViaBot(
  containerName: string,
  containerPort: number,
  channel: string
): Promise<{ status: number; result: RegisterNickResult }> {
  const response = await botFetch(containerName, containerPort, `/blocked-channels/${encodeURIComponent(channel)}`, {
    method: "DELETE"
  });
  const result = (await response.json()) as RegisterNickResult;
  return { status: response.status, result };
}

export interface BotAppCandidate {
  id: number;
  image: string;
  containerName: string | null;
  containerId: string | null;
}

export interface EnvVarLookup {
  key: string;
  value: string;
}

/**
 * Finds the Quipora Bot app that's configured to point at a given IRC
 * server container. There's no formal link between the two apps — the
 * bot's own IRC_HOST env var (set at deploy time, defaulting to
 * "app-quipora-irc") is the only available signal, so this scans every
 * bot-image app for one whose IRC_HOST matches. Returns null if none match
 * (or more than one candidate app resolves ambiguously — first match wins,
 * same as any other "find" semantics).
 */
export function findLinkedBotApp(
  apps: BotAppCandidate[],
  envVarsByAppId: (appId: number) => EnvVarLookup[],
  ircContainerName: string
): BotAppCandidate | null {
  for (const app of apps) {
    if (!isIrcBotImage(app.image)) {
      continue;
    }
    const hostVar = envVarsByAppId(app.id).find((v) => v.key === "IRC_HOST");
    if (hostVar?.value === ircContainerName) {
      return app;
    }
  }
  return null;
}

export async function registerBotNick(
  containerName: string,
  containerPort: number,
  password: string,
  email?: string
): Promise<{ status: number; result: RegisterNickResult }> {
  const response = await botFetch(containerName, containerPort, "/register-nick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(email ? { password, email } : { password })
  });

  const result = (await response.json()) as RegisterNickResult;
  return { status: response.status, result };
}
