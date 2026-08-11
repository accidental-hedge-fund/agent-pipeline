// Provider-neutral whole-item remediation for durable loop recovery. The
// supervisor owns claim/budget state; this module owns the actual candidate
// repair and reports success only after the configured implementer produced a
// committed, pushed change; a post-push label-clear failure is recorded in the
// evidence rather than failing the verified repair.
//
// #629 disposition (consumer via shared auto-fix): substantive implementer
// work goes through `performPreMergeAutoFix`, which itself uses the shared
// `runHarnessRound` helper. This file is a **documented narrow exemption**
// from calling `runHarnessRound` directly — the recovery shell owns durable
// pre-invocation breadcrumb refs, ownership proof before adopting unpushed
// commits, idempotent reconciliation of already-pushed marked repairs, and
// refusal to adopt unmarked human commits. Those shell invariants must not be
// flattened into the stage skeleton.

import * as path from "node:path";
import { clearBlocked, getIssueDetail } from "../gh.ts";
import { invoke } from "../harness.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import { performPreMergeAutoFix } from "../stages/pre_merge.ts";
import { withTrailers } from "../traceability.ts";
import type { StageDiagnostic } from "../stage-diagnostic.ts";
import { LABEL_PREFIX, type PipelineConfig } from "../types.ts";
import {
  branchName,
  ensureManagedWorktree,
  getOnDiskForIssue,
  gitInWorktree,
} from "../worktree.ts";
import { appendEvent, defaultRunStoreDeps, runDirPath } from "../run-store.ts";
import { DEFAULT_GIT_PUSH_AUTH, gitExecForwardingEnv, runConfiguredGitPush } from "../git-push-auth.ts";

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

    // Durable pre-invocation breadcrumb: a git ref in the managed worktree's
    // repository, keyed by this attempt id and pointing at the claimed head.
    // It is written immediately before the harness/auto-fix seam is invoked,
    // survives process death, never dirties `git status`, and is the smallest
    // durable mechanism this executor already owns (it has a git seam but no
    // run-store/token seam). The unmarked-commit reconciliation below may
    // adopt a commit ONLY when this breadcrumb proves the attempt's own
    // interrupted run was mid-harness at exactly the claimed head.
    const breadcrumbRef = `refs/pipeline-recovery/${input.attemptId}`;

    // A post-push label-clear hiccup must not convert a verified pushed
    // repair into a charged failure — for a budget-1 run_fatal class that
    // would end the whole run. Retry once; a residual failure is returned so
    // callers record it in the evidence and the supervisor's next reconcile
    // pass re-observes labels and resyncs.
    const clearBlockedWithRetry = async (): Promise<string | undefined> => {
      try {
        await unblock(cfg, issueNumber);
        return undefined;
      } catch {
        try {
          await unblock(cfg, issueNumber);
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }
    };

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
    let actualHead = headResult.stdout.trim();
    if (headResult.code !== 0 || !actualHead) {
      const error = `cannot verify the current worktree head for repair attempt ${input.attemptId}`;
      return { succeeded: false, evidence: error, error };
    }
    if (actualHead.toLowerCase() !== expected.toLowerCase()) {
      const attemptMarker = input.attemptId.slice(0, 12);
      const subject = await git(wt.path, ["log", "-1", "--format=%s"], { ignoreFailure: true });
      let marked = subject.code === 0 && subject.stdout.includes(`pipeline recovery ${attemptMarker}`);
      if (!marked) {
        // No marked commit to reconcile. Before declaring the candidate moved,
        // distinguish two recoverable local states — both require a clean tree
        // and a remote branch still at the claimed head (the head the claim
        // bound); anything dirty or unprovable fails closed.
        const status = await git(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
        if (status.code !== 0 || status.stdout.trim() !== "") {
          const error =
            `recovery candidate moved before repair: claimed ${expected}, worktree is ${actualHead} ` +
            "with uncommitted changes; refusing destructive reconciliation";
          return { succeeded: false, evidence: error, error };
        }
        const branch = branchName(issueNumber, wt.slug);
        const remote = await git(
          wt.path,
          ["ls-remote", "origin", `refs/heads/${branch}`],
          { ignoreFailure: true },
        );
        const remoteHead = remote.code === 0 ? remote.stdout.trim().split(/\s+/, 1)[0] ?? "" : "";
        if (remoteHead.toLowerCase() !== expected.toLowerCase()) {
          const error =
            `recovery candidate moved before repair: claimed ${expected}, worktree is ${actualHead}; ` +
            "reconcile and claim the current candidate instead";
          return { succeeded: false, evidence: error, error };
        }
        const parent = await git(wt.path, ["rev-parse", "HEAD^"], { ignoreFailure: true });
        if (parent.code === 0 && parent.stdout.trim().toLowerCase() === expected.toLowerCase()) {
          // Crash window: this attempt's harness/salvage commit landed but the
          // process died before the marker amend. Exactly one clean, unpushed
          // commit sits on the claimed head while the remote is still at the
          // claim. That shape alone is NOT proof of authorship — a human's
          // local commit in the managed worktree matches it too, and adopting
          // one would amend away their commit message and publish their work.
          // Safety scope: the destructive amend+push below therefore also
          // require the durable pre-invocation breadcrumb — it must exist for
          // THIS attempt id and record THIS claimed head. Our own attempts
          // always write it before the harness runs, so a genuinely crashed
          // attempt still reconciles; anything unprovable fails closed.
          const breadcrumb = await git(
            wt.path,
            ["rev-parse", "--verify", "--quiet", breadcrumbRef],
            { ignoreFailure: true },
          );
          const breadcrumbHead = breadcrumb.code === 0 ? breadcrumb.stdout.trim() : "";
          if (breadcrumbHead.toLowerCase() !== expected.toLowerCase()) {
            const error =
              `recovery candidate moved before repair: claimed ${expected}, worktree is ${actualHead} ` +
              `carrying an unpushed commit that attempt ${input.attemptId} cannot prove it authored ` +
              "(no pre-invocation breadcrumb); refusing to adopt, amend, or publish it";
            return { succeeded: false, evidence: error, error };
          }
          // Stamp the marker now and let the marked-commit flow below push and
          // verify it instead of wedging the attempt.
          const amend = await git(
            wt.path,
            [
              "commit",
              "--amend",
              "-m",
              withTrailers(
                `fix: pipeline recovery ${attemptMarker} for #${issueNumber}`,
                issueNumber,
                input.runId,
              ),
            ],
            { ignoreFailure: true },
          );
          const amendedHead = amend.code === 0
            ? (await git(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim()
            : "";
          if (!amendedHead) {
            const error =
              `recovery attempt ${input.attemptId} could not stamp its marker onto the ` +
              `interrupted commit ${actualHead}`;
            return { succeeded: false, evidence: error, error };
          }
          // The stamped marker subject is now the durable proof of authorship;
          // retire the breadcrumb so it can never vouch for a future commit.
          await git(wt.path, ["update-ref", "-d", breadcrumbRef], { ignoreFailure: true });
          actualHead = amendedHead;
          marked = true;
        } else {
          // Present-but-stale worktree: the claim binds the remote PR head, and
          // the remote branch is verified above to still be exactly the claimed
          // head. Hard-sync so the attempt repairs the claimed candidate instead
          // of failing deterministically until the budget exhausts.
          // `fetch` + `reset --hard` is destructive but provably scoped: it
          // targets only this managed worktree root, and the reset target is the
          // claimed head, which IS the current remote branch truth.
          const fetched = await git(wt.path, ["fetch", "origin", branch], { ignoreFailure: true });
          if (fetched.code === 0) {
            // The reset target is proven above (claimed head == remote truth),
            // but that alone says nothing about what the reset would DISCARD.
            // Safety scope: only a worktree strictly behind remote truth may be
            // hard-synced — local HEAD must be an ancestor of the claimed
            // head. Any local-only commit (ahead or diverged) fails closed
            // instead of being silently destroyed.
            const ancestry = await git(
              wt.path,
              ["merge-base", "--is-ancestor", "HEAD", expected],
              { ignoreFailure: true },
            );
            if (ancestry.code !== 0) {
              const error =
                `recovery attempt ${input.attemptId} found the stale worktree at ${actualHead} ` +
                `with local commits not reachable from the claimed head ${expected}: ` +
                "local commits present; refusing to discard them with a hard sync";
              return { succeeded: false, evidence: error, error };
            }
          }
          const reset = fetched.code === 0
            ? await git(wt.path, ["reset", "--hard", expected], { ignoreFailure: true })
            : fetched;
          const syncedHead = reset.code === 0
            ? (await git(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim()
            : "";
          if (syncedHead.toLowerCase() !== expected.toLowerCase()) {
            const error =
              `recovery attempt ${input.attemptId} could not sync the stale worktree ` +
              `from ${actualHead} to the claimed head ${expected}`;
            return { succeeded: false, evidence: error, error };
          }
          actualHead = syncedHead;
        }
      }
      if (marked) {
        const branch = branchName(issueNumber, wt.slug);
        const remote = await git(
          wt.path,
          ["ls-remote", "origin", `refs/heads/${branch}`],
          { ignoreFailure: true },
        );
        const remoteHead = remote.code === 0 ? remote.stdout.trim().split(/\s+/, 1)[0] ?? "" : "";
        if (remoteHead.toLowerCase() === actualHead.toLowerCase()) {
          // The recovery commit is already remote-verified; like the
          // substantive path below, a label-clear failure must not convert
          // the verified repair into a charged failure.
          const labelClearFailure = await clearBlockedWithRetry();
          return {
            succeeded: true,
            candidateHead: actualHead,
            evidence:
              `reconciled remote recovery attempt ${input.attemptId} at ${actualHead} ` +
              (labelClearFailure
                ? `without replaying the implementer, but the mechanical blocked label could not ` +
                  `be cleared after a retry (next reconcile pass must resync it): ${labelClearFailure}`
                : "and cleared the mechanical block without replaying the implementer"),
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
        const pushAuth = cfg.git?.push_auth ?? DEFAULT_GIT_PUSH_AUTH;
        const push = await runConfiguredGitPush({
          cwd: wt.path,
          auth: pushAuth,
          args: ["push", "origin", `HEAD:refs/heads/${branch}`],
          deps: {
            gitConfigGet: async (cwd, key) => {
              const r = await git(cwd, ["config", "--get", key], { ignoreFailure: true });
              return r.code === 0 ? r.stdout.trim() || null : null;
            },
            gitExec: gitExecForwardingEnv(wt.path, git),
          },
        });
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
        // The push above is remote-verified; like the substantive path below,
        // a label-clear failure must not convert it into a charged failure.
        const labelClearFailure = await clearBlockedWithRetry();
        return {
          succeeded: true,
          candidateHead: actualHead,
          evidence:
            `pushed and reconciled recovery attempt ${input.attemptId} at ${actualHead} ` +
            "without replaying the implementer" +
            (labelClearFailure
              ? `, but the mechanical blocked label could not be cleared after a retry ` +
                `(next reconcile pass must resync it): ${labelClearFailure}`
              : ""),
        };
      }
      // Reaching here means the stale worktree was hard-synced to the claimed
      // head; the substantive repair below operates on the claimed candidate.
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
    // Write the durable breadcrumb immediately before the harness/auto-fix
    // seam runs: if the process dies mid-harness, the replayed attempt can
    // prove any clean unpushed commit on the claimed head came from its own
    // interrupted run. Best-effort — a failed write only ever fails CLOSED
    // later (the reconciliation refuses to adopt without it).
    await git(wt.path, ["update-ref", breadcrumbRef, expected], { ignoreFailure: true });
    // Substantive path: shared-helper-backed pre-merge auto-fix (#629 / #787).
    // Do not reintroduce a private full implementer-round skeleton here.
    // #857: pass candidate-integrity context when we can resolve a durable store.
    const storeRoot =
      cfg.repo_dir && input.runId
        ? runDirPath(cfg.repo_dir, input.runId)
        : cfg.repo_dir
          ? path.join(cfg.repo_dir, ".agent-pipeline", "runs", input.runId)
          : undefined;
    const base = cfg.base_branch;
    const branch = branchName(issueNumber, wt.slug);
    const integrity =
      storeRoot && base
        ? {
            storeRoot,
            subject: {
              run_id: input.runId,
              issue: issueNumber,
              pr: null as number | null,
            },
            base_ref: base,
            mutation_method: "recovery_repair" as const,
            // Empty scope → any candidate-side map delta is scope_expansion.
            declared_scope: {
              paths: [] as string[],
              directories: [] as string[],
              reason: "recovery_repair",
            },
            resolveBaseSha: async () => {
              const r = await git(wt.path, ["rev-parse", `origin/${base}`], {
                ignoreFailure: true,
              });
              return r.code === 0 ? r.stdout.trim() || null : null;
            },
            resolveCandidateSha: async () => {
              const remote = await git(
                wt.path,
                ["ls-remote", "origin", `refs/heads/${branch}`],
                { ignoreFailure: true },
              );
              const sha =
                remote.code === 0 ? remote.stdout.trim().split(/\s+/, 1)[0] ?? "" : "";
              if (sha) return sha;
              const local = await git(wt.path, ["rev-parse", "HEAD"], {
                ignoreFailure: true,
              });
              return local.code === 0 ? local.stdout.trim() || null : null;
            },
            emitEvent: async (event: unknown) => {
              await appendEvent(storeRoot, event as never, defaultRunStoreDeps).catch(() => {});
            },
          }
        : undefined;

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
      undefined,
      integrity,
    );
    // Controlled completion (any status): retire the breadcrumb so it can
    // only ever vouch for a genuinely interrupted (crashed) harness run.
    await git(wt.path, ["update-ref", "-d", breadcrumbRef], { ignoreFailure: true });
    if (result.status !== "fix-committed") {
      const error =
        result.status === "noop-clean"
          ? `configured implementer inspected ${actualHead} but produced no verifiable candidate change: ${result.diagnostic ?? "clean no-op"}`
          : `configured implementer did not produce a committed and pushed repair for ${actualHead}`;
      return { succeeded: false, evidence: error, error };
    }

    // The verified push above already proved the repair; a label-API hiccup
    // must not convert it into a failed (budget-charged) attempt.
    const labelClearFailure = await clearBlockedWithRetry();

    return {
      succeeded: true,
      candidateHead: result.headSha,
      evidence:
        `repair attempt ${input.attemptId} moved ${expected} to ${result.headSha}, pushed the candidate, ` +
        (labelClearFailure
          ? `but the mechanical blocked label could not be cleared after a retry ` +
            `(next reconcile pass must resync it): ${labelClearFailure}`
          : "and cleared the mechanical block for normal Pipeline re-entry"),
    };
  };
}
