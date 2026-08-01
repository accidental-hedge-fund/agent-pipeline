// Provider-neutral whole-item remediation for durable loop recovery. The
// supervisor owns claim/budget state; this module owns the actual candidate
// repair and reports success only after the configured implementer produced a
// committed, pushed change and the mechanical block was cleared.

import { clearBlocked, getIssueDetail } from "../gh.ts";
import { invoke } from "../harness.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import { performPreMergeAutoFix } from "../stages/pre_merge.ts";
import type { StageDiagnostic } from "../stage-diagnostic.ts";
import { LABEL_PREFIX, type PipelineConfig } from "../types.ts";
import {
  branchName,
  ensureManagedWorktree,
  getOnDiskForIssue,
  gitInWorktree,
} from "../worktree.ts";

export interface RepairPipelineItemInput {
  runId: string;
  itemId: string;
  attemptId: string;
  candidateIdentity: string;
  diagnostic: StageDiagnostic;
}

export interface RepairPipelineItemResult {
  succeeded: boolean;
  evidence: string;
  error?: string;
  /** Remote-verified candidate head after a successful repair/replay. */
  candidateHead?: string;
}

export interface RepairPipelineItemDeps {
  getIssueDetail?: typeof getIssueDetail;
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  ensureManagedWorktree?: typeof ensureManagedWorktree;
  gitInWorktree?: typeof gitInWorktree;
  invoke?: typeof invoke;
  performRepair?: typeof performPreMergeAutoFix;
  clearBlocked?: typeof clearBlocked;
}

function expectedHead(candidateIdentity: string): string | null {
  const match = /(?:^|\|)head=([0-9a-f]{7,64})(?:\||$)/i.exec(candidateIdentity);
  return match?.[1] ?? null;
}

function diagnosticEvidence(diagnostic: StageDiagnostic): string {
  return [
    "## Autonomous Pipeline Recovery",
    "",
    `Reason code: ${diagnostic.reason_code}`,
    `Evidence key: ${diagnostic.evidence_key}`,
    `Blocked stage: ${diagnostic.detail.stage ?? "unknown"}`,
    `Blocker kind: ${diagnostic.detail.blocker_kind}`,
    "",
    diagnostic.detail.reason,
    "",
    "Resolve this mechanical blocker without weakening requirements, review policy, or gates. " +
      "Do not merge, deploy, create an override, enter credentials, or make a product decision. " +
      "Commit the repair so the normal Pipeline state machine can re-review and re-validate it.",
  ].join("\n");
}

export function createRepairPipelineItemExecutor(
  cfg: PipelineConfig,
  deps: RepairPipelineItemDeps = {},
): (input: RepairPipelineItemInput) => Promise<RepairPipelineItemResult> {
  const getDetail = deps.getIssueDetail ?? getIssueDetail;
  const getWorktree = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const ensureWorktree = deps.ensureManagedWorktree ?? ensureManagedWorktree;
  const git = deps.gitInWorktree ?? gitInWorktree;
  const invokeHarness = deps.invoke ?? invoke;
  const repair = deps.performRepair ?? performPreMergeAutoFix;
  const unblock = deps.clearBlocked ?? clearBlocked;

  return async (input) => {
    const issueNumber = Number(input.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      const error = `repair_pipeline_item requires a positive numeric item id, got ${JSON.stringify(input.itemId)}`;
      return { succeeded: false, evidence: error, error };
    }

    const expected = expectedHead(input.candidateIdentity);
    if (!expected) {
      const error = `repair attempt ${input.attemptId} has no verified head in its candidate identity`;
      return { succeeded: false, evidence: error, error };
    }

    let wt = await getWorktree(cfg, issueNumber);
    if (!wt) {
      const materialized = await ensureWorktree(cfg, issueNumber);
      if (materialized.result === "fail" || !materialized.worktree) {
        const error =
          materialized.result === "fail"
            ? `worktree rematerialization failed: ${materialized.reason}`
            : "worktree rematerialization did not return a worktree";
        return { succeeded: false, evidence: error, error };
      }
      wt = { path: materialized.worktree.path, slug: materialized.worktree.slug };
    }

    const headResult = await git(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true });
    const actualHead = headResult.stdout.trim();
    if (headResult.code !== 0 || !actualHead) {
      const error = `cannot verify the current worktree head for repair attempt ${input.attemptId}`;
      return { succeeded: false, evidence: error, error };
    }
    if (actualHead !== expected) {
      const attemptMarker = input.attemptId.slice(0, 12);
      const subject = await git(wt.path, ["log", "-1", "--format=%s"], { ignoreFailure: true });
      if (subject.code === 0 && subject.stdout.includes(`pipeline recovery ${attemptMarker}`)) {
        const branch = branchName(issueNumber, wt.slug);
        const remote = await git(
          wt.path,
          ["ls-remote", "origin", `refs/heads/${branch}`],
          { ignoreFailure: true },
        );
        const remoteHead = remote.code === 0 ? remote.stdout.trim().split(/\s+/, 1)[0] ?? "" : "";
        if (remoteHead.toLowerCase() === actualHead.toLowerCase()) {
          try {
            await unblock(cfg, issueNumber);
          } catch (err) {
            const error =
              `recovery commit ${actualHead} is already present for attempt ${input.attemptId}, ` +
              `but the mechanical blocked label could not be cleared: ` +
              `${err instanceof Error ? err.message : String(err)}`;
            return { succeeded: false, evidence: error, error };
          }
          return {
            succeeded: true,
            candidateHead: actualHead,
            evidence:
              `reconciled remote recovery attempt ${input.attemptId} at ${actualHead} ` +
              "and cleared the mechanical block without replaying the implementer",
          };
        }
        if (remoteHead.toLowerCase() !== expected.toLowerCase()) {
          const error =
            `recovery commit ${actualHead} is present locally for attempt ${input.attemptId}, ` +
            `but remote branch ${branch} is at ${remoteHead || "an unverified head"}; refusing to clear the block`;
          return { succeeded: false, evidence: error, error };
        }

        // The process died after creating its exact marked commit but before
        // push. Preserve that deterministic result: prove it is a clean,
        // single-child commit of the claimed head, push it normally, and
        // verify the remote instead of invoking a model twice.
        const status = await git(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
        const parent = await git(wt.path, ["rev-parse", "HEAD^"], { ignoreFailure: true });
        if (
          status.code !== 0 ||
          status.stdout.trim() !== "" ||
          parent.code !== 0 ||
          parent.stdout.trim().toLowerCase() !== expected.toLowerCase()
        ) {
          const error =
            `recovery attempt ${input.attemptId} found an unpushed marked commit, but its tree ` +
            `is dirty or its parent is not the claimed head ${expected}`;
          return { succeeded: false, evidence: error, error };
        }
        const push = await git(
          wt.path,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          { ignoreFailure: true },
        );
        const verifiedRemote = await git(
          wt.path,
          ["ls-remote", "origin", `refs/heads/${branch}`],
          { ignoreFailure: true },
        );
        const verifiedHead = verifiedRemote.code === 0
          ? verifiedRemote.stdout.trim().split(/\s+/, 1)[0] ?? ""
          : "";
        if (push.code !== 0 || verifiedHead.toLowerCase() !== actualHead.toLowerCase()) {
          const error =
            `recovery attempt ${input.attemptId} could not verify its existing commit ${actualHead} ` +
            `on remote branch ${branch}`;
          return { succeeded: false, evidence: error, error };
        }
        try {
          await unblock(cfg, issueNumber);
        } catch (err) {
          const error =
            `recovery commit ${actualHead} was pushed for attempt ${input.attemptId}, ` +
            `but the mechanical blocked label could not be cleared: ` +
            `${err instanceof Error ? err.message : String(err)}`;
          return { succeeded: false, evidence: error, error };
        }
        return {
          succeeded: true,
          candidateHead: actualHead,
          evidence:
            `pushed and reconciled recovery attempt ${input.attemptId} at ${actualHead} ` +
            "without replaying the implementer",
        };
      } else {
        const error =
          `recovery candidate moved before repair: claimed ${expected}, worktree is ${actualHead}; ` +
          "reconcile and claim the current candidate instead";
        return { succeeded: false, evidence: error, error };
      }
    }

    let detail: Awaited<ReturnType<typeof getIssueDetail>>;
    try {
      detail = await getDetail(cfg, issueNumber);
    } catch (err) {
      const error = `cannot load issue context for repair: ${err instanceof Error ? err.message : String(err)}`;
      return { succeeded: false, evidence: error, error };
    }
    if (detail.state !== "open") {
      const error = `refusing substantive recovery for closed issue #${issueNumber}`;
      return { succeeded: false, evidence: error, error };
    }
    if (detail.labels.includes(`${LABEL_PREFIX}ready-to-deploy`)) {
      const error = `refusing substantive recovery because issue #${issueNumber} is already ready to deploy`;
      return { succeeded: false, evidence: error, error };
    }

    const invokeConfiguredRepair: typeof invoke = (harness, worktreeDir, prompt, opts = {}) =>
      invokeHarness(harness, worktreeDir, prompt, {
        ...opts,
        reasoningEffort: cfg.effort?.fix,
      });
    const result = await repair(
      cfg,
      issueNumber,
      input.runId,
      diagnosticEvidence(input.diagnostic),
      detail.title,
      wt,
      git,
      invokeConfiguredRepair,
      trySalvageUncommittedWork,
      {
        commitSubjectPrefix: `fix: pipeline recovery ${input.attemptId.slice(0, 12)}`,
        salvageLabel: "pipeline recovery",
      },
    );
    if (result.status !== "fix-committed") {
      const error =
        result.status === "noop-clean"
          ? `configured implementer inspected ${actualHead} but produced no verifiable candidate change: ${result.diagnostic ?? "clean no-op"}`
          : `configured implementer did not produce a committed and pushed repair for ${actualHead}`;
      return { succeeded: false, evidence: error, error };
    }

    try {
      await unblock(cfg, issueNumber);
    } catch (err) {
      const error =
        `repair commit ${result.headSha} was pushed but the mechanical blocked label could not be cleared: ` +
        `${err instanceof Error ? err.message : String(err)}`;
      return { succeeded: false, evidence: error, error };
    }

    return {
      succeeded: true,
      candidateHead: result.headSha,
      evidence:
        `repair attempt ${input.attemptId} moved ${expected} to ${result.headSha}, pushed the candidate, ` +
        "and cleared the mechanical block for normal Pipeline re-entry",
    };
  };
}
