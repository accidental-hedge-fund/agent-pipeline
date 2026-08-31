// Drift guard: supervisor contract and examples stay aligned with train_status v1.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrainStatus } from "../scripts/stages/train.ts";
import { textDefaultsOrDocumentsHermesStateProductionPin } from "../scripts/production-engine-pin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("CONTEXT ship path names freeze-eligible and ship-end-open-issue-gate (#1354)", () => {
  const context = read("CONTEXT.md");
  const shipPath = context.slice(context.indexOf("### Ship path"));
  assert.match(shipPath, /\*\*Freeze-eligible\*\*:/);
  assert.match(shipPath, /Train membership only/);
  assert.match(shipPath, /Not authorization to start FRG pack, release, or promote/);
  assert.match(shipPath, /\*\*Ship-end-open-issue-gate\*\*:/);
  assert.match(shipPath, /every post-train FRG pack/);
  assert.match(shipPath, /Pipeline labels do not exempt/);
});

test("FRG runbook and supervisor ship text document all-integrated freeze and pack-loop profile (#1252)", () => {
  const runbook = read("docs/factory-reliability-gate-runbook.md");
  const supervisor = read("docs/supervisor.md");
  const ship = read("docs/runbooks/ship-milestone.md");
  for (const [name, text] of [
    ["runbook", runbook],
    ["supervisor", supervisor],
    ["ship-milestone", ship],
  ] as const) {
    assert.match(
      text,
      /no open issues to freeze/,
      `${name} must name the all-integrated freeze stop it no longer hits`,
    );
    assert.match(
      text,
      /already-integrated/,
      `${name} must record already-integrated before FRG / release`,
    );
    assert.match(
      text,
      /\*\*not\*\* authorization to start FRG/,
      `${name} must not treat freeze-eligible integration as FRG start`,
    );
    assert.match(
      text,
      /pipeline:backlog/,
      `${name} must name leftover open backlog as fail-closed before FRG`,
    );
    assert.match(
      text,
      /fails? closed/,
      `${name} must document remaining-open fail-closed before FRG / release / promote`,
    );
    assert.match(
      text,
      /pipeline loop --label factory-gate --profile claude/,
      `${name} must name the native-/goal pack loop`,
    );
    assert.match(
      text,
      /pipeline factory-gate --for <X\.Y\.Z> --from-run <loop-run-id>/,
      `${name} must name the --from-run scorer`,
    );
    assert.match(text, /escape/i, `${name} must label skip as an escape`);
    assert.doesNotMatch(
      text,
      /use --skip-frg (when|if) .{0,60}non-claude|non-claude .{0,60}(should|must|use) --skip-frg/i,
      `${name} must not imply skip is the non-claude recovery`,
    );
  }
});

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

// #1030: needs-human / blocked is conditional — recoverable engine vs real human.
test("supervisor.md distinguishes recoverable engine blocked from true human-authority wait (#1030)", () => {
  const doc = read("docs/supervisor.md");
  assert.match(doc, /ship-path-autonomy\.md/);
  assert.match(doc, /recoverable engine|workflow/i);
  assert.match(doc, /deterministic recipe|loop recovery|re-train/i);
  assert.match(doc, /true human authority|human authority|wait for human/i);
  assert.match(doc, /Do \*\*not\*\* treat every|not.*unconditional/i);
  // Non-goals: no second control plane / merge authority from this guidance.
  assert.match(doc, /do \*\*not\*\* gain merge authority|second durable scheduler|second state machine/i);
  // Must not be a single unconditional wait row for all needs-human outcomes.
  assert.doesNotMatch(
    doc,
    /\|\s*`needs-human`\s*\/\s*blocked\s*\|\s*Report `blocker`; wait for human/,
  );
});

test("docs/ship-path-autonomy.md exists with five doctrine points and is linked from concepts (#1030)", () => {
  const doctrinePath = path.join(repoRoot, "docs/ship-path-autonomy.md");
  assert.ok(fs.existsSync(doctrinePath), "docs/ship-path-autonomy.md must exist");
  const doctrine = read("docs/ship-path-autonomy.md");
  assert.match(doctrine, /Ship path|base-eligible frontiers/i);
  assert.match(doctrine, /Recovery ladder|deterministic recipe/i);
  assert.match(doctrine, /False human vs real human/i);
  assert.match(doctrine, /Class over site/i);
  assert.match(doctrine, /Anti-goals/i);
  assert.match(doctrine, /pipeline-ship-path-autonomy:\s*v1/);
  const concepts = read("docs/concepts.md");
  assert.match(concepts, /ship-path-autonomy\.md/);
  assert.match(concepts, /Ship-path autonomy|ship-path autonomy/i);
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
    "examples/supervisor/shell/frg-pack-helpers.sh",
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
  // #1096: Ship milestone maps to pipeline ship --milestone, not Tugboat-as-owner.
  assert.match(hermes, /pipeline ship --milestone/);
  assert.match(hermes, /Ship milestone vX\.Y\.Z/i);
  // #1039: default is FRG pack then release; skip is escape only.
  assert.match(hermes, /FRG pack/i);
  assert.match(hermes, /operator escape/i);
  assert.doesNotMatch(hermes, /optional \/ advisory|FRG is not part of thin ship/i);
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
  assert.match(shipDoc, /pipeline ship --milestone/);
  assert.doesNotMatch(shipDoc, /never in-engine ship|in-engine `pipeline ship` is parked/i);
  assert.match(shipDoc, /factory-release prepare/);
  assert.doesNotMatch(shipDoc, /FRG is not part of thin ship|optional \/ advisory/);
  const readme = read("examples/supervisor/README.md");
  assert.match(readme, /pipeline ship --milestone/);
  assert.doesNotMatch(readme, /never in-engine ship/i);
});

// #1183: one live production pin. SKILL / env.example must not default or
// document the Hermes-state path as a live pin.
const HERMES_SUPERVISOR_PIN_SOURCES = [
  "examples/supervisor/hermes/SKILL.md",
  "examples/supervisor/hermes/env.example",
] as const;

test("hermes supervisor SKILL and env.example do not default a Hermes-state pin (#1183)", () => {
  for (const rel of HERMES_SUPERVISOR_PIN_SOURCES) {
    const body = read(rel);
    assert.equal(
      textDefaultsOrDocumentsHermesStateProductionPin(body),
      false,
      `${rel} must not default or document hermes-factory/production-engine-pin.json`,
    );
  }
  const env = read("examples/supervisor/hermes/env.example");
  const liveAssign = env
    .split("\n")
    .find((l) => /^\s*AGENT_PIPELINE_PRODUCTION_PIN=/.test(l) && !l.trim().startsWith("#"));
  if (liveAssign) {
    assert.match(
      liveAssign,
      /\$REPO_DIR\/\.agent-pipeline\/production-engine-pin\.json/,
      "env.example live AGENT_PIPELINE_PRODUCTION_PIN must be the control-checkout pin",
    );
  }
});

test("hermes-state pin detector fails when the SKILL default is injected (#1183)", () => {
  const injected =
    'export AGENT_PIPELINE_PRODUCTION_PIN="${AGENT_PIPELINE_PRODUCTION_PIN:-$HOME/.local/state/hermes-factory/production-engine-pin.json}"';
  assert.equal(textDefaultsOrDocumentsHermesStateProductionPin(injected), true);
  assert.equal(
    textDefaultsOrDocumentsHermesStateProductionPin(
      "AGENT_PIPELINE_PRODUCTION_PIN=$REPO_DIR/.agent-pipeline/production-engine-pin.json",
    ),
    false,
  );
});

test("supervisor docs name the forbidden Hermes-state pin and v1.40.1 packaging bar (#1183)", () => {
  const supervisor = read("docs/supervisor.md");
  assert.match(supervisor, /install:production-pin-path/);
  assert.match(supervisor, /v1\.40\.1 packaging MAY template/);
  assert.match(supervisor, /MUST NOT\s+reintroduce a second live pin/);
  assert.match(supervisor, /hermes-factory\/production-engine-pin\.json/);
  const env = read("examples/supervisor/hermes/env.example");
  assert.match(env, /v1\.40\.1 packaging MAY template/);
  assert.match(env, /MUST NOT reintroduce a second live pin/);
  const deploy = read("docs/runbooks/hermes-supervisor-deployment.md");
  assert.match(deploy, /v1\.40\.1 packaging MAY template/);
  assert.match(deploy, /not pin authority/);
});
