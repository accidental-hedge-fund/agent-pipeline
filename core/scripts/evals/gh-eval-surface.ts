// The evaluation-mode GitHub surface (openspec/changes/stage-eval-runner, design.md
// decision 4): a `gh` seam that REFUSES every mutating operation and records the
// refusal, rather than relying on scattered `if (!evalMode)` guards at each call
// site. Any stage invoked in evaluation mode that is wired to this surface cannot
// perform a production write even if it tries.

export class GhWriteRefusedError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`Evaluation mode refused mutating GitHub operation: ${operation}`);
    this.name = "GhWriteRefusedError";
    this.operation = operation;
  }
}

export interface GhRefusalRecord {
  operation: string;
  args: unknown[];
}

export interface GhRefusalRecorder {
  record(refusal: GhRefusalRecord): void;
}

export function createRecordingRefusalRecorder(): GhRefusalRecorder & { refusals: GhRefusalRecord[] } {
  const refusals: GhRefusalRecord[] = [];
  return {
    refusals,
    record(refusal: GhRefusalRecord) {
      refusals.push(refusal);
    },
  };
}

/** The full set of mutating GitHub operations a stage might attempt. Named
 *  after their production counterparts in core/scripts/gh.ts (addLabel,
 *  addLabelToPr, removeLabel, postComment, createIssue, addIssueComment,
 *  postPrComment, transition, silentTransition, setBlocked, clearBlocked,
 *  closePr, reopenPr, createPr, mergePr, ensurePipelineLabels,
 *  createMilestone) plus a production-branch push, which happens outside
 *  gh.ts (in worktree/git code). */
export const MUTATING_GH_OPERATIONS = [
  "addLabel",
  "addLabelToPr",
  "removeLabel",
  "postComment",
  "createIssue",
  "addIssueComment",
  "postPrComment",
  "transition",
  "silentTransition",
  "setBlocked",
  "clearBlocked",
  "closePr",
  "reopenPr",
  "createPr",
  "mergePr",
  "ensurePipelineLabels",
  "createMilestone",
  "pushToProductionBranch",
] as const;
export type MutatingGhOperation = (typeof MUTATING_GH_OPERATIONS)[number];

export type EvalGhSurface = {
  [K in MutatingGhOperation]: (...args: unknown[]) => Promise<never>;
};

/** Build a `gh` surface where every mutating operation refuses and records
 *  the attempt instead of executing. Read operations are deliberately not
 *  part of this surface — a fixture's frozen issue/PR snapshot is local data,
 *  and evaluation mode restricts writes, not reads (design.md decision 4). */
export function createEvalGhSurface(recorder: GhRefusalRecorder): EvalGhSurface {
  const surface = {} as EvalGhSurface;
  for (const op of MUTATING_GH_OPERATIONS) {
    surface[op] = async (...args: unknown[]): Promise<never> => {
      recorder.record({ operation: op, args });
      throw new GhWriteRefusedError(op);
    };
  }
  return surface;
}
