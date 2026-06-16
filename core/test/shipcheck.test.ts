// Shipcheck-gate stage (#148) unit tests.
//
// All side-effecting calls (GitHub API, harness invocation, file reads) are
// injected as stubs via ShipcheckDeps. No network or filesystem operations.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  buildShipcheckPrompt,
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
