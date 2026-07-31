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
//
// Base-bound path (when expectedBaseBranch is set — merge-queue drive):
//   `gh pr merge` only binds head via --match-head-commit; a PR retarget after the
//   client-side baseRefName gate can still land the squash on another base. The
//   base-bound path instead squash-creates a commit onto the *named* expected base
//   tip (Git Data API) and fast-forward updates that ref (force=false CAS). The
//   irreversible write targets refs/heads/<expectedBase> only — PR base retarget
//   cannot redirect the destination.

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

/** Options for the irreversible merge write. */
export interface GhPrMergeOptions {
  /**
   * When set, the production merge MUST land on this named base via a
   * server-enforced base-bound squash (explicit base ref update). Must not
   * rely solely on the PR's live `baseRefName` at `gh pr merge` time.
   */
  expectedBaseBranch?: string;
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
  /**
   * Irreversible merge write. Without `expectedBaseBranch`, calls
   * `gh pr merge --squash --delete-branch --match-head-commit <headRefOid>`
   * (head-bound TOCTOU guard). With `expectedBaseBranch`, performs a
   * base-bound squash onto that named branch so a PR retarget cannot redirect
   * the merge destination, then closes the PR and deletes the head branch.
   */
  ghPrMerge(pr: number, headRefOid: string, opts?: GhPrMergeOptions): Promise<void>;
  getIssueLabels(issueNumber: number): Promise<string[]>;
  getPrLinkedIssue(pr: number): Promise<number | null>;
  /** Authoritative resolver: given an issue number, return the open same-repo PR
   *  that closes it (mirrors gh.ts resolvePrForIssue logic). Used to cross-validate
   *  that a closingIssuesReferences candidate actually maps back to the correct PR
   *  in this repository, guarding against cross-repo reference mismatches. */
  getPrForIssue(issueNumber: number): Promise<number | null>;
  /**
   * When set (merge-queue drive), immediately-pre-merge gate requires the PR's
   * `baseRefName` to match this branch (early refuse). The irreversible write
   * additionally uses server-enforced base binding (see `ghPrMerge` opts) so a
   * retarget between the gate read and the write cannot land on another base.
   */
  expectedBaseBranch?: string;
  log(msg: string): void;
}

/** Encode a branch name for GitHub git/ref(s)/heads/* paths (supports nested branches). */
export function gitHeadsRefApiPath(branch: string, plural: boolean): string {
  const encoded = branch
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return plural ? `git/refs/heads/${encoded}` : `git/ref/heads/${encoded}`;
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

    async ghPrMerge(pr, headRefOid, opts) {
      const expectedBase = (opts?.expectedBaseBranch ?? "").trim();
      if (expectedBase) {
        await baseBoundSquashMerge(repo, pr, headRefOid, expectedBase);
        return;
      }
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
// Base-bound squash (server-enforced destination)
// ---------------------------------------------------------------------------

/**
 * Squash the inspected head onto the named expected base and fast-forward that
 * base ref only. Destination is the branch name passed to the ref update API —
 * not the PR's live baseRefName — so a retarget after gate inspection cannot
 * redirect the irreversible write. force=false requires a fast-forward (CAS
 * against the tip used as the squash parent).
 */
async function baseBoundSquashMerge(
  repo: string,
  pr: number,
  headRefOid: string,
  expectedBase: string,
): Promise<void> {
  const ghApi = async (args: string[], timeout = 30_000): Promise<string> => {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
      timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  };

  // 1. Tree of the inspected head (binds content to headRefOid like --match-head-commit).
  let headTree: string;
  try {
    const headJson = JSON.parse(
      await ghApi([`repos/${repo}/git/commits/${headRefOid}`]),
    ) as { tree?: { sha?: string } };
    headTree = String(headJson.tree?.sha ?? "");
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `base-bound merge: could not read head commit ${headRefOid}: ${String(e.stderr ?? e.message ?? err).trim()}`,
    );
  }
  if (!headTree) {
    throw new Error(
      `base-bound merge: head commit ${headRefOid} has empty tree sha; refusing merge.`,
    );
  }

  // 2. Current tip of the *named* expected base (destination ref).
  const baseRefPath = gitHeadsRefApiPath(expectedBase, false);
  let baseTip: string;
  try {
    const refJson = JSON.parse(
      await ghApi([`repos/${repo}/${baseRefPath}`]),
    ) as { object?: { sha?: string } };
    baseTip = String(refJson.object?.sha ?? "");
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `base-bound merge: could not read base ref ${expectedBase}: ${String(e.stderr ?? e.message ?? err).trim()}`,
    );
  }
  if (!baseTip) {
    throw new Error(
      `base-bound merge: base branch ${expectedBase} has empty tip sha; refusing merge.`,
    );
  }

  // 3. Squash commit: single parent = base tip, tree = head tree.
  const message =
    `Squash merge PR #${pr} into ${expectedBase} ` +
    `(base-bound; head ${headRefOid.slice(0, 12)})`;
  let squashSha: string;
  try {
    const commitJson = JSON.parse(
      await ghApi([
        "-X",
        "POST",
        `repos/${repo}/git/commits`,
        "-f",
        `message=${message}`,
        "-f",
        `tree=${headTree}`,
        "-f",
        `parents[]=${baseTip}`,
      ]),
    ) as { sha?: string };
    squashSha = String(commitJson.sha ?? "");
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `base-bound merge: create squash commit failed: ${String(e.stderr ?? e.message ?? err).trim()}`,
    );
  }
  if (!squashSha) {
    throw new Error(`base-bound merge: create squash commit returned empty sha; refusing ref update.`);
  }

  // 4. Fast-forward only the expected base ref (server-enforced destination + CAS).
  const baseRefsPath = gitHeadsRefApiPath(expectedBase, true);
  try {
    await ghApi(
      [
        "-X",
        "PATCH",
        `repos/${repo}/${baseRefsPath}`,
        "-f",
        `sha=${squashSha}`,
        "-F",
        "force=false",
      ],
      60_000,
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `base-bound merge: fast-forward of ${expectedBase} to ${squashSha.slice(0, 12)} failed ` +
        `(base may have moved): ${String(e.stderr ?? e.message ?? err).trim()}`,
    );
  }

  // 5. Close PR if still open and delete head branch (parity with --delete-branch).
  // Base ref already advanced — cleanup failures are non-fatal.
  let headRefName = "";
  let prState = "";
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "view",
        String(pr),
        "--json",
        "headRefName,state",
        "-R",
        repo,
      ],
      { timeout: 30_000 },
    );
    const meta = JSON.parse(stdout) as { headRefName?: string; state?: string };
    headRefName = String(meta.headRefName ?? "").trim();
    prState = String(meta.state ?? "").trim().toUpperCase();
  } catch {
    // Best-effort metadata only.
  }

  if (prState === "OPEN") {
    try {
      await execFileAsync(
        "gh",
        [
          "pr",
          "close",
          String(pr),
          "--comment",
          `Merged into \`${expectedBase}\` via merge-queue base-bound squash ` +
            `(head ${headRefOid.slice(0, 12)} → ${squashSha.slice(0, 12)}).`,
          "-R",
          repo,
        ],
        { timeout: 30_000 },
      );
    } catch {
      // Non-fatal: base already has the squash; PR close is cleanup.
    }
  }

  if (headRefName) {
    try {
      await ghApi(["-X", "DELETE", `repos/${repo}/${gitHeadsRefApiPath(headRefName, true)}`]);
    } catch {
      // Non-fatal: already deleted / gone / permissions — base update is the merge.
    }
  }
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
  // through to the merge write (match-head-commit or base-bound squash parent
  // tree) so content is bound to the inspected head.
  // When queue drive supplies expectedBaseBranch, also fetch baseRefName for an
  // early refuse if already retargeted; the merge write itself is additionally
  // base-bound so a retarget after this read still cannot land on another base.
  const expectedBase = (deps.expectedBaseBranch ?? "").trim();
  const viewFields = [
    "mergeable",
    "mergeStateStatus",
    "headRefOid",
    ...(expectedBase ? (["baseRefName"] as const) : []),
  ];
  const prData = await deps.ghPrView(pr, [...viewFields]);

  if (expectedBase) {
    const baseRefName = String(prData.baseRefName ?? "");
    if (baseRefName !== expectedBase) {
      throw new Error(
        `PR #${pr} base branch mismatch at merge gate: baseRefName=${baseRefName || "(empty)"} ` +
          `expected=${expectedBase}. Refusing merge (possible retarget race).`,
      );
    }
  }

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

  deps.log(
    expectedBase
      ? `[pipeline merge] #${pr}: all gates passed — base-bound squash onto ${expectedBase}...`
      : `[pipeline merge] #${pr}: all gates passed — squash-merging and deleting branch...`,
  );
  // When expectedBase is set, pass it into the merge write so the production
  // implementation binds the destination server-side (not only the pre-check).
  await deps.ghPrMerge(
    pr,
    headRefOid,
    expectedBase ? { expectedBaseBranch: expectedBase } : undefined,
  );
  deps.log(`[pipeline merge] #${pr}: merged successfully.`);
}
