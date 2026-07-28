import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration015SourceSelectedStrategy: Migration = {
  version: 15,
  name: "source_selected_strategy",
  up(db: DatabaseSync): void {
    db.exec(`
      -- Additive only, nullable, defaults to NULL for every existing row
      -- (including roadmapstudio-web's) — NULL means "follow the
      -- inspection recommendation automatically", the exact behavior
      -- every source had before this column existed, so no existing
      -- deployment changes behavior on upgrade. build_strategy (migration
      -- 009) is a DISPLAY-ONLY field overwritten by every inspection run
      -- with whatever was just detected; this column is the operator's
      -- own explicit choice and must survive inspection reruns
      -- untouched — the two are deliberately separate columns so an
      -- inspection rerun can never silently clobber a manual override.
      ALTER TABLE app_sources ADD COLUMN selected_strategy TEXT;
    `);
  }
};
