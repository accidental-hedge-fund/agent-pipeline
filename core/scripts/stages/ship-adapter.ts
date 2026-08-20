// Production composition for the Pipeline-owned ship coordinator.
//
// This file adapts existing Pipeline capabilities to ShipCoordinatorDeps. It
// does not add another scheduler, retry model, merge implementation, or FRG
// evidence producer. Each converge operation first observes external truth.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveEngineCommitSha } from "../engine-attribution.ts";
import {
  parseExactGitSha,
} from "../ship-end-identity.ts";
import {
  assertShipEndLeafArgv,
  attestorChildEnv,
  pinShaDiffersFromCandidate,
  resolveCandidateEngine,
  shipEndCliPrefix,
  shipEndLeafArgv,
  uncredentialedPrepareEnv,
  type CandidateEngine,
  type CandidateEngineResult,
  type ResolveCandidateEngineDeps,
} from "../ship-end-candidate.ts";
import {
  frgLatestPath,
  validateFrgEvidenceFileForTag,
  type FrgEvidence,
} from "../factory-reliability-gate.ts";
import { FRG_HYBRID_PILOT_VERSION } from "../frg-pack-observations.ts";
import {
  FACTORY_RELEASE_REQUEST_KIND,
  factoryReleaseVersionIndexPath,
  isPostPilotReleaseVersion,
} from "../factory-release-prepare.ts";
import { resolveReleaseConfig } from "../config.ts";
import { getPrForIssueAnyState } from "../gh.ts";
import { withLock } from "../lock.ts";
import { resolveStateHome } from "../loop/store.ts";
import { LOOP_LEDGER_SCHEMA } from "../loop/types.ts";
import type { PipelineConfig } from "../types.ts";
import {
  defaultShipStateStore,
  shipKey,
  shipStatePaths,
  type ShipCoordinatorDeps,
  type ShipFrgEvidence,
  type ShipFrgPackEvidence,
  type ShipIntent,
  type ShipPhaseEvent,
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
const FRG_WAIT_ATTEMPTS = 120;
const FRG_WAIT_MS = 10_000;
const SAFE_LOOP_RUN_ID = /^[A-Za-z0-9._-]+$/;
const TERMINAL_LOOP_EVENT_KINDS = new Set([
  "loop_run_complete",
  "loop_run_stopped",
  "run_complete",
]);

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
  /**
   * Optional candidate FRG pack. When present, convergeFrgPack runs this
   * before observing evidence so a pin process can spawn candidate prepare/gate.
   */
  runFrgPack?(intent: ShipIntent, train: ShipTrainEvidence): Promise<void>;
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
  /** Running process source SHA. Injected in tests; default is this engine checkout. */
  pinCommitSha?: string | null;
  resolveCandidateEngine?: (sha: string) => Promise<CandidateEngineResult>;
  spawnShipEnd?: (
    argv: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  spawnEnsureTag?: (
    engine: CandidateEngine,
    opts: { version: string; mergeCommitOid: string; packedCandidate: string },
  ) => Promise<void>;
  factoryReleaseRequestPath?: string;
  /** Persist or resume the ship-bound factory-release request JSON. */
  resolveFactoryReleaseRequestPath?(
    intent: ShipIntent,
    train: ShipTrainEvidence,
  ): Promise<string>;
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
  ref = `refs/tags/${tag}`,
): Promise<void> {
  const expected = requireOid(expectedCommitOid, "ship release merge commit");
  const objectType = (await git(["cat-file", "-t", ref])).trim();
  if (objectType !== "tag") {
    throw new Error(`ship release: ${tag} must be an annotated tag (got ${objectType || "missing"})`);
  }
  const peeled = requireOid(await git(["rev-parse", `${ref}^{}`]), "ship release peeled tag commit");
  if (peeled !== expected) {
    throw new Error(`ship release: ${tag} does not point to the release merge commit`);
  }
}

function candidateShaFromRecord(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return parseExactGitSha((raw as Record<string, unknown>).candidate_git_sha);
}

/**
 * HMAC recorded packed-candidate SHA from on-disk latest.json.
 * Prefer factory_release_binding.candidate_git_sha; else pack_provenance.
 */
export function hmacPackedCandidateGitShaFromUnknown(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const fromBinding = candidateShaFromRecord(rec.factory_release_binding);
  if (fromBinding) return fromBinding;
  if (Array.isArray(rec.notes)) {
    for (const note of rec.notes) {
      if (typeof note !== "string" || !note.startsWith("factory_release_binding:")) continue;
      try {
        const parsed: unknown = JSON.parse(note.slice("factory_release_binding:".length));
        const sha = candidateShaFromRecord(parsed);
        if (sha) return sha;
      } catch {
        // malformed note carrier is not a second validator
      }
    }
  }
  return candidateShaFromRecord(rec.pack_provenance);
}

export async function readHmacPackedCandidateGitSha(
  repoDir: string,
  version: string,
): Promise<string | null> {
  const latestPath = frgLatestPath(repoDir, version);
  let text: string;
  try {
    text = await fs.readFile(latestPath, "utf8");
  } catch {
    return null;
  }
  try {
    return hmacPackedCandidateGitShaFromUnknown(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * After a merged release PR, if FRG latest.json is release-eligible and the
 * annotated tag is missing, create and push it on the peeled merge commit.
 * Does not open a second release PR. Never force-updates or deletes the tag.
 */
export async function ensureAnnotatedReleaseTag(opts: {
  version: string;
  mergeCommitOid: string;
  packedCandidate: string;
  git: (args: string[]) => Promise<string>;
  validateFrg: () => Promise<void>;
  hmacCandidateGitSha: () => Promise<string | null>;
}): Promise<"created" | "exists"> {
  const tag = expectedTag(opts.version);
  const merge = requireOid(opts.mergeCommitOid, "ship release merge commit");
  const packed = requireOid(opts.packedCandidate, "ship packed candidate");
  const peeled = requireOid(
    await opts.git(["rev-parse", "--verify", `${merge}^{commit}`]),
    "ship release peeled merge commit",
  );
  try {
    const objectType = (await opts.git(["cat-file", "-t", `refs/tags/${tag}`])).trim();
    if (objectType === "tag") {
      await verifyAnnotatedReleaseTag(tag, peeled, opts.git);
      return "exists";
    }
    if (objectType) {
      throw new Error(`ship release: ${tag} must be an annotated tag (got ${objectType})`);
    }
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("does not point to the release merge commit") || msg.includes("must be an annotated tag")) {
      throw err;
    }
  }
  await opts.validateFrg();
  const hmacSha = parseExactGitSha(await opts.hmacCandidateGitSha());
  if (!hmacSha) {
    throw new Error(
      "ship release: on-disk HMAC latest.json has no candidate_git_sha bound to this ship's packed candidate",
    );
  }
  if (hmacSha !== packed) {
    throw new Error(
      "ship release: HMAC candidate_git_sha is not this ship's packed candidate",
    );
  }
  await opts.git(["tag", "-a", tag, peeled, "-m", `${tag} — v${opts.version}`]);
  try {
    await opts.git(["push", "origin", `refs/tags/${tag}`]);
    return "created";
  } catch {
    const observeRef = `refs/tags/${tag}-origin-observe`;
    await opts.git(["fetch", "origin", `refs/tags/${tag}:${observeRef}`]);
    await verifyAnnotatedReleaseTag(tag, peeled, opts.git, observeRef);
    return "exists";
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
      if (typeof operations.runFrgPack === "function") {
        await operations.runFrgPack(intent, retainedTrain);
      }
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
      await ensureAnnotatedReleaseTag({
        version: intent.version,
        mergeCommitOid: release.merge_commit_oid,
        packedCandidate: release.candidate_head_oid,
        git,
        validateFrg: () => validateFrgEvidenceFileForTag(opts.repoDir, intent.version).then(() => undefined),
        hmacCandidateGitSha: () => readHmacPackedCandidateGitSha(opts.repoDir, intent.version),
      });
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

export type BoundPackLoopLiveness = "live" | "not-live" | "unknown";

export interface CandidateShipEndContext {
  pinCommitSha: string | null;
  repoDir: string;
  env: NodeJS.ProcessEnv;
  nodeBin?: string;
  factoryReleaseRequestPath?: string;
  resolveFactoryReleaseRequestPath?(
    intent: ShipIntent,
    train: ShipTrainEvidence,
  ): Promise<string>;
  resolveCandidate(sha: string): Promise<CandidateEngineResult>;
  spawn(
    argv: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  spawnEnsureTag?(
    engine: CandidateEngine,
    opts: { version: string; mergeCommitOid: string; packedCandidate: string },
  ): Promise<void>;
  delay?(ms: number): Promise<void>;
  frgWaitAttempts?: number;
  isBoundPackLoopLive?(
    loopRunId: string,
  ): Promise<boolean | BoundPackLoopLiveness> | boolean | BoundPackLoopLiveness;
  isPidAlive?(pid: number): Promise<boolean> | boolean;
  readTextFile?(p: string): Promise<string | null> | string | null;
  onFrgWaitTick?(tick: {
    intent: ShipIntent;
    attempt: number;
    loopRunId: string;
    live: BoundPackLoopLiveness;
  }): Promise<void> | void;
}

function candidateIdentityError(detail: string): Error {
  return new Error(`ship candidate-engine identity defect: ${detail}`);
}

async function spawnLeaf(
  ctx: CandidateShipEndContext,
  engine: CandidateEngine,
  leaf: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = [...shipEndCliPrefix(engine, ctx.nodeBin ?? "node"), ...leaf];
  assertShipEndLeafArgv(argv);
  return ctx.spawn(argv, env);
}

async function delayMs(ctx: CandidateShipEndContext, ms: number): Promise<void> {
  if (ctx.delay) {
    await ctx.delay(ms);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parsePrepareStdout(stdout: string): Record<string, unknown> | null {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  const tryParse = (raw: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const brace = text.lastIndexOf("{");
  return brace >= 0 ? tryParse(text.slice(brace)) : null;
}

function closedArtifactRef(ref: unknown): boolean {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
  const rec = ref as { path?: unknown; sha256?: unknown };
  const p = String(rec.path ?? "").trim();
  const sha = String(rec.sha256 ?? "").trim().toLowerCase();
  if (!p || p === "/dev/null") return false;
  if (sha.length !== 64 || sha === "0".repeat(64)) return false;
  return /^[0-9a-f]{64}$/.test(sha);
}

function hasUnsignedEligibleArtifacts(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  const payloads = [parsed.frg, parsed.unsigned];
  return payloads.some((payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const rec = payload as { observations?: unknown; evidence_bundle?: unknown };
    return closedArtifactRef(rec.observations) && closedArtifactRef(rec.evidence_bundle);
  });
}

type CandidatePrepareTick = "done" | "attest" | "retry" | "fail";

function classifyCandidatePrepareTick(
  parsed: Record<string, unknown> | null,
  exitCode: number,
): CandidatePrepareTick {
  const status = typeof parsed?.status === "string" ? parsed.status : null;
  if (status === "complete") return "done";
  if (status === "awaiting_frg_attestation") return "attest";
  if (status === "in_progress") {
    return hasUnsignedEligibleArtifacts(parsed) ? "attest" : "retry";
  }
  if (status === "failed" || status === "error" || status === "missing" || !parsed || exitCode !== 0) {
    return "fail";
  }
  return "fail";
}

function prepareLoopRunId(parsed: Record<string, unknown> | null): string {
  if (!parsed) return "";
  const top = typeof parsed.loop_run_id === "string" ? parsed.loop_run_id.trim() : "";
  if (top) return top;
  const frg = parsed.frg;
  if (frg && typeof frg === "object" && !Array.isArray(frg)) {
    const nested = (frg as { loop_run_id?: unknown }).loop_run_id;
    if (typeof nested === "string") return nested.trim();
  }
  return "";
}

export type FrgPackWaitDecision = "continue" | "fail";

function waitLivenessContinues(live: boolean | BoundPackLoopLiveness): boolean {
  return live !== false && live !== "not-live";
}

function normalizeBoundPackLoopLiveness(
  raw: boolean | BoundPackLoopLiveness,
): BoundPackLoopLiveness {
  if (raw === "live" || raw === "not-live" || raw === "unknown") return raw;
  return raw ? "live" : "not-live";
}

/** retry + live or unknown continues even when attempt == cap. Cap applies only when not-live. */
export function classifyFrgPackWaitDecision(input: {
  tick: CandidatePrepareTick;
  live: boolean | BoundPackLoopLiveness;
  attempt: number;
  cap: number;
}): FrgPackWaitDecision {
  if (input.tick !== "retry") return "continue";
  if (waitLivenessContinues(input.live)) return "continue";
  if (Number.isInteger(input.attempt) && Number.isInteger(input.cap) && input.attempt < input.cap) {
    return "continue";
  }
  return "fail";
}

/**
 * Live when lock pid is alive OR ledger is present and not terminal.
 * Unknown when lock or ledger state is unreadable or malformed and neither
 * signal positively proves live. Not-live only after a dead-or-missing pid
 * and a terminal-or-missing ledger.
 */
export function classifyBoundPackLoopLiveness(input: {
  lockPidAlive: boolean;
  lockUnreadable?: boolean;
  ledgerPresent: boolean;
  ledgerStopPresent: boolean;
  ledgerUnreadable?: boolean;
  eventsTerminal: boolean;
}): BoundPackLoopLiveness {
  if (input.lockPidAlive) return "live";
  if (input.ledgerPresent && !input.ledgerStopPresent && !input.eventsTerminal) return "live";
  if (input.lockUnreadable || input.ledgerUnreadable) return "unknown";
  return "not-live";
}

/** Live when lock pid is alive OR ledger is present and not terminal. */
export function boundPackLoopIsLive(input: {
  lockPidAlive: boolean;
  ledgerPresent: boolean;
  ledgerStopPresent: boolean;
  eventsTerminal: boolean;
}): boolean {
  return classifyBoundPackLoopLiveness(input) === "live";
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function parseLockPidField(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) return null;
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }
  return null;
}

/** Closed set of LoopStopRecord.reason values. Incomplete or unknown reasons are not terminal. */
const DURABLE_LEDGER_STOP_REASONS = new Set([
  "recovery_exhausted",
  "consecutive_blocked",
  "needs_human_classification",
  "repeated_no_progress",
  "human_authority",
  "run_fatal",
  "supervisor_no_progress",
  "supervisor_cycle_cap",
  "dependency_deadlock",
  "worktree_capacity",
]);

/**
 * Null/absent stop is open. A LoopStopRecord-shaped object (known reason plus
 * non-empty time) is terminal. Incomplete or invalid stop values are malformed.
 */
function parseLedgerStopField(raw: unknown): "open" | "stop" | "invalid" {
  if (raw == null) return "open";
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const rec = raw as { reason?: unknown; time?: unknown; outstanding_ready?: unknown };
  if (typeof rec.reason !== "string" || !DURABLE_LEDGER_STOP_REASONS.has(rec.reason)) {
    return "invalid";
  }
  if (typeof rec.time !== "string" || rec.time.length === 0) return "invalid";
  if (rec.outstanding_ready !== undefined) {
    if (
      !Array.isArray(rec.outstanding_ready) ||
      rec.outstanding_ready.some((id) => typeof id !== "string")
    ) {
      return "invalid";
    }
  }
  return "stop";
}

/**
 * A stop is terminal only on a durable ledger envelope: schema plus a run_id
 * that matches the bound loop. Stop-only or identity-mismatched objects are
 * malformed, not proof the bound loop is dead.
 */
function parseDurableLedger(raw: unknown, expectedRunId: string): "open" | "stop" | "invalid" {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const rec = raw as { schema?: unknown; run_id?: unknown; stop?: unknown };
  if (rec.schema !== LOOP_LEDGER_SCHEMA) return "invalid";
  if (typeof rec.run_id !== "string" || rec.run_id !== expectedRunId) return "invalid";
  return parseLedgerStopField(rec.stop);
}

function eventsAreTerminal(text: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as { kind?: unknown; type?: unknown };
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
      const kind = String(ev.kind ?? ev.type ?? "");
      if (TERMINAL_LOOP_EVENT_KINDS.has(kind)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

type TextFileRead =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "unreadable" };

async function resolveTextFile(
  p: string,
  readTextFile?: (path: string) => Promise<string | null> | string | null,
): Promise<TextFileRead> {
  const asErrno = (err: unknown): string | undefined =>
    (err as NodeJS.ErrnoException).code;
  if (typeof readTextFile === "function") {
    try {
      const text = await readTextFile(p);
      if (text == null) return { status: "missing" };
      return { status: "ok", text };
    } catch (err) {
      if (asErrno(err) === "ENOENT") return { status: "missing" };
      return { status: "unreadable" };
    }
  }
  try {
    return { status: "ok", text: await fs.readFile(p, "utf8") };
  } catch (err) {
    if (asErrno(err) === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }
}

export async function probeBoundPackLoopLive(
  loopRunId: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    isPidAlive?: (pid: number) => Promise<boolean> | boolean;
    readTextFile?: (p: string) => Promise<string | null> | string | null;
  } = {},
): Promise<BoundPackLoopLiveness> {
  const id = loopRunId.trim();
  if (!SAFE_LOOP_RUN_ID.test(id) || id === "." || id === ".." || id.includes("..")) {
    return "not-live";
  }
  const env = opts.env ?? process.env;
  const home = resolveStateHome({ env, hostname: () => "unused" });
  const runDir = path.join(home, "runs", id);
  const lock = await resolveTextFile(path.join(runDir, "lock.json"), opts.readTextFile);
  let lockPidAlive = false;
  let lockUnreadable = lock.status === "unreadable";
  if (lock.status === "ok") {
    try {
      const parsed = JSON.parse(lock.text) as { pid?: unknown };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        lockUnreadable = true;
      } else {
        const pid = parseLockPidField(parsed.pid);
        if (pid === null) {
          lockUnreadable = true;
        } else {
          try {
            lockPidAlive = Boolean(await (opts.isPidAlive ?? defaultIsPidAlive)(pid));
          } catch {
            lockUnreadable = true;
          }
        }
      }
    } catch {
      lockUnreadable = true;
    }
  }
  const ledger = await resolveTextFile(path.join(runDir, "ledger.json"), opts.readTextFile);
  let ledgerPresent = false;
  let ledgerStopPresent = false;
  let ledgerUnreadable = ledger.status === "unreadable";
  if (ledger.status === "ok") {
    if (!ledger.text.trim()) {
      ledgerUnreadable = true;
    } else {
      try {
        const parsed: unknown = JSON.parse(ledger.text);
        const stopKind = parseDurableLedger(parsed, id);
        if (stopKind === "invalid") {
          ledgerUnreadable = true;
        } else {
          ledgerPresent = true;
          ledgerStopPresent = stopKind === "stop";
        }
      } catch {
        ledgerUnreadable = true;
      }
    }
  }
  const events = await resolveTextFile(path.join(runDir, "events.jsonl"), opts.readTextFile);
  const eventsTerminal = events.status === "ok" ? eventsAreTerminal(events.text) : false;
  return classifyBoundPackLoopLiveness({
    lockPidAlive,
    lockUnreadable,
    ledgerPresent,
    ledgerStopPresent,
    ledgerUnreadable,
    eventsTerminal,
  });
}

async function boundPackLoopLiveForWait(
  ctx: CandidateShipEndContext,
  loopRunId: string,
): Promise<BoundPackLoopLiveness> {
  if (typeof ctx.isBoundPackLoopLive === "function") {
    return normalizeBoundPackLoopLiveness(await ctx.isBoundPackLoopLive(loopRunId));
  }
  return probeBoundPackLoopLive(loopRunId, {
    env: ctx.env,
    isPidAlive: ctx.isPidAlive,
    readTextFile: ctx.readTextFile,
  });
}

async function resolveCandidateFactoryReleaseRequestPath(
  ctx: CandidateShipEndContext,
  intent: ShipIntent,
  train: ShipTrainEvidence,
): Promise<string> {
  const provided = ctx.factoryReleaseRequestPath?.trim();
  if (provided) {
    if (!path.isAbsolute(provided)) {
      throw new Error("ship FRG: factory-release prepare request path must be absolute");
    }
    return provided;
  }
  if (typeof ctx.resolveFactoryReleaseRequestPath === "function") {
    const resolved = String(await ctx.resolveFactoryReleaseRequestPath(intent, train) ?? "").trim();
    if (!resolved || !path.isAbsolute(resolved)) {
      throw new Error("ship FRG: resolved factory-release prepare request path must be absolute");
    }
    return resolved;
  }
  throw new Error(
    "ship FRG: missing factory-release prepare request path; will not skip candidate factory-release prepare",
  );
}

export function persistedShipFactoryReleaseRequestPath(
  intent: ShipIntent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    path.dirname(shipStatePaths(shipKey(intent), env).status_file),
    "factory-release-prepare-request.json",
  );
}

export async function persistShipFactoryReleaseRequest(
  intent: ShipIntent,
  train: ShipTrainEvidence,
  opts: { repoDir: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const dest = persistedShipFactoryReleaseRequestPath(intent, opts.env);
  try {
    const existing = await fs.readFile(dest, "utf8");
    if (existing.trim()) return dest;
  } catch {
    // Write a fresh request for this ship key.
  }
  const manifestPath = path.join(
    opts.repoDir,
    "core",
    "scripts",
    "frg-packs",
    "factory-gate-v1",
    "manifest.json",
  );
  let raw: Buffer;
  try {
    raw = await fs.readFile(manifestPath);
  } catch {
    throw new Error(
      `ship FRG: cannot write factory-release request; manifest missing at ${manifestPath}`,
    );
  }
  let packId = "factory-gate-v1";
  try {
    const pack = JSON.parse(raw.toString("utf8")) as { pack_id?: unknown };
    if (typeof pack.pack_id === "string" && pack.pack_id.trim()) packId = pack.pack_id.trim();
  } catch {
    throw new Error(`ship FRG: factory-release request manifest is not JSON: ${manifestPath}`);
  }
  const request = {
    schema_version: 1,
    kind: FACTORY_RELEASE_REQUEST_KIND,
    action_id: `pipeline-ship-${intent.version}`,
    repository: intent.repository,
    base_branch: intent.base_branch,
    target_version: intent.version,
    milestone: intent.milestone,
    integrated_candidate: { git_sha: train.integrated_head_oid },
    frg_manifest: {
      pack_id: packId,
      sha256: createHash("sha256").update(raw).digest("hex"),
    },
  };
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await fs.writeFile(dest, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return dest;
}

/** Observed identity of the version's release PR for `release ensure-tag`. */
export interface ObservedEnsureTagReleasePr {
  pr: number;
  title: string;
  state: string;
  mergeCommitOid: string | null;
}

/**
 * Require the caller-supplied OID to be the merge commit of the version's
 * completed release PR. Used by `release ensure-tag` before creating a tag.
 */
export function assertEnsureTagOidIsMergedRelease(opts: {
  version: string;
  mergeCommitOid: string;
  observed: ObservedEnsureTagReleasePr;
}): void {
  const expected = requireOid(opts.mergeCommitOid, "ship release merge commit");
  const parsed = parseReleasePrTitle(opts.observed.title);
  if (!parsed || parsed.version !== opts.version) {
    throw new Error(
      `ship release: ensure-tag observed PR is not the v${opts.version} release PR`,
    );
  }
  if (String(opts.observed.state ?? "").toUpperCase() !== "MERGED") {
    throw new Error(
      `ship release: ensure-tag requires the v${opts.version} release PR to be merged`,
    );
  }
  if (!opts.observed.mergeCommitOid) {
    throw new Error(
      `ship release: ensure-tag OID is not the merge commit of the v${opts.version} release PR`,
    );
  }
  const actual = requireOid(opts.observed.mergeCommitOid, "ship release merge commit");
  if (actual !== expected) {
    throw new Error(
      `ship release: ensure-tag OID is not the merge commit of the v${opts.version} release PR`,
    );
  }
}

async function defaultObserveMergedReleasePr(
  repoDir: string,
  repo: string | undefined,
  version: string,
): Promise<ObservedEnsureTagReleasePr> {
  if (!repo) {
    throw new Error(
      "ship release: candidate ensure-tag cannot re-observe the release PR without a repository",
    );
  }
  const branch = `release/v${version}`;
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr", "list",
      "--state", "all",
      "--head", branch,
      "--limit", "10",
      "--json", "number,title,state,mergeCommit,isCrossRepository",
      "-R", repo,
    ],
    {
      cwd: repoDir,
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const rows = JSON.parse(String(stdout)) as Array<{
    number?: unknown;
    title?: unknown;
    state?: unknown;
    mergeCommit?: { oid?: unknown } | null;
    isCrossRepository?: unknown;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`ship release: ensure-tag found no release PR for v${version}`);
  }
  if (rows.length > 1) {
    throw new Error(`ship release: multiple PRs use head ${branch}`);
  }
  const row = rows[0]!;
  const pr = Number(row.number);
  if (row.isCrossRepository === true || !Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("ship release: observed release PR identity does not match the shipment");
  }
  const mergeOid = row.mergeCommit && typeof row.mergeCommit.oid === "string"
    ? String(row.mergeCommit.oid)
    : null;
  return {
    pr,
    title: String(row.title ?? ""),
    state: String(row.state ?? ""),
    mergeCommitOid: mergeOid,
  };
}

/**
 * Candidate-process leaf for `pipeline release ensure-tag`.
 * Runs this engine's `ensureAnnotatedReleaseTag` against `repoDir`.
 * Before creating a missing tag, re-observes the version's release PR and
 * requires it to be merged with merge commit equal to `mergeCommitOid`.
 * Coordinator-side pin processes must spawn this verb on the candidate CLI
 * rather than importing this helper.
 */
export async function runEnsureAnnotatedReleaseTagCli(
  opts: {
    repoDir: string;
    version: string;
    mergeCommitOid: string;
    packedCandidate: string;
    repo?: string;
  },
  io?: {
    git?: (args: string[]) => Promise<string>;
    validateFrg?: () => Promise<void>;
    hmacCandidateGitSha?: () => Promise<string | null>;
    observeMergedReleasePr?: (version: string) => Promise<ObservedEnsureTagReleasePr>;
  },
): Promise<"created" | "exists"> {
  if (!opts.repoDir) {
    throw new Error(
      "ship release: candidate ensure-tag cannot run without a repository directory",
    );
  }
  const packedCandidate = requireOid(opts.packedCandidate, "ship packed candidate");
  const git = io?.git ?? (async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.repoDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout).trim();
  });
  const observeMergedReleasePr = io?.observeMergedReleasePr
    ?? ((version: string) => defaultObserveMergedReleasePr(opts.repoDir, opts.repo, version));
  const validateFrg = async () => {
    const observed = await observeMergedReleasePr(opts.version);
    assertEnsureTagOidIsMergedRelease({
      version: opts.version,
      mergeCommitOid: opts.mergeCommitOid,
      observed,
    });
    await (io?.validateFrg
      ?? (() => validateFrgEvidenceFileForTag(opts.repoDir, opts.version).then(() => undefined)))();
  };
  return ensureAnnotatedReleaseTag({
    version: opts.version,
    mergeCommitOid: opts.mergeCommitOid,
    packedCandidate,
    git,
    validateFrg,
    hmacCandidateGitSha: io?.hmacCandidateGitSha
      ?? (() => readHmacPackedCandidateGitSha(opts.repoDir, opts.version)),
  });
}

/**
 * Pin process stays the coordinator. When pin SHA ≠ candidate SHA, leaf
 * post-train verbs spawn the candidate launcher instead of in-process pin
 * runRelease / prepare / ensureAnnotatedReleaseTag. Tag is `release ensure-tag`.
 * Recursion is impossible: argv is never `ship --milestone` or `train`.
 */
export function bindCandidateShipEndOperations(
  pinOps: ShipAdapterOperations,
  ctx: CandidateShipEndContext,
): ShipAdapterOperations {
  const requireCandidate = async (sha: string): Promise<CandidateEngine> => {
    const resolved = await ctx.resolveCandidate(sha);
    if (!resolved.ok) throw candidateIdentityError(resolved.error);
    if (resolved.engine.commitSha !== parseExactGitSha(sha)) {
      throw candidateIdentityError(
        `resolved commit_sha ${resolved.engine.commitSha} does not equal candidate ${sha}`,
      );
    }
    return resolved.engine;
  };
  const shouldSpawn = (candidateSha: string): boolean =>
    pinShaDiffersFromCandidate(ctx.pinCommitSha, candidateSha);

  return {
    ...pinOps,
    async runFrgPack(intent, train) {
      const engine = await requireCandidate(train.integrated_head_oid);
      if (!shouldSpawn(train.integrated_head_oid)) {
        await pinOps.runFrgPack?.(intent, train);
        return;
      }
      const requestPath = await resolveCandidateFactoryReleaseRequestPath(ctx, intent, train);
      const attempts = ctx.frgWaitAttempts ?? FRG_WAIT_ATTEMPTS;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const prep = await spawnLeaf(
          ctx,
          engine,
          shipEndLeafArgv("factory-release-prepare", { requestPath }),
          uncredentialedPrepareEnv(ctx.env),
        );
        const parsed = parsePrepareStdout(prep.stdout);
        const verdict = classifyCandidatePrepareTick(parsed, prep.code);
        if (verdict === "done") return;
        if (verdict === "attest") {
          const loopRunId = prepareLoopRunId(parsed);
          if (!loopRunId) {
            throw new Error("ship FRG: candidate factory-release prepare is eligible but missing loop_run_id");
          }
          const gate = await spawnLeaf(
            ctx,
            engine,
            shipEndLeafArgv("factory-gate", { version: intent.version, loopRunId }),
            attestorChildEnv(ctx.env),
          );
          if (gate.code !== 0) {
            throw new Error(
              `ship FRG: candidate factory-gate failed (exit ${gate.code}): ${gate.stderr || gate.stdout}`,
            );
          }
          // Re-invoke the same request-bound prepare until it proves complete.
          // Do not return at the attestation checkpoint (#1151).
          continue;
        }
        if (verdict === "retry") {
          const loopRunId = prepareLoopRunId(parsed);
          const live = await boundPackLoopLiveForWait(ctx, loopRunId);
          const decision = classifyFrgPackWaitDecision({
            tick: "retry",
            live,
            attempt,
            cap: attempts,
          });
          if (decision === "fail") {
            throw new Error(
              `ship FRG: candidate factory-release prepare did not reach complete after ${attempts} ticks; ` +
                "retry the same ship command to resume the bound pack",
            );
          }
          if (typeof ctx.onFrgWaitTick === "function") {
            await ctx.onFrgWaitTick({ intent, attempt, loopRunId, live });
          }
          await delayMs(ctx, FRG_WAIT_MS);
          continue;
        }
        throw new Error(
          `ship FRG: candidate factory-release prepare failed (exit ${prep.code}): ${prep.stderr || prep.stdout}`,
        );
      }
    },
    async prepareRelease(intent, candidateHeadOid) {
      const engine = await requireCandidate(candidateHeadOid);
      if (!shouldSpawn(candidateHeadOid)) {
        return pinOps.prepareRelease(intent, candidateHeadOid);
      }
      const spawned = await spawnLeaf(
        ctx,
        engine,
        shipEndLeafArgv("release", { version: intent.version }),
        uncredentialedPrepareEnv(ctx.env),
      );
      if (spawned.code !== 0) {
        const existing = await pinOps.observeRelease(intent, candidateHeadOid);
        if (existing) return existing.prepare;
        throw new Error(
          `ship release: candidate release failed (exit ${spawned.code}): ${spawned.stderr || spawned.stdout}`,
        );
      }
      const observed = await pinOps.observeRelease(intent, candidateHeadOid);
      if (!observed) {
        throw new Error("ship release: candidate release returned no live identity");
      }
      return observed.prepare;
    },
    async finishRelease(intent, release) {
      const engine = await requireCandidate(release.candidate_head_oid);
      if (!shouldSpawn(release.candidate_head_oid)) {
        return pinOps.finishRelease(intent, release);
      }
      const spawned = await spawnLeaf(
        ctx,
        engine,
        shipEndLeafArgv("release-finish", { pr: release.pr }),
        uncredentialedPrepareEnv(ctx.env),
      );
      if (spawned.code !== 0) {
        throw new Error(
          `ship release: candidate release finish failed (exit ${spawned.code}): ${spawned.stderr || spawned.stdout}`,
        );
      }
      const observed = await pinOps.observeRelease(intent, release.candidate_head_oid);
      if (!observed?.finish) {
        throw new Error("ship release: candidate release finish returned no merge identity");
      }
      return observed.finish;
    },
    async waitForPublication(intent, release) {
      const engine = await requireCandidate(release.candidate_head_oid);
      if (!shouldSpawn(release.candidate_head_oid)) {
        return pinOps.waitForPublication(intent, release);
      }
      if (typeof ctx.spawnEnsureTag === "function") {
        await ctx.spawnEnsureTag(engine, {
          version: intent.version,
          mergeCommitOid: release.merge_commit_oid,
          packedCandidate: release.candidate_head_oid,
        });
      } else {
        const spawned = await spawnLeaf(
          ctx,
          engine,
          shipEndLeafArgv("ensure-tag", {
            version: intent.version,
            mergeCommitOid: release.merge_commit_oid,
            packedCandidate: release.candidate_head_oid,
          }),
          uncredentialedPrepareEnv(ctx.env),
        );
        if (spawned.code !== 0) {
          throw new Error(
            `ship release: candidate ensure-tag failed (exit ${spawned.code}): ${spawned.stderr || spawned.stdout}`,
          );
        }
      }
      for (let attempt = 0; attempt < RELEASE_WAIT_ATTEMPTS; attempt++) {
        const observed = await pinOps.observePublication(intent, release);
        if (observed) return observed;
        if (attempt + 1 < RELEASE_WAIT_ATTEMPTS) {
          await new Promise<void>((resolve) => setTimeout(resolve, RELEASE_WAIT_MS));
        }
      }
      throw new Error(
        `ship release: timed out waiting for published GitHub Release v${intent.version}; ` +
          "verify the release workflow, then retry the same ship command",
      );
    },
  };
}

function defaultResolveCandidateDeps(): ResolveCandidateEngineDeps {
  return {
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    fileExists: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    revParseHead: (cwd) => {
      try {
        const out = execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return parseExactGitSha(String(out).trim());
      } catch {
        return null;
      }
    },
    porcelain: (cwd) => {
      try {
        const out = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return String(out);
      } catch {
        return null;
      }
    },
    fetchSha: (dir, sha) => {
      try {
        execFileSync("git", ["-C", dir, "fetch", "--quiet", "origin", sha], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    worktreeAdd: (dir, dest, sha) => {
      try {
        execFileSync("git", ["-C", dir, "worktree", "add", "--detach", dest, sha], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function runningProcessPinSha(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const engineRoot = path.resolve(here, "../..");
  return parseExactGitSha(resolveEngineCommitSha(engineRoot));
}

/** Production factory used by the `pipeline ship` CLI. */
export function realShipCoordinatorDeps(opts: RealShipCoordinatorDepsOptions): ShipCoordinatorDeps {
  if (!opts.repo || opts.repo.toLowerCase() !== opts.repo.trim().toLowerCase() ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(opts.repo)) {
    throw new Error("pipeline ship: repository must be an explicit owner/name");
  }
  if (!opts.progress) throw new Error("pipeline ship: progress callback is required");
  const env = opts.env ?? process.env;
  const pinSha = opts.pinCommitSha !== undefined ? opts.pinCommitSha : runningProcessPinSha();
  const resolve =
    opts.resolveCandidateEngine ??
    (async (sha: string) =>
      resolveCandidateEngine(
        {
          repoDir: opts.repoDir,
          candidateSha: sha,
          candidateEngineRootEnv: env.PIPELINE_CANDIDATE_ENGINE_ROOT,
        },
        defaultResolveCandidateDeps(),
      ));
  const spawn =
    opts.spawnShipEnd ??
    (async (argv, spawnEnv) => {
      const [bin, ...args] = argv;
      try {
        const { stdout, stderr } = await execFileAsync(bin!, args, {
          cwd: opts.repoDir,
          env: spawnEnv,
          timeout: 600_000,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { code: 0, stdout: String(stdout), stderr: String(stderr) };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
        return {
          code: typeof e.status === "number" ? e.status : 1,
          stdout: String(e.stdout ?? ""),
          stderr: String(e.stderr ?? e.message ?? ""),
        };
      }
    });
  const pinOps = realShipAdapterOperations(opts);
  const state = opts.state ?? defaultShipStateStore(opts.env);
  const ops = bindCandidateShipEndOperations(pinOps, {
    pinCommitSha: pinSha,
    repoDir: opts.repoDir,
    env,
    nodeBin: process.execPath,
    factoryReleaseRequestPath: opts.factoryReleaseRequestPath,
    resolveFactoryReleaseRequestPath:
      opts.resolveFactoryReleaseRequestPath ??
      ((intent, train) => persistShipFactoryReleaseRequest(intent, train, { repoDir: opts.repoDir, env })),
    resolveCandidate: resolve,
    spawn,
    ...(opts.spawnEnsureTag ? { spawnEnsureTag: opts.spawnEnsureTag } : {}),
    async onFrgWaitTick(tick) {
      opts.progress(
        `ship FRG: wait heartbeat attempt=${tick.attempt} loop=${tick.loopRunId || "none"} live=${tick.live}`,
      );
      const key = shipKey(tick.intent);
      const current = await state.read(key);
      if (!current || current.next_action !== "frg_pack") return;
      const now = new Date().toISOString();
      await state.writeAtomic(key, {
        ...current,
        revision: current.revision + 1,
        updated_at: now,
        last_error: null,
      });
      const event: ShipPhaseEvent = {
        schema_version: 1,
        kind: "ship_phase",
        run_id: current.run_id,
        event_id: current.intent.event_id,
        at: now,
        phase: "frg_pack",
        status: "started",
        detail: `in_progress wait tick ${tick.attempt} loop=${tick.loopRunId || "none"} live=${tick.live}`,
      };
      await state.appendEvent(key, event);
    },
  });
  return shipCoordinatorDepsFromOperations(ops, { state });
}
