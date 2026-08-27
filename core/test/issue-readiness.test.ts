// Issue-implementation-readiness gate (#1238). Injected GitHub / harness / clock.
// No real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type Outcome, type PipelineConfig, type Stage } from "../scripts/types.ts";
import {
  buildIssueReadinessComment,
  evaluateIssueReadiness,
  eventsTextHasGateUnavailable,
  formatIssueReadinessMarker,
  hashIssueReadinessInput,
  ISSUE_READINESS_CANONICAL_HEADINGS,
  parseIssueReadinessMarker,
  parseIssueReadinessVerdict,
  proposedBodyHasCanonicalHeadings,
  recordsMatch,
  resolvedPlanningTreatment,
  type IssueReadinessComment,
  type IssueReadinessDeps,
  type IssueReadinessTreatment,
} from "../scripts/issue-readiness.ts";
import { dispatch, type PlanningRecoveryDeps } from "../scripts/pipeline-run.ts";

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "acme/widget",
    repo_dir: "/tmp/fake-repo",
    domain: "widget",
    invocation: "pipeline",
    harnesses: {
      implementer: "grok",
      reviewer: "codex",
      implementerSource: "repo-config",
      reviewerSource: "repo-config",
    },
    models: {
      planning: "grok-4.6",
      implementing: "grok-4.6",
      review: "gpt-5.6-terra",
      fix: "grok-4.6",
      intake: "grok-4.6",
      sweep: "grok-4.6",
    },
    effort: { planning: "high" },
    issue_readiness: { enabled: true, timeout: 600 },
    ...overrides,
  } as PipelineConfig;
}

const COMPLETE_BODY = [
  "Ship a retry loop for failed fetches.",
  "When the remote returns 5xx, retry up to 3 times then surface the last error.",
  "Out of scope: changing auth. No contradiction with existing timeout of 30s.",
].join("\n");

const THIN_BODY = "Make it better.";

const FIVE_SECTION_BODY = [
  "## Summary",
  "Retry failed fetches.",
  "## User story",
  "As an operator, I want retries so that transient errors recover.",
  "## Acceptance criteria",
  "- [ ] 5xx responses retry up to 3 times",
  "## Out of scope",
  "- Auth changes",
  "## Open questions",
  "None.",
].join("\n");

function needsSpecJson(deficiencies = ["missing observable acceptance criteria"]): string {
  return JSON.stringify({
    verdict: "needs_spec",
    deficiencies,
    proposed_body: FIVE_SECTION_BODY,
  });
}

function readyJson(): string {
  return JSON.stringify({ verdict: "ready", deficiencies: [], proposed_body: "" });
}

const PIPELINE_ACTOR = "pipeline-bot";

function ownedComment(input: {
  id: number;
  verdict: "ready" | "needs_spec";
  hash: string;
  treatment: IssueReadinessTreatment;
  author?: string;
  deficiencies?: string[];
  proposed_body?: string;
}): IssueReadinessComment {
  return {
    id: input.id,
    author: input.author ?? PIPELINE_ACTOR,
    body: buildIssueReadinessComment({
      verdict: input.verdict,
      hash: input.hash,
      treatment: input.treatment,
      deficiencies: input.deficiencies ?? (input.verdict === "needs_spec" ? ["thin"] : []),
      proposed_body: input.proposed_body ?? (input.verdict === "needs_spec" ? FIVE_SECTION_BODY : ""),
      evaluatedAt: "2026-08-27T01:48:04Z",
    }),
  };
}

function makeDeps(opts: {
  title?: string;
  body?: string;
  labels?: string[];
  labelSequence?: string[][];
  comments?: Array<{ id: number; body: string; author?: string }>;
  harness?: IssueReadinessDeps["invokeImplementer"];
  actor?: string | null;
}): IssueReadinessDeps & {
  calls: {
    fetch: number;
    invoke: number;
    createComment: string[];
    updateComment: Array<{ id: number; body: string }>;
    addLabel: string[];
    removeLabel: string[];
  };
} {
  const calls = {
    fetch: 0,
    invoke: 0,
    createComment: [] as string[],
    updateComment: [] as Array<{ id: number; body: string }>,
    addLabel: [] as string[],
    removeLabel: [] as string[],
  };
  const comments: IssueReadinessComment[] = (opts.comments ?? []).map((c) => ({
    id: c.id,
    body: c.body,
    author: c.author ?? "unknown",
  }));
  return {
    calls,
    fetchIssue: async () => {
      calls.fetch++;
      const labels = opts.labelSequence
        ? opts.labelSequence[Math.min(calls.fetch - 1, opts.labelSequence.length - 1)]
        : (opts.labels ?? ["pipeline:ready"]);
      return {
        title: opts.title ?? "Thin issue",
        body: opts.body ?? THIN_BODY,
        labels,
      };
    },
    listComments: async () => comments,
    getPipelineActor: async () => (opts.actor === undefined ? PIPELINE_ACTOR : opts.actor),
    createComment: async (_n, body) => {
      calls.createComment.push(body);
      comments.push({ id: comments.length + 1, body, author: PIPELINE_ACTOR });
    },
    updateComment: async (id, body) => {
      calls.updateComment.push({ id, body });
    },
    addLabel: async (_n, label) => {
      calls.addLabel.push(label);
    },
    removeLabel: async (_n, label) => {
      calls.removeLabel.push(label);
    },
    invokeImplementer: async (input) => {
      calls.invoke++;
      if (opts.harness) return opts.harness(input);
      return { success: true, stdout: needsSpecJson(), stderr: "", timed_out: false };
    },
    now: () => new Date("2026-08-27T01:48:04Z"),
  };
}

test("hash: body change and treatment change invalidate", () => {
  const t = { implementer: "grok", model: "grok-4.6", effort: "high" };
  const h1 = hashIssueReadinessInput("T", "body-a", t);
  const h2 = hashIssueReadinessInput("T", "body-b", t);
  const h3 = hashIssueReadinessInput("T", "body-a", { ...t, model: "sonnet" });
  assert.notEqual(h1, h2);
  assert.notEqual(h1, h3);
  const rec = parseIssueReadinessMarker(formatIssueReadinessMarker("needs_spec", h1, t));
  assert.ok(rec);
  assert.equal(recordsMatch(rec!, h1, t), true);
  assert.equal(recordsMatch(rec!, h2, t), false);
  assert.equal(recordsMatch(rec!, h1, { ...t, effort: "low" }), false);
});

test("parseIssueReadinessVerdict: missing verdict is schema failure", () => {
  assert.throws(() => parseIssueReadinessVerdict('{"deficiencies":[]}'), /schema/);
});

test("parseIssueReadinessVerdict: needs_spec without canonical headings is schema failure", () => {
  assert.throws(
    () =>
      parseIssueReadinessVerdict(
        JSON.stringify({
          verdict: "needs_spec",
          deficiencies: ["thin"],
          proposed_body: "just a paragraph",
        }),
      ),
    /schema/,
  );
  const reversed = [...ISSUE_READINESS_CANONICAL_HEADINGS]
    .reverse()
    .map((heading) => `## ${heading}\ntext`)
    .join("\n");
  assert.throws(
    () =>
      parseIssueReadinessVerdict(
        JSON.stringify({
          verdict: "needs_spec",
          deficiencies: ["thin"],
          proposed_body: reversed,
        }),
      ),
    /schema/,
  );
});

test("proposedBodyHasCanonicalHeadings: requires all five headings in order", () => {
  assert.equal(proposedBodyHasCanonicalHeadings(FIVE_SECTION_BODY), true);
  assert.equal(proposedBodyHasCanonicalHeadings("## Summary\nonly one"), false);
  const reversed = [...ISSUE_READINESS_CANONICAL_HEADINGS]
    .reverse()
    .map((heading) => `## ${heading}`)
    .join("\n");
  assert.equal(proposedBodyHasCanonicalHeadings(reversed), false);
});

test("gate: semantically complete issue without headings is ready", async () => {
  const deps = makeDeps({
    title: "Retry failed fetches",
    body: COMPLETE_BODY,
    harness: async () => ({ success: true, stdout: readyJson(), stderr: "", timed_out: false }),
  });
  const result = await evaluateIssueReadiness(makeCfg(), 42, { deps });
  assert.equal(result.kind, "ready");
  assert.equal(result.kind === "ready" && result.reused, false);
  assert.equal(deps.calls.invoke, 1);
  assert.equal(deps.calls.addLabel.length, 0);
  assert.equal(deps.calls.removeLabel.length, 0);
  assert.equal(deps.calls.createComment.length, 1);
});

test("gate: missing acceptance criteria is needs_spec with five-section body", async () => {
  const deps = makeDeps({ body: THIN_BODY });
  const result = await evaluateIssueReadiness(makeCfg(), 42, { deps });
  assert.equal(result.kind, "needs_spec");
  if (result.kind !== "needs_spec") throw new Error("expected needs_spec");
  assert.ok(result.deficiencies.length > 0);
  assert.equal(proposedBodyHasCanonicalHeadings(result.proposed_body), true);
  assert.deepEqual(deps.calls.addLabel, ["pipeline:needs-spec"]);
  assert.deepEqual(deps.calls.removeLabel, ["pipeline:ready"]);
  assert.equal(deps.calls.createComment.length, 1);
  assert.ok(deps.calls.createComment[0].includes("<!-- pipeline-issue-readiness"));
});

test("gate: later needs_spec updates the same owned comment", async () => {
  const cfg = makeCfg();
  const treatment = resolvedPlanningTreatment(cfg);
  const oldHash = hashIssueReadinessInput("Thin issue", "old", treatment);
  const deps = makeDeps({
    comments: [ownedComment({ id: 9, verdict: "needs_spec", hash: oldHash, treatment })],
    harness: async () => ({
      success: true,
      stdout: needsSpecJson(["unresolved contradiction"]),
      stderr: "",
      timed_out: false,
    }),
  });
  const result = await evaluateIssueReadiness(cfg, 42, { deps });
  assert.equal(result.kind, "needs_spec");
  assert.equal(deps.calls.createComment.length, 0);
  assert.equal(deps.calls.updateComment.length, 1);
  assert.equal(deps.calls.updateComment[0].id, 9);
});

test("gate: matching hash-and-treatment reuses needs_spec with zero invoke", async () => {
  const cfg = makeCfg();
  const treatment = resolvedPlanningTreatment(cfg);
  const hash = hashIssueReadinessInput("Thin issue", THIN_BODY, treatment);
  const deps = makeDeps({
    comments: [ownedComment({ id: 3, verdict: "needs_spec", hash, treatment })],
  });
  const result = await evaluateIssueReadiness(cfg, 42, { deps });
  assert.equal(result.kind, "needs_spec");
  assert.equal(result.kind === "needs_spec" && result.reused, true);
  assert.equal(deps.calls.invoke, 0);
  assert.equal(deps.calls.createComment.length, 0);
  assert.deepEqual(deps.calls.addLabel, ["pipeline:needs-spec"]);
  assert.deepEqual(deps.calls.removeLabel, ["pipeline:ready"]);
});

test("gate: matching ready record is reused with zero invoke", async () => {
  const cfg = makeCfg();
  const treatment = resolvedPlanningTreatment(cfg);
  const hash = hashIssueReadinessInput("Retry failed fetches", COMPLETE_BODY, treatment);
  const deps = makeDeps({
    title: "Retry failed fetches",
    body: COMPLETE_BODY,
    comments: [ownedComment({ id: 4, verdict: "ready", hash, treatment })],
  });
  const result = await evaluateIssueReadiness(cfg, 42, { deps });
  assert.equal(result.kind, "ready");
  assert.equal(result.kind === "ready" && result.reused, true);
  assert.equal(deps.calls.invoke, 0);
  assert.equal(deps.calls.createComment.length, 0);
  assert.equal(deps.calls.updateComment.length, 0);
});

test("gate: foreign needs_spec marker is not patched", async () => {
  const cfg = makeCfg();
  const treatment = resolvedPlanningTreatment(cfg);
  const oldHash = hashIssueReadinessInput("Thin issue", "old", treatment);
  const deps = makeDeps({
    comments: [
      ownedComment({
        id: 99,
        verdict: "needs_spec",
        hash: oldHash,
        treatment,
        author: "attacker",
      }),
    ],
  });
  const result = await evaluateIssueReadiness(cfg, 42, { deps });
  assert.equal(result.kind, "needs_spec");
  assert.equal(result.kind === "needs_spec" && result.reused, false);
  assert.equal(deps.calls.updateComment.length, 0);
  assert.equal(deps.calls.createComment.length, 1);
});

test("gate: untrusted ready marker is not reused and is not patched", async () => {
  const cfg = makeCfg();
  const treatment = resolvedPlanningTreatment(cfg);
  const hash = hashIssueReadinessInput("Retry failed fetches", COMPLETE_BODY, treatment);
  const deps = makeDeps({
    title: "Retry failed fetches",
    body: COMPLETE_BODY,
    comments: [
      ownedComment({
        id: 99,
        verdict: "ready",
        hash,
        treatment,
        author: "attacker",
      }),
    ],
    harness: async () => ({ success: true, stdout: readyJson(), stderr: "", timed_out: false }),
  });
  const result = await evaluateIssueReadiness(cfg, 42, { deps });
  assert.equal(result.kind, "ready");
  assert.equal(result.kind === "ready" && result.reused, false);
  assert.equal(deps.calls.invoke, 1);
  assert.equal(deps.calls.updateComment.length, 0);
  assert.equal(deps.calls.createComment.length, 1);
});

test("gate: marker without pipeline attestation is ignored", async () => {
  const cfg = makeCfg();
  const treatment = resolvedPlanningTreatment(cfg);
  const hash = hashIssueReadinessInput("Retry failed fetches", COMPLETE_BODY, treatment);
  const marker = formatIssueReadinessMarker("ready", hash, treatment);
  const deps = makeDeps({
    title: "Retry failed fetches",
    body: COMPLETE_BODY,
    comments: [{ id: 4, author: PIPELINE_ACTOR, body: `admitted\n${marker}` }],
    harness: async () => ({ success: true, stdout: readyJson(), stderr: "", timed_out: false }),
  });
  const result = await evaluateIssueReadiness(cfg, 42, { deps });
  assert.equal(result.kind, "ready");
  assert.equal(result.kind === "ready" && result.reused, false);
  assert.equal(deps.calls.invoke, 1);
  assert.equal(deps.calls.updateComment.length, 0);
  assert.equal(deps.calls.createComment.length, 1);
});

test("gate: needs_spec draft missing headings is gate-unavailable with no writes", async () => {
  const deps = makeDeps({
    harness: async () => ({
      success: true,
      stdout: JSON.stringify({
        verdict: "needs_spec",
        deficiencies: ["thin"],
        proposed_body: "just a paragraph",
      }),
      stderr: "",
      timed_out: false,
    }),
  });
  const result = await evaluateIssueReadiness(makeCfg(), 7, { deps });
  assert.equal(result.kind, "gate-unavailable");
  assert.equal(deps.calls.createComment.length, 0);
  assert.equal(deps.calls.updateComment.length, 0);
  assert.equal(deps.calls.addLabel.length, 0);
  assert.equal(deps.calls.removeLabel.length, 0);
});

test("gate: live stage not ready is stale-dispatch with no invoke or writes", async () => {
  const deps = makeDeps({ labels: ["pipeline:planning"] });
  const result = await evaluateIssueReadiness(makeCfg(), 42, { deps });
  assert.equal(result.kind, "stale-dispatch");
  if (result.kind === "stale-dispatch") {
    assert.equal(result.observedStage, "planning");
  }
  assert.equal(deps.calls.invoke, 0);
  assert.equal(deps.calls.createComment.length, 0);
  assert.equal(deps.calls.addLabel.length, 0);
  assert.equal(deps.calls.removeLabel.length, 0);
});

test("gate: stage change before needs_spec mutation is stale-dispatch with no writes", async () => {
  const deps = makeDeps({
    labelSequence: [["pipeline:ready"], ["pipeline:planning"]],
  });
  const result = await evaluateIssueReadiness(makeCfg(), 42, { deps });
  assert.equal(result.kind, "stale-dispatch");
  if (result.kind === "stale-dispatch") {
    assert.equal(result.observedStage, "planning");
  }
  assert.equal(deps.calls.invoke, 1);
  assert.equal(deps.calls.createComment.length, 0);
  assert.equal(deps.calls.addLabel.length, 0);
  assert.equal(deps.calls.removeLabel.length, 0);
});

test("gate: timeout, harness fail, and schema fail are gate-unavailable with no writes", async () => {
  for (const harness of [
    async () => ({ success: false, stdout: "", stderr: "boom", timed_out: true }),
    async () => ({ success: false, stdout: "", stderr: "cli missing", timed_out: false }),
    async () => ({ success: true, stdout: "{}", stderr: "", timed_out: false }),
  ] as const) {
    const deps = makeDeps({ harness });
    const result = await evaluateIssueReadiness(makeCfg(), 7, { deps });
    assert.equal(result.kind, "gate-unavailable");
    assert.equal(deps.calls.createComment.length, 0);
    assert.equal(deps.calls.updateComment.length, 0);
    assert.equal(deps.calls.addLabel.length, 0);
    assert.equal(deps.calls.removeLabel.length, 0);
  }
});

test("gate: planning treatment including auto-resolved values is propagated", async () => {
  const seen: Array<{ harness: string; model: string; effort: string | undefined }> = [];
  const cfg = makeCfg({
    harnesses: {
      implementer: "grok",
      reviewer: "codex",
      implementerSource: "repo-config",
      reviewerSource: "repo-config",
    },
    models: { ...makeCfg().models, planning: "grok-4.6" },
    effort: { planning: "high" },
  });
  const deps = makeDeps({
    harness: async (input) => {
      seen.push({ harness: input.harness, model: input.model, effort: input.effort });
      return { success: true, stdout: readyJson(), stderr: "", timed_out: false };
    },
  });
  await evaluateIssueReadiness(cfg, 1, { deps });
  assert.deepEqual(seen, [{ harness: "grok", model: "grok-4.6", effort: "high" }]);
});

test("eventsTextHasGateUnavailable: detects typed gate_result", () => {
  const line = JSON.stringify({
    type: "gate_result",
    gate: "issue_readiness",
    result: "fail",
    reason: "gate-unavailable: timeout",
  });
  assert.equal(eventsTextHasGateUnavailable(line), true);
  assert.equal(eventsTextHasGateUnavailable('{"type":"gate_result","gate":"eval"}'), false);
});

test("dispatch ready: enabled thin issue never claims marker or planningAdvance", async () => {
  const cfg = makeCfg({ issue_readiness: { enabled: true, timeout: 600 } });
  let marker = 0;
  let planning = 0;
  const deps: PlanningRecoveryDeps = {
    transition: async () => {},
    planningAdvance: async () => {
      planning++;
      return { advanced: true, from: "ready", to: "planning", summary: "no" };
    },
    tryAcquireLivePlanningMarker: () => {
      marker++;
      return true;
    },
    evaluateIssueReadiness: async () => ({
      kind: "needs_spec",
      reused: false,
      hash: "abc",
      treatment: resolvedPlanningTreatment(cfg),
      deficiencies: ["missing observable acceptance criteria"],
      proposed_body: FIVE_SECTION_BODY,
    }),
  };
  const out = await dispatch(cfg, 42, "ready", { dryRun: false }, "run", undefined, undefined, undefined, deps);
  assert.equal(out.advanced, true);
  if (out.advanced) {
    assert.equal(out.to, "needs-spec");
  }
  assert.equal(marker, 0);
  assert.equal(planning, 0);
});

test("dispatch ready: disabled skips the gate and claims marker", async () => {
  const cfg = makeCfg({ issue_readiness: { enabled: false, timeout: 600 } });
  let marker = 0;
  let planning = 0;
  let gate = 0;
  const deps: PlanningRecoveryDeps = {
    transition: async () => {},
    planningAdvance: async () => {
      planning++;
      return { advanced: true, from: "ready", to: "planning", summary: "ok" };
    },
    tryAcquireLivePlanningMarker: () => {
      marker++;
      return true;
    },
    evaluateIssueReadiness: async () => {
      gate++;
      return { kind: "needs_spec", reused: false, hash: "x", treatment: resolvedPlanningTreatment(cfg), deficiencies: ["x"], proposed_body: FIVE_SECTION_BODY };
    },
  };
  const out = await dispatch(cfg, 42, "ready", { dryRun: false }, "run", undefined, undefined, undefined, deps);
  assert.equal(out.advanced, true);
  assert.equal(gate, 0);
  assert.equal(marker, 1);
  assert.equal(planning, 1);
});

test("dispatch ready: admitted issue still calls planningAdvance after gate", async () => {
  const cfg = makeCfg({ issue_readiness: { enabled: true, timeout: 600 } });
  let planning = 0;
  const deps: PlanningRecoveryDeps = {
    transition: async () => {},
    planningAdvance: async () => {
      planning++;
      return { advanced: true, from: "ready", to: "planning", summary: "admitted" };
    },
    tryAcquireLivePlanningMarker: () => true,
    evaluateIssueReadiness: async () => ({
      kind: "ready",
      reused: false,
      hash: "h",
      treatment: resolvedPlanningTreatment(cfg),
    }),
  };
  const out = await dispatch(cfg, 9, "ready", {}, "run", undefined, undefined, undefined, deps);
  assert.equal(out.advanced, true);
  assert.equal(planning, 1);
});

test("dispatch needs-spec: wait with zero planningAdvance", async () => {
  let planning = 0;
  const deps: PlanningRecoveryDeps = {
    transition: async () => {},
    planningAdvance: async () => {
      planning++;
      return { advanced: true, from: "ready", to: "planning", summary: "no" };
    },
    tryAcquireLivePlanningMarker: () => true,
  };
  const out = await dispatch(makeCfg(), 1, "needs-spec", {}, "run", undefined, undefined, undefined, deps);
  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.status, "waiting");
    assert.match(out.reason, /triage/);
  }
  assert.equal(planning, 0);
});

test("dispatch implementing: does not fetch for issue-readiness", async () => {
  const cfg = makeCfg({ issue_readiness: { enabled: true, timeout: 600 } });
  let gate = 0;
  const deps: PlanningRecoveryDeps = {
    transition: async () => {},
    planningAdvance: async () => ({ advanced: false, status: "waiting", reason: "resume" }),
    isLivePlanningActive: () => false,
    evaluateIssueReadiness: async () => {
      gate++;
      return { kind: "ready", reused: false, hash: "h", treatment: resolvedPlanningTreatment(cfg) };
    },
  };
  await dispatch(cfg, 5, "implementing", { dryRun: true }, "run", undefined, undefined, undefined, deps);
  assert.equal(gate, 0);
});

test("pickup coordinators share ready-dispatch gate and have no private copy", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
  const dispatchSrc = readFileSync(join(root, "pipeline-run.ts"), "utf8");
  assert.match(dispatchSrc, /evaluateIssueReadiness/);
  assert.match(dispatchSrc, /case "ready"/);
  for (const rel of ["stages/queue.ts", "stages/train.ts", "stages/ship.ts", "loop/supervisor.ts"]) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.equal(
      src.includes("evaluateIssueReadiness"),
      false,
      `${rel} must not copy the gate; ready dispatch is the seam`,
    );
  }
  assert.match(readFileSync(join(root, "stages/queue.ts"), "utf8"), /pipelineScript/);
  assert.match(readFileSync(join(root, "stages/train.ts"), "utf8"), /advanceWave/);
});

test("dispatch ready: stale-dispatch is a waiting no-op", async () => {
  const cfg = makeCfg({ issue_readiness: { enabled: true, timeout: 600 } });
  let planning = 0;
  const out = await dispatch(
    cfg,
    8,
    "ready",
    {},
    "run",
    undefined,
    undefined,
    undefined,
    {
      transition: async () => {},
      planningAdvance: async () => {
        planning++;
        return { advanced: true, from: "ready" as Stage, to: "planning" as Stage, summary: "no" };
      },
      tryAcquireLivePlanningMarker: () => true,
      evaluateIssueReadiness: async () => ({ kind: "stale-dispatch", observedStage: "planning" }),
    },
  );
  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.status, "waiting");
    assert.match(out.reason, /stale-dispatch/);
  }
  assert.equal(planning, 0);
});

test("dispatch ready: gate-unavailable is typed error", async () => {
  const cfg = makeCfg({ issue_readiness: { enabled: true, timeout: 600 } });
  const out: Outcome = await dispatch(
    cfg,
    8,
    "ready",
    {},
    "run",
    undefined,
    undefined,
    undefined,
    {
      transition: async () => {},
      planningAdvance: async () => ({ advanced: true, from: "ready" as Stage, to: "planning" as Stage, summary: "no" }),
      tryAcquireLivePlanningMarker: () => true,
      evaluateIssueReadiness: async () => ({ kind: "gate-unavailable", reason: "timeout" }),
    },
  );
  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.status, "error");
    assert.match(out.reason, /gate-unavailable/);
  }
});
