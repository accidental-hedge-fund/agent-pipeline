// Per-run snapshot cache for issue state, PR number, and worktree path.
//
// Eliminates redundant GitHub reads across pipeline bookkeeping callers that
// previously each issued independent gh calls at the same logical point in the
// run. Callers share one fetch per named refresh point instead.
//
// Design constraints:
//  - Accessors throw before the first successful refresh so stale-read bugs
//    surface immediately rather than silently propagating null/stale values.
//  - Two named refresh points correspond to the two moments new data matters:
//    after initial worktree setup, and after a fix commit lands.
//  - `getOnDiskForIssue` is used for the worktree path (zero GitHub calls);
//    `getIssueStateAndLabels` and `getPrForIssue` are the only gh-touching reads.

import { getIssueStateAndLabels, getPrForIssue } from "./gh.ts";
import { getOnDiskForIssue } from "./worktree.ts";
import type { PipelineConfig } from "./types.ts";

export interface RunStateCacheDeps {
  getIssueStateAndLabels?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ state: "open" | "closed"; labels: string[] } | null>;
  getPrForIssue?: (cfg: PipelineConfig, issueNumber: number) => Promise<number | null>;
  getOnDiskForIssue?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ path: string; slug: string } | null>;
}

export class RunStateCache {
  private readonly _issueNumber: number;
  private _populated = false;
  private _issueState: "open" | "closed" | null = null;
  private _labels: string[] = [];
  private _prNumber: number | null = null;
  private _worktreePath: string | null = null;
  private _worktreeSlug: string | null = null;

  constructor(issueNumber: number) {
    this._issueNumber = issueNumber;
  }

  get populated(): boolean {
    return this._populated;
  }

  private assertPopulated(field: string): void {
    if (!this._populated) {
      throw new Error(
        `RunStateCache: cannot read ${field} — cache not populated. Call refreshAfterSetup() first.`,
      );
    }
  }

  private async _refresh(cfg: PipelineConfig, deps: RunStateCacheDeps = {}): Promise<void> {
    const getStateFn = deps.getIssueStateAndLabels ?? getIssueStateAndLabels;
    const getPrFn = deps.getPrForIssue ?? getPrForIssue;
    const getWtFn = deps.getOnDiskForIssue ?? getOnDiskForIssue;
    const [stateResult, prResult, wtResult] = await Promise.all([
      getStateFn(cfg, this._issueNumber),
      getPrFn(cfg, this._issueNumber).catch(() => null),
      getWtFn(cfg, this._issueNumber).catch(() => null),
    ]);
    this._issueState = stateResult?.state ?? null;
    this._labels = stateResult?.labels ?? [];
    this._prNumber = prResult;
    this._worktreePath = wtResult?.path ?? null;
    this._worktreeSlug = wtResult?.slug ?? null;
    this._populated = true;
  }

  async refreshAfterSetup(cfg: PipelineConfig, deps: RunStateCacheDeps = {}): Promise<void> {
    await this._refresh(cfg, deps);
  }

  async refreshAfterFix(cfg: PipelineConfig, deps: RunStateCacheDeps = {}): Promise<void> {
    await this._refresh(cfg, deps);
  }

  get issueState(): "open" | "closed" | null {
    this.assertPopulated("issueState");
    return this._issueState;
  }

  get labels(): string[] {
    this.assertPopulated("labels");
    return this._labels;
  }

  get prNumber(): number | null {
    this.assertPopulated("prNumber");
    return this._prNumber;
  }

  get worktreePath(): string | null {
    this.assertPopulated("worktreePath");
    return this._worktreePath;
  }

  get worktreeSlug(): string | null {
    this.assertPopulated("worktreeSlug");
    return this._worktreeSlug;
  }
}
