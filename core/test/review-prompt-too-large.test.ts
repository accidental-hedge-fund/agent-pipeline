// #1054: review-prompt-too-large preflight before harness spawn.
// Injected deps only — no real network, git, or subprocess for the wiring path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  advanceReview,
  invokePromptHarnessReview,
  type AdvanceReviewDeps,
} from "../scripts/stages/review.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { isAutoLoopRecoverable } from "../scripts/pipeline-run.ts";
import { withPreflightReadiness } from "./_preflight-readiness-shim.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-review-prompt-too-large-"));

function baseCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repo_dir: tmpRoot,
    repo: "acme/widget",
    domain: "widget",
    review_timeout: 60,
    openspec: { enabled: "off", bootstrap: false },
    models: {
      planning: "sonnet",
      implementing: "sonnet",
      review: "opus",
      fix: "sonnet",
      intake: "sonnet",
      sweep: "sonnet",
    },
    effort: {},
    harnesses: { implementer: "codex", reviewer: "claude" },
    // Opt into fail_open so missing tester evidence does not withhold the path
    // under test; oversize preflight runs after that gate.
    tester_evidence: {
      on_missing: "fail_open",
      max_output_chars: 4000,
      max_artifact_chars: 48_000,
      extractors: [],
    },
    review_policy: {
      block_threshold: "high",
      min_confidence: 0.5,
      max_adversarial_rounds: 0,
      ceiling_action: "block",
    },
    ...overrides,
  } as unknown as PipelineConfig;
}

function makeFakeClaude(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const cliPath = path.join(dir, "claude");
  // Exit 0 with a minimal approve verdict so under-ceiling path can succeed.
  fs.writeFileSync(
    cliPath,
    withPreflightReadiness(
      `printf '%s\\n' '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'`,
    ),
  );
  fs.chmodSync(cliPath, 0o755);
  return dir;
}

// ---------------------------------------------------------------------------
// invokePromptHarnessReview: oversize → zero spawn, promptTooLarge marker
// ---------------------------------------------------------------------------

test("invokePromptHarnessReview: oversize review-1 never spawns reviewer (#1054)", async () => {
  const binDir = makeFakeClaude();
  const spawnLog = path.join(binDir, "spawned");
  // Overwrite fake to record spawn attempts.
  fs.writeFileSync(
    path.join(binDir, "claude"),
    withPreflightReadiness(
      `echo spawned >> "${spawnLog}"; printf '%s\\n' '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'`,
    ),
  );
  fs.chmodSync(path.join(binDir, "claude"), 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const inv = await invokePromptHarnessReview(
      baseCfg(),
      42,
      "Title",
      "body",
      "plan",
      undefined,
      undefined,
      "diff text",
      1,
      tmpRoot,
      { reviewPromptCharCeiling: 50 },
    );
    assert.equal(inv.result.success, false);
    assert.ok(inv.promptTooLarge, "must set promptTooLarge marker");
    assert.ok(inv.promptTooLarge!.measured > 50);
    assert.equal(inv.promptTooLarge!.ceiling, 50);
    assert.ok(
      !fs.existsSync(spawnLog),
      "reviewer CLI must not have been spawned for oversize prompt",
    );
    assert.match(inv.result.stderr, /exceeds the reviewer input character ceiling/);
    assert.match(inv.result.stderr, /review-1/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: oversize review-2 never spawns reviewer (#1054)", async () => {
  const binDir = makeFakeClaude();
  const spawnLog = path.join(binDir, "spawned-r2");
  fs.writeFileSync(
    path.join(binDir, "claude"),
    withPreflightReadiness(
      `echo spawned >> "${spawnLog}"; printf '%s\\n' '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'`,
    ),
  );
  fs.chmodSync(path.join(binDir, "claude"), 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const inv = await invokePromptHarnessReview(
      baseCfg(),
      42,
      "Title",
      "body",
      "plan",
      "review1 summary",
      undefined,
      "diff text",
      2,
      tmpRoot,
      { reviewPromptCharCeiling: 50 },
    );
    assert.equal(inv.result.success, false);
    assert.ok(inv.promptTooLarge);
    assert.equal(inv.promptTooLarge!.ceiling, 50);
    assert.ok(!fs.existsSync(spawnLog), "must not spawn for oversize review-2");
    assert.match(inv.result.stderr, /review-2/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: under-ceiling still invokes reviewer once (#1054)", async () => {
  const binDir = makeFakeClaude();
  const spawnLog = path.join(binDir, "spawned-ok");
  fs.writeFileSync(
    path.join(binDir, "claude"),
    withPreflightReadiness(
      `echo spawned >> "${spawnLog}"; printf '%s\\n' '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'`,
    ),
  );
  fs.chmodSync(path.join(binDir, "claude"), 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    // Huge ceiling so the assembled prompt is always under.
    const inv = await invokePromptHarnessReview(
      baseCfg(),
      42,
      "Title",
      "body",
      "plan",
      undefined,
      undefined,
      "diff text",
      1,
      tmpRoot,
      { reviewPromptCharCeiling: 10_000_000 },
    );
    assert.equal(inv.promptTooLarge, undefined);
    assert.equal(inv.result.success, true);
    assert.ok(fs.existsSync(spawnLog), "reviewer must spawn under ceiling");
    const lines = fs.readFileSync(spawnLog, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "exactly one harness spawn");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// advanceReview: setBlocked kind + Outcome.blockerKind
// ---------------------------------------------------------------------------

const APPROVE_JSON =
  '{"verdict":"approve","summary":"LGTM","findings":[],"next_steps":[]}';

function makeAdvanceDeps(rec: {
  blocked: string[];
  blockedKinds: string[];
  runReviewCalls: number;
}): AdvanceReviewDeps {
  const sha = "a".repeat(40);
  return {
    getPrForIssue: async () => ({ number: 99, headRefName: "pipeline/42-x", url: "https://example/pr/99" } as any),
    getPrDiff: async () => "diff --git a/f b/f\n+line\n",
    getPrDetail: async () => ({ head_sha: sha, base_sha: "b".repeat(40) } as any),
    getIssueDetail: async () => ({
      title: "T",
      body: "B",
      labels: ["pipeline:review-1"],
      comments: [
        {
          author: { login: "bot" },
          body: "## Plan\n\nplan text\n\n<!-- pipeline-plan -->",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    } as any),
    getForIssue: async () => ({ path: tmpRoot, branch: "pipeline/42-x" } as any),
    gitInWorktree: async () => ({ stdout: `${sha}\n`, stderr: "", code: 0 }),
    postComment: async () => {},
    postPrComment: async () => {},
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason, _stage, kind) => {
      rec.blocked.push(reason);
      if (kind) rec.blockedKinds.push(kind);
    },
    runReview: async () => {
      rec.runReviewCalls += 1;
      // Simulate invokePromptHarnessReview oversize return without building MB prompts.
      return {
        result: {
          success: false,
          stdout: "",
          stderr: "Assembled review prompt for review-1 exceeds the reviewer input character ceiling (measured=200, ceiling=50).",
          exit_code: -1,
          duration: 0,
          timed_out: false,
        },
        effectiveReviewer: "claude",
        selfReview: false,
        promptTooLarge: { measured: 200, ceiling: 50 },
      };
    },
    getGhActor: async () => "pipeline-bot",
  };
}

test("advanceReview: promptTooLarge → setBlocked review-prompt-too-large, no re-spawn (#1054)", async () => {
  const rec = { blocked: [] as string[], blockedKinds: [] as string[], runReviewCalls: 0 };
  const deps = makeAdvanceDeps(rec);
  const out = await advanceReview(baseCfg(), 42, 1, {}, 0, deps);
  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.status, "blocked");
    assert.equal(out.blockerKind, "review-prompt-too-large");
    assert.match(out.reason ?? "", /measured=200/);
    assert.match(out.reason ?? "", /ceiling=50/);
  }
  assert.deepEqual(rec.blockedKinds, ["review-prompt-too-large"]);
  assert.equal(rec.runReviewCalls, 1, "runReview called once; no auto re-spawn in advanceReview");
  assert.ok(
    !rec.blocked.some((b) => b.includes("re-run as-is")),
    "blocked reason must not advise re-run as-is",
  );
});

test("advanceReview: promptTooLarge on review-2 uses same kind (#1054)", async () => {
  const rec = { blocked: [] as string[], blockedKinds: [] as string[], runReviewCalls: 0 };
  const deps = makeAdvanceDeps(rec);
  deps.runReview = async () => {
    rec.runReviewCalls += 1;
    return {
      result: {
        success: false,
        stdout: "",
        stderr: "over",
        exit_code: -1,
        duration: 0,
        timed_out: false,
      },
      effectiveReviewer: "claude",
      selfReview: false,
      promptTooLarge: { measured: 999, ceiling: 100 },
    };
  };
  deps.getIssueDetail = async () =>
    ({
      title: "T",
      body: "B",
      labels: ["pipeline:review-2"],
      comments: [
        {
          author: { login: "bot" },
          body: "## Plan\n\nplan\n\n<!-- pipeline-plan -->",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          author: { login: "bot" },
          body: "## Review 1 (claude) — approve\n\nsummary\n",
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    }) as any;

  const out = await advanceReview(baseCfg(), 42, 2, {}, 0, deps);
  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.blockerKind, "review-prompt-too-large");
    assert.match(out.reason ?? "", /review-2/);
    assert.match(out.reason ?? "", /measured=999/);
  }
  assert.deepEqual(rec.blockedKinds, ["review-prompt-too-large"]);
});

// Ensure unused approve fixture is referenced if we need under-path via advance later.
void APPROVE_JSON;

// ---------------------------------------------------------------------------
// Auto-loop recoverability
// ---------------------------------------------------------------------------

test("isAutoLoopRecoverable: review-prompt-too-large → false (#1054)", () => {
  assert.equal(
    isAutoLoopRecoverable({
      advanced: false,
      status: "blocked",
      reason: "prompt too large",
      blockerKind: "review-prompt-too-large",
    }),
    false,
  );
});

test("isAutoLoopRecoverable: previously recoverable kind remains recoverable (#1054)", () => {
  assert.equal(
    isAutoLoopRecoverable({
      advanced: false,
      status: "blocked",
      reason: "eval failed",
      blockerKind: "eval-gate-failed",
    }),
    true,
  );
  assert.equal(
    isAutoLoopRecoverable({
      advanced: false,
      status: "blocked",
      reason: "harness crash",
      blockerKind: "harness-failure",
    }),
    true,
  );
});
