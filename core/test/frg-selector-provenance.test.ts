import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSelectorMatches,
  compileWorkListRunFresh,
} from "../scripts/pipeline.ts";
import {
  validateFrgPackContract,
} from "../scripts/factory-reliability-gate.ts";
import type { WorkListDependencyDiscoverDeps } from "../scripts/loop/work-list-deps.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const cfg = {
  repo: "owner/repo",
  base_branch: "main",
  repo_dir: "/tmp/frg-selector-provenance",
} as PipelineConfig;

const noDependencies: WorkListDependencyDiscoverDeps = {
  getIssueTitleBody: async () => ({ title: "FRG fixture", body: "" }),
  getBlockedByIssueNumbers: async () => [],
};

test("fresh label pack compilation preserves selector provenance for FRG validation", async () => {
  const selector = { type: "label", value: "factory-gate" } as const;
  const { contract } = await compileWorkListRunFresh(
    cfg,
    "codex",
    ["101", "102"],
    "loop-label-pack",
    noDependencies,
    selector,
  );

  assert.deepEqual(contract.selector, selector);
  assert.deepEqual(contract.items.map((item) => item.id), ["101", "102"]);
  assert.deepEqual(validateFrgPackContract(contract as never), { ok: true });
});

test("fresh milestone pack compilation preserves normalized milestone provenance", async () => {
  const selector = { type: "milestone", value: "frg-pack" } as const;
  const { contract } = await compileWorkListRunFresh(
    cfg,
    "codex",
    ["201", "202"],
    "loop-milestone-pack",
    noDependencies,
    selector,
  );

  assert.deepEqual(contract.selector, selector);
  assert.deepEqual(validateFrgPackContract(contract as never), { ok: true });
});

test("fresh explicit work list remains ad-hoc and is rejected as an FRG pack", async () => {
  const selector = { type: "work-list", value: ["301", "302"] } as const;
  const { contract } = await compileWorkListRunFresh(
    cfg,
    "codex",
    selector.value,
    "loop-ad-hoc",
    noDependencies,
    selector,
  );

  assert.deepEqual(contract.selector, { type: "work-list", value: ["301", "302"] });
  const validation = validateFrgPackContract(contract as never);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.match(validation.detail, /not an FRG fixed-pack selector/);
});

test("canonical selector reuse refuses an equal issue list from another selector", () => {
  const issues = ["301", "302"];
  assert.equal(
    canonicalSelectorMatches(
      { type: "work-list", value: issues },
      { type: "label", value: "factory-gate" },
      issues,
    ),
    false,
  );
  assert.equal(
    canonicalSelectorMatches(
      { type: "label", value: "factory-gate" },
      { type: "label", value: "factory-gate" },
      issues,
    ),
    true,
  );
  assert.equal(
    canonicalSelectorMatches(
      { type: "milestone", value: "frg-pack" },
      { type: "label", value: "factory-gate" },
      issues,
    ),
    false,
  );
});
