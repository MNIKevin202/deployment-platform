import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration020AppPublishedPorts: Migration = {
  version: 20,
  name: "app_published_ports",
  up(db: DatabaseSync): void {
    // Optional raw TCP/UDP host-port publishing, applied to the container's
    // HostConfig.PortBindings on create/redeploy. This is what lets non-HTTP
    // services (game servers, IRC, etc.) be reached from outside the platform,
    // since they can't ride the HTTP reverse proxy. No rows means the previous
    // behavior — no published host ports — so this is fully additive.
    //
    //  - host_port: the port opened on the VPS itself.
    //  - container_port: the port the app listens on inside the container.
    //  - protocol: 'tcp' or 'udp' (Bedrock Minecraft, for example, is UDP).
    //
    // UNIQUE(host_port, protocol) enforces that two apps can never claim the
    // same host port — a create that would collide fails cleanly instead of
    // producing a container Docker then refuses to start.
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_published_ports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        host_port INTEGER NOT NULL,
        container_port INTEGER NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'tcp',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(host_port, protocol),
        UNIQUE(app_id, container_port, protocol)
      );

      CREATE INDEX IF NOT EXISTS idx_app_published_ports_app_id
      ON app_published_ports(app_id);
    `);
  }
};
