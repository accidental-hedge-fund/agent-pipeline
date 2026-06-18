// Triage sub-command (#216): moves an issue between pre-pipeline stage labels
// (`pipeline:backlog` ↔ `pipeline:ready`) without manual `gh issue edit`.
//
// Fully deterministic — no model harness call. All external I/O is injected
// via TriageDeps so unit tests use no real network, git, or subprocess calls.

import { spawnSync } from "node:child_process";

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

export function realTriageDeps(repoDir: string): TriageDeps {
  return {
    getIssueLabels: async (issueNumber) => {
      const result = spawnSync(
        "gh",
        ["issue", "view", String(issueNumber), "--json", "labels", "--jq", ".labels[].name"],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline triage] gh issue view failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      return result.stdout.trim().split("\n").filter(Boolean);
    },
    addLabel: async (issueNumber, label) => {
      const result = spawnSync(
        "gh",
        ["issue", "edit", String(issueNumber), "--add-label", label],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline triage] gh issue edit --add-label "${label}" failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    removeLabel: async (issueNumber, label) => {
      const result = spawnSync(
        "gh",
        ["issue", "edit", String(issueNumber), "--remove-label", label],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline triage] gh issue edit --remove-label "${label}" failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runTriage(input: TriageInput, deps: TriageDeps): Promise<void> {
  const { issueArg, stage } = input;

  // Validate issue number
  const issueNumber = Number.parseInt(issueArg ?? "", 10);
  if (!issueArg || !Number.isFinite(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `issue number is required and must be a positive integer` +
        (issueArg ? ` (got: "${issueArg}")` : ""),
    );
  }

  // Validate --stage is present
  if (!stage) {
    throw new Error(
      `--stage is required. Allowed values: ${ALLOWED_TRIAGE_STAGES.join(", ")}`,
    );
  }

  // Validate --stage is a pre-pipeline stage
  if (!(ALLOWED_TRIAGE_STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `"${stage}" is not a valid triage stage. ` +
        `Allowed values: ${ALLOWED_TRIAGE_STAGES.join(", ")}. ` +
        `Mid-flight stages (planning, review-1, etc.) are owned by the advance state machine.`,
    );
  }

  const targetLabel = `${PIPELINE_LABEL_PREFIX}${stage}`;

  // Fetch current labels — first GitHub read; only reached after input validation.
  const labels = await deps.getIssueLabels(issueNumber);
  const currentPipelineLabels = labels.filter((l) => l.startsWith(PIPELINE_LABEL_PREFIX));

  // Idempotent: already carries exactly the target label, nothing to do.
  if (currentPipelineLabels.length === 1 && currentPipelineLabels[0] === targetLabel) {
    deps.log(`[pipeline triage] already set: ${targetLabel}`);
    return;
  }

  // Remove every pipeline:* label except the target.
  const toRemove = currentPipelineLabels.filter((l) => l !== targetLabel);
  for (const label of toRemove) {
    await deps.removeLabel(issueNumber, label);
  }

  // Add the target label if not already present.
  if (!currentPipelineLabels.includes(targetLabel)) {
    await deps.addLabel(issueNumber, targetLabel);
  }

  // Log the transition.
  if (toRemove.length > 0) {
    deps.log(`[pipeline triage] #${issueNumber}: ${toRemove.join(", ")} → ${targetLabel}`);
  } else {
    deps.log(`[pipeline triage] #${issueNumber}: added ${targetLabel}`);
  }
}
