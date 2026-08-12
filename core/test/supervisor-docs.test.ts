// Drift guard: supervisor contract and examples stay aligned with train_status v1.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrainStatus } from "../scripts/stages/train.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("supervisor.md documents train_status schema_version 1", () => {
  const doc = read("docs/supervisor.md");
  assert.match(doc, /schema_version:\s*1|"schema_version":\s*1/);
  assert.match(doc, /"kind":\s*"train_status"|kind:\s*"train_status"|kind.*train_status/);
  assert.match(doc, /pipeline train/);
  assert.match(doc, /--merge/);
  assert.match(doc, /ALLOW_MERGE|opt-in/i);
  assert.match(doc, /examples\/supervisor/);
  assert.match(doc, /release finish|release_finish/);
  assert.match(doc, /engine-promote/);
});

test("buildTrainStatus still emits schema_version 1 envelope", () => {
  const s = buildTrainStatus({
    ordered_issues: [1],
    current_issue: null,
    current_index: 0,
    next_action: "complete",
    merge_mode: false,
    items: [],
    blocker: null,
    complete: true,
  });
  assert.equal(s.schema_version, 1);
  assert.equal(s.kind, "train_status");
});

test("supervisor examples exist and stay thin", () => {
  for (const rel of [
    "examples/supervisor/README.md",
    "examples/supervisor/shell/run-intent.sh",
    "examples/supervisor/shell/ship-stage-watch.sh",
    "examples/supervisor/shell/tugboat.sh",
    "examples/supervisor/shell/ship-milestone.sh",
    "examples/supervisor/shell/pipeline-ship-playbook.sh",
    "examples/supervisor/shell/train-status-complete.py",
    "examples/supervisor/shell/release-checks-green.py",
    "examples/supervisor/hermes/SKILL.md",
    "examples/supervisor/openclaw/SKILL.md",
    "examples/supervisor/slack/README.md",
    "docs/runbooks/hermes-supervisor-deployment.md",
    "docs/runbooks/ship-milestone.md",
  ]) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `missing ${rel}`);
  }
  const shell = read("examples/supervisor/shell/run-intent.sh");
  assert.match(shell, /ALLOW_MERGE/);
  assert.match(shell, /pipeline train|--issues|--milestone|train/);
  assert.doesNotMatch(shell, /ops\/hermes-factory|grant_fingerprint|auto_merge/);
  const hermes = read("examples/supervisor/hermes/SKILL.md");
  assert.match(hermes, /does not implement a second state machine|Not the removed/i);
  // Option 1 (#927 / #1001): Ship milestone maps to Tugboat, not playbook-as-primary.
  assert.match(hermes, /tugboat/i);
  assert.match(hermes, /Ship milestone vX\.Y\.Z/i);
  const stageWatch = read("examples/supervisor/shell/ship-stage-watch.sh");
  assert.match(stageWatch, /--events-file/);
  assert.match(stageWatch, /PIPELINE_MATERIAL_FILTER/);
  assert.doesNotMatch(stageWatch, /AGENT_PIPELINE_LOOP_ROOT|\.local\/state\/agent-pipeline|ps -eo|ls -t/);
  const ship = read("examples/supervisor/shell/ship-milestone.sh");
  assert.match(ship, /pipeline.*ship|ship_args/s);
  assert.match(ship, /systemd-run/);
  assert.doesNotMatch(ship, /release finish|engine-promote|gh release view/);
  const shipDoc = read("docs/runbooks/ship-milestone.md");
  assert.match(shipDoc, /exact.*events\.jsonl|events\.jsonl.*exact/i);
  assert.match(shipDoc, /material-filter\.mjs/);
  assert.match(shipDoc, /tugboat\.sh|Option 1/i);
  assert.match(shipDoc, /Alternate|legacy|non-primary/i);
  const readme = read("examples/supervisor/README.md");
  assert.match(readme, /tugboat\.sh/);
  assert.match(readme, /Option 1 primary|primary ship composer/i);
});
