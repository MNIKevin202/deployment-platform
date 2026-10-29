import type { ExportDockerClient } from "./export-docker.js";
import { restoreContainer, type DisruptionEntry, type JournalStore, type RestoreOptions } from "./export-journal.js";

/**
 * Stops or pauses an app for a consistent snapshot — and GUARANTEES it is put back.
 *
 * Every disturbance goes through `journal.append` first (durable before the
 * container is touched), and `restoreAll` never throws, so it can sit in a
 * `finally` block without hiding the original failure.
 */

export interface StopOutcome {
  /** False if the app was not running to begin with (so nothing was disturbed). */
  wasRunning: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  /** Exit code 0: the process left on its own terms. This is PROCESS-level evidence only. */
  cleanExit: boolean;
  /** SIGKILL after the grace period (137) or an out-of-memory kill. */
  forcedKill: boolean;
}

export interface RestoreSummary {
  restored: string[];
  failed: Array<{ containerName: string; error: string }>;
}

export class ContainerMissingError extends Error {
  constructor(containerName: string) {
    super(`Container "${containerName}" does not exist.`);
    this.name = "ContainerMissingError";
  }
}

export interface GuardOptions extends RestoreOptions {
  graceSeconds?: number;
}

export class DisruptionGuard {
  private readonly graceSeconds: number;

  constructor(
    private readonly client: ExportDockerClient,
    private readonly journal: JournalStore,
    private readonly options: GuardOptions = {}
  ) {
    this.graceSeconds = options.graceSeconds ?? 30;
  }

  /** Apps this guard has disturbed and not yet restored. */
  outstanding(): DisruptionEntry[] {
    return this.journal.unrestored().filter((entry) => entry.wasRunning);
  }

  async stop(app: { ref: string; containerName: string }): Promise<StopOutcome> {
    const before = await this.client.inspectContainer(app.containerName);
    if (!before) {
      throw new ContainerMissingError(app.containerName);
    }
    if (before.paused) {
      throw new Error(`"${app.containerName}" is paused by something else; refusing to stop it.`);
    }

    if (!before.running) {
      // Nothing to disturb. Report how it last exited so the caller can judge.
      return {
        wasRunning: false,
        exitCode: before.exitCode,
        oomKilled: before.oomKilled,
        cleanExit: before.exitCode === 0 && !before.oomKilled,
        forcedKill: before.exitCode === 137 || before.oomKilled
      };
    }

    // Durable BEFORE the stop: a crash from here on is recoverable.
    const entry = await this.journal.append({
      appRef: app.ref,
      containerName: app.containerName,
      action: "stop",
      wasRunning: true
    });

    await this.client.stopContainer(before.id, this.graceSeconds);
    await this.journal.update(entry.id, { state: "applied" });

    const after = await this.client.inspectContainer(app.containerName);
    const exitCode = after?.exitCode ?? null;
    const oomKilled = after?.oomKilled ?? false;

    return {
      wasRunning: true,
      exitCode,
      oomKilled,
      cleanExit: exitCode === 0 && !oomKilled,
      forcedKill: exitCode === 137 || oomKilled
    };
  }

  async freeze(app: { ref: string; containerName: string }): Promise<{ wasRunning: boolean }> {
    const before = await this.client.inspectContainer(app.containerName);
    if (!before) {
      throw new ContainerMissingError(app.containerName);
    }
    if (!before.running || before.paused) {
      return { wasRunning: false };
    }

    const entry = await this.journal.append({
      appRef: app.ref,
      containerName: app.containerName,
      action: "pause",
      wasRunning: true
    });

    await this.client.pauseContainer(before.id);
    await this.journal.update(entry.id, { state: "applied" });

    return { wasRunning: true };
  }

  /** Restores one app (the most recent disruption of it). Throws if it cannot be restored. */
  async restore(appRef: string): Promise<void> {
    const entry = [...this.journal.entries()].reverse().find((e) => e.appRef === appRef && e.state !== "restored");
    if (!entry) {
      return;
    }

    try {
      await restoreContainer(this.client, entry, this.options);
      await this.journal.update(entry.id, { state: "restored", restoredAt: new Date().toISOString() });
    } catch (error) {
      await this.journal.update(entry.id, { state: "restore-failed", error: (error as Error).message }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Restores everything outstanding, newest disruption first. NEVER throws: failures
   * are returned so the caller can report them prominently without losing the
   * original error.
   */
  async restoreAll(): Promise<RestoreSummary> {
    const summary: RestoreSummary = { restored: [], failed: [] };

    for (const entry of [...this.journal.unrestored()].reverse()) {
      try {
        await restoreContainer(this.client, entry, this.options);
        await this.journal.update(entry.id, { state: "restored", restoredAt: new Date().toISOString() });
        if (entry.wasRunning) {
          summary.restored.push(entry.containerName);
        }
      } catch (error) {
        const message = (error as Error).message;
        summary.failed.push({ containerName: entry.containerName, error: message });
        await this.journal.update(entry.id, { state: "restore-failed", error: message }).catch(() => undefined);
      }
    }

    return summary;
  }
}
