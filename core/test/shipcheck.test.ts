// Shipcheck-gate stage (#148) unit tests.
//
// All side-effecting calls (GitHub API, harness invocation, file reads) are
// injected as stubs via ShipcheckDeps. No network or filesystem operations.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  buildShipcheckPrompt,
  extractAcceptanceCriteria,
  formatShipcheckComment,
  parseShipcheckVerdict,
  type ShipcheckDeps,
} from "../scripts/stages/shipcheck.ts";
import { SHIPCHECK_VERDICT_SCHEMA_BLOCK, SHIPCHECK_SCHEMA_FIELDS } from "../scripts/review-schema.ts";
import type { PipelineConfig, ShipcheckVerdict } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CallLog {
  transitions: Array<{ from: string; to: string; reason?: string }>;
  silentTransitions: Array<{ from: string; to: string }>;
  blocked: Array<{ reason: string; kind?: string }>;
  comments: string[];
  prComments: string[];
}

function makeCallLog(): CallLog {
  return { transitions: [], silentTransitions: [], blocked: [], comments: [], prComments: [] };
}

function baseCfg(overrides: Partial<PipelineConfig["shipcheck_gate"]> = {}): PipelineConfig {
  return {
    profile_name: "codex",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "—",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
    eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 2 },
    shipcheck_gate: {
      enabled: true,
      mode: "advisory",
      max_rounds: 1,
      rubric_path: ".github/shipcheck-rubric.md",
      block_on_partial: false,
      ...overrides,
    },
    review_policy: { block_threshold: "medium", min_confidence: 0.7, max_adversarial_rounds: 3 },
    doctor: { runOnStart: false, failFast: false },
    format_gate: [],
    harness_sandbox: false,
  };
}

const PASS_VERDICT: ShipcheckVerdict = {
  verdict: "pass",
  summary: "All acceptance criteria met.",
  criteria: [{ criterion: "Tests pass", result: "pass", note: "CI green" }],
};

const FAIL_VERDICT: ShipcheckVerdict = {
  verdict: "fail",
  summary: "Missing acceptance criteria coverage.",
  criteria: [{ criterion: "Tests pass", result: "fail", note: "No new tests added" }],
};

const PARTIAL_VERDICT: ShipcheckVerdict = {
  verdict: "partial",
  summary: "Some criteria met.",
  criteria: [
    { criterion: "Tests pass", result: "pass", note: "CI green" },
    { criterion: "Docs updated", result: "fail", note: "README not updated" },
  ],
};

function fencedJson(v: ShipcheckVerdict): string {
  return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
}

function makeDeps(
  log: CallLog,
  reviewerOutput: string,
  rubricContents: string | null = "## Rubric\n- Tests must pass\n",
): ShipcheckDeps {
  return {
    getIssueDetail: async (_cfg, _n) => ({
      number: _n,
      type: "issue",
      title: "Test issue",
      body: "Issue body with ACs:\n- [ ] Tests pass",
      state: "open",
      url: "https://github.com/acme/widget/issues/1",
      labels: ["pipeline:shipcheck-gate"],
      comments: [],
    }),
    getPrForIssue: async () => null,
    getPrDiff: async () => "",
    getForIssue: async () => null,
    gitDiffNames: async () => [],
    readEvidenceBundle: async () => null,
    postComment: async (_c, _n, body) => { log.comments.push(body); },
    postPrComment: async (_c, _n, body) => { log.prComments.push(body); },
    transition: async (_c, _n, from, to, reason) => { log.transitions.push({ from, to, reason }); },
    silentTransition: async (_c, _n, from, to) => { log.silentTransitions.push({ from, to }); },
    setBlocked: async (_c, _n, reason, _stage, kind) => { log.blocked.push({ reason, kind: kind as string }); },
    readFile: (_p) => rubricContents,
    invokeReviewer: async () => ({ stdout: reviewerOutput, success: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("shipcheck-gate: disabled → silent label swap to ready-to-deploy, no harness call, no comment", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: false });
  let invokerCalled = 0;
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    invokeReviewer: async () => { invokerCalled++; return { stdout: "", success: true }; },
  };

  const out = await advance(cfg, 42, {}, deps);

  assert.equal(invokerCalled, 0, "reviewer must not be called when disabled");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.silentTransitions.length, 1);
  assert.equal(log.silentTransitions[0].from, "shipcheck-gate");
  assert.equal(log.silentTransitions[0].to, "ready-to-deploy");
  assert.equal(log.transitions.length, 0);
  assert.equal(log.comments.length, 0);
  assert.equal(log.blocked.length, 0);
});

test("shipcheck-gate: rubric file absent — fallback warning logged, still runs", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT), null /* rubric absent */),
  };

  try {
    const out = await advance(cfg, 43, {}, deps);
    assert.equal(out.advanced, true);
    assert.ok(warnings.some((w) => w.includes("rubric file not found")), "must warn about missing rubric");
  } finally {
    console.warn = origWarn;
  }
});

test("shipcheck-gate: advisory mode + fail verdict → comment posted, still advances", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });
  const deps = makeDeps(log, fencedJson(FAIL_VERDICT));

  const out = await advance(cfg, 44, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("advisory"), "comment must say advisory");
  assert.ok(log.comments[0].includes("FAIL") || log.comments[0].includes("fail"), "comment must show fail verdict");
  assert.equal(log.transitions.length, 1);
});

test("shipcheck-gate: gate mode + pass verdict → transitions to ready-to-deploy", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate" });
  const deps = makeDeps(log, fencedJson(PASS_VERDICT));

  const out = await advance(cfg, 45, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.equal(log.transitions.length, 1);
});

test("shipcheck-gate: gate mode + fail verdict → setBlocked, no forward transition", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate" });
  const deps = makeDeps(log, fencedJson(FAIL_VERDICT));

  const out = await advance(cfg, 46, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0);
  assert.equal(log.comments.length, 1);
});

test("shipcheck-gate: gate mode + partial verdict + block_on_partial:false → advances", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", block_on_partial: false });
  const deps = makeDeps(log, fencedJson(PARTIAL_VERDICT));

  const out = await advance(cfg, 47, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
});

test("shipcheck-gate: gate mode + partial verdict + block_on_partial:true → blocks", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", block_on_partial: true });
  const deps = makeDeps(log, fencedJson(PARTIAL_VERDICT));

  const out = await advance(cfg, 48, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0);
  assert.equal(log.comments.length, 1);
});

test("shipcheck-gate: unparseable output in gate mode → needs-human block after max_rounds", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_rounds: 2 });
  let rounds = 0;
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    invokeReviewer: async () => { rounds++; return { stdout: "totally not JSON at all", success: true }; },
  };

  const out = await advance(cfg, 49, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.ok(log.blocked[0].kind === "needs-human", "must block with needs-human kind");
  assert.equal(rounds, 2, "must attempt max_rounds times");
});

test("shipcheck-gate: unparseable output in advisory mode → warn and advance", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_rounds: 1 });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    invokeReviewer: async () => ({ stdout: "not parseable", success: true }),
  };

  try {
    const out = await advance(cfg, 50, {}, deps);
    assert.equal(out.advanced, true);
    assert.equal((out as { to: string }).to, "ready-to-deploy");
    assert.equal(log.blocked.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test("buildShipcheckPrompt: substitutes all placeholders including absent eval summary fallback", () => {
  const prompt = buildShipcheckPrompt({
    rubric: "## Must pass tests",
    issueBody: "Issue body",
    planAndAcs: "Plan here",
    changedFiles: "src/foo.ts +10 -2",
    evalSummary: undefined, // absent → fallback
    openspecDeltas: undefined,
  });

  assert.ok(!prompt.includes("{{rubric}}"), "{{rubric}} must be substituted");
  assert.ok(!prompt.includes("{{issue_body}}"), "{{issue_body}} must be substituted");
  assert.ok(!prompt.includes("{{plan_and_acs}}"), "{{plan_and_acs}} must be substituted");
  assert.ok(!prompt.includes("{{changed_files}}"), "{{changed_files}} must be substituted");
  assert.ok(!prompt.includes("{{eval_summary}}"), "{{eval_summary}} must be substituted");
  assert.ok(!prompt.includes("{{openspec_deltas}}"), "{{openspec_deltas}} must be substituted");
  assert.ok(!prompt.includes("{{schema_block}}"), "{{schema_block}} must be substituted");

  assert.ok(prompt.includes("eval results: not available"), "absent eval summary must use fallback text");
  assert.ok(prompt.includes("## Must pass tests"), "rubric content must appear");
  assert.ok(prompt.includes("Issue body"), "issue body must appear");
});

test("SHIPCHECK_VERDICT_SCHEMA_BLOCK drift-guard: schema constant fields match ShipcheckVerdict/ShipcheckCriterion manifest", () => {
  // Parse the schema block fields from the constant.
  const block = SHIPCHECK_VERDICT_SCHEMA_BLOCK;
  const verdictFields: string[] = [];
  const criterionFields: string[] = [];
  let depth = 0;
  const keyRe = /^"(\w+)"\s*:/;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"') {
      const m = block.slice(i).match(keyRe);
      if (m) {
        if (depth === 1) verdictFields.push(m[1]);
        else if (depth === 3) criterionFields.push(m[1]);
      }
    }
  }

  const expectedVerdict = SHIPCHECK_SCHEMA_FIELDS.verdict;
  const expectedCriterion = SHIPCHECK_SCHEMA_FIELDS.criterion;

  const missingFromBlock = expectedVerdict.filter((f) => !verdictFields.includes(f));
  assert.deepEqual(missingFromBlock, [], `verdict fields in ShipcheckVerdict missing from schema block: ${missingFromBlock.join(", ")}`);

  const extraInBlock = verdictFields.filter((f) => !expectedVerdict.includes(f));
  assert.deepEqual(extraInBlock, [], `extra verdict fields in schema block not in ShipcheckVerdict: ${extraInBlock.join(", ")}`);

  const missingCriterion = expectedCriterion.filter((f) => !criterionFields.includes(f));
  assert.deepEqual(missingCriterion, [], `criterion fields in ShipcheckCriterion missing from schema block: ${missingCriterion.join(", ")}`);

  const extraCriterion = criterionFields.filter((f) => !expectedCriterion.includes(f));
  assert.deepEqual(extraCriterion, [], `extra criterion fields in schema block not in ShipcheckCriterion: ${extraCriterion.join(", ")}`);
});

// ---------------------------------------------------------------------------
// parseShipcheckVerdict unit tests
// ---------------------------------------------------------------------------

test("parseShipcheckVerdict: valid fenced JSON block → parsed without fallback", () => {
  const warnings: string[] = [];
  const result = parseShipcheckVerdict(fencedJson(PASS_VERDICT), (w) => warnings.push(w));
  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, PASS_VERDICT.summary);
  assert.deepEqual(warnings, []);
});

test("parseShipcheckVerdict: unparseable output → conservative fail fallback + warning", () => {
  const warnings: string[] = [];
  const result = parseShipcheckVerdict("I reviewed the code and it looks good to me!", (w) => warnings.push(w));
  assert.equal(result.verdict, "fail");
  assert.equal(result.criteria.length, 0);
  assert.ok(warnings.length > 0, "must warn on parse failure");
});

// ---------------------------------------------------------------------------
// formatShipcheckComment unit tests
// ---------------------------------------------------------------------------

test("formatShipcheckComment: advisory mode comment header includes 'advisory'", () => {
  const comment = formatShipcheckComment(PASS_VERDICT, "advisory");
  assert.ok(comment.includes("advisory"), "advisory mode comment must include 'advisory'");
});

test("formatShipcheckComment: per-criterion table present when criteria non-empty", () => {
  const comment = formatShipcheckComment(PARTIAL_VERDICT, "gate");
  assert.ok(comment.includes("| Criterion |"), "comment must include criterion table");
  assert.ok(comment.includes("Tests pass"), "comment must list criterion names");
  assert.ok(comment.includes("Docs updated"), "comment must list all criteria");
});

// ---------------------------------------------------------------------------
// Finding 4: non-zero/timeout reviewer exit must not silently pass (regression)
// ---------------------------------------------------------------------------

test("shipcheck-gate: reviewer non-zero exit with valid JSON stdout → treated as failed round, not parsed", async () => {
  // When invokeReviewer returns success:false, the gate must NOT parse stdout
  // even if it contains valid JSON. In gate mode with max_rounds:1 this must block.
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_rounds: 1 });
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    invokeReviewer: async () => ({
      stdout: fencedJson(PASS_VERDICT), // valid JSON, but process failed
      success: false,
    }),
  };

  const out = await advance(cfg, 60, {}, deps);

  assert.equal(out.advanced, false, "non-zero exit must not advance even with valid-looking stdout");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.ok(log.blocked[0].kind === "needs-human");
  assert.equal(log.transitions.length, 0);
});

test("shipcheck-gate: reviewer non-zero exit in advisory mode → warn and advance (parse failure path)", async () => {
  // Advisory mode still advances after a failed reviewer invocation.
  const log = makeCallLog();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  const cfg = baseCfg({ enabled: true, mode: "advisory", max_rounds: 1 });
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    invokeReviewer: async () => ({ stdout: "", success: false }),
  };

  try {
    const out = await advance(cfg, 61, {}, deps);
    assert.equal(out.advanced, true, "advisory mode must advance even after non-zero exit");
    assert.equal((out as { to: string }).to, "ready-to-deploy");
    assert.equal(log.blocked.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// Finding 5: malformed criteria array must be rejected (regression)
// ---------------------------------------------------------------------------

test("parseShipcheckVerdict: criteria entries missing required fields → parse failure fallback", () => {
  const warnings: string[] = [];
  // Top-level shape valid, but criteria entries lack required fields.
  const malformed = JSON.stringify({ verdict: "pass", summary: "ok", criteria: [{}] });
  const result = parseShipcheckVerdict(malformed, (w) => warnings.push(w));
  assert.equal(result.verdict, "fail", "malformed criterion must fall back to fail");
  assert.ok(warnings.length > 0, "must warn on malformed criteria");
});

test("parseShipcheckVerdict: criteria entry with wrong result value → parse failure fallback", () => {
  const warnings: string[] = [];
  const malformed = JSON.stringify({
    verdict: "pass",
    summary: "ok",
    criteria: [{ criterion: "c", result: "unknown", note: "n" }],
  });
  const result = parseShipcheckVerdict(malformed, (w) => warnings.push(w));
  assert.equal(result.verdict, "fail", "invalid criterion result must fall back to fail");
  assert.ok(warnings.length > 0);
});

test("parseShipcheckVerdict: fully valid criteria entries → parsed without fallback", () => {
  const warnings: string[] = [];
  const valid = JSON.stringify({
    verdict: "pass",
    summary: "all good",
    criteria: [
      { criterion: "Tests pass", result: "pass", note: "CI green" },
      { criterion: "Docs updated", result: "na", note: "no docs needed" },
    ],
  });
  const result = parseShipcheckVerdict(valid, (w) => warnings.push(w));
  assert.equal(result.verdict, "pass");
  assert.equal(result.criteria.length, 2);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Finding 6: rubric fallback must use issue acceptance criteria (regression)
// ---------------------------------------------------------------------------

test("shipcheck-gate: rubric absent → fallback uses issue body acceptance-criteria section", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT), null /* rubric file absent */),
    getIssueDetail: async (_cfg, _n) => ({
      number: _n,
      type: "issue",
      title: "Test issue",
      body: "Some preamble.\n\n## Acceptance Criteria\n- Criterion A must pass\n- Criterion B must pass",
      state: "open",
      url: "https://github.com/acme/widget/issues/1",
      labels: ["pipeline:shipcheck-gate"],
      comments: [],
    }),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await advance(cfg, 62, {}, deps);
    assert.ok(warnings.some((w) => w.includes("rubric file not found")), "must warn about missing rubric");
    assert.ok(capturedPrompt.includes("Criterion A must pass"), "prompt must include issue ACs as rubric");
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// Finding 3: prompt context assembly (regression)
// ---------------------------------------------------------------------------

test("shipcheck-gate: PR diff assembled into changed-files prompt section", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getPrForIssue: async () => 42,
    getPrDiff: async () =>
      "diff --git a/src/foo.ts b/src/foo.ts\n+some change\ndiff --git a/src/bar.ts b/src/bar.ts\n+another change\n",
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 63, {}, deps);

  assert.ok(capturedPrompt.includes("src/foo.ts"), "prompt must list changed file foo.ts");
  assert.ok(capturedPrompt.includes("src/bar.ts"), "prompt must list changed file bar.ts");
});

test("shipcheck-gate: plan extracted from issue comments included in prompt", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getIssueDetail: async (_cfg, _n) => ({
      number: _n,
      type: "issue",
      title: "Test issue",
      body: "Issue body",
      state: "open",
      url: "https://github.com/acme/widget/issues/1",
      labels: ["pipeline:shipcheck-gate"],
      comments: [
        {
          author: "pipeline-bot",
          body: "## Implementation Plan\n\n### Steps\n1. Do the thing\n2. Test it",
          createdAt: "2024-01-01T00:00:00Z",
        },
      ],
    }),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 64, {}, deps);

  assert.ok(capturedPrompt.includes("Do the thing"), "prompt must include plan content from issue comments");
});

test("shipcheck-gate: worktree path used for reviewer invocation when worktree present", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  let capturedWorktreeDir = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getForIssue: async () => ({ path: "/tmp/test-worktree", slug: "1-test" }),
    gitDiffNames: async () => [],
    invokeReviewer: async (_prompt, worktreeDir) => {
      capturedWorktreeDir = worktreeDir;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 65, {}, deps);

  assert.equal(capturedWorktreeDir, "/tmp/test-worktree", "reviewer must run in the issue worktree");
});

// ---------------------------------------------------------------------------
// extractAcceptanceCriteria unit tests
// ---------------------------------------------------------------------------

test("extractAcceptanceCriteria: section present → returns section text", () => {
  const body = "Intro.\n\n## Acceptance Criteria\n- Must pass tests\n- Must update docs\n\n## Other Section\nOther content.";
  const result = extractAcceptanceCriteria(body);
  assert.ok(result.includes("Must pass tests"), "must include AC content");
  assert.ok(!result.includes("Other content"), "must not include content after the AC section");
});

test("extractAcceptanceCriteria: section absent → returns empty string", () => {
  const body = "Just an issue description with no AC section.";
  const result = extractAcceptanceCriteria(body);
  assert.equal(result, "");
});

// ---------------------------------------------------------------------------
// Finding 1 regression: rubric_path path escape rejection
// ---------------------------------------------------------------------------

test("shipcheck-gate: absolute rubric_path is rejected → fallback used, warning logged", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", rubric_path: "/etc/passwd" });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT), "should not be read"),
    readFile: (_p) => { throw new Error("readFile must not be called for an absolute path"); },
    getIssueDetail: async (_cfg, _n) => ({
      number: _n, type: "issue", title: "T", body: "## Acceptance Criteria\n- AC1", state: "open",
      url: "u", labels: [], comments: [],
    }),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  try {
    const out = await advance(cfg, 70, {}, deps);
    assert.equal(out.advanced, true);
    assert.ok(warnings.some((w) => w.includes("resolves outside the repo root")), "must warn about path escape");
    assert.ok(capturedPrompt.includes("AC1"), "prompt must use AC fallback from issue body");
  } finally {
    console.warn = origWarn;
  }
});

test("shipcheck-gate: traversal rubric_path (../../) is rejected → fallback used", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", rubric_path: "../../etc/passwd" });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT), null),
    readFile: (_p) => { throw new Error("readFile must not be called for escape path"); },
    getIssueDetail: async (_cfg, _n) => ({
      number: _n, type: "issue", title: "T", body: "## Acceptance Criteria\n- AC-escape", state: "open",
      url: "u", labels: [], comments: [],
    }),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  try {
    await advance(cfg, 71, {}, deps);
    assert.ok(warnings.some((w) => w.includes("resolves outside the repo root")), "must warn about traversal escape");
    assert.ok(capturedPrompt.includes("AC-escape"), "prompt must use AC fallback");
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// Finding 3 regression: revised plan preferred over original
// ---------------------------------------------------------------------------

test("shipcheck-gate: Revised Implementation Plan preferred over original plan", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getIssueDetail: async (_cfg, _n) => ({
      number: _n, type: "issue", title: "T", body: "Issue body", state: "open",
      url: "u", labels: [], comments: [
        {
          author: "pipeline-bot",
          body: "## Implementation Plan\n\nOriginal step that is now outdated.",
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          author: "pipeline-bot",
          body: "## Revised Implementation Plan\n\nRevised step incorporating review feedback.",
          createdAt: "2024-01-02T00:00:00Z",
        },
      ],
    }),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 72, {}, deps);

  assert.ok(capturedPrompt.includes("Revised step incorporating review feedback"), "prompt must use revised plan");
  assert.ok(!capturedPrompt.includes("Original step that is now outdated"), "prompt must not use stale original plan");
});

// ---------------------------------------------------------------------------
// Finding 4 regression: empty criteria must not silently pass
// ---------------------------------------------------------------------------

test("parseShipcheckVerdict: pass verdict with empty criteria → conservative fail fallback", () => {
  const warnings: string[] = [];
  const emptyPass = JSON.stringify({ verdict: "pass", summary: "looks good", criteria: [] });
  const result = parseShipcheckVerdict(emptyPass, (w) => warnings.push(w));
  assert.equal(result.verdict, "fail", "empty criteria must trigger conservative fail, not silent pass");
  assert.ok(warnings.length > 0, "must warn when criteria is empty");
});

test("shipcheck-gate: gate mode + pass verdict with empty criteria → blocks (no silent advance)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_rounds: 1 });
  const emptyPassJson = JSON.stringify({ verdict: "pass", summary: "looks good", criteria: [] });
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    invokeReviewer: async () => ({ stdout: emptyPassJson, success: true }),
  };

  const out = await advance(cfg, 73, {}, deps);

  assert.equal(out.advanced, false, "empty criteria must not silently advance in gate mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.ok(log.blocked[0].kind === "needs-human");
});

// ---------------------------------------------------------------------------
// Finding 5 regression: PR comment failure must not strand the gate
// ---------------------------------------------------------------------------

test("shipcheck-gate: PR comment failure → warning logged, gate still advances (advisory)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getPrForIssue: async () => 99,
    postPrComment: async () => { throw new Error("PR API down"); },
  };

  try {
    const out = await advance(cfg, 74, {}, deps);
    assert.equal(out.advanced, true, "gate must advance despite PR comment failure");
    assert.equal(log.comments.length, 1, "issue comment must still be posted");
    assert.ok(warnings.some((w) => w.includes("PR mirror comment failed")), "must warn about PR comment failure");
  } finally {
    console.warn = origWarn;
  }
});

test("shipcheck-gate: PR comment failure → gate still blocks in gate mode on fail verdict", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate" });

  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(FAIL_VERDICT)),
    getPrForIssue: async () => 99,
    postPrComment: async () => { throw new Error("PR API down"); },
  };

  const out = await advance(cfg, 75, {}, deps);

  assert.equal(out.advanced, false, "block must still happen despite PR comment failure");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.comments.length, 1, "issue comment still posted");
});

// ---------------------------------------------------------------------------
// Finding 6 regression: changed files must include line-count deltas
// ---------------------------------------------------------------------------

test("shipcheck-gate: changed-files summary includes additions and deletions", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getPrForIssue: async () => 42,
    getPrDiff: async () => [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "+added line one",
      "+added line two",
      "-removed line",
      " context",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 76, {}, deps);

  assert.ok(capturedPrompt.includes("src/foo.ts (+2 -1)"), "prompt must include foo.ts with line counts");
  assert.ok(capturedPrompt.includes("src/bar.ts (+1 -1)"), "prompt must include bar.ts with line counts");
});

// ---------------------------------------------------------------------------
// Finding 7 regression: timeout comes from cfg.review_timeout, not hardcoded 300
// ---------------------------------------------------------------------------

test("shipcheck-gate: reviewer invoked with cfg.review_timeout, not hardcoded 300", async () => {
  const log = makeCallLog();
  // Use a non-default review_timeout to distinguish from the old hardcoded 300.
  const cfg: ReturnType<typeof baseCfg> = { ...baseCfg({ enabled: true, mode: "advisory" }), review_timeout: 900 };

  let capturedTimeout = 0;
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    invokeReviewer: async (_prompt, _dir, timeoutSec) => {
      capturedTimeout = timeoutSec;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 77, {}, deps);

  assert.equal(capturedTimeout, 900, "reviewer must receive cfg.review_timeout, not hardcoded 300");
});
