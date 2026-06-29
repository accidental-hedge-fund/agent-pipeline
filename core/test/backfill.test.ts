// Unit tests for the backfill sub-command (#327).
//
// All tests use injectable BackfillDeps fakes — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCoverage,
  nonOpenspecPaths,
  runBackfill,
  type BackfillCandidate,
  type BackfillDeps,
} from "../scripts/stages/backfill.ts";
import { buildCmd } from "../scripts/pipeline.ts";
import { lookupCommand, validateFlags, COMMAND_REGISTRY } from "../scripts/command-registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mutable state tracked across BackfillDeps calls. */
interface DepsState {
  harnessCallCount: number;
  writtenFiles: Record<string, string>;
  gitBranches: string[];
  prOpened: string | null;
  logged: string[];
  listBehaviorsCalled: boolean;
}

function makeDeps(overrides: Partial<BackfillDeps> = {}): BackfillDeps & { state: DepsState } {
  const state: DepsState = {
    harnessCallCount: 0,
    writtenFiles: {},
    gitBranches: [],
    prOpened: null,
    logged: [],
    listBehaviorsCalled: false,
  };

  const defaultCandidates: BackfillCandidate[] = [
    { behavior: "The CLI exits with code 0 on success", provenance: "test/exit-codes.test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "Preview mode makes no writes", provenance: "README.md#preview-mode", evidence_grade: "sufficient", conflicts_with: null },
  ];

  const base: BackfillDeps = {
    runHarness: async (_prompt, _timeoutSec) => {
      state.harnessCallCount++;
      return { success: true, output: JSON.stringify(defaultCandidates) };
    },
    readLivingSpecs: (_dir) => [],
    readEvidenceCorpus: (_dir) => "test evidence corpus",
    validate: async (_dir) => ({ valid: true, unavailable: false, issues: [], raw: "" }),
    writeFile: (filePath, content) => { state.writtenFiles[filePath] = content; },
    gitResolveBaseSha: (_dir, _branch) => "abc1234",
    gitCreateBranch: (_dir, branch, _fromRef) => { state.gitBranches.push(branch); },
    gitCommit: (_dir, _files, _msg) => {},
    gitPushBranch: (_dir, _branch) => {},
    createPR: async (_dir, _title, _body, _base, _head) => {
      state.prOpened = "https://github.com/owner/repo/pull/999";
      return "https://github.com/owner/repo/pull/999";
    },
    gitGetStagedFiles: (_dir) => [],
    gitOpenspecDirtyFiles: (_dir) => [],
    listOpenBackfillPRBehaviors: (_dir) => {
      state.listBehaviorsCalled = true;
      return [];
    },
    log: (msg) => { state.logged.push(msg); },
  };

  const deps: BackfillDeps = { ...base, ...overrides };
  return Object.assign(deps, { state }) as BackfillDeps & { state: DepsState };
}

const cfg = { repo_dir: "/fake/repo", repo: "owner/repo", base_branch: "main" };

// ---------------------------------------------------------------------------
// classifyCoverage — pure function tests
// ---------------------------------------------------------------------------

test("classifyCoverage: absent workspace → everything is missing-coverage", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "The CLI prints version on --version", provenance: "test/version.test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "The CLI exits 0 on success", provenance: "test/exit.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const result = classifyCoverage(candidates, []);
  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.group === "missing-coverage"), "all should be missing-coverage with empty living specs");
});

test("classifyCoverage: candidate with no provenance → uncertain-evidence", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "Some vague behavior", provenance: "", evidence_grade: "uncertain", conflicts_with: null },
  ];
  const result = classifyCoverage(candidates, []);
  assert.equal(result[0]!.group, "uncertain-evidence");
});

test("classifyCoverage: uncertain grade → uncertain-evidence group", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "An unclear behavior", provenance: "some test", evidence_grade: "uncertain", conflicts_with: null },
  ];
  const result = classifyCoverage(candidates, []);
  assert.equal(result[0]!.group, "uncertain-evidence");
});

test("classifyCoverage: conflicting grade → conflicting-evidence group", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "The CLI does X in contradiction", provenance: "test.ts", evidence_grade: "conflicting", conflicts_with: "Existing Requirement A" },
  ];
  const result = classifyCoverage(candidates, []);
  assert.equal(result[0]!.group, "conflicting-evidence");
});

test("classifyCoverage: partial adoption — only uncovered behaviors are missing", () => {
  // One living requirement covers one behavior.
  const livingRequirements = ["The CLI prints version on version flag"];
  const candidates: BackfillCandidate[] = [
    { behavior: "The CLI prints version on version flag", provenance: "test/version.test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "The CLI exits 0 on success", provenance: "test/exit.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const result = classifyCoverage(candidates, livingRequirements);
  const covered = result.filter((c) => c.group === "already-covered");
  const missing = result.filter((c) => c.group === "missing-coverage");
  assert.equal(covered.length, 1, "one should be already-covered");
  assert.equal(missing.length, 1, "one should be missing-coverage");
});

test("classifyCoverage: already-proposed behaviors are flagged", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "The CLI exits 0 on success", provenance: "test/exit.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const result = classifyCoverage(candidates, [], ["The CLI exits 0 on success"]);
  assert.equal(result[0]!.group, "missing-coverage");
  assert.equal(result[0]!.already_proposed, true);
});

test("classifyCoverage: candidate in each group appears in exactly one group", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "Covered behavior", provenance: "test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "Missing behavior", provenance: "test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "Conflicting thing", provenance: "test.ts", evidence_grade: "conflicting", conflicts_with: "Requirement X" },
    { behavior: "Uncertain thing", provenance: "", evidence_grade: "uncertain", conflicts_with: null },
  ];
  const living = ["Covered behavior already specified in living spec"];
  const result = classifyCoverage(candidates, living);
  const groups = result.map((c) => c.group);
  // Each item appears exactly once.
  assert.equal(result.length, 4);
  // No duplicates.
  const seen = new Set<BackfillCandidate>();
  for (const c of result) {
    assert.ok(!seen.has(c.candidate));
    seen.add(c.candidate);
  }
  assert.ok(groups.includes("missing-coverage"));
  assert.ok(groups.includes("conflicting-evidence"));
  assert.ok(groups.includes("uncertain-evidence"));
});

// ---------------------------------------------------------------------------
// nonOpenspecPaths guard
// ---------------------------------------------------------------------------

test("nonOpenspecPaths: only non-openspec paths returned", () => {
  const paths = [
    "openspec/changes/backfill-foo/proposal.md",
    "openspec/changes/backfill-foo/specs/foo/spec.md",
    "src/main.ts",
    "README.md",
  ];
  const result = nonOpenspecPaths(paths);
  assert.deepEqual(result, ["src/main.ts", "README.md"]);
});

test("nonOpenspecPaths: all openspec paths → empty array", () => {
  const paths = ["openspec/specs/foo/spec.md", "openspec/changes/x/proposal.md"];
  const result = nonOpenspecPaths(paths);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// runBackfill — preview path (non-mutating)
// ---------------------------------------------------------------------------

test("runBackfill: preview — makes no writes, no branches, no PRs", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: false }, cfg, deps);

  assert.deepEqual(state.writtenFiles, {}, "no files written in preview");
  assert.deepEqual(state.gitBranches, [], "no branches created in preview");
  assert.equal(state.prOpened, null, "no PR opened in preview");
});

test("runBackfill: preview — output contains 'nothing changed' statement", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: false }, cfg, deps);

  const output = state.logged.join("\n");
  assert.ok(
    output.includes("No specs, issues, branches, or PRs were changed"),
    `expected 'nothing changed' statement in output, got:\n${output}`,
  );
});

test("runBackfill: preview — report contains all four groups", async () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "Covered thing", provenance: "test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "Missing thing", provenance: "test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "Conflicting thing", provenance: "test.ts", evidence_grade: "conflicting", conflicts_with: "Req X" },
    { behavior: "Uncertain thing", provenance: "", evidence_grade: "uncertain", conflicts_with: null },
  ];
  const { state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
    readLivingSpecs: () => ["Covered thing is in living specs"],
  });
  await runBackfill({ apply: false }, cfg, deps);
  const output = state.logged.join("\n");

  assert.ok(output.includes("Already Covered"), "missing 'Already Covered' group");
  assert.ok(output.includes("Missing Coverage"), "missing 'Missing Coverage' group");
  assert.ok(output.includes("Conflicting Evidence"), "missing 'Conflicting Evidence' group");
  assert.ok(output.includes("Uncertain Evidence"), "missing 'Uncertain Evidence' group");
});

test("runBackfill: preview — partial adoption still surfaces missing behaviors", async () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "Covered thing already in specs", provenance: "test.ts", evidence_grade: "sufficient", conflicts_with: null },
    { behavior: "Legacy behavior not yet covered", provenance: "test2.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const { state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
    readLivingSpecs: () => ["Covered thing already in specs"],
  });
  await runBackfill({ apply: false }, cfg, deps);
  const output = state.logged.join("\n");

  assert.ok(output.includes("Legacy behavior not yet covered"), "missing behavior should appear in output");
  assert.ok(!output.includes("Backfill is complete"), "should NOT report as complete when there is missing coverage");
});

// ---------------------------------------------------------------------------
// runBackfill — apply path (mutating)
// ---------------------------------------------------------------------------

test("runBackfill: apply — creates branch, commits, pushes, opens PR", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: true }, cfg, deps);

  assert.equal(state.gitBranches.length, 1, "one branch should be created");
  assert.ok(state.gitBranches[0]!.startsWith("backfill/"), "branch should start with backfill/");
  assert.ok(state.prOpened !== null, "PR should be opened");
});

test("runBackfill: apply — authored files are under openspec/ only", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: true }, cfg, deps);

  for (const filePath of Object.keys(state.writtenFiles)) {
    assert.ok(
      filePath.includes("openspec/"),
      `file ${filePath} is NOT under openspec/`,
    );
  }
});

test("runBackfill: apply — PR output mentions PR URL", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: true }, cfg, deps);

  const output = state.logged.join("\n");
  assert.ok(output.includes("https://github.com/owner/repo/pull/999"), "PR URL should appear in output");
});

test("runBackfill: apply — validation failure blocks PR and reports blocker", async () => {
  const { state, ...deps } = makeDeps({
    validate: async () => ({
      valid: false,
      issues: [{ message: "Missing SHALL keyword in requirement" }],
      raw: "validation failed",
    }),
  });

  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /openspec validate failed/,
  );
  assert.equal(state.prOpened, null, "no PR should be opened on validation failure");
  // Branch is created before validation runs (Finding 3 fix) — spec only prohibits PR creation on failure.
});

test("runBackfill: apply — validation failure message names the validation error", async () => {
  const { _state, ...deps } = makeDeps({
    validate: async () => ({
      valid: false,
      issues: [{ message: "Missing SHALL keyword in requirement" }],
      raw: "validation failed",
    }),
  });

  let errorMsg = "";
  try {
    await runBackfill({ apply: true }, cfg, deps);
  } catch (err) {
    errorMsg = (err as Error).message;
  }
  assert.ok(errorMsg.includes("Missing SHALL keyword"), `error should name validation issue, got: ${errorMsg}`);
});

test("runBackfill: apply — empty slice (all covered) exits non-zero", async () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "Covered thing", provenance: "test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const { _state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
    readLivingSpecs: () => ["Covered thing in living specs already"],
  });

  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /no missing-coverage candidates/,
  );
});

// ---------------------------------------------------------------------------
// runBackfill — idempotency
// ---------------------------------------------------------------------------

test("runBackfill: idempotent re-run — already-covered behaviors are not re-proposed", async () => {
  const behavior = "The CLI exits 0 on success";
  const candidates: BackfillCandidate[] = [
    { behavior, provenance: "test/exit.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const { state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
    readLivingSpecs: () => [behavior],
  });
  await runBackfill({ apply: false }, cfg, deps);
  const output = state.logged.join("\n");

  assert.ok(output.includes("Already Covered"), "behavior should appear as already-covered");
  // Specifically: the behavior should NOT be in missing-coverage section
  const lines = output.split("\n");
  let inMissing = false;
  for (const line of lines) {
    if (line.includes("Missing Coverage")) { inMissing = true; continue; }
    if (line.startsWith("###") && !line.includes("Missing Coverage")) { inMissing = false; }
    if (inMissing) {
      assert.ok(!line.includes(behavior), `behavior should not appear in Missing Coverage section: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Single model boundary
// ---------------------------------------------------------------------------

test("runBackfill: single model boundary — exactly one harness call in preview", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: false }, cfg, deps);
  assert.equal(state.harnessCallCount, 1, "exactly one harness call in preview mode");
});

test("runBackfill: single model boundary — exactly one harness call in apply", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: true }, cfg, deps);
  assert.equal(state.harnessCallCount, 1, "exactly one harness call in apply mode");
});

// ---------------------------------------------------------------------------
// CLI dispatch wiring tests
// ---------------------------------------------------------------------------

test("pipeline-cli: backfill — registered in COMMAND_REGISTRY", () => {
  assert.ok("backfill" in COMMAND_REGISTRY, "backfill should be in COMMAND_REGISTRY");
});

test("pipeline-cli: backfill — no issue number needed", () => {
  const entry = lookupCommand("backfill");
  assert.ok(entry !== null, "backfill should resolve in registry");
  assert.equal(entry!.needsIssueNumber, false);
});

test("pipeline-cli: backfill — no flags → validateFlags returns []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "backfill"]);
  const entry = lookupCommand("backfill");
  assert.ok(entry !== null);
  assert.deepEqual(validateFlags(entry!, cmd), []);
});

test("pipeline-cli: backfill --apply → validateFlags returns []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "backfill", "--apply"]);
  const entry = lookupCommand("backfill");
  assert.ok(entry !== null);
  assert.deepEqual(validateFlags(entry!, cmd), []);
});

test("pipeline-cli: backfill --capability foo → validateFlags returns []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "backfill", "--capability", "foo"]);
  const entry = lookupCommand("backfill");
  assert.ok(entry !== null);
  assert.deepEqual(validateFlags(entry!, cmd), []);
});

test("pipeline-cli: backfill --repo is not a supported backfill flag → validateFlags returns non-empty", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "backfill", "--repo", "owner/repo"]);
  const entry = lookupCommand("backfill");
  assert.ok(entry !== null);
  const offending = validateFlags(entry!, cmd);
  assert.ok(offending.includes("repo"), `expected repo to be disallowed for backfill, got: ${JSON.stringify(offending)}`);
});

test("pipeline-cli: backfill with unsupported flag → validateFlags returns non-empty", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "backfill", "--dry-run"]);
  const entry = lookupCommand("backfill");
  assert.ok(entry !== null);
  const offending = validateFlags(entry!, cmd);
  assert.ok(offending.includes("dryRun"), `expected dryRun to be disallowed, got: ${JSON.stringify(offending)}`);
});

test("pipeline-cli: backfill listed in argument help text", () => {
  const cmd = buildCmd();
  const argDef = cmd.registeredArguments[0];
  assert.ok(argDef !== undefined, "first argument should be defined");
  assert.ok(
    argDef.description.includes("backfill"),
    `argument description should include 'backfill', got: ${argDef.description}`,
  );
});

test("pipeline-cli: buildCmd includes --capability option", () => {
  const cmd = buildCmd();
  const capOpt = cmd.options.find((o) => o.long === "--capability");
  assert.ok(capOpt !== undefined, "--capability option should be defined in buildCmd");
});

// ---------------------------------------------------------------------------
// Finding 2: staged-files guard (pre-staged non-openspec files abort before commit)
// ---------------------------------------------------------------------------

test("runBackfill: apply — aborts before commit when non-openspec files are pre-staged", async () => {
  const { state, ...deps } = makeDeps({
    gitGetStagedFiles: (_dir) => ["src/main.ts", "README.md"],
  });

  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /spec-only guard.*non-openspec/,
  );
  assert.equal(state.prOpened, null, "no PR should be opened when staged non-spec files detected");
});

test("runBackfill: apply — proceeds normally when only openspec files are pre-staged", async () => {
  const { state, ...deps } = makeDeps({
    gitGetStagedFiles: (_dir) => ["openspec/specs/foo/spec.md"],
  });

  await runBackfill({ apply: true }, cfg, deps);
  assert.ok(state.prOpened !== null, "PR should be opened when pre-staged files are all under openspec/");
});

// ---------------------------------------------------------------------------
// Finding 3: open backfill PR de-duplication
// ---------------------------------------------------------------------------

test("classifyCoverage: capability-scoped already-proposed behavior is flagged", () => {
  const candidates: BackfillCandidate[] = [
    { behavior: "The CLI accepts a capability flag", provenance: "test/cli.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  // Simulate a behavior from a capability-scoped spec (not backfill/spec.md)
  const result = classifyCoverage(candidates, [], ["The CLI accepts a capability flag"]);
  assert.equal(result[0]!.group, "missing-coverage");
  assert.equal(result[0]!.already_proposed, true);
});

test("runBackfill: apply — remote open PR behaviors are de-duplicated", async () => {
  const behavior = "The CLI exits 0 on success";
  const candidates: BackfillCandidate[] = [
    { behavior, provenance: "test/exit.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const { state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
    listOpenBackfillPRBehaviors: (_dir) => [behavior],
  });

  // The only candidate is already proposed in a remote PR → slice is empty → throws
  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /no missing-coverage candidates/,
  );
  assert.equal(state.prOpened, null, "no duplicate PR should be opened");
});

// ---------------------------------------------------------------------------
// Finding 1 regression: preview must call listOpenBackfillPRBehaviors for accurate de-duplication
// ---------------------------------------------------------------------------

test("runBackfill: preview — listOpenBackfillPRBehaviors IS called for remote de-duplication", async () => {
  const { state, ...deps } = makeDeps();
  await runBackfill({ apply: false }, cfg, deps);
  assert.equal(state.listBehaviorsCalled, true, "preview should call listOpenBackfillPRBehaviors for accurate de-duplication");
});

test("runBackfill: preview — behavior already proposed in remote PR appears as already-proposed", async () => {
  const behavior = "The CLI exits 0 on success";
  const candidates: BackfillCandidate[] = [
    { behavior, provenance: "test/exit.test.ts", evidence_grade: "sufficient", conflicts_with: null },
  ];
  const { state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
    listOpenBackfillPRBehaviors: (_dir) => {
      state.listBehaviorsCalled = true;
      return [behavior];
    },
  });
  await runBackfill({ apply: false }, cfg, deps);
  const output = state.logged.join("\n");
  assert.ok(
    output.includes("Already proposed in an open backfill PR"),
    `expected 'already proposed' annotation in preview output, got:\n${output}`,
  );
});

// ---------------------------------------------------------------------------
// Finding 2 regression: pre-existing dirty openspec/ state aborts before authoring
// ---------------------------------------------------------------------------

test("runBackfill: apply — aborts before writing when pre-existing openspec/ dirt is detected", async () => {
  const { state, ...deps } = makeDeps({
    gitOpenspecDirtyFiles: (_dir) => ["openspec/changes/old-backfill/specs/foo/spec.md"],
  });

  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /pre-existing dirty openspec\/ state detected/,
  );
  assert.deepEqual(state.writtenFiles, {}, "no files should be written when dirty openspec/ state is detected");
  assert.equal(state.prOpened, null, "no PR should be opened when dirty openspec/ state is detected");
});

test("runBackfill: apply — proceeds normally when openspec/ is clean", async () => {
  const { state, ...deps } = makeDeps({
    gitOpenspecDirtyFiles: (_dir) => [],
  });

  await runBackfill({ apply: true }, cfg, deps);
  assert.ok(state.prOpened !== null, "PR should be opened when openspec/ is clean");
});

// ---------------------------------------------------------------------------
// Finding 2 regression: unavailable openspec CLI blocks apply with actionable error
// ---------------------------------------------------------------------------

test("runBackfill: apply — unavailable openspec CLI blocks PR with actionable error", async () => {
  const { state, ...deps } = makeDeps({
    validate: async () => ({ valid: true, unavailable: true, issues: [], raw: "" }),
  });

  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /openspec.*not installed|openspec.*not on PATH/i,
  );
  assert.equal(state.prOpened, null, "no PR should be opened when openspec is unavailable");
});

// ---------------------------------------------------------------------------
// Finding 4: unknown evidence grade → uncertain-evidence
// ---------------------------------------------------------------------------

test("runBackfill: unknown evidence grade from model is demoted to uncertain-evidence", async () => {
  const candidates = [
    { behavior: "Some behavior", provenance: "test.ts", evidence_grade: "weak", conflicts_with: null },
  ];
  const { state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
  });

  await runBackfill({ apply: false }, cfg, deps);
  const output = state.logged.join("\n");
  assert.ok(output.includes("Uncertain Evidence"), "unknown grade should appear in Uncertain Evidence group");
  assert.ok(!output.includes("Missing Coverage\n\n- **Some behavior**"), "unknown grade should NOT appear in Missing Coverage group");
});

test("runBackfill: apply — unknown evidence grade does not enter missing-coverage slice", async () => {
  const candidates = [
    { behavior: "Some weak behavior", provenance: "test.ts", evidence_grade: "insufficient", conflicts_with: null },
  ];
  const { _state, ...deps } = makeDeps({
    runHarness: async () => ({ success: true, output: JSON.stringify(candidates) }),
  });

  // With only an unknown-grade candidate, no missing-coverage slice exists → exits non-zero
  await assert.rejects(
    () => runBackfill({ apply: true }, cfg, deps),
    /no missing-coverage candidates/,
  );
});
