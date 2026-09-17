import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  UPDATE_STATES,
  canTransition,
  isInFlight,
  isPostCutover,
  isResting,
  isTerminal,
  isUpdateState,
  recoveryActionFor,
  type UpdateState
} from "../services/update-state-machine.js";

describe("update state machine", () => {
  test("isUpdateState guards the enum", () => {
    assert.equal(isUpdateState("installing"), true);
    assert.equal(isUpdateState("nonsense"), false);
    assert.equal(isUpdateState(42), false);
  });

  test("the happy path is a legal chain of transitions", () => {
    const path: UpdateState[] = [
      "idle",
      "checking",
      "update_available",
      "downloading",
      "verifying",
      "preparing",
      "installing",
      "migrating",
      "health_checking",
      "successful",
      "idle"
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
    }
  });

  test("the rollback path is legal", () => {
    assert.equal(canTransition("health_checking", "rolling_back"), true);
    assert.equal(canTransition("rolling_back", "rolled_back"), true);
    assert.equal(canTransition("rolling_back", "manual_intervention_required"), true);
    assert.equal(canTransition("rolled_back", "checking"), true);
  });

  test("illegal jumps are rejected", () => {
    assert.equal(canTransition("idle", "installing"), false);
    assert.equal(canTransition("checking", "successful"), false);
    assert.equal(canTransition("successful", "rolling_back"), false);
  });

  test("manual_intervention_required is only left by an explicit re-check", () => {
    assert.equal(canTransition("manual_intervention_required", "checking"), true);
    assert.equal(canTransition("manual_intervention_required", "idle"), false);
    assert.equal(canTransition("manual_intervention_required", "installing"), false);
  });

  test("state classification is consistent", () => {
    assert.equal(isResting("idle"), true);
    assert.equal(isResting("installing"), false);
    assert.equal(isInFlight("downloading"), true);
    assert.equal(isInFlight("idle"), false);
    assert.equal(isTerminal("successful"), true);
    assert.equal(isTerminal("checking"), false);
    assert.equal(isPostCutover("installing"), true);
    assert.equal(isPostCutover("verifying"), false);
  });

  test("every state has a defined outgoing-transition list", () => {
    for (const state of UPDATE_STATES) {
      // canTransition must not throw for any known state pairing.
      for (const other of UPDATE_STATES) {
        assert.doesNotThrow(() => canTransition(state, other));
      }
    }
  });

  test("recovery action distinguishes pre- and post-cutover interruptions", () => {
    // Pre-cutover work never touched the running version → safe to abandon.
    assert.equal(recoveryActionFor("downloading"), "abandon-safe");
    assert.equal(recoveryActionFor("verifying"), "abandon-safe");
    assert.equal(recoveryActionFor("preparing"), "abandon-safe");
    // Post-cutover → must inspect what is actually running.
    assert.equal(recoveryActionFor("installing"), "inspect-running");
    assert.equal(recoveryActionFor("migrating"), "inspect-running");
    assert.equal(recoveryActionFor("health_checking"), "inspect-running");
    assert.equal(recoveryActionFor("rolling_back"), "inspect-running");
    // Resting/terminal → nothing to reconcile.
    assert.equal(recoveryActionFor("idle"), "resume-normal");
    assert.equal(recoveryActionFor("successful"), "resume-normal");
    assert.equal(recoveryActionFor("failed"), "resume-normal");
  });
});
