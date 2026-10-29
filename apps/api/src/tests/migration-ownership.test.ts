import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  activateStandby,
  assertNotDoubleLive,
  createDormantCopy,
  createStandby,
  describeOwnership,
  discardStandby,
  fence,
  newLiveRecord,
  OwnershipError,
  promoteDormantCopy,
  retire,
  sideEffectsAllowed,
  unfence,
  OWNERSHIP_STATES,
  type OwnershipRecord
} from "../migration/ownership.js";

const MIGRATION = "11111111-1111-4111-8111-111111111111";
const OTHER_MIGRATION = "22222222-2222-4222-8222-222222222222";

function live(serverId = "server-a"): OwnershipRecord {
  return newLiveRecord({ subject: "app:7", serverId });
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof OwnershipError && error.code === code);
}

describe("move: the happy path", () => {
  test("fence → standby → activate → retire, and the moved lineage is never live on both servers", () => {
    const source = live();
    assertNotDoubleLive(source, null);

    // 1. Fence the source. From here nothing may run on it.
    const fenced = fence(source, MIGRATION);
    assert.equal(fenced.record.state, "frozen-for-migration");
    assert.equal(sideEffectsAllowed(fenced.record), false);

    // 2. The destination holds an inert standby.
    const standby = createStandby({ receipt: fenced.receipt, destinationServerId: "server-b" });
    assert.equal(standby.state, "standby");
    assert.equal(standby.epoch, source.epoch + 1);
    assert.equal(standby.lineageId, source.lineageId);
    assert.equal(sideEffectsAllowed(standby), false);
    assertNotDoubleLive(fenced.record, standby);

    // 3. Activate with the receipt.
    const active = activateStandby(standby, fenced.receipt);
    assert.equal(active.state, "live");
    assertNotDoubleLive(fenced.record, active);

    // 4. Commit: the source is retired and says where the app went.
    const retired = retire(fenced.record, MIGRATION, "server-b");
    assert.equal(retired.state, "retired-after-move");
    assert.equal(retired.movedToServerId, "server-b");
    assert.equal(sideEffectsAllowed(retired), false);
    assertNotDoubleLive(retired, active);
  });

  test("the invariant checker really does catch two live copies of one lineage", () => {
    const a = live("server-a");
    const b = { ...a, ownerServerId: "server-b" };

    throwsCode(() => assertNotDoubleLive(a, b), "DOUBLE_LIVE");
    // Unrelated lineages (a copy) may both be live.
    assertNotDoubleLive(a, { ...b, lineageId: "different" });
  });
});

describe("move: rollback", () => {
  test("unfence restores the source and invalidates the old receipt (epoch bump)", () => {
    const fenced = fence(live(), MIGRATION);
    const standby = createStandby({ receipt: fenced.receipt, destinationServerId: "server-b" });

    const restored = unfence(fenced.record, MIGRATION);
    assert.equal(restored.state, "live");
    assert.equal(restored.epoch, fenced.record.epoch + 1);
    assert.equal(sideEffectsAllowed(restored), true);

    // The abandoned attempt's standby must be discarded, and the stale receipt can never go live.
    assert.equal(discardStandby(standby, MIGRATION), null);
    const lateStandby = createStandby({ receipt: fenced.receipt, destinationServerId: "server-b" });
    // A standby built from the old receipt would claim epoch+1, but the source has since moved past it.
    assert.ok(restored.epoch >= lateStandby.epoch);
  });

  test("a rolled-back move cannot be retired, and a committed move cannot be unfenced", () => {
    const fenced = fence(live(), MIGRATION);
    const restored = unfence(fenced.record, MIGRATION);
    throwsCode(() => retire(restored, MIGRATION, "server-b"), "INVALID_STATE");

    const retired = retire(fenced.record, MIGRATION, "server-b");
    throwsCode(() => unfence(retired, MIGRATION), "INVALID_STATE");
  });
});

describe("move: protections", () => {
  test("only a live subject can be fenced; fencing twice is refused", () => {
    const fenced = fence(live(), MIGRATION);

    throwsCode(() => fence(fenced.record, OTHER_MIGRATION), "INVALID_STATE");
    for (const state of OWNERSHIP_STATES.filter((s) => s !== "live")) {
      throwsCode(() => fence({ ...live(), state }, MIGRATION), "INVALID_STATE");
    }
  });

  test("unfence, retire and discard require the same migration id", () => {
    const fenced = fence(live(), MIGRATION);
    const standby = createStandby({ receipt: fenced.receipt, destinationServerId: "server-b" });

    throwsCode(() => unfence(fenced.record, OTHER_MIGRATION), "MIGRATION_MISMATCH");
    throwsCode(() => retire(fenced.record, OTHER_MIGRATION, "server-b"), "MIGRATION_MISMATCH");
    throwsCode(() => discardStandby(standby, OTHER_MIGRATION), "MIGRATION_MISMATCH");
  });

  test("a standby cannot go live without a receipt, or with the wrong or a stale one", () => {
    const fenced = fence(live(), MIGRATION);
    const standby = createStandby({ receipt: fenced.receipt, destinationServerId: "server-b" });

    throwsCode(() => activateStandby(standby, null), "RECEIPT_REQUIRED");
    throwsCode(() => activateStandby(standby, undefined), "RECEIPT_REQUIRED");
    throwsCode(
      () => activateStandby(standby, { ...fenced.receipt, migrationId: OTHER_MIGRATION }),
      "RECEIPT_MISMATCH"
    );
    throwsCode(() => activateStandby(standby, { ...fenced.receipt, subject: "app:8" }), "RECEIPT_MISMATCH");
    throwsCode(() => activateStandby(standby, { ...fenced.receipt, lineageId: "other" }), "RECEIPT_MISMATCH");
    throwsCode(() => activateStandby(standby, { ...fenced.receipt, epoch: fenced.receipt.epoch + 5 }), "STALE_RECEIPT");
    throwsCode(() => activateStandby(standby, { ...fenced.receipt, epoch: fenced.receipt.epoch - 1 }), "STALE_RECEIPT");
  });

  test("only a standby can be activated or discarded", () => {
    const fenced = fence(live(), MIGRATION);

    throwsCode(() => activateStandby(live(), fenced.receipt), "INVALID_STATE");
    throwsCode(() => discardStandby(live(), MIGRATION), "INVALID_STATE");
  });
});

describe("copy", () => {
  test("a copy is a new, dormant lineage that needs explicit acknowledgement to go live", () => {
    const source = live();
    const copy = createDormantCopy({
      subject: "app:7",
      destinationServerId: "server-b",
      sourceLineageId: source.lineageId,
      migrationId: MIGRATION
    });

    assert.equal(copy.state, "dormant-copy");
    assert.notEqual(copy.lineageId, source.lineageId);
    assert.equal(copy.copiedFromLineageId, source.lineageId);
    assert.equal(sideEffectsAllowed(copy), false);
    assert.equal(sideEffectsAllowed(source), true); // the original is untouched
    assertNotDoubleLive(source, copy); // different lineage: both may legitimately be live later

    throwsCode(() => promoteDormantCopy(copy, false), "ACKNOWLEDGEMENT_REQUIRED");
    const promoted = promoteDormantCopy(copy, true);
    assert.equal(promoted.state, "live");
    assert.equal(promoted.migrationId, null);
    throwsCode(() => promoteDormantCopy(promoted, true), "INVALID_STATE");
  });
});

describe("which server owns the app", () => {
  test("only 'live' allows side effects, and every state has a clear description", () => {
    const base = live("server-a");

    for (const state of OWNERSHIP_STATES) {
      const record: OwnershipRecord = { ...base, state, movedToServerId: state === "retired-after-move" ? "server-b" : null };
      assert.equal(sideEffectsAllowed(record), state === "live", state);
      assert.ok(describeOwnership(record, "server-a").length > 10);
    }

    assert.equal(describeOwnership(base, "server-a"), "Live on this server");
    assert.equal(describeOwnership(base, "server-z"), "Live on server-a");
    assert.match(
      describeOwnership({ ...base, state: "retired-after-move", movedToServerId: "server-b" }, "server-a"),
      /Moved to server-b/
    );
  });
});
