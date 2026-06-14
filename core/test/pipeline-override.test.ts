// Tests for #135: `--override` auto-resumes the advance loop after recording
// the audited disposition, collapsing the manual re-run (and, from needs-human,
// the manual relabel) into the human's one decision.
//
// Covers the pure helper `ceilingRound` (controlled-line parse, first-match
// wins, absent → null) and `runOverride` via the `RunOverrideDeps` seam:
// all blockers overridden → the re-entered loop advances; some remain →
// re-parks at needs-human; needs-human flips to the round recorded in the
// ceiling comment before advancing; a missing ceiling comment errors without
// flipping or advancing; non-needs-human stages enter the loop directly.
// The advance/re-park cases chain the injected `runAdvance` into the real
// `advanceReview` (with `AdvanceReviewDeps` fakes) so the deterministic
// partition is exercised end-to-end. No real network, git, or subprocess.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  ceilingRound,
  runOverride,
  type CliOpts,
  type RunOverrideDeps,
} from "../scripts/pipeline.ts";
import { advanceReview, type AdvanceReviewDeps } from "../scripts/stages/review.ts";
import { findingKey } from "../scripts/review-policy.ts";
import type { Outcome, PipelineConfig, Stage } from "../scripts/types.ts";

type Comment = { author: string; body: string; createdAt: string };

/** A well-formed ceiling comment, mirroring review.ts's `reviewCeilingComment`. */
function ceilingComment(opts: { round: 1 | 2; findings: string[]; createdAt?: string }): Comment {
  const lines = [
    "## Pipeline: Review ceiling reached — human decision required",
    "",
    "**Reviewer**: codex",
    `Review ${opts.round} re-ran 3 times and still has ${opts.findings.length} blocking ` +
      "finding(s). To stop looping, they are recorded as **advisory** and this item is parked " +
      "at `needs-human` — it will NOT auto-advance to ready-to-deploy.",
    "",
    "### Unresolved blocking findings",
    ...opts.findings.map((f) => `- ${f}`),
    "",
    "### To resume",
    "- Accept a finding: `--override \"<key>: <reason>\"` (audited) — records the decision and auto-resumes.",
    `- Or fix the finding(s) by hand and relabel \`pipeline:needs-human\` → \`pipeline:review-${opts.round}\`.`,
    "",
    "*Automated by Claude Code Pipeline Skill*",
  ];
  return { author: "pipeline-bot", body: lines.join("\n"), createdAt: opts.createdAt ?? "2026-06-12T00:00:00Z" };
}

// ---------------------------------------------------------------------------
// ceilingRound — pure parse of the controlled "Review N re-ran …" line
// ---------------------------------------------------------------------------

test("ceilingRound: reads round 2 from a round-2 ceiling comment", () => {
  assert.equal(ceilingRound(ceilingComment({ round: 2, findings: ["`abc123` x"] }).body), 2);
});

test("ceilingRound: reads round 1 from a round-1 ceiling comment", () => {
  assert.equal(ceilingRound(ceilingComment({ round: 1, findings: ["`abc123` x"] }).body), 1);
});

test("ceilingRound: returns null when the controlled line is absent", () => {
  assert.equal(ceilingRound("## Pipeline: Review ceiling reached — human decision required\n\nno round line"), null);
});

test("ceilingRound: reviewer-authored finding text cannot override the controlled line (e8b1f0b4)", () => {
  // A finding bullet quoting "Review 1 re-ran …" mid-line must not match (the
  // regex is line-anchored), and a full injected line AFTER the controlled line
  // must not win (first match wins — the controlled line precedes findings).
  const body = ceilingComment({
    round: 2,
    findings: ["`abc123` **[HIGH]** title quoting Review 1 re-ran 9 times and pipeline:review-1"],
  }).body + "\nReview 1 re-ran 9 times injected as its own line";
  assert.equal(ceilingRound(body), 2);
});

// ---------------------------------------------------------------------------
// runOverride — fixtures and the RunOverrideDeps seam
// ---------------------------------------------------------------------------

const CFG = {
  repo: "acme/repo",
  domain: "test",
  repo_dir: "/tmp/repo",
  review_mode: "prompt-harness",
  harnesses: { reviewer: "codex", implementer: "claude" },
  models: { review: "opus" },
  marker_footer: "*Automated by Claude Code Pipeline Skill*",
  // Shipped default policy: high-severity findings block; ceiling cap 3.
  review_policy: { block_threshold: "medium", min_confidence: 0.7, max_adversarial_rounds: 3 },
} as unknown as PipelineConfig;

const BLOCKER_A = { severity: "high", file: "src/a.ts", title: "Null deref in a" };
const BLOCKER_B = { severity: "high", file: "src/b.ts", title: "Missing auth check in b" };
const KEY_A = findingKey(BLOCKER_A);

type Detail = {
  number: number;
  type: "issue";
  title: string;
  body: string;
  state: "open";
  url: string;
  labels: string[];
  comments: Comment[];
};

function detailAt(labels: string[], comments: Comment[]): Detail {
  return {
    number: 7,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/7",
    labels,
    comments,
  };
}

interface OverrideRecorder {
  posted: string[];
  clearedBlocked: number;
  flips: string[];
  advances: number;
  /** Call-order trace so flip-before-advance can be asserted. */
  sequence: string[];
}

/**
 * RunOverrideDeps fakes. Posted comments are appended to `detail.comments` so a
 * chained advance (whose getIssueDetail reads the same detail) sees the override
 * sentinel — mirroring real GitHub state.
 */
function makeOverrideDeps(
  detail: Detail,
  onAdvance?: () => Promise<void>,
): { deps: RunOverrideDeps; rec: OverrideRecorder } {
  const rec: OverrideRecorder = { posted: [], clearedBlocked: 0, flips: [], advances: 0, sequence: [] };
  const deps: RunOverrideDeps = {
    getIssueDetail: (async () => detail) as RunOverrideDeps["getIssueDetail"],
    postComment: async (_cfg, _n, body) => {
      rec.posted.push(body);
      rec.sequence.push("post");
      detail.comments.push({ author: "operator", body, createdAt: "2026-06-12T01:00:00Z" });
    },
    clearBlocked: async () => {
      rec.clearedBlocked += 1;
      rec.sequence.push("clearBlocked");
    },
    silentTransition: async (_cfg, _n, from, to) => {
      rec.flips.push(`${from}->${to}`);
      rec.sequence.push("flip");
    },
    runAdvance: async () => {
      rec.advances += 1;
      rec.sequence.push("advance");
      if (onAdvance) await onAdvance();
    },
  };
  return { deps, rec };
}

interface ReviewRecorder {
  transitions: Stage[];
  comments: string[];
  blocked: string[];
}

/** AdvanceReviewDeps fakes whose getIssueDetail reads the SAME shared detail
 *  runOverride mutated, and whose reviewer re-emits `findings` verbatim. */
function makeReviewDeps(
  detail: Detail,
  findings: { severity: string; file: string; title: string }[],
): { deps: AdvanceReviewDeps; rec: ReviewRecorder } {
  const rec: ReviewRecorder = { transitions: [], comments: [], blocked: [] };
  const stdout = JSON.stringify({
    verdict: "needs-attention",
    summary: "re-emitted findings",
    findings: findings.map((f) => ({ ...f, body: "b", confidence: 0.9, recommendation: "r" })),
    next_steps: [],
  });
  const deps: AdvanceReviewDeps = {
    getPrForIssue: async () => 42,
    getPrDiff: async () => "diff --git a/x.ts b/x.ts\n+const a = 1;",
    getPrDetail: async () =>
      ({ head_sha: "f".repeat(40) }) as Awaited<
        ReturnType<NonNullable<AdvanceReviewDeps["getPrDetail"]>>
      >,
    getIssueDetail: (async () => detail) as NonNullable<AdvanceReviewDeps["getIssueDetail"]>,
    getForIssue: async () => null,
    postComment: async (_cfg, _n, body) => {
      rec.comments.push(body);
      detail.comments.push({ author: "pipeline-bot", body, createdAt: "2026-06-12T02:00:00Z" });
    },
    postPrComment: async () => {},
    transition: async (_cfg, _n, _from, to) => {
      rec.transitions.push(to);
    },
    setBlocked: async (_cfg, _n, reason) => {
      rec.blocked.push(reason);
    },
    // Mirror invokeReviewer's ReviewerInvocation shape (#39): a normal
    // cross-harness review by the configured reviewer.
    runReview: async () => ({
      result: {
        success: true,
        stdout,
        stderr: "",
        exit_code: 0,
        duration: 0.1,
        timed_out: false,
      },
      effectiveReviewer: "codex",
      selfReview: false,
    }),
  };
  return { deps, rec };
}

/** Suppress console.log/warn for the duration of `fn`, returning logged lines. */
async function quiet(t: TestContext, fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  t.mock.method(console, "warn", () => {});
  await fn();
  return lines;
}

const OPTS: CliOpts = {};

// ---------------------------------------------------------------------------
// 2.1 all blockers overridden → the resumed loop advances
// ---------------------------------------------------------------------------

test("runOverride (#135): override covering the only blocker auto-resumes and the loop advances", async (t) => {
  // Blocked at review-2 (below the round ceiling), one blocking finding A.
  const detail = detailAt(["pipeline:review-2", "blocked"], []);
  const review = makeReviewDeps(detail, [BLOCKER_A]);
  let outcome: Outcome | undefined;
  const { deps, rec } = makeOverrideDeps(detail, async () => {
    outcome = await advanceReview(CFG, 7, 2, {}, 0, review.deps);
  });

  const logged = await quiet(t, async () => {
    await runOverride(CFG, 7, `${KEY_A}: rejected — false positive`, OPTS, deps);
  });

  assert.ok(
    rec.posted.some((b) => b.includes(`<!-- pipeline-override: ${KEY_A} rejected -->`)),
    "the audited sentinel must be posted",
  );
  assert.equal(rec.clearedBlocked, 1, "blocked must be cleared before resuming");
  assert.deepEqual(rec.flips, [], "no label flip outside needs-human");
  assert.equal(rec.advances, 1, "the advance loop must be entered automatically");
  // The re-emitted finding is overridden by the just-posted sentinel → advances.
  assert.deepEqual(review.rec.transitions, ["pre-merge"], "all blockers dispositioned → advance");
  assert.equal(outcome?.advanced, true);
  assert.deepEqual(review.rec.blocked, []);
  assert.ok(
    !logged.some((l) => l.includes("Re-run the pipeline")),
    "the manual re-run prompt must be gone",
  );
});

// ---------------------------------------------------------------------------
// 2.2 some blockers remain → the resumed loop re-parks at needs-human
// ---------------------------------------------------------------------------

test("runOverride (#135): override covering only one of two blockers re-parks at needs-human", async (t) => {
  // Parked at needs-human after the round-2 ceiling: 3 prior verdict comments
  // (cap 3), then the ceiling comment. Overriding A still leaves B blocking.
  const priorR2 = (sha: string): Comment => ({
    author: "pipeline-bot",
    body: `## Review 2 (Adversarial) — needs-attention (commit ${sha.slice(0, 7)})\n\n<!-- reviewed-sha: ${sha} -->`,
    createdAt: "2026-06-11T00:00:00Z",
  });
  const detail = detailAt(
    ["pipeline:needs-human"],
    [
      priorR2("a".repeat(40)),
      priorR2("b".repeat(40)),
      priorR2("c".repeat(40)),
      ceilingComment({ round: 2, findings: ["`k1` A", "`k2` B"] }),
    ],
  );
  const review = makeReviewDeps(detail, [BLOCKER_A, BLOCKER_B]);
  let outcome: Outcome | undefined;
  const { deps, rec } = makeOverrideDeps(detail, async () => {
    outcome = await advanceReview(CFG, 7, 2, {}, 0, review.deps);
  });

  await quiet(t, async () => {
    await runOverride(CFG, 7, `${KEY_A}: deferred #200 — tracked separately`, OPTS, deps);
  });

  assert.deepEqual(rec.flips, ["needs-human->review-2"], "must flip back to the ceiling round");
  assert.equal(rec.advances, 1);
  // B is still blocking and the round is at its ceiling → re-park, never advance.
  assert.deepEqual(review.rec.transitions, ["needs-human"], "remaining blocker → re-park at needs-human");
  assert.ok(
    !review.rec.transitions.some((to) => to === "pre-merge" || to === "ready-to-deploy"),
    "must NOT advance past an unresolved blocker",
  );
  assert.equal((outcome as { to?: Stage } | undefined)?.to, "needs-human");
  assert.ok(
    review.rec.comments.some((c) => c.startsWith("## Pipeline: Review ceiling reached")),
    "a fresh ceiling punch-list is posted on re-park",
  );
});

// ---------------------------------------------------------------------------
// 2.3 needs-human label flip is computed from the ceiling round
// ---------------------------------------------------------------------------

test("runOverride (#135): needs-human flips to the round recorded in the ceiling comment, before advancing", async (t) => {
  const detail = detailAt(["pipeline:needs-human"], [ceilingComment({ round: 2, findings: ["`k1` A"] })]);
  const { deps, rec } = makeOverrideDeps(detail);
  await quiet(t, async () => {
    await runOverride(CFG, 7, `${KEY_A}: rejected — out of scope`, OPTS, deps);
  });
  assert.deepEqual(rec.flips, ["needs-human->review-2"]);
  assert.equal(rec.advances, 1);
  assert.deepEqual(rec.sequence, ["post", "flip", "advance"], "flip must precede the advance loop");
});

test("runOverride (#135): a round-1 ceiling resumes into review-1", async (t) => {
  const detail = detailAt(["pipeline:needs-human"], [ceilingComment({ round: 1, findings: ["`k1` A"] })]);
  const { deps, rec } = makeOverrideDeps(detail);
  await quiet(t, async () => {
    await runOverride(CFG, 7, `${KEY_A}: rejected — out of scope`, OPTS, deps);
  });
  assert.deepEqual(rec.flips, ["needs-human->review-1"]);
  assert.equal(rec.advances, 1);
});

test("runOverride (#135): the latest ceiling comment names the resume round", async (t) => {
  // An older round-1 ceiling followed by a newer round-2 ceiling → review-2.
  const detail = detailAt(
    ["pipeline:needs-human"],
    [
      ceilingComment({ round: 1, findings: ["`k1` A"], createdAt: "2026-06-10T00:00:00Z" }),
      ceilingComment({ round: 2, findings: ["`k2` B"], createdAt: "2026-06-11T00:00:00Z" }),
    ],
  );
  const { deps, rec } = makeOverrideDeps(detail);
  await quiet(t, async () => {
    await runOverride(CFG, 7, `${KEY_A}: rejected — out of scope`, OPTS, deps);
  });
  assert.deepEqual(rec.flips, ["needs-human->review-2"]);
});

// ---------------------------------------------------------------------------
// 2.4 needs-human with no ceiling comment → clear error, no flip, no advance
// ---------------------------------------------------------------------------

test("runOverride (#135): needs-human with no ceiling comment errors clearly and does not advance", async (t) => {
  const detail = detailAt(["pipeline:needs-human"], [
    { author: "human", body: "an unrelated note", createdAt: "2026-06-10T00:00:00Z" },
  ]);
  const { deps, rec } = makeOverrideDeps(detail);
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const originalExitCode = process.exitCode;
  try {
    await quiet(t, async () => {
      await runOverride(CFG, 7, `${KEY_A}: rejected — false positive`, OPTS, deps);
    });
    assert.equal(process.exitCode, 1, "must exit non-zero");
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.equal(rec.advances, 0, "must NOT enter the advance loop");
  assert.deepEqual(rec.flips, [], "must NOT flip any label");
  assert.ok(
    errors.some((e) => e.includes("Review ceiling reached") && e.includes("no ")),
    `error must describe the missing ceiling comment; got:\n${errors.join("\n")}`,
  );
  // The disposition itself is still recorded — the operator falls back to the
  // manual relabel + re-run, with the override already applying.
  assert.ok(rec.posted.some((b) => b.includes(`<!-- pipeline-override: ${KEY_A} rejected -->`)));
});

// ---------------------------------------------------------------------------
// 2.5 non-needs-human stage → no flip, loop entered directly
// ---------------------------------------------------------------------------

test("runOverride (#135): blocked at review-1 enters the advance loop directly with no label flip", async (t) => {
  const detail = detailAt(["pipeline:review-1", "blocked"], []);
  const { deps, rec } = makeOverrideDeps(detail);
  await quiet(t, async () => {
    await runOverride(CFG, 7, `${KEY_A}: rejected — false positive`, OPTS, deps);
  });
  assert.deepEqual(rec.flips, [], "no label flip outside needs-human");
  assert.equal(rec.clearedBlocked, 1);
  assert.equal(rec.advances, 1, "the advance loop must be entered");
  assert.deepEqual(rec.sequence, ["post", "clearBlocked", "advance"]);
});

// ---------------------------------------------------------------------------
// 2.6 --dry-run --override is rejected as a usage error before any GitHub write
// ---------------------------------------------------------------------------

test("runOverride: --dry-run --override is rejected as a usage error; no GitHub writes are made", async (t) => {
  // Regression for finding 1 of review 2: runOverride must not mutate any label
  // or post any comment when --dry-run is set — it exits with code 2 instead.
  const detail = detailAt(["pipeline:needs-human"], [ceilingComment({ round: 2, findings: ["`k1` A"] })]);
  const { deps, rec } = makeOverrideDeps(detail);
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const originalExitCode = process.exitCode;
  try {
    await quiet(t, async () => {
      await runOverride(CFG, 7, `${KEY_A}: rejected — false positive`, { dryRun: true }, deps);
    });
    assert.equal(process.exitCode, 2, "must set exit code 2");
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.equal(rec.posted.length, 0, "must not post any comment");
  assert.equal(rec.clearedBlocked, 0, "must not clear blocked");
  assert.equal(rec.flips.length, 0, "must not flip any label");
  assert.equal(rec.advances, 0, "must not enter the advance loop");
  assert.ok(
    errors.some((e) => e.includes("--override") && e.includes("--dry-run")),
    `error must mention both flags; got:\n${errors.join("\n")}`,
  );
});
