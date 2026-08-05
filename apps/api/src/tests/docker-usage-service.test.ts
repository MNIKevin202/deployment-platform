import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getDockerUsageSnapshot,
  getHostDiskUsage,
  createDockerUsageProvider,
  type DockerUsageOps,
  type CombinedUsage
} from "../services/docker-usage-service.js";

/** A promise plus its own resolve/reject, for deterministic control over when a fake fetch "completes". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake timer registry so timeout behavior can be triggered deterministically without real waiting. */
function createManualTimers() {
  let nextId = 1;
  const handlers = new Map<number, () => void>();
  return {
    setTimeoutFn: (handler: () => void): unknown => {
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearTimeoutFn: (handle: unknown): void => {
      handlers.delete(handle as number);
    },
    fireAll: (): void => {
      const pending = [...handlers.values()];
      handlers.clear();
      for (const handler of pending) {
        handler();
      }
    },
    pendingCount: (): number => handlers.size
  };
}

function fakeUsage(): CombinedUsage {
  return {
    usage: { images: 1, containers: 1, runningContainers: 1, volumes: 1, imagesSizeBytes: 100 },
    disk: { usedBytes: 200, totalBytes: 400 }
  };
}

describe("getDockerUsageSnapshot", () => {
  test("reports raw counts, running-container count, and LayersSize as the images size", async () => {
    const fakeDocker: DockerUsageOps = {
      listImages: async () => [{}, {}, {}],
      listContainers: async () => [
        { State: "running" },
        { State: "running" },
        { State: "exited" },
        { State: "exited" },
        { State: "exited" }
      ],
      listVolumes: async () => ({ Volumes: [{}, {}] }),
      df: async () => ({ LayersSize: 123_456 })
    };

    const snapshot = await getDockerUsageSnapshot(fakeDocker as never);
    assert.deepEqual(snapshot, {
      images: 3,
      containers: 5,
      runningContainers: 2,
      volumes: 2,
      imagesSizeBytes: 123_456
    });
  });

  test("degrades gracefully when df or volumes come back empty/missing", async () => {
    const fakeDocker: DockerUsageOps = {
      listImages: async () => [],
      listContainers: async () => [],
      listVolumes: async () => ({ Volumes: null }),
      df: async () => ({})
    };

    const snapshot = await getDockerUsageSnapshot(fakeDocker as never);
    assert.deepEqual(snapshot, {
      images: 0,
      containers: 0,
      runningContainers: 0,
      volumes: 0,
      imagesSizeBytes: 0
    });
  });
});

describe("getHostDiskUsage", () => {
  test("computes used bytes as total minus available (not free)", async () => {
    const usage = await getHostDiskUsage("/", async () => ({
      blocks: 1000,
      bsize: 1024,
      bavail: 400
    }));

    assert.equal(usage.totalBytes, 1000 * 1024);
    assert.equal(usage.usedBytes, (1000 - 400) * 1024);
  });

  test("never returns a negative used value", async () => {
    // Pathological/rounding input: available slightly exceeds total.
    const usage = await getHostDiskUsage("/", async () => ({
      blocks: 100,
      bsize: 1024,
      bavail: 200
    }));

    assert.equal(usage.usedBytes, 0);
  });
});

describe("createDockerUsageProvider", () => {
  test("serves a cached result within the TTL without calling fetchUsage again", async () => {
    let calls = 0;
    let clock = 0;
    const provider = createDockerUsageProvider({} as never, {
      ttlMs: 30_000,
      now: () => clock,
      fetchUsage: async () => {
        calls += 1;
        return fakeUsage();
      }
    });

    await provider.getUsage();
    clock += 5_000; // well within the 30s TTL
    await provider.getUsage();

    assert.equal(calls, 1);
  });

  test("re-fetches once the cached result's TTL has expired", async () => {
    let calls = 0;
    let clock = 0;
    const provider = createDockerUsageProvider({} as never, {
      ttlMs: 30_000,
      now: () => clock,
      fetchUsage: async () => {
        calls += 1;
        return fakeUsage();
      }
    });

    await provider.getUsage();
    clock += 30_001;
    await provider.getUsage();

    assert.equal(calls, 2);
  });

  test("de-duplicates concurrent callers into a single in-flight fetch", async () => {
    let calls = 0;
    const gate = deferred<CombinedUsage>();
    const provider = createDockerUsageProvider({} as never, {
      fetchUsage: async () => {
        calls += 1;
        return gate.promise;
      }
    });

    const first = provider.getUsage();
    const second = provider.getUsage();

    assert.equal(calls, 1); // the second call joined the first's in-flight attempt, not a new one.

    gate.resolve(fakeUsage());
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, fakeUsage());
    assert.deepEqual(b, fakeUsage());
  });

  test("rejects with a clear timeout message when fetchUsage never settles, using the injected timer", async () => {
    const timers = createManualTimers();
    const neverSettles = new Promise<CombinedUsage>(() => undefined);
    const provider = createDockerUsageProvider({} as never, {
      timeoutMs: 5_000,
      fetchUsage: () => neverSettles,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    const attempt = provider.getUsage();
    assert.equal(timers.pendingCount(), 1);
    timers.fireAll();

    await assert.rejects(attempt, /timed out after 5000ms/);
  });

  test("a failed attempt is never cached — the next call retries", async () => {
    let calls = 0;
    const provider = createDockerUsageProvider({} as never, {
      fetchUsage: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("docker unreachable");
        }
        return fakeUsage();
      }
    });

    await assert.rejects(provider.getUsage(), /docker unreachable/);
    const result = await provider.getUsage();

    assert.equal(calls, 2);
    assert.deepEqual(result, fakeUsage());
  });

  test("a fresh call after a timeout starts a new attempt rather than reusing the abandoned one", async () => {
    const timers = createManualTimers();
    let calls = 0;
    const gates: ReturnType<typeof deferred<CombinedUsage>>[] = [];
    const provider = createDockerUsageProvider({} as never, {
      timeoutMs: 5_000,
      fetchUsage: () => {
        calls += 1;
        const gate = deferred<CombinedUsage>();
        gates.push(gate);
        return gate.promise;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    });

    const firstAttempt = provider.getUsage();
    timers.fireAll(); // the first attempt times out.
    await assert.rejects(firstAttempt, /timed out/);

    const secondAttempt = provider.getUsage();
    assert.equal(calls, 2); // a genuinely new attempt, not the abandoned first one.

    // The first attempt's fetchUsage finally resolves late — it must not
    // clobber the second (still in-flight) attempt's result.
    gates[0].resolve(fakeUsage());
    gates[1].resolve(fakeUsage());
    await secondAttempt;
  });

  test("invalidate() clears the cache so the very next call re-fetches, even within the TTL", async () => {
    let calls = 0;
    let clock = 0;
    const provider = createDockerUsageProvider({} as never, {
      ttlMs: 30_000,
      now: () => clock,
      fetchUsage: async () => {
        calls += 1;
        return fakeUsage();
      }
    });

    await provider.getUsage();
    clock += 1_000; // still well within the TTL.
    provider.invalidate();
    await provider.getUsage();

    assert.equal(calls, 2);
  });

  test("invalidate() while a fetch is in flight doesn't affect that fetch — it still populates a fresh cache", async () => {
    let clock = 0;
    const gate = deferred<CombinedUsage>();
    let calls = 0;
    const provider = createDockerUsageProvider({} as never, {
      now: () => clock,
      fetchUsage: async () => {
        calls += 1;
        return gate.promise;
      }
    });

    const inFlight = provider.getUsage();
    provider.invalidate(); // no cache exists yet — this is a no-op, not an error.
    gate.resolve(fakeUsage());
    await inFlight;

    // The completed fetch's result is now cached; a call right after reuses it.
    await provider.getUsage();
    assert.equal(calls, 1);
  });
});
