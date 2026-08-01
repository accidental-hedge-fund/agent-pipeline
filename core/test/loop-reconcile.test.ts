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
    async getLocalHead(issueNumber) {
      calls.push(`getLocalHead:${issueNumber}`);
      return null;
    },
    async baseBranchContainsSha(sha) {
      calls.push(`baseBranchContainsSha:${sha}`);
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
  return { deps, calls };
}

function openPrIdentity(overrides: Partial<LoopExternalIdentity> = {}): LoopExternalIdentity {
  return {
    issue_number: 100,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: 12,
    pr_state: "open",
    head_branch: "pipeline/100-fix",
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "success",
    // Default null stage preserves #511 crash-after-PR-open catch-up when tests
    // do not override. Mid-flight gate tests set pipeline_stage explicitly.
    pipeline_stage: null,
    observed_at: "2026-07-23T00:00:00.000Z",
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
  assert.deepEqual(calls, ["getIssueStateAndLabels:100", "findPrForIssue:100", "getPrDetail:12", "getPrChecks:12"]);
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

test("classifyDrift: a local state (implemented) is ledger-behind when a PR is already discovered (#511 review-2 regression)", () => {
  // A worker that crashed after opening (or even merging) the PR but before
  // recording implemented -> pr_opened must be repaired forward, not treated
  // as aligned — the old behavior hard-returned null for every local state.
  // Null / non-mid-flight stage preserves this catch-up; mid-flight is gated (#712).
  assert.equal(classifyDrift("implemented", openPrIdentity({ pipeline_stage: null }), null), "ledger-behind");
  assert.equal(classifyDrift("implemented", openPrIdentity({ pr_state: "merged" }), null), "ledger-behind");
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

test("computeNextAction: contradictions never invent human authority", () => {
  for (const cls of ["ledger-ahead", "external-absent", "identity-mismatch"] as const) {
    assert.equal(computeNextAction("pr_opened", openPrIdentity(), cls, false), "noop");
  }
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
  assert.equal(result.next_actions["100"], "advance");
  assert.ok(calls.length > 0);

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.reconciliation_sequence, 1);
  assert.equal(ledger.last_reconciliation?.sequence, 1);
  assert.equal(ledger.items["100"].last_verified_identity?.pr_number, 12);

  const events = ledger.run_id; // sanity: readLedger returns the same run
  assert.equal(events, "run-1");
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
  assert.equal(ledger.items["100"].state, "pr_opened");
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

test("reconcile: a crash before recording implemented -> pr_opened is repaired to the verified target, not hard-coded to merged (#511 review-2 regression)", async () => {
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
  assert.equal(result.drift[0].class, "ledger-behind");
  assert.equal(result.next_actions["100"], "repair-forward");

  const ledger = await readLedger(deps, "run-1");
  // The PR is only open (not merged) — repairing to a hard-coded "merged"
  // target would fabricate an unproven merge; the verified target is pr_opened.
  assert.equal(ledger.items["100"].state, "pr_opened");
  const last = ledger.items["100"].history.at(-1);
  assert.equal(last?.from, "implemented");
  assert.equal(last?.to, "pr_opened");
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

test("reconcile: an over-claim (ledger-ahead) is surfaced, not rewritten — state is left untouched", async () => {
  const { deps, token } = await setup("merged");
  const { deps: observeDeps } = fakeObserveDeps({
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "b", head_sha: "s", merge_commit_sha: null };
    },
  });

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0].class, "ledger-ahead");
  assert.equal(result.next_actions["100"], "noop");

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "merged", "ledger-ahead drift must never be silently rewritten");
});

test("reconcile: external-absent is surfaced without inventing human authority", async () => {
  const { deps, token } = await setup("pr_opened");
  const { deps: observeDeps } = fakeObserveDeps();

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0].class, "external-absent");
  assert.equal(result.next_actions["100"], "noop");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "pr_opened");
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
  assert.equal(result.next_actions["100"], "clear-merge-barrier");
  const after = await readLedger(deps, "run-1");
  assert.deepEqual(after.merge_barrier, { item_id: "100", merged_sha: "mergesha", set_at: "2026-07-22T00:00:00.000Z" });
});

test("reconcile: refuses to run against an already-stopped run", async () => {
  const { deps, token } = await setup("pr_opened", {}, {
    stop: { reason: "recovery_exhausted", time: "2026-07-23T00:00:00.000Z" },
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

test("reconcile: local + open PR + null stage still repairs to pr_opened (#511 compatibility)", async () => {
  const { deps, token } = await setup("implemented");
  const observeDeps = openPrObserveDeps({ stage: null });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0]?.class, "ledger-behind");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "pr_opened");
});

test("reconcile: local + open PR + ready stage still repairs to pr_opened (#511 / non-mid-flight)", async () => {
  const { deps, token } = await setup("in_progress");
  const observeDeps = openPrObserveDeps({ stage: "ready" });
  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0]?.class, "ledger-behind");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "pr_opened");
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
  assert.match(last?.note ?? "", /mid-flight/);
  // Not stranded with non-consuming advance.
  assert.notEqual(ledger.last_reconciliation?.next_actions["100"], "advance");
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
    second.items["100"].history.filter((h) => h.to === "in_progress" && (h.note ?? "").includes("mid-flight")).length,
    1,
  );
  assert.ok(second.items["100"].history.length === historyLen || second.items["100"].history.at(-1)?.to !== "pr_opened");
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
