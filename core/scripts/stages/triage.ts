// Triage sub-command (#216 / #1072): moves an issue between pre-pipeline stage
// labels (`pipeline:backlog` ↔ `pipeline:ready`) without a model harness.
//
// `--stage ready` validates the Decisions artifact first. Validation failure
// makes zero label-write API calls. `--stage backlog` stays a label write.

import {
  addLabel as ghAddLabel,
  getIssueDetail,
  getIssueStateAndLabels,
  removeLabel as ghRemoveLabel,
} from "../gh.ts";
import { validateDecisionsForReady, type GrillReadySnapshot } from "../grill-ready.ts";
import { listHandoffs } from "../human-question-handoff.ts";
import type { PipelineConfig } from "../types.ts";

export const ALLOWED_TRIAGE_STAGES = ["backlog", "ready"] as const;
export type TriageStage = (typeof ALLOWED_TRIAGE_STAGES)[number];

const PIPELINE_LABEL_PREFIX = "pipeline:";

export interface TriageDeps {
  getIssueLabels(issueNumber: number): Promise<string[]>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  log(msg: string): void;
  /** Required for `--stage ready`. Unused for backlog. */
  getReadySnapshot?(issueNumber: number): Promise<GrillReadySnapshot>;
}

/** Raw CLI inputs — validated inside runTriage so unit tests can probe error paths. */
export interface TriageInput {
  issueArg: string | undefined;
  stage: string | undefined;
}

export function realTriageDeps(cfg: PipelineConfig, snapshot?: GrillReadySnapshot): TriageDeps {
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
    getReadySnapshot: snapshot
      ? async () => snapshot
      : undefined,
  };
}

export async function realReadySnapshot(
  cfg: PipelineConfig,
  issueNumber: number,
  compute: () => Promise<Omit<GrillReadySnapshot, "title" | "body" | "comments">>,
): Promise<GrillReadySnapshot> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const extra = await compute();
  const handoffs = await listHandoffs(cfg.repo_dir, { issue: issueNumber });
  return {
    title: detail.title,
    body: detail.body,
    comments: detail.comments,
    ...extra,
    handoffs: extra.handoffs ?? handoffs,
  };
}

export function validateTriageInput(
  issueArg: string | undefined,
  stage: string | undefined,
): string | null {
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

export class TriageReadyError extends Error {
  readonly exitCode: number;
  readonly code: string;
  constructor(message: string, code: string, exitCode = 2) {
    super(message);
    this.name = "TriageReadyError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function runTriage(input: TriageInput, deps: TriageDeps): Promise<void> {
  const { issueArg, stage } = input;

  const validationError = validateTriageInput(issueArg, stage);
  if (validationError) {
    throw new Error(validationError);
  }

  const issueNumber = Number.parseInt(issueArg!, 10);
  const targetLabel = `${PIPELINE_LABEL_PREFIX}${stage}`;

  if (stage === "ready") {
    if (!deps.getReadySnapshot) {
      throw new TriageReadyError(
        "Decisions artifact validation requires a ready snapshot",
        "missing_artifact",
      );
    }
    const snapshot = await deps.getReadySnapshot(issueNumber);
    const ready = validateDecisionsForReady(snapshot);
    if (!ready.ok) {
      throw new TriageReadyError(ready.reason, ready.code);
    }
  }

  const labels = await deps.getIssueLabels(issueNumber);
  const currentPipelineLabels = labels.filter((l) => l.startsWith(PIPELINE_LABEL_PREFIX));

  if (currentPipelineLabels.length === 1 && currentPipelineLabels[0] === targetLabel) {
    deps.log(`[pipeline triage] already set: ${targetLabel}`);
    return;
  }

  if (!currentPipelineLabels.includes(targetLabel)) {
    await deps.addLabel(issueNumber, targetLabel);
  }

  const toRemove = currentPipelineLabels.filter((l) => l !== targetLabel);
  for (const label of toRemove) {
    await deps.removeLabel(issueNumber, label);
  }

  if (stage === "ready") {
    const after = await deps.getIssueLabels(issueNumber);
    let remaining = after.filter((l) => l.startsWith(PIPELINE_LABEL_PREFIX) && l !== targetLabel);
    if (remaining.length > 0) {
      for (const label of remaining) {
        await deps.removeLabel(issueNumber, label);
      }
      const retry = await deps.getIssueLabels(issueNumber);
      remaining = retry.filter((l) => l.startsWith(PIPELINE_LABEL_PREFIX) && l !== targetLabel);
      if (remaining.length > 0) {
        throw new TriageReadyError(
          `label_reconciliation_failed: extra pipeline labels remain (${remaining.join(", ")})`,
          "label_reconciliation_failed",
          1,
        );
      }
    }
  }

  if (toRemove.length > 0) {
    deps.log(`[pipeline triage] #${issueNumber}: ${toRemove.join(", ")} → ${targetLabel}`);
  } else {
    deps.log(`[pipeline triage] #${issueNumber}: added ${targetLabel}`);
  }
}
