// Operator-authorized integrated train (#901 / #1023 / #1028 / #1063 / #1096 / #1273 / #1413).
//
// Advance-only (`merge: false`): base-eligible frontier waves (loop recovery).
// `--merge` / ship: **serial** — merge-first prelude merges every already-R2D
// open mergeable PR and proves base containment before any plan/implement.
// A merge-first log line is not compliance. At most one implement at a time.
// That merge-first rule is the anti-PR-farm rule. A contained per-item hold
// (blocked / needs-human / waiting / cooling / non-ready) does not abandon
// independent remaining work. Direct and transitive dependents of a held item
// are dependency-skipped. Train does not invoke recover-parked.
// `pipeline loop` keeps frontier parallelism.
//
// Unit tests inject TrainDeps — no real network, git, or subprocess in tests.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { parseDeclaredDependencyIds } from "../declared-dependency-grammar.ts";
import { mintLogicalOperationId } from "../logical-operation.ts";
import {
  assertDiscoveryCompleteForAdmission,
  discoverDeclaredDependencies,
  extractRoadmapDeclaredEdges,
  realWorkListDependencyDiscoverDeps,
  type DeclaredDependencyDiscoveryResult,
  type DeclaredEdgeProvenance,
  type IgnoredDep,
  type RoadmapDeclaredEdge,
  type SourceObservation,
  type WorkListDependencyDiscoverDeps,
} from "../loop/work-list-deps.ts";
import { isFactoryControlCheckout } from "../production-engine-pin.ts";
import {
  getPrForIssueAnyState as ghGetPrForIssueAnyState,
  normalizeLinkedIssuePrs,
  type LinkedIssuePrs,
} from "../gh.ts";
import { compileContractItems, type RawContractItem } from "../loop/dependencies.ts";
import { LoopError } from "../loop/types.ts";
import {
  persistPublicEntrypointAdmission,
  resolvePublicAdmissionPersistRoot,
  type PublicAdmissionStoreDeps,
  type RunStoreDeps,
} from "../run-store.ts";
import {
  flushTrainRunHandoff,
  initTrainRunStore,
  type TrainEventSession,
  type TrainEventsCoverage,
} from "../train-events.ts";
import type { PipelineConfig } from "../types.ts";
import { pipelineStageFromLabels } from "../loop/precondition.ts";
import {
  integrationSideEffectCertainty,
  reportMechanicalFault,
  reportPublicEntrypointAdmissionFailure,
  type ReportOperationObservation,
  type LinkedPrIntegrationFact,
} from "../operation-observation.ts";
import {
  proveMergeResultInBase,
  releaseWorktreeForParkedIssue,
  type ParkReleaseDeps,
  type ParkReleaseResult,
  type VerifiedMergeProof,
} from "../worktree.ts";
import { mergePr, realMergeDeps, realMergeSupervision, type MergeDeps } from "./merge.ts";
import {
  classifyMergeFault,
  trainItemObservation,
  type MergeFaultClass,
  type SupervisedMergeObservation,
} from "./merge-supervision.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrainItemTerminal =
  | "ready-to-deploy"
  | "needs-human"
  | "blocked"
  | "already-integrated"
  | "error"
  | "parked"
  | "dependency-skipped";

export type TrainNextAction =
  | "resolve-work-list"
  | "advance"
  | "merge"
  | "wait-for-base"
  | "next-item"
  | "complete"
  | "stopped";

export interface TrainIssueSnapshot {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

export interface TrainItemResult {
  issue: number;
  pr: number | null;
  terminal: TrainItemTerminal;
  merge_result_oid: string | null;
  integrated: boolean;
  error?: string;
}

export interface TrainStatus {
  schema_version: 1;
  kind: "train_status";
  ordered_issues: number[];
  current_issue: number | null;
  current_index: number;
  next_action: TrainNextAction;
  merge_mode: boolean;
  items: TrainItemResult[];
  blocker: string | null;
  complete: boolean;
  /** Additive train-level run id when the generic run store was initialized. */
  run_id?: string;
  /**
   * Observational train-event coverage (#1301). Omitted on successful exclusive
   * identity allocation (`ok`). Present as `degraded` or `unknown` when the
   * run store could not be published exclusively or a later observation failed.
   */
  events_coverage?: TrainEventsCoverage;
}

/** Closed snapshot actions for `pipeline train --dry-run` (#1275). */
export type TrainIntendedAction =
  | "would-advance"
  | "waiting-on-deps"
  | "would-merge"
  | "already-integrated"
  | "would-block"
  | "held";

export interface TrainPlanItem {
  issue: number;
  stage: string | null;
  pr: number | null;
  intended_action: TrainIntendedAction;
  on_frontier: boolean;
}

export interface TrainPlan {
  schema_version: 1;
  kind: "train_plan";
  merge_mode: boolean;
  ordered_issues: number[];
  merge_first: number[];
  items: TrainPlanItem[];
  /** Additive discovery audit (#1413). Same facts live train records on the work-list event. */
  observations?: SourceObservation[];
  edge_provenance?: DeclaredEdgeProvenance[];
  ignored_deps?: IgnoredDep[];
}

export interface TrainOpts {
  /** Explicit issue numbers (positive integers). Mutually exclusive with empty+milestone-only. */
  issues?: readonly number[];
  /** Milestone title; used when issues is absent/empty. Also scopes engine-class live siblings. */
  milestone?: string;
  /** When true, merge each ready-to-deploy PR and prove base containment before dependents advance. */
  merge: boolean;
  /**
   * Opt-in read-only plan (#1275). Resolves order + GitHub PR/stage snapshot and
   * returns without advance, merge, or a train run store. Not the default.
   */
  dryRun?: boolean;
  baseBranch: string;
  repoDir: string;
  repo: string;
  /** Full pipeline config when available (park-release identity uses base_branch / worktree_root). */
  pipelineConfig?: PipelineConfig;
  /** Skip live advance when the issue is already at ready-to-deploy (default true). */
  skipAdvanceIfReady?: boolean;
}

export interface TrainResult {
  exitCode: number;
  status: TrainStatus;
  /** Present when `opts.dryRun` produced a read-only plan. */
  plan?: TrainPlan;
}

export type AdvanceOutcome =
  | {
      ok: true;
      terminal: "ready-to-deploy" | "needs-human" | "blocked" | "other";
      labels: string[];
      /**
       * Optional structured loop stop / block diagnostic (#1074). Used when
       * parking holds so item `error` / train blocker quote class/reason
       * instead of a generic park phrase alone.
       */
      diagnostic?: string;
    }
  | { ok: false; error: string };

export interface LinkedLoopRun {
  /** Real loop run directory basename (not a synthetic `pipeline-loop-…` string). */
  runId: string;
  /** Absolute loop `events.jsonl` path when the store is confirmed. */
  eventsPath?: string;
}

export type AdvanceWaveResult = Map<number, AdvanceOutcome> & {
  /** Confirmed wave loop store, when the production loop seam published one. */
  loopRun?: LinkedLoopRun;
};

/** Context passed into each advance wave (#1277 / #1301). */
export interface AdvanceWaveContext {
  logicalOperationId?: string;
  /**
   * Live child-loop handoff. Production `advanceWaveThroughLoop` awaits this
   * from `onRunReady` after the exact run id and events path exist, before the
   * loop engine can block on work. Sole append site for `train_loop_linked`.
   */
  onLoopReady?: (loopRun: LinkedLoopRun) => void | Promise<void>;
}

/** Result shape consumed from recover-parked (shared entrypoint). */
export type TrainRecoverParkedStatus =
  | "deterministic-cleared"
  | "recovered"
  | "still-parked"
  | "already-spent"
  | "not-parked"
  | "fail-closed";

export interface TrainRecoverParkedResult {
  status: TrainRecoverParkedStatus;
  issue: number;
  message: string;
}

export interface TrainDeps {
  log(msg: string): void;
  listMilestoneIssues(milestone: string): Promise<TrainIssueSnapshot[]>;
  getIssue(issue: number): Promise<TrainIssueSnapshot>;
  /**
   * Shared work-list declared-dependency discovery (#1413). Production wires
   * {@link realWorkListDependencyDiscoverDeps} (same class as fresh loop compile).
   * Tests inject fakes. Train MUST NOT parse title/body as a second graph.
   */
  discoverDeps: WorkListDependencyDiscoverDeps;
  /** Injected generic run-store I/O. Tests supply an in-memory fake. */
  runStore?: RunStoreDeps;
  /** Strict public-admission I/O for train-nested merge records. */
  publicAdmissionStore?: PublicAdmissionStoreDeps;
  persistPublicAdmission?: typeof persistPublicEntrypointAdmission;
  /** Production resolves factory-control; tests bind an explicit approved root. */
  resolveApprovedControlRoot?: () => Promise<string | null>;
  reportOperationObservation?: ReportOperationObservation;
  /** Clock for train run ids and event timestamps. */
  now?: () => Date;
  /** Early `train_run_handoff` JSON line (stderr in production). */
  writeHandoff?: (line: string) => Promise<void> | void;
  /**
   * Advance one base-eligible frontier as a single multi-item wave
   * (production: one loop/advance-wave call — not N×single). Must not merge.
   */
  advanceWave(
    issues: readonly number[],
    ctx?: AdvanceWaveContext,
  ): Promise<AdvanceWaveResult>;
  /**
   * Legacy single-item advance. Used only when tests/adapters lack advanceWave
   * wiring via {@link advanceWaveFromSingle}. Prefer advanceWave in production.
   */
  advanceIssue?(issue: number): Promise<AdvanceOutcome>;
  /**
   * Optional unused seam. Production train MUST NOT wire or invoke recover-parked.
   * Residual parks are RecoverySupervisor observations. Tests may inject a
   * throwing stub to prove the entrypoint is not called.
   */
  recoverParked?(issue: number): Promise<TrainRecoverParkedResult>;
  /** Typed observations for RecoverySupervisor. Train does not choose lifecycle. */
  reportObservation?(obs: SupervisedMergeObservation): void;
  /** Open PR only — used when a merge mutation may still be required. */
  getPrForIssue(issue: number): Promise<number | null>;
  /**
   * Linked PR across open/closed/merged states (timeline-based).
   * Used for merge-mode already-integrated reconciliation after the open PR is gone.
   */
  getPrForIssueAnyState(issue: number): Promise<number | null>;
  /** Every linked PR (open, closed, merged). Completeness consults this set.
   *  `{ numbers, truncated }` reports a bounded scan that is not absence. */
  listLinkedPrs?(issue: number): Promise<readonly number[] | LinkedIssuePrs>;
  /** Existing merge surface (same gates as `pipeline merge`). */
  mergeIssuePr(pr: number): Promise<void>;
  observePr(pr: number): Promise<{
    state: "open" | "closed" | "merged";
    mergeCommitOid: string | null;
    headRefOid: string | null;
  }>;
  fetchBase(baseBranch: string): Promise<void>;
  baseTip(baseBranch: string): Promise<string>;
  /** True when `ancestor` is an ancestor of `descendant` (or equal). */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /**
   * Shared park-release after a proven merge (#1274). Defaults to
   * {@link releaseWorktreeForParkedIssue}. Tests inject a spy. Train MUST NOT
   * add a path-local worktree-delete mole.
   */
  releaseParkedWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    parkDeps?: ParkReleaseDeps,
  ) => Promise<ParkReleaseResult>;
  parkReleaseDeps?: ParkReleaseDeps;
}

/** Result of reconciling a linked PR against base containment for integration. */
export type IntegratedReconcileResult =
  | { kind: "not-merged" }
  | { kind: "integrated"; mergeCommitOid: string | null; verifiedMergeProof?: VerifiedMergeProof }
  | { kind: "containment-failed"; mergeCommitOid: string; tip: string };

/**
 * Observe a PR and, when merged, prove merge-result containment in the fetched base.
 * When the PR is merged but no merge-result OID is available, treat as integrated
 * (observe already proved merged — #1014 closed+merged without OID).
 */
export async function reconcileMergedPrIntegration(
  issue: number,
  pr: number,
  baseBranch: string,
  deps: Pick<TrainDeps, "observePr" | "fetchBase" | "baseTip" | "isAncestor">,
): Promise<IntegratedReconcileResult> {
  const obs = await deps.observePr(pr);
  if (obs.state !== "merged") return { kind: "not-merged" };
  if (!obs.mergeCommitOid) {
    return { kind: "integrated", mergeCommitOid: null };
  }
  const proof = await proveMergeResultInBase(
    {
      issue,
      pr,
      base: baseBranch,
      mergeResultOid: obs.mergeCommitOid,
      worktreeHead: obs.headRefOid ?? "",
    },
    {
      fetchBase: deps.fetchBase,
      baseTip: deps.baseTip,
      isAncestor: deps.isAncestor,
    },
  );
  if (proof) {
    return { kind: "integrated", mergeCommitOid: obs.mergeCommitOid, verifiedMergeProof: proof };
  }
  const tip = await deps.baseTip(baseBranch);
  return { kind: "containment-failed", mergeCommitOid: obs.mergeCommitOid, tip };
}

/** Outcome of the shared merge+containment surface used by prelude and merge wave. */
export type MergeReadyToDeployResult =
  | {
      kind: "integrated";
      pr: number;
      mergeCommitOid: string | null;
      already: boolean;
      /** True when `mergeIssuePr` was invoked for this item. */
      attempted: boolean;
      verifiedMergeProof?: VerifiedMergeProof;
    }
  | {
      kind: "stop";
      blocker: string;
      pr: number | null;
      mergeCommitOid: string | null;
      attempted: boolean;
    }
  | {
      kind: "hold";
      blocker: string;
      pr: number | null;
      mergeCommitOid: string | null;
      attempted: boolean;
      fault: MergeFaultClass | "containment" | "missing-pr";
      lifecycle: "cooling" | "waiting";
    };

/**
 * Existing issue-PR merge surface + base containment. Prelude and the
 * post-advance merge wave both call this; it is not a second merge policy.
 */
export async function mergeReadyToDeployItem(
  issue: number,
  baseBranch: string,
  deps: Pick<
    TrainDeps,
    | "getPrForIssue"
    | "getPrForIssueAnyState"
    | "observePr"
    | "mergeIssuePr"
    | "fetchBase"
    | "baseTip"
    | "isAncestor"
    | "log"
  > & { admitMergeSubmission?: (issue: number, pr: number) => Promise<string | null> },
): Promise<MergeReadyToDeployResult> {
  const pr = await deps.getPrForIssue(issue);
  if (pr == null) {
    const anyPr = await deps.getPrForIssueAnyState(issue);
    if (anyPr != null) {
      const recon = await reconcileMergedPrIntegration(issue, anyPr, baseBranch, deps);
      if (recon.kind === "integrated") {
        const oidNote =
          recon.mergeCommitOid != null
            ? ` merge ${recon.mergeCommitOid.slice(0, 12)}… in ${baseBranch}`
            : "";
        deps.log(`[train] #${issue}: already integrated (PR #${anyPr}${oidNote})`);
        return {
          kind: "integrated",
          pr: anyPr,
          mergeCommitOid: recon.mergeCommitOid,
          already: true,
          attempted: false,
          verifiedMergeProof: recon.verifiedMergeProof,
        };
      }
      if (recon.kind === "containment-failed") {
        return {
          kind: "hold",
          blocker:
            `merge result ${recon.mergeCommitOid} for #${issue} PR #${anyPr} is not contained in ` +
            `fetched ${baseBranch} tip ${recon.tip}`,
          pr: anyPr,
          mergeCommitOid: recon.mergeCommitOid,
          attempted: false,
          fault: "containment",
          lifecycle: "waiting",
        };
      }
    }
    return {
      kind: "hold",
      blocker: `issue #${issue} is ready-to-deploy but has no linked open PR`,
      pr: null,
      mergeCommitOid: null,
      attempted: false,
      fault: "missing-pr",
      lifecycle: "waiting",
    };
  }

  let obs = await deps.observePr(pr);
  let attempted = false;
  if (obs.state !== "merged") {
    const admissionFailure = await deps.admitMergeSubmission?.(issue, pr);
    if (admissionFailure) {
      return {
        kind: "hold",
        blocker: admissionFailure,
        pr,
        mergeCommitOid: obs.mergeCommitOid,
        attempted: false,
        fault: "uncertain_merge_response",
        lifecycle: "cooling",
      };
    }
    deps.log(`[train] #${issue}: merging PR #${pr}…`);
    try {
      await deps.mergeIssuePr(pr);
      attempted = true;
    } catch (err) {
      const message = (err as Error).message;
      obs = await deps.observePr(pr);
      if (obs.state === "merged") {
        attempted = true;
      } else {
        const fault = classifyMergeFault(message);
        return {
          kind: "hold",
          blocker: `merge failed for #${issue} PR #${pr}: ${message}`,
          pr,
          mergeCommitOid: obs.mergeCommitOid,
          attempted: true,
          fault: fault ?? "uncertain_merge_response",
          lifecycle: fault === "unknown_mergeability" || fault === "check_drift" ? "waiting" : "cooling",
        };
      }
    }
    obs = await deps.observePr(pr);
  }

  if (obs.state !== "merged" || !obs.mergeCommitOid) {
    return {
      kind: "hold",
      blocker:
        `PR #${pr} for #${issue} is not merged with an observable merge commit ` +
        `(state=${obs.state}, mergeCommit=${obs.mergeCommitOid ?? "null"})`,
      pr,
      mergeCommitOid: obs.mergeCommitOid,
      attempted,
      fault: "uncertain_merge_response",
      lifecycle: "cooling",
    };
  }

  deps.log(
    `[train] #${issue}: proving merge ${obs.mergeCommitOid.slice(0, 12)}… is in origin/${baseBranch}…`,
  );
  const proof = await proveMergeResultInBase(
    {
      issue,
      pr,
      base: baseBranch,
      mergeResultOid: obs.mergeCommitOid,
      worktreeHead: obs.headRefOid ?? "",
    },
    {
      fetchBase: deps.fetchBase,
      baseTip: deps.baseTip,
      isAncestor: deps.isAncestor,
    },
  );
  if (!proof) {
    const tip = await deps.baseTip(baseBranch);
    return {
      kind: "hold",
      blocker:
        `merge result ${obs.mergeCommitOid} for #${issue} PR #${pr} is not contained in ` +
        `fetched ${baseBranch} tip ${tip}`,
      pr,
      mergeCommitOid: obs.mergeCommitOid,
      attempted,
      fault: "containment",
      lifecycle: "waiting",
    };
  }

  deps.log(`[train] #${issue}: integrated (PR #${pr})`);
  return {
    kind: "integrated",
    pr,
    mergeCommitOid: obs.mergeCommitOid,
    already: !attempted,
    attempted,
    verifiedMergeProof: proof,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function parseIssueList(raw: string | undefined | null): number[] {
  if (raw == null || String(raw).trim() === "") return [];
  const parts = String(raw)
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    if (!/^[1-9][0-9]*$/.test(part)) {
      throw new Error(`invalid issue id "${part}" — expected a positive integer`);
    }
    const n = Number(part);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export { pipelineStageFromLabels };


export function isReadyToDeploySnapshot(s: TrainIssueSnapshot): boolean {
  return pipelineStageFromLabels(s.labels) === "ready-to-deploy";
}

/** gh `issue list --limit` cap shared by train `--milestone` and ship freeze. */
export const MILESTONE_ISSUE_DISCOVERY_LIMIT = 200;

/**
 * Freeze-eligible work-list members (#1252): open non-backlog issues plus
 * closed `pipeline:ready-to-deploy`. Freeze admits; train merge-mode still
 * classifies `already-integrated` vs no-open-PR / containment.
 */
export function isFreezeEligibleIssue(s: TrainIssueSnapshot): boolean {
  const stage = pipelineStageFromLabels(s.labels);
  if (s.state === "closed") return stage === "ready-to-deploy";
  return stage !== "backlog";
}

export function selectFreezeEligibleIssues(
  snapshots: readonly TrainIssueSnapshot[],
): TrainIssueSnapshot[] {
  return snapshots.filter(isFreezeEligibleIssue);
}

export function emptyFreezeEligibleMilestoneError(
  milestone: string,
  source: "train" | "ship" = "train",
): string {
  const prefix = source === "ship" ? "ship train: " : "";
  return `${prefix}milestone ${JSON.stringify(milestone)} has no freeze-eligible issues`;
}

export function assertMilestoneIssueDiscoveryLimit(
  listedCount: number,
  milestone: string,
  source: "train" | "ship" = "train",
): void {
  if (listedCount < MILESTONE_ISSUE_DISCOVERY_LIMIT) return;
  const prefix = source === "ship" ? "ship train: " : "";
  const suffix =
    source === "ship"
      ? "split the milestone or add paginated discovery before authorizing a shipment"
      : "split the milestone or add paginated discovery";
  throw new Error(
    `${prefix}milestone ${JSON.stringify(milestone)} reached the 200-issue discovery limit; ` +
      suffix,
  );
}

export function isBlockedOrNeedsHumanSnapshot(s: TrainIssueSnapshot): boolean {
  return s.labels.includes("blocked") || pipelineStageFromLabels(s.labels) === "needs-human";
}

/**
 * `--merge` order: already-R2D issues first (stable relative order), then the rest.
 * Declared-dep order is preserved inside each partition (#1063).
 * When `admittedItems` is provided (train live/dry-run), order consumes the
 * shared discovery graph rather than re-parsing snapshot title/body (#1413).
 */
export function orderIssuesForTrain(
  snapshots: readonly TrainIssueSnapshot[],
  mergeMode: boolean,
  admittedItems?: readonly RawContractItem[],
): number[] {
  const base = admittedItems
    ? orderIssuesByAdmittedItems(snapshots, admittedItems)
    : orderIssuesByDeclaredDeps(snapshots);
  if (!mergeMode) return base;
  const byN = new Map(snapshots.map((s) => [s.number, s]));
  const r2d: number[] = [];
  const rest: number[] = [];
  for (const n of base) {
    if (isReadyToDeploySnapshot(byN.get(n)!)) r2d.push(n);
    else rest.push(n);
  }
  return [...r2d, ...rest];
}

/**
 * Build a dependency-ordered issue list from admitted discovery items.
 * Input snapshot order breaks topological ties (compileContractItems).
 */
export function orderIssuesByAdmittedItems(
  snapshots: readonly TrainIssueSnapshot[],
  admittedItems: readonly RawContractItem[],
): number[] {
  if (snapshots.length === 0) {
    throw new Error("work list is empty");
  }
  const byId = new Map(admittedItems.map((item) => [item.id, item]));
  const raw: RawContractItem[] = snapshots.map((s) => {
    const id = String(s.number);
    const item = byId.get(id);
    if (!item) {
      throw new Error(`discovery omitted issue #${s.number}`);
    }
    return item;
  });
  return orderRawContractItems(raw);
}

/**
 * Build a dependency-ordered issue list from snapshots.
 * Lexical-only helper retained for ship freeze planning. Train live/dry-run
 * uses {@link orderIssuesByAdmittedItems} from shared discovery (#1413).
 */
export function orderIssuesByDeclaredDeps(
  snapshots: readonly TrainIssueSnapshot[],
): number[] {
  if (snapshots.length === 0) {
    throw new Error("work list is empty");
  }
  const raw: RawContractItem[] = snapshots.map((s) => {
    const text = `${s.title}\n${s.body}`;
    const deps = parseDeclaredDependencyIds(text, String(s.number))
      .map((id) => id)
      .filter((id) => snapshots.some((o) => String(o.number) === id));
    return { id: String(s.number), depends_on: deps };
  });
  return orderRawContractItems(raw);
}

function orderRawContractItems(raw: readonly RawContractItem[]): number[] {
  try {
    const ordered = compileContractItems(raw);
    return ordered.map((item) => Number(item.id));
  } catch (err) {
    if (err instanceof LoopError) {
      throw new Error(`dependency validation failed: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Code-dependency adjacency from admitted discovery items:
 * issue → prerequisite issue numbers. Unknown edge kind fails closed (#1023).
 */
export function codeDependencyMap(
  items: readonly RawContractItem[],
): Map<number, number[]> {
  const inList = new Set(items.map((item) => Number(item.id)));
  const map = new Map<number, number[]>();
  for (const item of items) {
    const n = Number(item.id);
    const deps = (item.depends_on ?? [])
      .map((id) => Number(id))
      .filter((d) => Number.isSafeInteger(d) && inList.has(d));
    map.set(n, deps);
  }
  return map;
}

/**
 * Base-eligible frontier: not done/held, code prereqs all integrated, stable order.
 * Code prereqs require base containment (`integrated`) only — non-merge R2D
 * (`finished`) is not sufficient (#1028 review). Unknown ownership is not
 * modeled here — loop serializes unproven pairs inside the wave.
 */
export function computeBaseEligibleFrontier(input: {
  ordered: readonly number[];
  /** Finished terminals (integrated, or non-merge R2D complete). */
  finished: ReadonlySet<number>;
  /** Parked / held (needs-human, blocked after resume) — excluded from advance. */
  held: ReadonlySet<number>;
  /** Issues whose merge-result is contained on the configured base. */
  integrated: ReadonlySet<number>;
  /** issue → code prereq issues (empty when none). */
  codeDeps: ReadonlyMap<number, readonly number[]>;
}): number[] {
  const frontier: number[] = [];
  for (const issue of input.ordered) {
    if (input.finished.has(issue) || input.held.has(issue)) continue;
    const prereqs = input.codeDeps.get(issue) ?? [];
    // Code deps: merge-result base containment only (not mere R2D / finished).
    const prereqsOk = prereqs.every((p) => input.integrated.has(p));
    if (!prereqsOk) continue;
    frontier.push(issue);
  }
  return frontier;
}

/**
 * True when `issue` has no direct or transitive admitted declared-dependency
 * path to any held item. Reverse edges (a held item depends on `issue`) do not
 * skip it. Fail closed: {@link codeDependencyMap} already treats unknown
 * admitted edges as code dependencies; this helper walks that graph.
 */
export function isIndependentOfHeld(
  issue: number,
  held: ReadonlySet<number>,
  codeDeps: ReadonlyMap<number, readonly number[]>,
): boolean {
  if (held.size === 0) return true;
  const seen = new Set<number>();
  const stack = [...(codeDeps.get(issue) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (held.has(cur)) return false;
    for (const prereq of codeDeps.get(cur) ?? []) {
      stack.push(prereq);
    }
  }
  return true;
}

/** Adapt N× advanceIssue into one advanceWave for tests / thin CLI wiring. */
export function advanceWaveFromSingle(
  advanceIssue: (issue: number) => Promise<AdvanceOutcome>,
): (issues: readonly number[]) => Promise<AdvanceWaveResult> {
  return async (issues) => {
    const out = new Map<number, AdvanceOutcome>();
    for (const n of issues) {
      out.set(n, await advanceIssue(n));
    }
    return out;
  };
}

export function buildTrainStatus(partial: Omit<TrainStatus, "schema_version" | "kind">): TrainStatus {
  return { schema_version: 1, kind: "train_status", ...partial };
}

export function buildTrainPlan(partial: Omit<TrainPlan, "schema_version" | "kind">): TrainPlan {
  return { schema_version: 1, kind: "train_plan", ...partial };
}

/** Shared `[train] ordered issues:` line used by live train and dry-run. */
export function formatTrainOrderedIssuesLine(
  ordered: readonly number[],
  mergeMode: boolean,
  mergeFirst: readonly number[],
): string {
  return (
    `[train] ordered issues: ${ordered.map((n) => `#${n}`).join(" → ")}` +
    (mergeMode
      ? ` (merge mode, serial ship; merge-first ${mergeFirst.length ? mergeFirst.map((n) => `#${n}`).join(", ") : "none"})`
      : " (advance only, frontier waves)")
  );
}

async function linkedPrForPlan(
  issue: number,
  deps: TrainDeps,
): Promise<{ pr: number | null; open: boolean; merged: boolean; contained: boolean }> {
  const openPr = await deps.getPrForIssue(issue);
  const anyPr = await deps.getPrForIssueAnyState(issue);
  const listed = deps.listLinkedPrs
    ? normalizeLinkedIssuePrs(await deps.listLinkedPrs(issue))
    : { numbers: [] as number[], truncated: false };
  const numbers = [...new Set([
    ...listed.numbers,
    ...(openPr != null ? [openPr] : []),
    ...(anyPr != null ? [anyPr] : []),
  ])];
  const facts: LinkedPrIntegrationFact[] = [];
  for (const n of numbers) {
    const obs = await deps.observePr(n);
    let contained: boolean | null = null;
    if (obs.state === "merged" && obs.mergeCommitOid) {
      try {
        const tip = await deps.baseTip("");
        contained = await deps.isAncestor(obs.mergeCommitOid, tip);
      } catch {
        contained = obs.mergeCommitOid ? true : null;
      }
    } else if (obs.state === "merged") {
      contained = null;
    }
    facts.push({
      number: n,
      state: obs.state,
      merge_commit_sha: obs.mergeCommitOid,
      contained,
      artifact_role: "implementation",
      artifact_identity: obs.headRefOid ? `pr:${n}:${obs.headRefOid}` : null,
      candidate_sha: obs.headRefOid,
      candidate_epoch: obs.headRefOid,
    });
  }
  const certainty = integrationSideEffectCertainty(facts, { truncated: listed.truncated });
  const mergedFact = facts.find((f) => f.state === "merged" && f.contained === true)
    ?? facts.find((f) => f.state === "merged");
  if (mergedFact) {
    return {
      pr: mergedFact.number,
      open: false,
      merged: true,
      contained: certainty === "known_complete" || mergedFact.contained !== false,
    };
  }
  const openFact = facts.find((f) => f.state === "open");
  if (openFact) {
    return { pr: openFact.number, open: true, merged: false, contained: false };
  }
  return { pr: null, open: false, merged: false, contained: false };
}

function classifyTrainIntendedAction(input: {
  mergeMode: boolean;
  stage: string | null;
  held: boolean;
  open: boolean;
  merged: boolean;
  contained?: boolean;
  waitingOnDeps: boolean;
}): TrainIntendedAction {
  if (input.held) return "held";
  if (input.merged) return "already-integrated";
  if (input.mergeMode && input.stage === "ready-to-deploy") {
    if (input.open) return "would-merge";
    if (input.merged) return "already-integrated";
    return "would-block";
  }
  if (input.waitingOnDeps) return "waiting-on-deps";
  return "would-advance";
}

function discoveryAuditFields(discovery: DeclaredDependencyDiscoveryResult): {
  observations: SourceObservation[];
  edge_provenance: DeclaredEdgeProvenance[];
  ignored_deps?: IgnoredDep[];
} {
  return {
    observations: discovery.observations,
    edge_provenance: discovery.edge_provenance,
    ...(discovery.ignored_deps.length > 0 ? { ignored_deps: discovery.ignored_deps } : {}),
  };
}

async function planTrainDryRun(input: {
  ordered: readonly number[];
  byNumber: ReadonlyMap<number, TrainIssueSnapshot>;
  codeDeps: ReadonlyMap<number, readonly number[]>;
  mergeMode: boolean;
  deps: TrainDeps;
  discovery: DeclaredDependencyDiscoveryResult;
}): Promise<TrainPlan> {
  const { ordered, byNumber, codeDeps, mergeMode, deps, discovery } = input;
  const linked = new Map<number, { pr: number | null; open: boolean; merged: boolean; contained: boolean }>();
  for (const n of ordered) {
    linked.set(n, await linkedPrForPlan(n, deps));
  }

  const held = new Set<number>();
  const alreadyIntegrated = new Set<number>();
  for (const n of ordered) {
    const snap = byNumber.get(n)!;
    if (isBlockedOrNeedsHumanSnapshot(snap)) held.add(n);
    const stage = pipelineStageFromLabels(snap.labels);
    const pr = linked.get(n)!;
    if (pr.merged) {
      alreadyIntegrated.add(n);
    }
  }

  const frontier = new Set(
    computeBaseEligibleFrontier({
      ordered,
      finished: alreadyIntegrated,
      held,
      integrated: alreadyIntegrated,
      codeDeps,
    }),
  );

  const items: TrainPlanItem[] = ordered.map((n) => {
    const snap = byNumber.get(n)!;
    const stage = pipelineStageFromLabels(snap.labels);
    const pr = linked.get(n)!;
    const prereqs = codeDeps.get(n) ?? [];
    const waitingOnDeps = prereqs.some((p) => !alreadyIntegrated.has(p));
    return {
      issue: n,
      stage,
      pr: pr.pr,
      intended_action: classifyTrainIntendedAction({
        mergeMode,
        stage,
        held: held.has(n),
        open: pr.open,
        merged: pr.merged,
        contained: pr.contained,
        waitingOnDeps,
      }),
      on_frontier: frontier.has(n),
    };
  });

  const mergeFirst = mergeMode
    ? ordered.filter((n) => {
        const snap = byNumber.get(n)!;
        const pr = linked.get(n)!;
        return pipelineStageFromLabels(snap.labels) === "ready-to-deploy" && pr.open;
      })
    : [];

  return buildTrainPlan({
    merge_mode: mergeMode,
    ordered_issues: [...ordered],
    merge_first: mergeFirst,
    items,
    ...discoveryAuditFields(discovery),
  });
}

function logTrainPlan(plan: TrainPlan, log: (msg: string) => void): void {
  log(formatTrainOrderedIssuesLine(plan.ordered_issues, plan.merge_mode, plan.merge_first));
  for (const item of plan.items) {
    const prText = item.pr != null ? `PR #${item.pr}` : "PR none";
    const mergeFirstNote =
      plan.merge_mode && plan.merge_first.includes(item.issue) ? " merge-first" : "";
    log(
      `[train] #${item.issue}  stage=${item.stage ?? "none"}  ${prText}  ` +
        `frontier=${item.on_frontier ? "yes" : "no"}  action=${item.intended_action}${mergeFirstNote}`,
    );
  }
  for (const edge of plan.edge_provenance ?? []) {
    log(
      `[train] dep #${edge.depender} → #${edge.prerequisite} sources=${edge.sources.join(",")}`,
    );
  }
  for (const ign of plan.ignored_deps ?? []) {
    log(`[train] ignored dep #${ign.depender} → #${ign.target} reason=${ign.reason}`);
  }
  log(
    "[train] dry-run: no mutations performed (no advance, merge, push, comment, or run store)",
  );
}

function trainPipelineConfig(opts: TrainOpts): PipelineConfig {
  return (
    opts.pipelineConfig ??
    ({
      repo: opts.repo,
      repo_dir: opts.repoDir,
      base_branch: opts.baseBranch,
      worktree_root: ".worktrees",
    } as PipelineConfig)
  );
}

/** Shared bound-proof park-release after proven train merge. Never a train-only remover. */
async function parkReleaseAfterProvenMerge(
  issue: number,
  proof: VerifiedMergeProof | undefined,
  opts: TrainOpts,
  deps: TrainDeps,
): Promise<void> {
  if (!proof) return;
  const cfg = trainPipelineConfig(opts);
  const releaseFn = deps.releaseParkedWorktree ?? releaseWorktreeForParkedIssue;
  try {
    const result = await releaseFn(cfg, issue, {
      ...(deps.parkReleaseDeps ?? {}),
      verifiedMergeProof: proof,
      prNumber: proof.pr,
      expectedMergeResultOid: proof.mergeResultOid,
    });
    if (result.action === "released") {
      deps.log(`[train] #${issue}: park-release: ${result.reason}`);
    } else if (result.action === "retained") {
      deps.log(`[train] #${issue}: park-release retained: ${result.reason}`);
    }
  } catch (err) {
    deps.log(
      `[train] #${issue}: park-release failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runTrain(opts: TrainOpts, deps: TrainDeps): Promise<TrainResult> {
  const mergeMode = !!opts.merge;
  const skipIfReady = opts.skipAdvanceIfReady !== false;

  const advanceWave =
    deps.advanceWave ??
    (deps.advanceIssue
      ? advanceWaveFromSingle(deps.advanceIssue)
      : null);
  if (!advanceWave) {
    throw new Error("TrainDeps requires advanceWave (or legacy advanceIssue)");
  }

  let snapshots: TrainIssueSnapshot[];
  if (opts.issues && opts.issues.length > 0) {
    snapshots = [];
    for (const n of opts.issues) {
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`invalid issue number ${n}`);
      }
      snapshots.push(await deps.getIssue(n));
    }
  } else if (opts.milestone && opts.milestone.trim() !== "") {
    snapshots = selectFreezeEligibleIssues(
      await deps.listMilestoneIssues(opts.milestone.trim()),
    );
    if (snapshots.length === 0) {
      throw new Error(emptyFreezeEligibleMilestoneError(opts.milestone));
    }
  } else {
    throw new Error(
      "pipeline train requires --issues <n,n,n> and/or --milestone <title>",
    );
  }

  snapshots = snapshots.filter((s) => pipelineStageFromLabels(s.labels) !== "backlog");
  if (snapshots.length === 0) {
    throw new Error("work list has no eligible issues (all pipeline:backlog or empty)");
  }

  if (!deps.discoverDeps) {
    throw new Error("TrainDeps requires discoverDeps (shared work-list discovery)");
  }
  const issueIds = snapshots.map((s) => String(s.number));
  const discovery = await discoverDeclaredDependencies(issueIds, deps.discoverDeps);
  assertDiscoveryCompleteForAdmission(issueIds, discovery, {
    forceRefuse: isFactoryControlCheckout({
      repoDir: opts.repoDir,
      env: process.env,
    }),
  });

  const ordered = orderIssuesForTrain(snapshots, mergeMode, discovery.items);
  const byNumber = new Map(snapshots.map((s) => [s.number, s]));
  const codeDeps = codeDependencyMap(discovery.items);

  if (opts.dryRun) {
    const plan = await planTrainDryRun({
      ordered,
      byNumber,
      codeDeps,
      mergeMode,
      deps,
      discovery,
    });
    logTrainPlan(plan, deps.log);
    return {
      exitCode: 0,
      status: buildTrainStatus({
        ordered_issues: plan.ordered_issues,
        current_issue: null,
        current_index: 0,
        next_action: "resolve-work-list",
        merge_mode: plan.merge_mode,
        items: [],
        blocker: null,
        complete: false,
      }),
      plan,
    };
  }

  const mergeFirst = mergeMode
    ? ordered.filter((n) => isReadyToDeploySnapshot(byNumber.get(n)!))
    : [];

  deps.log(formatTrainOrderedIssuesLine(ordered, mergeMode, mergeFirst));

  const startedAt = deps.now?.() ?? new Date();
  const outerLogicalOperationId = mintLogicalOperationId();
  let trainStoreRoot = opts.repoDir;
  if (mergeMode) {
    try {
      trainStoreRoot =
        (await (deps.resolveApprovedControlRoot ?? (() => resolvePublicAdmissionPersistRoot({ repoDir: opts.repoDir })))()) ?? "";
    } catch {
      trainStoreRoot = "";
    }
    if (!trainStoreRoot) {
      reportMechanicalFault(deps.reportOperationObservation, {
        operation: "train",
        form_id: "public-admission:train",
        message: "approved factory-control root is unavailable",
        domain: opts.pipelineConfig?.domain ?? opts.repo,
        logical_operation_id: outerLogicalOperationId,
        repository: opts.repo,
        run_id: null,
        fault: "admission.approved_root_unavailable",
        certainty: "known_absent",
      });
      return {
        exitCode: 1,
        status: buildTrainStatus({
          ordered_issues: ordered,
          current_issue: ordered[0] ?? null,
          current_index: 0,
          next_action: "stopped",
          merge_mode: true,
          items: [],
          blocker: "train merge admission refused: approved factory-control root is unavailable",
          complete: false,
          events_coverage: "unknown",
        }),
      };
    }
  }
  const storeInit = await initTrainRunStore({
    repoDir: trainStoreRoot,
    repo: opts.repo,
    startedAt,
    mergeMode,
    orderedIssues: ordered,
    selector: {
      ...(opts.issues && opts.issues.length > 0 ? { issues: [...opts.issues] } : {}),
      ...(opts.milestone && opts.milestone.trim() !== ""
        ? { milestone: opts.milestone.trim() }
        : {}),
    },
    store: deps.runStore,
    now: deps.now,
    logicalOperationId: outerLogicalOperationId,
  });
  let eventsCoverage = storeInit.eventsCoverage;
  const published = storeInit.session;
  if (mergeMode && !published) {
    reportMechanicalFault(deps.reportOperationObservation, {
      operation: "train",
      form_id: "public-admission:train",
      message: "outer train session was not durably published and verified",
      domain: opts.pipelineConfig?.domain ?? opts.repo,
      logical_operation_id: outerLogicalOperationId,
      repository: opts.repo,
      run_id: null,
      fault: "admission.persistence_failure",
      certainty: "known_absent",
    });
    return {
      exitCode: 1,
      status: buildTrainStatus({
        ordered_issues: ordered,
        current_issue: ordered[0] ?? null,
        current_index: 0,
        next_action: "stopped",
        merge_mode: true,
        items: [],
        blocker: "train merge admission refused: outer session persistence was not acknowledged",
        complete: false,
        events_coverage: storeInit.eventsCoverage,
      }),
    };
  }
  const session: TrainEventSession = published ?? {
    runId: "",
    runDir: "",
    eventsPath: "",
    logicalOperationId: "",
    async append() {
      return true;
    },
  };
  if (published) {
    await flushTrainRunHandoff(published, deps.writeHandoff);
  }
  await session.append("train_work_list_resolved", {
    ordered_issues: ordered,
    merge_mode: mergeMode,
    ...discoveryAuditFields(discovery),
  });

  const startedIssues = new Set<number>();
  const announcedPrs = new Set<string>();
  const linkedLoopIds = new Map<string, string>();
  const linkedLoopPaths = new Map<string, string>();
  const liveLoopByWave = new Map<number, { runId: string; eventsPath: string }>();
  const conflictsPublishedLiveLink = (id: string, eventsPath: string): boolean => {
    const publishedPath = linkedLoopIds.get(id);
    if (publishedPath !== undefined) return publishedPath !== eventsPath;
    const publishedId = linkedLoopPaths.get(eventsPath);
    return publishedId !== undefined && publishedId !== id;
  };
  const emitItemStarted = async (issue: number): Promise<void> => {
    if (startedIssues.has(issue)) return;
    startedIssues.add(issue);
    await session.append("train_item_started", { issue });
  };
  const emitPr = async (issue: number, pr: number | null): Promise<void> => {
    if (pr == null) return;
    const key = `${issue}:${pr}`;
    if (announcedPrs.has(key)) return;
    announcedPrs.add(key);
    await session.append("train_pr_created", { issue, pr });
  };
  const emitItemCompleted = async (item: TrainItemResult): Promise<void> => {
    await emitPr(item.issue, item.pr);
    await session.append("train_item_completed", {
      issue: item.issue,
      terminal: item.terminal,
      ...(item.pr != null ? { pr: item.pr } : {}),
    });
  };
  const emitMergeCatalog = async (
    issue: number,
    merged: MergeReadyToDeployResult,
  ): Promise<void> => {
    if (merged.pr != null) await emitPr(issue, merged.pr);
    if (merged.attempted && merged.pr != null) {
      await session.append("train_merge_attempted", { issue, pr: merged.pr });
    }
    if (merged.kind !== "integrated") return;
    await session.append("train_merge_proven", {
      issue,
      pr: merged.pr,
      merge_result_oid: merged.mergeCommitOid,
      proof_disposition: merged.already ? "already-contained" : "newly-merged",
    });
    await session.append("train_merge_integrated", {
      issue,
      pr: merged.pr,
      merge_result_oid: merged.mergeCommitOid,
    });
  };
  const admitNestedMergeSubmission = async (issue: number, pr: number): Promise<string | null> => {
    const admission = await (deps.persistPublicAdmission ?? persistPublicEntrypointAdmission)(
      {
        repoDir: opts.repoDir,
        factoryControlRoot: trainStoreRoot,
        kind: "merge",
        repo: opts.repo,
        domain: opts.pipelineConfig?.domain ?? opts.repo,
        issue,
        runId: `merge-${session.runId}-${issue}-${pr}`,
        logicalOperationId: session.logicalOperationId,
        admissionMode: "nested",
      },
      deps.publicAdmissionStore,
    );
    if (admission.acknowledged) return null;
    reportPublicEntrypointAdmissionFailure(deps.reportOperationObservation, admission);
    return `nested merge admission refused (${admission.failure.kind}): ${admission.failure.diagnostic}`;
  };

  let result: TrainResult | undefined;
  try {
    result = await (async (): Promise<TrainResult> => {
  const items: TrainItemResult[] = [];
  const finished = new Set<number>();
  const held = new Set<number>();
  const integrated = new Set<number>();
  const itemByIssue = new Map<number, TrainItemResult>();
  let blocker: string | null = null;
  let nextAction: TrainNextAction = "advance";
  let currentIssue: number | null = ordered[0] ?? null;
  let currentIndex = 0;

  const pushItem = (item: TrainItemResult) => {
    items.push(item);
    itemByIssue.set(item.issue, item);
  };

  const skipDependentsOfHeld = async (): Promise<void> => {
    for (const n of ordered) {
      if (finished.has(n) || held.has(n) || itemByIssue.has(n)) continue;
      if (isIndependentOfHeld(n, held, codeDeps)) continue;
      const ancestors = [...held].filter(
        (h) => !isIndependentOfHeld(n, new Set([h]), codeDeps),
      );
      held.add(n);
      const skipped: TrainItemResult = {
        issue: n,
        pr: await deps.getPrForIssue(n),
        terminal: "dependency-skipped",
        merge_result_oid: null,
        integrated: false,
        error:
          `dependency-skipped: #${n} depends on held ` +
          `${ancestors.map((h) => `#${h}`).join(", ")}`,
      };
      pushItem(skipped);
      await emitItemCompleted(skipped);
      deps.log(
        `[train] #${n}: dependency-skipped (depends on ${ancestors.map((h) => `#${h}`).join(", ")})`,
      );
    }
  };

  const holdContainedItem = async (item: TrainItemResult): Promise<void> => {
    held.add(item.issue);
    pushItem(item);
    await emitItemCompleted(item);
    await session.append("train_sibling_halted", { issue: item.issue });
    await skipDependentsOfHeld();
  };

  if (mergeMode) {
    for (const s of snapshots) {
      if (!isBlockedOrNeedsHumanSnapshot(s)) continue;
      const needsHuman = pipelineStageFromLabels(s.labels) === "needs-human";
      held.add(s.number);
      const parked: TrainItemResult = {
        issue: s.number,
        pr: null,
        terminal: needsHuman ? "needs-human" : "blocked",
        merge_result_oid: null,
        integrated: false,
        error: needsHuman
          ? `issue #${s.number} parked at pipeline:needs-human`
          : `issue #${s.number} is blocked`,
      };
      pushItem(parked);
      await emitItemStarted(s.number);
      await emitItemCompleted(parked);
      await session.append("train_sibling_halted", { issue: s.number });
      deps.log(
        `[train] #${s.number}: already ${needsHuman ? "needs-human" : "blocked"} — held (independent remaining work continues)`,
      );
    }
    await skipDependentsOfHeld();
  }

  const status = (): TrainStatus =>
    buildTrainStatus({
      ordered_issues: ordered,
      current_issue: currentIssue,
      current_index: currentIndex,
      next_action: nextAction,
      merge_mode: mergeMode,
      items: [...items],
      blocker,
      complete:
        blocker === null &&
        ordered.every((n) => finished.has(n) || integrated.has(n)) &&
        held.size === 0,
      ...(published ? { run_id: published.runId } : {}),
      ...(eventsCoverage !== "ok" ? { events_coverage: eventsCoverage } : {}),
    });

  const markFinished = (issue: number, item: TrainItemResult) => {
    pushItem(item);
    finished.add(issue);
    if (item.integrated) integrated.add(issue);
  };

  const applyMergeReady = (
    issue: number,
    merged: MergeReadyToDeployResult,
  ): TrainResult | null => {
    if (merged.kind === "hold") {
      return null;
    }
    if (merged.kind === "stop") {
      blocker = merged.blocker;
      nextAction = "stopped";
      pushItem({
        issue,
        pr: merged.pr,
        terminal: "ready-to-deploy",
        merge_result_oid: merged.mergeCommitOid,
        integrated: false,
        error: blocker,
      });
      deps.log(`[train] STOP: ${blocker}`);
      return { exitCode: 1, status: status() };
    }
    markFinished(issue, {
      issue,
      pr: merged.pr,
      terminal: merged.already ? "already-integrated" : "ready-to-deploy",
      merge_result_oid: merged.mergeCommitOid,
      integrated: true,
    });
    nextAction = "next-item";
    return null;
  };

  /**
   * Merge every remaining already-R2D work-list item with a linked PR.
   * Used as the merge-first prelude and as the post-advance merge wave.
   */
  const mergeReadyCandidates = async (
    candidates: readonly number[],
  ): Promise<TrainResult | null> => {
    for (const issue of candidates) {
      if (finished.has(issue) || held.has(issue) || integrated.has(issue)) continue;
      const snap = byNumber.get(issue) ?? (await deps.getIssue(issue));
      byNumber.set(issue, snap);
      if (pipelineStageFromLabels(snap.labels) !== "ready-to-deploy") continue;

      if (held.size > 0 && !isIndependentOfHeld(issue, held, codeDeps)) {
        blocker =
          `cannot merge #${issue}: independence from held item(s) ` +
          `${[...held].map((h) => `#${h}`).join(", ")} is unproven`;
        nextAction = "stopped";
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }

      currentIssue = issue;
      currentIndex = ordered.indexOf(issue);
      nextAction = "merge";
      await emitItemStarted(issue);
      const merged = await mergeReadyToDeployItem(issue, opts.baseBranch, {
        ...deps,
        admitMergeSubmission: admitNestedMergeSubmission,
      });
      await emitMergeCatalog(issue, merged);
      if (merged.kind === "integrated") {
        await parkReleaseAfterProvenMerge(issue, merged.verifiedMergeProof, opts, deps);
      }
      if (merged.kind === "hold") {
        const heldItem: TrainItemResult = {
          issue,
          pr: merged.pr,
          terminal: "error",
          merge_result_oid: merged.mergeCommitOid,
          integrated: false,
          error: merged.blocker,
        };
        await holdContainedItem(heldItem);
        deps.reportObservation?.(
          trainItemObservation({
            issue,
            kind: "merge_fault",
            fault:
              merged.fault === "containment" || merged.fault === "missing-pr"
                ? null
                : merged.fault,
            message: merged.blocker,
            lifecycle: merged.lifecycle,
          }),
        );
        deps.log(
          `[train] hold #${issue}: ${merged.blocker} (independent remaining work continues)`,
        );
        continue;
      }
      const stopped = applyMergeReady(issue, merged);
      if (stopped) {
        const last = items[items.length - 1];
        if (last && last.issue === issue) await emitItemCompleted(last);
        return stopped;
      }
      const finishedItem = itemByIssue.get(issue);
      if (finishedItem) await emitItemCompleted(finishedItem);
    }
    return null;
  };

  const openReadyToDeployPrs = async (): Promise<number[]> => {
    const open: number[] = [];
    for (const issue of ordered) {
      if (finished.has(issue) || held.has(issue) || integrated.has(issue)) continue;
      const snap = byNumber.get(issue);
      if (!snap || pipelineStageFromLabels(snap.labels) !== "ready-to-deploy") continue;
      const pr = await deps.getPrForIssue(issue);
      if (pr == null) continue;
      const obs = await deps.observePr(pr);
      if (obs.state === "open") open.push(issue);
    }
    return open;
  };

  // Safety bound: frontiers recompute; avoid infinite empty thrash.
  const maxWaves = ordered.length * 4 + 4;
  for (let wave = 0; wave < maxWaves; wave++) {
    // Refresh labels for unfinished items
    for (const n of ordered) {
      if (finished.has(n) || held.has(n)) continue;
      const snap = await deps.getIssue(n);
      byNumber.set(n, snap);
    }

    // Idempotent integrated reconciliation for merge-mode R2D items
    if (mergeMode) {
      for (const issue of ordered) {
        if (finished.has(issue) || held.has(issue) || integrated.has(issue)) continue;
        const snap = byNumber.get(issue)!;
        const stage = pipelineStageFromLabels(snap.labels);
        const openPr = await deps.getPrForIssue(issue);
        const linkedPr =
          openPr ??
          (stage === "ready-to-deploy" ? await deps.getPrForIssueAnyState(issue) : null);
        if (linkedPr == null) continue;
        const recon = await reconcileMergedPrIntegration(issue, linkedPr, opts.baseBranch, deps);
        if (recon.kind === "integrated") {
          const oidNote =
            recon.mergeCommitOid != null
              ? ` merge ${recon.mergeCommitOid.slice(0, 12)}… in ${opts.baseBranch}`
              : "";
          deps.log(`[train] #${issue}: already integrated (PR #${linkedPr}${oidNote})`);
          await emitItemStarted(issue);
          await emitMergeCatalog(issue, {
            kind: "integrated",
            pr: linkedPr,
            mergeCommitOid: recon.mergeCommitOid,
            already: true,
            attempted: false,
            verifiedMergeProof: recon.verifiedMergeProof,
          });
          const already: TrainItemResult = {
            issue,
            pr: linkedPr,
            terminal: "already-integrated",
            merge_result_oid: recon.mergeCommitOid,
            integrated: true,
          };
          markFinished(issue, already);
          await parkReleaseAfterProvenMerge(issue, recon.verifiedMergeProof, opts, deps);
          await emitItemCompleted(already);
          continue;
        }
        if (recon.kind === "containment-failed") {
          const err =
            `merge result ${recon.mergeCommitOid} for #${issue} PR #${linkedPr} is not contained in ` +
            `fetched ${opts.baseBranch} tip ${recon.tip}`;
          await holdContainedItem({
            issue,
            pr: linkedPr,
            terminal: "error",
            merge_result_oid: recon.mergeCommitOid,
            integrated: false,
            error: err,
          });
          deps.reportObservation?.(
            trainItemObservation({
              issue,
              kind: "merge_fault",
              fault: null,
              message: err,
              lifecycle: "waiting",
            }),
          );
          deps.log(
            `[train] hold #${issue}: ${err} (independent remaining work continues)`,
          );
          continue;
        }
      }

      // Merge-first prelude: already-R2D open mergeable PRs before any implement.
      const preludeStop = await mergeReadyCandidates(ordered);
      if (preludeStop) return preludeStop;
    }

    const frontier = computeBaseEligibleFrontier({
      ordered,
      finished,
      held,
      integrated,
      codeDeps,
    });

    if (frontier.length === 0) {
      const remaining = ordered.filter((n) => !finished.has(n) && !held.has(n));
      if (remaining.length === 0) {
        // All finished or held
        if (held.size > 0) {
          const reasons = [...held].map((n) => {
            const it = itemByIssue.get(n);
            return `#${n}${it?.error ? ` (${it.error})` : ""}`;
          });
          blocker = `all remaining work held: ${reasons.join(", ")}`;
          nextAction = "stopped";
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }
        break; // complete
      }
      // Dependents waiting on code prereqs not yet base-contained (finished R2D
      // without merge is not enough — #1028).
      const waitingOn = remaining.map((n) => {
        const prereqs = (codeDeps.get(n) ?? []).filter((p) => !integrated.has(p));
        return `#${n} waits on ${prereqs.map((p) => `#${p}`).join(",") || "?"} (not integrated on base)`;
      });
      blocker = `no base-eligible frontier; ${waitingOn.join("; ")}`;
      nextAction = "stopped";
      deps.log(`[train] STOP: ${blocker}`);
      return { exitCode: 1, status: status() };
    }

    // ---- Advance wave ----
    let toAdvance = frontier.filter((issue) => {
      const snap = byNumber.get(issue)!;
      const stage = pipelineStageFromLabels(snap.labels);
      if (skipIfReady && stage === "ready-to-deploy") return false;
      return true;
    });
    if (mergeMode && toAdvance.length > 0) {
      toAdvance = [toAdvance[0]!];
    }

    if (toAdvance.length > 0) {
      if (mergeMode) {
        const openR2d = await openReadyToDeployPrs();
        if (openR2d.length > 0) {
          blocker =
            `merge-first violated: would implement #${toAdvance[0]} while ready-to-deploy ` +
            `${openR2d.map((n) => `#${n}`).join(", ")} still has an open mergeable PR`;
          nextAction = "stopped";
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }
      }
      currentIssue = toAdvance[0]!;
      currentIndex = ordered.indexOf(currentIssue);
      nextAction = "advance";
      deps.log(
        `[train] advance wave: ${toAdvance.map((n) => `#${n}`).join(", ")} ` +
          `(frontier ${frontier.map((n) => `#${n}`).join(", ")})`,
      );
      const waveNumber = wave + 1;
      await session.append("train_wave_started", {
        wave: waveNumber,
        frontier: toAdvance,
      });
      for (const issue of toAdvance) {
        await emitItemStarted(issue);
      }
      const publishLiveLoop = async (loopRun: LinkedLoopRun): Promise<void> => {
        if (!published) return;
        const id = loopRun.runId.trim();
        const eventsPath =
          typeof loopRun.eventsPath === "string" ? loopRun.eventsPath.trim() : "";
        if (!id || !eventsPath || !isAbsolute(eventsPath)) return;
        if (conflictsPublishedLiveLink(id, eventsPath)) {
          eventsCoverage = "degraded";
          return;
        }
        if (linkedLoopIds.has(id)) return;
        const live = liveLoopByWave.get(waveNumber);
        if (live && (live.runId !== id || live.eventsPath !== eventsPath)) {
          eventsCoverage = "degraded";
          return;
        }
        try {
          const ok = await session.append("train_loop_linked", {
            wave: waveNumber,
            loop_run_id: id,
            logical_operation_id: session.logicalOperationId,
            events: eventsPath,
          });
          if (!ok) {
            eventsCoverage = "degraded";
            return;
          }
          linkedLoopIds.set(id, eventsPath);
          linkedLoopPaths.set(eventsPath, id);
          liveLoopByWave.set(waveNumber, { runId: id, eventsPath });
        } catch {
          eventsCoverage = "degraded";
        }
      };
      let waveResult: AdvanceWaveResult;
      try {
        waveResult = await advanceWave(toAdvance, {
          logicalOperationId: published ? session.logicalOperationId : undefined,
          onLoopReady: publishLiveLoop,
        });
      } catch (err) {
        blocker = `advance wave failed: ${(err as Error).message}`;
        nextAction = "stopped";
        deps.log(`[train] STOP: ${blocker}`);
        await session.append("train_wave_ended", {
          wave: waveNumber,
          frontier: toAdvance,
        });
        return { exitCode: 1, status: status() };
      }
      const live = liveLoopByWave.get(waveNumber);
      const later = waveResult.loopRun;
      if (
        live &&
        later &&
        later.runId.trim() !== "" &&
        (later.runId !== live.runId || later.eventsPath !== live.eventsPath)
      ) {
        eventsCoverage = "degraded";
      }
      if (later) {
        const laterId = later.runId.trim();
        const laterPath =
          typeof later.eventsPath === "string" ? later.eventsPath.trim() : "";
        if (
          laterId !== "" &&
          laterPath !== "" &&
          isAbsolute(laterPath) &&
          conflictsPublishedLiveLink(laterId, laterPath)
        ) {
          eventsCoverage = "degraded";
        }
      }

      for (const issue of toAdvance) {
        const advanced = waveResult.get(issue);
        if (!advanced) {
          blocker = `advance wave omitted outcome for #${issue}`;
          nextAction = "stopped";
          deps.log(`[train] STOP: ${blocker}`);
          await session.append("train_wave_ended", {
            wave: waveNumber,
            frontier: toAdvance,
          });
          return { exitCode: 1, status: status() };
        }
        if (!advanced.ok) {
          const errItem: TrainItemResult = {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "error",
            merge_result_oid: null,
            integrated: false,
            error: advanced.error,
          };
          await holdContainedItem(errItem);
          deps.log(
            mergeMode
              ? `[train] hold #${issue}: ${advanced.error} (independent remaining work continues)`
              : `[train] park #${issue}: ${advanced.error}`,
          );
          continue;
        }
        const labels = advanced.labels;
        byNumber.set(issue, { ...byNumber.get(issue)!, labels });
        const stage =
          pipelineStageFromLabels(labels) ??
          (advanced.terminal === "ready-to-deploy" ? "ready-to-deploy" : null);

        if (advanced.terminal === "needs-human" || stage === "needs-human") {
          const err =
            advanced.diagnostic ?? `issue #${issue} parked at pipeline:needs-human`;
          const parked: TrainItemResult = {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "needs-human",
            merge_result_oid: null,
            integrated: false,
            error: err,
          };
          await holdContainedItem(parked);
          deps.reportObservation?.(
            trainItemObservation({
              issue,
              kind: "park",
              fault: "park",
              message: err,
            }),
          );
          deps.log(
            mergeMode
              ? `[train] hold #${issue}: needs-human (independent remaining work continues)`
              : `[train] park #${issue}: needs-human (advance-only peers may continue)`,
          );
          continue;
        }
        if (advanced.terminal === "blocked" || labels.includes("blocked")) {
          const err = advanced.diagnostic ?? `issue #${issue} is blocked`;
          const blockedItem: TrainItemResult = {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "blocked",
            merge_result_oid: null,
            integrated: false,
            error: err,
          };
          await holdContainedItem(blockedItem);
          deps.reportObservation?.(
            trainItemObservation({
              issue,
              kind: "block",
              fault: "block",
              message: err,
            }),
          );
          deps.log(
            mergeMode
              ? `[train] hold #${issue}: blocked (independent remaining work continues)`
              : `[train] park #${issue}: blocked (advance-only peers may continue)`,
          );
          continue;
        }
        if (stage !== "ready-to-deploy" && advanced.terminal !== "ready-to-deploy") {
          const err =
            advanced.diagnostic ??
            `issue #${issue} did not reach ready-to-deploy (stage=${stage ?? advanced.terminal})`;
          const other: TrainItemResult = {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "error",
            merge_result_oid: null,
            integrated: false,
            error: err,
          };
          await holdContainedItem(other);
          deps.log(
            mergeMode
              ? `[train] hold #${issue}: ${err} (independent remaining work continues)`
              : `[train] park #${issue}: ${err}`,
          );
          continue;
        }
        // Reached R2D — labels updated; not finished until merge wave (merge mode)
        // or non-merge complete.
        if (!mergeMode) {
          const r2d: TrainItemResult = {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "ready-to-deploy",
            merge_result_oid: null,
            integrated: false,
          };
          markFinished(issue, r2d);
          await emitItemCompleted(r2d);
        } else {
          // Leave in frontier for merge wave; refresh labels
          byNumber.set(issue, {
            ...byNumber.get(issue)!,
            labels: labels.includes("pipeline:ready-to-deploy")
              ? labels
              : ["pipeline:ready-to-deploy"],
          });
        }
      }
      await session.append("train_wave_ended", {
        wave: waveNumber,
        frontier: toAdvance,
      });
    } else {
      // Entire frontier already R2D (skip advance)
      for (const issue of frontier) {
        if (!mergeMode && !finished.has(issue)) {
          await emitItemStarted(issue);
          const r2d: TrainItemResult = {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "ready-to-deploy",
            merge_result_oid: null,
            integrated: false,
          };
          markFinished(issue, r2d);
          await emitItemCompleted(r2d);
        }
      }
    }

    // ---- Merge wave (serial) for items that became R2D in this advance wave ----
    if (mergeMode) {
      nextAction = "merge";
      const mergeWaveStop = await mergeReadyCandidates(frontier);
      if (mergeWaveStop) return mergeWaveStop;
    }

    // Progress check: if nothing finished this wave and no advance ran, stop thrashing
    if (toAdvance.length === 0 && mergeMode) {
      const anyMergeEligible = frontier.some(
        (n) =>
          !finished.has(n) &&
          !held.has(n) &&
          !integrated.has(n) &&
          pipelineStageFromLabels(byNumber.get(n)?.labels ?? []) === "ready-to-deploy",
      );
      if (!anyMergeEligible && frontier.every((n) => finished.has(n) || held.has(n))) {
        // all frontier parked or done — loop continues to recompute
      }
    }
  }

  if (held.size > 0 && !ordered.every((n) => finished.has(n) || held.has(n))) {
    // Some finished, some held — still partial success if merge complete for independents
  }

  if (held.size > 0) {
    const reasons = [...held].map((n) => {
      const it = itemByIssue.get(n);
      return `#${n}${it?.error ? `: ${it.error}` : ""}`;
    });
    // If any unfinished non-held remain, we already stopped above. Here all remaining held.
    if (!ordered.every((n) => finished.has(n) || held.has(n))) {
      blocker = `held items remain with unfinished work: ${reasons.join("; ")}`;
      nextAction = "stopped";
      return { exitCode: 1, status: status() };
    }
    blocker = `held: ${reasons.join("; ")}`;
    nextAction = "stopped";
    deps.log(`[train] STOP: ${blocker}`);
    return { exitCode: 1, status: status() };
  }

  if (!ordered.every((n) => finished.has(n))) {
    blocker = `train did not finish all items after ${maxWaves} waves`;
    nextAction = "stopped";
    return { exitCode: 1, status: status() };
  }

  currentIssue = null;
  nextAction = "complete";
  deps.log(`[train] complete (${items.length} item(s)${mergeMode ? ", all integrated" : ", ready-to-deploy"})`);
  return { exitCode: 0, status: status() };
    })();
    return result;
  } finally {
    const st = result?.status;
    const ended = deps.now?.() ?? new Date();
    await session.append("run_complete", {
      final_state: st?.complete ? "complete" : st?.blocker ? "stopped" : "error",
      elapsed_ms: Math.max(0, ended.getTime() - startedAt.getTime()),
      complete: st?.complete ?? false,
      blocker: st?.blocker ?? null,
      item_count: st?.items.length ?? 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Production deps
// ---------------------------------------------------------------------------

/**
 * Production ROADMAP.md edges for train discovery. Matches loop compile
 * `tryLoadRoadmapDeclaredEdges`: missing/unreadable files contribute no
 * edges (source stays enabled-empty, not omitted or unavailable).
 */
function loadRoadmapDeclaredEdges(repoDir: string): readonly RoadmapDeclaredEdge[] {
  try {
    const text = readFileSync(join(repoDir, "ROADMAP.md"), "utf8");
    return extractRoadmapDeclaredEdges(text);
  } catch {
    return [];
  }
}

export function realTrainDeps(opts: {
  repoDir: string;
  repo: string;
  baseBranch: string;
  /**
   * Multi-item frontier advance (preferred). Production wires one loop engine
   * call per frontier. When only single-item is available, wrap with
   * {@link advanceWaveFromSingle}.
   */
  advanceWave: (
    issues: readonly number[],
    ctx?: AdvanceWaveContext,
  ) => Promise<AdvanceWaveResult>;
  mergeDeps?: MergeDeps;
}): TrainDeps {
  const mergeDeps = opts.mergeDeps ?? realMergeDeps(opts.repo);
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.repoDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout).trim();
  };

  const discoverCfg = {
    repo: opts.repo,
    repo_dir: opts.repoDir,
    base_branch: opts.baseBranch,
  } as PipelineConfig;

  return {
    log(msg) {
      console.error(msg);
    },

    discoverDeps: realWorkListDependencyDiscoverDeps(discoverCfg, {
      getRoadmapDeclaredEdges: async () => loadRoadmapDeclaredEdges(opts.repoDir),
    }),
    resolveApprovedControlRoot: () => resolvePublicAdmissionPersistRoot({ repoDir: opts.repoDir }),

    async listMilestoneIssues(milestone) {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          opts.repo,
          "--milestone",
          milestone,
          "--state",
          "all",
          "--limit",
          String(MILESTONE_ISSUE_DISCOVERY_LIMIT),
          "--json",
          "number,title,body,labels,state",
        ],
        { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 },
      );
      const rows = JSON.parse(String(stdout)) as Array<{
        number: number;
        title: string;
        body: string;
        labels: Array<{ name: string }>;
        state: string;
      }>;
      assertMilestoneIssueDiscoveryLimit(rows.length, milestone, "train");
      return selectFreezeEligibleIssues(
        rows.map((r) => ({
          number: r.number,
          title: r.title ?? "",
          body: r.body ?? "",
          labels: (r.labels ?? []).map((l) => l.name),
          state: r.state === "CLOSED" || r.state === "closed" ? "closed" : "open",
        })),
      );
    },

    async getIssue(issue) {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "issue",
          "view",
          String(issue),
          "--repo",
          opts.repo,
          "--json",
          "number,title,body,labels,state",
        ],
        { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const r = JSON.parse(String(stdout)) as {
        number: number;
        title: string;
        body: string;
        labels: Array<{ name: string }>;
        state: string;
      };
      return {
        number: r.number,
        title: r.title ?? "",
        body: r.body ?? "",
        labels: (r.labels ?? []).map((l) => l.name),
        state: r.state === "CLOSED" || r.state === "closed" ? "closed" : "open",
      };
    },

    advanceWave: opts.advanceWave,

    async getPrForIssue(issue) {
      return mergeDeps.getPrForIssue(issue);
    },

    async getPrForIssueAnyState(issue) {
      const cfg = { repo: opts.repo } as PipelineConfig;
      return ghGetPrForIssueAnyState(cfg, issue);
    },

    async mergeIssuePr(pr) {
      await mergePr(pr, {
        ...mergeDeps,
        supervision: realMergeSupervision({
          repo: opts.repo,
          base: opts.baseBranch,
          repoDir: opts.repoDir,
          envelope: "pipeline train --merge",
          actionIdentity: "pipeline train --merge",
          mergeDeps,
        }),
      });
    },

    async observePr(pr) {
      const data = await mergeDeps.ghPrView(pr, [
        "state",
        "mergedAt",
        "mergeCommit",
        "headRefOid",
      ]);
      const stateRaw = String(data.state ?? "").toUpperCase();
      const mergeCommit = data.mergeCommit as { oid?: string } | null | undefined;
      const mergedAt = data.mergedAt;
      const isMerged =
        stateRaw === "MERGED" ||
        (mergedAt != null && String(mergedAt) !== "" && String(mergedAt) !== "null");
      return {
        state: isMerged ? "merged" : stateRaw === "CLOSED" ? "closed" : "open",
        mergeCommitOid: mergeCommit?.oid ?? null,
        headRefOid: data.headRefOid ? String(data.headRefOid) : null,
      };
    },

    async fetchBase(baseBranch) {
      await git(["fetch", "origin", baseBranch]);
    },

    async baseTip(baseBranch) {
      return git(["rev-parse", `origin/${baseBranch}`]);
    },

    async isAncestor(ancestor, descendant) {
      try {
        await execFileAsync(
          "git",
          ["merge-base", "--is-ancestor", ancestor, descendant],
          { cwd: opts.repoDir, timeout: 30_000 },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
