// Evaluation-mode in-process GitHub surface (#607 / #637).
//
// Refuse-and-record seam for evaluator-owned *in-process* code that accepts a
// `gh` dependency. Local-CLI harness children do NOT receive this object —
// child write denial is enforced by the PATH deny shim + credential strip
// (boundary-shim / isolatedGhEnv), not by injecting EvalGhSurface into the
// external process. Keep this module for in-process seams and unit tests;
// do not thread it ornamentally through harness invoke args.

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
 *  updateIssueComment, postPrComment, transition, silentTransition, setBlocked, clearBlocked,
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
  "updateIssueComment",
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
 *  the attempt instead of executing. For in-process evaluator code only —
 *  not injected into local-CLI harness children (see module header). Read
 *  operations are deliberately not part of this surface. */
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
