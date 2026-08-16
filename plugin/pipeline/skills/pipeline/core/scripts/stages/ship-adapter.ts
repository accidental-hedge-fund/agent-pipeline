// Production composition for the Pipeline-owned ship coordinator.
//
// This file adapts existing Pipeline capabilities to ShipCoordinatorDeps. It
// does not add another scheduler, retry model, merge implementation, or FRG
// evidence producer. Each converge operation first observes external truth.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  validateFrgEvidenceFileForTag,
  type FrgEvidence,
} from "../factory-reliability-gate.ts";
import { FRG_HYBRID_PILOT_VERSION } from "../frg-pack-observations.ts";
import {
  factoryReleaseVersionIndexPath,
  isPostPilotReleaseVersion,
} from "../factory-release-prepare.ts";
import { resolveReleaseConfig } from "../config.ts";
import { getPrForIssueAnyState } from "../gh.ts";
import { withLock } from "../lock.ts";
import type { PipelineConfig } from "../types.ts";
import {
  defaultShipStateStore,
  type ShipCoordinatorDeps,
  type ShipFrgEvidence,
  type ShipFrgPackEvidence,
  type ShipIntent,
  type ShipProgress,
  type ShipPromotionEvidence,
  type ShipPublicationEvidence,
  type ShipReleaseEvidence,
  type ShipReleaseFinishEvidence,
  type ShipStateStore,
  type ShipTrainEvidence,
  type ShipTrainPlan,
} from "./ship.ts";
import {
  orderIssuesByDeclaredDeps,
  realTrainDeps,
  runTrain,
  type AdvanceWaveResult,
  type TrainDeps,
  type TrainIssueSnapshot,
} from "./train.ts";
import { realMergeDeps } from "./merge.ts";
import { realReleaseDeps, runRelease } from "./release.ts";
import {
  finishReleasePr,
  parseReleasePrTitle,
  realReleaseFinishDeps,
} from "./release-finish.ts";
import { realEnginePromoteDeps, runEnginePromote } from "./engine-promote.ts";

const execFileAsync = promisify(execFile);
const OID_RE = /^[0-9a-f]{40}$/i;
const RELEASE_WAIT_ATTEMPTS = 120;
const RELEASE_WAIT_MS = 10_000;

interface ObservedRelease {
  prepare: ShipReleaseEvidence;
  finish: ShipReleaseFinishEvidence | null;
}

/**
 * High-level injected seams for adapter tests. The real implementation below
 * is the only place that invokes git, gh, or existing mutating stages.
 */
export interface ShipAdapterOperations {
  planTrain(intent: ShipIntent): Promise<ShipTrainPlan>;
  observeTrain(
    intent: ShipIntent,
    plannedIssues: readonly number[],
    candidateHeadOid?: string,
  ): Promise<ShipTrainEvidence | null>;
  runTrain(intent: ShipIntent, plannedIssues: readonly number[]): Promise<ShipTrainEvidence>;
  observeFrg(
    intent: ShipIntent,
    train: ShipTrainEvidence,
    requireCurrentCandidate: boolean,
  ): Promise<FrgEvidence | null>;
  observeRelease(intent: ShipIntent, candidateHeadOid?: string): Promise<ObservedRelease | null>;
  prepareRelease(intent: ShipIntent, candidateHeadOid: string): Promise<ShipReleaseEvidence>;
  finishRelease(intent: ShipIntent, release: ShipReleaseEvidence): Promise<ShipReleaseFinishEvidence>;
  observePublication(
    intent: ShipIntent,
    release: ShipReleaseFinishEvidence,
  ): Promise<ShipPublicationEvidence | null>;
  waitForPublication(
    intent: ShipIntent,
    release: ShipReleaseFinishEvidence,
  ): Promise<ShipPublicationEvidence>;
  observePromotion(
    intent: ShipIntent,
    publication: ShipPublicationEvidence,
  ): Promise<ShipPromotionEvidence | null>;
  promote(
    intent: ShipIntent,
    publication: ShipPublicationEvidence,
  ): Promise<ShipPromotionEvidence>;
}

export interface RealShipCoordinatorDepsOptions {
  repoDir: string;
  repo: string;
  baseBranch: string;
  profile?: string;
  progress(msg: string): void;
  authorizationPublicKey: string;
  /**
   * Multi-item frontier advance supplied by pipeline.ts (one loop/advance-wave
   * call per frontier — same seam as `runTrainCommand`). Must not be N×single.
   */
  advanceWave(issues: readonly number[]): Promise<AdvanceWaveResult>;
  state?: ShipStateStore;
  env?: NodeJS.ProcessEnv;
}

function requireOid(value: string, field: string): string {
  if (!OID_RE.test(value)) throw new Error(`${field} must be a 40-character git OID`);
  return value.toLowerCase();
}

function expectedTag(version: string): string {
  return `v${version}`;
}

/** Require the repository's annotated release-tag invariant and exact target. */
export async function verifyAnnotatedReleaseTag(
  tag: string,
  expectedCommitOid: string,
  git: (args: string[]) => Promise<string>,
): Promise<void> {
  const expected = requireOid(expectedCommitOid, "ship release merge commit");
  const ref = `refs/tags/${tag}`;
  const objectType = await git(["cat-file", "-t", ref]);
  if (objectType !== "tag") {
    throw new Error(`ship release: ${tag} must be an annotated tag (got ${objectType || "missing"})`);
  }
  const peeled = requireOid(await git(["rev-parse", `${ref}^{}`]), "ship release peeled tag commit");
  if (peeled !== expected) {
    throw new Error(`ship release: ${tag} does not point to the release merge commit`);
  }
}

export async function alignReleaseCheckoutToCandidate(
  baseBranch: string,
  candidateHeadOid: string,
  git: (args: string[]) => Promise<string>,
): Promise<void> {
  const candidate = requireOid(candidateHeadOid, "ship release candidate");
  await git(["checkout", baseBranch]);
  await git(["merge", "--ff-only", `origin/${baseBranch}`]);
  const localHead = requireOid(await git(["rev-parse", "HEAD"]), "ship release local head");
  if (localHead !== candidate) {
    throw new Error("ship release: local base checkout does not match the FRG candidate");
  }
}

export function assertFrgCandidateProvenance(
  evidence: FrgEvidence,
  train: ShipTrainEvidence,
  intent: ShipIntent,
  opts?: {
    /**
     * Post-pilot durable path may bind the candidate via the factory-release
     * version index instead of hybrid pack_provenance. When provided, the index
     * candidate OID is checked against the train head.
     */
    durableCandidateGitSha?: string | null;
  },
): void {
  const provenance = evidence.pack_provenance;
  if (!provenance) {
    // Hybrid pack_provenance is v1.33.0-only. Later releases use durable
    // factory-release prepare binding (version index / request checkpoint).
    if (isPostPilotReleaseVersion(intent.version)) {
      if (provenance != null) {
        throw new Error(
          `ship FRG: hybrid pack_provenance is not accepted for v${intent.version}; ` +
            `use durable factory-release prepare after v${FRG_HYBRID_PILOT_VERSION}`,
        );
      }
      const bound = opts?.durableCandidateGitSha?.toLowerCase() ?? null;
      if (!bound) {
        throw new Error(
          "ship FRG: post-pilot release evidence has no durable candidate binding; " +
            "run pipeline factory-release prepare --request <absolute-request.json> --json " +
            "from the exact integrated candidate",
        );
      }
      if (bound !== train.integrated_head_oid) {
        throw new Error("ship FRG: durable candidate binding does not match the exact train candidate");
      }
      return;
    }
    throw new Error(
      "ship FRG: release evidence has no candidate provenance; " +
        "the fixed-pack producer must bind the exact repository, base branch, and candidate OID",
    );
  }
  if (intent.version !== FRG_HYBRID_PILOT_VERSION) {
    throw new Error(
      `ship FRG: hybrid pack_provenance is valid only for v${FRG_HYBRID_PILOT_VERSION}; ` +
        `got ${intent.version}`,
    );
  }
  if (provenance.candidate_git_sha.toLowerCase() !== train.integrated_head_oid ||
      provenance.repository.toLowerCase() !== intent.repository ||
      provenance.base_branch !== intent.base_branch) {
    throw new Error("ship FRG: pack provenance does not match the exact train candidate");
  }
}

function emptyProgress(): ShipProgress {
  return {
    train: null,
    frg_pack: null,
    frg: null,
    release: null,
    release_finish: null,
    publication: null,
    promotion: null,
  };
}

function projectFrgPack(
  intent: ShipIntent,
  train: ShipTrainEvidence,
  evidence: FrgEvidence,
): ShipFrgPackEvidence {
  return {
    version: intent.version,
    complete: true,
    loop_run_id: evidence.loop_run_id!,
    pack_id: evidence.pack_id!,
    candidate_head_oid: train.integrated_head_oid,
  };
}

function projectFrg(
  intent: ShipIntent,
  pack: ShipFrgPackEvidence,
  evidence: FrgEvidence,
): ShipFrgEvidence {
  return {
    version: intent.version,
    pass: true,
    loop_run_id: pack.loop_run_id,
    frg_run_id: evidence.run_id,
    candidate_head_oid: pack.candidate_head_oid,
  };
}

/** Compose restart-safe coordinator deps from externally observable operations. */
export function shipCoordinatorDepsFromOperations(
  operations: ShipAdapterOperations,
  opts: {
    state: ShipStateStore;
    now?: () => Date;
  },
): ShipCoordinatorDeps {
  const trainCheckpoints = new Map<string, ShipTrainEvidence>();
  const rememberTrain = (train: ShipTrainEvidence): ShipTrainEvidence => {
    trainCheckpoints.set(train.integrated_head_oid, train);
    return train;
  };
  const reobserveRememberedTrain = async (
    intent: ShipIntent,
    candidateHeadOid: string,
  ): Promise<ShipTrainEvidence | null> => {
    const remembered = trainCheckpoints.get(candidateHeadOid);
    if (!remembered) return null;
    const observed = await operations.observeTrain(
      intent,
      remembered.ordered_issues,
      candidateHeadOid,
    );
    return observed ? rememberTrain({ ...observed, completed_at: remembered.completed_at }) : null;
  };
  const observeValidatedFrg = async (
    intent: ShipIntent,
    train: ShipTrainEvidence,
    requireCurrentCandidate: boolean,
  ): Promise<FrgEvidence | null> =>
    operations.observeFrg(intent, train, requireCurrentCandidate);

  return {
    now: opts.now ?? (() => new Date()),
    state: opts.state,
    authorizationPublicKey: opts.authorizationPublicKey,
    withRunLock: (key, fn) => withLock(`ship-${key}`, fn),

    planTrain: operations.planTrain,

    async reconcile(intent, checkpoint) {
      const progress = emptyProgress();
      if (!checkpoint.train_plan) return progress;
      const train = await operations.observeTrain(
        intent,
        checkpoint.train_plan.ordered_issues,
        checkpoint.train?.integrated_head_oid,
      );
      if (!train) return progress;
      // Retain useful local identity only after live integration truth proves
      // the same candidate. A newly advanced base invalidates all later stages.
      progress.train = checkpoint.train?.integrated_head_oid === train.integrated_head_oid
        ? checkpoint.train
        : train;
      rememberTrain(progress.train);

      // Once a later authorized stage exists, the release merge may have
      // advanced base. Reconciliation still verifies the retained FRG artifact
      // against its candidate but does not reapply the pre-release base-tip gate.
      const frgEvidence = await operations.observeFrg(intent, progress.train, !checkpoint.frg);
      if (!frgEvidence) return progress;
      const observedPack = projectFrgPack(intent, progress.train, frgEvidence);
      progress.frg_pack = checkpoint.frg_pack?.candidate_head_oid === observedPack.candidate_head_oid &&
          checkpoint.frg_pack.loop_run_id === observedPack.loop_run_id &&
          checkpoint.frg_pack.pack_id === observedPack.pack_id
        ? checkpoint.frg_pack
        : observedPack;
      const observedFrg = projectFrg(intent, progress.frg_pack, frgEvidence);
      progress.frg = checkpoint.frg?.candidate_head_oid === observedFrg.candidate_head_oid &&
          checkpoint.frg.loop_run_id === observedFrg.loop_run_id &&
          checkpoint.frg.frg_run_id === observedFrg.frg_run_id
        ? checkpoint.frg
        : observedFrg;

      const release = await operations.observeRelease(intent, progress.frg.candidate_head_oid);
      if (!release) return progress;
      if (checkpoint.release &&
          (checkpoint.release.pr !== release.prepare.pr ||
            checkpoint.release.head_oid !== release.prepare.head_oid ||
            checkpoint.release.candidate_head_oid !== release.prepare.candidate_head_oid)) {
        throw new Error("ship release: persisted release PR identity changed during reconciliation");
      }
      progress.release = checkpoint.release ?? release.prepare;
      progress.release_finish = release.finish && checkpoint.release_finish?.pr === release.finish.pr &&
          checkpoint.release_finish.head_oid === release.finish.head_oid &&
          checkpoint.release_finish.merge_commit_oid === release.finish.merge_commit_oid
        ? checkpoint.release_finish
        : release.finish;
      if (!release.finish) return progress;

      progress.publication = await operations.observePublication(intent, release.finish);
      if (!progress.publication) return progress;
      progress.promotion = await operations.observePromotion(intent, progress.publication);
      return progress;
    },

    async convergeTrain(intent, plannedIssues) {
      const observed = await operations.observeTrain(intent, plannedIssues);
      if (observed) return rememberTrain(observed);
      return rememberTrain(await operations.runTrain(intent, plannedIssues));
    },

    async convergeFrgPack(intent, trainEvidence) {
      const train = await operations.observeTrain(
        intent,
        trainEvidence.ordered_issues,
        trainEvidence.integrated_head_oid,
      );
      if (!train || train.integrated_head_oid !== trainEvidence.integrated_head_oid) {
        throw new Error("ship FRG: integrated base changed after train; run the same ship command to reconcile");
      }
      const retainedTrain = rememberTrain({ ...train, completed_at: trainEvidence.completed_at });
      const evidence = await observeValidatedFrg(intent, retainedTrain, true);
      if (!evidence) {
        if (isPostPilotReleaseVersion(intent.version)) {
          throw new Error(
            `ship FRG: no release-eligible candidate artifact for v${intent.version}. ` +
              `Auto-generate genuine FRG via the durable path (not a synthetic trivial pack):\n` +
              `  pipeline factory-release prepare --request <absolute-request.json> --json\n` +
              `Multi-tick protocol: first call starts/resumes a bound pack loop and ` +
              `returns in_progress; after the loop is scored --from-run (no --observations) ` +
              `it returns awaiting_frg_attestation; after the production-owned attestor ` +
              `stores the MAC, the next unchanged call returns complete (or write attested ` +
              `latest.json and retry ship). ` +
              `Hybrid pilot remains valid only for exactly v${FRG_HYBRID_PILOT_VERSION}.`,
          );
        }
        throw new Error(
          `ship FRG: no release-eligible candidate artifact for v${intent.version}. ` +
            `Complete the shipped fixed pack, run ` +
            `pipeline factory-gate --for ${intent.version} --from-run <loop-run-id> ` +
            `--observations <file>, then retry the same ship command.`,
        );
      }
      return projectFrgPack(intent, trainEvidence, evidence);
    },

    async convergeFrgScore(intent, pack) {
      const train = await reobserveRememberedTrain(intent, pack.candidate_head_oid);
      if (!train) {
        throw new Error("ship FRG: candidate base changed before scoring; run the same ship command to reconcile");
      }
      const evidence = await observeValidatedFrg(intent, train, true);
      if (!evidence || evidence.loop_run_id !== pack.loop_run_id || evidence.pack_id !== pack.pack_id) {
        throw new Error("ship FRG: the release-eligible artifact changed between pack and score checks");
      }
      return projectFrg(intent, pack, evidence);
    },

    async convergeReleasePrepare(intent, frg) {
      const existing = await operations.observeRelease(intent, frg.candidate_head_oid);
      if (existing) return existing.prepare;
      const train = await reobserveRememberedTrain(intent, frg.candidate_head_oid);
      if (!train) {
        throw new Error("ship release: base changed after FRG; start a new candidate shipment");
      }
      return operations.prepareRelease(intent, frg.candidate_head_oid);
    },

    async convergeReleaseFinish(intent, release) {
      const train = await reobserveRememberedTrain(intent, release.candidate_head_oid);
      if (!train) throw new Error("ship release: train candidate cannot be revalidated before finish");
      const frg = await observeValidatedFrg(intent, train, true);
      if (!frg) throw new Error("ship release: FRG evidence is no longer valid before finish");
      const existing = await operations.observeRelease(intent, release.candidate_head_oid);
      if (existing?.finish) return existing.finish;
      if (existing && (existing.prepare.pr !== release.pr || existing.prepare.head_oid !== release.head_oid)) {
        throw new Error("ship release: observed release PR identity differs from prepared identity");
      }
      return operations.finishRelease(intent, release);
    },

    async waitForRelease(intent, release) {
      return await operations.observePublication(intent, release) ??
        operations.waitForPublication(intent, release);
    },

    async convergeEnginePromote(intent, publication) {
      return await operations.observePromotion(intent, publication) ??
        operations.promote(intent, publication);
    },
  };
}

function normalizeIssue(row: {
  number: number;
  title?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  state?: string;
}): TrainIssueSnapshot {
  return {
    number: row.number,
    title: row.title ?? "",
    body: row.body ?? "",
    labels: (row.labels ?? []).map((label) => String(label.name ?? "")).filter(Boolean),
    state: String(row.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open",
  };
}

function realShipAdapterOperations(opts: RealShipCoordinatorDepsOptions): ShipAdapterOperations {
  const mergeDeps = { ...realMergeDeps(opts.repo), log: opts.progress };
  const ghCfg = { repo: opts.repo } as PipelineConfig;
  const releaseFinishDeps = realReleaseFinishDeps(opts.repo, opts.repoDir);
  const engineDeps = realEnginePromoteDeps(opts.repoDir);

  const ghJson = async (args: string[]): Promise<unknown> => {
    const { stdout } = await execFileAsync("gh", [...args, "-R", opts.repo], {
      cwd: opts.repoDir,
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(String(stdout));
  };
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.repoDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout).trim();
  };

  const listMilestoneIssues = async (
    milestone: string,
    state: "open" | "all",
  ): Promise<TrainIssueSnapshot[]> => {
    const rows = await ghJson([
      "issue", "list", "--milestone", milestone, "--state", state, "--limit", "200",
      "--json", "number,title,body,labels,state",
    ]) as Array<Parameters<typeof normalizeIssue>[0]>;
    if (rows.length >= 200) {
      throw new Error(
        `ship train: milestone ${JSON.stringify(milestone)} reached the 200-issue discovery limit; ` +
          "split the milestone or add paginated discovery before authorizing a shipment",
      );
    }
    return rows.map(normalizeIssue);
  };

  const getPrForIssueAll = async (issue: number): Promise<number | null> => {
    return getPrForIssueAnyState(ghCfg, issue);
  };

  const trainDeps = (): TrainDeps => {
    const base = realTrainDeps({
      repoDir: opts.repoDir,
      repo: opts.repo,
      baseBranch: opts.baseBranch,
      // Production ship uses the injected multi-item wave (loop engine), not
      // a per-issue single loop — see integrated-train-mode #1023.
      advanceWave: opts.advanceWave,
      mergeDeps,
    });
    return {
      ...base,
      log: opts.progress,
      listMilestoneIssues: (milestone) => listMilestoneIssues(milestone, "all"),
      getPrForIssue: getPrForIssueAll,
    };
  };

  const observeBase = async (): Promise<string> => {
    await git(["fetch", "origin", opts.baseBranch]);
    return requireOid(await git(["rev-parse", `origin/${opts.baseBranch}`]), "ship candidate head");
  };

  const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
    try {
      await git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };

  const observeTrain = async (
    intent: ShipIntent,
    plannedIssues: readonly number[],
    candidateHeadOid?: string,
  ): Promise<ShipTrainEvidence | null> => {
    const deps = trainDeps();
    if (plannedIssues.length === 0) return null;
    const ordered = [...plannedIssues];
    const baseTip = await observeBase();
    const candidate = candidateHeadOid
      ? requireOid(candidateHeadOid, "ship train checkpoint candidate")
      : baseTip;
    if (!(await isAncestor(candidate, baseTip))) return null;
    for (const issue of ordered) {
      const pr = await getPrForIssueAll(issue);
      if (pr === null) return null;
      const data = await mergeDeps.ghPrView(pr, ["state", "mergedAt", "mergeCommit"]);
      const mergedAt = Date.parse(String(data.mergedAt ?? ""));
      const mergeCommit = data.mergeCommit as { oid?: string } | null | undefined;
      const mergeOid = mergeCommit?.oid ? requireOid(String(mergeCommit.oid), `ship train PR #${pr} merge commit`) : null;
      if (String(data.state ?? "").toUpperCase() !== "MERGED" || !mergeOid ||
          !(await deps.isAncestor(mergeOid, candidate)) || !Number.isFinite(mergedAt)) {
        return null;
      }
    }
    return {
      repository: intent.repository,
      base_branch: intent.base_branch,
      milestone: intent.milestone,
      complete: true,
      ordered_issues: ordered,
      run_id: null,
      integrated_head_oid: candidate,
      completed_at: new Date().toISOString(),
    };
  };

  const observeFrg = async (
    intent: ShipIntent,
    train: ShipTrainEvidence,
    requireCurrentCandidate: boolean,
  ): Promise<FrgEvidence | null> => {
    const before = await observeBase();
    if (requireCurrentCandidate && before !== train.integrated_head_oid) {
      throw new Error("ship FRG: base advanced after the integrated train candidate was recorded");
    }
    if (!requireCurrentCandidate &&
        !(await isAncestor(train.integrated_head_oid, before))) {
      throw new Error("ship FRG: recorded train candidate is no longer contained in base");
    }
    let evidence: FrgEvidence;
    try {
      evidence = await validateFrgEvidenceFileForTag(opts.repoDir, intent.version);
    } catch (err) {
      if ((err as Error).message.includes("evidence missing")) return null;
      throw err;
    }
    let durableCandidate: string | null = null;
    if (isPostPilotReleaseVersion(intent.version) && !evidence.pack_provenance) {
      const indexPath = factoryReleaseVersionIndexPath(opts.repoDir, intent.version);
      try {
        const indexRaw = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
          candidate_git_sha?: string;
          version?: string;
        };
        if (
          indexRaw.version === intent.version &&
          typeof indexRaw.candidate_git_sha === "string" &&
          /^[0-9a-f]{40,64}$/i.test(indexRaw.candidate_git_sha)
        ) {
          durableCandidate = indexRaw.candidate_git_sha.toLowerCase();
        }
      } catch {
        durableCandidate = null;
      }
    }
    assertFrgCandidateProvenance(evidence, train, intent, {
      durableCandidateGitSha: durableCandidate,
    });
    const after = await observeBase();
    if (after !== before) throw new Error("ship FRG: base advanced while FRG evidence was checked");
    return evidence;
  };

  const observeRelease = async (
    intent: ShipIntent,
    candidateHeadOid?: string,
  ): Promise<ObservedRelease | null> => {
    const branch = `release/v${intent.version}`;
    const rows = await ghJson([
      "pr", "list", "--state", "all", "--head", branch, "--limit", "10",
      "--json", "number,title,state,baseRefName,headRefOid,mergedAt,mergeCommit,isCrossRepository,headRepositoryOwner",
    ]) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new Error(`ship release: multiple PRs use head ${branch}`);
    const row = rows[0]!;
    const parsed = parseReleasePrTitle(String(row.title ?? ""));
    const pr = Number(row.number);
    const headOid = requireOid(String(row.headRefOid ?? ""), "ship release head");
    const headOwner = row.headRepositoryOwner as { login?: string } | null | undefined;
    const expectedOwner = intent.repository.split("/")[0]!;
    if (!parsed || parsed.version !== intent.version || row.baseRefName !== intent.base_branch ||
        row.isCrossRepository === true || String(headOwner?.login ?? "").toLowerCase() !== expectedOwner ||
        !Number.isSafeInteger(pr) || pr <= 0) {
      throw new Error("ship release: observed release PR identity does not match the shipment");
    }
    const prepare: ShipReleaseEvidence = {
      repository: intent.repository,
      base_branch: intent.base_branch,
      version: intent.version,
      pr,
      head_oid: headOid,
      candidate_head_oid: requireOid(
        candidateHeadOid ?? "",
        "ship release candidate checkpoint",
      ),
    };
    if (candidateHeadOid) {
      const candidate = requireOid(candidateHeadOid, "ship release candidate");
      await git(["fetch", "origin", `refs/pull/${pr}/head`]);
      if (!(await isAncestor(candidate, headOid))) {
        throw new Error("ship release: release PR head does not contain the exact train candidate");
      }
    }
    if (String(row.state ?? "").toUpperCase() !== "MERGED") return { prepare, finish: null };
    const mergeCommit = row.mergeCommit as { oid?: string } | null | undefined;
    return {
      prepare,
      finish: {
        ...prepare,
        merged: true,
        merge_commit_oid: requireOid(String(mergeCommit?.oid ?? ""), "ship release merge commit"),
      },
    };
  };

  const observePublication = async (
    intent: ShipIntent,
    release: ShipReleaseFinishEvidence,
  ): Promise<ShipPublicationEvidence | null> => {
    const tag = expectedTag(intent.version);
    let data: { isDraft?: boolean; tagName?: string };
    try {
      data = await ghJson(["release", "view", tag, "--json", "isDraft,tagName"]) as typeof data;
    } catch {
      return null;
    }
    if (data.isDraft || (data.tagName !== tag && data.tagName !== intent.version)) return null;
    await git(["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    await verifyAnnotatedReleaseTag(tag, release.merge_commit_oid, git);
    return { version: intent.version, tag, published: true };
  };

  return {
    async planTrain(intent) {
      const issues = await listMilestoneIssues(intent.milestone, "open");
      if (issues.length === 0) {
        throw new Error(`ship train: milestone ${JSON.stringify(intent.milestone)} has no open issues to freeze`);
      }
      return { ordered_issues: orderIssuesByDeclaredDeps(issues) };
    },
    observeTrain,
    async runTrain(intent, plannedIssues) {
      const result = await runTrain({
        issues: [...plannedIssues],
        merge: true,
        baseBranch: intent.base_branch,
        repoDir: opts.repoDir,
        repo: intent.repository,
      }, trainDeps());
      if (result.exitCode !== 0 || !result.status.complete) {
        throw new Error(result.status.blocker ?? "ship train did not complete");
      }
      const observed = await observeTrain(intent, plannedIssues);
      if (!observed) throw new Error("ship train completed but external integration proof is incomplete");
      return observed;
    },
    observeFrg,
    observeRelease,
    async prepareRelease(intent, candidateHeadOid) {
      if (await observeBase() !== candidateHeadOid) {
        throw new Error("ship release: base advanced after FRG; start a new candidate shipment");
      }
      await alignReleaseCheckoutToCandidate(intent.base_branch, candidateHeadOid, git);
      const cfg = resolveReleaseConfig(opts.repoDir, intent.base_branch, opts.profile);
      const baseDeps = realReleaseDeps(opts.repoDir);
      const result = await runRelease(intent.version, { noEdit: true }, {
        ...cfg,
        repo: intent.repository,
      }, {
        ...baseDeps,
        stdout: opts.progress,
        stderr: opts.progress,
      });
      if (!result) throw new Error("ship release: release prepare returned no live identity");
      return {
        repository: intent.repository,
        base_branch: result.base,
        version: result.version,
        pr: result.pr,
        head_oid: requireOid(result.head_oid, "ship release head"),
        candidate_head_oid: candidateHeadOid,
      };
    },
    async finishRelease(intent, release) {
      const result = await finishReleasePr(release.pr, {
        ...releaseFinishDeps,
        log: opts.progress,
      }, {
        pr: release.pr,
        version: intent.version,
        base: intent.base_branch,
        head_oid: release.head_oid,
      });
      if (!result.mergeCommitOid) throw new Error("ship release: merged PR has no merge commit identity");
      return {
        ...release,
        merged: true,
        merge_commit_oid: requireOid(result.mergeCommitOid, "ship release merge commit"),
      };
    },
    observePublication,
    async waitForPublication(intent, release) {
      for (let attempt = 0; attempt < RELEASE_WAIT_ATTEMPTS; attempt++) {
        const observed = await observePublication(intent, release);
        if (observed) return observed;
        if (attempt + 1 < RELEASE_WAIT_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, RELEASE_WAIT_MS));
        }
      }
      throw new Error(
        `ship release: timed out waiting for published GitHub Release ${expectedTag(intent.version)}; ` +
          "verify the release workflow, then retry the same ship command",
      );
    },
    async observePromotion(intent, publication) {
      const release = await engineDeps.verifyPublishedRelease(publication.tag);
      if (!release.ok) return null;
      const pin = await engineDeps.loadPin({ repoDir: opts.repoDir });
      const installed = await engineDeps.installedVersion();
      if (pin.kind !== "ok" || pin.pin.version !== intent.version ||
          pin.pin.tag !== publication.tag || installed?.replace(/^[vV]/, "") !== intent.version) {
        return null;
      }
      return {
        version: intent.version,
        tag: publication.tag,
        verified: true,
        installed_version: intent.version,
      };
    },
    async promote(intent, publication) {
      const result = await runEnginePromote({
        version: intent.version,
        repoDir: opts.repoDir,
      }, {
        ...engineDeps,
        log: opts.progress,
      });
      if (!result.verified || result.error) {
        throw new Error(`ship engine-promote: ${result.error ?? "installed version was not verified"}`);
      }
      return {
        version: intent.version,
        tag: publication.tag,
        verified: true,
        installed_version: intent.version,
      };
    },
  };
}

/** Production factory used by the `pipeline ship` CLI. */
export function realShipCoordinatorDeps(opts: RealShipCoordinatorDepsOptions): ShipCoordinatorDeps {
  if (!opts.repo || opts.repo.toLowerCase() !== opts.repo.trim().toLowerCase() ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(opts.repo)) {
    throw new Error("pipeline ship: repository must be an explicit owner/name");
  }
  if (!opts.progress) throw new Error("pipeline ship: progress callback is required");
  return shipCoordinatorDepsFromOperations(realShipAdapterOperations(opts), {
    state: opts.state ?? defaultShipStateStore(opts.env),
  });
}
