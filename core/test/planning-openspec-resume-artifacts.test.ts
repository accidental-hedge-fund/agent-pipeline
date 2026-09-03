// OpenSpec plan-review resume binds worktree proposal.md + spec deltas (#1418).
// Injected comment listing plus file reads — no live network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeFreeformPlanningHooks,
  makeOpenspecPlanningHooks,
  runPlanningPhases,
} from "../scripts/stages/planning.ts";
import * as openspec from "../scripts/openspec.ts";
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

const planReviewOk: HarnessResult = {
  success: true,
  stdout: "## Plan Review Verdict\n\nApproved. No blocking findings.",
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

const wt = { path: "/fake/wt", branch: "pipeline/42-resume-artifacts" };

const STALE_COMMENT_PIN = "STALE_COMMENT_ONLY_WORDING_without_pins";
const WORKTREE_PROPOSAL_PIN =
  "EEXIST-only retry and sole onRunReady append plus merge-proof payload";
const SPEC_DELTA_PIN = "coverage transitions SHALL stay in the spec delta";

const STALE_PLAN_COMMENT =
  `## Implementation Plan\n\n_OpenSpec change \`fresh-change\` — proposal.md_\n\n${STALE_COMMENT_PIN}`;

const LIVING_PROPOSAL =
  `Living OpenSpec proposal with prior NEEDS_REVISION pins: ${WORKTREE_PROPOSAL_PIN}.`;

const LIVING_DELTAS = `#### spec.md\n\n${SPEC_DELTA_PIN}`;

const FREEFORM_PLAN_BODY = "Freeform resume plan: ship the comment text.";

function eqBaseDeps(over: Record<string, unknown> = {}) {
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
      comments: [{ author: "bot", body: STALE_PLAN_COMMENT, createdAt: "2026-09-03T00:00:00Z" }],
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
    ...over,
  };
}

function recordingValidate(calls: string[]) {
  return async (_dir: string, name: string): Promise<ValidateResult> => {
    calls.push(name);
    return validItem();
  };
}

function planSectionOf(prompt: string): string {
  const marker = "Proposed implementation plan:";
  const i = prompt.indexOf(marker);
  assert.ok(i >= 0, `prompt must contain "${marker}"`);
  return prompt.slice(i + marker.length);
}

function originalPlanSectionOf(prompt: string): string {
  const marker = "Original implementation plan:";
  const i = prompt.indexOf(marker);
  assert.ok(i >= 0, `revision prompt must contain "${marker}"`);
  return prompt.slice(i + marker.length);
}

function assertWorktreePlanNotCommentOnly(prompt: string, label: string): void {
  const section = prompt.includes("Proposed implementation plan:")
    ? planSectionOf(prompt)
    : originalPlanSectionOf(prompt);
  assert.ok(
    section.includes(WORKTREE_PROPOSAL_PIN),
    `${label}: plan text must include worktree proposal pins`,
  );
  assert.ok(
    section.includes(SPEC_DELTA_PIN),
    `${label}: prompt must include worktree spec deltas`,
  );
  assert.ok(
    section.includes(WORKTREE_PROPOSAL_PIN) || !section.includes(STALE_COMMENT_PIN),
    `${label}: GitHub comment must not be the sole plan text`,
  );
  assert.ok(
    !(section.includes(STALE_COMMENT_PIN) && !section.includes(WORKTREE_PROPOSAL_PIN)),
    `${label}: regression — resume ignored worktree proposal.md`,
  );
}

function livingFileInjects(over: {
  dirs?: () => string[];
  proposal?: string | null;
  deltas?: string;
  throwDeltas?: Error;
  readIds?: string[];
} = {}) {
  const readIds = over.readIds ?? [];
  return {
    listChangeDirs: over.dirs ?? (() => ["fresh-change"]),
    validateItem: recordingValidate([]),
    readChangeFile: ((_dir: string, name: string, file: string) => {
      readIds.push(name);
      if (file !== "proposal.md") return null;
      if (over.proposal === undefined) return LIVING_PROPOSAL;
      return over.proposal;
    }) as typeof openspec.readChangeFile,
    readSpecDeltas: ((_dir: string, name: string) => {
      if (over.throwDeltas) throw over.throwDeltas;
      readIds.push(`deltas:${name}`);
      return over.deltas === undefined ? LIVING_DELTAS : over.deltas;
    }) as typeof openspec.readSpecDeltas,
    readIds,
  };
}

// ---------------------------------------------------------------------------
// 1.1 / 1.2 — inject bag + optional hook
// ---------------------------------------------------------------------------

test("OpenspecPlanningHookInjects: tests can replace readChangeFile and readSpecDeltas (#1418 1.1)", async () => {
  let fileReads = 0;
  let deltaReads = 0;
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", [], {
    listChangeDirs: () => ["fresh-change"],
    readChangeFile: (_dir, name, file) => {
      fileReads += 1;
      assert.equal(name, "fresh-change");
      assert.equal(file, "proposal.md");
      return LIVING_PROPOSAL;
    },
    readSpecDeltas: (_dir, name) => {
      deltaReads += 1;
      assert.equal(name, "fresh-change");
      return LIVING_DELTAS;
    },
  });
  assert.equal(typeof hooks.bindResumePlanArtifacts, "function");
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, true);
  assert.equal(fileReads, 1, "bind must use the injected readChangeFile");
  assert.equal(deltaReads, 1, "bind must use the injected readSpecDeltas");
  assert.ok(bound.ok && bound.promptPlanText === LIVING_PROPOSAL);
  assert.ok(bound.ok && bound.specContext === LIVING_DELTAS);
});

test("makeFreeformPlanningHooks: bindResumePlanArtifacts is absent (#1418 1.2)", () => {
  const hooks = makeFreeformPlanningHooks(eqCfg, "Test", "body");
  assert.equal(
    hooks.bindResumePlanArtifacts,
    undefined,
    "freeform callers must compile without implementing bindResumePlanArtifacts",
  );
});

test("makeOpenspecPlanningHooks: omitted file-read injects use module readers (#1418 1.1 production default)", async () => {
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", [], {
    listChangeDirs: () => ["fresh-change"],
  });
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, false, "fake worktree has no proposal.md on disk");
  assert.ok(!bound.ok && bound.tag === "openspec-invalid");
  assert.ok(!bound.ok && /fresh-change/.test(bound.reason));
  assert.ok(!bound.ok && /proposal\.md/.test(bound.reason));
});

// ---------------------------------------------------------------------------
// 2.x — hook-level bind
// ---------------------------------------------------------------------------

test("makeOpenspecPlanningHooks: bindResumePlanArtifacts returns worktree proposal, not a stale comment (#1418 2.1-2.2)", async () => {
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    ["baseline-change"],
    livingFileInjects({ dirs: () => ["baseline-change", "fresh-change"] }),
  );
  assert.equal(typeof hooks.authorArtifact, "function");
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, true);
  assert.ok(bound.ok && bound.promptPlanText.includes(WORKTREE_PROPOSAL_PIN));
  assert.ok(bound.ok && bound.specContext.includes(SPEC_DELTA_PIN));
  assert.ok(bound.ok && !bound.promptPlanText.includes(STALE_COMMENT_PIN));
});

test("makeOpenspecPlanningHooks: empty spec deltas still bind as empty string (#1418 2.2)", async () => {
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    [],
    livingFileInjects({ deltas: "" }),
  );
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, true);
  assert.ok(bound.ok && bound.promptPlanText === LIVING_PROPOSAL);
  assert.ok(bound.ok && bound.specContext === "");
});

test("makeOpenspecPlanningHooks: thrown spec-delta reader is the same bind failure (#1418 2.2)", async () => {
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    [],
    livingFileInjects({ throwDeltas: new Error("delta boom") }),
  );
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, false);
  assert.ok(!bound.ok && bound.tag === "openspec-invalid");
  assert.ok(!bound.ok && /fresh-change/.test(bound.reason));
  assert.ok(!bound.ok && /delta boom/.test(bound.reason));
  assert.ok(!bound.ok && !("promptPlanText" in bound));
});

test("makeOpenspecPlanningHooks: exactly one active change in the baseline is bound (#1418 2.3)", async () => {
  const readIds: string[] = [];
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    ["only-change"],
    livingFileInjects({
      dirs: () => ["only-change"],
      proposal: "proposal for only-change",
      readIds,
    }),
  );
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, true);
  assert.ok(bound.ok && bound.promptPlanText === "proposal for only-change");
  assert.ok(readIds.includes("only-change"));
});

test("makeOpenspecPlanningHooks: zero active changes blocks with named restore reason (#1418 2.3)", async () => {
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    [],
    livingFileInjects({ dirs: () => [] }),
  );
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, false);
  assert.ok(!bound.ok && bound.tag === "openspec-invalid");
  assert.ok(!bound.ok && /change-id restore failed/i.test(bound.reason));
  assert.ok(!bound.ok && /no openspec change created/i.test(bound.reason));
  assert.ok(!bound.ok && !("promptPlanText" in bound));
});

test("makeOpenspecPlanningHooks: multiple fresh changes block without picking one (#1418 2.3)", async () => {
  const readIds: string[] = [];
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    [],
    livingFileInjects({ dirs: () => ["change-a", "change-b"], readIds }),
  );
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, false);
  assert.ok(!bound.ok && bound.tag === "openspec-invalid");
  assert.ok(!bound.ok && /change-id restore failed/i.test(bound.reason));
  assert.ok(!bound.ok && /expected exactly one/i.test(bound.reason));
  assert.deepEqual(readIds, [], "bind must not scrape a comment or pick an arbitrary change");
});

test("makeOpenspecPlanningHooks: empty changeId restores then binds that id's proposal (#1418 2.4)", async () => {
  const readIds: string[] = [];
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test",
    "body",
    ["baseline-change"],
    livingFileInjects({
      dirs: () => ["baseline-change", "fresh-change"],
      readIds,
    }),
  );
  const bound = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(bound.ok, true);
  assert.ok(bound.ok && bound.promptPlanText === LIVING_PROPOSAL);
  assert.ok(readIds.includes("fresh-change"));
  assert.ok(!readIds.includes("baseline-change"));
});

test("makeOpenspecPlanningHooks: non-empty resolved id does not re-pick (#1418 2.5)", async () => {
  let dirs = ["fresh-change"];
  const readIds: string[] = [];
  const hooks = makeOpenspecPlanningHooks(eqCfg, "Test", "body", [], {
    listChangeDirs: () => dirs,
    readChangeFile: (_dir, name, file) => {
      if (file === "proposal.md") {
        readIds.push(name);
        return `proposal for ${name}`;
      }
      return null;
    },
    readSpecDeltas: () => "",
  });
  const first = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(first.ok, true);
  assert.ok(first.ok && first.promptPlanText === "proposal for fresh-change");

  dirs = ["other-change"];
  readIds.length = 0;
  const second = await hooks.bindResumePlanArtifacts!(wt);
  assert.equal(second.ok, true);
  assert.deepEqual(readIds, ["fresh-change"], "must keep the original resolved id");
  assert.ok(second.ok && second.promptPlanText === "proposal for fresh-change");
});

test("makeOpenspecPlanningHooks: unreadable proposal on a resolved id blocks without comment text (#1418 2.6)", async () => {
  for (const proposal of [null, "", "   \n"]) {
    const hooks = makeOpenspecPlanningHooks(
      eqCfg,
      "Test",
      "body",
      [],
      livingFileInjects({ proposal }),
    );
    const bound = await hooks.bindResumePlanArtifacts!(wt);
    assert.equal(bound.ok, false, `proposal=${JSON.stringify(proposal)} must fail`);
    assert.ok(!bound.ok && bound.tag === "openspec-invalid");
    assert.ok(!bound.ok && /fresh-change/.test(bound.reason));
    assert.ok(!bound.ok && /proposal\.md/.test(bound.reason));
    assert.ok(!bound.ok && !("promptPlanText" in bound));
    assert.ok(!bound.ok && !bound.reason.includes(STALE_COMMENT_PIN));
  }
});

// ---------------------------------------------------------------------------
// 3.x — shared runner resume path
// ---------------------------------------------------------------------------

test("runPlanningPhases: OpenSpec plan-review resume reviews worktree proposal and deltas, not the stale comment (#1418 3.1-3.4)", async () => {
  let authorCalls = 0;
  const reviewPrompts: string[] = [];
  const revisionPrompts: string[] = [];
  const reviewCwds: string[] = [];
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test issue",
    "test body",
    [],
    livingFileInjects(),
  );
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
    eqBaseDeps({
      invokeReviewer: async (
        _reviewer: string,
        _primary: string,
        cwd: string,
        prompt: string,
      ) => {
        reviewCwds.push(cwd);
        reviewPrompts.push(prompt);
        return {
          result: planReviewNeedsRevision,
          effectiveReviewer: "codex",
          selfReview: false,
        };
      },
      invoke: async (_h: string, _dir: string, prompt: string) => {
        revisionPrompts.push(prompt);
        return revisionOkResult;
      },
    }) as never,
  );

  assert.equal(authorCalls, 0, "plan-review resume must not re-invoke authorArtifact");
  assert.ok(reviewPrompts.length >= 1, "invokeReviewer must run");
  assertWorktreePlanNotCommentOnly(reviewPrompts[0]!, "plan-review");
  assert.ok(revisionPrompts.length >= 1, "invokeRevision must run after NEEDS_REVISION");
  assertWorktreePlanNotCommentOnly(revisionPrompts[0]!, "plan-revision");
  assert.equal(reviewCwds[0], wt.path, "planReviewCwd must stay the worktree");
  assert.notEqual(reviewCwds[0], eqCfg.repo_dir);
});

test("runPlanningPhases: freeform plan-review resume still uses the GitHub comment (#1418 3.5)", async () => {
  const reviewPrompts: string[] = [];
  const freeformComment = `## Implementation Plan\n\n${FREEFORM_PLAN_BODY}`;
  const hooks = makeFreeformPlanningHooks(eqCfg, "Test issue", "test body");
  assert.equal(hooks.bindResumePlanArtifacts, undefined);

  await runPlanningPhases(
    eqCfg,
    42,
    "Test issue",
    "test body",
    "run-42",
    { resumePlanReview: true },
    hooks,
    eqBaseDeps({
      getIssueDetail: async () => ({
        title: "Test",
        body: "test body",
        comments: [{ author: "bot", body: freeformComment, createdAt: "2026-09-03T00:00:00Z" }],
        number: 42,
        labels: [],
        state: "open",
      }),
      invokeReviewer: async (
        _reviewer: string,
        _primary: string,
        _cwd: string,
        prompt: string,
      ) => {
        reviewPrompts.push(prompt);
        return { result: planReviewOk, effectiveReviewer: "codex", selfReview: false };
      },
    }) as never,
  );

  assert.ok(reviewPrompts.length >= 1, "freeform resume must still invoke the reviewer");
  const section = planSectionOf(reviewPrompts[0]!);
  assert.ok(section.includes(FREEFORM_PLAN_BODY), "freeform resume uses the GitHub comment as plan text");
});

test("runPlanningPhases: OpenSpec resume with zero or multiple restore candidates blocks before review (#1418 3.6)", async () => {
  for (const dirs of [[] as string[], ["change-a", "change-b"]]) {
    let reviewCalls = 0;
    let revisionCalls = 0;
    let blocked: { tag: string; reason: string; stage: string } | undefined;
    const hooks = makeOpenspecPlanningHooks(
      eqCfg,
      "Test issue",
      "test body",
      [],
      livingFileInjects({ dirs: () => dirs }),
    );
    await runPlanningPhases(
      eqCfg,
      42,
      "Test issue",
      "test body",
      "run-42",
      { resumePlanReview: true },
      hooks,
      eqBaseDeps({
        setBlocked: async (_cfg: unknown, _n: unknown, reason: string, stage: string, tag: string) => {
          blocked = { tag, reason, stage };
        },
        invokeReviewer: async () => {
          reviewCalls += 1;
          return {
            result: planReviewNeedsRevision,
            effectiveReviewer: "codex",
            selfReview: false,
          };
        },
        invoke: async () => {
          revisionCalls += 1;
          return revisionOkResult;
        },
      }) as never,
    );
    const label = dirs.length === 0 ? "zero" : "multi-fresh";
    assert.equal(blocked?.tag, "openspec-invalid", `${label}: tag`);
    assert.equal(blocked?.stage, "plan-review", `${label}: stage`);
    assert.ok(
      blocked && /change-id restore failed/i.test(blocked.reason),
      `${label}: reason must name change-id restore failure: ${blocked?.reason}`,
    );
    assert.equal(reviewCalls, 0, `${label}: invokeReviewer must not run`);
    assert.equal(revisionCalls, 0, `${label}: invokeRevision must not run`);
  }
});

test("runPlanningPhases: missing proposal.md on a resolved id blocks without comment fallback (#1418 3.7)", async () => {
  let reviewCalls = 0;
  let revisionCalls = 0;
  const reviewPrompts: string[] = [];
  let blocked: { tag: string; reason: string; stage: string } | undefined;
  const hooks = makeOpenspecPlanningHooks(
    eqCfg,
    "Test issue",
    "test body",
    [],
    livingFileInjects({ proposal: null }),
  );
  await runPlanningPhases(
    eqCfg,
    42,
    "Test issue",
    "test body",
    "run-42",
    { resumePlanReview: true },
    hooks,
    eqBaseDeps({
      setBlocked: async (_cfg: unknown, _n: unknown, reason: string, stage: string, tag: string) => {
        blocked = { tag, reason, stage };
      },
      invokeReviewer: async (
        _reviewer: string,
        _primary: string,
        _cwd: string,
        prompt: string,
      ) => {
        reviewCalls += 1;
        reviewPrompts.push(prompt);
        return {
          result: planReviewNeedsRevision,
          effectiveReviewer: "codex",
          selfReview: false,
        };
      },
      invoke: async () => {
        revisionCalls += 1;
        return revisionOkResult;
      },
    }) as never,
  );
  assert.equal(blocked?.tag, "openspec-invalid");
  assert.equal(blocked?.stage, "plan-review");
  assert.ok(blocked && /fresh-change/.test(blocked.reason));
  assert.ok(blocked && /proposal\.md/.test(blocked.reason));
  assert.ok(blocked && !blocked.reason.includes(STALE_COMMENT_PIN));
  assert.equal(reviewCalls, 0, "invokeReviewer must not run");
  assert.equal(revisionCalls, 0, "invokeRevision must not run");
  assert.deepEqual(reviewPrompts, [], "GitHub comment must not become plan text");
});
