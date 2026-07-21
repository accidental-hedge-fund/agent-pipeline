// Tests for seeded, harness-interleaved, resumable scheduling
// (openspec/changes/stage-eval-runner). No real fs/git/subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cellsRemaining, makeSeededRandom, scheduleCells } from "../scripts/evals/scheduler.ts";
import type { Cell, CellRecord } from "../scripts/evals/types.ts";

function makeCell(fixtureId: string, harness: string, replicate: number): Cell {
  const treatmentId = `harness=${harness}`;
  return {
    cell_id: `exp1/${fixtureId}/${treatmentId}/${replicate}`,
    experiment_id: "exp1",
    fixture_id: fixtureId,
    treatment_id: treatmentId,
    treatment: { harness },
    replicate,
    mode: "review",
    base_sha: "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd",
  };
}

test("makeSeededRandom: same seed produces the same sequence", () => {
  const r1 = makeSeededRandom(7);
  const r2 = makeSeededRandom(7);
  const seq1 = Array.from({ length: 5 }, () => r1());
  const seq2 = Array.from({ length: 5 }, () => r2());
  assert.deepEqual(seq1, seq2);
});

test("makeSeededRandom: different seeds diverge", () => {
  const r1 = makeSeededRandom(1);
  const r2 = makeSeededRandom(2);
  assert.notEqual(r1(), r2());
});

test("scheduleCells: same manifest and seed reproduce the same order", () => {
  const cells = [
    makeCell("f1", "claude", 1),
    makeCell("f1", "codex", 1),
    makeCell("f2", "claude", 1),
    makeCell("f2", "codex", 1),
  ];
  const order1 = scheduleCells(cells, 99).map((c) => c.cell_id);
  const order2 = scheduleCells(cells, 99).map((c) => c.cell_id);
  assert.deepEqual(order1, order2);
});

test("scheduleCells: is a permutation — every cell appears exactly once", () => {
  const cells = [makeCell("f1", "claude", 1), makeCell("f1", "codex", 1), makeCell("f2", "claude", 1)];
  const scheduled = scheduleCells(cells, 5);
  assert.equal(scheduled.length, cells.length);
  assert.deepEqual(
    new Set(scheduled.map((c) => c.cell_id)),
    new Set(cells.map((c) => c.cell_id)),
  );
});

test("scheduleCells: interleaves harnesses — consecutive cells do not all share one harness", () => {
  const cells: Cell[] = [];
  for (let i = 1; i <= 6; i++) {
    cells.push(makeCell(`f${i}`, "claude", 1));
    cells.push(makeCell(`f${i}`, "codex", 1));
  }
  const scheduled = scheduleCells(cells, 123);
  const harnesses = scheduled.map((c) => c.treatment.harness);
  // If harnesses were merely shuffled without interleaving, it would be plausible
  // (though unlikely) for 6 same-harness cells to appear consecutively; assert
  // that never happens for any window of length > half the bucket size.
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < harnesses.length; i++) {
    run = harnesses[i] === harnesses[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, `expected interleaving to bound same-harness runs, got a run of ${maxRun}`);
});

test("scheduleCells: single-harness plans are unaffected by interleaving", () => {
  const cells = [makeCell("f1", "claude", 1), makeCell("f2", "claude", 1), makeCell("f3", "claude", 1)];
  const scheduled = scheduleCells(cells, 1);
  assert.equal(scheduled.length, 3);
});

test("cellsRemaining: drops cells with an existing record, keeps the rest", () => {
  const cells = [makeCell("f1", "claude", 1), makeCell("f1", "codex", 1), makeCell("f2", "claude", 1)];
  const existing: CellRecord[] = [
    {
      cell_id: cells[0].cell_id,
      experiment_id: "exp1",
      fixture_id: "f1",
      treatment_id: "harness=claude",
      replicate: 1,
      prompt_hash: "x",
      config_hash: "y",
      base_sha: cells[0].base_sha,
      result_class: "completed",
    },
  ];
  const remaining = cellsRemaining(cells, existing);
  assert.deepEqual(remaining.map((c) => c.cell_id), [cells[1].cell_id, cells[2].cell_id]);
});

test("cellsRemaining: no existing records → all cells remain", () => {
  const cells = [makeCell("f1", "claude", 1)];
  assert.deepEqual(cellsRemaining(cells, []), cells);
});
