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
//   headRefOid: string  (the head commit SHA at inspection time, threaded to
//                        --match-head-commit to prevent merging a different head)
//
// gh pr checks --required --json name,bucket (confirmed 2026-06-17):
//   JSON fields available: bucket, completedAt, description, event, link, name, startedAt, state, workflow
//   bucket: "pass" | "fail" | "pending" | "skipping" | "cancel"
//   --required: only emit checks that are required by branch protection rules
//
// gh pr merge --squash --delete-branch --match-head-commit <sha>:
//   Exits 0 on success; aborts if the PR head has advanced past <sha> since inspection.
//   May emit a stderr warning about the branch already being deleted (non-fatal).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Dependency-injection seam
// ---------------------------------------------------------------------------

export interface RequiredCheck {
  name: string;
  bucket: string;
}

export interface MergeDeps {
  ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>;
  /** Calls `gh pr checks <pr> --required --json name,bucket` and returns only
   *  required checks. This keeps optional pending/skipped/failed checks from
   *  blocking a merge where all required checks have passed. */
  ghPrChecksRequired(pr: number): Promise<RequiredCheck[]>;
  /** Calls `gh pr checks <pr> --json name,bucket` (without --required) and returns
   *  all observable check results. Used as a fallback safety gate when the base
   *  branch has no required checks configured. */
  ghPrChecksAll(pr: number): Promise<RequiredCheck[]>;
  /** Calls `gh pr merge --squash --delete-branch --match-head-commit <headRefOid>`.
   *  The headRefOid is fetched from ghPrView and binds the merge to the inspected
   *  head SHA, closing the TOCTOU race between gate inspection and merge execution. */
  ghPrMerge(pr: number, headRefOid: string): Promise<void>;
  getIssueLabels(issueNumber: number): Promise<string[]>;
  getPrLinkedIssue(pr: number): Promise<number | null>;
  /** Authoritative resolver: given an issue number, return the open same-repo PR
   *  that closes it (mirrors gh.ts resolvePrForIssue logic). Used to cross-validate
   *  that a closingIssuesReferences candidate actually maps back to the correct PR
   *  in this repository, guarding against cross-repo reference mismatches. */
  getPrForIssue(issueNumber: number): Promise<number | null>;
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

    async ghPrChecksRequired(pr) {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "checks", String(pr), "--required", "--json", "name,bucket", "-R", repo],
        { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as RequiredCheck[];
    },

    async ghPrChecksAll(pr) {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "checks", String(pr), "--json", "name,bucket", "-R", repo],
        { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as RequiredCheck[];
    },

    async ghPrMerge(pr, headRefOid) {
      try {
        await execFileAsync(
          "gh",
          [
            "pr", "merge", String(pr),
            "--squash", "--delete-branch",
            "--match-head-commit", headRefOid,
            "-R", repo,
          ],
          { timeout: 60_000 },
        );
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        const stderr = (String(e.stderr ?? "")).toLowerCase();
        // Treat "branch already deleted" as non-fatal: the merge succeeded but the
        // branch cleanup was a no-op (e.g. already removed by a prior attempt).
        // Only match the specific already-deleted condition — "could not delete"
        // alone can accompany a real failure (e.g. permissions) and must surface.
        if (stderr.includes("already deleted") || stderr.includes("branch not found")) {
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

    async getPrForIssue(issueNumber) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          [
            "pr", "list",
            "--json", "number,headRefName,isCrossRepository,closingIssuesReferences",
            "--state", "open",
            "-L", "100",
            "-R", repo,
          ],
          { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
        );
        const prs = JSON.parse(stdout) as Array<{
          number: number;
          headRefName: string;
          isCrossRepository?: boolean;
          closingIssuesReferences?: Array<{
            number: number;
            repository?: { name: string; owner: { login: string } };
          }>;
        }>;
        const branchPrefix = `pipeline/${issueNumber}-`;
        const repoLower = repo.toLowerCase();
        // Branch-name fast path (same-repo only), mirrors gh.ts resolvePrForIssue
        for (const pr of prs) {
          if (!pr.isCrossRepository && pr.headRefName.startsWith(branchPrefix)) {
            return pr.number;
          }
        }
        // Closing-reference check with repo-identity guard
        for (const pr of prs) {
          for (const ref of pr.closingIssuesReferences ?? []) {
            if (ref.repository) {
              const nameWithOwner =
                `${ref.repository.owner.login}/${ref.repository.name}`.toLowerCase();
              if (nameWithOwner === repoLower && ref.number === issueNumber) {
                return pr.number;
              }
            }
          }
        }
        return null;
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
  // mergeable === "MERGEABLE" — now require CLEAN mergeStateStatus
  if (mergeStateStatus === "BEHIND") {
    return (
      `PR merge state is BEHIND (the PR branch is behind the base branch). ` +
      `Rebase or merge the base branch into the PR branch, then retry.`
    );
  }
  if (mergeStateStatus === "BLOCKED") {
    return (
      `PR merge state is BLOCKED (a branch protection rule is preventing the merge). ` +
      `Check branch protection rules and required reviews, then retry.`
    );
  }
  if (mergeStateStatus === "HAS_HOOKS") {
    return (
      `PR merge state is HAS_HOOKS (pre-receive hooks are preventing the merge). ` +
      `Check repository hooks configuration, then retry.`
    );
  }
  if (mergeStateStatus !== "CLEAN") {
    return (
      `PR merge state is ${mergeStateStatus} (expected CLEAN). ` +
      `Resolve the blocking condition and retry.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate 2: required status checks
// ---------------------------------------------------------------------------

// Uses `gh pr checks --required --json name,bucket` to filter to only the
// checks that branch protection marks as required. Optional checks (pending,
// skipped, or failed) do not appear in this list and cannot block the merge.
//
// bucket values from `gh pr checks`: "pass" | "fail" | "pending" | "skipping" | "cancel"
// "pass" and "skipping" are non-blocking; everything else is a blocking condition.
function checkStatusChecks(requiredChecks: RequiredCheck[]): string | null {
  if (requiredChecks.length === 0) {
    return null;
  }

  const blocking: string[] = [];
  for (const check of requiredChecks) {
    const name = check.name ?? "unknown";
    const bucket = (check.bucket ?? "").toLowerCase();
    // "pass" = SUCCESS; "skipping" = NEUTRAL/SKIPPED (intentionally skipped required check)
    if (bucket !== "pass" && bucket !== "skipping") {
      blocking.push(`${name} (${bucket || "unknown"})`);
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

  // Cross-validate via the authoritative resolver: the issue must map back to this
  // exact PR in the same repository, guarding against cross-repo reference mismatches.
  const resolvedPr = await deps.getPrForIssue(linkedIssue);
  if (resolvedPr !== pr) {
    return (
      `Linked issue #${linkedIssue} does not resolve back to PR #${pr} ` +
      `(authoritative resolver returned ${resolvedPr ?? "null"}). ` +
      `Verify the "Closes #<issue>" reference and that the issue is in the same repository.`
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

  // Fetch mergeable state and the head SHA together. headRefOid is threaded
  // through to --match-head-commit so the merge is bound to the commit that
  // was inspected, closing the TOCTOU race between gate inspection and merge.
  const prData = await deps.ghPrView(pr, [
    "mergeable",
    "mergeStateStatus",
    "headRefOid",
  ]);

  const mergeabilityError = checkMergeability(
    String(prData.mergeable ?? "UNKNOWN"),
    String(prData.mergeStateStatus ?? "UNKNOWN"),
  );
  if (mergeabilityError) {
    throw new Error(mergeabilityError);
  }

  const headRefOid = String(prData.headRefOid ?? "");
  if (!headRefOid) {
    throw new Error(
      `PR #${pr}: could not determine head commit SHA (headRefOid was empty). ` +
      `Retry or check gh authentication.`,
    );
  }

  deps.log(`[pipeline merge] #${pr}: checking required status checks...`);
  let requiredChecks: RequiredCheck[];
  let noRequiredChecksConfigured = false;
  try {
    requiredChecks = await deps.ghPrChecksRequired(pr);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const errText = `${e.stderr ?? ""} ${e.message ?? ""}`;
    if (errText.includes("no required checks reported")) {
      noRequiredChecksConfigured = true;
      requiredChecks = [];
    } else {
      throw err;
    }
  }

  if (noRequiredChecksConfigured) {
    deps.log(`[pipeline merge] #${pr}: no required checks configured — verifying all observable checks as fallback...`);
    let allChecks: RequiredCheck[];
    try {
      allChecks = await deps.ghPrChecksAll(pr);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const errText = `${e.stderr ?? ""} ${e.message ?? ""}`;
      if (errText.includes("no checks reported")) {
        allChecks = [];
      } else {
        throw err;
      }
    }
    const blocking: string[] = [];
    for (const check of allChecks) {
      const bucket = (check.bucket ?? "").toLowerCase();
      if (bucket === "fail" || bucket === "pending" || bucket === "cancel") {
        blocking.push(`${check.name ?? "unknown"} (${bucket})`);
      }
    }
    if (blocking.length > 0) {
      throw new Error(
        `No required checks are configured, but observable checks are not all green:\n` +
        blocking.map((c) => `  - ${c}`).join("\n") +
        `\nFix or wait for the checks to pass, then retry.`,
      );
    }
  } else {
    const checksError = checkStatusChecks(requiredChecks!);
    if (checksError) {
      throw new Error(checksError);
    }
  }

  deps.log(`[pipeline merge] #${pr}: checking linked issue stage...`);
  const stageError = await checkIssueStage(pr, deps);
  if (stageError) {
    throw new Error(stageError);
  }

  deps.log(`[pipeline merge] #${pr}: all gates passed — squash-merging and deleting branch...`);
  await deps.ghPrMerge(pr, headRefOid);
  deps.log(`[pipeline merge] #${pr}: merged successfully.`);
}
