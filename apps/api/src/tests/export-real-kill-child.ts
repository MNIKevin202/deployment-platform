/**
 * Child process for the REAL-Docker hard-kill test. It runs an actual export against the
 * real daemon (stop strategy, a real stopped container), announces when the app is down
 * and its volume is about to be read, and then waits to be SIGKILLed by the parent.
 */
import { makeRealHarness } from "./real-docker-estate.js";

const [runId, baseDir] = process.argv.slice(2);
if (!runId || !baseDir) {
  throw new Error("usage: export-real-kill-child <runId> <baseDir>");
}

setInterval(() => undefined, 1000); // keep the process alive so the parent kills a LIVE process

const harness = makeRealHarness(runId, baseDir);
await harness.run(
  {
    scope: "application",
    operation: "backup",
    appId: 2,
    mode: "cutover",
    strategies: { default: "stop", perApp: {} },
    acceptRisks: { web: "crash-consistent" }
  },
  {
    onStep: (step) => {
      if (step === "volume") {
        // "window-quiesce" has already stopped the app by now.
        console.log("APP-STOPPED");
      }
    }
  }
);
