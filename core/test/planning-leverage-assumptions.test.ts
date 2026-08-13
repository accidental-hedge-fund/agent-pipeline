import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateAssumptionId,
  countUnresolved,
  createOpenAssumption,
  nextAssumptionOrdinal,
  projectAssumptionCurrentState,
  updateAssumptionStatus,
} from "../scripts/planning-leverage/assumptions.ts";

test("new assumption receives stable id and open status", () => {
  const a = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "API remains stable",
    introduced_phase: "planning",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  assert.ok(a.assumption_id.length > 0);
  assert.equal(a.kind, "assumption");
  assert.equal(a.status, "open");
  assert.equal(a.introduced_phase, "planning");
});

test("open question uses same identity contract", () => {
  const q = createOpenAssumption({
    run_id: "run-1",
    kind: "open_question",
    statement: "Which auth provider?",
    introduced_phase: "planning",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  assert.equal(q.kind, "open_question");
  assert.ok(q.assumption_id);
  assert.equal(q.status, "open");
});

test("resolve reuses assumption_id", () => {
  const open = createOpenAssumption({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: "x",
    introduced_phase: "planning",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  const resolved = updateAssumptionStatus({
    prior: open,
    status: "resolved",
    status_updated_at: "2026-08-13T13:00:00Z",
    resolved_in_phase: "implementation",
    resolution_note: "confirmed in code",
  });
  assert.equal(resolved.assumption_id, "A1");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution?.resolved_in_phase, "implementation");
});

test("history retained; current state is latest", () => {
  const open = createOpenAssumption({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: "x",
    introduced_phase: "planning",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  const resolved = updateAssumptionStatus({
    prior: open,
    status: "resolved",
    status_updated_at: "2026-08-13T13:00:00Z",
    resolved_in_phase: "implementation",
  });
  const events = [open, resolved];
  assert.equal(events.length, 2);
  const current = projectAssumptionCurrentState(events, "run-1");
  assert.equal(current.get("A1")?.status, "resolved");
});

test("unresolved counts exclude resolved", () => {
  const a1 = createOpenAssumption({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: "still open",
    introduced_phase: "planning",
    status_updated_at: "t1",
  });
  const a2open = createOpenAssumption({
    run_id: "run-1",
    assumption_id: "A2",
    kind: "assumption",
    statement: "will resolve",
    introduced_phase: "planning",
    status_updated_at: "t1",
  });
  const a2 = updateAssumptionStatus({
    prior: a2open,
    status: "resolved",
    status_updated_at: "t2",
    resolved_in_phase: "implementation",
  });
  const current = projectAssumptionCurrentState([a1, a2open, a2], "run-1");
  assert.equal(countUnresolved(current), 1);
  assert.equal(current.get("A1")?.status, "open");
});

test("reopen after resolve keeps the same id", () => {
  const open = createOpenAssumption({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: "x",
    introduced_phase: "planning",
    status_updated_at: "t1",
  });
  const resolved = updateAssumptionStatus({
    prior: open,
    status: "resolved",
    status_updated_at: "t2",
    resolved_in_phase: "implementation",
  });
  const reopened = updateAssumptionStatus({
    prior: resolved,
    status: "open",
    status_updated_at: "t3",
  });
  assert.equal(reopened.assumption_id, "A1");
  assert.equal(reopened.status, "open");
});

test("allocateAssumptionId is stable for same inputs", () => {
  const a = allocateAssumptionId({ run_id: "r", statement: "same", ordinal: 0 });
  const b = allocateAssumptionId({ run_id: "r", statement: "same", ordinal: 0 });
  const c = allocateAssumptionId({ run_id: "r", statement: "same", ordinal: 1 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("identical statements with distinct ordinals get distinct ids", () => {
  const a = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "same text twice",
    introduced_phase: "planning",
    status_updated_at: "t1",
    ordinal: 0,
  });
  const b = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "same text twice",
    introduced_phase: "planning",
    status_updated_at: "t1",
    ordinal: 1,
  });
  assert.notEqual(a.assumption_id, b.assumption_id);
  assert.equal(a.statement, b.statement);
  const current = projectAssumptionCurrentState([a, b], "run-1");
  assert.equal(current.size, 2);
  assert.equal(countUnresolved(current), 2);
});

test("nextAssumptionOrdinal skips occupied ordinals; status updates do not inflate", () => {
  const a0 = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "dup",
    introduced_phase: "planning",
    status_updated_at: "t1",
    ordinal: 0,
  });
  const a0resolved = updateAssumptionStatus({
    prior: a0,
    status: "resolved",
    status_updated_at: "t2",
    resolved_in_phase: "implementation",
  });
  assert.equal(
    nextAssumptionOrdinal({
      events: [a0, a0resolved],
      run_id: "run-1",
      kind: "assumption",
      statement: "dup",
    }),
    1,
  );
  const a1 = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "dup",
    introduced_phase: "planning",
    status_updated_at: "t3",
    ordinal: 1,
  });
  assert.equal(
    nextAssumptionOrdinal({
      events: [a0, a0resolved, a1],
      run_id: "run-1",
      kind: "assumption",
      statement: "dup",
    }),
    2,
  );
  // Status update on a1 must keep a1's id (not reallocate).
  const a1deferred = updateAssumptionStatus({
    prior: a1,
    status: "deferred",
    status_updated_at: "t4",
  });
  assert.equal(a1deferred.assumption_id, a1.assumption_id);
  const current = projectAssumptionCurrentState(
    [a0, a0resolved, a1, a1deferred],
    "run-1",
  );
  assert.equal(current.size, 2);
  assert.equal(current.get(a0.assumption_id)?.status, "resolved");
  assert.equal(current.get(a1.assumption_id)?.status, "deferred");
});

test("nextAssumptionOrdinal returns lowest free under sparse producer ordinal", () => {
  // Regression #702 9d6443b4: producer supplies ordinal 1 only; count-based
  // next would return 1 and recreate that id. Lowest free is 0.
  const sparse = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "shared text",
    introduced_phase: "planning",
    status_updated_at: "t1",
    ordinal: 1,
  });
  assert.equal(
    nextAssumptionOrdinal({
      events: [sparse],
      run_id: "run-1",
      kind: "assumption",
      statement: "shared text",
    }),
    0,
  );
  const hole = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "shared text",
    introduced_phase: "planning",
    status_updated_at: "t2",
    ordinal: 0,
  });
  // 0 and 1 taken → next is 2 (not count==2 only by coincidence).
  assert.equal(
    nextAssumptionOrdinal({
      events: [sparse, hole],
      run_id: "run-1",
      kind: "assumption",
      statement: "shared text",
    }),
    2,
  );
  // Gap: only 0 and 2 present → next is 1.
  const high = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "gap text",
    introduced_phase: "planning",
    status_updated_at: "t3",
    ordinal: 2,
  });
  const low = createOpenAssumption({
    run_id: "run-1",
    kind: "assumption",
    statement: "gap text",
    introduced_phase: "planning",
    status_updated_at: "t4",
    ordinal: 0,
  });
  assert.equal(
    nextAssumptionOrdinal({
      events: [high, low],
      run_id: "run-1",
      kind: "assumption",
      statement: "gap text",
    }),
    1,
  );
});

test("open assumption still visible after planning ends", () => {
  const open = createOpenAssumption({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: "carried forward",
    introduced_phase: "planning",
    status_updated_at: "t-plan",
  });
  // Implementation phase emits other events but not a drop of A1
  const current = projectAssumptionCurrentState([open], "run-1");
  assert.equal(current.get("A1")?.status, "open");
});
