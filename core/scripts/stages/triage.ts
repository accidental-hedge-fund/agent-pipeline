// Triage sub-command (#216): moves an issue between pre-pipeline stage labels
// (`pipeline:backlog` ↔ `pipeline:ready`) without manual `gh issue edit`.
//
// Fully deterministic — no model harness call. All external I/O is injected
// via TriageDeps so unit tests use no real network, git, or subprocess calls.

import {
  addLabel as ghAddLabel,
  getIssueStateAndLabels,
  removeLabel as ghRemoveLabel,
} from "../gh.ts";
import type { PipelineConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const ALLOWED_TRIAGE_STAGES = ["backlog", "ready"] as const;
export type TriageStage = (typeof ALLOWED_TRIAGE_STAGES)[number];

const PIPELINE_LABEL_PREFIX = "pipeline:";

export interface TriageDeps {
  getIssueLabels(issueNumber: number): Promise<string[]>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  log(msg: string): void;
}

/** Raw CLI inputs — validated inside runTriage so unit tests can probe error paths. */
export interface TriageInput {
  issueArg: string | undefined;
  stage: string | undefined;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realTriageDeps(cfg: PipelineConfig): TriageDeps {
  return {
    getIssueLabels: async (issueNumber) => {
      const result = await getIssueStateAndLabels(cfg, issueNumber);
      if (!result) {
        throw new Error(`[pipeline triage] could not fetch labels for issue #${issueNumber}`);
      }
      return result.labels;
    },
    addLabel: async (issueNumber, label) => {
      await ghAddLabel(cfg, issueNumber, label);
    },
    removeLabel: async (issueNumber, label) => {
      await ghRemoveLabel(cfg, issueNumber, label);
    },
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Pure validation helper (no deps — safe to call before config resolution)
// ---------------------------------------------------------------------------

/**
 * Validates raw triage CLI inputs. Returns an error message string on the first
 * violation, or null if both inputs are valid. Calling this before resolveConfig()
 * ensures invalid commands never trigger a GitHub API call.
 */
export function validateTriageInput(
  issueArg: string | undefined,
  stage: string | undefined,
): string | null {
  // Full-string check rejects "42abc", "42.9", "1e2", "0", etc.
  if (!issueArg || !/^[1-9]\d*$/.test(issueArg)) {
    return (
      `issue number is required and must be a positive integer` +
      (issueArg ? ` (got: "${issueArg}")` : "")
    );
  }
  if (!stage) {
    return `--stage is required. Allowed values: ${ALLOWED_TRIAGE_STAGES.join(", ")}`;
  }
  if (!(ALLOWED_TRIAGE_STAGES as readonly string[]).includes(stage)) {
    return (
      `"${stage}" is not a valid triage stage. ` +
      `Allowed values: ${ALLOWED_TRIAGE_STAGES.join(", ")}. ` +
      `Mid-flight stages (planning, review-1, etc.) are owned by the advance state machine.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runTriage(input: TriageInput, deps: TriageDeps): Promise<void> {
  const { issueArg, stage } = input;

  const validationError = validateTriageInput(issueArg, stage);
  if (validationError) {
    throw new Error(validationError);
  }

  const issueNumber = Number.parseInt(issueArg!, 10);
  const targetLabel = `${PIPELINE_LABEL_PREFIX}${stage}`;

  // Fetch current labels — first GitHub read; only reached after input validation.
  const labels = await deps.getIssueLabels(issueNumber);
  const currentPipelineLabels = labels.filter((l) => l.startsWith(PIPELINE_LABEL_PREFIX));

  // Idempotent: already carries exactly the target label, nothing to do.
  if (currentPipelineLabels.length === 1 && currentPipelineLabels[0] === targetLabel) {
    deps.log(`[pipeline triage] already set: ${targetLabel}`);
    return;
  }

  // Add-first: ensure the target label is present before removing stale ones.
  // If the add succeeds but a later remove fails, the issue still carries the
  // correct target label and is never left without a pipeline stage.
  if (!currentPipelineLabels.includes(targetLabel)) {
    await deps.addLabel(issueNumber, targetLabel);
  }

  // Remove every pipeline:* label except the target.
  const toRemove = currentPipelineLabels.filter((l) => l !== targetLabel);
  for (const label of toRemove) {
    await deps.removeLabel(issueNumber, label);
  }

  // Log the transition.
  if (toRemove.length > 0) {
    deps.log(`[pipeline triage] #${issueNumber}: ${toRemove.join(", ")} → ${targetLabel}`);
  } else {
    deps.log(`[pipeline triage] #${issueNumber}: added ${targetLabel}`);
  }
}
