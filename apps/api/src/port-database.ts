import type { DatabaseSync } from "node:sqlite";

export type PortProtocol = "tcp" | "udp";

export interface StoredAppPublishedPort {
  id: number;
  appId: number;
  hostPort: number;
  containerPort: number;
  protocol: PortProtocol;
  createdAt: string;
}

interface AppPublishedPortRow {
  id: number;
  app_id: number;
  host_port: number;
  container_port: number;
  protocol: string;
  created_at: string;
}

function mapAppPublishedPort(row: AppPublishedPortRow): StoredAppPublishedPort {
  return {
    id: row.id,
    appId: row.app_id,
    hostPort: row.host_port,
    containerPort: row.container_port,
    protocol: row.protocol === "udp" ? "udp" : "tcp",
    createdAt: row.created_at
  };
}

export interface CreateAppPublishedPortInput {
  appId: number;
  hostPort: number;
  containerPort: number;
  protocol: PortProtocol;
}

const APP_PUBLISHED_PORT_COLUMNS = `
  id, app_id, host_port, container_port, protocol, created_at
`;

export function createPortRepository(db: DatabaseSync) {
  function listAppPublishedPorts(appId: number): StoredAppPublishedPort[] {
    const rows = db
      .prepare(
        `SELECT ${APP_PUBLISHED_PORT_COLUMNS} FROM app_published_ports WHERE app_id = ? ORDER BY host_port ASC`
      )
      .all(appId) as unknown as AppPublishedPortRow[];

    return rows.map(mapAppPublishedPort);
  }

  /**
   * The app currently publishing the given host port/protocol, if any. Used
   * to reject a create that would collide with another app before Docker does.
   */
  function getAppPublishedPortByHost(
    hostPort: number,
    protocol: PortProtocol
  ): StoredAppPublishedPort | null {
    const row = db
      .prepare(
        `SELECT ${APP_PUBLISHED_PORT_COLUMNS} FROM app_published_ports WHERE host_port = ? AND protocol = ?`
      )
      .get(hostPort, protocol) as unknown as AppPublishedPortRow | undefined;

    return row ? mapAppPublishedPort(row) : null;
  }

  function createAppPublishedPort(
    input: CreateAppPublishedPortInput
  ): StoredAppPublishedPort {
    const result = db
      .prepare(
        `
          INSERT INTO app_published_ports (app_id, host_port, container_port, protocol)
          VALUES (?, ?, ?, ?)
        `
      )
      .run(input.appId, input.hostPort, input.containerPort, input.protocol);

    const created = db
      .prepare(
        `SELECT ${APP_PUBLISHED_PORT_COLUMNS} FROM app_published_ports WHERE id = ?`
      )
      .get(result.lastInsertRowid) as unknown as AppPublishedPortRow | undefined;

    if (!created) {
      throw new Error("App published port could not be loaded after creation");
    }

    return mapAppPublishedPort(created);
  }

  function deleteAppPublishedPortsForApp(appId: number): void {
    db.prepare(`DELETE FROM app_published_ports WHERE app_id = ?`).run(appId);
  }

  return {
    listAppPublishedPorts,
    getAppPublishedPortByHost,
    createAppPublishedPort,
    deleteAppPublishedPortsForApp
  };
}

export type PortRepository = ReturnType<typeof createPortRepository>;
