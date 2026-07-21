// pipeline/loop-execution@1 (#451): the one engine-neutral contract between a
// durable multi-item loop orchestrator (goal-loop) and per-item Agent Pipeline
// execution. See openspec/changes/pipeline-loop-facade/design.md decision 2.
//
// This is a documented data contract, not a transport: it names exactly what
// the orchestrator supplies and what Pipeline reports back, so the same
// description holds whether the run is driven by Claude Code or Codex.
//
// By construction, this module exposes no per-stage verb (no "advance one
// stage" function) — only the whole-item request/response shapes. That is
// deliberate: the orchestrator must hand off a whole item and never learn how
// Pipeline advances it stage by stage, which is what keeps the per-item
// advance loop from ever owning more than one issue (a stated non-goal).

export const LOOP_EXECUTION_CONTRACT_SCHEMA = "pipeline/loop-execution@1";

export type LoopEngine = "claude" | "codex";

/** How the orchestrator wants the per-item worktree handled. Opaque to the
 *  contract itself — Pipeline interprets the policy string using its own
 *  existing worktree conventions. */
export type LoopWorktreePolicy = string;

/** What "done" means for a selected item. Always the pipeline stage label the
 *  facade is permitted to treat as terminal — never a merge. */
export type LoopDoneDefinition = "pipeline:ready-to-deploy";

/** The request the orchestrator hands to per-item Pipeline execution. Carries
 *  a whole item, never a single stage transition. */
export interface LoopExecutionRequest {
  readonly schema: typeof LOOP_EXECUTION_CONTRACT_SCHEMA;
  /** Issue number (or other durable-store item id) being executed. */
  item_id: string;
  repo: {
    name: string;
    base_branch: string;
  };
  engine: LoopEngine;
  worktree_policy: LoopWorktreePolicy;
  done_definition: LoopDoneDefinition;
  /** goal-loop run id, threaded through for traceability only — Pipeline does
   *  not interpret or store it beyond echoing it back in the response. */
  run_id: string;
}

/** The only terminal outcomes per-item execution may report. Anything else is
 *  a protocol violation the orchestrator SHALL record as `failed` rather than
 *  silently retrying (see {@link isLoopTerminalOutcome}). */
export const LOOP_TERMINAL_OUTCOMES = [
  "ready_to_deploy",
  "blocked_needs_human",
  "failed",
  "abandoned",
] as const;

export type LoopTerminalOutcome = (typeof LOOP_TERMINAL_OUTCOMES)[number];

export function isLoopTerminalOutcome(value: unknown): value is LoopTerminalOutcome {
  return typeof value === "string" && (LOOP_TERMINAL_OUTCOMES as readonly string[]).includes(value);
}

/** Evidence pointer: a reference to where the proof lives, not a copy of it —
 *  the ledger stores this pointer, not the evidence itself. */
export interface LoopEvidencePointer {
  /** PR number, when one exists for this item. */
  pr_number: number | null;
  /** Agent Pipeline's own run id (`.agent-pipeline/runs/<run-id>`) for this item. */
  pipeline_run_id: string;
}

export interface LoopExecutionResponse {
  readonly schema: typeof LOOP_EXECUTION_CONTRACT_SCHEMA;
  item_id: string;
  run_id: string;
  outcome: LoopTerminalOutcome;
  evidence: LoopEvidencePointer;
}

/** Normalize an arbitrary reported outcome to a terminal one, per the "no
 *  silent retry" rule: an outcome outside {@link LOOP_TERMINAL_OUTCOMES} is
 *  recorded as `failed`. */
export function normalizeLoopOutcome(reported: unknown): LoopTerminalOutcome {
  return isLoopTerminalOutcome(reported) ? reported : "failed";
}
