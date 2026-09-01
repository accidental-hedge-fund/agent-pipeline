// Host-surface drift-guard tests (#273, #1048).
//
// Covers:
//   7.5  OPERATION_SURFACE is the verb catalog. Hosts exec `pipeline <verb>`.
//        Build/install do not emit a per-verb command pack.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const COMMANDS_DIR = join(REPO_ROOT, "plugin", "pipeline", "commands");
const HOST_SKILL_PATHS = [
  join(REPO_ROOT, "hosts", "claude", "SKILL.md"),
  join(REPO_ROOT, "hosts", "codex", "SKILL.md"),
  join(REPO_ROOT, "hosts", "grok", "SKILL.md"),
  join(REPO_ROOT, "hosts", "opencode", "SKILL.md"),
];

// Canonical operation names per the namespaced-command-surface spec.
// run is intentionally absent — it is an undocumented alias only.
const EXPECTED_OPERATIONS = new Set([
  "status",
  "unblock",
  "override",
  "recover-parked",
  "summary",
  "doctor",
  "init",
  "cleanup",
  "intake",
  "decompose",
  "sweep",
  "grill",
  "triage",
  "merge",
  "merge-queue",
  "release",
  "roadmap",
  "logs",
  "loop",
  "train",
  "ship",
]);

// ---------------------------------------------------------------------------
// 7.5a  Every expected operation remains in the shared CLI catalog
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5a: OPERATION_SURFACE catalogs expected ops; no slash-command tree", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;
  const catalog = new Set(OPERATION_SURFACE.map((op: { name: string }) => op.name));
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(catalog.has(expected), `OPERATION_SURFACE missing catalog entry: ${expected}`);
  }
  for (const actual of catalog) {
    assert.ok(
      EXPECTED_OPERATIONS.has(actual),
      `OPERATION_SURFACE has unexpected operation: ${actual}`,
    );
  }

  // Generate-into-temp is covered in scripts/build.test.mjs; here assert the
  // committed plugin tree is not a slash-command pack.
  const files = existsSync(COMMANDS_DIR)
    ? readdirSync(COMMANDS_DIR).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"))
    : [];
  assert.deepEqual(files, [], "plugin/pipeline/commands/ must not contain pipeline:*.md");
});

test("namespaced-commands 7.5a2: live surfaces advertise direct CLI verbs only", () => {
  const truthfulSurfacePaths = [
    ...HOST_SKILL_PATHS,
    join(REPO_ROOT, "CLAUDE.md"),
    join(REPO_ROOT, "README.md"),
    join(REPO_ROOT, "docs", "concepts.md"),
    join(REPO_ROOT, "core", "scripts", "pipeline.ts"),
  ];

  for (const surfacePath of truthfulSurfacePaths) {
    const content = readFileSync(surfacePath, "utf8");
    assert.doesNotMatch(
      content,
      /(?:\/|\$)pipeline:[a-z]/,
      `${surfacePath} must not advertise a removed per-verb host token`,
    );
  }

  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /First-ever invocation runs `npm install`/);
  assert.match(readme, /best-effort dependency prewarm with `npm ci`/);
  assert.match(readme, /first non-version launcher invocation retries/);
  assert.match(readme, /fails closed with manual remediation/);

  const packaging = readFileSync(join(REPO_ROOT, "docs", "packaging.md"), "utf8");
  assert.doesNotMatch(packaging, /generated mirror\s+of\s+`core\/`/i);
  assert.match(packaging, /OMP\/Tugboat is a tree\/native-CLI install host/);
  assert.match(packaging, /It has no SKILL overlay/);
});

// ---------------------------------------------------------------------------
// 7.5b  No pipeline:run host command exists (run is undocumented alias only)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b: no pipeline:run.md command file exists", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR);
  } catch {
    // If commands dir doesn't exist, run isn't there either — pass
    files = [];
  }
  assert.equal(
    files.includes("pipeline:run.md"),
    false,
    "pipeline:run.md must not exist — run is an undocumented alias, not a surface command",
  );

  for (const skillPath of HOST_SKILL_PATHS) {
    assert.doesNotMatch(
      readFileSync(skillPath, "utf8"),
      /^(?:\/|\$)pipeline run\b/m,
      `${skillPath} must not advertise the legacy run alias`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7.5b2  Codex and Claude operation sets are symmetric (both from OPERATION_SURFACE)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b2: OPERATION_SURFACE is the shared catalog; no yaml agents generated", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderCodexCommand } = buildMjs;
  assert.equal(renderCodexCommand, undefined, "renderCodexCommand must not be exported");
  const names = new Set(OPERATION_SURFACE.map((op: { name: string }) => op.name));
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(names.has(expected), `OPERATION_SURFACE missing operation: ${expected}`);
  }
  for (const actual of names) {
    if (actual === "run") continue;
    assert.ok(EXPECTED_OPERATIONS.has(actual), `OPERATION_SURFACE has unexpected operation: ${actual}`);
  }
});

// ---------------------------------------------------------------------------
// 7.5b3  The `loop` wrapper describes the in-repo supervisor — never external
//        goal-loop delegation (regression for the v1.26.0 internalization, #512).
//        The stale wrapper told the invoking agent to "delegate to the installed
//        goal-loop skill", contradicting the shipped in-repo supervisor and
//        causing a wrong external-skill invocation.
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b3: host SKILL loop guidance drives in-repo, never an external goal-loop skill", () => {
  const hostSkills = [
    join(REPO_ROOT, "hosts", "claude", "SKILL.md"),
    join(REPO_ROOT, "hosts", "codex", "SKILL.md"),
  ];
  for (const skillPath of hostSkills) {
    const content = readFileSync(skillPath, "utf8");
    assert.ok(
      !/delegate to the installed goal-loop/i.test(content),
      `${skillPath} must not instruct external goal-loop delegation`,
    );
    assert.ok(
      !/loop:contract-coherence/.test(content),
      `${skillPath} must not miscite loop:contract-coherence`,
    );
    assert.ok(
      /in-repo/i.test(content) && /supervisor/i.test(content),
      `${skillPath} should describe the in-repo loop supervisor`,
    );
    assert.match(content, /pipeline loop logs <loop-run-id> --events --follow/);
  }
});

// ---------------------------------------------------------------------------
// 7.5b4  Loop packaging is long-running + event-followed — never the shared
//        fast template that claims "completes in seconds" and forbids Monitor
//        (#668 / loop-skill-event-orchestration).
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b4: loop SKILL packaging is long-running; generator writes no pipeline:loop.md", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;

  const loopOp = OPERATION_SURFACE.find(
    (op: { name: string; fast?: boolean; inRepoLoop?: boolean }) => op.name === "loop",
  ) as { name: string; fast?: boolean; inRepoLoop?: boolean } | undefined;
  assert.ok(loopOp, "OPERATION_SURFACE is missing the `loop` operation");
  assert.equal(loopOp.fast, false, "loop must not be classified as the shared fast template (#668)");
  assert.equal(loopOp.inRepoLoop, true, "loop must keep inRepoLoop packaging");

  for (const host of ["claude", "codex", "grok", "opencode"] as const) {
    const skill = readFileSync(join(REPO_ROOT, "hosts", host, "SKILL.md"), "utf8");
    assert.match(
      skill,
      /long-running/i,
      `${host} SKILL must state multi-item drive/resume is long-running`,
    );
    assert.doesNotMatch(
      skill,
      /completes in seconds/i,
      `${host} SKILL must not use the fast-command completion claim`,
    );
    assert.doesNotMatch(
      skill,
      /No background process or Monitor needed/i,
      `${host} SKILL must not forbid its required background monitor`,
    );
    assert.match(skill, /pipeline loop logs <loop-run-id> --events --follow/);
  }
  assert.equal(
    existsSync(join(COMMANDS_DIR, "pipeline:loop.md")),
    false,
    "scripts/build.mjs must not write plugin/pipeline/commands/pipeline:loop.md",
  );
});

test("namespaced-commands 7.5b4b: true-fast peers may still note seconds; no slash files emitted", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;

  for (const name of ["status", "doctor"] as const) {
    const op = OPERATION_SURFACE.find((o: { name: string; fast?: boolean }) => o.name === name) as
      | { name: string; fast?: boolean }
      | undefined;
    assert.ok(op, `OPERATION_SURFACE is missing \`${name}\``);
    assert.equal(op.fast, true, `${name} stays a fast catalog entry`);
    assert.equal(
      existsSync(join(COMMANDS_DIR, `pipeline:${name}.md`)),
      false,
      `generator must not emit pipeline:${name}.md`,
    );
  }
  const concepts = readFileSync(join(REPO_ROOT, "docs", "concepts.md"), "utf8");
  assert.ok(
    /completes in seconds/i.test(concepts),
    "durable docs MAY still note that true-fast verbs complete in seconds",
  );
});

// #699: host loop orchestration must stop run-scoped follows on terminal in the
// same turn; dual-follow must exit; one-liners must not claim unconditional
// "no auto-exit on terminal" without documenting until-terminal default.
// Bare `tail -F …events.jsonl` is forbidden as a documented follow command —
// it never exits on loop_run_stopped (zombie-follow failure mode).
test("namespaced-commands 7.5b6: host loop skill stop-on-terminal (#699)", () => {
  const concepts = readFileSync(join(REPO_ROOT, "docs", "concepts.md"), "utf8");
  for (const skillPath of HOST_SKILL_PATHS) {
    const body = readFileSync(skillPath, "utf8");
    assert.ok(/loop_run_stopped/i.test(body), `${skillPath} must mention loop_run_stopped`);
    assert.ok(
      /in the same\s+turn/i.test(body),
      `${skillPath} must require same-turn stop of run-scoped follows`,
    );
    assert.ok(
      /follows stopped/i.test(body),
      `${skillPath} final summary must include follows-stopped confirmation`,
    );
    assert.doesNotMatch(body, /^\s*tail\s+-F\s+/m);
    assert.doesNotMatch(body, /\bmktemp\s+-u\b/);
    assert.doesNotMatch(body, /owns tail via process substitution/i);
  }
  assert.match(concepts, /loop_run_stopped/);
  assert.match(concepts, /<state-home>\/runs\/<loop_run_id>\/events\.jsonl/);
});

// #725: single-issue advance §4 must require re-attach after cancelled/lost
// follow, treat cancelled wait as non-terminal, and document run-store
// re-attach path (status + logs --events --follow + summary).
test("namespaced-commands 7.5b7: host advance skill re-attach + cancelled-wait-not-terminal (#725)", () => {
  const concepts = readFileSync(join(REPO_ROOT, "docs", "concepts.md"), "utf8");
  for (const skillPath of HOST_SKILL_PATHS) {
    const body = readFileSync(skillPath, "utf8");
    assert.ok(/Reattach an interrupted follow/i.test(body), `${skillPath} must require reattach`);
    assert.ok(/Interrupted follow is non-terminal/i.test(body));
    assert.ok(/Cancelled wait is not completion/i.test(body));
    assert.match(body, /pipeline status <N>/);
    assert.match(body, /pipeline logs <advance-run-id> --events --follow/);
    assert.match(body, /pipeline loop logs <loop-run-id> --events --follow/);
    assert.ok(/terminal reason/i.test(body));
  }
  assert.match(concepts, /pipeline status <N>/);
  assert.match(concepts, /does not discover a run id/);
  assert.match(concepts, /pipeline logs <advance-run-id> --events --follow/);
  assert.match(concepts, /pipeline loop logs <loop-run-id> --events --follow/);
});

test("namespaced-commands 7.5b6b: host SKILL loop packaging requires same-turn stop + follows stopped (#699)", () => {
  const claude = readFileSync(join(REPO_ROOT, "hosts", "claude", "SKILL.md"), "utf8");
  assert.ok(/loop_run_stopped/i.test(claude), "loop SKILL packaging must mention loop_run_stopped");
  assert.ok(
    /same turn|same-turn|in the same/i.test(claude) || /stop.*follow/i.test(claude),
    "loop SKILL packaging must instruct stop of follows on terminal",
  );
});

// #668 pre-merge: skill lock discovery must not use unanchored grep of $LOOP_PID
// (pid 123 matching lock pid 12345).
test("namespaced-commands 7.5b5: generated SKILL does not embed PID-grep discovery", () => {
  const badGrep = /grep\s+-q\s+"\\"pid\\"[^"]*\$LOOP_PID/;
  for (const path of HOST_SKILL_PATHS) {
    const body = readFileSync(path, "utf8");
    assert.ok(!badGrep.test(body), `${path} must not use unanchored grep of $LOOP_PID`);
    assert.doesNotMatch(body, /pipeline-loop-\$\.out|pipeline-loop-\$\$\.out/);
  }
  const concepts = readFileSync(join(REPO_ROOT, "docs", "concepts.md"), "utf8");
  assert.match(concepts, /AGENT_PIPELINE_STATE_HOME/);
  assert.match(concepts, /<state-home>\/runs\/<loop_run_id>\/events\.jsonl/);
});

test("namespaced-commands 7.5c: status is a CLI catalog verb, not a required slash file", async () => {
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE } = buildMjs;
  const status = OPERATION_SURFACE.find((op: { name: string }) => op.name === "status");
  assert.ok(status, "catalog must list status");
  assert.equal(existsSync(join(COMMANDS_DIR, "pipeline:status.md")), false);
});
