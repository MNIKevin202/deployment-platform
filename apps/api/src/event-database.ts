import type { DatabaseSync } from "node:sqlite";

export type DeploymentEventSeverity = "info" | "warning" | "error";

export interface StoredDeploymentEvent {
  id: number;
  appId: number;
  eventType: string;
  severity: DeploymentEventSeverity;
  message: string;
  metadataJson: string | null;
  createdAt: string;
}

interface DeploymentEventRow {
  id: number;
  app_id: number;
  event_type: string;
  severity: string;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

const EVENT_COLUMNS = `
  id, app_id, event_type, severity, message, metadata_json, created_at
`;

function mapEvent(row: DeploymentEventRow): StoredDeploymentEvent {
  return {
    id: row.id,
    appId: row.app_id,
    eventType: row.event_type,
    severity: row.severity as DeploymentEventSeverity,
    message: row.message,
    metadataJson: row.metadata_json,
    createdAt: row.created_at
  };
}

export interface CreateDeploymentEventInput {
  appId: number;
  eventType: string;
  severity: DeploymentEventSeverity;
  message: string;
  metadataJson: string | null;
}

export interface ListDeploymentEventsOptions {
  limit: number;
  /** When set, only events strictly older (lower id) than this cursor. */
  beforeId?: number;
}

export function createEventRepository(db: DatabaseSync) {
  function createDeploymentEvent(
    input: CreateDeploymentEventInput
  ): StoredDeploymentEvent {
    db.prepare(
      `
        INSERT INTO app_deployment_events (app_id, event_type, severity, message, metadata_json)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      input.appId,
      input.eventType,
      input.severity,
      input.message,
      input.metadataJson
    );

    const row = db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM app_deployment_events WHERE id = last_insert_rowid()`)
      .get() as unknown as DeploymentEventRow;

    return mapEvent(row);
  }

  function listDeploymentEvents(
    appId: number,
    options: ListDeploymentEventsOptions
  ): StoredDeploymentEvent[] {
    const rows = options.beforeId
      ? (db
          .prepare(
            `SELECT ${EVENT_COLUMNS} FROM app_deployment_events WHERE app_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
          )
          .all(appId, options.beforeId, options.limit) as unknown as DeploymentEventRow[])
      : (db
          .prepare(
            `SELECT ${EVENT_COLUMNS} FROM app_deployment_events WHERE app_id = ? ORDER BY id DESC LIMIT ?`
          )
          .all(appId, options.limit) as unknown as DeploymentEventRow[]);

    return rows.map(mapEvent);
  }

  return {
    createDeploymentEvent,
    listDeploymentEvents
  };
}

export type EventRepository = ReturnType<typeof createEventRepository>;
