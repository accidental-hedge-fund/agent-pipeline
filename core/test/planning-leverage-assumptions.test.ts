import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateAssumptionId,
  countUnresolved,
  createOpenAssumption,
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
