// Shipcheck-gate stage (#148) unit tests.
//
// All side-effecting calls (GitHub API, harness invocation, file reads) are
// injected as stubs via ShipcheckDeps. No network or filesystem operations.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  archiveNamesFromPaths,
  buildShipcheckPrompt,
  extractAcceptanceCriteria,
  formatShipcheckComment,
  parseShipcheckVerdict,
  type ShipcheckDeps,
} from "../scripts/stages/shipcheck.ts";
import { SHIPCHECK_VERDICT_SCHEMA_BLOCK, SHIPCHECK_SCHEMA_FIELDS } from "../scripts/review-schema.ts";
import type { PipelineConfig, ShipcheckVerdict } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

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

function appendOnlyRunStore(appended: string[]): RunStoreDeps {
  return {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async (_p, data) => { appended.push(data); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
}

function appendedEvents(appended: string[]): Record<string, unknown>[] {
  return appended.map((line) => JSON.parse(line) as Record<string, unknown>);
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
  const appended: string[] = [];

  const out = await advance(cfg, 44, { runDir: "/runs/44", runStoreDeps: appendOnlyRunStore(appended) }, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("advisory"), "comment must say advisory");
  assert.ok(log.comments[0].includes("FAIL") || log.comments[0].includes("fail"), "comment must show fail verdict");
  assert.equal(log.transitions.length, 1);
  assert.deepEqual(
    appendedEvents(appended).map((event) => ({ type: event.type, gate: event.gate, result: event.result, mode: event.mode })),
    [{ type: "gate_result", gate: "shipcheck-gate", result: "fail", mode: "advisory" }],
  );
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
  // Regression for #302: fail verdict must use the dedicated shipcheck-failed
  // blockerKind (maps to eval-shipcheck-failure in the taxonomy) — not the
  // recoverable eval-gate-failed kind, and not the generic needs-human.
  assert.equal((out as { blockerKind: string }).blockerKind, "shipcheck-failed", "fail verdict blockerKind must be shipcheck-failed");
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
  // Regression for #302: partial verdict (block_on_partial) must use the dedicated
  // shipcheck-failed blockerKind (maps to eval-shipcheck-failure) — not the
  // recoverable eval-gate-failed kind, and not the generic needs-human.
  assert.equal((out as { blockerKind: string }).blockerKind, "shipcheck-failed", "partial verdict blockerKind must be shipcheck-failed");
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

// ---------------------------------------------------------------------------
// Finding 1 (review-2): symlink escape must be rejected via realpath check
// ---------------------------------------------------------------------------

test("archiveNamesFromPaths: extracts full date-prefixed archive dir names from diff paths", () => {
  const paths = [
    "openspec/changes/archive/2026-06-08-my-feature/specs/my-feature/spec.md",
    "openspec/changes/archive/2026-06-10-other/specs/other/spec.md",
    "openspec/specs/my-feature/spec.md",            // living spec — not an archive path
    "openspec/changes/active-change/specs/x.md",    // active change — must be excluded
  ];
  const names = archiveNamesFromPaths(paths);
  assert.deepEqual(
    names.sort(),
    ["2026-06-08-my-feature", "2026-06-10-other"].sort(),
    "must extract full date-prefixed archive names and exclude non-archive paths",
  );
});

test("archiveNamesFromPaths: returns empty array when no archive paths present", () => {
  const paths = ["src/foo.ts", "openspec/specs/x.md", "openspec/changes/active/tasks.md"];
  assert.deepEqual(archiveNamesFromPaths(paths), []);
});

test("shipcheck-gate: symlink rubric_path that resolves outside repo → rejected, fallback used", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", rubric_path: ".github/shipcheck-rubric.md" });
  // Simulate a repo rooted at /some/repo where the rubric symlinks to /etc/passwd.
  cfg.repo_dir = "/some/repo";

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT), "should not be read via readFile"),
    realpathFn: (p: string) => {
      if (p === "/some/repo") return "/some/repo";
      // The rubric file is a symlink whose real path exits the repo.
      if (p.endsWith("shipcheck-rubric.md")) return "/etc/passwd";
      return p;
    },
    readFile: (_p) => { throw new Error("readFile must not be called when symlink escapes repo"); },
    getIssueDetail: async (_cfg, _n) => ({
      number: _n, type: "issue", title: "T",
      body: "## Acceptance Criteria\n- Symlink AC must appear in prompt",
      state: "open", url: "u", labels: [], comments: [],
    }),
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  try {
    const out = await advance(cfg, 80, {}, deps);
    assert.equal(out.advanced, true);
    assert.ok(
      warnings.some((w) => w.includes("symlink")),
      "must warn about symlink escape",
    );
    assert.ok(capturedPrompt.includes("Symlink AC must appear in prompt"), "prompt must use AC fallback, not symlink target");
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// Finding 2 (review-2): archived OpenSpec deltas recovered after pre-merge
// ---------------------------------------------------------------------------

test("shipcheck-gate: OpenSpec deltas recovered from date-prefixed archive dir after pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });

  // Simulate a git diff that shows archived OpenSpec paths (post-pre-merge).
  // The active change dir was moved to the date-prefixed archive location.
  const archiveDiffPaths = [
    "openspec/changes/archive/2026-06-08-my-feature/specs/my-feature/spec.md",
    "openspec/specs/my-feature/spec.md",
  ];

  let capturedPrompt = "";
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getForIssue: async () => ({ path: "/tmp/fake-worktree", slug: "1-test" }),
    gitDiffNames: async () => archiveDiffPaths,
    readSpecDeltasFn: (_wtPath: string, name: string) => {
      // Verify the lookup uses the full date-prefixed name, not a bare id.
      if (name === "archive/2026-06-08-my-feature") {
        return "## my-feature/spec.md\n\nShipcheck SHALL evaluate archived spec deltas.";
      }
      return "";
    },
    invokeReviewer: async (prompt) => {
      capturedPrompt = prompt;
      return { stdout: fencedJson(PASS_VERDICT), success: true };
    },
  };

  await advance(cfg, 81, {}, deps);

  assert.ok(
    capturedPrompt.includes("Shipcheck SHALL evaluate archived spec deltas"),
    "prompt must include spec deltas recovered from date-prefixed archive dir",
  );
});

// ---------------------------------------------------------------------------
// Regression tests for review-2 findings
// ---------------------------------------------------------------------------

// Finding 1 (review-2): disabled shipcheck + auto_merge_eligibility.enabled → eligibility gate still runs
test("shipcheck-gate: disabled + auto_merge_eligibility.enabled → eligibility gate still runs", async () => {
  const log = makeCallLog();
  let eligibilityGateCalled = false;
  const cfg: PipelineConfig = {
    ...baseCfg({ enabled: false }),
    auto_merge_eligibility: {
      enabled: true,
      max_diff_lines: 300,
      max_files: 10,
      deny_paths: [],
      allow_paths: [],
      min_confidence: 0.8,
    },
  };
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    getPrForIssue: async () => 99,
    getForIssue: async () => null,
    runEligibilityGateFn: async () => {
      eligibilityGateCalled = true;
      return {
        eligibility: "needs-human",
        evaluated_at: "2026-06-28T00:00:00Z",
        deterministic_checks: [],
        denial_reasons: ["ci: no passing run"],
        judge_output: null,
        ci_status_snapshot: { sha: "abc", conclusion: "failure", checked_at: "2026-06-28T00:00:00Z" },
        review_verdict_snapshot: { verdict: "unknown", finding_count: 0, recorded_at: "2026-06-28T00:00:00Z" },
        linked_run_id: "",
        linked_issue: 42,
        linked_pr: 99,
        revert_note: "git revert abc",
      };
    },
  };

  const out = await advance(cfg, 42, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(eligibilityGateCalled, true, "eligibility gate must run even when shipcheck is disabled");
});

// Finding 1 (review-2): disabled shipcheck without auto_merge_eligibility → gate NOT called
test("shipcheck-gate: disabled + auto_merge_eligibility absent → eligibility gate NOT called", async () => {
  const log = makeCallLog();
  let eligibilityGateCalled = false;
  const cfg = baseCfg({ enabled: false });
  const deps: ShipcheckDeps = {
    ...makeDeps(log, ""),
    runEligibilityGateFn: async () => {
      eligibilityGateCalled = true;
      return {
        eligibility: "needs-human",
        evaluated_at: "2026-06-28T00:00:00Z",
        deterministic_checks: [],
        denial_reasons: [],
        judge_output: null,
        ci_status_snapshot: { sha: "abc", conclusion: "unknown", checked_at: "2026-06-28T00:00:00Z" },
        review_verdict_snapshot: { verdict: "unknown", finding_count: 0, recorded_at: "2026-06-28T00:00:00Z" },
        linked_run_id: "",
        linked_issue: 42,
        linked_pr: null as unknown as number,
        revert_note: "git revert abc",
      };
    },
  };

  const out = await advance(cfg, 42, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(eligibilityGateCalled, false, "eligibility gate must NOT run when auto_merge_eligibility is not configured");
});

// Finding 2 (review-2): actual review verdict read from bundle (no reviews → null)
test("shipcheck-gate: actual review verdict read from bundle, not synthetic approve (empty reviews → null)", async () => {
  const log = makeCallLog();
  let capturedReviewVerdict: unknown = "NOT_CALLED";
  const cfg: PipelineConfig = {
    ...baseCfg({ enabled: true, mode: "advisory" }),
    auto_merge_eligibility: {
      enabled: true,
      max_diff_lines: 300,
      max_files: 10,
      deny_paths: [],
      allow_paths: [],
      min_confidence: 0.8,
    },
  };
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getPrForIssue: async () => 99,
    getForIssue: async () => null,
    readEvidenceBundle: async () => ({
      schema_version: 1,
      schemaVersion: 1,
      runId: "real-run-id",
      issue: 42,
      pr: 99,
      branch: "test",
      harnesses: [],
      stages: [],
      reviews: [],
      overrides: [],
      recoveries: [],
      finalState: null,
      finalizedAt: null,
      notifiedAt: null,
    }),
    runEligibilityGateFn: async (_cfg, _issue, _pr, gateOpts) => {
      capturedReviewVerdict = gateOpts.reviewVerdict;
      return {
        eligibility: "needs-human",
        evaluated_at: "2026-06-28T00:00:00Z",
        deterministic_checks: [],
        denial_reasons: ["review: verdict is not approved"],
        judge_output: null,
        ci_status_snapshot: { sha: "abc", conclusion: "unknown", checked_at: "2026-06-28T00:00:00Z" },
        review_verdict_snapshot: { verdict: "unknown", finding_count: 0, recorded_at: "2026-06-28T00:00:00Z" },
        linked_run_id: "real-run-id",
        linked_issue: 42,
        linked_pr: 99,
        revert_note: "git revert abc",
      };
    },
  };

  const out = await advance(cfg, 42, { stateDir: "/tmp/state" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(capturedReviewVerdict, null, "with no reviews in bundle, reviewVerdict should be null (not synthetic approve)");
});

// Finding 2 (review-2): actual review verdict from bundle reviews passed to eligibility gate
test("shipcheck-gate: actual review verdict from bundle reviews passed to eligibility gate", async () => {
  const log = makeCallLog();
  let capturedReviewVerdict: unknown = "NOT_CALLED";
  const cfg: PipelineConfig = {
    ...baseCfg({ enabled: true, mode: "advisory" }),
    auto_merge_eligibility: {
      enabled: true,
      max_diff_lines: 300,
      max_files: 10,
      deny_paths: [],
      allow_paths: [],
      min_confidence: 0.8,
    },
  };
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getPrForIssue: async () => 99,
    getForIssue: async () => null,
    readEvidenceBundle: async () => ({
      schema_version: 1,
      schemaVersion: 1,
      runId: "real-run-id",
      issue: 42,
      pr: 99,
      branch: "test",
      harnesses: [],
      stages: [],
      reviews: [{ round: 1, sha: "abc", verdict: "approve", findingCounts: { low: 0 } }],
      overrides: [],
      recoveries: [],
      finalState: null,
      finalizedAt: null,
      notifiedAt: null,
    }),
    runEligibilityGateFn: async (_cfg, _issue, _pr, gateOpts) => {
      capturedReviewVerdict = gateOpts.reviewVerdict;
      return {
        eligibility: "auto-merge-eligible",
        evaluated_at: "2026-06-28T00:00:00Z",
        deterministic_checks: [],
        denial_reasons: [],
        judge_output: null,
        ci_status_snapshot: { sha: "abc", conclusion: "success", checked_at: "2026-06-28T00:00:00Z" },
        review_verdict_snapshot: { verdict: "approve", finding_count: 0, recorded_at: "2026-06-28T00:00:00Z" },
        linked_run_id: "real-run-id",
        linked_issue: 42,
        linked_pr: 99,
        revert_note: "git revert abc",
      };
    },
  };

  const out = await advance(cfg, 42, { stateDir: "/tmp/state" }, deps);

  assert.equal(out.advanced, true);
  const rv = capturedReviewVerdict as { verdict: string } | null;
  assert.ok(rv !== null, "reviewVerdict should not be null when reviews exist");
  assert.equal((rv as { verdict: string }).verdict, "approve", "reviewVerdict.verdict should match the bundle review verdict");
});

test("shipcheck-gate: OpenSpec disabled (enabled:off) → archive lookup skipped", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory" });
  cfg.openspec = { enabled: "off", bootstrap: false };

  let readSpecDeltasCalled = false;
  const deps: ShipcheckDeps = {
    ...makeDeps(log, fencedJson(PASS_VERDICT)),
    getForIssue: async () => ({ path: "/tmp/fake-worktree", slug: "1-test" }),
    gitDiffNames: async () => ["openspec/changes/archive/2026-06-08-x/specs/x.md"],
    readSpecDeltasFn: () => { readSpecDeltasCalled = true; return "should not be read"; },
    invokeReviewer: async () => ({ stdout: fencedJson(PASS_VERDICT), success: true }),
  };

  await advance(cfg, 82, {}, deps);

  assert.equal(readSpecDeltasCalled, false, "archive lookup must be skipped when openspec is disabled");
});
