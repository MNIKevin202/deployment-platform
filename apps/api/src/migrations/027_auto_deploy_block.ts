import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const migration027AutoDeployBlock: Migration = {
  version: 27,
  name: "auto_deploy_block",
  up(db: DatabaseSync): void {
    // Support an operator-controlled, persistent pause on auto-redeploying a
    // specific failed commit (distinct from the in-memory circuit breaker):
    //
    //  - last_build_commit_sha: the commit the most recent build was for, so
    //    the UI can offer to block exactly that commit after a failure.
    //  - auto_deploy_blocked_commit: a commit the auto-deploy scheduler must
    //    NOT redeploy. A newer commit (different sha) still deploys, and a
    //    manual deploy ignores it. Cleared on a successful deploy.
    //
    // Both additive and nullable — existing apps have neither set.
    db.exec(`
      ALTER TABLE app_sources ADD COLUMN last_build_commit_sha TEXT;
      ALTER TABLE app_sources ADD COLUMN auto_deploy_blocked_commit TEXT;
    `);
  }
};
