import type { AppDatabase } from "../database.js";

export type EventSeverity = "info" | "warning" | "error";

/**
 * Deliberately conservative, closed set — routes and services should never
 * be able to invent a new event type ad hoc, since that's how event
 * semantics drift over time.
 */
export type EventType =
  | "app-created"
  | "container-started"
  | "container-stopped"
  | "container-restarted"
  | "redeploy-started"
  | "redeploy-succeeded"
  | "redeploy-failed"
  | "health-became-healthy"
  | "health-became-unhealthy"
  | "health-check-error"
  | "routing-changed"
  | "routing-warning"
  | "cleanup-warning"
  | "source-linked"
  | "source-updated"
  | "source-removed"
  | "source-validation-succeeded"
  | "source-validation-failed"
  /**
   * One event per GitHub-deploy stage (Phase 11) — coarse-grained
   * (not one per log line) so the event log stays a readable timeline
   * rather than a firehose. "github-deploy-progress" carries the
   * specific stage name/detail in metadata rather than being one type
   * per stage, so this union doesn't need to grow every time a stage is
   * renamed or reordered.
   */
  | "github-deploy-started"
  | "github-deploy-progress"
  | "github-deploy-succeeded"
  | "github-deploy-failed"
  | "github-deploy-rolled-back"
  /**
   * GitHub connect/disconnect is a global integration event, not tied to
   * any one app. app_deployment_events requires an app_id (FK, NOT NULL),
   * so these two types are never actually written to that table in this
   * phase — they exist here for a consistent, closed event vocabulary and
   * for a future global-events surface. GitHub credential lifecycle is
   * logged via the credential service's own logger instead; see
   * github-credential-service.ts.
   */
  | "github-connected"
  | "github-disconnected"
  /** Performance Diagnostics (compact — never carries raw resource lists, see performance-diagnostics-service.ts). */
  | "performance-test-started"
  | "performance-test-completed"
  | "performance-test-failed";

export interface RecordEventInput {
  appId: number;
  eventType: EventType;
  severity: EventSeverity;
  message: string;
  /**
   * Structured, size-bounded context only — e.g. container ids, image name,
   * status codes, counts. Never a raw request body, full environment
   * payload, or anything that could carry a secret value. Keys that look
   * like they might hold sensitive data are dropped defensively; see
   * `sanitizeMetadata`.
   */
  metadata?: Record<string, unknown>;
}

export interface EventLogger {
  error: (obj: unknown, message?: string) => void;
}

export type RecordEventFn = (input: RecordEventInput) => void;

const MAX_MESSAGE_LENGTH = 500;
const MAX_METADATA_JSON_LENGTH = 2000;

/**
 * Keys matching this are dropped from metadata entirely, regardless of
 * value. `api[_-]?key` explicitly recognizes apiKey/API_KEY/api-key/apikey
 * variants (including as a substring, e.g. "stripeApiKey") without using a
 * bare `/key/i` rule, which would also reject ordinary non-secret fields
 * that merely contain the word "key" (e.g. a "primaryKey" id or a
 * "keyCount" count).
 */
const SENSITIVE_METADATA_KEY_PATTERN =
  /secret|password|passwd|token|credential|authoriz|cookie|header|api[_-]?key/i;

function isPlainValue(value: unknown): boolean {
  const type = typeof value;
  return (
    value === null ||
    type === "string" ||
    type === "number" ||
    type === "boolean"
  );
}

/**
 * Drops anything that looks like it could be sensitive by key name, drops
 * non-primitive values (no nested objects/arrays — keeps metadata flat and
 * predictable), and caps the total serialized size so a runaway metadata
 * object can never bloat the events table.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): string | null {
  if (!metadata) {
    return null;
  }

  const safeEntries: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
      continue;
    }

    if (value === undefined || !isPlainValue(value)) {
      continue;
    }

    if (typeof value === "string" && value.length > 300) {
      safeEntries[key] = `${value.slice(0, 300)}…`;
      continue;
    }

    safeEntries[key] = value;
  }

  if (Object.keys(safeEntries).length === 0) {
    return null;
  }

  const json = JSON.stringify(safeEntries);

  if (json.length > MAX_METADATA_JSON_LENGTH) {
    return JSON.stringify({ note: "metadata omitted (too large)" });
  }

  return json;
}

/**
 * Writes one deployment/lifecycle event. Never throws — a failure to
 * record an informational event must never break an otherwise successful
 * operation (app creation, redeploy, a container action, a health
 * transition). Failures are logged server-side only, with no secrets.
 */
export function recordEvent(
  eventDatabase: Pick<AppDatabase, "createDeploymentEvent">,
  logger: EventLogger,
  input: RecordEventInput
): void {
  try {
    eventDatabase.createDeploymentEvent({
      appId: input.appId,
      eventType: input.eventType,
      severity: input.severity,
      message: input.message.slice(0, MAX_MESSAGE_LENGTH),
      metadataJson: sanitizeMetadata(input.metadata)
    });
  } catch (error) {
    logger.error(
      {
        appId: input.appId,
        eventType: input.eventType,
        error: error instanceof Error ? error.message : "Unknown error"
      },
      "Failed to record deployment event"
    );
  }
}

/** Binds a database + logger once so callers just pass the event fields. */
export function createEventRecorder(
  eventDatabase: Pick<AppDatabase, "createDeploymentEvent">,
  logger: EventLogger
): RecordEventFn {
  return (input: RecordEventInput) => recordEvent(eventDatabase, logger, input);
}
