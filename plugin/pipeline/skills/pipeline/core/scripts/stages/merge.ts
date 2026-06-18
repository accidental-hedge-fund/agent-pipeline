// Human-invoked merge sub-command (#217): squash-merges a ready-to-deploy PR and
// deletes its head branch. NEVER called from the autonomous advance loop — the
// loop-isolation guarantee is structural (no import from any stage handler) and is
// backed by a unit test in core/test/merge.test.ts.
//
// This is the controlled, explicit surface for pipeline operators (or pipeline-desk
// on a human button click) to merge after ready-to-deploy. Rule #4 from CLAUDE.md
// ("The pipeline never merges") refers to the autonomous loop; this sub-command is
// the human-gated exception.
//
// gh pr view field shapes (confirmed 2026-06-17 against agent-pipeline PR #219):
//   mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
//   mergeStateStatus: "CLEAN" | "DIRTY" | "UNKNOWN" | "BEHIND" | "BLOCKED" | "HAS_HOOKS"
//   statusCheckRollup: Array<{
//     name: string;
//     status: "COMPLETED" | "IN_PROGRESS" | "QUEUED" | "WAITING";
//     conclusion: "SUCCESS" | "FAILURE" | "TIMED_OUT" | "CANCELLED" | "NEUTRAL" |
//                 "SKIPPED" | "ACTION_REQUIRED" | null;
//     __typename: string;
//   }> | null
//
// gh pr merge --squash --delete-branch: exits 0 on success; may emit a stderr
// warning about the branch already being deleted (non-fatal). No structured output
// is parsed — success is exit 0, failure is non-zero exit.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Dependency-injection seam
// ---------------------------------------------------------------------------

export interface MergeDeps {
  ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>;
  ghPrMerge(pr: number): Promise<void>;
  getIssueLabels(issueNumber: number): Promise<string[]>;
  getPrLinkedIssue(pr: number): Promise<number | null>;
  log(msg: string): void;
}

export function realMergeDeps(repo: string): MergeDeps {
  return {
    async ghPrView(pr, fields) {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", String(pr), "--json", fields.join(","), "-R", repo],
        { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    },

    async ghPrMerge(pr) {
      try {
        await execFileAsync(
          "gh",
          ["pr", "merge", String(pr), "--squash", "--delete-branch", "-R", repo],
          { timeout: 60_000 },
        );
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        const stderr = (String(e.stderr ?? "")).toLowerCase();
        // Treat "branch already deleted" as non-fatal: the merge succeeded but the
        // branch cleanup was a no-op (e.g. already removed by a prior attempt).
        if (
          stderr.includes("already deleted") ||
          stderr.includes("branch not found") ||
          stderr.includes("could not delete")
        ) {
          return;
        }
        const raw = String(e.stderr ?? e.message).trim();
        throw new Error(`gh pr merge failed: ${raw}`);
      }
    },

    async getIssueLabels(issueNumber) {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "issue",
          "view",
          String(issueNumber),
          "--json",
          "labels",
          "--jq",
          ".labels[].name",
          "-R",
          repo,
        ],
        { timeout: 30_000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    },

    async getPrLinkedIssue(pr) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["pr", "view", String(pr), "--json", "closingIssuesReferences", "-R", repo],
          { timeout: 30_000 },
        );
        const data = JSON.parse(stdout) as {
          closingIssuesReferences?: { number: number }[];
        };
        const refs = data.closingIssuesReferences ?? [];
        return refs.length > 0 ? refs[0].number : null;
      } catch {
        return null;
      }
    },

    log(msg) {
      console.log(msg);
    },
  };
}

// ---------------------------------------------------------------------------
// Gate 1: mergeability
// ---------------------------------------------------------------------------

function checkMergeability(
  mergeable: string,
  mergeStateStatus: string,
): string | null {
  if (mergeable === "UNKNOWN") {
    return (
      `PR mergeability is not yet computed (UNKNOWN). ` +
      `GitHub is still evaluating — wait a few seconds and retry \`pipeline merge\`.`
    );
  }
  if (mergeable === "CONFLICTING") {
    return (
      `PR has merge conflicts (mergeable: CONFLICTING). ` +
      `Resolve the conflicts and push a new commit, then retry.`
    );
  }
  if (mergeStateStatus === "DIRTY") {
    return (
      `PR merge state is DIRTY (the base branch may have diverged). ` +
      `Rebase or merge the base branch into the PR branch, then retry.`
    );
  }
  if (mergeable !== "MERGEABLE") {
    return (
      `PR cannot be merged: mergeable=${mergeable}, mergeStateStatus=${mergeStateStatus}. ` +
      `Resolve the blocking condition and retry.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate 2: required status checks
// ---------------------------------------------------------------------------

interface StatusCheck {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

function checkStatusChecks(statusCheckRollup: unknown): string | null {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }

  const blocking: string[] = [];
  for (const check of statusCheckRollup as StatusCheck[]) {
    const name = check.name ?? "unknown";
    const status = (check.status ?? "").toUpperCase();
    const conclusion = (check.conclusion ?? "").toUpperCase();

    if (status !== "COMPLETED") {
      // Still running or queued — pending
      blocking.push(`${name} (${status.toLowerCase()})`);
      continue;
    }
    if (
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED"
    ) {
      blocking.push(`${name} (${conclusion.toLowerCase()})`);
    }
  }

  if (blocking.length === 0) return null;

  return (
    `PR has failing or pending required checks:\n` +
    blocking.map((c) => `  - ${c}`).join("\n") +
    `\nFix or wait for the checks to pass, then retry.`
  );
}

// ---------------------------------------------------------------------------
// Gate 3: linked issue stage
// ---------------------------------------------------------------------------

async function checkIssueStage(
  pr: number,
  deps: MergeDeps,
): Promise<string | null> {
  const linkedIssue = await deps.getPrLinkedIssue(pr);
  if (linkedIssue === null) {
    return (
      `PR #${pr} has no linked pipeline issue (no closing-issue reference found). ` +
      `Add "Closes #<issue>" to the PR body and retry, or verify the issue link.`
    );
  }

  const labels = await deps.getIssueLabels(linkedIssue);
  if (labels.includes("pipeline:ready-to-deploy")) {
    return null;
  }

  const pipelineLabel = labels.find((l) => l.startsWith("pipeline:"));
  const currentStage = pipelineLabel ?? "(no pipeline label)";
  return (
    `Linked issue #${linkedIssue} is not at pipeline:ready-to-deploy ` +
    `(current stage: ${currentStage}). ` +
    `Let the pipeline advance the issue to ready-to-deploy first, then retry.`
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function mergePr(pr: number, deps: MergeDeps): Promise<void> {
  deps.log(`[pipeline merge] #${pr}: checking mergeability...`);

  const prData = await deps.ghPrView(pr, [
    "mergeable",
    "mergeStateStatus",
    "statusCheckRollup",
  ]);

  const mergeabilityError = checkMergeability(
    String(prData.mergeable ?? "UNKNOWN"),
    String(prData.mergeStateStatus ?? "UNKNOWN"),
  );
  if (mergeabilityError) {
    throw new Error(mergeabilityError);
  }

  deps.log(`[pipeline merge] #${pr}: checking required status checks...`);
  const checksError = checkStatusChecks(prData.statusCheckRollup);
  if (checksError) {
    throw new Error(checksError);
  }

  deps.log(`[pipeline merge] #${pr}: checking linked issue stage...`);
  const stageError = await checkIssueStage(pr, deps);
  if (stageError) {
    throw new Error(stageError);
  }

  deps.log(`[pipeline merge] #${pr}: all gates passed — squash-merging and deleting branch...`);
  await deps.ghPrMerge(pr);
  deps.log(`[pipeline merge] #${pr}: merged successfully.`);
}
