export type NotificationType = "discord" | "slack" | "generic";

export interface NotificationConfig {
  enabled: boolean;
  type: NotificationType;
  webhookUrl: string;
}

export interface DeployEventInput {
  eventType: string;
  message: string;
  severity?: string;
}

/** Deploy-outcome events worth notifying about (not the noisy in-progress ones). */
const NOTIFY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "github-deploy-succeeded",
  "github-deploy-failed",
  "github-deploy-rolled-back",
  "revert-succeeded",
  "revert-failed"
]);

export function shouldNotify(eventType: string): boolean {
  return NOTIFY_EVENT_TYPES.has(eventType);
}

const EMOJI: Record<string, string> = {
  "github-deploy-succeeded": "✅",
  "github-deploy-failed": "❌",
  "github-deploy-rolled-back": "↩️",
  "revert-succeeded": "↩️",
  "revert-failed": "❌"
};

export function formatDeployMessage(input: DeployEventInput): string {
  const emoji = EMOJI[input.eventType] ?? "ℹ️";
  return `${emoji} ${input.message}`;
}

/** Shapes the request body for the configured webhook flavor. */
export function buildWebhookPayload(type: NotificationType, text: string): unknown {
  switch (type) {
    case "discord":
      return { content: text };
    case "slack":
      return { text };
    case "generic":
    default:
      return { text };
  }
}

function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

const defaultFetch: FetchImpl = (url, init) =>
  fetch(url, init) as unknown as Promise<{ ok: boolean; status: number }>;

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Posts a single message to the configured webhook. Never throws. */
export async function sendNotification(
  config: NotificationConfig,
  text: string,
  fetchImpl: FetchImpl = defaultFetch
): Promise<SendResult> {
  if (!config.webhookUrl || !isValidWebhookUrl(config.webhookUrl)) {
    return { ok: false, error: "A valid https webhook URL is required." };
  }

  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(config.type, text))
    });
    if (!response.ok) {
      return { ok: false, error: `Webhook responded with HTTP ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Request failed." };
  }
}

/**
 * Fire-and-forget notification for a deploy-outcome event. Silently does
 * nothing when notifications are disabled or the event isn't notable.
 */
export async function notifyDeployEvent(
  config: NotificationConfig | null,
  input: DeployEventInput,
  fetchImpl: FetchImpl = defaultFetch
): Promise<void> {
  if (!config || !config.enabled || !shouldNotify(input.eventType)) {
    return;
  }
  await sendNotification(config, formatDeployMessage(input), fetchImpl);
}
