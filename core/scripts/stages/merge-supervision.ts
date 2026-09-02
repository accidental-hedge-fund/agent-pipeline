// Exact-candidate merge supervision (#1330).
//
// RecoverySupervisor is the sole lifecycle owner. This module declares the
// shared merge operation invariant, exact-candidate claim, side-effect
// certainty, and typed observations that merge, merge-queue, and train emit.
// It is not a second controller, ledger family, grant schema, or scheduler.
// Do not import ship-supervision (wrong bounded context).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const MERGE_OPERATION = "squash_merge" as const;
export const MERGE_COOLING_MS = 15_000;

export type MergeSideEffectCertainty = "known_complete" | "known_absent" | "uncertain";

export type MergeLifecycleState = "active" | "cooling" | "waiting" | "complete";

export type MergeFaultClass =
  | "conflict"
  | "check_drift"
  | "head_drift"
  | "unknown_mergeability"
  | "timeout"
  | "uncertain_merge_response";

export type MergeAuthorityEnvelope =
  | "pipeline merge"
  | "pipeline merge-queue --apply"
  | "pipeline train --merge";

export interface MergeOperationInvariant {
  operation: typeof MERGE_OPERATION;
  precondition: string;
  postcondition: string;
  observer: string;
  candidate_binding: string;
  replay_rule: string;
}

/** Shared merge invariant consumed by `pipeline merge`, merge-queue apply, and train merge waves. */
export const MERGE_OPERATION_INVARIANT: MergeOperationInvariant = {
  operation: MERGE_OPERATION,
  precondition:
    "operator merge authority is current; the linked issue is at pipeline:ready-to-deploy; the PR is the exact integration candidate (repository, base, frozen issue scope, PR number, inspected head); mergeability is MERGEABLE and CLEAN; required checks pass; linkage is valid",
  postcondition:
    "that PR is merged and its merge-result is contained in the fetched configured base",
  observer: "GitHub pull-request merge state plus git ancestry of the fetched base tip",
  candidate_binding:
    "repository, base, frozen issue scope, PR, inspected head SHA, and action identity",
  replay_rule:
    "observe PR state and prove base containment before any replay; do not submit a second merge while the claim is complete, submitted, or uncertain",
};

export function mergeOperationInvariant(): MergeOperationInvariant {
  return { ...MERGE_OPERATION_INVARIANT };
}

export interface MergeClaim {
  operation: typeof MERGE_OPERATION;
  repository: string;
  base: string;
  frozen_issue_scope: number[];
  pr: number;
  inspected_head: string;
  action_identity: string;
  evidence_fingerprint: string;
  outcome: "started" | "submitted" | "complete" | "uncertain";
  started_at: string;
  /** Latest submitted or uncertain transition. Cooling uses this, not started_at. */
  transitioned_at?: string;
}

export interface MergeRemoteObservation {
  state: "open" | "closed" | "merged";
  mergeCommitOid: string | null;
  headRefOid: string | null;
  mergedAt?: string | null;
}

export interface MergeObservation {
  operation: typeof MERGE_OPERATION;
  pr: number;
  repository: string;
  certainty: MergeSideEffectCertainty;
  lifecycle: MergeLifecycleState;
  human_owned: false;
  complete: boolean;
  cancelled: false;
  fault: MergeFaultClass | null;
  message: string;
  claim: MergeClaim | null;
  inspected_head: string | null;
  merge_commit_oid: string | null;
  /** Process exit is ingress evidence only — never treated as verified completion. */
  process_exit_is_completion: false;
}

export interface TrainItemObservation {
  operation: "train_item";
  issue: number;
  kind: "park" | "block" | "merge_fault";
  certainty: MergeSideEffectCertainty;
  lifecycle: MergeLifecycleState;
  human_owned: false;
  complete: false;
  cancelled: false;
  fault: MergeFaultClass | "park" | "block" | null;
  message: string;
}

export type SupervisedMergeObservation = MergeObservation | TrainItemObservation;

export interface MergeClaimStore {
  load(key: string): Promise<MergeClaim | null>;
  save(claim: MergeClaim): Promise<void>;
  /**
   * Atomically persist `next` only when the stored claim equals `expected`.
   * `expected === null` is exclusive create. Returns the stored claim on
   * success, or null when a competitor holds the record.
   */
  compareAndSwap(
    expected: MergeClaim | null,
    next: MergeClaim,
  ): Promise<MergeClaim | null>;
}

export interface MergeSupervisionContext {
  repository: string;
  base: string;
  frozenIssueScope: readonly number[];
  /** Original typed operator envelope. Never widened. */
  envelope: MergeAuthorityEnvelope;
  actionIdentity: string;
  claimStore: MergeClaimStore;
  observeMergedPr(pr: number): Promise<MergeRemoteObservation>;
  fetchBase(base: string): Promise<void>;
  baseTip(base: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  reportObservation?(obs: SupervisedMergeObservation): void;
  now?(): Date;
  /** Test seam: throw after the started claim is persisted and before ghPrMerge. */
  crashBeforeSubmit?: () => void;
  /** Test seam: throw after ghPrMerge returns and before complete-claim persist. */
  crashAfterSubmit?: () => void;
}

export function mergeClaimKey(repository: string, pr: number): string {
  return `${repository.trim().toLowerCase()}#${pr}`;
}

export function mergeClaimsCasEqual(
  a: MergeClaim | null,
  b: MergeClaim | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.outcome === b.outcome &&
    a.evidence_fingerprint === b.evidence_fingerprint &&
    a.inspected_head === b.inspected_head &&
    a.started_at === b.started_at &&
    (a.transitioned_at ?? "") === (b.transitioned_at ?? "") &&
    a.repository === b.repository &&
    a.base === b.base &&
    a.pr === b.pr &&
    a.action_identity === b.action_identity &&
    a.frozen_issue_scope.join(",") === b.frozen_issue_scope.join(",")
  );
}

export function memoryMergeClaimStore(
  map: Map<string, MergeClaim> = new Map(),
): MergeClaimStore & { map: Map<string, MergeClaim> } {
  return {
    map,
    async load(key) {
      const found = map.get(key);
      return found ? structuredClone(found) : null;
    },
    async save(claim) {
      map.set(mergeClaimKey(claim.repository, claim.pr), structuredClone(claim));
    },
    async compareAndSwap(expected, next) {
      const key = mergeClaimKey(next.repository, next.pr);
      const current = map.get(key) ?? null;
      if (!mergeClaimsCasEqual(current, expected)) return null;
      map.set(key, structuredClone(next));
      return structuredClone(next);
    },
  };
}

function claimFileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readClaimFile(file: string): Promise<MergeClaim | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as MergeClaim;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function writeClaimAtomic(file: string, claim: MergeClaim): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(claim), "utf8");
  await fs.rename(tmp, file);
}

async function withClaimCasLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    const fh = await fs.open(lockPath, "wx");
    try {
      await fh.writeFile(String(process.pid), "utf8");
      return await fn();
    } finally {
      await fh.close();
      await fs.unlink(lockPath).catch(() => {});
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") throw err;
    let holder = 0;
    try {
      holder = Number.parseInt(await fs.readFile(lockPath, "utf8"), 10);
    } catch {
      return null;
    }
    if (Number.isInteger(holder) && holder > 0 && !isProcessAlive(holder)) {
      await fs.unlink(lockPath).catch(() => {});
      try {
        const fh = await fs.open(lockPath, "wx");
        try {
          await fh.writeFile(String(process.pid), "utf8");
          return await fn();
        } finally {
          await fh.close();
          await fs.unlink(lockPath).catch(() => {});
        }
      } catch (retryErr) {
        const re = retryErr as NodeJS.ErrnoException;
        if (re.code === "EEXIST") return null;
        throw retryErr;
      }
    }
    return null;
  }
}

export function fileMergeClaimStore(
  dir: string = path.join(os.tmpdir(), "pipeline-merge-claims"),
): MergeClaimStore {
  return {
    async load(key) {
      return readClaimFile(path.join(dir, claimFileName(key)));
    },
    async save(claim) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, claimFileName(mergeClaimKey(claim.repository, claim.pr)));
      await writeClaimAtomic(file, claim);
    },
    async compareAndSwap(expected, next) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, claimFileName(mergeClaimKey(next.repository, next.pr)));
      if (expected === null) {
        try {
          const fh = await fs.open(file, "wx");
          try {
            await fh.writeFile(JSON.stringify(next), "utf8");
          } finally {
            await fh.close();
          }
          return next;
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "EEXIST") return null;
          throw err;
        }
      }
      return withClaimCasLock(`${file}.caslock`, async () => {
        const current = await readClaimFile(file);
        if (!mergeClaimsCasEqual(current, expected)) return null;
        await writeClaimAtomic(file, next);
        return next;
      });
    },
  };
}

export function bindMergeClaim(input: {
  repository: string;
  base: string;
  frozenIssueScope: readonly number[];
  pr: number;
  inspectedHead: string;
  actionIdentity: string;
  now?: Date;
}): MergeClaim {
  const inspected_head = input.inspectedHead.trim();
  if (!inspected_head) {
    throw new Error("merge claim: inspected head SHA is required");
  }
  const repository = input.repository.trim();
  const base = input.base.trim();
  if (!repository || !base) {
    throw new Error("merge claim: repository and base are required");
  }
  const started_at = (input.now ?? new Date()).toISOString();
  const frozen_issue_scope = [...input.frozenIssueScope];
  return {
    operation: MERGE_OPERATION,
    repository,
    base,
    frozen_issue_scope,
    pr: input.pr,
    inspected_head,
    action_identity: input.actionIdentity,
    evidence_fingerprint: [
      MERGE_OPERATION,
      repository,
      base,
      frozen_issue_scope.join(","),
      String(input.pr),
      inspected_head,
      input.actionIdentity,
    ].join(":"),
    outcome: "started",
    started_at,
  };
}

export function transitionMergeClaim(
  claim: MergeClaim,
  outcome: MergeClaim["outcome"],
  now?: Date,
): MergeClaim {
  const next: MergeClaim = { ...claim, outcome };
  if (outcome === "submitted" || outcome === "uncertain") {
    next.transitioned_at = (now ?? new Date()).toISOString();
  }
  return next;
}

/** True when the operator-frozen scope is empty or exactly the live closing issue. */
export function frozenIssueScopeMatchesLinkedIssue(
  frozenIssueScope: readonly number[],
  linkedIssue: number,
): boolean {
  if (frozenIssueScope.length === 0) return true;
  return frozenIssueScope.length === 1 && frozenIssueScope[0] === linkedIssue;
}

export function claimsMatchCandidate(
  claim: MergeClaim,
  live: {
    repository: string;
    base: string;
    frozenIssueScope: readonly number[];
    pr: number;
    inspectedHead: string;
  },
): boolean {
  const scope = [...live.frozenIssueScope].join(",");
  return (
    claim.repository === live.repository.trim() &&
    claim.base === live.base.trim() &&
    claim.pr === live.pr &&
    claim.inspected_head === live.inspectedHead.trim() &&
    claim.frozen_issue_scope.join(",") === scope
  );
}

export function claimInvalidationReason(
  claim: MergeClaim,
  live: {
    repository: string;
    base: string;
    frozenIssueScope: readonly number[];
    pr: number;
    headRefOid: string | null;
  },
): "head_drift" | "base" | "pr" | "scope" | "repository" | null {
  if (claim.repository !== live.repository.trim()) return "repository";
  if (claim.base !== live.base.trim()) return "base";
  if (claim.pr !== live.pr) return "pr";
  if (claim.frozen_issue_scope.join(",") !== [...live.frozenIssueScope].join(",")) {
    return "scope";
  }
  const liveHead = (live.headRefOid ?? "").trim();
  if (liveHead && liveHead !== claim.inspected_head) return "head_drift";
  return null;
}

export type MergeReconcileDecision =
  | { action: "complete"; certainty: "known_complete"; mergeCommitOid: string | null }
  | { action: "may_submit"; certainty: "known_absent" }
  | { action: "wait"; certainty: "uncertain"; fault: MergeFaultClass }
  | { action: "invalidate"; certainty: "known_absent"; fault: "head_drift" };

function mergeSideEffectPending(claim: MergeClaim | null): boolean {
  return claim?.outcome === "submitted" || claim?.outcome === "uncertain";
}

function claimCoolingElapsed(claim: MergeClaim, now: Date): boolean {
  const raw = claim.transitioned_at;
  if (!raw) return false;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at >= MERGE_COOLING_MS;
}

export function decideMergeReplay(input: {
  claim: MergeClaim | null;
  live: MergeRemoteObservation;
  contained: boolean;
  now?: Date;
}): MergeReconcileDecision {
  const liveMerged = input.live.state === "merged";
  // Verified completion always requires merged + fetched-base containment.
  if (liveMerged && input.contained) {
    return {
      action: "complete",
      certainty: "known_complete",
      mergeCommitOid: input.live.mergeCommitOid,
    };
  }
  // Submitted/uncertain: never remarge until the prior side effect is known absent.
  if (mergeSideEffectPending(input.claim)) {
    const now = input.now ?? new Date();
    if (input.claim && !liveMerged && claimCoolingElapsed(input.claim, now)) {
      return { action: "may_submit", certainty: "known_absent" };
    }
    return {
      action: "wait",
      certainty: "uncertain",
      fault: "uncertain_merge_response",
    };
  }
  // A persisted complete claim without proven containment stays owned; never remarge it.
  if (input.claim?.outcome === "complete") {
    return {
      action: "wait",
      certainty: "uncertain",
      fault: "uncertain_merge_response",
    };
  }
  if (input.claim && input.live.headRefOid) {
    const drifted = input.live.headRefOid.trim() !== input.claim.inspected_head;
    if (drifted) {
      return { action: "invalidate", certainty: "known_absent", fault: "head_drift" };
    }
  }
  if (input.claim?.outcome === "started" && !liveMerged) {
    // Crash-before-submit: mutation never left. Re-prove gates, then may submit.
    return { action: "may_submit", certainty: "known_absent" };
  }
  if (!liveMerged) {
    return { action: "may_submit", certainty: "known_absent" };
  }
  // Merged but not yet contained: owned external-condition wait.
  return { action: "wait", certainty: "uncertain", fault: "uncertain_merge_response" };
}

export function classifyMergeFault(message: string): MergeFaultClass | null {
  const text = message.toLowerCase();
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("etimedout") ||
    text.includes("aborted")
  ) {
    return "timeout";
  }
  if (
    text.includes("head sha different") ||
    text.includes("head moved") ||
    text.includes("stale inspected head") ||
    text.includes("match-head-commit") ||
    text.includes("headrefoid")
  ) {
    return "head_drift";
  }
  if (
    text.includes("not yet computed") ||
    text.includes("mergeable is unknown") ||
    text.includes("mergeability is not yet computed")
  ) {
    return "unknown_mergeability";
  }
  if (
    text.includes("conflicting") ||
    text.includes("merge conflict") ||
    text.includes("merge conflicts") ||
    text.includes("merge state is dirty") ||
    text.includes("mergestatestatus is dirty") ||
    text.includes("merge state is behind") ||
    text.includes("cannot be merged")
  ) {
    return "conflict";
  }
  if (
    text.includes("required check") ||
    text.includes("observable check") ||
    text.includes("checks are not all green") ||
    text.includes("failing or pending")
  ) {
    return "check_drift";
  }
  if (
    text.includes("gh pr merge failed") ||
    text.includes("unreadable") ||
    text.includes("uncertain merge")
  ) {
    return "uncertain_merge_response";
  }
  return null;
}

export function ownedLifecycleForFault(
  fault: MergeFaultClass | null,
): MergeLifecycleState {
  if (fault === "unknown_mergeability" || fault === "check_drift") return "waiting";
  if (fault === "timeout" || fault === "uncertain_merge_response") return "cooling";
  if (fault === "conflict" || fault === "head_drift") return "cooling";
  return "cooling";
}

export function mergeObservation(input: {
  pr: number;
  repository: string;
  certainty: MergeSideEffectCertainty;
  lifecycle: MergeLifecycleState;
  complete: boolean;
  fault: MergeFaultClass | null;
  message: string;
  claim: MergeClaim | null;
  inspectedHead?: string | null;
  mergeCommitOid?: string | null;
}): MergeObservation {
  return {
    operation: MERGE_OPERATION,
    pr: input.pr,
    repository: input.repository,
    certainty: input.certainty,
    lifecycle: input.lifecycle,
    human_owned: false,
    complete: input.complete,
    cancelled: false,
    fault: input.fault,
    message: input.message,
    claim: input.claim,
    inspected_head: input.inspectedHead ?? input.claim?.inspected_head ?? null,
    merge_commit_oid: input.mergeCommitOid ?? null,
    process_exit_is_completion: false,
  };
}

export function trainItemObservation(input: {
  issue: number;
  kind: "park" | "block" | "merge_fault";
  fault: MergeFaultClass | "park" | "block" | null;
  message: string;
  lifecycle?: MergeLifecycleState;
}): TrainItemObservation {
  return {
    operation: "train_item",
    issue: input.issue,
    kind: input.kind,
    certainty: "known_absent",
    lifecycle: input.lifecycle ?? "cooling",
    human_owned: false,
    complete: false,
    cancelled: false,
    fault: input.fault,
    message: input.message,
  };
}

export function coolingUntilIso(now: Date, ms: number = MERGE_COOLING_MS): string {
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * Authority comes only from the original typed operator envelope.
 * Repository config, recover-parked, and host retry never grant merge.
 */
export function assertOperatorMergeEnvelope(envelope: unknown): asserts envelope is MergeAuthorityEnvelope {
  if (
    envelope !== "pipeline merge" &&
    envelope !== "pipeline merge-queue --apply" &&
    envelope !== "pipeline train --merge"
  ) {
    throw new Error(
      `merge authority refused: envelope must be pipeline merge, merge-queue --apply, or train --merge (got ${String(envelope)})`,
    );
  }
}

export function mergeAuthorityFromConfig(_config: unknown): never {
  throw new Error(
    "merge authority refused: repository configuration cannot authorize merges; auto_merge is not a config key",
  );
}

export function mergeAuthorityFromRecoverParked(): never {
  throw new Error(
    "merge authority refused: recover-parked does not grant merge authority",
  );
}

export async function proveMergeContained(
  supervision: Pick<MergeSupervisionContext, "fetchBase" | "baseTip" | "isAncestor">,
  base: string,
  mergeCommitOid: string | null,
): Promise<boolean> {
  if (!mergeCommitOid) return false;
  await supervision.fetchBase(base);
  const tip = await supervision.baseTip(base);
  return supervision.isAncestor(mergeCommitOid, tip);
}

export async function observeAndDecide(input: {
  pr: number;
  supervision: MergeSupervisionContext;
  claim: MergeClaim | null;
}): Promise<{ decision: MergeReconcileDecision; live: MergeRemoteObservation; contained: boolean }> {
  const live = await input.supervision.observeMergedPr(input.pr);
  let contained = false;
  if (live.state === "merged" && live.mergeCommitOid) {
    contained = await proveMergeContained(
      input.supervision,
      input.supervision.base,
      live.mergeCommitOid,
    );
  }
  return {
    decision: decideMergeReplay({
      claim: input.claim,
      live,
      contained,
      now: input.supervision.now?.() ?? new Date(),
    }),
    live,
    contained,
  };
}
