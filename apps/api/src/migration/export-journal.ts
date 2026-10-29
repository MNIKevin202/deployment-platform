import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HEADER_FILE, MANIFEST_FILE } from "./constants.js";
import type { ExportDockerClient } from "./export-docker.js";

/**
 * The export RECOVERY JOURNAL: a durable record of every app an export has
 * stopped or paused, written BEFORE the container is touched.
 *
 * That ordering is the whole point. If the exporting process is killed — Ctrl-C,
 * `docker kill`, the OOM killer, power loss — the journal already says what may
 * have been disrupted, so `migrate recover` (and the launcher, automatically) can
 * put it right. Restoring is idempotent: starting a running container or
 * unpausing a running one is harmless, so an entry whose disruption never
 * actually happened is restored safely too.
 */

export type EntryState = "intent" | "applied" | "restored" | "restore-failed";

export interface DisruptionEntry {
  id: string;
  appRef: string;
  containerName: string;
  action: "stop" | "pause";
  /** Only containers that WERE running are ever disturbed — and therefore ever restored. */
  wasRunning: boolean;
  state: EntryState;
  at: string;
  restoredAt?: string;
  error?: string;
}

export interface ExportJournal {
  journalVersion: 1;
  exportId: string;
  /** The bundle directory this export created (so a failed export's partial bundle can be removed). */
  bundlePath: string;
  startedAt: string;
  heartbeatAt: string;
  entries: DisruptionEntry[];
}

const FILE_PREFIX = "export-";
const FILE_SUFFIX = ".journal.json";

/** Durable atomic write: temp file → fsync → rename. */
async function writeDurably(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp`;
  const handle = await open(temp, "w", 0o600);

  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temp, path);
}

export class JournalStore {
  readonly path: string;
  private journal: ExportJournal | null = null;
  /** Writes are SERIALIZED: the heartbeat and the guard must never write the same file at once. */
  private chain: Promise<void> = Promise.resolve();
  /** Once closed, no further write can recreate the file (a heartbeat in flight during remove()). */
  private closed = false;

  constructor(
    private readonly directory: string,
    readonly exportId: string = randomUUID(),
    private readonly now: () => Date = () => new Date()
  ) {
    this.path = join(directory, `${FILE_PREFIX}${exportId}${FILE_SUFFIX}`);
  }

  async create(bundlePath: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const at = this.now().toISOString();
    this.journal = {
      journalVersion: 1,
      exportId: this.exportId,
      bundlePath,
      startedAt: at,
      heartbeatAt: at,
      entries: []
    };
    await this.persist();
  }

  private persist(): Promise<void> {
    if (!this.journal) {
      throw new Error("The journal has not been created.");
    }
    // Snapshot NOW (the state at the time of the call), then write in order — never concurrently.
    const content = `${JSON.stringify(this.journal, null, 2)}\n`;
    const write = this.chain.then(() => (this.closed ? undefined : writeDurably(this.path, content)));
    this.chain = write.catch(() => undefined);

    return write;
  }

  entries(): DisruptionEntry[] {
    return this.journal?.entries ?? [];
  }

  /** Records an intent to disrupt. Resolves only once the entry is on disk. */
  async append(entry: Omit<DisruptionEntry, "id" | "at" | "state">): Promise<DisruptionEntry> {
    if (!this.journal) {
      throw new Error("The journal has not been created.");
    }
    const created: DisruptionEntry = { ...entry, id: randomUUID(), at: this.now().toISOString(), state: "intent" };
    this.journal = { ...this.journal, entries: [...this.journal.entries, created] };
    await this.persist();

    return created;
  }

  async update(id: string, patch: Partial<Pick<DisruptionEntry, "state" | "restoredAt" | "error">>): Promise<void> {
    if (!this.journal) {
      throw new Error("The journal has not been created.");
    }
    this.journal = {
      ...this.journal,
      entries: this.journal.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    };
    await this.persist();
  }

  async heartbeat(): Promise<void> {
    if (this.journal && !this.closed) {
      this.journal = { ...this.journal, heartbeatAt: this.now().toISOString() };
      await this.persist();
    }
  }

  /**
   * Deletes the journal: only done once every entry is restored. Waits for any write in
   * flight and forbids later ones, so nothing can bring the file back afterwards.
   */
  async remove(): Promise<void> {
    this.closed = true;
    await this.chain;
    await rm(this.path, { force: true });
    this.journal = null;
  }

  unrestored(): DisruptionEntry[] {
    return this.entries().filter((entry) => entry.state !== "restored");
  }
}

export async function readJournals(directory: string): Promise<ExportJournal[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const journals: ExportJournal[] = [];
  for (const name of names.filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX))) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as ExportJournal;
      if (parsed.journalVersion === 1 && Array.isArray(parsed.entries)) {
        journals.push(parsed);
      }
    } catch {
      // A half-written temp file or foreign file: ignore, never crash recovery.
    }
  }

  return journals;
}

// ---------------------------------------------------------------- restoring ----

export interface RestoreOptions {
  /** How many times to try to bring one container back before reporting failure. */
  attempts?: number;
  /** How long to wait for a restored container to report running. */
  verifyMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Brings one disrupted container back to "running and not paused", and VERIFIES it.
 * Idempotent and safe to repeat. Throws only after every attempt has failed.
 */
export async function restoreContainer(
  client: ExportDockerClient,
  entry: Pick<DisruptionEntry, "containerName" | "wasRunning" | "action">,
  options: RestoreOptions = {}
): Promise<"restored" | "untouched"> {
  if (!entry.wasRunning) {
    return "untouched";
  }

  const attempts = options.attempts ?? 4;
  const verifyMs = options.verifyMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const info = await client.inspectContainer(entry.containerName);
      if (!info) {
        throw new Error(`container "${entry.containerName}" no longer exists`);
      }

      if (info.paused) {
        await client.unpauseContainer(info.id);
      } else if (!info.running) {
        await client.startContainer(info.id);
      }

      // Verify, don't assume.
      const deadline = Date.now() + verifyMs;
      for (;;) {
        const after = await client.inspectContainer(entry.containerName);
        if (after?.running && !after.paused) {
          return "restored";
        }
        if (Date.now() >= deadline) {
          throw new Error(`container "${entry.containerName}" did not report running after being restored`);
        }
        await sleep(200);
      }
    } catch (error) {
      lastError = error;
      options.log?.(`restore attempt ${attempt}/${attempts} for ${entry.containerName} failed: ${(error as Error).message}`);
      if (attempt < attempts) {
        await sleep(Math.min(250 * 2 ** (attempt - 1), 4000));
      }
    }
  }

  throw new Error(`could not restore ${entry.containerName}: ${(lastError as Error)?.message ?? "unknown error"}`);
}

export interface RecoveryResult {
  exportId: string;
  bundlePath: string;
  /** True if the journal's export looked alive (fresh heartbeat), so nothing was touched. */
  skippedActive: boolean;
  restored: string[];
  failed: Array<{ containerName: string; error: string }>;
  /** Helper containers removed. */
  helpersRemoved: number;
  /** True if an incomplete bundle left behind by the dead export was deleted. */
  partialBundleRemoved: boolean;
}

/**
 * Deletes the half-written bundle a KILLED export left behind. Strictly limited: the path
 * recorded in the journal must contain a bundle header and must NOT contain a manifest,
 * i.e. it is provably an unfinished bundle. A complete bundle is never touched.
 */
async function removeIncompleteBundle(bundlePath: string): Promise<boolean> {
  try {
    if (!isAbsolute(bundlePath) || !existsSync(join(bundlePath, HEADER_FILE)) || existsSync(join(bundlePath, MANIFEST_FILE))) {
      return false;
    }
    await rm(bundlePath, { recursive: true, force: true });

    return true;
  } catch {
    return false;
  }
}

/**
 * Restores whatever any export journal says may still be disrupted. Never throws:
 * every failure is reported in the result so the caller can say it loudly.
 */
export async function recoverDisruptions(
  client: ExportDockerClient,
  directory: string,
  options: RestoreOptions & { force?: boolean; now?: () => Date; activeWithinMs?: number } = {}
): Promise<RecoveryResult[]> {
  const now = options.now ?? (() => new Date());
  const activeWithinMs = options.activeWithinMs ?? 60_000;
  const results: RecoveryResult[] = [];

  for (const journal of await readJournals(directory)) {
    const result: RecoveryResult = {
      exportId: journal.exportId,
      bundlePath: journal.bundlePath,
      skippedActive: false,
      restored: [],
      failed: [],
      helpersRemoved: 0,
      partialBundleRemoved: false
    };

    const age = now().getTime() - new Date(journal.heartbeatAt).getTime();
    const pending = journal.entries.filter((entry) => entry.state !== "restored");

    if (!options.force && pending.length > 0 && age >= 0 && age < activeWithinMs) {
      // A live export is still heartbeating; restoring under it would fight it.
      result.skippedActive = true;
      results.push(result);
      continue;
    }

    const store = new JournalStore(directory, journal.exportId, now);
    // Restore in REVERSE order of disruption: dependencies come back before their dependents.
    for (const entry of [...pending].reverse()) {
      try {
        await restoreContainer(client, entry, options);
        result.restored.push(entry.containerName);
        await markRestored(directory, journal, entry.id, now);
      } catch (error) {
        result.failed.push({ containerName: entry.containerName, error: (error as Error).message });
      }
    }

    try {
      result.helpersRemoved = await client.sweepHelpers();
    } catch {
      // Sweeping helpers is housekeeping; it must never mask the restore outcome.
    }

    if (result.failed.length === 0) {
      result.partialBundleRemoved = await removeIncompleteBundle(journal.bundlePath);
      await store.remove().catch(() => undefined);
      await rm(join(directory, `${FILE_PREFIX}${journal.exportId}${FILE_SUFFIX}`), { force: true });
    }
    results.push(result);
  }

  return results;
}

async function markRestored(directory: string, journal: ExportJournal, entryId: string, now: () => Date): Promise<void> {
  const path = join(directory, `${FILE_PREFIX}${journal.exportId}${FILE_SUFFIX}`);
  const updated: ExportJournal = {
    ...journal,
    entries: journal.entries.map((entry) =>
      entry.id === entryId ? { ...entry, state: "restored" as const, restoredAt: now().toISOString() } : entry
    )
  };
  journal.entries = updated.entries;
  await writeDurably(path, `${JSON.stringify(updated, null, 2)}\n`);
}
