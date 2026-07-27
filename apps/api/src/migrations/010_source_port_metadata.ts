import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration010SourcePortMetadata: Migration = {
  version: 10,
  name: "source_port_metadata",
  up(db: DatabaseSync): void {
    db.exec(`
      -- Additive only. container_port (migration 009) already stores the
      -- operator-confirmed value; these two describe *how* that value was
      -- arrived at (a detection result the operator accepted, or "manual"
      -- when they typed it themselves) so the Source tab and deployment
      -- events can show it — the raw port number alone doesn't answer
      -- "was this port actually inferred, or did someone just type it?".
      ALTER TABLE app_sources ADD COLUMN container_port_source TEXT;
      ALTER TABLE app_sources ADD COLUMN container_port_confidence TEXT;

      -- The most recent GitHub-deployment runtime verification results —
      -- shown on the Source tab so an operator can see, without opening
      -- Activity, whether the currently-live deployment actually passed
      -- internal/public reachability checks (see github-deploy-service.ts).
      ALTER TABLE app_sources ADD COLUMN last_internal_health_result TEXT;
      ALTER TABLE app_sources ADD COLUMN last_public_health_result TEXT;
      ALTER TABLE app_sources ADD COLUMN last_deployment_status TEXT;
    `);
  }
};
