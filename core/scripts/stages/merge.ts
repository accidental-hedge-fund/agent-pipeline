// Operator-authorized merge sub-command (#217): squash-merges a
// ready-to-deploy PR and deletes its head branch. NEVER called from the
// autonomous advance loop — the loop-isolation guarantee is structural (no
// import from any stage handler) and is backed by a unit test in
// core/test/merge.test.ts.
//
// This is the controlled, explicit surface for direct pipeline operators,
// pipeline-desk on an operator button click, or an external wrapper that has
// already validated a scoped operator grant. This command does not validate
// Buzz events or deployment grants. Rule #4 from CLAUDE.md applies to the
// autonomous advance loop; this sub-command remains loop-isolated.
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
import {
  assertOperatorMergeEnvelope,
  bindMergeClaim,
  classifyMergeFault,
  fileMergeClaimStore,
  mergeClaimKey,
  mergeObservation,
  ownedLifecycleForFault,
  observeAndDecide,
  type MergeObservation,
  type MergeSupervisionContext,
} from "./merge-supervision.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// UNKNOWN mergeability retry budget (#1071)
// ---------------------------------------------------------------------------
// GitHub briefly reports mergeable: UNKNOWN while computing mergeability.
// That is a transient compute gap, not a product block. Bounded re-reads live
// on the shared merge surface so train --merge and pipeline merge inherit the
// same behavior (class-over-site — not a train-only mole).

/** Total mergeability reads per merge attempt (initial read counts). */
export const MERGEABILITY_UNKNOWN_MAX_ATTEMPTS = 5;
/** Fixed delay between consecutive UNKNOWN mergeability reads (ms). */
export const MERGEABILITY_UNKNOWN_RETRY_DELAY_MS = 5000;

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
  /** Delay seam for UNKNOWN mergeability re-reads. Production uses a real timer;
   *  unit tests inject a no-wait recorder so suites do not wall-clock sleep. */
  sleep(ms: number): Promise<void>;
  /**
   * Optional RecoverySupervisor adapter context. When present, merge persists an
   * exact-candidate claim, reconciles remote truth before replay, and reports a
   * typed observation. Standalone CLI still throws for operator UX.
   */
  supervision?: MergeSupervisionContext;
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

    async sleep(ms) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  };
}

export function realMergeSupervision(opts: {
  repo: string;
  base: string;
  repoDir: string;
  envelope: MergeSupervisionContext["envelope"];
  actionIdentity: string;
  frozenIssueScope?: readonly number[];
  claimStore?: MergeSupervisionContext["claimStore"];
  mergeDeps?: MergeDeps;
}): MergeSupervisionContext {
  const mergeDeps = opts.mergeDeps ?? realMergeDeps(opts.repo);
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.repoDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout).trim();
  };
  return {
    repository: opts.repo,
    base: opts.base,
    frozenIssueScope: opts.frozenIssueScope ?? [],
    envelope: opts.envelope,
    actionIdentity: opts.actionIdentity,
    claimStore: opts.claimStore ?? fileMergeClaimStore(),
    observeMergedPr: async (pr) => {
      const data = await mergeDeps.ghPrView(pr, [
        "state",
        "mergedAt",
        "mergeCommit",
        "headRefOid",
      ]);
      const stateRaw = String(data.state ?? "").toUpperCase();
      const mergeCommit = data.mergeCommit as { oid?: string } | null | undefined;
      const mergedAt = data.mergedAt;
      const isMerged =
        stateRaw === "MERGED" ||
        (mergedAt != null && String(mergedAt) !== "" && String(mergedAt) !== "null");
      return {
        state: isMerged ? "merged" : stateRaw === "CLOSED" ? "closed" : "open",
        mergeCommitOid: mergeCommit?.oid ?? null,
        headRefOid: data.headRefOid ? String(data.headRefOid) : null,
      };
    },
    fetchBase: async (base) => {
      await git(["fetch", "origin", base]);
    },
    baseTip: async (base) => git(["rev-parse", `origin/${base}`]),
    isAncestor: async (ancestor, descendant) => {
      try {
        await git(["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
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

/** Actionable refusal when mergeability stays UNKNOWN after the retry budget. */
function unknownMergeabilityMessage(): string {
  return (
    `PR mergeability is not yet computed (UNKNOWN). ` +
    `GitHub is still evaluating — wait a few seconds and retry \`pipeline merge\`.`
  );
}

export interface InspectedMergeCandidate {
  pr: number;
  headRefOid: string;
  linkedIssue: number;
}

export async function inspectMergeCandidate(
  pr: number,
  deps: MergeDeps,
): Promise<InspectedMergeCandidate> {
  deps.log(`[pipeline merge] #${pr}: checking mergeability...`);

  // Fetch mergeable state and the head SHA together. headRefOid is threaded
  // through to --match-head-commit so the merge is bound to the commit that
  // passed the successful MERGEABLE+CLEAN gate (never an earlier UNKNOWN read),
  // closing the TOCTOU race between gate inspection and merge.
  //
  // mergeable: UNKNOWN is a transient GitHub compute gap (#1071). Re-read under
  // a bounded budget; hard unclean states refuse immediately with zero sleep.
  let headRefOid = "";
  for (let attempt = 1; attempt <= MERGEABILITY_UNKNOWN_MAX_ATTEMPTS; attempt++) {
    const prData = await deps.ghPrView(pr, [
      "mergeable",
      "mergeStateStatus",
      "headRefOid",
    ]);
    const mergeable = String(prData.mergeable ?? "UNKNOWN");
    const mergeStateStatus = String(prData.mergeStateStatus ?? "UNKNOWN");
    const oid = String(prData.headRefOid ?? "");

    if (mergeable === "UNKNOWN") {
      if (attempt < MERGEABILITY_UNKNOWN_MAX_ATTEMPTS) {
        deps.log(
          `[pipeline merge] #${pr}: mergeability UNKNOWN ` +
            `(attempt ${attempt}/${MERGEABILITY_UNKNOWN_MAX_ATTEMPTS}); ` +
            `waiting ${MERGEABILITY_UNKNOWN_RETRY_DELAY_MS}ms before re-read…`,
        );
        await deps.sleep(MERGEABILITY_UNKNOWN_RETRY_DELAY_MS);
        continue;
      }
      // Budget exhausted — fail closed; never treat UNKNOWN as MERGEABLE.
      throw new Error(unknownMergeabilityMessage());
    }

    // Non-UNKNOWN: hard unclean states refuse immediately (no further UNKNOWN sleeps).
    const mergeabilityError = checkMergeability(mergeable, mergeStateStatus);
    if (mergeabilityError) {
      throw new Error(mergeabilityError);
    }

    // Latest read is MERGEABLE+CLEAN — bind --match-head-commit to this OID only.
    if (!oid) {
      throw new Error(
        `PR #${pr}: could not determine head commit SHA (headRefOid was empty). ` +
          `Retry or check gh authentication.`,
      );
    }
    headRefOid = oid;
    break;
  }

  if (!headRefOid) {
    // Unreachable if the loop is correct; fail closed rather than merge on empty SHA.
    throw new Error(unknownMergeabilityMessage());
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

  const linkedIssue = await deps.getPrLinkedIssue(pr);
  if (linkedIssue === null) {
    throw new Error(
      `PR #${pr} has no linked pipeline issue (no closing-issue reference found). ` +
        `Add "Closes #<issue>" to the PR body and retry, or verify the issue link.`,
    );
  }

  return { pr, headRefOid, linkedIssue };
}

export type MergeAttemptResult =
  | { kind: "complete"; observation: MergeObservation; mergedNow: boolean }
  | { kind: "owned"; observation: MergeObservation };

async function emitObservation(
  deps: MergeDeps,
  observation: MergeObservation,
): Promise<void> {
  deps.supervision?.reportObservation?.(observation);
}

/**
 * One bounded merge attempt as a RecoverySupervisor operation adapter.
 * Does not declare terminal lifecycle on mechanical failure. Verified
 * completion requires the observer (merged + base containment).
 */
export async function runMergeAttempt(
  pr: number,
  deps: MergeDeps,
): Promise<MergeAttemptResult> {
  const supervision = deps.supervision;
  if (supervision) {
    assertOperatorMergeEnvelope(supervision.envelope);
    const existing = await supervision.claimStore.load(
      mergeClaimKey(supervision.repository, pr),
    );
    const { decision, live } = await observeAndDecide({
      pr,
      supervision,
      claim: existing,
    });
    if (decision.action === "complete") {
      if (existing && existing.outcome !== "complete") {
        await supervision.claimStore.save({ ...existing, outcome: "complete" });
      }
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: "known_complete",
        lifecycle: "complete",
        complete: true,
        fault: null,
        message: `PR #${pr} is merged and contained in ${supervision.base}`,
        claim: existing
          ? { ...existing, outcome: "complete" }
          : null,
        inspectedHead: existing?.inspected_head ?? live.headRefOid,
        mergeCommitOid: decision.mergeCommitOid,
      });
      await emitObservation(deps, observation);
      deps.log(`[pipeline merge] #${pr}: already merged and contained — no replay.`);
      return { kind: "complete", observation, mergedNow: false };
    }
    if (decision.action === "wait") {
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: decision.certainty,
        lifecycle: ownedLifecycleForFault(decision.fault),
        complete: false,
        fault: decision.fault,
        message:
          `PR #${pr}: merge side-effect is ${decision.certainty}; ` +
          `reconciling remote truth before replay (${decision.fault})`,
        claim: existing,
        inspectedHead: existing?.inspected_head ?? live.headRefOid,
        mergeCommitOid: live.mergeCommitOid,
      });
      await emitObservation(deps, observation);
      return { kind: "owned", observation };
    }
    if (decision.action === "invalidate") {
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: "known_absent",
        lifecycle: "cooling",
        complete: false,
        fault: "head_drift",
        message:
          `PR #${pr}: inspected head moved; stale claim and derived merge authorization are invalid`,
        claim: existing,
        inspectedHead: live.headRefOid,
        mergeCommitOid: live.mergeCommitOid,
      });
      await emitObservation(deps, observation);
      // Fresh exact-candidate gates + a new claim under the original envelope.
    }
    if (
      decision.action === "may_submit" &&
      existing &&
      (existing.outcome === "submitted" || existing.outcome === "uncertain")
    ) {
      // Prior side effect is known absent. Record that so later invokes retry.
      await supervision.claimStore.save({ ...existing, outcome: "started" });
    }
  }

  let inspected: InspectedMergeCandidate;
  try {
    inspected = await inspectMergeCandidate(pr, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fault = classifyMergeFault(message);
    const observation = mergeObservation({
      pr,
      repository: supervision?.repository ?? "",
      certainty: "known_absent",
      lifecycle: fault ? ownedLifecycleForFault(fault) : "cooling",
      complete: false,
      fault,
      message,
      claim: null,
    });
    await emitObservation(deps, observation);
    return { kind: "owned", observation };
  }

  if (supervision) {
    const liveHead = inspected.headRefOid;
    const existing = await supervision.claimStore.load(
      mergeClaimKey(supervision.repository, pr),
    );
    if (
      existing &&
      existing.outcome !== "complete" &&
      existing.inspected_head !== liveHead
    ) {
      deps.log(
        `[pipeline merge] #${pr}: stale claim head ${existing.inspected_head} ` +
          `!= inspected ${liveHead}; re-deriving candidate authorization`,
      );
    }

    const claim = bindMergeClaim({
      repository: supervision.repository,
      base: supervision.base,
      frozenIssueScope:
        supervision.frozenIssueScope.length > 0
          ? supervision.frozenIssueScope
          : [inspected.linkedIssue],
      pr,
      inspectedHead: liveHead,
      actionIdentity: supervision.actionIdentity,
      now: supervision.now?.(),
    });
    await supervision.claimStore.save(claim);
    const charged = await supervision.claimStore.load(
      mergeClaimKey(supervision.repository, pr),
    );
    if (!charged || charged.outcome !== "started" || charged.inspected_head !== liveHead) {
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: "known_absent",
        lifecycle: "cooling",
        complete: false,
        fault: null,
        message: `merge refused: exact-candidate claim was not persisted before submission`,
        claim: charged,
        inspectedHead: liveHead,
      });
      await emitObservation(deps, observation);
      return { kind: "owned", observation };
    }

    supervision.crashBeforeSubmit?.();

    const submittedClaim = { ...charged, outcome: "submitted" as const };
    await supervision.claimStore.save(submittedClaim);
    const pending = await supervision.claimStore.load(
      mergeClaimKey(supervision.repository, pr),
    );
    if (!pending || pending.outcome !== "submitted" || pending.inspected_head !== liveHead) {
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: "known_absent",
        lifecycle: "cooling",
        complete: false,
        fault: null,
        message: `merge refused: submitted claim was not persisted before mutation`,
        claim: pending,
        inspectedHead: liveHead,
      });
      await emitObservation(deps, observation);
      return { kind: "owned", observation };
    }

    deps.log(`[pipeline merge] #${pr}: all gates passed — squash-merging and deleting branch...`);
    try {
      await deps.ghPrMerge(pr, liveHead);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const uncertainClaim = { ...pending, outcome: "uncertain" as const };
      await supervision.claimStore.save(uncertainClaim);
      const { decision, live } = await observeAndDecide({
        pr,
        supervision,
        claim: uncertainClaim,
      });
      if (decision.action === "complete") {
        await supervision.claimStore.save({ ...pending, outcome: "complete" });
        const observation = mergeObservation({
          pr,
          repository: supervision.repository,
          certainty: "known_complete",
          lifecycle: "complete",
          complete: true,
          fault: null,
          message: `PR #${pr} is merged and contained in ${supervision.base}`,
          claim: { ...pending, outcome: "complete" },
          inspectedHead: liveHead,
          mergeCommitOid: decision.mergeCommitOid,
        });
        await emitObservation(deps, observation);
        deps.log(`[pipeline merge] #${pr}: merged successfully (reconciled after mutation error).`);
        return { kind: "complete", observation, mergedNow: true };
      }
      const fault =
        classifyMergeFault(message) ?? "uncertain_merge_response";
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: "uncertain",
        lifecycle: ownedLifecycleForFault(fault),
        complete: false,
        fault,
        message,
        claim: uncertainClaim,
        inspectedHead: liveHead,
        mergeCommitOid: live.mergeCommitOid,
      });
      await emitObservation(deps, observation);
      return { kind: "owned", observation };
    }

    supervision.crashAfterSubmit?.();

    const { decision, live, contained } = await observeAndDecide({
      pr,
      supervision,
      claim: pending,
    });
    if (decision.action === "complete") {
      const completeClaim = { ...pending, outcome: "complete" as const };
      await supervision.claimStore.save(completeClaim);
      const observation = mergeObservation({
        pr,
        repository: supervision.repository,
        certainty: "known_complete",
        lifecycle: "complete",
        complete: true,
        fault: null,
        message: `PR #${pr} is merged and contained in ${supervision.base}`,
        claim: completeClaim,
        inspectedHead: liveHead,
        mergeCommitOid: decision.mergeCommitOid,
      });
      await emitObservation(deps, observation);
      deps.log(`[pipeline merge] #${pr}: merged successfully.`);
      return { kind: "complete", observation, mergedNow: true };
    }
    const waitingClaim = { ...pending, outcome: "uncertain" as const };
    await supervision.claimStore.save(waitingClaim);
    const fault =
      decision.action === "wait" || decision.action === "invalidate"
        ? decision.fault
        : "uncertain_merge_response";
    const observation = mergeObservation({
      pr,
      repository: supervision.repository,
      certainty: "uncertain",
      lifecycle: ownedLifecycleForFault(fault),
      complete: false,
      fault,
      message:
        `PR #${pr}: merge command returned; postcondition not proven ` +
        `(state=${live.state}, contained=${contained})`,
      claim: waitingClaim,
      inspectedHead: liveHead,
      mergeCommitOid: live.mergeCommitOid,
    });
    await emitObservation(deps, observation);
    return { kind: "owned", observation };
  }

  deps.log(`[pipeline merge] #${pr}: all gates passed — squash-merging and deleting branch...`);
  await deps.ghPrMerge(pr, inspected.headRefOid);
  deps.log(`[pipeline merge] #${pr}: merged successfully.`);
  const observation = mergeObservation({
    pr,
    repository: "",
    certainty: "known_complete",
    lifecycle: "complete",
    complete: true,
    fault: null,
    message: `PR #${pr}: merged successfully.`,
    claim: null,
    inspectedHead: inspected.headRefOid,
  });
  return { kind: "complete", observation, mergedNow: true };
}

export async function mergePr(pr: number, deps: MergeDeps): Promise<void> {
  const result = await runMergeAttempt(pr, deps);
  if (result.kind === "complete" && result.observation.complete) return;
  throw new Error(result.observation.message);
}
