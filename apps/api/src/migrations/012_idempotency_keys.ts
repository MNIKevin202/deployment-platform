import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration012IdempotencyKeys: Migration = {
  version: 12,
  name: "idempotency_keys",
  up(db: DatabaseSync): void {
    db.exec(`
      -- Tracks browser-generated Idempotency-Key values for mutating
      -- operations (currently: app creation) so a request that is delivered
      -- to the API more than once — a real double click, a retried submit,
      -- or a transport-level retry after the connection was interrupted
      -- mid-request (e.g. by the Caddy container restart that routing
      -- reconciliation performs) — is answered with the ORIGINAL result
      -- instead of re-running the operation or returning a misleading
      -- "already exists" error.
      --
      -- "scope" namespaces keys per operation type so this table can be
      -- reused by future idempotent endpoints without key collisions.
      -- "request_hash" is a fingerprint of the normalized request body: a
      -- second request that reuses a key with a DIFFERENT body is a bug or
      -- an attack, not a legitimate retry, and is rejected rather than
      -- replayed or treated as the same attempt.
      --
      -- Retention (enforced in code, not by a DB trigger, matching this
      -- project's existing retention approach): completed records are kept
      -- for 24 hours, long enough to cover any plausible delayed retry, then
      -- lazily pruned on the next write. A record stuck "in_progress" for
      -- more than 5 minutes is treated as abandoned (e.g. the process
      -- crashed mid-request) and its key becomes available again.
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
        status_code INTEGER,
        response_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_scope_key
        ON idempotency_keys (scope, key);
    `);
  }
};
