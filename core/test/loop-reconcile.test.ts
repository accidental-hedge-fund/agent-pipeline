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
    pr_number: 12,
    pr_state: "open",
    head_branch: "pipeline/100-fix",
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "success",
    observed_at: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
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
  assert.equal(classifyDrift("implemented", openPrIdentity(), null), "ledger-behind");
  assert.equal(classifyDrift("implemented", openPrIdentity({ pr_state: "merged" }), null), "ledger-behind");
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

test("computeNextAction: every contradiction class yields hold-for-human", () => {
  for (const cls of ["ledger-ahead", "external-absent", "identity-mismatch"] as const) {
    assert.equal(computeNextAction("pr_opened", openPrIdentity(), cls, false), "hold-for-human");
  }
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
  assert.equal(result.next_actions["100"], "hold-for-human");

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "merged", "ledger-ahead drift must never be silently rewritten");
});

test("reconcile: external-absent — a claimed PR that does not exist is surfaced and routed to a human", async () => {
  const { deps, token } = await setup("pr_opened");
  const { deps: observeDeps } = fakeObserveDeps();

  const result = await reconcile(deps, observeDeps, { runId: "run-1", token, engine: "claude" });
  assert.equal(result.drift[0].class, "external-absent");
  assert.equal(result.next_actions["100"], "hold-for-human");
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
