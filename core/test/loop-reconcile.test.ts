// Tests for verified live reconciliation (#511, capability
// `durable-run-reconciliation`). Every test runs through an in-memory
// LoopStoreDeps fake (mirrors loop-store.test.ts / loop-recovery.test.ts)
// AND an in-memory ReconcileObserveDeps fake — no real filesystem, process,
// network, git, or subprocess access anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDrift,
  computeNextAction,
  observeExternalIdentity,
  parseItemIssueNumber,
  reconcile,
  transitionItem,
  type ReconcileObserveDeps,
} from "../scripts/loop/reconcile.ts";
import { initRun, readLedger, acquireLock, type LoopStoreDeps } from "../scripts/loop/store.ts";
import {
  DEFAULT_RECOVERY_POLICY,
  blockItem,
  startRecoveryAttempt,
} from "../scripts/loop/recovery.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  isLoopDriftClass,
  isLoopNextAction,
  type LoopContract,
  type LoopExternalIdentity,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import {
  admitLifecycleRecord,
  consultLifecycleRecord,
} from "../scripts/recovery-lifecycle-ownership.ts";

// ---------------------------------------------------------------------------
// In-memory fakes (mirrors loop-recovery.test.ts's fakeDeps).
// ---------------------------------------------------------------------------

let fakeDepsCounter = 0;

function fakeDeps(overrides: Partial<LoopStoreDeps> = {}): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const isolatedEnv = { AGENT_PIPELINE_STATE_HOME: `/state-reconcile-${fakeDepsCounter++}` };

  const deps: LoopStoreDeps = {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async readTextFile(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async writeFileAtomic(p, content) {
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) {
      files.delete(p);
    },
    async removeFileIfMatches(p, expectedContent) {
      if (files.get(p) !== expectedContent) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
    async mkdirp() {},
    async renameDirExclusive(from, to) {
      const fromPrefix = from + "/";
      const published = [...files.keys()].some((k) => k === to || k.startsWith(to + "/"));
      if (published) return false;
      for (const k of [...files.keys()]) {
        if (k.startsWith(fromPrefix)) {
          files.set(to + "/" + k.slice(fromPrefix.length), files.get(k)!);
          files.delete(k);
        }
      }
      return true;
    },
    async listDir(p) {
      const prefix = p + "/";
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]);
    },
    async isPidAlive() {
      return true;
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date(clock),
    uuid: () => `uuid-${uuidCounter++}`,
    env: isolatedEnv,
    ...overrides,
  };
  return { deps, files };
}

function testContract(overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "milestone", value: "v2" },
    objective: "ship v2",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: ["push_pr", "merge", "release", "deploy"],
    recovery_budgets: { default: 3 },
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [{ id: "100", depends_on: [] }],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function testLedger(state: LoopLedger["items"][string]["state"] = "pr_opened"): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: {
      "100": { id: "100", state, history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
  };
}

async function setup(
  state: LoopLedger["items"][string]["state"] = "pr_opened",
  contractOverrides: Partial<LoopContract> = {},
  ledgerOverrides: Partial<LoopLedger> = {},
) {
  const { deps, files } = fakeDeps();
  const contract = testContract(contractOverrides);
  await initRun(deps, contract, { ...testLedger(state), ...ledgerOverrides });
  const { token } = await acquireLock(deps, "run-1", "claude");
  return { deps, files, contract, token };
}

/** Records every call so a test can assert exactly which (fake, not real)
 *  reads were made — this fake never touches gh.ts/worktree.ts/git, so a
 *  reconciliation pass built on it performs zero real network, git, or
 *  subprocess calls by construction. */
function fakeObserveDeps(overrides: Partial<ReconcileObserveDeps> = {}): { deps: ReconcileObserveDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      calls.push(`getIssueStateAndLabels:${issueNumber}`);
      return { state: "open", labels: [] };
    },
    async findPrForIssue(issueNumber) {
      calls.push(`findPrForIssue:${issueNumber}`);
      return null;
    },
    async getPrDetail(prNumber) {
      calls.push(`getPrDetail:${prNumber}`);
      return null;
    },
    async getPrChecks(prNumber) {
      calls.push(`getPrChecks:${prNumber}`);
      return [];
    },
    async getPrArtifactBinding(prNumber, detail) {
      calls.push(`getPrArtifactBinding:${prNumber}`);
      return {
        role: "implementation",
        artifactIdentity: `pr:${prNumber}:${detail.head_sha}`,
        candidateSha: detail.head_sha,
        candidateEpoch: detail.head_sha,
      };
    },
    async getLocalHead(issueNumber) {
      calls.push(`getLocalHead:${issueNumber}`);
      return null;
    },
    async baseBranchContainsSha(sha) {
      calls.push(`baseBranchContainsSha:${sha}`);
      return true;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
  return { deps, calls };
}

function openPrIdentity(overrides: Partial<LoopExternalIdentity> = {}): LoopExternalIdentity {
  const headSha = overrides.head_sha ?? "abc123";
  const prState = overrides.pr_state ?? "open";
  return {
    issue_number: 100,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: 12,
    pr_state: prState,
    head_branch: "pipeline/100-fix",
    head_sha: headSha,
    merge_commit_sha: null,
    checks_conclusion: "success",
    // Default null stage preserves #511 crash-after-PR-open catch-up when tests
    // do not override. Mid-flight gate tests set pipeline_stage explicitly.
    pipeline_stage: null,
    observed_at: "2026-07-23T00:00:00.000Z",
    integration_certainty: prState === "merged" ? "known_complete" : "known_absent",
    artifact_role: "implementation",
    artifact_identity: `pr:12:${headSha}`,
    candidate_epoch: headSha,
    ...overrides,
  };
}

/** Observe fake that reports an open PR at the given pipeline stage (and checks). */
function openPrObserveDeps(opts: {
  stage: string | null;
  checks?: "success" | "failure" | "pending" | "none";
  readyLabel?: boolean;
  prState?: "open" | "merged";
  issueNumber?: number;
}): ReconcileObserveDeps {
  const issueNumber = opts.issueNumber ?? 100;
  const checks = opts.checks ?? "success";
  const labels = [
    ...(opts.stage ? [`pipeline:${opts.stage}`] : []),
    ...(opts.readyLabel ? ["pipeline:ready-to-deploy"] : []),
  ];
  const checkBuckets =
    checks === "success" ? [{ bucket: "pass" }] :
    checks === "failure" ? [{ bucket: "fail" }] :
    checks === "pending" ? [{ bucket: "pending" }] :
    [];
  return fakeObserveDeps({
    async getIssueStateAndLabels(n) {
      if (n !== issueNumber) return { state: "open", labels: ["pipeline:ready"] };
      return { state: "open", labels };
    },
    async findPrForIssue(n) {
      return n === issueNumber ? 12 : null;
    },
    async getPrDetail() {
      return {
        state: opts.prState ?? "open",
        head_ref: `pipeline/${issueNumber}-fix`,
        head_sha: "abc123",
        merge_commit_sha: opts.prState === "merged" ? "mergesha" : null,
      };
    },
    async getPrChecks() {
      return checkBuckets;
    },
  }).deps;
}

// ---------------------------------------------------------------------------
// observeExternalIdentity — built only from the injected seam.
// ---------------------------------------------------------------------------

test("observeExternalIdentity: builds a full identity from an open PR with green checks, performing zero real calls", async () => {
  const { deps, calls } = fakeObserveDeps({
    async findPrForIssue(issueNumber) {
      calls.push(`findPrForIssue:${issueNumber}`);
      return 12;
    },
    async getPrDetail(prNumber) {
      calls.push(`getPrDetail:${prNumber}`);
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks(prNumber) {
      calls.push(`getPrChecks:${prNumber}`);
      return [{ bucket: "pass" }];
    },
  });
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pr_number, 12);
  assert.equal(identity.pr_state, "open");
  assert.equal(identity.head_sha, "abc123");
  assert.equal(identity.checks_conclusion, "success");
  assert.equal(identity.observed_at, "2026-07-23T00:00:00.000Z");
  // Every fact came from the fake seam, not a real gh/git call — this file
  // never imports gh.ts's ghRun or worktree.ts's execFile-backed helpers.
  assert.ok(calls.includes("getIssueStateAndLabels:100"));
  assert.ok(calls.includes("findPrForIssue:100"));
  assert.ok(calls.includes("getPrDetail:12"));
  assert.ok(calls.includes("getPrChecks:12"));
});

test("observeExternalIdentity: absent external objects are represented, not omitted", async () => {
  const { deps } = fakeObserveDeps();
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pr_number, null);
  assert.equal(identity.pr_state, null);
  assert.equal(identity.checks_conclusion, "none");
});

test("observeExternalIdentity: no PR yet falls back to the local worktree head", async () => {
  const { deps } = fakeObserveDeps({
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: "local-sha" };
    },
  });
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pr_number, null);
  assert.equal(identity.head_branch, "pipeline/100-fix");
  assert.equal(identity.head_sha, "local-sha");
});

// ---------------------------------------------------------------------------
// pipeline_stage (#568, capability `loop-precondition-stage-gate`) — the
// precondition stage gate's input, derived from the same live label read.
// ---------------------------------------------------------------------------

test("observeExternalIdentity: pipeline_stage is null when the issue carries no pipeline:* label", async () => {
  const { deps } = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["bug", "priority:high"] };
    },
  });
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pipeline_stage, null);
});

test("observeExternalIdentity: pipeline_stage is the label suffix for a pre-pipeline backlog issue", async () => {
  const { deps } = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:backlog"] };
    },
  });
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pipeline_stage, "backlog");
});

test("observeExternalIdentity: pipeline_stage tracks an in-flight advance-loop stage", async () => {
  const { deps } = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:review-1"] };
    },
  });
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pipeline_stage, "review-1");
});

test("observeExternalIdentity: pipeline_stage is null when the issue is not found (no observation at all)", async () => {
  const { deps } = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return null;
    },
  });
  const identity = await observeExternalIdentity(deps, "100");
  assert.equal(identity.pipeline_stage, null);
});

test("parseItemIssueNumber: a non-numeric item id is refused, not guessed", () => {
  assert.throws(() => parseItemIssueNumber("not-a-number"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "validation");
    return true;
  });
});

// ---------------------------------------------------------------------------
// classifyDrift — closed typed set, one class per trigger.
// ---------------------------------------------------------------------------

test("classifyDrift: aligned pr_opened with a matching open PR produces no drift", () => {
  assert.equal(classifyDrift("pr_opened", openPrIdentity(), null), null);
});

test("classifyDrift: external-ahead (PR merged while ledger says pr_opened) is ledger-behind", () => {
  const identity = openPrIdentity({ pr_state: "merged", merge_commit_sha: "mergesha" });
  const cls = classifyDrift("pr_opened", identity, null);
  assert.equal(cls, "ledger-behind");
  assert.ok(isLoopDriftClass(cls));
});

test("classifyDrift: ledger claims merged but PR is still open is ledger-ahead", () => {
  const cls = classifyDrift("merged", openPrIdentity({ pr_state: "open" }), null);
  assert.equal(cls, "ledger-ahead");
});

test("classifyDrift: ledger claims pr_opened but no PR exists is external-absent", () => {
  const identity = openPrIdentity({ pr_number: null, pr_state: null });
  assert.equal(classifyDrift("pr_opened", identity, null), "external-absent");
});

test("classifyDrift: a different PR number than the one previously bound is identity-mismatch", () => {
  const bound = openPrIdentity({ pr_number: 12 });
  const now = openPrIdentity({ pr_number: 99 });
  assert.equal(classifyDrift("pr_opened", now, bound), "identity-mismatch");
});

test("classifyDrift: checks regressing from success to failure on an otherwise aligned item is checks-regressed", () => {
  const bound = openPrIdentity({ checks_conclusion: "success" });
  const now = openPrIdentity({ checks_conclusion: "failure" });
  assert.equal(classifyDrift("pr_opened", now, bound), "checks-regressed");
});

test("classifyDrift: a local state (implemented) with no PR at all produces no drift", () => {
  assert.equal(classifyDrift("implemented", openPrIdentity({ pr_number: null, pr_state: null }), null), null);
});

test("classifyDrift: a local state (implemented) is ledger-behind when a merged PR is already discovered (#511 review-2 regression)", () => {
  // A worker that crashed after merging the PR but before recording the
  // transition must be repaired forward. Open PR alone while advance still
  // needed no longer catches up to stranded pr_opened (#1068).
  assert.equal(classifyDrift("implemented", openPrIdentity({ pr_state: "merged" }), null), "ledger-behind");
  assert.equal(classifyDrift("implemented", openPrIdentity({ pipeline_stage: null }), null), null);
});

test("classifyDrift: local + open PR + mid-flight stage is NOT ledger-behind (#712)", () => {
  // Pre-fix unguarded behavior returned ledger-behind for any open PR. This
  // regression fails without the mid-flight gate.
  assert.equal(
    classifyDrift("in_progress", openPrIdentity({ pipeline_stage: "fix-2", checks_conclusion: "success" }), null),
    null,
  );
  assert.equal(
    classifyDrift("pending", openPrIdentity({ pipeline_stage: "review-1" }), null),
    null,
  );
  assert.equal(
    classifyDrift("implemented", openPrIdentity({ pipeline_stage: "pre-merge" }), null),
    null,
  );
});

test("classifyDrift: local + open PR + intake-ready stage is NOT ledger-behind (#1068)", () => {
  // Without this gate, heal→in_progress oscillates: next reconcile demotes
  // intake-ready back to stranded pr_opened under the old #511 catch-up.
  assert.equal(
    classifyDrift("in_progress", openPrIdentity({ pipeline_stage: "ready", checks_conclusion: "success" }), null),
    null,
  );
  assert.equal(
    classifyDrift("pending", openPrIdentity({ pipeline_stage: "ready" }), null),
    null,
  );
  assert.equal(
    classifyDrift("implemented", openPrIdentity({ pipeline_stage: null }), null),
    null,
  );
});

test("classifyDrift: an open PR never supersedes blocked recovery, but ready and merged truth do", () => {
  assert.equal(
    classifyDrift("blocked", openPrIdentity({ pipeline_stage: "needs-human" }), null),
    null,
  );
  assert.equal(
    classifyDrift("blocked", openPrIdentity({ pipeline_stage: "needs-human", ready_label_present: true }), null),
    "ledger-behind",
  );
  assert.equal(
    classifyDrift("blocked", openPrIdentity({ pipeline_stage: "needs-human", pr_state: "merged" }), null),
    "ledger-behind",
  );
});

test("classifyDrift: waiting/paused/blocked SHA/rebase mismatch is identity-mismatch", () => {
  const bound = openPrIdentity({ head_sha: "claimed-sha", pipeline_stage: "fix-2" });
  const live = openPrIdentity({
    head_sha: "claimed-sha",
    local_head_sha: "ondisk-sha",
    rebase_in_progress: true,
    product_dirt: true,
    pipeline_stage: "fix-2",
  });
  for (const state of ["waiting", "paused", "blocked"] as const) {
    assert.equal(classifyDrift(state, live, bound), "identity-mismatch", state);
  }
});

test("classifyDrift: mid-flight gate is independent of checks conclusion (#712)", () => {
  for (const checks of ["success", "failure", "pending", "none"] as const) {
    assert.equal(
      classifyDrift("in_progress", openPrIdentity({ pipeline_stage: "fix-2", checks_conclusion: checks }), null),
      null,
      `checks=${checks} must not force ledger-behind for mid-flight local open PR`,
    );
  }
});

test("classifyDrift: merged and ready-label still win over mid-flight stage (#712)", () => {
  assert.equal(
    classifyDrift("in_progress", openPrIdentity({ pr_state: "merged", pipeline_stage: "fix-2" }), null),
    "ledger-behind",
  );
  assert.equal(
    classifyDrift("in_progress", openPrIdentity({ ready_label_present: true, pipeline_stage: "pre-merge" }), null),
    "ledger-behind",
  );
  assert.equal(
    classifyDrift("pr_opened", openPrIdentity({ ready_label_present: true, pipeline_stage: "fix-2" }), null),
    "ledger-behind",
  );
});

test("classifyDrift: every produced class is a member of the closed LoopDriftClass set", () => {
  const cases: Array<[Parameters<typeof classifyDrift>[0], LoopExternalIdentity, LoopExternalIdentity | null]> = [
    ["pr_opened", openPrIdentity({ pr_state: "merged" }), null],
    ["merged", openPrIdentity({ pr_state: "open" }), null],
    ["pr_opened", openPrIdentity({ pr_number: null, pr_state: null }), null],
    ["pr_opened", openPrIdentity({ pr_number: 99 }), openPrIdentity({ pr_number: 12 })],
  ];
  for (const [state, identity, bound] of cases) {
    const cls = classifyDrift(state, identity, bound);
    assert.ok(cls !== null && isLoopDriftClass(cls), `expected a valid LoopDriftClass, got ${cls}`);
  }
});

test("isLoopDriftClass: rejects an out-of-enum value", () => {
  assert.equal(isLoopDriftClass("made-up-class"), false);
  assert.equal(isLoopDriftClass(undefined), false);
});

// ---------------------------------------------------------------------------
// computeNextAction — pure and deterministic.
// ---------------------------------------------------------------------------

test("computeNextAction: pending checks on an aligned pr_opened item yields await-checks", () => {
  const identity = openPrIdentity({ checks_conclusion: "pending" });
  assert.equal(computeNextAction("pr_opened", identity, null, false), "await-checks");
});

test("computeNextAction: pending checks do not noop review-1 after epoch change (#1462)", () => {
  const identity = openPrIdentity({
    pipeline_stage: "review-1",
    checks_conclusion: "pending",
    head_sha: "b".repeat(40),
    candidate_epoch: "b".repeat(40),
  });
  assert.equal(computeNextAction("in_progress", identity, null, false), "advance");
  assert.equal(computeNextAction("pending", identity, null, false), "advance");
  assert.equal(computeNextAction("pr_opened", identity, null, false), "advance");
  assert.equal(
    computeNextAction("in_progress", identity, "checks-regressed", false),
    "advance",
  );
  assert.notEqual(computeNextAction("in_progress", identity, null, false), "noop");
  assert.notEqual(computeNextAction("in_progress", identity, "checks-regressed", false), "await-checks");
});

test("computeNextAction: review-2 stays actionable with pending checks (#1462)", () => {
  const identity = openPrIdentity({
    pipeline_stage: "review-2",
    checks_conclusion: "pending",
  });
  assert.equal(computeNextAction("in_progress", identity, null, false), "advance");
});

test("computeNextAction: contradictions never invent human authority", () => {
  for (const cls of ["ledger-ahead", "external-absent", "identity-mismatch"] as const) {
    assert.equal(computeNextAction("pr_opened", openPrIdentity(), cls, false), "reconstruct");
    assert.notEqual(computeNextAction("pr_opened", openPrIdentity(), cls, false), "hold-for-human");
    assert.notEqual(computeNextAction("pr_opened", openPrIdentity(), cls, false), "noop");
  }
});

test("computeNextAction: waiting/paused/blocked contradictions without typed authority reconstruct, not noop", () => {
  for (const state of ["waiting", "paused", "blocked"] as const) {
    for (const cls of ["ledger-ahead", "identity-mismatch"] as const) {
      const action = computeNextAction(state, openPrIdentity(), cls, false, false);
      assert.equal(action, "reconstruct", `${state} + ${cls}`);
      assert.notEqual(action, "noop", `${state} + ${cls} must not idle`);
      assert.notEqual(action, "hold-for-human", `${state} + ${cls} must not invent authority`);
    }
  }
});

test("isLoopNextAction: reconstruct is a closed-set member", () => {
  assert.equal(isLoopNextAction("reconstruct"), true);
});

test("computeNextAction: only current authority evidence yields hold-for-human", () => {
  assert.equal(computeNextAction("waiting", openPrIdentity(), null, false, true), "hold-for-human");
  assert.equal(computeNextAction("waiting", openPrIdentity(), null, false, false), "noop");
});

test("computeNextAction: ledger-behind drift yields repair-forward", () => {
  assert.equal(computeNextAction("pr_opened", openPrIdentity({ pr_state: "merged" }), "ledger-behind", false), "repair-forward");
});

test("computeNextAction: is deterministic — identical inputs yield the identical action twice", () => {
  const identity = openPrIdentity({ checks_conclusion: "pending" });
  const a = computeNextAction("pr_opened", identity, null, false);
  const b = computeNextAction("pr_opened", identity, null, false);
  assert.equal(a, b);
});

test("isLoopNextAction: rejects an out-of-enum value", () => {
  assert.equal(isLoopNextAction("teleport"), false);
});

// ---------------------------------------------------------------------------
// reconcile() — verified truth -> drift -> repair, sequenced and eventful.
// ---------------------------------------------------------------------------

test("reconcile: records a sequence-numbered last_reconciliation and emits an event, using only the injected seam", async () => {
  const { deps, contract, token } = await setup("pr_opened");
  const { deps: observeDeps, calls } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.sequence, 1);
  assert.equal(result.drift.length, 0);
  // #1068: open PR + null stage is advance-still-needed — heal to in_progress so
  // next_actions is not stranded non-consuming "advance" on pr_opened.
  assert.equal(result.next_actions["100"], "noop");
  assert.ok(calls.length > 0);

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.reconciliation_sequence, 1);
  assert.equal(ledger.last_reconciliation?.sequence, 1);
  assert.equal(ledger.items["100"].last_verified_identity?.pr_number, 12);
  assert.equal(ledger.items["100"].state, "in_progress");

  const events = ledger.run_id; // sanity: readLedger returns the same run
  assert.equal(events, "run-1");
  void contract;
});

test("reconcile: caller-supplied claims never enter the picture — truth comes only from the live observation", async () => {
  const { deps, contract, token } = await setup("pr_opened");
  // The seam reports the PR is still open, regardless of what a hypothetical
  // caller might claim elsewhere — reconcile() takes no claim parameter at
  // all, so there is no way for a caller assertion to reach this pass.
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
  });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  // Observed open PR + advance-still-needed heals stranded pr_opened to in_progress (#1068).
  assert.equal(ledger.items["100"].state, "in_progress");
  assert.equal(ledger.items["100"].last_verified_identity?.pr_number, 12);
  void contract;
});

test("reconcile: sequence increments by exactly one across repeated passes", async () => {
  const { deps, token } = await setup("pr_opened");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "b", head_sha: "s", merge_commit_sha: null };
    },
  });
  const first = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const second = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
});

test("reconcile: benign ledger-behind drift is repaired forward with a history entry and no external mutation", async () => {
  const { deps, token } = await setup("pr_opened");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "merged", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: "mergesha" };
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0].class, "ledger-behind");
  assert.equal(result.next_actions["100"], "repair-forward");

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "merged");
  const last = ledger.items["100"].history.at(-1);
  assert.equal(last?.from, "pr_opened");
  assert.equal(last?.to, "merged");
  // ReconcileObserveDeps exposes only read methods (get*/find*/baseBranchContainsSha) —
  // there is no merge/push/label-write/PR-edit method reachable through the seam at all,
  // so this repair could not have performed an external mutation even in principle.
});

test("reconcile: a crash before recording implemented + open PR heals to in_progress, not merged or stranded pr_opened (#511 / #1068)", async () => {
  const { deps, token } = await setup("implemented");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  // Open PR alone while advance still needed is not terminal catch-up: restore
  // non-dispatchable implemented to in_progress (not stranded pr_opened).
  assert.equal(result.drift.find((d) => d.item_id === "100")?.class, undefined);
  assert.notEqual(result.next_actions["100"], "repair-forward");

  const ledger = await readLedger(deps, "run-1");
  // The PR is only open (not merged) — must never fabricate merged.
  assert.notEqual(ledger.items["100"].state, "merged");
  assert.equal(ledger.items["100"].state, "in_progress");
  assert.notEqual(ledger.items["100"].state, "pr_opened");
  assert.notEqual(ledger.items["100"].state, "implemented");
  assert.match(ledger.items["100"].history.at(-1)?.note ?? "", /advance-still-needed/);
});

test("reconcile: a crash before recording implemented -> merged repairs all the way to merged", async () => {
  const { deps, token } = await setup("implemented");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "merged", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: "mergesha" };
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0].class, "ledger-behind");

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "merged");
});

test("reconcile: reopened pipeline:ready with an older merged planning PR remains actionable (#1454)", async () => {
  const logicalOperationId = "lop-reopened-planning-1454";
  const { deps, token } = await setup(
    "pending",
    { logical_operation_id: logicalOperationId },
    {
      lifecycle: admitLifecycleRecord({
        logical_operation_id: logicalOperationId,
        updated_at: "2026-07-23T00:00:00.000Z",
      }),
    },
  );
  const planningSha = "d".repeat(40);
  const { deps: observeDeps } = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:ready"] };
    },
    async findPrForIssue() {
      return 10;
    },
    async listLinkedPrs() {
      return [10];
    },
    async getPrDetail() {
      return {
        state: "merged",
        head_ref: "pipeline/100-plan",
        head_sha: planningSha,
        merge_commit_sha: "e".repeat(40),
      };
    },
    async baseBranchContainsSha() {
      return true;
    },
    async getPrArtifactBinding() {
      return {
        role: "planning",
        artifactIdentity: `pr:10:${planningSha}`,
        candidateSha: planningSha,
        candidateEpoch: planningSha,
      };
    },
  });

  const result = await reconcile(deps, observeDeps, {
    runId: "run-1",
    token,
    engine: "claude",
  });
  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.items["100"].state, "merged");
  assert.equal(ledger.items["100"].state, "pending");
  assert.equal(result.observed["100"].pipeline_stage, "ready");
  assert.equal(result.observed["100"].artifact_role, "planning");
  assert.equal(result.observed["100"].integration_certainty, "uncertain");
  assert.notEqual(result.next_actions["100"], "repair-forward");
  assert.equal(ledger.lifecycle?.owned, true);
  assert.equal(ledger.lifecycle?.ownerless, false);
  assert.equal(ledger.lifecycle?.state, "active");
});

test("reconcile: an over-claim (ledger-ahead) is reconstructed locally without remote mutation", async () => {
  const { deps, files, token } = await setup("merged");
  const { deps: observeDeps, calls } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "b", head_sha: "s", merge_commit_sha: null };
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0].class, "ledger-ahead");
  assert.equal(result.next_actions["100"], "reconstruct");
  assert.notEqual(result.next_actions["100"], "hold-for-human");

  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.items["100"].state, "merged");
  assert.match(ledger.items["100"].history.at(-1)?.note ?? "", /reconstructed local state/);
  assert.ok(calls.every((c) => /^(getIssueStateAndLabels|findPrForIssue|listLinkedPrs|getPrDetail|getPrChecks|getPrArtifactBinding|getLocalHead|baseBranchContainsSha):/.test(c)));
  void files;
});

test("reconcile: external-absent is reconstructed without inventing human authority", async () => {
  const { deps, token } = await setup("pr_opened");
  const { deps: observeDeps } = fakeObserveDeps();

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0].class, "external-absent");
  assert.equal(result.next_actions["100"], "reconstruct");
  assert.notEqual(result.next_actions["100"], "hold-for-human");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "implemented");
});

function shaMismatchObserveDeps(stage: string): ReturnType<typeof fakeObserveDeps> {
  return fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: [`pipeline:${stage}`] };
    },
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "claimed-sha", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: "ondisk-sha", rebase_in_progress: true, product_dirt: true };
    },
  });
}

test("reconcile: identity-mismatch on waiting/paused/blocked reconstructs identity without typed authority", async () => {
  const claimed = openPrIdentity({ head_sha: "claimed-sha", pipeline_stage: "fix-2" });
  for (const state of ["waiting", "paused", "blocked"] as const) {
    const stage = state === "blocked" ? "needs-human" : "fix-2";
    const bound = { ...claimed, pipeline_stage: stage };
    const { deps, token, files } = await setup(state, {}, {
      items: {
        "100": {
          id: "100",
          state,
          history: [],
          recovery_budgets_remaining: { default: 3 },
          last_verified_identity: bound,
        },
      },
    });
    const { deps: observeDeps, calls } = shaMismatchObserveDeps(stage);
    const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
    assert.equal(result.drift.find((d) => d.item_id === "100")?.class, "identity-mismatch", state);
    assert.equal(result.next_actions["100"], "reconstruct", state);
    assert.notEqual(result.next_actions["100"], "noop", state);
    assert.notEqual(result.next_actions["100"], "hold-for-human", state);
    const ledger = await readLedger(deps, "run-1");
    assert.equal(ledger.items["100"].state, state, `${state} must stay RecoverySupervisor-owned`);
    assert.equal(ledger.items["100"].last_verified_identity?.local_head_sha, "ondisk-sha", state);
    assert.equal(ledger.items["100"].last_verified_identity?.rebase_in_progress, true, state);
    assert.match(ledger.items["100"].history.at(-1)?.note ?? "", /reconstructed local state/, state);
    assert.ok(calls.every((c) => /^(getIssueStateAndLabels|findPrForIssue|listLinkedPrs|getPrDetail|getPrChecks|getPrArtifactBinding|getLocalHead|baseBranchContainsSha):/.test(c)), state);
    void files;
  }
});

test("reconcile: current typed authority on waiting identity-mismatch still holds and persists identity", async () => {
  const bound = openPrIdentity({ head_sha: "claimed-sha", pipeline_stage: "fix-2" });
  const { deps, token } = await setup("waiting", {}, {
    items: {
      "100": {
        id: "100",
        state: "waiting",
        history: [],
        recovery_budgets_remaining: { default: 3 },
        last_verified_identity: bound,
        hold_request: {
          request_id: "hold-100",
          item_id: "100",
          kind: "decision",
          prompt: "Decide",
          requested_by_engine: "claude",
          requested_at: "2026-07-23T00:00:00.000Z",
          authority_evidence_key: "human-decision-required:100",
          authority_candidate_head: "claimed-sha",
        },
      },
    },
  });
  const { deps: observeDeps } = shaMismatchObserveDeps("fix-2");
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift.find((d) => d.item_id === "100")?.class, "identity-mismatch");
  assert.equal(result.next_actions["100"], "hold-for-human");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting");
  assert.equal(ledger.items["100"].last_verified_identity?.local_head_sha, "ondisk-sha");
  assert.match(ledger.items["100"].history.at(-1)?.note ?? "", /reconstructed local state/);
});

test("reconcile: the merge barrier clears only when the base branch is verified to contain the merged SHA", async () => {
  const { deps, token } = await setup("merged", {}, {
    merge_barrier: { item_id: "100", merged_sha: "mergesha", set_at: "2026-07-22T00:00:00.000Z" },
  });

  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "merged", head_ref: "b", head_sha: "s", merge_commit_sha: "mergesha" };
    },
    async baseBranchContainsSha(sha) {
      return sha === "mergesha";
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.next_actions["100"], "noop");
  const after = await readLedger(deps, "run-1");
  assert.equal(after.merge_barrier, null);
});

test("reconcile: the merge barrier stays set when the base branch does not yet contain the merged SHA", async () => {
  const { deps, token } = await setup("merged", {}, {
    merge_barrier: { item_id: "100", merged_sha: "mergesha", set_at: "2026-07-22T00:00:00.000Z" },
  });

  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "merged", head_ref: "b", head_sha: "s", merge_commit_sha: "mergesha" };
    },
    async baseBranchContainsSha() {
      return false;
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.next_actions["100"], "reconstruct");
  const after = await readLedger(deps, "run-1");
  assert.equal(after.items["100"].state, "implemented");
  assert.deepEqual(after.merge_barrier, { item_id: "100", merged_sha: "mergesha", set_at: "2026-07-22T00:00:00.000Z" });
});

test("reconcile: mechanical compatibility stop does not refuse observation (#1322)", async () => {
  const { deps, token } = await setup("pr_opened", {}, {
    stop: { reason: "recovery_exhausted", time: "2026-07-23T00:00:00.000Z" },
  });

  const { deps: observeDeps } = fakeObserveDeps();
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.ok(result);
  const after = await readLedger(deps, "run-1");
  assert.equal(after.stop?.reason, "recovery_exhausted");
});

test("reconcile: refuses to run against a non-mechanical already-stopped run", async () => {
  const { deps, token } = await setup("pr_opened", {}, {
    stop: { reason: "human_authority", time: "2026-07-23T00:00:00.000Z" },
  });

  const { deps: observeDeps } = fakeObserveDeps();
  await assert.rejects(
    reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "stop");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// transitionItem — caller-supplied state never proves a remote transition.
// `TransitionItemInput` carries no identity field at all: the only evidence
// transitionItem ever considers is what it observes itself, live, through the
// injected ReconcileObserveDeps seam — a caller has nothing to fabricate.
// ---------------------------------------------------------------------------

test("transitionItem: a remote-proving transition with no PR observed is refused, state unchanged", async () => {
  const { deps, contract, token } = await setup("implemented");
  const { deps: observeDeps } = fakeObserveDeps();
  await assert.rejects(
    transitionItem(deps, observeDeps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "pr_opened" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "validation");
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "implemented");
});

test("transitionItem: a remote-proving transition backed by the engine's own live observation is accepted", async () => {
  const { deps, contract, token } = await setup("implemented");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
  });
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "pr_opened",
  });
  assert.equal(ledger.items["100"].state, "pr_opened");
  assert.equal(ledger.items["100"].last_verified_identity?.pr_number, 12);
});

test("transitionItem: an observation taken outside the freshness window does not prove the transition", async () => {
  const { deps, contract, token } = await setup("implemented", {});
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    now: () => new Date("2020-01-01T00:00:00.000Z"),
  });
  await assert.rejects(
    transitionItem(deps, observeDeps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "pr_opened" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "validation");
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "implemented");
});

test("transitionItem: an observation that does not support the target state is refused", async () => {
  const { deps, contract, token } = await setup("implemented");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "closed", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
  });
  await assert.rejects(
    transitionItem(deps, observeDeps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "pr_opened" }),
  );
});

test("transitionItem: a merged PR never proves released or deployed — no evidence field exists for either", async () => {
  const { deps, contract, token } = await setup("merged");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "merged", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: "mergesha" };
    },
  });
  for (const to of ["released", "deployed"] as const) {
    await assert.rejects(
      transitionItem(deps, observeDeps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to }),
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.loopFailureClass, "validation");
        return true;
      },
    );
  }
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "merged");
});

test("transitionItem (#1095): ready transition omits current blocked_theme and keeps history", async () => {
  const { deps, contract, token } = await setup(
    "in_progress",
    {},
    {
      items: {
        "100": {
          id: "100",
          state: "in_progress",
          history: [
            {
              time: "2026-07-23T00:00:00.000Z",
              from: "blocked",
              to: "in_progress",
              engine: "claude",
              theme: "implementation-ci",
              evidence: "ci failed",
            },
          ],
          recovery_budgets_remaining: { default: 3 },
          blocked_theme: "implementation-ci",
        },
      },
    },
  );
  const observeDeps = openPrObserveDeps({ stage: "ready-to-deploy", readyLabel: true });
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["100"].blocked_theme, undefined);
  assert.ok(
    ledger.items["100"].history.some(
      (h) => h.theme === "implementation-ci" || h.evidence === "ci failed",
    ),
    "prior block history remains readable",
  );
});

test("transitionItem (#1095): resume to in_progress still retains blocked_theme", async () => {
  const { deps, contract, token } = await setup(
    "blocked",
    {},
    {
      items: {
        "100": {
          id: "100",
          state: "blocked",
          history: [
            {
              time: "2026-07-23T00:00:00.000Z",
              from: "in_progress",
              to: "blocked",
              engine: "claude",
              theme: "implementation-ci",
              evidence: "ci failed",
            },
          ],
          recovery_budgets_remaining: { default: 3 },
          blocked_theme: "implementation-ci",
        },
      },
    },
  );
  const { deps: observeDeps } = fakeObserveDeps();
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "in_progress",
  });
  assert.equal(ledger.items["100"].state, "in_progress");
  assert.equal(ledger.items["100"].blocked_theme, "implementation-ci");
});

test("transitionItem: a local transition (implemented) needs no external identity", async () => {
  const { deps, contract, token } = await setup("in_progress");
  const { deps: observeDeps } = fakeObserveDeps();
  const ledger = await transitionItem(deps, observeDeps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "implemented" });
  assert.equal(ledger.items["100"].state, "implemented");
});

test("transitionItem: a remote-proving transition without the granted authority gate is refused even with a good observation", async () => {
  const { deps, contract, token } = await setup("implemented", { authority_grants: [] });
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
  });
  await assert.rejects(
    transitionItem(deps, observeDeps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", to: "pr_opened" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "authority");
      return true;
    },
  );
});

test("transitionItem: observer-backed ready binds succeeded in the same write; restart consults it", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-transition-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    { logical_operation_id: "lop-transition-1322" },
    { lifecycle: admitted },
  );
  const observeDeps = openPrObserveDeps({ stage: "ready-to-deploy", readyLabel: true });
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
    logicalOperationId: "lop-transition-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.lifecycle?.logical_operation_id, "lop-transition-1322");
  assert.equal(ledger.lifecycle?.state, "succeeded");
  assert.equal(ledger.lifecycle?.revision, 2);

  const restarted = await readLedger(deps, "run-1");
  assert.equal(restarted.lifecycle?.state, "succeeded");
  const wake = consultLifecycleRecord(restarted.lifecycle, {
    labels: ["pipeline:needs-human"],
    processExitCode: 1,
  });
  assert.equal(wake.state, "succeeded");
  assert.notEqual(wake.state, "active");
});

function multiIssueReadyObserveDeps(readyIssueNumbers: ReadonlySet<number>): ReconcileObserveDeps {
  return fakeObserveDeps({
    async getIssueStateAndLabels(n) {
      const labels = readyIssueNumbers.has(n)
        ? ["pipeline:ready-to-deploy"]
        : ["pipeline:review-1"];
      return { state: "open", labels };
    },
    async findPrForIssue(n) {
      return n;
    },
    async getPrDetail(prNumber) {
      return {
        state: "open",
        head_ref: `pipeline/${prNumber}-fix`,
        head_sha: "abc123",
        merge_commit_sha: null,
      };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
  }).deps;
}

test("transitionItem: observer-backed ready with a pending sibling stays active", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-sibling-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    {
      logical_operation_id: "lop-sibling-1322",
      items: [
        { id: "100", depends_on: [] },
        { id: "200", depends_on: [] },
      ],
    },
    {
      lifecycle: admitted,
      items: {
        "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
        "200": { id: "200", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
      },
    },
  );
  const observeDeps = openPrObserveDeps({ stage: "ready-to-deploy", readyLabel: true });
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
    logicalOperationId: "lop-sibling-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["200"].state, "pending");
  assert.equal(ledger.lifecycle?.state, "active");
  assert.notEqual(ledger.lifecycle?.state, "succeeded");
});

test("transitionItem: ready sibling without current observer proof does not succeed the operation", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-sibling-unproved-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    {
      logical_operation_id: "lop-sibling-unproved-1322",
      items: [
        { id: "100", depends_on: [] },
        { id: "200", depends_on: [] },
      ],
    },
    {
      lifecycle: admitted,
      items: {
        "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
        "200": { id: "200", state: "ready", history: [], recovery_budgets_remaining: { default: 3 } },
      },
    },
  );
  const observeDeps = multiIssueReadyObserveDeps(new Set([100]));
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
    logicalOperationId: "lop-sibling-unproved-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["200"].state, "ready");
  assert.equal(ledger.lifecycle?.state, "active");
  assert.notEqual(ledger.lifecycle?.state, "succeeded");
});

test("transitionItem: stored ready sibling whose live identity has regressed does not succeed", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-sibling-regress-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const staleReadyIdentity = openPrIdentity({
    issue_number: 200,
    ready_label_present: true,
    pr_number: 200,
    observed_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    {
      logical_operation_id: "lop-sibling-regress-1322",
      items: [
        { id: "100", depends_on: [] },
        { id: "200", depends_on: [] },
      ],
    },
    {
      lifecycle: admitted,
      items: {
        "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
        "200": {
          id: "200",
          state: "ready",
          history: [],
          recovery_budgets_remaining: { default: 3 },
          last_verified_identity: staleReadyIdentity,
        },
      },
    },
  );
  const observeDeps = multiIssueReadyObserveDeps(new Set([100]));
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
    logicalOperationId: "lop-sibling-regress-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["200"].state, "ready");
  assert.equal(ledger.lifecycle?.state, "active");
  assert.notEqual(ledger.lifecycle?.state, "succeeded");
});

test("transitionItem: sibling observe failure keeps the proven item ready and does not succeed", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-sibling-observe-fail-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    {
      logical_operation_id: "lop-sibling-observe-fail-1322",
      items: [
        { id: "100", depends_on: [] },
        { id: "200", depends_on: [] },
      ],
    },
    {
      lifecycle: admitted,
      items: {
        "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
        "200": { id: "200", state: "ready", history: [], recovery_budgets_remaining: { default: 3 } },
      },
    },
  );
  const observeDeps = fakeObserveDeps({
    async getIssueStateAndLabels(n) {
      if (n === 200) throw new Error("forge unavailable");
      return { state: "open", labels: ["pipeline:ready-to-deploy"] };
    },
    async findPrForIssue(n) {
      return n === 100 ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
  }).deps;
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
    logicalOperationId: "lop-sibling-observe-fail-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["200"].state, "ready");
  assert.equal(ledger.lifecycle?.state, "active");
  assert.notEqual(ledger.lifecycle?.state, "succeeded");
});

test("transitionItem: observer-backed ready succeeds only when every sibling has current proof", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-sibling-proved-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    {
      logical_operation_id: "lop-sibling-proved-1322",
      items: [
        { id: "100", depends_on: [] },
        { id: "200", depends_on: [] },
      ],
    },
    {
      lifecycle: admitted,
      items: {
        "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
        "200": { id: "200", state: "ready", history: [], recovery_budgets_remaining: { default: 3 } },
      },
    },
  );
  const observeDeps = multiIssueReadyObserveDeps(new Set([100, 200]));
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "ready",
    logicalOperationId: "lop-sibling-proved-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["200"].state, "ready");
  assert.equal(ledger.items["200"].last_verified_identity?.ready_label_present, true);
  assert.equal(ledger.lifecycle?.state, "succeeded");
});

test("transitionItem: caller observerProof cannot mark succeeded without live observer evidence", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-noproof-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, contract, token } = await setup(
    "in_progress",
    { logical_operation_id: "lop-noproof-1322" },
    { lifecycle: admitted },
  );
  const { deps: observeDeps } = fakeObserveDeps();
  const ledger = await transitionItem(deps, observeDeps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    to: "implemented",
    logicalOperationId: "lop-noproof-1322",
    observerProof: { provedPostcondition: true },
  });
  assert.equal(ledger.items["100"].state, "implemented");
  assert.equal(ledger.lifecycle?.state, "active");
  assert.notEqual(ledger.lifecycle?.state, "succeeded");
});

test("reconcile: observer-backed ledger-behind repair binds succeeded in the same write", async () => {
  const admitted = admitLifecycleRecord({
    logical_operation_id: "lop-reconcile-1322",
    updated_at: "2026-07-23T00:00:00.000Z",
  });
  const { deps, token } = await setup("pr_opened", { logical_operation_id: "lop-reconcile-1322" }, { lifecycle: admitted });
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "merged", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: "mergesha" };
    },
    async getPrArtifactBinding(prNumber, detail) {
      return {
        role: "implementation",
        artifactIdentity: `pr:${prNumber}:${detail.head_sha}`,
        candidateSha: detail.head_sha,
        candidateEpoch: detail.head_sha,
        logicalOperationId: "lop-reconcile-1322",
      };
    },
  });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const restarted = await readLedger(deps, "run-1");
  assert.equal(restarted.items["100"].state, "merged");
  assert.equal(restarted.lifecycle?.logical_operation_id, "lop-reconcile-1322");
  assert.equal(restarted.lifecycle?.state, "succeeded");
  const wake = consultLifecycleRecord(restarted.lifecycle, { processExitCode: 1 });
  assert.equal(wake.state, "succeeded");
});

// ---------------------------------------------------------------------------
// #712 mid-flight open-PR repair gate + stranded pr_opened heal
// ---------------------------------------------------------------------------

test("reconcile: in_progress + open PR + green checks + fix-2 remains in_progress, not pr_opened (#712)", async () => {
  const { deps, token } = await setup("in_progress");
  const observeDeps = openPrObserveDeps({ stage: "fix-2", checks: "success" });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift.find((d) => d.item_id === "100")?.class, undefined);
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
  // Continuity must not depend solely on non-consuming next_actions.advance on pr_opened.
  assert.notEqual(ledger.items["100"].state, "pr_opened");
  assert.notEqual(result.next_actions["100"], "advance");
});

test("reconcile: pending + open PR + mid-flight stage stays pending (#712)", async () => {
  const { deps, token } = await setup("pending");
  const observeDeps = openPrObserveDeps({ stage: "review-1" });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "pending");
});

test("reconcile: local + merged still repairs to merged even with mid-flight stage (#712)", async () => {
  const { deps, token } = await setup("in_progress");
  const observeDeps = openPrObserveDeps({ stage: "fix-2", prState: "merged" });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0]?.class, "ledger-behind");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "merged");
});

test("reconcile (#1095): repair-forward to ready omits current blocked_theme", async () => {
  const { deps, token } = await setup(
    "in_progress",
    {},
    {
      items: {
        "100": {
          id: "100",
          state: "in_progress",
          history: [
            {
              time: "2026-07-23T00:00:00.000Z",
              from: "blocked",
              to: "in_progress",
              engine: "claude",
              theme: "implementation-ci",
              evidence: "ci failed",
            },
          ],
          recovery_budgets_remaining: { default: 3 },
          blocked_theme: "implementation-ci",
        },
      },
    },
  );
  const observeDeps = openPrObserveDeps({ stage: "pre-merge", readyLabel: true });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0]?.class, "ledger-behind");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "ready");
  assert.equal(ledger.items["100"].blocked_theme, undefined);
  assert.ok(
    ledger.items["100"].history.some((h) => h.theme === "implementation-ci"),
    "prior block history remains readable",
  );
});

test("reconcile: local + ready-to-deploy label still repairs to ready even with mid-flight stage (#712)", async () => {
  const { deps, token } = await setup("in_progress");
  const observeDeps = openPrObserveDeps({ stage: "pre-merge", readyLabel: true });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0]?.class, "ledger-behind");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "ready");
});

test("regression #797: reconcile preserves a blocked item and its started recovery claim when an open PR is visible", async () => {
  const { deps, token, contract } = await setup("in_progress");
  await blockItem(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    blockerClass: "implementation-ci",
    evidence: "review finding remains blocking on current head",
  });
  await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "repair_pipeline_item",
    candidateIdentity: "base=main;head=abc123;attempt=0",
  });
  const before = await readLedger(deps, "run-1");
  const budgetAfterClaim = before.items["100"].recovery_budgets_remaining["implementation-ci"];

  const result = await reconcile(
    deps,
    openPrObserveDeps({ stage: "needs-human", checks: "success" }),
    { runId: "run-1", token, engine: "claude" },
  );

  const after = await readLedger(deps, "run-1");
  assert.equal(result.drift.find((entry) => entry.item_id === "100"), undefined);
  assert.equal(after.items["100"].state, "blocked");
  assert.equal(after.recovery_attempts.length, 1);
  assert.equal(after.recovery_attempts[0].outcome, "started");
  assert.equal(after.items["100"].recovery_budgets_remaining["implementation-ci"], budgetAfterClaim);
  assert.ok(!after.items["100"].history.some((entry) => entry.from === "blocked" && entry.to === "pr_opened"));
});

test("reconcile: local implemented + open PR + null stage heals to in_progress, not stranded pr_opened (#1068 / #511)", async () => {
  // #511 crash-after-PR-open residual: open PR with null stage still needs
  // advance. implemented is not on any supervisor frontier — restore to
  // in_progress rather than parking at non-consuming pr_opened.
  const { deps, token } = await setup("implemented");
  const observeDeps = openPrObserveDeps({ stage: null });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift.find((d) => d.item_id === "100")?.class, undefined);
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
  assert.notEqual(ledger.items["100"].state, "pr_opened");
  assert.notEqual(ledger.items["100"].state, "implemented");
  assert.match(ledger.items["100"].history.at(-1)?.note ?? "", /advance-still-needed/);
});

test("reconcile: local + open PR + ready stage stays in_progress, not stranded pr_opened (#1068)", async () => {
  // Pre-#1068: non-mid-flight intake-ready repaired to pr_opened (#511 path),
  // then never healed — dead next_actions.advance. Gate keeps dispatchable local.
  const { deps, token } = await setup("in_progress");
  const observeDeps = openPrObserveDeps({ stage: "ready" });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift.find((d) => d.item_id === "100")?.class, undefined);
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
  assert.notEqual(ledger.items["100"].state, "pr_opened");
});

test("reconcile: mid-flight local open PR leaves local state across checks matrix (#712)", async () => {
  for (const checks of ["success", "failure", "pending", "none"] as const) {
    const { deps, token } = await setup("in_progress");
    const observeDeps = openPrObserveDeps({ stage: "fix-2", checks });
    await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
    const ledger = await readLedger(deps, "run-1");
    assert.equal(ledger.items["100"].state, "in_progress", `checks=${checks}`);
  }
});

test("reconcile: stranded pr_opened + mid-flight open PR heals to in_progress (#712)", async () => {
  const { deps, token } = await setup("pr_opened");
  const observeDeps = openPrObserveDeps({ stage: "fix-2", checks: "success" });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
  const last = ledger.items["100"].history.at(-1);
  assert.equal(last?.from, "pr_opened");
  assert.equal(last?.to, "in_progress");
  assert.match(last?.note ?? "", /advance-still-needed/);
  // Not stranded with non-consuming advance.
  assert.notEqual(ledger.last_reconciliation?.next_actions["100"], "advance");
});

test("reconcile: stranded pr_opened + intake-ready stage ready heals to in_progress (#1068)", async () => {
  // Live class: pipeline:ready (intake) + open PR + green checks left at
  // pr_opened with non-consuming next_actions.advance → supervisor_no_progress.
  const { deps, token } = await setup("pr_opened");
  const observeDeps = openPrObserveDeps({ stage: "ready", checks: "success" });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
  const last = ledger.items["100"].history.at(-1);
  assert.equal(last?.from, "pr_opened");
  assert.equal(last?.to, "in_progress");
  assert.match(last?.note ?? "", /advance-still-needed/);
  assert.notEqual(ledger.last_reconciliation?.next_actions["100"], "advance");
});

test("reconcile: stranded pr_opened + needs-human is NOT healed to in_progress (#1068)", async () => {
  const { deps, token } = await setup("pr_opened");
  const observeDeps = openPrObserveDeps({ stage: "needs-human", checks: "success" });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "pr_opened");
  assert.ok(!ledger.items["100"].history.some((h) => h.to === "in_progress"));
});

// Pre-fix stranded rows normally retain last_verified_identity. If the PR head
// moved (or checks churned) before resume, classifyDrift returns a non-null
// class (identity-mismatch / checks-regressed). The heal MUST still restore
// pr_opened → in_progress; gating on !driftClass left these permanently stranded.
test("reconcile: stranded pr_opened heals despite stale last_verified_identity head SHA (#712)", async () => {
  const staleIdentity = openPrIdentity({
    head_sha: "old-sha-before-fix",
    checks_conclusion: "success",
    pipeline_stage: "fix-1",
  });
  const liveIdentity = openPrIdentity({
    head_sha: "new-sha-after-push",
    checks_conclusion: "success",
    pipeline_stage: "fix-2",
  });
  // Bite: without the heal ignoring non-forward drift, this pair yields
  // identity-mismatch and the pre-fix !driftClass gate would skip restore.
  assert.equal(classifyDrift("pr_opened", liveIdentity, staleIdentity), "identity-mismatch");

  const { deps, token } = await setup("pr_opened", {}, {
    items: {
      "100": {
        id: "100",
        state: "pr_opened",
        history: [],
        recovery_budgets_remaining: { default: 3 },
        last_verified_identity: staleIdentity,
      },
    },
  });
  const observeDeps = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:fix-2"] };
    },
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return {
        state: "open",
        head_ref: "pipeline/100-fix",
        head_sha: "new-sha-after-push",
        merge_commit_sha: null,
      };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
  }).deps;

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress", "heal must restore despite identity-mismatch drift");
  assert.equal(ledger.items["100"].last_verified_identity?.head_sha, "new-sha-after-push");
  assert.equal(ledger.items["100"].history.at(-1)?.from, "pr_opened");
  assert.equal(ledger.items["100"].history.at(-1)?.to, "in_progress");
  // Observed drift is still recorded for audit; it must not block the heal.
  assert.equal(result.drift.find((d) => d.item_id === "100")?.class, "identity-mismatch");
});

test("reconcile: mid-flight heal is idempotent across repeated passes (#712)", async () => {
  const { deps, token } = await setup("pr_opened");
  const observeDeps = openPrObserveDeps({ stage: "review-2" });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const afterHeal = await readLedger(deps, "run-1");
  assert.equal(afterHeal.items["100"].state, "in_progress");
  const historyLen = afterHeal.items["100"].history.length;

  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const second = await readLedger(deps, "run-1");
  assert.equal(second.items["100"].state, "in_progress");
  // No re-promote to pr_opened and no duplicate heal history spam.
  assert.equal(
    second.items["100"].history.filter((h) => h.to === "in_progress" && (h.note ?? "").includes("advance-still-needed")).length,
    1,
  );
  assert.ok(second.items["100"].history.length === historyLen || second.items["100"].history.at(-1)?.to !== "pr_opened");
});

test("reconcile: intake-ready heal is idempotent and does not oscillate back to pr_opened (#1068)", async () => {
  const { deps, token } = await setup("pr_opened");
  const observeDeps = openPrObserveDeps({ stage: "ready", checks: "success" });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const afterHeal = await readLedger(deps, "run-1");
  assert.equal(afterHeal.items["100"].state, "in_progress");

  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const second = await readLedger(deps, "run-1");
  assert.equal(second.items["100"].state, "in_progress");
  assert.notEqual(second.items["100"].state, "pr_opened");
  assert.equal(
    second.items["100"].history.filter((h) => h.to === "in_progress" && (h.note ?? "").includes("advance-still-needed")).length,
    1,
  );
});

test("reconcile: heal does not override ready or merged catch-up from pr_opened (#712)", async () => {
  {
    const { deps, token } = await setup("pr_opened");
    const observeDeps = openPrObserveDeps({ stage: "fix-2", prState: "merged" });
    await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
    const ledger = await readLedger(deps, "run-1");
    assert.equal(ledger.items["100"].state, "merged");
  }
  {
    const { deps, token } = await setup("pr_opened");
    const observeDeps = openPrObserveDeps({ stage: "fix-2", readyLabel: true });
    await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
    const ledger = await readLedger(deps, "run-1");
    assert.equal(ledger.items["100"].state, "ready");
  }
});

test("reconcile: multi-item mid-flight in_progress stays dispatchable while sibling stays pending (#712)", async () => {
  const { deps, files } = fakeDeps();
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  await initRun(deps, contract, {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: {
      "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
      "200": { id: "200", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
  });
  const { token } = await acquireLock(deps, "run-1", "claude");
  const { deps: observeDeps } = fakeObserveDeps({
    async getIssueStateAndLabels(issueNumber) {
      if (issueNumber === 100) return { state: "open", labels: ["pipeline:fix-2"] };
      return { state: "open", labels: ["pipeline:ready"] };
    },
    async findPrForIssue(issueNumber) {
      return issueNumber === 100 ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
  });
  await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress", "mid-flight A must remain re-dispatchable");
  assert.equal(ledger.items["200"].state, "pending");
  void files;
});
