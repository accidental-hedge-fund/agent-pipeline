// Host-conformance layer for the universal fault-recovery matrix (#1333).
// Reuses the outer-host conformance kit. Pass criteria are typed lifecycle
// outcomes, not prompt-text equality.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MATRIX_EXAMPLE_HOSTS,
  MATRIX_FAULT_STATES,
  MATRIX_REQUIRED_HOSTS,
  observeAdapterFault,
} from "../scripts/fault-recovery-matrix.ts";
import {
  BUILTIN_OUTER_HOST_IDS,
  allOuterHosts,
  ensureBuiltinOuterHostsRegistered,
  runOuterHostConformanceKit,
  _resetOuterHostRegistryForTests,
} from "../scripts/outer-hosts/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

function registerBuiltins(): void {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
}

for (const host of MATRIX_REQUIRED_HOSTS) {
  test(`host conformance: ${host}`, () => {
    registerBuiltins();
    if (host !== "direct_cli") {
      const reports = runOuterHostConformanceKit(allOuterHosts());
      const report = reports.find((r) => r.host === host);
      assert.ok(report, `conformance kit missing host ${host}`);
      assert.equal(report.ok, true, JSON.stringify(report.failures));
    }
    for (const fault of MATRIX_FAULT_STATES) {
      const obs = observeAdapterFault({ fault_state: fault });
      assert.equal(obs.declared_run_terminal, false);
      assert.notEqual(obs.unique_operation_terminal, "false_human_projection");
      assert.notEqual(obs.unique_operation_terminal, "ownerless_terminal");
      assert.equal(obs.supervisor_stop, false);
    }
  });
}

test("Hermes and OpenClaw stay example-supervisor fixtures", () => {
  registerBuiltins();
  const ids = allOuterHosts().map((h) => h.id);
  for (const host of MATRIX_EXAMPLE_HOSTS) {
    assert.ok(!ids.includes(host), `${host} must not be a shipped builtin`);
  }
  for (const id of BUILTIN_OUTER_HOST_IDS) {
    assert.ok(!MATRIX_EXAMPLE_HOSTS.includes(id as (typeof MATRIX_EXAMPLE_HOSTS)[number]));
  }
});

test("unsupported host capability is a typed request not a false-human", () => {
  const obs = observeAdapterFault({ fault_state: "capability_request" });
  assert.equal(obs.unique_operation_terminal, "typed_request");
  assert.equal(obs.false_human, false);
  assert.equal(obs.ownerless_terminal, false);
});
