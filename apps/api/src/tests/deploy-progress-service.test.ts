import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  DEPLOY_STAGE_CEILINGS,
  deployPercent,
  dismissDeployProgress,
  estimateEtaSeconds,
  listDeployProgress,
  parseBuildStep,
  resetDeployProgress,
  startDeployProgress,
  subscribeToDeployProgress,
  type DeployProgress
} from "../services/deploy-progress-service.js";
import type { DeployStage } from "../services/github-deploy-service.js";

afterEach(() => {
  resetDeployProgress();
});

describe("parseBuildStep", () => {
  test("reads Docker's classic step counter", () => {
    assert.deepEqual(parseBuildStep("Step 7/14 : RUN npm ci"), { step: 7, total: 14 });
    assert.deepEqual(parseBuildStep("Step 1/3 : FROM node:22-alpine"), { step: 1, total: 3 });
  });

  test("tolerates leading whitespace and trailing output", () => {
    assert.deepEqual(parseBuildStep("  Step 2/9 : COPY . .\n"), { step: 2, total: 9 });
  });

  test("ignores ordinary build output", () => {
    for (const line of [
      "",
      "npm WARN deprecated",
      "Successfully built abc123",
      "Stepping through something",
      "Step 3 of 9",
      "Step x/y : RUN"
    ]) {
      assert.equal(parseBuildStep(line), null, `${JSON.stringify(line)} should not parse`);
    }
  });

  test("never returns a total smaller than the current step", () => {
    // Defensive: a nonsensical "Step 9/3" must not produce >100%.
    assert.deepEqual(parseBuildStep("Step 9/3 : RUN"), { step: 9, total: 9 });
  });
});

describe("deployPercent", () => {
  test("uses the stage ceiling outside the build", () => {
    assert.equal(deployPercent("cloning-repository", null, null), DEPLOY_STAGE_CEILINGS["cloning-repository"]);
    assert.equal(deployPercent("verifying-health", null, null), DEPLOY_STAGE_CEILINGS["verifying-health"]);
    assert.equal(deployPercent("deployment-complete", null, null), 100);
  });

  test("ramps across the build band in proportion to Docker steps", () => {
    const start = DEPLOY_STAGE_CEILINGS["preparing-build"];
    const end = DEPLOY_STAGE_CEILINGS["building-image"];

    assert.equal(deployPercent("building-image", 0, 10), start);
    assert.equal(deployPercent("building-image", 10, 10), end);

    const half = deployPercent("building-image", 5, 10);
    assert.ok(half > start && half < end, "a half-done build sits inside the band");
  });

  test("a build with no step counter yet sits at the band FLOOR, not the ceiling", () => {
    // Returning the ceiling here would peg the bar at 80% the moment the
    // build began and leave the step counter unable to move it — the
    // frozen-bar bug this overlay exists to prevent.
    assert.equal(
      deployPercent("building-image", null, null),
      DEPLOY_STAGE_CEILINGS["preparing-build"]
    );
    assert.ok(
      deployPercent("building-image", null, null) < DEPLOY_STAGE_CEILINGS["building-image"]
    );
  });

  test("stage ceilings never decrease along the real pipeline order", () => {
    const order: DeployStage[] = [
      "resolving-repository",
      "resolving-branch",
      "reading-commit-metadata",
      "preparing-checkout",
      "cloning-repository",
      "inspecting-project",
      "preparing-build",
      "building-image",
      "preserving-current-container",
      "starting-replacement",
      "verifying-health",
      "updating-route",
      "cleaning-temporary-files",
      "deployment-complete"
    ];

    let previous = -1;
    for (const stage of order) {
      const value = DEPLOY_STAGE_CEILINGS[stage];
      assert.ok(value >= previous, `${stage} must not regress`);
      previous = value;
    }
  });
});

describe("estimateEtaSeconds", () => {
  test("extrapolates from elapsed time once meaningfully underway", () => {
    // 50% done after 60s implies roughly another 60s.
    assert.equal(estimateEtaSeconds(50, 60), 60);
    // 80% after 80s implies about 20s left.
    assert.equal(estimateEtaSeconds(80, 80), 20);
  });

  test("withholds an estimate while too early to be meaningful", () => {
    assert.equal(estimateEtaSeconds(1, 5), null);
    assert.equal(estimateEtaSeconds(0, 30), null);
  });

  test("withholds an estimate once finished, and for nonsense input", () => {
    assert.equal(estimateEtaSeconds(100, 90), null);
    assert.equal(estimateEtaSeconds(50, 0), null);
  });
});

/** Snapshots, since the service mutates one object in place. */
function snapshot(progress: DeployProgress): DeployProgress {
  return JSON.parse(JSON.stringify(progress)) as DeployProgress;
}

describe("deployment progress lifecycle", () => {
  test("subscribers receive stage changes, and the snapshot lists the run", () => {
    const seen: DeployProgress[] = [];
    const unsubscribe = subscribeToDeployProgress((p) => seen.push(snapshot(p)));

    const reporter = startDeployProgress(7, "staxxio", "MNIKevin202/Staxxio@main");
    reporter.setStage("cloning-repository", "checked out abc123");

    assert.ok(seen.length >= 2, "start and stage change both publish");
    const latest = seen[seen.length - 1];
    assert.equal(latest.appName, "staxxio");
    assert.equal(latest.source, "MNIKevin202/Staxxio@main");
    assert.equal(latest.stage, "cloning-repository");
    assert.equal(latest.detail, "checked out abc123");

    assert.equal(listDeployProgress().length, 1);
    unsubscribe();
  });

  test("build output advances the bar through the build stage", () => {
    const reporter = startDeployProgress(8, "app", null);
    reporter.setStage("building-image");

    const before = listDeployProgress()[0].percent;
    reporter.observeBuildOutput("Step 1/10 : FROM node:22-alpine\n");
    reporter.observeBuildOutput("Step 6/10 : RUN npm ci\n");

    const after = listDeployProgress()[0];
    assert.ok(after.percent > before, "steps move the bar forward");
    assert.equal(after.step, 6);
    assert.equal(after.totalSteps, 10);
  });

  test("ordinary build output leaves the step counter untouched", () => {
    const reporter = startDeployProgress(9, "app", null);
    reporter.setStage("building-image");
    reporter.observeBuildOutput("Step 3/8 : RUN echo hi\n");
    reporter.observeBuildOutput("npm WARN deprecated some-package\n");

    assert.equal(listDeployProgress()[0].step, 3);
  });

  test("the bar never moves backwards", () => {
    const reporter = startDeployProgress(10, "app", null);
    reporter.setStage("building-image");
    reporter.observeBuildOutput("Step 9/10 : RUN build\n");
    const high = listDeployProgress()[0].percent;

    // A re-reported earlier step must not rewind the bar.
    reporter.observeBuildOutput("Step 2/10 : COPY . .\n");
    assert.ok(listDeployProgress()[0].percent >= high);
  });

  test("leaving the build stage clears a stale step counter", () => {
    const reporter = startDeployProgress(11, "app", null);
    reporter.setStage("building-image");
    reporter.observeBuildOutput("Step 4/12 : RUN build\n");
    assert.equal(listDeployProgress()[0].step, 4);

    reporter.setStage("starting-replacement");
    const after = listDeployProgress()[0];
    assert.equal(after.step, null);
    assert.equal(after.totalSteps, null);
  });

  test("success reports 100% and a complete stage", () => {
    const reporter = startDeployProgress(12, "app", null);
    reporter.setStage("building-image");
    reporter.succeed();

    const progress = listDeployProgress()[0];
    assert.equal(progress.status, "succeeded");
    assert.equal(progress.percent, 100);
    assert.equal(progress.stage, "deployment-complete");
    assert.ok(progress.finishedAt);
    assert.equal(progress.etaSeconds, null);
  });

  test("failure records the reason and stage, and never claims completion", () => {
    const reporter = startDeployProgress(13, "staxxio", null);
    reporter.setStage("building-image");
    reporter.fail(
      "Build failed: The command '/bin/sh -c npm run build' returned a non-zero code: 1",
      "building-image",
      false
    );

    const progress = listDeployProgress()[0];
    assert.equal(progress.status, "failed");
    assert.match(progress.error ?? "", /npm run build/);
    assert.equal(progress.failedStage, "building-image");
    assert.ok(progress.percent < 100, "a failed deployment never shows 100%");
    assert.equal(progress.etaSeconds, null);
  });

  test("a rollback is reported so the operator knows the old version is back", () => {
    const reporter = startDeployProgress(14, "app", null);
    reporter.fail("health check failed", "verifying-health", true);
    assert.equal(listDeployProgress()[0].rolledBack, true);
  });

  test("several apps deploying at once are tracked independently", () => {
    startDeployProgress(20, "one", null).setStage("cloning-repository");
    startDeployProgress(21, "two", null).setStage("building-image");

    const all = listDeployProgress();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((d) => d.appName).sort(), ["one", "two"]);
  });

  test("a finished deployment can be dismissed; a running one cannot", () => {
    const running = startDeployProgress(30, "running-app", null);
    assert.equal(dismissDeployProgress(30), false, "a live deployment is never dismissed");
    assert.equal(listDeployProgress().length, 1);

    running.fail("boom", "building-image", false);
    assert.equal(dismissDeployProgress(30), true);
    assert.equal(listDeployProgress().length, 0);
  });

  test("dismissing an unknown app is a harmless no-op", () => {
    assert.equal(dismissDeployProgress(999), false);
  });

  test("unsubscribing stops delivery", () => {
    let count = 0;
    const unsubscribe = subscribeToDeployProgress(() => (count += 1));
    const reporter = startDeployProgress(40, "app", null);
    const afterStart = count;

    unsubscribe();
    reporter.setStage("building-image");

    assert.equal(count, afterStart, "no further events after unsubscribe");
  });
});
