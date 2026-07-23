// Verified live reconciliation (#511, capability `durable-run-reconciliation`).
//
// Supersedes the #508 shortcut where reconciliation accepted an
// observed-truth document supplied by the caller and never resolved drift.
// This module reads live GitHub / git / checks truth itself through an
// engine-owned observation seam (`ReconcileObserveDeps`), binds each item to
// a structured `LoopExternalIdentity`, classifies drift into a closed typed
// set, repairs only benign forward catch-up drift, and computes a pure
// deterministic next action per item. A caller-supplied claim can never
// substitute for this seam's live read — see `transitionItem`'s
// remote-proving-transition guard below.
//
// See openspec/changes/durable-run-reconciliation/design.md for the
// decisions this module implements. Every mutating operation goes through
// loop/store.ts's injected LoopStoreDeps seam; every live read goes through
// the injected ReconcileObserveDeps seam — no real filesystem, process,
// network, or subprocess access in unit tests.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LABEL_PREFIX, type PipelineConfig } from "../types.ts";
import {
  getIssueStateAndLabels,
  getPrChecks,
  getPrDetail,
  getPrForIssueAnyState,
  parseChecksAggregate,
} from "../gh.ts";
import { getOnDiskForIssue, gitInWorktree } from "../worktree.ts";
import {
  LoopError,
  isLoopAuthorityGate,
  isLoopDriftClass,
  type LoopAuthorityGate,
  type LoopContract,
  type LoopDrift,
  type LoopDriftClass,
  type LoopEngineName,
  type LoopExternalIdentity,
  type LoopItemLedgerEntry,
  type LoopItemState,
  type LoopLedger,
  type LoopNextAction,
  type LoopReconciliation,
} from "./types.ts";
import { appendEvent, readLedger, writeLedger, type LoopStoreDeps } from "./store.ts";
import { authorizeGatedTransition, NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS } from "./pause.ts";

const execFileAsync = promisify(execFile);

const READY_LABEL = `${LABEL_PREFIX}ready-to-deploy`;

/** States a transition can only enter with a fresh verified {@link LoopExternalIdentity}
 *  behind it — a caller-supplied claim never proves these (#511 core invariant). */
export const REMOTE_PROVING_STATES: ReadonlySet<LoopItemState> = new Set([
  "pr_opened",
  "ready",
  "merged",
  "released",
  "deployed",
]);

// ---------------------------------------------------------------------------
// Live observation seam.
// ---------------------------------------------------------------------------

/** Engine-owned live observation seam (#511). Wraps the existing typed `gh`
 *  wrappers plus a local git head read. Unit tests inject a fake — the pass
 *  performs zero real network, git, or subprocess calls under test; the
 *  *provenance* guarantee ("verified", not caller-claimed) comes from this
 *  seam being engine-owned, never a parameter a caller can substitute a
 *  claim into. */
export interface ReconcileObserveDeps {
  getIssueStateAndLabels(issueNumber: number): Promise<{ state: "open" | "closed"; labels: string[] } | null>;
  findPrForIssue(issueNumber: number): Promise<number | null>;
  getPrDetail(prNumber: number): Promise<{
    state: "open" | "closed" | "merged";
    head_ref: string;
    head_sha: string;
    merge_commit_sha: string | null;
  } | null>;
  getPrChecks(prNumber: number): Promise<{ bucket: string }[]>;
  /** Local worktree fallback used only when no PR exists yet — reads the
   *  on-disk branch/head for the issue with zero GitHub calls. */
  getLocalHead(issueNumber: number): Promise<{ branch: string; sha: string } | null>;
  /** True when `sha` is an ancestor of the base branch's current remote head
   *  — the evidence the merge-barrier requirement (durable-loop-engine) needs
   *  to clear a barrier. Returns null when the base branch head cannot be
   *  determined (e.g. remote unreachable) — treated as "not yet proven". */
  baseBranchContainsSha(sha: string): Promise<boolean | null>;
  now(): Date;
}

/** Real implementation of {@link ReconcileObserveDeps} — the only sanctioned
 *  production seam, mirroring `defaultLoopStoreDeps` (loop/store.ts). */
export function defaultReconcileObserveDeps(cfg: PipelineConfig): ReconcileObserveDeps {
  return {
    async getIssueStateAndLabels(issueNumber) {
      return getIssueStateAndLabels(cfg, issueNumber);
    },
    async findPrForIssue(issueNumber) {
      return getPrForIssueAnyState(cfg, issueNumber);
    },
    async getPrDetail(prNumber) {
      try {
        const detail = await getPrDetail(cfg, prNumber);
        return {
          state: detail.state,
          head_ref: detail.head_ref,
          head_sha: detail.head_sha,
          merge_commit_sha: detail.merge_commit_sha,
        };
      } catch {
        return null;
      }
    },
    async getPrChecks(prNumber) {
      try {
        return await getPrChecks(cfg, prNumber);
      } catch {
        return [];
      }
    },
    async getLocalHead(issueNumber) {
      const wt = await getOnDiskForIssue(cfg, issueNumber);
      if (!wt) return null;
      try {
        const [branchOut, shaOut] = await Promise.all([
          gitInWorktree(wt.path, ["branch", "--show-current"]),
          gitInWorktree(wt.path, ["rev-parse", "HEAD"]),
        ]);
        const branch = branchOut.stdout.trim();
        const sha = shaOut.stdout.trim();
        return branch && sha ? { branch, sha } : null;
      } catch {
        return null;
      }
    },
    async baseBranchContainsSha(sha) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["rev-parse", `origin/${cfg.base_branch}`],
          { cwd: cfg.repo_dir, timeout: 30_000 },
        );
        const baseHead = stdout.trim();
        if (!baseHead) return null;
        await execFileAsync(
          "git",
          ["merge-base", "--is-ancestor", sha, baseHead],
          { cwd: cfg.repo_dir, timeout: 30_000 },
        );
        return true; // exit 0 => is-ancestor
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 1) return false; // exit 1 => not-an-ancestor (well-formed answer)
        return null; // any other failure (bad ref, no remote, timeout) — not yet provable
      }
    },
    now: () => new Date(),
  };
}

/** Derives the aggregate `checks_conclusion` from raw check runs, reusing the
 *  same bucket semantics as `parseChecksAggregate` (gh.ts) rather than
 *  re-deriving pass/fail/pending logic. */
export function deriveChecksConclusion(checks: { bucket: string }[]): LoopExternalIdentity["checks_conclusion"] {
  if (checks.length === 0) return "none";
  const { passed, pending, failed } = parseChecksAggregate(checks as { name: string; bucket: string; state: string; description?: string; link?: string }[]);
  if (failed.length > 0) return "failure";
  if (pending) return "pending";
  return passed ? "success" : "pending";
}

/** An item id is the issue number as a bare string (established convention —
 *  see loop-recovery.test.ts fixtures). Refuses a non-numeric id rather than
 *  guessing. */
export function parseItemIssueNumber(itemId: string): number {
  const n = Number(itemId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new LoopError("validation", `item id "${itemId}" is not a valid issue number — reconciliation cannot observe it`);
  }
  return n;
}

/** Builds one item's verified live identity from the injected seam only. */
export async function observeExternalIdentity(deps: ReconcileObserveDeps, itemId: string): Promise<LoopExternalIdentity> {
  const issueNumber = parseItemIssueNumber(itemId);
  const issue = await deps.getIssueStateAndLabels(issueNumber);
  const issue_open = issue?.state === "open";
  const ready_label_present = issue?.labels.includes(READY_LABEL) ?? false;

  let pr_number: number | null = null;
  let pr_state: LoopExternalIdentity["pr_state"] = null;
  let head_branch = "";
  let head_sha = "";
  let merge_commit_sha: string | null = null;
  let checks_conclusion: LoopExternalIdentity["checks_conclusion"] = "none";

  const foundPrNumber = await deps.findPrForIssue(issueNumber);
  if (foundPrNumber !== null) {
    const detail = await deps.getPrDetail(foundPrNumber);
    if (detail) {
      pr_number = foundPrNumber;
      pr_state = detail.state;
      head_branch = detail.head_ref;
      head_sha = detail.head_sha;
      merge_commit_sha = detail.merge_commit_sha;
      const checks = await deps.getPrChecks(foundPrNumber);
      checks_conclusion = deriveChecksConclusion(checks);
    }
  }

  if (!head_branch) {
    const local = await deps.getLocalHead(issueNumber);
    if (local) {
      head_branch = local.branch;
      head_sha = local.sha;
    }
  }

  return {
    issue_number: issueNumber,
    issue_open,
    ready_label_present,
    pr_number,
    pr_state,
    head_branch,
    head_sha,
    merge_commit_sha,
    checks_conclusion,
    observed_at: deps.now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Drift classification — closed typed set, forward-only repair.
// ---------------------------------------------------------------------------

function checksRegressed(bound: LoopExternalIdentity | null, identity: LoopExternalIdentity): boolean {
  return !!bound && bound.checks_conclusion === "success" && (identity.checks_conclusion === "failure" || identity.checks_conclusion === "pending");
}

/** The furthest {@link LoopItemState} the verified `identity` alone supports —
 *  `null` when no PR exists yet. `LoopExternalIdentity` carries no
 *  release/deployment evidence, so `merged` is the furthest derivable target
 *  (mirrors `identitySupportsState`'s `released`/`deployed` refusal below). */
function verifiedForwardTarget(identity: LoopExternalIdentity): LoopItemState | null {
  if (identity.pr_state === "merged") return "merged";
  if (identity.pr_number !== null && identity.pr_state === "open") {
    return identity.ready_label_present ? "ready" : "pr_opened";
  }
  return null;
}

/** Classifies the disagreement (if any) between `state` and the freshly
 *  observed `identity`, using `bound` — the item's last verified identity, if
 *  any — to detect an object-identity change (`identity-mismatch`). Returns
 *  null when the item is aligned. Pure; a drift with no/invalid class is
 *  unconstructable since this is the only producer of {@link LoopDriftClass}
 *  values and every branch returns a literal from the closed set. */
export function classifyDrift(
  state: LoopItemState,
  identity: LoopExternalIdentity,
  bound: LoopExternalIdentity | null,
): LoopDriftClass | null {
  if (!REMOTE_PROVING_STATES.has(state)) {
    // Local states (pending/in_progress/blocked/abandoned/implemented) never
    // over-claim by definition, but a verified PR already ahead of the
    // ledger IS forward catch-up drift — a worker that crashed after
    // opening/merging the PR but before recording the transition (#511
    // review-2 finding: this branch used to hard-return null here and could
    // never recover such a crash).
    if (verifiedForwardTarget(identity)) return "ledger-behind";
    return checksRegressed(bound, identity) ? "checks-regressed" : null;
  }

  // Forward catch-up always wins first: the external truth already reached a
  // state strictly ahead of what the ledger claims.
  if (state !== "merged" && state !== "released" && state !== "deployed" && identity.pr_state === "merged") {
    return "ledger-behind";
  }

  if (identity.pr_number === null) {
    return "external-absent";
  }

  if (bound && bound.pr_number !== null && bound.pr_number !== identity.pr_number) {
    return "identity-mismatch";
  }
  if (
    bound &&
    bound.head_sha &&
    identity.head_sha &&
    bound.head_sha !== identity.head_sha &&
    state !== "merged" &&
    state !== "released" &&
    state !== "deployed"
  ) {
    return "identity-mismatch";
  }

  switch (state) {
    case "pr_opened":
      if (identity.pr_state !== "open") return "ledger-ahead";
      return checksRegressed(bound, identity) ? "checks-regressed" : null;
    case "ready":
      if (identity.pr_state !== "open" || !identity.ready_label_present) return "ledger-ahead";
      return checksRegressed(bound, identity) ? "checks-regressed" : null;
    case "merged":
    case "released":
    case "deployed":
      if (identity.pr_state !== "merged") return "ledger-ahead";
      return null;
    default:
      return null;
  }
}

function describeObservedState(identity: LoopExternalIdentity): string {
  return `pr:${identity.pr_number ?? "none"}/${identity.pr_state ?? "none"} checks:${identity.checks_conclusion}`;
}

// ---------------------------------------------------------------------------
// Next-action computation — pure, deterministic.
// ---------------------------------------------------------------------------

/** Computes exactly one {@link LoopNextAction} from the reconciled item state
 *  and its verified identity alone. No clock read, randomness, or I/O — the
 *  same inputs always yield the same action (#511 acceptance criterion). */
export function computeNextAction(
  state: LoopItemState,
  identity: LoopExternalIdentity,
  drift: LoopDriftClass | null,
  mergeBarrierSetForThisItem: boolean,
): LoopNextAction {
  if (drift === "ledger-behind") return "repair-forward";
  if (drift === "ledger-ahead" || drift === "external-absent" || drift === "identity-mismatch") return "hold-for-human";
  if (drift === "checks-regressed") return identity.checks_conclusion === "pending" ? "await-checks" : "hold-for-human";

  switch (state) {
    case "pr_opened":
      if (identity.checks_conclusion === "pending") return "await-checks";
      if (identity.checks_conclusion === "success") return "advance";
      return "noop";
    case "merged":
      return mergeBarrierSetForThisItem ? "clear-merge-barrier" : "noop";
    default:
      return "noop";
  }
}

// ---------------------------------------------------------------------------
// Reconciliation pass — verified truth -> drift -> repair -> next action.
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  runId: string;
  token: string;
  engine: LoopEngineName;
}

/** Runs one reconciliation pass: observes every item's live identity through
 *  the injected seam, classifies drift, repairs only `ledger-behind` drift
 *  forward as an audited transition, evaluates the merge barrier against
 *  verified evidence, computes each item's next action, and persists the
 *  result as a sequence-numbered `last_reconciliation` under the lock token.
 *  Performs no external mutation — every write is a ledger/event write via
 *  `LoopStoreDeps`, never through `ReconcileObserveDeps`. */
export async function reconcile(
  deps: LoopStoreDeps,
  observeDeps: ReconcileObserveDeps,
  input: ReconcileInput,
): Promise<LoopReconciliation> {
  const ledger = await readLedger(deps, input.runId);
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }

  const observed: Record<string, LoopExternalIdentity> = {};
  const drift: LoopDrift[] = [];
  const items: LoopLedger["items"] = { ...ledger.items };

  for (const [id, entry] of Object.entries(ledger.items)) {
    const identity = await observeExternalIdentity(observeDeps, id);
    observed[id] = identity;
    const bound = entry.last_verified_identity ?? null;
    const driftClass = classifyDrift(entry.state, identity, bound);

    if (driftClass) {
      if (!isLoopDriftClass(driftClass)) {
        throw new LoopError("validation", `classifyDrift produced an out-of-enum drift class "${driftClass}" for item "${id}"`);
      }
      drift.push({ item_id: id, ledger_state: entry.state, observed_state: describeObservedState(identity), class: driftClass });
    }

    if (driftClass === "ledger-behind") {
      const target = verifiedForwardTarget(identity);
      if (!target) {
        throw new LoopError("validation", `classifyDrift reported "ledger-behind" for item "${id}" but verifiedForwardTarget found no verified target — these must agree`);
      }
      const time = deps.now().toISOString();
      const from = entry.state;
      const repaired: LoopItemLedgerEntry = {
        ...entry,
        state: target,
        last_verified_identity: identity,
        history: [
          ...entry.history,
          { time, from, to: target, engine: input.engine, note: "reconciliation repaired forward on verified external identity" },
        ],
      };
      items[id] = repaired;
    } else if (!driftClass && (REMOTE_PROVING_STATES.has(entry.state) || identity.pr_number !== null)) {
      items[id] = { ...entry, last_verified_identity: identity };
    }
  }

  let merge_barrier = ledger.merge_barrier;
  if (merge_barrier) {
    const contains = await observeDeps.baseBranchContainsSha(merge_barrier.merged_sha);
    if (contains === true) merge_barrier = null;
  }

  const next_actions: Record<string, LoopNextAction> = {};
  for (const [id, entry] of Object.entries(items)) {
    const identity = observed[id];
    const driftEntry = drift.find((d) => d.item_id === id);
    const barrierSet = ledger.merge_barrier?.item_id === id && merge_barrier !== null;
    next_actions[id] = computeNextAction(entry.state, identity, driftEntry?.class ?? null, barrierSet);
  }

  const sequence = ledger.reconciliation_sequence + 1;
  const reconciliation: LoopReconciliation = {
    sequence,
    time: deps.now().toISOString(),
    observed,
    drift,
    next_actions,
  };

  const newLedger: LoopLedger = {
    ...ledger,
    items,
    merge_barrier,
    last_reconciliation: reconciliation,
    reconciliation_sequence: sequence,
  };
  await writeLedger(deps, newLedger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_reconciled", {
    sequence,
    drift,
    next_actions,
  });
  if (ledger.merge_barrier && !merge_barrier) {
    await appendEvent(deps, input.runId, input.token, "loop_merge_barrier_cleared", {
      item_id: ledger.merge_barrier.item_id,
      merged_sha: ledger.merge_barrier.merged_sha,
    });
  }
  return reconciliation;
}

// ---------------------------------------------------------------------------
// Caller-supplied state never proves a remote transition.
// ---------------------------------------------------------------------------

const STATE_TO_GATE: Partial<Record<LoopItemState, LoopAuthorityGate>> = {
  pr_opened: "push_pr",
  merged: "merge",
  released: "release",
  deployed: "deploy",
};

function identitySupportsState(state: LoopItemState, identity: LoopExternalIdentity): boolean {
  switch (state) {
    case "pr_opened":
      return identity.pr_number !== null && identity.pr_state === "open";
    case "ready":
      return identity.pr_number !== null && identity.pr_state === "open" && identity.ready_label_present;
    case "merged":
      return identity.pr_state === "merged";
    case "released":
    case "deployed":
      // LoopExternalIdentity carries no release/deployment evidence (it observes
      // only issue/PR/checks state) — a merged PR proves merged, never released or
      // deployed. Refuse both until a dedicated evidence field exists (finding
      // 54e0ccf4/c4efacb2e973537a) rather than accept a merge as a stand-in proof.
      return false;
    default:
      return true;
  }
}

function describeIdentityEvidence(identity: LoopExternalIdentity): string {
  return `verified ${describeObservedState(identity)} at ${identity.observed_at}`;
}

export interface TransitionItemInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  to: LoopItemState;
  note?: string;
}

/** The sanctioned entry point for moving an item into a remote-proving state.
 *  Refuses (LoopError "validation") a transition into `pr_opened` / `ready` /
 *  `merged` / `released` / `deployed` unless the engine's own live observation
 *  — taken through the injected {@link ReconcileObserveDeps} seam immediately
 *  before the transition, never a value the caller supplies — is fresh
 *  (within {@link NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS}) and supports that
 *  exact state. A caller cannot fabricate this evidence: `TransitionItemInput`
 *  carries no identity field at all, so there is nothing for a caller to
 *  substitute a claim into. Composes with (never bypasses) the existing
 *  authority-gate + directly-verified-evidence requirement via
 *  `authorizeGatedTransition` (loop/pause.ts) for every state that maps to a
 *  {@link LoopAuthorityGate}. */
export async function transitionItem(
  deps: LoopStoreDeps,
  observeDeps: ReconcileObserveDeps,
  contractInput: LoopContract,
  input: TransitionItemInput,
): Promise<LoopLedger> {
  const ledger = await readLedger(deps, input.runId);
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }
  const item = ledger.items[input.itemId];
  if (!item) {
    throw new LoopError("validation", `item "${input.itemId}" not found in run "${input.runId}"`);
  }

  let observedIdentity: LoopExternalIdentity | undefined;
  if (REMOTE_PROVING_STATES.has(input.to)) {
    const identity = await observeExternalIdentity(observeDeps, input.itemId);
    const ageSeconds = (deps.now().getTime() - Date.parse(identity.observed_at)) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS) {
      throw new LoopError(
        "validation",
        `transition into "${input.to}" for item "${input.itemId}" requires a verified identity within the ${NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS}s freshness window — the engine's live observation was taken at ${identity.observed_at}`,
      );
    }
    if (!identitySupportsState(input.to, identity)) {
      throw new LoopError(
        "validation",
        `transition into "${input.to}" for item "${input.itemId}" is not supported by the engine's verified external identity — caller-supplied state never proves a remote transition`,
      );
    }
    const gate = STATE_TO_GATE[input.to];
    if (gate && isLoopAuthorityGate(gate)) {
      authorizeGatedTransition(contractInput.authority_grants, ledger, gate, input.itemId, describeIdentityEvidence(identity));
    }
    observedIdentity = identity;
  }

  const time = deps.now().toISOString();
  const from = item.state;
  const updated: LoopItemLedgerEntry = {
    ...item,
    state: input.to,
    history: [...item.history, { time, from, to: input.to, engine: input.engine, note: input.note }],
    ...(observedIdentity ? { last_verified_identity: observedIdentity } : {}),
  };
  ledger.items = { ...ledger.items, [input.itemId]: updated };

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_item_transitioned", {
    item_id: input.itemId,
    from,
    to: input.to,
  });
  return ledger;
}
