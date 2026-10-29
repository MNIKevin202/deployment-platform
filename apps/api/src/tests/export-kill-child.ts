/**
 * Child process for export-kill.test.ts. It runs a REAL export against a synthetic
 * installation whose container states live in a file, stalls in the middle of reading a
 * volume while an app is stopped, announces it, and then waits to be KILLED (SIGKILL)
 * by the parent. Nothing here touches a real Docker daemon.
 */
import { makeHarness } from "./export-harness.js";

const [baseDir, statePath] = process.argv.slice(2);
if (!baseDir || !statePath) {
  throw new Error("usage: export-kill-child <baseDir> <statePath>");
}

// A stalled stream holds no handle, so without this Node would simply exit ("unsettled top-level await")
// and the parent would never get to kill a LIVE process.
setInterval(() => undefined, 1000);

const h = await makeHarness({ baseDir, fakeStatePath: statePath, webBigBytes: 400_000 });
h.fake.volumeFaults.set("web-uploads", { stallAfterBytes: 50_000 });
h.fake.onCall = (op, target) => {
  if (op === "volumeArchive" && target === "web-uploads") {
    // The app was stopped before its volume is read, so this is "stopped, mid-snapshot".
    console.log("STOPPED-AND-STREAMING");
  }
};

await h.run({
  scope: "application",
  operation: "move",
  appId: 1,
  selection: [2, 3],
  mode: "cutover",
  strategies: { default: "stop", perApp: {} },
  acceptRisks: { web: "quiesced-unverified", db: "quiesced-unverified" }
});
