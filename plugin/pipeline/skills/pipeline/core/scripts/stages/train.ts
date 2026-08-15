// Operator-authorized integrated train (#901 / #1023 / #1028 / #1063).
//
// Advance-only (`merge: false`): base-eligible frontier waves (loop recovery).
// `--merge` / Tugboat ship: **serial** — merge-first R2D, at most one implement
// at a time, STOP on blocked/needs-human. Never start a sibling. That is the
// anti-PR-farm rule. `pipeline loop` keeps frontier parallelism.
//
// Unit tests inject TrainDeps — no real network, git, or subprocess in tests.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDeclaredDependencyIds } from "../declared-dependency-grammar.ts";
import { getPrForIssueAnyState as ghGetPrForIssueAnyState } from "../gh.ts";
import { compileContractItems, type RawContractItem } from "../loop/dependencies.ts";
import { LoopError } from "../loop/types.ts";
import type { PipelineConfig } from "../types.ts";
import { mergePr, realMergeDeps, type MergeDeps } from "./merge.ts";

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
  | "parked";

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
}

export interface TrainOpts {
  /** Explicit issue numbers (positive integers). Mutually exclusive with empty+milestone-only. */
  issues?: readonly number[];
  /** Milestone title; used when issues is absent/empty. Also scopes engine-class live siblings. */
  milestone?: string;
  /** When true, merge each ready-to-deploy PR and prove base containment before dependents advance. */
  merge: boolean;
  baseBranch: string;
  repoDir: string;
  repo: string;
  /** Skip live advance when the issue is already at ready-to-deploy (default true). */
  skipAdvanceIfReady?: boolean;
}

export interface TrainResult {
  exitCode: number;
  status: TrainStatus;
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

export type AdvanceWaveResult = Map<number, AdvanceOutcome>;

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
   * Advance one base-eligible frontier as a single multi-item wave
   * (production: one loop/advance-wave call — not N×single). Must not merge.
   */
  advanceWave(issues: readonly number[]): Promise<AdvanceWaveResult>;
  /**
   * Legacy single-item advance. Used only when tests/adapters lack advanceWave
   * wiring via {@link advanceWaveFromSingle}. Prefer advanceWave in production.
   */
  advanceIssue?(issue: number): Promise<AdvanceOutcome>;
  /**
   * One supervisor recover-parked pass for a parked item (#1061).
   * Train MUST NOT invent override or drop blocked labels itself.
   * Default production wiring invokes `runRecoverParked`; tests inject fakes.
   */
  recoverParked?(issue: number): Promise<TrainRecoverParkedResult>;
  /** Open PR only — used when a merge mutation may still be required. */
  getPrForIssue(issue: number): Promise<number | null>;
  /**
   * Linked PR across open/closed/merged states (timeline-based).
   * Used for merge-mode already-integrated reconciliation after the open PR is gone.
   */
  getPrForIssueAnyState(issue: number): Promise<number | null>;
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
}

/** Result of reconciling a linked PR against base containment for integration. */
export type IntegratedReconcileResult =
  | { kind: "not-merged" }
  | { kind: "integrated"; mergeCommitOid: string | null }
  | { kind: "containment-failed"; mergeCommitOid: string; tip: string };

/**
 * Observe a PR and, when merged, prove merge-result containment in the fetched base.
 * When the PR is merged but no merge-result OID is available, treat as integrated
 * (observe already proved merged — #1014 closed+merged without OID).
 */
export async function reconcileMergedPrIntegration(
  pr: number,
  baseBranch: string,
  deps: Pick<TrainDeps, "observePr" | "fetchBase" | "baseTip" | "isAncestor">,
): Promise<IntegratedReconcileResult> {
  const obs = await deps.observePr(pr);
  if (obs.state !== "merged") return { kind: "not-merged" };
  if (!obs.mergeCommitOid) {
    return { kind: "integrated", mergeCommitOid: null };
  }
  await deps.fetchBase(baseBranch);
  const tip = await deps.baseTip(baseBranch);
  const contained = await deps.isAncestor(obs.mergeCommitOid, tip);
  if (contained) {
    return { kind: "integrated", mergeCommitOid: obs.mergeCommitOid };
  }
  return { kind: "containment-failed", mergeCommitOid: obs.mergeCommitOid, tip };
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

export function pipelineStageFromLabels(labels: readonly string[]): string | null {
  const stages = labels.filter((l) => l.startsWith("pipeline:"));
  if (stages.length === 0) return null;
  if (stages.length > 1) {
    throw new Error(`ambiguous pipeline stage labels: ${stages.join(", ")}`);
  }
  return stages[0]!.slice("pipeline:".length);
}


export function isReadyToDeploySnapshot(s: TrainIssueSnapshot): boolean {
  return pipelineStageFromLabels(s.labels) === "ready-to-deploy";
}

export function isBlockedOrNeedsHumanSnapshot(s: TrainIssueSnapshot): boolean {
  return s.labels.includes("blocked") || pipelineStageFromLabels(s.labels) === "needs-human";
}

/**
 * `--merge` order: already-R2D issues first (stable relative order), then the rest.
 * Declared-dep order is preserved inside each partition (#1063).
 */
export function orderIssuesForTrain(
  snapshots: readonly TrainIssueSnapshot[],
  mergeMode: boolean,
): number[] {
  const base = orderIssuesByDeclaredDeps(snapshots);
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
 * Build a dependency-ordered issue list from snapshots.
 * Uses declared lexical deps (#905 grammar) among in-list issues only.
 * Input order breaks topological ties (compileContractItems).
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
 * Code-dependency adjacency: issue → prerequisite issue numbers.
 * Unknown edge kind fails closed as a code dependency (#1023).
 */
export function codeDependencyMap(
  snapshots: readonly TrainIssueSnapshot[],
): Map<number, number[]> {
  const inList = new Set(snapshots.map((s) => s.number));
  const map = new Map<number, number[]>();
  for (const s of snapshots) {
    const text = `${s.title}\n${s.body}`;
    const deps = parseDeclaredDependencyIds(text, String(s.number))
      .map((id) => Number(id))
      .filter((n) => Number.isSafeInteger(n) && inList.has(n));
    map.set(s.number, deps);
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
 * True when S has no dependency edge to/from any held issue (declared deps only).
 * Fail closed: if any held issue shares an edge with S, independence is unproven.
 */
export function isIndependentOfHeld(
  issue: number,
  held: ReadonlySet<number>,
  codeDeps: ReadonlyMap<number, readonly number[]>,
): boolean {
  if (held.size === 0) return true;
  for (const h of held) {
    const depsS = codeDeps.get(issue) ?? [];
    const depsH = codeDeps.get(h) ?? [];
    if (depsS.includes(h) || depsH.includes(issue)) return false;
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
    snapshots = await deps.listMilestoneIssues(opts.milestone.trim());
    if (snapshots.length === 0) {
      throw new Error(`milestone ${JSON.stringify(opts.milestone)} has no open issues`);
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

  const ordered = orderIssuesForTrain(snapshots, mergeMode);
  const byNumber = new Map(snapshots.map((s) => [s.number, s]));
  const codeDeps = codeDependencyMap(snapshots);
  const mergeFirst = mergeMode
    ? ordered.filter((n) => isReadyToDeploySnapshot(byNumber.get(n)!))
    : [];

  deps.log(
    `[train] ordered issues: ${ordered.map((n) => `#${n}`).join(" → ")}` +
      (mergeMode
        ? ` (merge mode, serial ship; merge-first ${mergeFirst.length ? mergeFirst.map((n) => `#${n}`).join(", ") : "none"})`
        : " (advance only, frontier waves)"),
  );


  const items: TrainItemResult[] = [];
  const finished = new Set<number>();
  const held = new Set<number>();
  const integrated = new Set<number>();
  /** Per-wave-drive: at most one recover-parked attempt per issue (#1061). */
  const recoverParkedAttempted = new Set<number>();
  const itemByIssue = new Map<number, TrainItemResult>();
  let blocker: string | null = null;
  let nextAction: TrainNextAction = "advance";
  let currentIssue: number | null = ordered[0] ?? null;
  let currentIndex = 0;

  const pushItem = (item: TrainItemResult) => {
    items.push(item);
    itemByIssue.set(item.issue, item);
  };

  if (mergeMode) {
    for (const s of snapshots) {
      if (!isBlockedOrNeedsHumanSnapshot(s)) continue;
      const needsHuman = pipelineStageFromLabels(s.labels) === "needs-human";
      held.add(s.number);
      pushItem({
        issue: s.number,
        pr: null,
        terminal: needsHuman ? "needs-human" : "blocked",
        merge_result_oid: null,
        integrated: false,
        error: needsHuman
          ? `issue #${s.number} parked at pipeline:needs-human`
          : `issue #${s.number} is blocked`,
      });
      deps.log(
        `[train] #${s.number}: already ${needsHuman ? "needs-human" : "blocked"} — held (will not implement siblings)`,
      );
    }
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
    });

  const markFinished = (issue: number, item: TrainItemResult) => {
    pushItem(item);
    finished.add(issue);
    if (item.integrated) integrated.add(issue);
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
        const recon = await reconcileMergedPrIntegration(linkedPr, opts.baseBranch, deps);
        if (recon.kind === "integrated") {
          const oidNote =
            recon.mergeCommitOid != null
              ? ` merge ${recon.mergeCommitOid.slice(0, 12)}… in ${opts.baseBranch}`
              : "";
          deps.log(`[train] #${issue}: already integrated (PR #${linkedPr}${oidNote})`);
          markFinished(issue, {
            issue,
            pr: linkedPr,
            terminal: "already-integrated",
            merge_result_oid: recon.mergeCommitOid,
            integrated: true,
          });
          continue;
        }
        if (recon.kind === "containment-failed") {
          blocker =
            `merge result ${recon.mergeCommitOid} for #${issue} PR #${linkedPr} is not contained in ` +
            `fetched ${opts.baseBranch} tip ${recon.tip}`;
          nextAction = "stopped";
          pushItem({
            issue,
            pr: linkedPr,
            terminal: "ready-to-deploy",
            merge_result_oid: recon.mergeCommitOid,
            integrated: false,
            error: blocker,
          });
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }
      }
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
      if (held.size > 0) {
        blocker =
          `will not implement #${toAdvance[0]} while ` +
          `${[...held].map((h) => `#${h}`).join(", ")} is blocked/parked`;
        nextAction = "stopped";
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }
      toAdvance = [toAdvance[0]!];
    }

    if (toAdvance.length > 0) {
      currentIssue = toAdvance[0]!;
      currentIndex = ordered.indexOf(currentIssue);
      nextAction = "advance";
      deps.log(
        `[train] advance wave: ${toAdvance.map((n) => `#${n}`).join(", ")} ` +
          `(frontier ${frontier.map((n) => `#${n}`).join(", ")})`,
      );
      let waveResult: AdvanceWaveResult;
      try {
        waveResult = await advanceWave(toAdvance);
      } catch (err) {
        blocker = `advance wave failed: ${(err as Error).message}`;
        nextAction = "stopped";
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }

      for (const issue of toAdvance) {
        const advanced = waveResult.get(issue);
        if (!advanced) {
          blocker = `advance wave omitted outcome for #${issue}`;
          nextAction = "stopped";
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }
        if (!advanced.ok) {
          held.add(issue);
          pushItem({
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "error",
            merge_result_oid: null,
            integrated: false,
            error: advanced.error,
          });
          if (mergeMode) {
            blocker = advanced.error;
            nextAction = "stopped";
            deps.log(`[train] STOP: ${blocker} — will not implement another sibling`);
            return { exitCode: 1, status: status() };
          }
          continue;
        }
        const labels = advanced.labels;
        byNumber.set(issue, { ...byNumber.get(issue)!, labels });
        const stage =
          pipelineStageFromLabels(labels) ??
          (advanced.terminal === "ready-to-deploy" ? "ready-to-deploy" : null);

        if (advanced.terminal === "needs-human" || stage === "needs-human") {
          // #1061: one recover-parked pass per park before terminal hold.
          // Train never invents override or drops blocked labels itself.
          if (deps.recoverParked && !recoverParkedAttempted.has(issue)) {
            recoverParkedAttempted.add(issue);
            deps.log(`[train] recover-parked once for #${issue} (needs-human)`);
            let rp: TrainRecoverParkedResult;
            try {
              rp = await deps.recoverParked(issue);
            } catch (err) {
              rp = {
                status: "fail-closed",
                issue,
                message: `recover-parked threw: ${(err as Error).message}`,
              };
            }
            deps.log(
              `[train] recover-parked #${issue}: ${rp.status} — ${rp.message}`,
            );
            if (rp.status === "recovered" || rp.status === "deterministic-cleared") {
              // Same-issue continues on work list; refresh labels and do not hold.
              try {
                const refreshed = await deps.getIssue(issue);
                byNumber.set(issue, {
                  ...byNumber.get(issue)!,
                  labels: refreshed.labels,
                  body: refreshed.body,
                  title: refreshed.title,
                  state: refreshed.state,
                });
              } catch {
                /* keep prior labels; re-advance may still help next wave */
              }
              deps.log(
                `[train] #${issue}: recover-parked ${rp.status}; continuing same issue (no backlog restart)`,
              );
              continue;
            }
          }
          held.add(issue);
          const err =
            advanced.diagnostic ?? `issue #${issue} parked at pipeline:needs-human`;
          pushItem({
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "needs-human",
            merge_result_oid: null,
            integrated: false,
            error: err,
          });
          if (mergeMode) {
            blocker = err;
            nextAction = "stopped";
            deps.log(`[train] STOP: ${blocker} — will not implement another sibling`);
            return { exitCode: 1, status: status() };
          }
          deps.log(`[train] park #${issue}: needs-human (advance-only peers may continue)`);
          continue;
        }
        if (advanced.terminal === "blocked" || labels.includes("blocked")) {
          if (deps.recoverParked && !recoverParkedAttempted.has(issue)) {
            recoverParkedAttempted.add(issue);
            deps.log(`[train] recover-parked once for #${issue} (blocked)`);
            let rp: TrainRecoverParkedResult;
            try {
              rp = await deps.recoverParked(issue);
            } catch (err) {
              rp = {
                status: "fail-closed",
                issue,
                message: `recover-parked threw: ${(err as Error).message}`,
              };
            }
            deps.log(
              `[train] recover-parked #${issue}: ${rp.status} — ${rp.message}`,
            );
            if (rp.status === "recovered" || rp.status === "deterministic-cleared") {
              try {
                const refreshed = await deps.getIssue(issue);
                byNumber.set(issue, {
                  ...byNumber.get(issue)!,
                  labels: refreshed.labels,
                  body: refreshed.body,
                  title: refreshed.title,
                  state: refreshed.state,
                });
              } catch {
                /* keep prior */
              }
              deps.log(
                `[train] #${issue}: recover-parked ${rp.status}; continuing same issue (no backlog restart)`,
              );
              continue;
            }
          }
          held.add(issue);
          const err = advanced.diagnostic ?? `issue #${issue} is blocked`;
          pushItem({
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "blocked",
            merge_result_oid: null,
            integrated: false,
            error: err,
          });
          if (mergeMode) {
            blocker = err;
            nextAction = "stopped";
            deps.log(`[train] STOP: ${blocker} — will not implement another sibling`);
            return { exitCode: 1, status: status() };
          }
          deps.log(`[train] park #${issue}: blocked (advance-only peers may continue)`);
          continue;
        }
        if (stage !== "ready-to-deploy" && advanced.terminal !== "ready-to-deploy") {
          held.add(issue);
          const err =
            advanced.diagnostic ??
            `issue #${issue} did not reach ready-to-deploy (stage=${stage ?? advanced.terminal})`;
          pushItem({
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "error",
            merge_result_oid: null,
            integrated: false,
            error: err,
          });
          if (mergeMode) {
            blocker = err;
            nextAction = "stopped";
            deps.log(`[train] STOP: ${blocker} — will not implement another sibling`);
            return { exitCode: 1, status: status() };
          }
          deps.log(`[train] park #${issue}: ${err}`);
          continue;
        }
        // Reached R2D — labels updated; not finished until merge wave (merge mode)
        // or non-merge complete.
        if (!mergeMode) {
          markFinished(issue, {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "ready-to-deploy",
            merge_result_oid: null,
            integrated: false,
          });
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
    } else {
      // Entire frontier already R2D (skip advance)
      for (const issue of frontier) {
        if (!mergeMode && !finished.has(issue)) {
          markFinished(issue, {
            issue,
            pr: await deps.getPrForIssue(issue),
            terminal: "ready-to-deploy",
            merge_result_oid: null,
            integrated: false,
          });
        }
      }
    }

    // ---- Merge wave (serial) ----
    if (mergeMode) {
      nextAction = "merge";
      // Merge R2D frontier members that are not held/finished/integrated.
      // Independent sibling may merge while a peer is parked (no dep edge).
      for (const issue of frontier) {
        if (finished.has(issue) || held.has(issue) || integrated.has(issue)) continue;
        const snap = byNumber.get(issue) ?? (await deps.getIssue(issue));
        const stage = pipelineStageFromLabels(snap.labels);
        if (stage !== "ready-to-deploy") continue;

        // If any held peer exists and independence cannot be proven, fail closed.
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

        const pr = await deps.getPrForIssue(issue);
        if (pr == null) {
          const anyPr = await deps.getPrForIssueAnyState(issue);
          if (anyPr != null) {
            const recon = await reconcileMergedPrIntegration(anyPr, opts.baseBranch, deps);
            if (recon.kind === "integrated") {
              const oidNote =
                recon.mergeCommitOid != null
                  ? ` merge ${recon.mergeCommitOid.slice(0, 12)}… in ${opts.baseBranch}`
                  : "";
              deps.log(`[train] #${issue}: already integrated (PR #${anyPr}${oidNote})`);
              markFinished(issue, {
                issue,
                pr: anyPr,
                terminal: "already-integrated",
                merge_result_oid: recon.mergeCommitOid,
                integrated: true,
              });
              continue;
            }
            if (recon.kind === "containment-failed") {
              blocker =
                `merge result ${recon.mergeCommitOid} for #${issue} PR #${anyPr} is not contained in ` +
                `fetched ${opts.baseBranch} tip ${recon.tip}`;
              nextAction = "stopped";
              pushItem({
                issue,
                pr: anyPr,
                terminal: "ready-to-deploy",
                merge_result_oid: recon.mergeCommitOid,
                integrated: false,
                error: blocker,
              });
              deps.log(`[train] STOP: ${blocker}`);
              return { exitCode: 1, status: status() };
            }
          }
          blocker = `issue #${issue} is ready-to-deploy but has no linked open PR`;
          nextAction = "stopped";
          pushItem({
            issue,
            pr: null,
            terminal: "ready-to-deploy",
            merge_result_oid: null,
            integrated: false,
            error: blocker,
          });
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }

        let obs = await deps.observePr(pr);
        if (obs.state !== "merged") {
          deps.log(`[train] #${issue}: merging PR #${pr}…`);
          try {
            await deps.mergeIssuePr(pr);
          } catch (err) {
            blocker = `merge failed for #${issue} PR #${pr}: ${(err as Error).message}`;
            nextAction = "stopped";
            pushItem({
              issue,
              pr,
              terminal: "ready-to-deploy",
              merge_result_oid: null,
              integrated: false,
              error: blocker,
            });
            deps.log(`[train] STOP: ${blocker}`);
            return { exitCode: 1, status: status() };
          }
          obs = await deps.observePr(pr);
        }

        if (obs.state !== "merged" || !obs.mergeCommitOid) {
          blocker =
            `PR #${pr} for #${issue} is not merged with an observable merge commit ` +
            `(state=${obs.state}, mergeCommit=${obs.mergeCommitOid ?? "null"})`;
          nextAction = "stopped";
          pushItem({
            issue,
            pr,
            terminal: "ready-to-deploy",
            merge_result_oid: obs.mergeCommitOid,
            integrated: false,
            error: blocker,
          });
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }

        nextAction = "wait-for-base";
        deps.log(
          `[train] #${issue}: proving merge ${obs.mergeCommitOid.slice(0, 12)}… is in origin/${opts.baseBranch}…`,
        );
        await deps.fetchBase(opts.baseBranch);
        const tip = await deps.baseTip(opts.baseBranch);
        const contained = await deps.isAncestor(obs.mergeCommitOid, tip);
        if (!contained) {
          blocker =
            `merge result ${obs.mergeCommitOid} for #${issue} PR #${pr} is not contained in ` +
            `fetched ${opts.baseBranch} tip ${tip}`;
          nextAction = "stopped";
          pushItem({
            issue,
            pr,
            terminal: "ready-to-deploy",
            merge_result_oid: obs.mergeCommitOid,
            integrated: false,
            error: blocker,
          });
          deps.log(`[train] STOP: ${blocker}`);
          return { exitCode: 1, status: status() };
        }

        deps.log(`[train] #${issue}: integrated (PR #${pr})`);
        markFinished(issue, {
          issue,
          pr,
          terminal: "ready-to-deploy",
          merge_result_oid: obs.mergeCommitOid,
          integrated: true,
        });
        nextAction = "next-item";
      }
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
}

// ---------------------------------------------------------------------------
// Production deps
// ---------------------------------------------------------------------------

export function realTrainDeps(opts: {
  repoDir: string;
  repo: string;
  baseBranch: string;
  /**
   * Multi-item frontier advance (preferred). Production wires one loop engine
   * call per frontier. When only single-item is available, wrap with
   * {@link advanceWaveFromSingle}.
   */
  advanceWave: (issues: readonly number[]) => Promise<AdvanceWaveResult>;
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

  return {
    log(msg) {
      console.error(msg);
    },

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
          "open",
          "--limit",
          "200",
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
      return rows.map((r) => ({
        number: r.number,
        title: r.title ?? "",
        body: r.body ?? "",
        labels: (r.labels ?? []).map((l) => l.name),
        state: r.state === "CLOSED" || r.state === "closed" ? "closed" : "open",
      }));
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
      await mergePr(pr, mergeDeps);
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
