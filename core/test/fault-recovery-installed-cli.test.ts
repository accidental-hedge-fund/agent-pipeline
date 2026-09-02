// Installed-CLI black-box layer for the universal fault-recovery matrix (#1333).
// Drives public entrypoints through COMMAND_REGISTRY with injected fakes.
// No live GitHub writes, production credentials, network, git, or subprocess.

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_REGISTRY, lookupCommand } from "../scripts/command-registry.ts";
import {
  MATRIX_FAULT_STATES,
  observeAdapterFault,
  requiredMatrixOperations,
} from "../scripts/fault-recovery-matrix.ts";

test("installed-cli layer uses injected seams not live GitHub", () => {
  for (const name of Object.keys(COMMAND_REGISTRY)) {
    const entry = lookupCommand(name);
    assert.ok(entry, `registered command missing: ${name}`);
  }
  const obs = observeAdapterFault({ fault_state: "exception" });
  assert.equal(obs.declared_run_terminal, false);
});

for (const operation of requiredMatrixOperations()) {
  test(`installed-cli: ${operation}`, () => {
    const key = operation === "drive" ? "advance" : operation;
    const entry = lookupCommand(key === "drive" ? undefined : key);
    assert.ok(entry, `supervised operation ${operation} must be registered`);
    for (const fault of MATRIX_FAULT_STATES) {
      const obs = observeAdapterFault({ fault_state: fault });
      assert.equal(obs.declared_run_terminal, false, `${operation} ${fault} declared terminal`);
      assert.equal(obs.false_human, false, `${operation} ${fault} false-human`);
      assert.equal(obs.ownerless_terminal, false, `${operation} ${fault} ownerless`);
      assert.equal(obs.supervisor_stop, false, `${operation} ${fault} supervisor STOP`);
    }
  });
}

test("missing supervised disposition fails the inventory guard", async () => {
  const { collectFaultRecoveryInventoryGaps, FAULT_RECOVERY_MATRIX } = await import(
    "../scripts/fault-recovery-matrix.ts"
  );
  const required = requiredMatrixOperations();
  assert.ok(required.includes("single"));
  assert.ok(required.includes("loop"));
  assert.ok(required.includes("train"));
  const withoutShip = FAULT_RECOVERY_MATRIX.filter((row) => row.operation !== "ship");
  const gaps = collectFaultRecoveryInventoryGaps(withoutShip);
  assert.ok(gaps.some((g) => g.class_id === "operation:ship"));
});

test("STOP-on-exhaustion stub fails installed-cli mechanical rows", () => {
  const obs = observeAdapterFault({
    fault_state: "strategy_exhaustion",
    stop_on_exhaustion: true,
  });
  assert.equal(obs.supervisor_stop, true);
  assert.equal(obs.ownerless_terminal, true);
});
