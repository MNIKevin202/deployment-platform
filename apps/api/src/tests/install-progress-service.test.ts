import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  createInstallJob,
  getInstallProgress,
  overallPercent,
  PullProgressAccumulator,
  resetInstallProgress,
  servicePercent,
  STAGE_CEILINGS,
  subscribeToInstall,
  type InstallProgress,
  type InstallServiceProgress
} from "../services/install-progress-service.js";

afterEach(() => {
  resetInstallProgress();
});

describe("PullProgressAccumulator", () => {
  test("sums layers, replacing an id rather than double-counting it", () => {
    const accumulator = new PullProgressAccumulator();

    accumulator.update({ id: "a", progressDetail: { current: 50, total: 100 } });
    assert.equal(accumulator.fraction(), 0.5);

    // The same layer reporting again must REPLACE, not add.
    accumulator.update({ id: "a", progressDetail: { current: 100, total: 100 } });
    assert.equal(accumulator.fraction(), 1);

    accumulator.update({ id: "b", progressDetail: { current: 0, total: 100 } });
    assert.equal(accumulator.fraction(), 0.5, "a second layer expands the denominator");
  });

  test("ignores events with no measurable size", () => {
    const accumulator = new PullProgressAccumulator();

    assert.equal(accumulator.update({ status: "Pulling fs layer" }), null);
    assert.equal(accumulator.update({ id: "a", progressDetail: { total: 0 } }), null);
    assert.equal(accumulator.fraction(), null, "nothing measurable means no fraction");
  });

  test("never exceeds 1 even if Docker reports more than the total", () => {
    const accumulator = new PullProgressAccumulator();
    accumulator.update({ id: "a", progressDetail: { current: 150, total: 100 } });
    assert.equal(accumulator.fraction(), 1);
  });

  test("reports the byte totals used for the detail line", () => {
    const accumulator = new PullProgressAccumulator();
    accumulator.update({ id: "a", progressDetail: { current: 25, total: 100 } });
    accumulator.update({ id: "b", progressDetail: { current: 75, total: 200 } });
    assert.deepEqual(accumulator.bytes(), { current: 100, total: 300 });
  });
});

describe("servicePercent", () => {
  test("ramps across the pull band in proportion to bytes downloaded", () => {
    assert.equal(servicePercent("pulling", 0), 0);
    assert.equal(servicePercent("pulling", 0.5), Math.round(STAGE_CEILINGS.pulling * 0.5));
    assert.equal(servicePercent("pulling", 1), STAGE_CEILINGS.pulling);
  });

  test("sits at the bottom of the band while nothing is measurable yet", () => {
    // The honest answer to "how far through the download are we?" before any
    // byte counts arrive is 0 — not a timer-driven guess.
    assert.equal(servicePercent("pulling", null), 0);
  });

  test("uses the stage ceiling for stages with no sub-progress", () => {
    assert.equal(servicePercent("storage", null), STAGE_CEILINGS.storage);
    assert.equal(servicePercent("creating", null), STAGE_CEILINGS.creating);
    assert.equal(servicePercent("starting", null), STAGE_CEILINGS.starting);
    assert.equal(servicePercent("done", null), 100);
  });

  test("stages never move backwards", () => {
    const order = ["queued", "pulling", "storage", "creating", "starting", "routing", "done"] as const;
    let previous = -1;
    for (const stage of order) {
      const value = servicePercent(stage, 1);
      assert.ok(value >= previous, `${stage} must not regress`);
      previous = value;
    }
  });
});

describe("overallPercent", () => {
  const service = (percent: number): InstallServiceProgress => ({
    name: `s${percent}`,
    stage: "pulling",
    percent,
    detail: ""
  });

  test("averages services equally", () => {
    assert.equal(overallPercent([service(0), service(100)]), 50);
    assert.equal(overallPercent([service(50)]), 50);
  });

  test("is 0 for no services", () => {
    assert.equal(overallPercent([]), 0);
  });
});

describe("install job lifecycle", () => {
  test("subscribers receive the current state immediately, then updates", () => {
    const reporter = createInstallJob("install-1");
    reporter.begin(["blueprint-ollama", "blueprint"]);

    const seen: InstallProgress[] = [];
    const unsubscribe = subscribeToInstall("install-1", (progress) => {
      // Snapshot — the service mutates one object in place.
      seen.push(JSON.parse(JSON.stringify(progress)) as InstallProgress);
    });

    assert.ok(unsubscribe);
    assert.equal(seen.length, 1, "current state arrives without waiting for a change");
    assert.equal(seen[0].services.length, 2);
    assert.equal(seen[0].percent, 0);

    reporter.setStage("blueprint-ollama", "pulling");
    reporter.setPullProgress("blueprint-ollama", {
      id: "layer",
      progressDetail: { current: 100, total: 100 }
    });

    const latest = seen[seen.length - 1];
    // One of two services finished its pull band: 70/2 = 35.
    assert.equal(latest.percent, Math.round(STAGE_CEILINGS.pulling / 2));
    assert.equal(latest.currentService, "blueprint-ollama");
    unsubscribe();
  });

  test("pull progress is ignored for a service that isn't pulling", () => {
    const reporter = createInstallJob("install-2");
    reporter.begin(["app"]);
    reporter.setStage("app", "creating");
    reporter.setPullProgress("app", { id: "l", progressDetail: { current: 1, total: 1 } });

    assert.equal(getInstallProgress("install-2")?.percent, STAGE_CEILINGS.creating);
  });

  test("the bar never moves backwards when a new layer widens the denominator", () => {
    const reporter = createInstallJob("install-3");
    reporter.begin(["app"]);
    reporter.setStage("app", "pulling");

    reporter.setPullProgress("app", { id: "a", progressDetail: { current: 100, total: 100 } });
    const high = getInstallProgress("install-3")!.percent;

    // A second, larger layer appears — the raw fraction drops sharply.
    reporter.setPullProgress("app", { id: "b", progressDetail: { current: 0, total: 900 } });
    assert.ok(
      getInstallProgress("install-3")!.percent >= high,
      "percent must not regress mid-pull"
    );
  });

  test("succeed() completes every service and reports 100", () => {
    const reporter = createInstallJob("install-4");
    reporter.begin(["a", "b"]);
    reporter.setStage("a", "pulling");
    reporter.succeed();

    const progress = getInstallProgress("install-4")!;
    assert.equal(progress.status, "succeeded");
    assert.equal(progress.percent, 100);
    assert.ok(progress.services.every((service) => service.stage === "done"));
    assert.ok(progress.finishedAt);
  });

  test("fail() records the error and stops at the percentage reached", () => {
    const reporter = createInstallJob("install-5");
    reporter.begin(["a", "b"]);
    reporter.setStage("a", "creating");
    reporter.fail("image pull failed");

    const progress = getInstallProgress("install-5")!;
    assert.equal(progress.status, "failed");
    assert.equal(progress.error, "image pull failed");
    // Deliberately NOT 100 — a failed install never claims completion.
    assert.ok(progress.percent < 100);
  });

  test("subscribing to an unknown install returns null rather than inventing one", () => {
    assert.equal(subscribeToInstall("nope", () => {}), null);
    assert.equal(getInstallProgress("nope"), null);
  });

  test("a late subscriber still sees a finished install's final state", () => {
    const reporter = createInstallJob("install-6");
    reporter.begin(["a"]);
    reporter.succeed();

    let received: InstallProgress | null = null;
    const unsubscribe = subscribeToInstall("install-6", (progress) => {
      received = progress;
    });

    assert.ok(unsubscribe);
    assert.equal(received!.status, "succeeded");
    assert.equal(received!.percent, 100);
    unsubscribe?.();
  });

  test("unsubscribing stops delivery without disturbing other subscribers", () => {
    const reporter = createInstallJob("install-7");
    reporter.begin(["a"]);

    let firstCount = 0;
    let secondCount = 0;
    const first = subscribeToInstall("install-7", () => firstCount += 1);
    const second = subscribeToInstall("install-7", () => secondCount += 1);

    first?.();
    reporter.setStage("a", "creating");

    assert.equal(firstCount, 1, "only the initial snapshot");
    assert.equal(secondCount, 2, "snapshot plus the update");
    second?.();
  });

  test("setStage on an unknown service is ignored rather than throwing", () => {
    const reporter = createInstallJob("install-8");
    reporter.begin(["a"]);
    reporter.setStage("does-not-exist", "creating");
    assert.equal(getInstallProgress("install-8")?.services.length, 1);
  });
});
