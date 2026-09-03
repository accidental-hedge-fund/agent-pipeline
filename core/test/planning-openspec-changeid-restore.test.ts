// OpenSpec change-id restore on plan-review resume (#1416).
// Injected listing / validation only — no live network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeOpenspecPlanningHooks,
  runPlanningPhases,
} from "../scripts/stages/planning.ts";
import type { ValidateResult } from "../scripts/openspec.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const eqCfg = {
  harnesses: { implementer: "claude", reviewer: "codex" },
  base_branch: "main",
  repo: "owner/repo",
  repo_dir: "/repo",
  steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
  implementation_timeout: 300,
  review_timeout: 300,
  plan_review_timeout: 300,
  models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet", intake: "sonnet", sweep: "sonnet" },
  effort: {},
  plan_review_effort: "medium",
  harness_sandbox: false,
  marker_footer: "---pipeline---",
  implementation_ready_message: "Implementation ready.",
  last30days: { enabled: false, timeout: 600 },
  openspec: { enabled: "auto", bootstrap: false },
  worktree_root: ".worktrees",
} as unknown as PipelineConfig;

const revisionOkResult: HarnessResult = {
  success: true,
  stdout:
    "## Revised Plan\n\nDo the thing.\n\n## Feedback Incorporated\n\n- [ADDRESSED] reviewer concern\n\n## Human Feedback Acknowledgement\n\nAcknowledged.",
  stderr: "",
  exit_code: 0,
  duration: 1,
  timed_out: false,
};

const planReviewNeedsRevision: HarnessResult = {
  success: true,
  stdout: "## Plan Review Verdict\n\nNEEDS_REVISION. Expand the OpenSpec tasks.",
  stderr: "",
  exit_code: 0,
  duration: 1,
  timed_out: false,
};

const validItem = (): ValidateResult => ({
  valid: true,
  unavailable: false,
  issues: [],
  raw: "",
});

const wt = { path: "/fake/wt", branch: "pipeline/42-restore" };

const PLAN_COMMENT =
  "## Implementation Plan\n\n_OpenSpec change `fresh-change` — proposal.md_\n\nDo the thing.";

function eqBaseDeps() {
  return {
    createWorktree: async () => wt,
    detectAndInstall: async () => ({ skipped: true }),
    removeWorktree: async () => {},
    invoke: async () => revisionOkResult,
    setBlocked: async () => {},
    transition: async () => {},
    postComment: async () => {},
    addLabel: async () => {},
    getIssueDetail: async () => ({
      title: "Test",
      body: "test body",
      comments: [{ author: "bot", body: PLAN_COMMENT, createdAt: "2026-09-03T00:00:00Z" }],
      number: 42,
      labels: [],
      state: "open",
    }),
    invokeReviewer: async () => ({
      result: planReviewNeedsRevision,
      effectiveReviewer: "codex",
      selfReview: false,
    }),
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    hasCommitsAhead: async () => true,
    runTestGate: async () => ({ skipped: true }),
    runFormatGate: async () => ({ status: "ok" as const, committed: false }),
    getPrForBranch: async () => null,
    createPr: async () => 99,
    disposeSupersededIssuePrs: async () => ({ closed: [], commented: [], errors: [], isCanonical: true }),
  };
}

function recordingValidate(calls: string[]) {
  return async (_dir: string, name: string): Promise<ValidateResult> => {
    calls.push(name);
    return validItem();
  };
}

function assertNoEmptyValidate(calls: string[], label: string): void {
  assert.ok(
    !calls.some((name) => name.trim() === ""),
    `${label}: validateItem must not receive an empty name; got ${JSON.stringify(calls)}`,
  );
}

function assertRestoreFailed(
  result: { ok: true } | { ok: false; reason: string; tag: string },
  validateCalls: string[],
  label: string,
): void {
  assert.equal(result.ok, false, `${label}: must block`);
  assert.ok(!result.ok && result.tag === "openspec-invalid", `${label}: tag must stay openspec-invalid`);
  assert.ok(!result.ok && /change-id restore failed/i.test(result.reason), `${label}: reason must name change-id restore failure: ${!result.ok ? result.reason : ""}`);
  assert.ok(!result.ok && !/Nothing to validate/i.test(result.reason), `${label}: reason must not include CLI text "Nothing to validate"`);
  assert.deepEqual(validateCalls, [], `${label}: validateItem must not run`);
}

test("makeOpenspecPlanningHooks: skipped authoring restores the unique fresh change before validateItem (#1416 2.1-2.3)", async () => {
  const listed: string[] = [];
  const validateCalls: string[] = [];
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", ["baseline-change"], {
    listChangeDirs: (dir) => {
      listed.push(dir);
      return ["baseline-change", "fresh-change"];
    },
    validateItem: recordingValidate(validateCalls),
  });

  const validated = await hooks.validateArtifact(wt);
  const revalidated = await hooks.revalidateArtifact(wt, "revised proposal");

  assert.equal(validated.ok, true, "validateArtifact must succeed after restore");
  assert.equal(revalidated.ok, true, "revalidateArtifact must succeed after restore");
  assert.deepEqual(listed, [wt.path], "restore lists the worktree once while changeId is empty");
  assert.deepEqual(
    validateCalls,
    ["fresh-change", "fresh-change"],
    "restore must pass the unique fresh id, not the empty closed-over changeId",
  );
  assertNoEmptyValidate(validateCalls, "fresh-change restore");
});

test("makeOpenspecPlanningHooks: exactly one active change is restored when it is already in the baseline (#1416 2.4)", async () => {
  const validateCalls: string[] = [];
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", ["only-change"], {
    listChangeDirs: () => ["only-change"],
    validateItem: recordingValidate(validateCalls),
  });

  const result = await hooks.revalidateArtifact(wt, "revised proposal");
  assert.equal(result.ok, true);
  assert.deepEqual(validateCalls, ["only-change"]);
  assertNoEmptyValidate(validateCalls, "exactly-one fallback");
});

test("makeOpenspecPlanningHooks: zero active changes blocks with a named restore reason (#1416 2.4)", async () => {
  const validateCalls: string[] = [];
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", [], {
    listChangeDirs: () => [],
    validateItem: recordingValidate(validateCalls),
  });

  const result = await hooks.revalidateArtifact(wt, "revised proposal");
  assertRestoreFailed(result, validateCalls, "zero active changes");
  assert.ok(!result.ok && /no openspec change created/i.test(result.reason), `must include singularity diagnostic: ${!result.ok ? result.reason : ""}`);
});

test("makeOpenspecPlanningHooks: multiple fresh changes block without picking one (#1416 2.4)", async () => {
  const validateCalls: string[] = [];
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", [], {
    listChangeDirs: () => ["change-a", "change-b"],
    validateItem: recordingValidate(validateCalls),
  });

  const result = await hooks.revalidateArtifact(wt, "revised proposal");
  assertRestoreFailed(result, validateCalls, "multiple fresh changes");
  assert.ok(!result.ok && /expected exactly one/i.test(result.reason), `must include singularity diagnostic: ${!result.ok ? result.reason : ""}`);
});

test("runPlanningPhases: plan-review resume validates the restored change after NEEDS_REVISION and skips authoring (#1416 3.1-3.2)", async () => {
  const validateCalls: string[] = [];
  let authorCalls = 0;
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test issue", "test body", [], {
    listChangeDirs: () => ["fresh-change"],
    validateItem: recordingValidate(validateCalls),
  });
  const originalAuthor = hooks.authorArtifact;
  hooks.authorArtifact = async (...args: Parameters<typeof originalAuthor>) => {
    authorCalls += 1;
    return originalAuthor(...args);
  };

  await runPlanningPhases(
    eqCfg,
    42,
    "Test issue",
    "test body",
    "run-42",
    { resumePlanReview: true },
    hooks,
    eqBaseDeps() as never,
  );

  assert.equal(authorCalls, 0, "plan-review resume must not re-invoke authorArtifact");
  assert.ok(
    validateCalls.includes("fresh-change"),
    `resume+revision must validate the restored id; got ${JSON.stringify(validateCalls)}`,
  );
  assertNoEmptyValidate(validateCalls, "resume+revision");
});
