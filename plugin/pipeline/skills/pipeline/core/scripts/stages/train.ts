// Operator-authorized integrated train (#901 / factory simplification Phase 1).
//
// Loop-isolated CLI surface: advances ordered issues (via injected single/advance
// driver), optionally merges each ready-to-deploy PR through the existing merge
// surface, proves squash-aware merge-result containment in the configured base,
// then starts the next item. Never reachable from advance stage dispatch.
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
  | "error";

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
  /** Milestone title; used when issues is absent/empty. */
  milestone?: string;
  /** When true, merge each ready-to-deploy PR and prove base containment before the next item. */
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
  | { ok: true; terminal: "ready-to-deploy" | "needs-human" | "blocked" | "other"; labels: string[] }
  | { ok: false; error: string };

export interface TrainDeps {
  log(msg: string): void;
  listMilestoneIssues(milestone: string): Promise<TrainIssueSnapshot[]>;
  getIssue(issue: number): Promise<TrainIssueSnapshot>;
  /** Drive one issue through the existing single/advance path until a terminal stage. */
  advanceIssue(issue: number): Promise<AdvanceOutcome>;
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

export function buildTrainStatus(partial: Omit<TrainStatus, "schema_version" | "kind">): TrainStatus {
  return { schema_version: 1, kind: "train_status", ...partial };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runTrain(opts: TrainOpts, deps: TrainDeps): Promise<TrainResult> {
  const mergeMode = !!opts.merge;
  const skipIfReady = opts.skipAdvanceIfReady !== false;

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

  const ordered = orderIssuesByDeclaredDeps(snapshots);
  const byNumber = new Map(snapshots.map((s) => [s.number, s]));

  deps.log(
    `[train] ordered issues: ${ordered.map((n) => `#${n}`).join(" → ")}` +
      (mergeMode ? " (merge mode)" : " (advance only)"),
  );

  const items: TrainItemResult[] = [];
  let blocker: string | null = null;
  let nextAction: TrainNextAction = "advance";
  let currentIssue: number | null = ordered[0] ?? null;
  let currentIndex = 0;

  const status = (): TrainStatus =>
    buildTrainStatus({
      ordered_issues: ordered,
      current_issue: currentIssue,
      current_index: currentIndex,
      next_action: nextAction,
      merge_mode: mergeMode,
      items: [...items],
      blocker,
      complete: blocker === null && items.length === ordered.length && items.every((i) =>
        mergeMode ? i.integrated : i.terminal === "ready-to-deploy" || i.terminal === "already-integrated",
      ),
    });

  for (let i = 0; i < ordered.length; i++) {
    const issue = ordered[i]!;
    currentIssue = issue;
    currentIndex = i;
    nextAction = "advance";

    let snap = byNumber.get(issue) ?? (await deps.getIssue(issue));
    let stage = pipelineStageFromLabels(snap.labels);

    // Idempotent: already merged PR + base containment → skip before advance.
    // Any-state (closed/merged) lookup is only for ready-to-deploy terminals —
    // pre-R2D / reopened items may retain a historical merged PR and must still
    // advance (#1014 review). Open-PR reconciliation remains available at any stage.
    if (mergeMode) {
      const openPr = await deps.getPrForIssue(issue);
      const linkedPr =
        openPr ??
        (stage === "ready-to-deploy" ? await deps.getPrForIssueAnyState(issue) : null);
      if (linkedPr != null) {
        const recon = await reconcileMergedPrIntegration(linkedPr, opts.baseBranch, deps);
        if (recon.kind === "integrated") {
          const oidNote =
            recon.mergeCommitOid != null
              ? ` merge ${recon.mergeCommitOid.slice(0, 12)}… in ${opts.baseBranch}`
              : "";
          deps.log(`[train] #${issue}: already integrated (PR #${linkedPr}${oidNote})`);
          items.push({
            issue,
            pr: linkedPr,
            terminal: "already-integrated",
            merge_result_oid: recon.mergeCommitOid,
            integrated: true,
          });
          nextAction = "next-item";
          continue;
        }
        if (recon.kind === "containment-failed") {
          // Merged linked PR (open-lookup race or any-state) not in base → stop
          // before advance or merge work. Do not require openPr == null: an
          // open-first race can observe merged+uncontained while openPr is set.
          blocker =
            `merge result ${recon.mergeCommitOid} for #${issue} PR #${linkedPr} is not contained in ` +
            `fetched ${opts.baseBranch} tip ${recon.tip}`;
          nextAction = "stopped";
          items.push({
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

    if (!(skipIfReady && stage === "ready-to-deploy")) {
      deps.log(`[train] #${issue}: advancing (stage=${stage ?? "none"})…`);
      nextAction = "advance";
      const advanced = await deps.advanceIssue(issue);
      if (!advanced.ok) {
        blocker = `advance failed for #${issue}: ${advanced.error}`;
        nextAction = "stopped";
        items.push({
          issue,
          pr: null,
          terminal: "error",
          merge_result_oid: null,
          integrated: false,
          error: advanced.error,
        });
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }
      snap = { ...snap, labels: advanced.labels };
      stage = pipelineStageFromLabels(advanced.labels) ??
        (advanced.terminal === "ready-to-deploy" ? "ready-to-deploy" : null);

      if (advanced.terminal === "needs-human" || stage === "needs-human") {
        blocker = `issue #${issue} parked at pipeline:needs-human`;
        nextAction = "stopped";
        items.push({
          issue,
          pr: await deps.getPrForIssue(issue),
          terminal: "needs-human",
          merge_result_oid: null,
          integrated: false,
          error: blocker,
        });
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }
      if (advanced.terminal === "blocked" || snap.labels.includes("blocked")) {
        blocker = `issue #${issue} is blocked`;
        nextAction = "stopped";
        items.push({
          issue,
          pr: await deps.getPrForIssue(issue),
          terminal: "blocked",
          merge_result_oid: null,
          integrated: false,
          error: blocker,
        });
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }
      if (stage !== "ready-to-deploy" && advanced.terminal !== "ready-to-deploy") {
        blocker = `issue #${issue} did not reach ready-to-deploy (stage=${stage ?? advanced.terminal})`;
        nextAction = "stopped";
        items.push({
          issue,
          pr: await deps.getPrForIssue(issue),
          terminal: "error",
          merge_result_oid: null,
          integrated: false,
          error: blocker,
        });
        deps.log(`[train] STOP: ${blocker}`);
        return { exitCode: 1, status: status() };
      }
      stage = "ready-to-deploy";
    } else {
      deps.log(`[train] #${issue}: already at ready-to-deploy`);
    }

    if (!mergeMode) {
      items.push({
        issue,
        pr: await deps.getPrForIssue(issue),
        terminal: "ready-to-deploy",
        merge_result_oid: null,
        integrated: false,
      });
      nextAction = "next-item";
      continue;
    }

    // Merge wave
    nextAction = "merge";
    const pr = await deps.getPrForIssue(issue);
    if (pr == null) {
      // No open PR: reconcile any-state (merged/closed) before failing closed.
      const anyPr = await deps.getPrForIssueAnyState(issue);
      if (anyPr != null) {
        const recon = await reconcileMergedPrIntegration(anyPr, opts.baseBranch, deps);
        if (recon.kind === "integrated") {
          const oidNote =
            recon.mergeCommitOid != null
              ? ` merge ${recon.mergeCommitOid.slice(0, 12)}… in ${opts.baseBranch}`
              : "";
          deps.log(`[train] #${issue}: already integrated (PR #${anyPr}${oidNote})`);
          items.push({
            issue,
            pr: anyPr,
            terminal: "already-integrated",
            merge_result_oid: recon.mergeCommitOid,
            integrated: true,
          });
          nextAction = "next-item";
          continue;
        }
        if (recon.kind === "containment-failed") {
          blocker =
            `merge result ${recon.mergeCommitOid} for #${issue} PR #${anyPr} is not contained in ` +
            `fetched ${opts.baseBranch} tip ${recon.tip}`;
          nextAction = "stopped";
          items.push({
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
        // Linked PR exists but is not merged (e.g. closed unmerged) → same
        // fail-closed class as missing open PR for merge-eligible work.
      }
      blocker = `issue #${issue} is ready-to-deploy but has no linked open PR`;
      nextAction = "stopped";
      items.push({
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

    // Idempotent re-check: may have merged during advance
    let obs = await deps.observePr(pr);
    if (obs.state !== "merged") {
      deps.log(`[train] #${issue}: merging PR #${pr}…`);
      try {
        await deps.mergeIssuePr(pr);
      } catch (err) {
        blocker = `merge failed for #${issue} PR #${pr}: ${(err as Error).message}`;
        nextAction = "stopped";
        items.push({
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
      items.push({
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
      items.push({
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
    items.push({
      issue,
      pr,
      terminal: "ready-to-deploy",
      merge_result_oid: obs.mergeCommitOid,
      integrated: true,
    });
    nextAction = "next-item";
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
  /** Invokes pipeline single / loop engine for one issue. Injected so CLI can wire runSingleIssueCommand. */
  advanceIssue: (issue: number) => Promise<AdvanceOutcome>;
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

    advanceIssue: opts.advanceIssue,

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
