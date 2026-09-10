// Release-owned exact-candidate Final Regression Gate (#1558).
//
// This module composes the shared candidate resolve-and-prepare boundary with
// the ordinary `pipeline loop <issue> <issue>` surface. It deliberately owns
// no scheduler, merge path, recovery controller, score, or attestation.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CandidateEngine } from "./ship-end-candidate.ts";
import {
  resolveAndPrepareCandidateEngine,
  runCandidateEngineProcess,
  type CandidateEngineProcessResult,
  type ResolveAndPrepareCandidateEngineDeps,
  defaultResolveAndPrepareDeps,
  shipEndCliPrefix,
} from "./ship-end-candidate.ts";
import { PIPELINE_SUPPRESS_AUTO_FILE_ENV } from "./stages/papercut.ts";
import { resolveConfig } from "./config.ts";
import { createIssue, getGhActor, getIssueDetail, getPrCommits, getPrDetail, getPrDiff, listOpenPrsForIssue, listPrsForIssueAnyState } from "./gh.ts";
import { defaultLoopStoreDeps, readContract, readLedger, readLoopRunHandoff, runExists as loopRunExists } from "./loop/store.ts";
import { LOOP_RUN_HANDOFF_KIND, type LoopRunHandoff } from "./loop/handoff.ts";
import { isDurableLoopRunHandoff, PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV, PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV } from "./loop/pack-loop-liveness.ts";
import { computeDiffHash, diffFilePaths, extractReviewArtifact, isVerifiedPipelineReviewOutput, type ReviewArtifact } from "./stages/review-parsing.ts";
import { readTesterEvidence, validateTesterEvidence, type TesterEvidence } from "./tester-evidence.ts";
import { buildReviewPolicyHash, buildTesterPolicyHash, parseEvidenceSubjectDetailed, type EvidenceSubjectV1 } from "./evidence-subject.ts";
import {
  isIndependentlyEligible,
  mapModelFamily,
  mapProviderFamily,
  type ReviewerAttemptLineage,
} from "./reviewer-independence.ts";
import { listRunIds, primaryWorktreeFromPorcelain, runDirPath, RUN_SCHEMA_VERSION } from "./run-store.ts";
import { currentWorkflowEngineExhaustion } from "./loop/recovery.ts";
import { effectiveReviewPolicy } from "./review-policy.ts";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceBundle } from "./types.ts";
import { PipelineLock } from "./lock.ts";
import { isBlockedInLabels, pipelineStageFromLabels } from "./loop/precondition.ts";
import { ownerRepoFromPackageRepository } from "./production-engine-pin.ts";
import { workListRunId } from "./loop/work-list-run-id.ts";
import { resolveReviewedShaCurrency } from "./stages/pre-merge-sha-gate.ts";

interface RequiredCheck { name: string; bucket: string }
type ExactAdvanceSummary = EvidenceBundle & { run_id: string };

class CommandOutputError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, stdout: string, stderr: string, exitCode: number | null) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

class ExactCandidateFrgRegression extends Error {
  readonly evidence: ExactCandidateFrgFailureEvidence | null;
  constructor(message: string, evidence: ExactCandidateFrgFailureEvidence | null = null) {
    super(message);
    this.evidence = evidence;
  }
}
class ExactCandidateFrgDispatchError extends Error {
  readonly record: ExactCandidateFrgRecord;
  readonly gateDefect: boolean;
  constructor(message: string, record: ExactCandidateFrgRecord, gateDefect = false) {
    super(message);
    this.record = record;
    this.gateDefect = gateDefect;
  }
}

export function recoverExactCandidateFrgChecks(error: unknown): RequiredCheck[] | null {
  const stdout = error instanceof CommandOutputError ? error.stdout :
    typeof (error as { stdout?: unknown })?.stdout === "string" ? (error as { stdout: string }).stdout : null;
  if (stdout === null || stdout.trim() === "") return null;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) && parsed.every((row) => row && typeof row.name === "string" && typeof row.bucket === "string")
      ? parsed as RequiredCheck[] : null;
  } catch { return null; }
}

export function recoverExpectedExactCandidateLoopExit(error: unknown): string | null {
  const candidate = error as { stdout?: unknown; exitCode?: unknown };
  return [1, 2].includes(typeof candidate.exitCode === "number" ? candidate.exitCode : -1) &&
    typeof candidate.stdout === "string" && candidate.stdout.includes(`"kind":"${LOOP_RUN_HANDOFF_KIND}"`)
    ? candidate.stdout : null;
}

export const EXACT_CANDIDATE_FRG_SCHEMA = "pipeline/exact-candidate-frg@1" as const;
export const EXACT_CANDIDATE_FRG_SLOT_IDS = ["clean-docs", "clean-openspec"] as const;
export type ExactCandidateFrgSlotId = (typeof EXACT_CANDIDATE_FRG_SLOT_IDS)[number];
export const EXACT_CANDIDATE_FRG_NON_PASS = [
  "ordinary_review_revision",
  "external_or_transient_inconclusive",
  "exact_candidate_regression",
  "gate_defect",
] as const;
export type ExactCandidateFrgNonPass = (typeof EXACT_CANDIDATE_FRG_NON_PASS)[number];
export type ExactCandidateFrgOutcome = "pending" | "passed" | "stale_candidate" | ExactCandidateFrgNonPass;
export type SideEffectCertainty = "known_absent" | "known_complete" | "uncertain";

export class ExactCandidateFrgGateDefect extends Error {
  readonly evidence: ExactCandidateFrgGateEvidence | null;
  constructor(message: string, evidence: ExactCandidateFrgGateEvidence | null = null) {
    super(message);
    this.evidence = evidence;
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PACK_ROOT_REL = path.join("core", "scripts", "frg-packs", "factory-gate-v1");
const MANIFEST_REL = path.join(PACK_ROOT_REL, "manifest.json");
const LOCKFILE_REL = path.join("core", "package-lock.json");

export interface ExactCandidateInputIdentity {
  relative_path: string;
  sha256: string;
}

export interface ExactCandidateFrgObservation {
  observed_at: string;
  issue: {
    source: "forge";
    labels: string[];
    provenance_epoch: string;
    provenance_candidate_sha: string;
    provenance_template_id: ExactCandidateFrgSlotId;
    provenance_template_sha256: string;
  };
  pr: {
    source: "forge";
    number: number;
    head_sha: string;
    state: "open" | "closed";
    merged: boolean;
  };
  ordinary: {
    source: "run_store";
    advance_run_id: string;
    loop_item_state: string;
    final_state: string;
    regression_proof: null | {
      source: "run_store";
      advance_run_id: string;
      candidate_sha: string;
      fixture_pr_head_sha: string;
      classification: "demonstrated_candidate_regression";
    };
  };
  ci: { source: "ci"; head_sha: string; required: boolean; check_count: number; conclusion: "success" | "failure" | "pending" };
  review: {
    source: "review";
    head_sha: string;
    reviewed_head_sha: string;
    independent: boolean;
    advance_run_id: string;
    evidence_run_id: string;
    evidence_subject_valid: boolean;
    verdict: "accepted" | "changes_requested" | "unavailable";
  };
  tester: {
    source: "tester";
    head_sha: string;
    advance_run_id: string;
    evidence_run_id: string;
    config_digest: string;
    evidence_subject_valid: boolean;
    conclusion: "passed" | "failed" | "unavailable";
  };
  unavailable_sources: string[];
  changed_paths: string[];
  ingress_claims?: string[];
}

export interface ExactCandidateFrgSlot {
  id: ExactCandidateFrgSlotId;
  epoch_id: string;
  candidate_sha: string;
  template: ExactCandidateInputIdentity;
  title_template: string;
  provenance_id: string;
  issue_number: number | null;
  create_certainty: SideEffectCertainty;
  advance_run_id: string | null;
  pr_number: number | null;
  pr_head_sha: string | null;
  observation: ExactCandidateFrgObservation | null;
  failure_evidence?: ExactCandidateFrgFailureEvidence | null;
  synthetic_fixture?: ExactCandidateSyntheticFixtureProvenance | null;
}

export interface ExactCandidateFrgFailureEvidence {
  source: "run_store";
  classification: "demonstrated_candidate_regression";
  issue_number: number;
  advance_run_id: string;
  candidate_sha: string;
  stage: string | null;
  pr_number: null;
  pr_head_sha: null;
}

export interface ExactCandidateFrgCleanupFact {
  target: string;
  status: "cleaned" | "debt";
  detail: string;
  observed_at: string;
}

export interface ExactCandidateFailedSyntheticClassification {
  classified_at: string;
  classification: "known_failed_synthetic";
}

export interface ExactCandidateSyntheticFixtureProvenance {
  persisted_at: string;
  source: "synthetic_fixture_create";
  branch_name: string;
  worktree_path: string;
  worktree_identity: string;
}

const FAILED_SYNTHETIC_CLEANUP_OUTCOMES = ["gate_defect", "exact_candidate_regression", "stale_candidate"] as const;

function isFailedSyntheticCleanupOutcome(outcome: ExactCandidateFrgOutcome): outcome is (typeof FAILED_SYNTHETIC_CLEANUP_OUTCOMES)[number] {
  return (FAILED_SYNTHETIC_CLEANUP_OUTCOMES as readonly ExactCandidateFrgOutcome[]).includes(outcome);
}

export interface ExactCandidateFrgGateEvidence {
  source: "controller" | "forge" | "run_store" | "review" | "tester";
  slot_id: ExactCandidateFrgSlotId | null;
  issue_number: number | null;
  pr_number: number | null;
  candidate_sha: string;
  observed_head_sha: string | null;
  fact: string;
}

export interface ExactCandidateFrgRecord {
  schema: typeof EXACT_CANDIDATE_FRG_SCHEMA;
  epoch_id: string;
  repository: string;
  operational_domain: string;
  base_branch: string;
  release_version: string;
  loop_engine: "claude" | "codex";
  candidate: {
    sha: string;
    engine_root: string;
    launcher_path: string;
    manifest: ExactCandidateInputIdentity;
    lockfile: ExactCandidateInputIdentity;
  };
  loop_run_id: string | null;
  loop_dispatch_certainty: SideEffectCertainty;
  slots: [ExactCandidateFrgSlot, ExactCandidateFrgSlot];
  worker_config: {
    implementer: string;
    reviewer: string;
    gates_sha256: string;
    review_standard_sha256: string;
    review_low_risk_round2_sha256: string;
    auto_file_repairs: false;
  };
  outcome: ExactCandidateFrgOutcome;
  outcome_detail: string;
  external_wait: { probe: string; wake_condition: string } | null;
  cleanup: ExactCandidateFrgCleanupFact[];
  cleanup_debt: boolean;
  failed_synthetic?: ExactCandidateFailedSyntheticClassification | null;
  reconciliation_evidence?: RemoteFixtureMatch[];
  gate_evidence?: ExactCandidateFrgGateEvidence[];
  created_at: string;
  updated_at: string;
}

export interface RemoteFixtureMatch {
  issue_number: number;
  epoch_id: string;
  candidate_sha: string;
  slot_id: string;
  provenance_id: string;
}

export interface ExactCandidateFrgDeps {
  now(): Date;
  newProvenanceId?(): string;
  observeOriginMainSha(repoDir: string): Promise<string | null>;
  resolveAndPrepareDeps: ResolveAndPrepareCandidateEngineDeps;
  resolveAndPrepareCandidate?: (
    input: BeginExactCandidateFrgInput,
    candidateSha: string,
  ) => ReturnType<typeof resolveAndPrepareCandidateEngine>;
  runCandidateProcess?: <T>(
    engine: CandidateEngine,
    start: Parameters<typeof runCandidateEngineProcess<T>>[0]["start"],
  ) => Promise<CandidateEngineProcessResult<T>>;
  readCandidateFile(absolutePath: string): Promise<string | Buffer>;
  resolveCandidatePolicy?(engineRoot: string): Promise<{
    repository: string; baseBranch: string; implementer: string; reviewer: string; gatesSha256: string;
    reviewPolicyHashes: { standard: string; lowRiskRound2: string };
  }>;
  persist(record: ExactCandidateFrgRecord): Promise<void>;
  listFixtureMatches(record: ExactCandidateFrgRecord): Promise<RemoteFixtureMatch[]>;
  createFixture(input: {
    record: ExactCandidateFrgRecord;
    slot: ExactCandidateFrgSlot;
    title: string;
    body: string;
  }): Promise<number>;
  dispatchOrdinaryLoop(input: {
    engine: CandidateEngine;
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    onHandoff(handoff: LoopRunHandoff): Promise<void>;
  }): Promise<{ stdout: string; contract: unknown; ledger: unknown; handoff: unknown }>;
  observeFixture(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): Promise<ExactCandidateFrgObservation>;
  reobserveFixtureIdentity(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot, options?: { requireReady: boolean }): Promise<{
    issue_number: number; issue_open: boolean; pr_number: number; pr_head_sha: string; pr_open: boolean; merged: boolean;
  }>;
  validateOrdinaryLoop?(record: ExactCandidateFrgRecord): Promise<[string | null, string | null] | void>;
  discoverOrdinaryLoop?(record: ExactCandidateFrgRecord): Promise<{ runId: string; children: [string | null, string | null] } | null>;
  ordinaryLoopNeedsResume?(record: ExactCandidateFrgRecord): Promise<boolean>;
  cleanup?(record: ExactCandidateFrgRecord): Promise<ExactCandidateFrgCleanupFact[]>;
}

export interface BeginExactCandidateFrgInput {
  repoDir: string;
  repository: string;
  baseBranch: string;
  releaseVersion: string;
  loopEngine?: "claude" | "codex";
  /** Release-owned retry generation after an observed C movement and return. */
  epochId?: string;
  operationalDomain?: string;
  candidateEngineRootEnv?: string | null;
  /** Internal outer-observation pin; prevents C movement during admission. */
  expectedCandidateSha?: string;
}

export interface ProductionExactCandidateFrgIo {
  now(): Date;
  observeOriginMainSha(repoDir: string): Promise<string | null>;
  resolveReleaseStoreRepoDir(repoDir: string): Promise<string>;
  validateTargetRuntime(input: BeginExactCandidateFrgInput): Promise<{ domain: string; repository: string }>;
  resolveCandidatePolicy(engineRoot: string): Promise<{
    repository: string; baseBranch: string; domain: string; implementer: string; reviewer: string;
    gatesSha256: string; reviewPolicyHashes: { standard: string; lowRiskRound2: string };
  }>;
  resolveAndPrepareCandidate?(
    input: BeginExactCandidateFrgInput,
    candidateSha: string,
  ): ReturnType<typeof resolveAndPrepareCandidateEngine>;
  readFile(file: string): Promise<string | null>;
  listRecordEpochIds(repoDir: string): Promise<string[]>;
  writeRecord(repoDir: string, record: ExactCandidateFrgRecord): Promise<void>;
  listIssues(repository: string): Promise<Array<{ number: number; body: string; state: "open" | "closed" }>>;
  createIssue(repository: string, title: string, body: string, labels: string[]): Promise<number>;
  runCandidateLoop(
    engine: CandidateEngine,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    onHandoff: (handoff: LoopRunHandoff) => Promise<void>,
  ): Promise<string>;
  readLoopDocuments(loopRunId: string): Promise<{ contract: unknown; ledger: unknown; handoff: unknown }>;
  loopRunExists?(loopRunId: string): Promise<boolean>;
  getIssue(input: BeginExactCandidateFrgInput, issueNumber: number): Promise<{ body: string; labels: string[]; state: "open" | "closed"; comments?: Array<{ author: string; body: string }> }>;
  listPrsAnyState(input: BeginExactCandidateFrgInput, issueNumber: number): Promise<{ numbers: number[]; truncated: boolean }>;
  listOpenPrs(input: BeginExactCandidateFrgInput, issueNumber: number): Promise<number[]>;
  getPr(input: BeginExactCandidateFrgInput, prNumber: number): Promise<{ number: number; head_sha: string; base_ref: string; state: string; merged: boolean }>;
  deleteBranch?(name: string, expectedSha: string): Promise<void>;
  observeBranch?(name: string): Promise<{ name: string; sha: string } | null>;
  observeWorktree?(worktreePath: string): Promise<{ path: string; owned: boolean; identity?: string } | null>;
  deleteOwnedWorktree?(worktreePath: string, expectedIdentity: string): Promise<void>;
  getRequiredChecks(input: BeginExactCandidateFrgInput, prNumber: number): Promise<RequiredCheck[]>;
  getPrDiff(input: BeginExactCandidateFrgInput, prNumber: number): Promise<string>;
  readAdvanceSummary(input: BeginExactCandidateFrgInput, advanceRunId: string): Promise<ExactAdvanceSummary | null>;
  readAdvanceTester(input: BeginExactCandidateFrgInput, advanceRunId: string): ReturnType<typeof readTesterEvidence>;
  readCurrentReviewEvidence(
    input: BeginExactCandidateFrgInput, issueNumber: number, prNumber: number, headSha: string, diffHash: string,
  ): Promise<{ advanceRunId: string; summary: ExactAdvanceSummary; reviewedHeadSha: string; reviewedDiffHash: string } | null>;
}

export interface CandidateOrdinaryLoopExecution {
  engine: CandidateEngine;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  targetPrimaryRepoDir: string;
  onHandoff(handoff: LoopRunHandoff): Promise<void>;
}

/**
 * The single transport boundary for an exact-C ordinary loop. Candidate C owns
 * executable/config behavior; this candidate-only binding gives its nested
 * advance runs one already-validated canonical target-primary artifact owner.
 */
export async function executeCandidateOrdinaryLoop(
  execution: CandidateOrdinaryLoopExecution,
  transport: ProductionExactCandidateFrgIo["runCandidateLoop"],
): Promise<string> {
  const target = execution.targetPrimaryRepoDir;
  if (!path.isAbsolute(target) || path.normalize(target) !== target) {
    throw new ExactCandidateFrgGateDefect("candidate ordinary loop target primary must be a normalized absolute path");
  }
  return transport(
    execution.engine,
    [...execution.argv, "--candidate-target-primary", target],
    execution.env,
    execution.onHandoff,
  );
}

export interface ExactCandidateFrgRecordStoreDeps {
  mkdir(directory: string): Promise<void>;
  writeFile(file: string, body: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncFile(file: string): Promise<void>;
  syncDir(directory: string): Promise<void>;
}

export interface ExactCandidateFrgRecordLoadDeps {
  readFile(file: string): Promise<string | null>;
}

export function exactCandidateFrgResultPath(repoDir: string, epochId: string): string {
  safeId(epochId, "epoch_id");
  return path.join(repoDir, ".agent-pipeline", "frg", "exact-pair", `${epochId}.json`);
}

/** Atomic release-owned persistence. The destination is outside fixture worktrees. */
export async function persistExactCandidateFrgRecord(
  repoDir: string,
  record: ExactCandidateFrgRecord,
  deps: ExactCandidateFrgRecordStoreDeps,
): Promise<void> {
  parseExactCandidateFrgRecord(record);
  const destination = exactCandidateFrgResultPath(repoDir, record.epoch_id);
  const temporary = `${destination}.tmp-${process.pid}`;
  await deps.mkdir(path.dirname(destination));
  await deps.writeFile(temporary, `${JSON.stringify(record)}\n`);
  await deps.syncFile(temporary);
  await deps.rename(temporary, destination);
  await deps.syncDir(path.dirname(destination));
}

export async function loadExactCandidateFrgRecord(
  repoDir: string,
  epochId: string,
  deps: ExactCandidateFrgRecordLoadDeps,
): Promise<ExactCandidateFrgRecord | null> {
  const raw = await deps.readFile(exactCandidateFrgResultPath(repoDir, epochId));
  if (raw === null) return null;
  return parseExactCandidateFrgRecord(JSON.parse(raw));
}

function productionResolveCandidate(
  input: BeginExactCandidateFrgInput,
  candidateSha: string,
  deps: ResolveAndPrepareCandidateEngineDeps,
) {
  return resolveAndPrepareCandidateEngine({
    repoDir: input.repoDir,
    candidateSha,
    candidateEngineRootEnv: input.candidateEngineRootEnv,
    consumer: "factory-gate.exact-pair",
  }, deps);
}

function productionRunCandidate<T>(
  engine: CandidateEngine,
  start: Parameters<typeof runCandidateEngineProcess<T>>[0]["start"],
) {
  return runCandidateEngineProcess({
    consumer: "factory-gate.exact-pair",
    engine,
    start,
  });
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date): string {
  const result = value.toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error("FRG clock returned an invalid timestamp");
  return result;
}

function canonicalIso(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a canonical ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function nonEmptyStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${field} must be a string array with nonempty elements`);
  }
  return value;
}

function exactSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error(`${field} must be an exact lowercase 40-hex SHA`);
  return value;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value) || value.includes("..")) {
    throw new Error(`${field} must be a safe non-empty identifier`);
  }
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function relativeCandidatePath(value: unknown, field: string): string {
  const result = nonEmpty(value, field);
  if (path.isAbsolute(result) || result.split(/[\\/]/).includes("..")) throw new Error(`${field} must stay within the candidate root`);
  return result;
}

function positiveIssue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive issue number`);
  }
  return value;
}

function contained(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function exactCandidateFrgOpenSpecChangeId(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): string {
  return `${record.epoch_id}-${slot.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function renderFixtureTemplate(template: string, record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): string {
  const openspecChangeId = exactCandidateFrgOpenSpecChangeId(record, slot);
  return template
    .replaceAll("{{release_version}}", record.release_version)
    .replaceAll("{{pack_run_id}}", record.epoch_id)
    .replaceAll("{{pack_id}}", "factory-gate-v1")
    .replaceAll("{{manifest_version}}", "1")
    .replaceAll("{{manifest_sha256}}", record.candidate.manifest.sha256)
    .replaceAll("{{template_id}}", slot.id)
    .replaceAll("{{template_sha256}}", slot.template.sha256)
    .replaceAll("{{openspec_change_id}}", openspecChangeId);
}

function templateBody(template: string, record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): string {
  const changeId = exactCandidateFrgOpenSpecChangeId(record, slot);
  return renderFixtureTemplate(template, record, slot) +
    `\nExact-pair archive allowance: \`openspec/specs/${changeId}/spec.md\` is the only living-spec destination owned by this fixture.\n` +
    `\n<!-- pipeline-exact-frg:v1 epoch=${record.epoch_id} candidate=${record.candidate.sha} slot=${slot.id} provenance=${slot.provenance_id} -->\n`;
}

export function renderExactCandidateFrgFixtureBody(template: string, record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): string {
  return templateBody(template, record, slot);
}

const EXACT_PROVENANCE_RE = /<!-- pipeline-exact-frg:v1 epoch=([^\s]+) candidate=([0-9a-f]{40}) slot=([^\s]+) provenance=([^\s]+) -->/g;

export function parseExactCandidateFrgProvenance(body: string): Omit<RemoteFixtureMatch, "issue_number">[] {
  return [...body.matchAll(EXACT_PROVENANCE_RE)].map((match) => ({
    epoch_id: match[1]!, candidate_sha: match[2]!, slot_id: match[3]!, provenance_id: match[4]!,
  }));
}

export function parseCandidateRenderedFrgProvenance(body: string): Record<string, string> | null {
  const block = body.match(/<!-- pipeline-frg-instance@1\n([\s\S]*?)\n-->/);
  if (!block) return null;
  const entries = block[1]!.split("\n").map((line) => line.split("=", 2));
  if (entries.some((entry) => entry.length !== 2)) return null;
  return Object.fromEntries(entries as [string, string][]);
}

export function exactCandidateFrgPathsAreHarmless(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot, paths: readonly string[]): boolean {
  if (paths.length === 0 || new Set(paths).size !== paths.length) return false;
  const prefix = `core/test/fixtures/frg/${record.epoch_id}/`;
  const test = `core/test/frg-${record.epoch_id}-${slot.id}.test.ts`;
  const changeId = exactCandidateFrgOpenSpecChangeId(record, slot);
  const livingSpec = `openspec/specs/${changeId}/spec.md`;
  const archivedChange = (file: string) => {
    const parts = file.split("/");
    return parts[0] === "openspec" && parts[1] === "changes" && parts[2] === "archive" &&
      new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${changeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(parts[3] ?? "") &&
      parts.length > 4;
  };
  const fixture = `${prefix}${slot.id}.json`;
  const allowed = paths.every((file) => file === fixture || file === test || file === livingSpec || archivedChange(file));
  const hasOwnOpenSpec = paths.some(archivedChange);
  const baseFilesPresent = allowed && paths.includes(fixture) && paths.includes(test);
  if (slot.id === "clean-openspec") return baseFilesPresent && paths.includes(livingSpec) && hasOwnOpenSpec;
  const hasAnyOpenSpec = paths.some((file) => file === livingSpec || archivedChange(file));
  return baseFilesPresent && (!hasAnyOpenSpec || (paths.includes(livingSpec) && hasOwnOpenSpec));
}

function cloneRecord(record: ExactCandidateFrgRecord): ExactCandidateFrgRecord {
  return structuredClone(record);
}

function parseSlot(value: unknown, expected: ExactCandidateFrgSlotId, epoch: string, candidate: string): ExactCandidateFrgSlot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`slot ${expected} must be an object`);
  const slot = value as ExactCandidateFrgSlot;
  if (slot.id !== expected) throw new Error(`FRG slots must be ordered exactly as ${EXACT_CANDIDATE_FRG_SLOT_IDS.join(", ")}`);
  if (slot.epoch_id !== epoch || slot.candidate_sha !== candidate) throw new Error(`slot ${expected} crosses candidate epoch`);
  safeId(slot.provenance_id, `slot ${expected}.provenance_id`);
  if (!slot.template || !DIGEST_RE.test(slot.template.sha256)) {
    throw new Error(`slot ${expected}.template is malformed`);
  }
  relativeCandidatePath(slot.template.relative_path, `slot ${expected}.template.relative_path`);
  nonEmpty(slot.title_template, `slot ${expected}.title_template`);
  if (slot.issue_number !== null) positiveIssue(slot.issue_number, `slot ${expected}.issue_number`);
  if (!["known_absent", "known_complete", "uncertain"].includes(slot.create_certainty)) {
    throw new Error(`slot ${expected}.create_certainty is malformed`);
  }
  if (slot.advance_run_id !== null) safeId(slot.advance_run_id, `slot ${expected}.advance_run_id`);
  if (slot.pr_number !== null) positiveIssue(slot.pr_number, `slot ${expected}.pr_number`);
  if (slot.pr_head_sha !== null) exactSha(slot.pr_head_sha, `slot ${expected}.pr_head_sha`);
  if (slot.observation !== null) {
    const observation = slot.observation;
    canonicalIso(observation.observed_at, `slot ${expected}.observation.observed_at`);
    if (observation.issue?.source !== "forge" ||
        typeof observation.issue.provenance_epoch !== "string" ||
        !EXACT_CANDIDATE_FRG_SLOT_IDS.includes(observation.issue.provenance_template_id) ||
        !DIGEST_RE.test(observation.issue.provenance_template_sha256)) {
      throw new Error(`slot ${expected}.observation issue provenance is malformed`);
    }
    nonEmptyStringArray(observation.issue.labels, `slot ${expected}.observation.issue.labels`);
    exactSha(observation.issue.provenance_candidate_sha, `slot ${expected}.observation.issue.provenance_candidate_sha`);
    if (observation.pr?.source !== "forge" || !["open", "closed"].includes(observation.pr.state) ||
        typeof observation.pr.merged !== "boolean") throw new Error(`slot ${expected}.observation PR is malformed`);
    positiveIssue(observation.pr.number, `slot ${expected}.observation.pr.number`);
    exactSha(observation.pr.head_sha, `slot ${expected}.observation.pr.head_sha`);
    if (observation.ordinary?.source !== "run_store") throw new Error(`slot ${expected}.observation ordinary run is malformed`);
    safeId(observation.ordinary.advance_run_id, `slot ${expected}.observation.ordinary.advance_run_id`);
    nonEmpty(observation.ordinary.loop_item_state, `slot ${expected}.observation.ordinary.loop_item_state`);
    nonEmpty(observation.ordinary.final_state, `slot ${expected}.observation.ordinary.final_state`);
    if (observation.ordinary.regression_proof !== null) {
      const proof = observation.ordinary.regression_proof;
      if (proof?.source !== "run_store" || proof.classification !== "demonstrated_candidate_regression") {
        throw new Error(`slot ${expected}.observation regression proof is malformed`);
      }
      safeId(proof.advance_run_id, `slot ${expected}.observation regression proof advance_run_id`);
      exactSha(proof.candidate_sha, `slot ${expected}.observation regression proof candidate_sha`);
      exactSha(proof.fixture_pr_head_sha, `slot ${expected}.observation regression proof fixture_pr_head_sha`);
      if (proof.advance_run_id !== slot.advance_run_id || proof.candidate_sha !== candidate ||
          proof.fixture_pr_head_sha !== observation.pr.head_sha) {
        throw new Error(`slot ${expected}.observation regression proof crosses the recorded candidate/run/head`);
      }
    }
    for (const [name, evidence] of [["ci", observation.ci], ["review", observation.review], ["tester", observation.tester]] as const) {
      if (!evidence || typeof evidence !== "object") throw new Error(`slot ${expected}.observation.${name} is malformed`);
      exactSha(evidence.head_sha, `slot ${expected}.observation.${name}.head_sha`);
    }
    if (observation.ci.source !== "ci" || observation.ci.required !== true || !Number.isSafeInteger(observation.ci.check_count) || observation.ci.check_count < 0 ||
        !["success", "failure", "pending"].includes(observation.ci.conclusion) ||
        observation.review.source !== "review" || typeof observation.review.independent !== "boolean" || typeof observation.review.evidence_subject_valid !== "boolean" ||
        !["accepted", "changes_requested", "unavailable"].includes(observation.review.verdict) ||
        observation.tester.source !== "tester" || !DIGEST_RE.test(observation.tester.config_digest) || typeof observation.tester.evidence_subject_valid !== "boolean" ||
        !["passed", "failed", "unavailable"].includes(observation.tester.conclusion)) throw new Error(`slot ${expected}.observation evidence is malformed`);
    nonEmptyStringArray(observation.unavailable_sources, `slot ${expected}.observation.unavailable_sources`);
    nonEmptyStringArray(observation.changed_paths, `slot ${expected}.observation.changed_paths`);
    if (observation.ingress_claims !== undefined) {
      nonEmptyStringArray(observation.ingress_claims, `slot ${expected}.observation.ingress_claims`);
    }
    safeId(observation.review.advance_run_id, `slot ${expected}.observation.review.advance_run_id`);
    exactSha(observation.review.reviewed_head_sha, `slot ${expected}.observation.review.reviewed_head_sha`);
    nonEmpty(observation.review.evidence_run_id, `slot ${expected}.observation.review.evidence_run_id`);
    safeId(observation.tester.advance_run_id, `slot ${expected}.observation.tester.advance_run_id`);
    safeId(observation.tester.evidence_run_id, `slot ${expected}.observation.tester.evidence_run_id`);
    if (slot.pr_number !== observation.pr.number || slot.pr_head_sha !== observation.pr.head_sha) {
      throw new Error(`slot ${expected}.observation does not match its recorded PR identity`);
    }
  }
  if (slot.failure_evidence !== undefined && slot.failure_evidence !== null) {
    const evidence = slot.failure_evidence;
    if (evidence.source !== "run_store" || evidence.classification !== "demonstrated_candidate_regression" ||
        evidence.issue_number !== slot.issue_number || evidence.advance_run_id !== slot.advance_run_id ||
        evidence.candidate_sha !== candidate || (evidence.stage !== null && (typeof evidence.stage !== "string" || evidence.stage.trim() === "")) ||
        evidence.pr_number !== null || evidence.pr_head_sha !== null) {
      throw new Error(`slot ${expected}.failure_evidence is malformed or crosses the recorded candidate/run`);
    }
  }
  if (slot.synthetic_fixture !== undefined && slot.synthetic_fixture !== null) {
    canonicalIso(slot.synthetic_fixture.persisted_at, `slot ${expected}.synthetic_fixture.persisted_at`);
    if (slot.synthetic_fixture.source !== "synthetic_fixture_create") {
      throw new Error(`slot ${expected}.synthetic_fixture.source is malformed`);
    }
    nonEmpty(slot.synthetic_fixture.branch_name, `slot ${expected}.synthetic_fixture.branch_name`);
    nonEmpty(slot.synthetic_fixture.worktree_path, `slot ${expected}.synthetic_fixture.worktree_path`);
    nonEmpty(slot.synthetic_fixture.worktree_identity, `slot ${expected}.synthetic_fixture.worktree_identity`);
    if (slot.issue_number === null) throw new Error(`slot ${expected}.synthetic_fixture requires a recorded issue identity`);
  }
  return slot;
}

export function parseExactCandidateFrgRecord(value: unknown): ExactCandidateFrgRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("exact-candidate FRG result must be an object");
  const record = value as ExactCandidateFrgRecord;
  if (record.schema !== EXACT_CANDIDATE_FRG_SCHEMA) throw new Error(`exact-candidate FRG schema must be ${EXACT_CANDIDATE_FRG_SCHEMA}`);
  safeId(record.epoch_id, "epoch_id");
  nonEmpty(record.repository, "repository");
  nonEmpty(record.operational_domain, "operational_domain");
  nonEmpty(record.base_branch, "base_branch");
  nonEmpty(record.release_version, "release_version");
  if (record.loop_engine !== "claude" && record.loop_engine !== "codex") throw new Error("loop_engine must be claude or codex");
  exactSha(record.candidate?.sha, "candidate.sha");
  if (!path.isAbsolute(record.candidate?.engine_root ?? "") || !path.isAbsolute(record.candidate?.launcher_path ?? "")) {
    throw new Error("candidate root and launcher must be absolute");
  }
  if (!contained(record.candidate.engine_root, record.candidate.launcher_path)) throw new Error("candidate launcher is outside engine root");
  for (const [name, ref] of [["manifest", record.candidate.manifest], ["lockfile", record.candidate.lockfile]] as const) {
    if (!ref || !DIGEST_RE.test(ref.sha256)) throw new Error(`candidate.${name} is malformed`);
    relativeCandidatePath(ref.relative_path, `candidate.${name}.relative_path`);
  }
  if (record.candidate.manifest.relative_path !== MANIFEST_REL || record.candidate.lockfile.relative_path !== LOCKFILE_REL) {
    throw new Error("candidate manifest or lockfile identity is not the exact candidate-owned input");
  }
  if (!Array.isArray(record.slots) || record.slots.length !== 2) throw new Error("exact-candidate FRG result must contain exactly two slots");
  parseSlot(record.slots[0], "clean-docs", record.epoch_id, record.candidate.sha);
  parseSlot(record.slots[1], "clean-openspec", record.epoch_id, record.candidate.sha);
  if (record.slots[0].template.relative_path === record.slots[1].template.relative_path) {
    throw new Error("exact-candidate FRG slots must reference distinct candidate template files");
  }
  if (record.loop_run_id !== null) safeId(record.loop_run_id, "loop_run_id");
  if (!["known_absent", "known_complete", "uncertain"].includes(record.loop_dispatch_certainty)) {
    throw new Error("loop_dispatch_certainty is malformed");
  }
  const advanceIds = record.slots.flatMap((slot) => slot.advance_run_id === null ? [] : [slot.advance_run_id]);
  if ((record.loop_run_id === null && advanceIds.length !== 0) ||
      new Set(advanceIds).size !== advanceIds.length) {
    throw new Error("child advance identities require one loop and distinct observed children");
  }
  const filledIssues = record.slots.flatMap((slot) => slot.issue_number === null ? [] : [slot.issue_number]);
  if (new Set(filledIssues).size !== filledIssues.length || record.slots[0].provenance_id === record.slots[1].provenance_id) {
    throw new Error("FRG slot identities must be distinct");
  }
  if (!record.worker_config || typeof record.worker_config.implementer !== "string" || record.worker_config.implementer.trim() === "" ||
      typeof record.worker_config.reviewer !== "string" || record.worker_config.reviewer.trim() === "" ||
      !DIGEST_RE.test(record.worker_config.gates_sha256) || !DIGEST_RE.test(record.worker_config.review_standard_sha256) ||
      !DIGEST_RE.test(record.worker_config.review_low_risk_round2_sha256) || record.worker_config.auto_file_repairs !== false) {
    throw new Error("worker_config is malformed or repair auto-filing is enabled");
  }
  if (!["pending", "passed", "stale_candidate", ...EXACT_CANDIDATE_FRG_NON_PASS].includes(record.outcome)) {
    throw new Error("FRG outcome is malformed");
  }
  const hasPrePrRegression = record.slots.some((slot) => slot.failure_evidence !== undefined && slot.failure_evidence !== null);
  const hasPostPrRegression = record.slots.some((slot) => slot.observation?.ordinary.regression_proof !== null &&
    slot.observation?.ordinary.regression_proof !== undefined);
  const hasRegressionEvidence = hasPrePrRegression || hasPostPrRegression;
  if (record.outcome === "exact_candidate_regression" && !hasRegressionEvidence) {
    throw new Error("exact-candidate regression outcome requires concrete retained regression evidence");
  }
  if (["passed", "pending", "ordinary_review_revision"].includes(record.outcome) && hasRegressionEvidence) {
    throw new Error(`${record.outcome} cannot retain contradictory candidate regression evidence`);
  }
  if (record.external_wait !== null &&
      (!record.external_wait || !nonEmpty(record.external_wait.probe, "external_wait.probe") ||
       !nonEmpty(record.external_wait.wake_condition, "external_wait.wake_condition"))) {
    throw new Error("external wait is malformed");
  }
  if ((record.outcome === "external_or_transient_inconclusive") !== (record.external_wait !== null)) {
    throw new Error("external wait must exist only for an inconclusive outcome");
  }
  if (!Array.isArray(record.cleanup) || typeof record.cleanup_debt !== "boolean") throw new Error("cleanup facts are malformed");
  for (const [index, fact] of record.cleanup.entries()) {
    nonEmpty(fact?.target, `cleanup[${index}].target`);
    nonEmpty(fact?.detail, `cleanup[${index}].detail`);
    if (!fact || !["cleaned", "debt"].includes(fact.status)) throw new Error(`cleanup[${index}] is malformed`);
    canonicalIso(fact.observed_at, `cleanup[${index}].observed_at`);
  }
  if (record.cleanup_debt !== record.cleanup.some((fact) => fact.status === "debt")) throw new Error("cleanup debt does not match cleanup facts");
  if (record.failed_synthetic !== undefined && record.failed_synthetic !== null) {
    canonicalIso(record.failed_synthetic.classified_at, "failed_synthetic.classified_at");
    if (record.failed_synthetic.classification !== "known_failed_synthetic") {
      throw new Error("failed_synthetic.classification is malformed");
    }
    if (!isFailedSyntheticCleanupOutcome(record.outcome)) {
      throw new Error("failed synthetic classification cannot apply to this outcome");
    }
    if (!hasPersistedSyntheticFixtureProvenance(record)) {
      throw new Error("failed synthetic classification requires persisted synthetic-fixture provenance");
    }
  }
  if (record.reconciliation_evidence !== undefined) {
    if (!Array.isArray(record.reconciliation_evidence)) throw new Error("reconciliation evidence is malformed");
    for (const evidence of record.reconciliation_evidence) {
      positiveIssue(evidence?.issue_number, "reconciliation issue_number");
      nonEmpty(evidence?.epoch_id, "reconciliation epoch_id");
      exactSha(evidence?.candidate_sha, "reconciliation candidate_sha");
      nonEmpty(evidence?.slot_id, "reconciliation slot_id");
      safeId(evidence?.provenance_id, "reconciliation provenance_id");
    }
  }
  if (record.gate_evidence !== undefined) {
    if (!Array.isArray(record.gate_evidence)) throw new Error("gate evidence is malformed");
    for (const evidence of record.gate_evidence) {
      if (!evidence || !["controller", "forge", "run_store", "review", "tester"].includes(evidence.source) ||
          !(evidence.slot_id === null || EXACT_CANDIDATE_FRG_SLOT_IDS.includes(evidence.slot_id)) ||
          !(evidence.issue_number === null || Number.isSafeInteger(evidence.issue_number) && evidence.issue_number > 0) ||
          !(evidence.pr_number === null || Number.isSafeInteger(evidence.pr_number) && evidence.pr_number > 0)) {
        throw new Error("gate evidence identity is malformed");
      }
      exactSha(evidence.candidate_sha, "gate evidence candidate_sha");
      if (evidence.candidate_sha !== record.candidate.sha) throw new Error("gate evidence crosses the recorded candidate");
      if (evidence.observed_head_sha !== null) exactSha(evidence.observed_head_sha, "gate evidence observed_head_sha");
      nonEmpty(evidence.fact, "gate evidence fact");
    }
  }
  if (record.outcome === "gate_defect" && (!record.gate_evidence || record.gate_evidence.length === 0)) {
    throw new Error("gate defect must retain normalized evidence");
  }
  nonEmpty(record.outcome_detail, "outcome_detail");
  canonicalIso(record.created_at, "created_at");
  canonicalIso(record.updated_at, "updated_at");
  return record;
}

export async function beginExactCandidateFrg(
  input: BeginExactCandidateFrgInput,
  deps: ExactCandidateFrgDeps,
): Promise<{ record: ExactCandidateFrgRecord; engine: CandidateEngine }> {
  const observed = exactSha(await deps.observeOriginMainSha(input.repoDir), "origin/main");
  if (input.expectedCandidateSha !== undefined && observed !== exactSha(input.expectedCandidateSha, "expected origin/main")) {
    throw new Error(`origin/main moved during exact-candidate admission (${input.expectedCandidateSha} -> ${observed})`);
  }
  const prepared = await (deps.resolveAndPrepareCandidate
    ? deps.resolveAndPrepareCandidate(input, observed)
    : productionResolveCandidate(input, observed, deps.resolveAndPrepareDeps));
  if (!prepared.ok) throw new Error(`exact-candidate FRG prepare failed: ${prepared.error}`);
  const root = path.resolve(prepared.engine.engineRoot);
  if (prepared.engine.commitSha !== observed || !contained(root, prepared.engine.launcherPath)) {
    throw new Error("prepared engine does not match the selected origin/main candidate");
  }
  if (!deps.resolveCandidatePolicy) throw new Error("candidate policy resolver is required");
  const candidatePolicy = await deps.resolveCandidatePolicy(root);
  if (candidatePolicy.repository !== input.repository || candidatePolicy.baseBranch !== input.baseBranch) {
    throw new ExactCandidateFrgGateDefect("candidate repository or base policy does not match the FRG target");
  }
  const manifestPath = path.join(root, MANIFEST_REL);
  const lockfilePath = path.join(root, LOCKFILE_REL);
  if (!contained(root, manifestPath) || !contained(root, lockfilePath)) throw new Error("candidate inputs escape prepared root");
  const manifestText = await deps.readCandidateFile(manifestPath);
  const lockfile = await deps.readCandidateFile(lockfilePath);
  let manifest: { schema_version?: unknown; pack_id?: unknown; manifest_version?: unknown; templates?: Array<{ id?: unknown; file?: unknown; sha256?: unknown; title?: unknown }> };
  try { manifest = JSON.parse(String(manifestText)); } catch { throw new Error("candidate FRG manifest is not valid JSON"); }
  if (manifest.schema_version !== 1 || manifest.pack_id !== "factory-gate-v1" || manifest.manifest_version !== 1 ||
      !Array.isArray(manifest.templates) || manifest.templates.length !== 2 ||
      manifest.templates[0]?.id !== "clean-docs" || manifest.templates[1]?.id !== "clean-openspec") {
    throw new Error("candidate FRG manifest identity must be factory-gate-v1@1 with exactly clean-docs and clean-openspec");
  }
  const createdAt = iso(deps.now());
  const epochId = input.epochId ?? `frg-${input.releaseVersion}-${observed.slice(0, 12)}`;
  safeId(epochId, "exact candidate epoch");
  const manifestIdentity = { relative_path: MANIFEST_REL, sha256: digest(manifestText) };
  const slots = [] as unknown as [ExactCandidateFrgSlot, ExactCandidateFrgSlot];
  for (const [index, id] of EXACT_CANDIDATE_FRG_SLOT_IDS.entries()) {
    const ref = manifest.templates[index]!;
    if (typeof ref.file !== "string" || typeof ref.sha256 !== "string" || !DIGEST_RE.test(ref.sha256) ||
        typeof ref.title !== "string" || ref.title.trim() === "") throw new Error(`candidate template ${id} manifest entry is malformed`);
    relativeCandidatePath(ref.file, `candidate template ${id} file`);
    const packRoot = path.join(root, PACK_ROOT_REL);
    const absoluteTemplate = path.resolve(packRoot, ref.file);
    if (!contained(packRoot, absoluteTemplate)) throw new Error(`candidate template ${id} escapes the candidate pack`);
    const rel = path.relative(root, absoluteTemplate);
    const body = await deps.readCandidateFile(absoluteTemplate);
    if (digest(body) !== ref.sha256) throw new Error(`candidate template ${id} hash mismatch`);
    slots[index] = {
      id, epoch_id: epochId, candidate_sha: observed,
      template: { relative_path: rel, sha256: ref.sha256 },
      title_template: ref.title,
      provenance_id: deps.newProvenanceId?.() ?? randomBytes(32).toString("hex"),
      issue_number: null, create_certainty: "known_absent", advance_run_id: null,
      pr_number: null, pr_head_sha: null, observation: null, failure_evidence: null,
    };
  }
  const record: ExactCandidateFrgRecord = {
    schema: EXACT_CANDIDATE_FRG_SCHEMA,
    epoch_id: epochId,
    repository: input.repository,
    operational_domain: input.operationalDomain ?? input.repository,
    base_branch: input.baseBranch,
    release_version: input.releaseVersion,
    loop_engine: input.loopEngine ?? "claude",
    candidate: {
      sha: observed, engine_root: root, launcher_path: prepared.engine.launcherPath,
      manifest: manifestIdentity,
      lockfile: { relative_path: LOCKFILE_REL, sha256: digest(lockfile) },
    },
    loop_run_id: null,
    loop_dispatch_certainty: "known_absent",
    slots,
    worker_config: {
      implementer: candidatePolicy.implementer,
      reviewer: candidatePolicy.reviewer,
      gates_sha256: candidatePolicy.gatesSha256,
      review_standard_sha256: candidatePolicy.reviewPolicyHashes.standard,
      review_low_risk_round2_sha256: candidatePolicy.reviewPolicyHashes.lowRiskRound2,
      auto_file_repairs: false,
    },
    outcome: "pending", outcome_detail: "candidate and intended pair bound",
    external_wait: null, cleanup: [], cleanup_debt: false,
    created_at: createdAt, updated_at: createdAt,
  };
  parseExactCandidateFrgRecord(record);
  await deps.persist(record);
  return { record, engine: prepared.engine };
}

function matchesForSlot(matches: readonly RemoteFixtureMatch[], record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): RemoteFixtureMatch[] {
  return matches.filter((match) =>
    match.epoch_id === record.epoch_id && match.candidate_sha === record.candidate.sha &&
    match.slot_id === slot.id && match.provenance_id === slot.provenance_id);
}

function exactPairInventoryConflict(matches: readonly RemoteFixtureMatch[], record: ExactCandidateFrgRecord): string | null {
  const epochMatches = matches.filter((match) => match.epoch_id === record.epoch_id);
  const foreign = epochMatches.filter((match) => !record.slots.some((slot) =>
    match.candidate_sha === record.candidate.sha && match.slot_id === slot.id && match.provenance_id === slot.provenance_id));
  if (foreign.length > 0) return "foreign issue claims exact-pair epoch";
  const uniqueIssues: number[] = [];
  for (const [index, slot] of record.slots.entries()) {
    const candidates = matchesForSlot(epochMatches, record, slot);
    if (candidates.length > 1) return `duplicate ${slot.id} fixture matches`;
    if (slot.issue_number !== null && (candidates.length === 0 || candidates[0]!.issue_number !== slot.issue_number)) {
      return `${slot.id} recorded issue contradicts authoritative reconciliation`;
    }
    if (candidates[0]) uniqueIssues.push(candidates[0].issue_number);
  }
  if (new Set(uniqueIssues).size !== uniqueIssues.length) return "one issue claims both exact-pair slots";
  return null;
}

export async function reconcileExactCandidateFrgPair(
  source: ExactCandidateFrgRecord,
  deps: ExactCandidateFrgDeps,
): Promise<ExactCandidateFrgRecord> {
  const record = cloneRecord(parseExactCandidateFrgRecord(source));
  let matches: RemoteFixtureMatch[] = [];
  for (const [index, slot] of record.slots.entries()) {
    // Re-observe the entire epoch immediately before every possible create.
    try { matches = await deps.listFixtureMatches(record); }
    catch (error) {
      return persistOutcome(record, deps, "external_or_transient_inconclusive", `fixture inventory unavailable: ${(error as Error).message}`,
        { probe: `enumerate all issues carrying epoch ${record.epoch_id}`, wake_condition: "the forge inventory observer is available" });
    }
    const conflict = exactPairInventoryConflict(matches, record);
    if (conflict) {
      record.reconciliation_evidence = structuredClone(matches);
      return finalizeObservedOutcome(record, deps, "gate_defect", conflict);
    }
    const candidates = matchesForSlot(matches, record, slot);
    if (candidates.length === 1) {
      const issue = positiveIssue(candidates[0]!.issue_number, `${slot.id} issue`);
      if (slot.issue_number !== null && slot.issue_number !== issue) return finalizeObservedOutcome(record, deps, "gate_defect", `${slot.id} fixture identity changed`);
      slot.issue_number = issue;
      slot.create_certainty = "known_complete";
      record.updated_at = iso(deps.now());
      await deps.persist(record);
      continue;
    }
    if (slot.issue_number !== null) return finalizeObservedOutcome(record, deps, "gate_defect", `${slot.id} recorded issue is absent from authoritative reconciliation`);
    if (slot.create_certainty === "uncertain") {
      slot.create_certainty = "known_absent";
      record.updated_at = iso(deps.now());
      await deps.persist(record);
    }
    const templateBytes = await deps.readCandidateFile(path.join(record.candidate.engine_root, slot.template.relative_path));
    if (digest(templateBytes) !== slot.template.sha256) {
      return finalizeObservedOutcome(record, deps, "gate_defect", `${slot.id} candidate template changed before create`);
    }
    const template = String(templateBytes);
    const body = templateBody(template, record, slot);
    const title = renderFixtureTemplate(slot.title_template, record, slot);
    slot.create_certainty = "uncertain";
    record.updated_at = iso(deps.now());
    await deps.persist(record);
    try {
      slot.issue_number = positiveIssue(await deps.createFixture({ record, slot, title, body }), `${slot.id} create result`);
      slot.create_certainty = "known_complete";
      record.updated_at = iso(deps.now());
      stampSyntheticFixtureProvenance(slot, slot.issue_number, record.updated_at);
      await deps.persist(record);
    } catch (error) {
      try { matches = await deps.listFixtureMatches(record); }
      catch (probeError) {
        return persistOutcome(record, deps, "external_or_transient_inconclusive", `post-create inventory unavailable: ${(probeError as Error).message}`,
          { probe: `enumerate all issues carrying epoch ${record.epoch_id}`, wake_condition: "the uncertain create is authoritatively present or absent" });
      }
      const conflict = exactPairInventoryConflict(matches, record);
      if (conflict) {
        record.reconciliation_evidence = structuredClone(matches);
        return finalizeObservedOutcome(record, deps, "gate_defect", conflict);
      }
      const recovered = matchesForSlot(matches, record, slot);
      if (recovered.length > 1) return finalizeObservedOutcome(record, deps, "gate_defect", `ambiguous ${slot.id} create response`);
      if (recovered.length === 1) {
        slot.issue_number = positiveIssue(recovered[0]!.issue_number, `${slot.id} recovered issue`);
        slot.create_certainty = "known_complete";
        record.updated_at = iso(deps.now());
        stampSyntheticFixtureProvenance(slot, slot.issue_number, record.updated_at);
        await deps.persist(record);
        continue;
      }
      return persistOutcome(record, deps, "external_or_transient_inconclusive", `uncertain ${slot.id} create: ${(error as Error).message}`,
        { probe: `list fixture matches for ${slot.provenance_id}`, wake_condition: "the create side effect is authoritatively present or absent" });
    }
  }
  return record;
}

export function exactCandidateFrgLoopArgv(record: ExactCandidateFrgRecord): readonly string[] {
  parseExactCandidateFrgRecord(record);
  const issues = record.slots.map((slot) => slot.issue_number);
  if (issues.some((issue) => issue === null) || new Set(issues).size !== 2) throw new Error("ordinary FRG loop requires exactly two distinct recorded issues");
  return ["loop", String(issues[0]), String(issues[1]), "--profile", record.loop_engine,
    "--engine-track", "candidate", "--domain", record.operational_domain];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

export function parseExactCandidateFrgLoopHandoff(
  stdout: string,
  contractValue: unknown,
  ledgerValue: unknown,
  durableHandoffValue: unknown,
  expectedIssues: readonly number[],
  expectedCandidate: string,
  expectedRepository?: string,
  expectedBaseBranch?: string,
  expectedEngine?: "claude" | "codex",
): { loop_run_id: string; advance_run_ids: [string | null, string | null] } {
  const handoffs = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Partial<LoopRunHandoff>;
      return parsed.kind === LOOP_RUN_HANDOFF_KIND ? [validateExactCandidateFrgLoopHandoff(parsed)] : [];
    } catch { return []; }
  });
  if (handoffs.length !== 1) throw new Error("ordinary loop must emit exactly one canonical loop_run_handoff");
  const handoff = handoffs[0]!;
  const loopRunId = safeId(handoff.run_id, "loop handoff run_id");
  if (expectedEngine !== undefined && handoff.engine !== expectedEngine) throw new Error("ordinary loop handoff engine does not match the recorded engine");
  const advanceRunIds = validateExactCandidateFrgLoopDocuments(
    contractValue, ledgerValue, durableHandoffValue, loopRunId, expectedIssues, expectedCandidate, expectedRepository, expectedBaseBranch,
    false, expectedEngine,
  );
  return { loop_run_id: loopRunId, advance_run_ids: advanceRunIds };
}

function validateExactCandidateFrgLoopDocuments(
  contractValue: unknown,
  ledgerValue: unknown,
  durableHandoffValue: unknown,
  loopRunId: string,
  expectedIssues: readonly number[],
  expectedCandidate: string,
  expectedRepository?: string,
  expectedBaseBranch?: string,
  allowMissingHandoff = false,
  expectedEngine?: "claude" | "codex",
): [string | null, string | null] {
  const contract = object(contractValue, "ordinary loop contract");
  if (contract.run_id !== loopRunId) throw new Error("ordinary loop contract does not match canonical handoff");
  if (expectedEngine !== undefined && (contract.engine !== expectedEngine ||
      (expectedRepository !== undefined && loopRunId !== workListRunId(expectedRepository, expectedEngine, expectedIssues.map(String))))) {
    throw new Error("ordinary loop engine or canonical work-list identity does not match the recorded engine");
  }
  if (expectedRepository !== undefined || expectedBaseBranch !== undefined) {
    const repo = object(contract.repo, "ordinary loop repository");
    if (repo.name !== expectedRepository || repo.base_branch !== expectedBaseBranch) {
      throw new Error("ordinary loop contract repository does not match the exact fixture target");
    }
  }
  const selector = object(contract.selector, "ordinary loop selector");
  if (selector.type !== "work-list" || !Array.isArray(selector.value) || selector.value.length !== 2 ||
      selector.value.some((value, index) => String(value) !== String(expectedIssues[index]))) {
    throw new Error("ordinary loop contract selector must be the exact two-item work-list");
  }
  const contractItems = contract.items;
  if (!Array.isArray(contractItems) || contractItems.length !== 2 ||
      contractItems.some((item, index) => String(object(item, "ordinary loop contract item").id) !== String(expectedIssues[index]))) {
    throw new Error("ordinary loop contract items must equal the exact fixture pair");
  }
  const ledger = object(ledgerValue, "ordinary loop ledger");
  if (ledger.run_id !== loopRunId) throw new Error("ordinary loop ledger does not match canonical handoff");
  const items = object(ledger.items, "ordinary loop ledger items");
  if (Object.keys(items).sort().join("\0") !== expectedIssues.map(String).sort().join("\0")) {
    throw new Error("ordinary loop ledger items must equal the exact fixture pair");
  }
  const rawIds = expectedIssues.map((issue) => object(items[String(issue)], `ordinary loop ledger item ${issue}`).advance_run_id);
  const ids = rawIds.map((value, index) => value === undefined || value === null
    ? null : safeId(value, `advance run ${expectedIssues[index]}`));
  const boundIds = ids.filter((value): value is string => value !== null);
  if (new Set(boundIds).size !== boundIds.length) throw new Error("ordinary loop ledger must bind distinct child advance runs");
  const missingHandoff = durableHandoffValue === null;
  if ((missingHandoff && (!allowMissingHandoff || boundIds.length !== 0)) || (!missingHandoff &&
      (!isDurableLoopRunHandoff(durableHandoffValue) || durableHandoffValue.run_id !== loopRunId ||
       durableHandoffValue.candidate_sha !== expectedCandidate ||
       (expectedEngine !== undefined && durableHandoffValue.engine !== expectedEngine)))) {
    throw new Error("ordinary loop durable handoff does not bind the exact engine candidate");
  }
  return ids as [string | null, string | null];
}

function validateExactCandidateFrgLoopHandoff(value: unknown): LoopRunHandoff {
  const handoff = object(value, "ordinary loop handoff") as unknown as LoopRunHandoff;
  if (handoff.schema_version !== "1" || handoff.kind !== LOOP_RUN_HANDOFF_KIND ||
      !path.isAbsolute(handoff.run_dir) || !path.isAbsolute(handoff.events) || !contained(handoff.run_dir, handoff.events) ||
      typeof handoff.resumed !== "boolean" || (handoff.selector !== null && typeof handoff.selector !== "object")) {
    throw new Error("ordinary loop handoff is not canonical");
  }
  safeId(handoff.run_id, "loop handoff run_id");
  nonEmpty(handoff.engine, "loop handoff engine");
  return handoff;
}

export async function dispatchExactCandidateFrgPair(
  source: ExactCandidateFrgRecord,
  engine: CandidateEngine,
  deps: ExactCandidateFrgDeps,
): Promise<ExactCandidateFrgRecord> {
  const record = cloneRecord(parseExactCandidateFrgRecord(source));
  if (engine.commitSha !== record.candidate.sha || path.resolve(engine.engineRoot) !== path.resolve(record.candidate.engine_root) ||
      path.resolve(engine.launcherPath) !== path.resolve(record.candidate.launcher_path)) throw new Error("prepared engine does not match FRG candidate binding");
  const argv = record.loop_run_id === null
    ? exactCandidateFrgLoopArgv(record)
    : ["loop", "--resume", record.loop_run_id, "--profile", record.loop_engine,
      "--engine-track", "candidate", "--domain", record.operational_domain];
  const start = async (bound: CandidateEngine, env: NodeJS.ProcessEnv) =>
    deps.dispatchOrdinaryLoop({
      engine: bound,
      argv,
      env: {
        ...process.env,
        ...env,
        [PIPELINE_SUPPRESS_AUTO_FILE_ENV]: "1",
        [PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV]: "1",
        [PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV]: record.candidate.sha,
      },
      async onHandoff(handoff) {
        const runId = safeId(handoff.run_id, "streamed loop handoff run_id");
        if (record.loop_run_id !== null && record.loop_run_id !== runId) {
          throw new Error("ordinary loop emitted a different run identity during resume");
        }
        if (record.loop_run_id === null) {
          record.loop_run_id = runId;
          record.updated_at = iso(deps.now());
          await deps.persist(record);
        }
      },
    });
  record.loop_dispatch_certainty = "uncertain";
  record.updated_at = iso(deps.now());
  await deps.persist(record);
  let started: CandidateEngineProcessResult<{ stdout: string; contract: unknown; ledger: unknown; handoff: unknown }>;
  try {
    started = deps.runCandidateProcess ? await deps.runCandidateProcess(engine, start) : await productionRunCandidate(engine, start);
  } catch (error) {
    throw new ExactCandidateFrgDispatchError((error as Error).message, cloneRecord(record));
  }
  if (!started.ok) throw new ExactCandidateFrgDispatchError(`exact-candidate FRG loop start failed: ${started.error}`, cloneRecord(record));
  const issues = record.slots.map((slot) => positiveIssue(slot.issue_number, `${slot.id} issue`));
  let parsed: ReturnType<typeof parseExactCandidateFrgLoopHandoff>;
  try {
    parsed = parseExactCandidateFrgLoopHandoff(
      started.value.stdout, started.value.contract, started.value.ledger, started.value.handoff, issues, record.candidate.sha,
      record.repository, record.base_branch, record.loop_engine,
    );
  } catch (error) {
    throw new ExactCandidateFrgDispatchError(`ordinary loop handoff is invalid: ${(error as Error).message}`, cloneRecord(record), true);
  }
  record.loop_run_id = parsed.loop_run_id;
  record.loop_dispatch_certainty = parsed.advance_run_ids.every((id) => id !== null) ? "known_complete" : "uncertain";
  for (const [index, slot] of record.slots.entries()) slot.advance_run_id = parsed.advance_run_ids[index] ?? null;
  record.updated_at = iso(deps.now());
  await deps.persist(record);
  return record;
}

function observationPasses(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot, obs: ExactCandidateFrgObservation): boolean {
  const head = obs.pr.head_sha;
  return obs.unavailable_sources.length === 0 &&
    (obs.ingress_claims?.length ?? 0) === 0 &&
    obs.issue.source === "forge" && pipelineStageFromLabels(obs.issue.labels) === "ready-to-deploy" && !isBlockedInLabels(obs.issue.labels) &&
    obs.issue.provenance_epoch === record.epoch_id && obs.issue.provenance_candidate_sha === record.candidate.sha &&
    obs.issue.provenance_template_id === slot.id && obs.issue.provenance_template_sha256 === slot.template.sha256 &&
    obs.pr.source === "forge" && obs.pr.state === "open" && !obs.pr.merged &&
    obs.ordinary.source === "run_store" && obs.ordinary.advance_run_id === slot.advance_run_id &&
    obs.ordinary.loop_item_state === "ready" && obs.ordinary.final_state === "ready-to-deploy" && obs.ordinary.regression_proof === null &&
    obs.ci.source === "ci" && obs.ci.required && obs.ci.check_count > 0 && obs.ci.head_sha === head && obs.ci.conclusion === "success" &&
    obs.review.source === "review" && obs.review.independent && obs.review.evidence_subject_valid &&
    obs.review.advance_run_id.trim() !== "" && obs.review.evidence_run_id.trim() !== "" &&
    obs.review.head_sha === head && obs.review.reviewed_head_sha === head && obs.review.verdict === "accepted" &&
    obs.tester.source === "tester" && obs.tester.evidence_subject_valid && obs.tester.advance_run_id === slot.advance_run_id &&
    obs.tester.evidence_run_id.trim() !== "" &&
    obs.tester.head_sha === head && obs.tester.conclusion === "passed" && obs.tester.config_digest === record.worker_config.gates_sha256 &&
    exactCandidateFrgPathsAreHarmless(record, slot, obs.changed_paths);
}

export function classifyExactCandidateFrgObservation(
  record: ExactCandidateFrgRecord,
  slot: ExactCandidateFrgSlot,
  obs: ExactCandidateFrgObservation,
): ExactCandidateFrgOutcome {
  if (observationPasses(record, slot, obs)) return "passed";
  const proof = obs.ordinary.regression_proof;
  if (proof?.classification === "demonstrated_candidate_regression" && proof.source === "run_store" &&
      proof.advance_run_id === slot.advance_run_id && proof.candidate_sha === record.candidate.sha &&
      proof.fixture_pr_head_sha === obs.pr.head_sha) return "exact_candidate_regression";
  if ((obs.ingress_claims?.length ?? 0) > 0) return "gate_defect";
  if (obs.review.verdict === "changes_requested" && obs.review.evidence_subject_valid &&
      obs.review.head_sha === obs.pr.head_sha && obs.review.reviewed_head_sha === obs.pr.head_sha) {
    return "ordinary_review_revision";
  }
  if (obs.ci.source === "ci" && obs.ci.required && obs.ci.check_count > 0 &&
      obs.ci.conclusion === "failure" && obs.ci.head_sha === obs.pr.head_sha) return "ordinary_review_revision";
  if (obs.tester.conclusion === "failed" && obs.tester.evidence_subject_valid &&
      obs.tester.advance_run_id === slot.advance_run_id && obs.tester.config_digest === record.worker_config.gates_sha256 &&
      obs.tester.head_sha === obs.pr.head_sha) return "ordinary_review_revision";
  if (obs.unavailable_sources.length > 0 || obs.ci.conclusion === "pending" || obs.review.verdict === "unavailable" || obs.tester.conclusion === "unavailable") {
    return "external_or_transient_inconclusive";
  }
  return "gate_defect";
}

async function persistOutcome(
  record: ExactCandidateFrgRecord,
  deps: ExactCandidateFrgDeps,
  outcome: ExactCandidateFrgOutcome,
  detail: string,
  wait: ExactCandidateFrgRecord["external_wait"] = null,
): Promise<ExactCandidateFrgRecord> {
  record.outcome = outcome;
  record.outcome_detail = detail;
  record.external_wait = wait;
  record.updated_at = iso(deps.now());
  if (isFailedSyntheticCleanupOutcome(outcome) && hasPersistedSyntheticFixtureProvenance(record)) {
    if (record.failed_synthetic == null) {
      record.failed_synthetic = { classified_at: record.updated_at, classification: "known_failed_synthetic" };
    }
  } else {
    record.failed_synthetic = null;
  }
  await deps.persist(record);
  return record;
}

async function finalizeObservedOutcome(
  record: ExactCandidateFrgRecord,
  deps: ExactCandidateFrgDeps,
  outcome: ExactCandidateFrgOutcome,
  detail: string,
  wait: ExactCandidateFrgRecord["external_wait"] = null,
): Promise<ExactCandidateFrgRecord> {
  if (outcome === "gate_defect" && (!record.gate_evidence || record.gate_evidence.length === 0)) {
    record.gate_evidence = [{
      source: "controller", slot_id: null, issue_number: null, pr_number: null,
      candidate_sha: record.candidate.sha, observed_head_sha: null, fact: detail,
    }];
  }
  await persistOutcome(record, deps, outcome, detail, wait);
  if (!deps.cleanup || ["ordinary_review_revision", "external_or_transient_inconclusive"].includes(outcome)) return record;
  const requiredTargets = record.slots.filter((slot) => slot.issue_number !== null).map((slot) => `issue:${slot.issue_number}`);
  if (requiredTargets.length === 0 || requiredTargets.every((target) => record.cleanup.some((fact) => fact.target === target))) return record;
  let facts: ExactCandidateFrgCleanupFact[];
  try { facts = validateCleanupFacts(await deps.cleanup(cloneRecord(record))); }
  catch (error) { facts = record.slots.map((slot) => ({ target: `issue:${slot.issue_number ?? "unknown"}`, status: "debt", detail: (error as Error).message, observed_at: iso(deps.now()) })); }
  const byTarget = new Map(record.cleanup.map((fact) => [fact.target, fact]));
  for (const fact of facts) byTarget.set(fact.target, fact);
  record.cleanup = [...byTarget.values()];
  record.cleanup_debt = record.cleanup.some((fact) => fact.status === "debt");
  record.updated_at = iso(deps.now());
  await deps.persist(record);
  return record;
}

function validateCleanupFacts(facts: ExactCandidateFrgCleanupFact[]): ExactCandidateFrgCleanupFact[] {
  if (!Array.isArray(facts)) throw new Error("cleanup result must be an array");
  for (const [index, fact] of facts.entries()) {
    if (!fact || typeof fact.target !== "string" || fact.target.trim() === "" ||
        !["cleaned", "debt"].includes(fact.status) || typeof fact.detail !== "string" || fact.detail.trim() === "" ||
        new Date(fact.observed_at).toISOString() !== fact.observed_at) throw new Error(`cleanup fact ${index} is malformed`);
  }
  return structuredClone(facts);
}

async function finalizeAfterCandidateBookend(
  record: ExactCandidateFrgRecord,
  deps: ExactCandidateFrgDeps,
  outcome: "exact_candidate_regression" | "gate_defect",
  detail: string,
): Promise<ExactCandidateFrgRecord> {
  let current: string;
  try { current = exactSha(await deps.observeOriginMainSha(record.candidate.engine_root), "terminal origin/main"); }
  catch (error) {
    return persistOutcome(record, deps, "external_or_transient_inconclusive",
      `${detail}; final origin/main observer unavailable: ${(error as Error).message}`,
      { probe: "git ls-remote origin refs/heads/main", wake_condition: "the exact remote main SHA is observable" });
  }
  if (current !== record.candidate.sha) {
    return finalizeObservedOutcome(record, deps, "stale_candidate", `origin/main moved from ${record.candidate.sha} to ${current}`);
  }
  return finalizeObservedOutcome(record, deps, outcome, detail);
}

export async function observeExactCandidateFrgPair(source: ExactCandidateFrgRecord, deps: ExactCandidateFrgDeps): Promise<ExactCandidateFrgRecord> {
  const record = cloneRecord(parseExactCandidateFrgRecord(source));
  let current: string;
  try { current = exactSha(await deps.observeOriginMainSha(record.candidate.engine_root), "current origin/main"); }
  catch (error) {
    return persistOutcome(record, deps, "external_or_transient_inconclusive", `origin/main observer unavailable: ${(error as Error).message}`,
      { probe: "git ls-remote origin refs/heads/main", wake_condition: "the exact remote main SHA is observable" });
  }
  if (current !== record.candidate.sha) return finalizeObservedOutcome(record, deps, "stale_candidate", `origin/main moved from ${record.candidate.sha} to ${current}`);
  const classifications: ExactCandidateFrgOutcome[] = [];
  for (const [index, slot] of record.slots.entries()) {
    if (record.loop_run_id === null || slot.issue_number === null || slot.advance_run_id === null) {
      return finalizeAfterCandidateBookend(record, deps, "gate_defect", `${slot.id} lacks bound issue or ordinary run identity`);
    }
    let obs: ExactCandidateFrgObservation;
    try { obs = await deps.observeFixture(record, slot); }
    catch (error) {
      if (error instanceof ExactCandidateFrgRegression) {
        slot.failure_evidence = error.evidence;
        return finalizeAfterCandidateBookend(record, deps, "exact_candidate_regression", error.message);
      }
      if (error instanceof ExactCandidateFrgGateDefect) {
        if (error.evidence) record.gate_evidence = [...(record.gate_evidence ?? []), error.evidence];
        return finalizeAfterCandidateBookend(record, deps, "gate_defect", error.message);
      }
      return persistOutcome(record, deps, "external_or_transient_inconclusive", `observer unavailable for ${slot.id}: ${(error as Error).message}`,
        { probe: `re-observe authoritative state for issue #${slot.issue_number}`, wake_condition: "forge, checks, review, and Tester observers are available" });
    }
    slot.observation = obs;
    slot.pr_number = obs.pr.number;
    slot.pr_head_sha = obs.pr.head_sha;
    classifications.push(classifyExactCandidateFrgObservation(record, slot, obs));
  }
  for (const [index, slot] of record.slots.entries()) {
    const observed = slot.observation!;
    let identity: Awaited<ReturnType<ExactCandidateFrgDeps["reobserveFixtureIdentity"]>>;
    try { identity = await deps.reobserveFixtureIdentity(record, slot, { requireReady: classifications[index] === "passed" }); }
    catch (error) {
      if (error instanceof ExactCandidateFrgGateDefect) {
        if (error.evidence) record.gate_evidence = [...(record.gate_evidence ?? []), error.evidence];
        return finalizeAfterCandidateBookend(record, deps, "gate_defect", error.message);
      }
      return persistOutcome(record, deps, "external_or_transient_inconclusive", `final forge identity unavailable for ${slot.id}: ${(error as Error).message}`,
        { probe: `re-observe issue #${slot.issue_number} and PR #${observed.pr.number}`, wake_condition: "forge identity observer is available" });
    }
    if (identity.issue_number !== slot.issue_number || !identity.issue_open || identity.pr_number !== observed.pr.number ||
        identity.pr_head_sha !== observed.pr.head_sha || !identity.pr_open || identity.merged) {
      return finalizeAfterCandidateBookend(record, deps, "gate_defect", `${slot.id} issue or PR identity moved during pair observation`);
    }
  }
  let finalCandidate: string;
  try { finalCandidate = exactSha(await deps.observeOriginMainSha(record.candidate.engine_root), "final origin/main"); }
  catch (error) {
    return persistOutcome(record, deps, "external_or_transient_inconclusive", `final origin/main observer unavailable: ${(error as Error).message}`,
      { probe: "git ls-remote origin refs/heads/main", wake_condition: "the exact remote main SHA is observable" });
  }
  if (finalCandidate !== record.candidate.sha) {
    return finalizeObservedOutcome(record, deps, "stale_candidate", `origin/main moved from ${record.candidate.sha} to ${finalCandidate}`);
  }
  const outcome: ExactCandidateFrgOutcome = classifications.every((item) => item === "passed") ? "passed" :
    classifications.includes("gate_defect") ? "gate_defect" :
    classifications.includes("exact_candidate_regression") ? "exact_candidate_regression" :
    classifications.includes("ordinary_review_revision") ? "ordinary_review_revision" : "external_or_transient_inconclusive";
  const wait = outcome === "external_or_transient_inconclusive"
    ? { probe: "re-observe forge, CI, review, and Tester for the recorded PR heads", wake_condition: "all authoritative observers return a current conclusive result" }
    : null;
  return finalizeObservedOutcome(record, deps, outcome, `fixture outcomes: ${classifications.join(",")}`, wait);
}

/** One ordinary exact-pair runner tick. Resume retains the same candidate and pair. */
export async function runExactCandidateFrg(
  input: BeginExactCandidateFrgInput,
  deps: ExactCandidateFrgDeps,
  existing?: ExactCandidateFrgRecord,
): Promise<ExactCandidateFrgRecord> {
  let record: ExactCandidateFrgRecord;
  let prepared: CandidateEngine;
  let resumeSameLoop = false;
  if (existing) {
    record = cloneRecord(parseExactCandidateFrgRecord(existing));
    if (record.repository !== input.repository || record.operational_domain !== (input.operationalDomain ?? input.repository) ||
        record.base_branch !== input.baseBranch || record.release_version !== input.releaseVersion ||
        record.loop_engine !== (input.loopEngine ?? "claude")) {
      return finalizeObservedOutcome(record, deps, "gate_defect", "resume input does not match the recorded FRG epoch");
    }
    let current: string;
    try { current = exactSha(await deps.observeOriginMainSha(input.repoDir), "current origin/main"); }
    catch (error) {
      if (record.outcome === "passed") {
        throw new Error(`origin/main observer unavailable while preserving durable pass: ${(error as Error).message}`);
      }
      return persistOutcome(record, deps, "external_or_transient_inconclusive", `origin/main observer unavailable on resume: ${(error as Error).message}`,
        { probe: "git ls-remote origin refs/heads/main", wake_condition: "the exact remote main SHA is observable" });
    }
    if (current !== record.candidate.sha) {
      return finalizeObservedOutcome(record, deps, "stale_candidate", `origin/main moved from ${record.candidate.sha} to ${current}`);
    }
    if (record.slots.some((slot) => (slot.failure_evidence !== undefined && slot.failure_evidence !== null) ||
        slot.observation?.ordinary.regression_proof !== null && slot.observation?.ordinary.regression_proof !== undefined)) {
      return finalizeObservedOutcome(record, deps, "exact_candidate_regression", "retained current-candidate regression evidence remains authoritative");
    }
    if (record.outcome === "passed") {
      verifyExactCandidateFrgResult(record, { epoch_id: record.epoch_id, candidate_sha: record.candidate.sha });
      const requiredTargets = record.slots.map((slot) => `issue:${slot.issue_number ?? "unknown"}`);
      if (deps.cleanup && requiredTargets.some((target) => !record.cleanup.some((fact) => fact.target === target))) {
        let facts: ExactCandidateFrgCleanupFact[];
        try { facts = validateCleanupFacts(await deps.cleanup(cloneRecord(record))); }
        catch (error) { facts = requiredTargets.map((target) => ({ target, status: "debt", detail: (error as Error).message, observed_at: iso(deps.now()) })); }
        const byTarget = new Map(record.cleanup.map((fact) => [fact.target, fact]));
        for (const fact of facts) byTarget.set(fact.target, fact);
        record.cleanup = [...byTarget.values()];
        record.cleanup_debt = record.cleanup.some((fact) => fact.status === "debt");
        record.updated_at = iso(deps.now());
        await deps.persist(record);
      }
      return record;
    }
    if (["stale_candidate", "exact_candidate_regression", "gate_defect"].includes(record.outcome)) {
      return finalizeObservedOutcome(record, deps, record.outcome, record.outcome_detail);
    }
    const priorOutcome = record.outcome;
    const result = await (deps.resolveAndPrepareCandidate
      ? deps.resolveAndPrepareCandidate(input, record.candidate.sha)
      : productionResolveCandidate(input, record.candidate.sha, deps.resolveAndPrepareDeps));
    if (!result.ok) {
      if (result.kind === "lock" || result.kind === "readiness") {
        return persistOutcome(record, deps, "external_or_transient_inconclusive", `candidate resume prepare is unavailable: ${result.error}`,
          { probe: "re-prepare the exact recorded candidate", wake_condition: "the same candidate passes shared readiness and process-lock checks" });
      }
      return finalizeObservedOutcome(record, deps, "gate_defect", `candidate resume prepare failed: ${result.error}`);
    }
    prepared = result.engine;
    const preparedRoot = path.resolve(prepared.engineRoot);
    if (prepared.commitSha !== record.candidate.sha || !contained(preparedRoot, prepared.launcherPath)) {
      return finalizeObservedOutcome(record, deps, "gate_defect", "prepared candidate identity changed within epoch");
    }
    try {
      if (!deps.resolveCandidatePolicy) throw new Error("candidate policy resolver is required");
      const policy = await deps.resolveCandidatePolicy(preparedRoot);
      if (policy.repository !== record.repository || policy.baseBranch !== record.base_branch ||
          policy.implementer !== record.worker_config.implementer || policy.reviewer !== record.worker_config.reviewer ||
          policy.gatesSha256 !== record.worker_config.gates_sha256 ||
          policy.reviewPolicyHashes.standard !== record.worker_config.review_standard_sha256 ||
          policy.reviewPolicyHashes.lowRiskRound2 !== record.worker_config.review_low_risk_round2_sha256) {
        throw new Error("candidate policy identity changed");
      }
      const identities = [record.candidate.manifest, record.candidate.lockfile, ...record.slots.map((slot) => slot.template)];
      for (const identity of identities) {
        const bytes = await deps.readCandidateFile(path.join(preparedRoot, identity.relative_path));
        if (digest(bytes) !== identity.sha256) throw new Error(`${identity.relative_path} hash changed`);
      }
    } catch (error) {
      return finalizeObservedOutcome(record, deps, "gate_defect", `prepared candidate inputs changed within epoch: ${(error as Error).message}`);
    }
    record.candidate.engine_root = preparedRoot;
    record.candidate.launcher_path = prepared.launcherPath;
    if (priorOutcome === "passed") return observeExactCandidateFrgPair(record, deps);
    record.outcome = "pending";
    record.outcome_detail = "same candidate and exact pair resumed";
    record.external_wait = null;
    if (record.loop_run_id !== null && deps.validateOrdinaryLoop) {
      try {
        const durableChildren = await deps.validateOrdinaryLoop(record);
        if (durableChildren) {
          for (const [index, child] of durableChildren.entries()) {
            if (child === null) continue;
            const recorded = record.slots[index]!.advance_run_id;
            if (recorded !== null && recorded !== child) throw new Error("recorded child advance identities differ from the ordinary ledger");
            record.slots[index]!.advance_run_id = child;
          }
        }
      }
      catch (error) { return finalizeObservedOutcome(record, deps, "gate_defect", `recorded ordinary loop is invalid: ${(error as Error).message}`); }
    }
    resumeSameLoop = record.loop_run_id !== null && (priorOutcome === "ordinary_review_revision" ||
      (priorOutcome === "external_or_transient_inconclusive" && await deps.ordinaryLoopNeedsResume?.(record) === true));
  } else {
    const begun = await beginExactCandidateFrg(input, deps);
    record = begun.record;
    prepared = begun.engine;
  }
  record = await reconcileExactCandidateFrgPair(record, deps);
  if (record.outcome !== "pending") return record;
  if (record.loop_run_id === null && record.loop_dispatch_certainty === "uncertain" && deps.discoverOrdinaryLoop) {
    try {
      const discovered = await deps.discoverOrdinaryLoop(record);
      if (discovered) {
        record.loop_run_id = discovered.runId;
        for (const [index, child] of discovered.children.entries()) record.slots[index]!.advance_run_id = child;
        record.updated_at = iso(deps.now());
        await deps.persist(record);
        resumeSameLoop = true;
      }
    } catch (error) {
      return finalizeObservedOutcome(record, deps, "gate_defect", `canonical ordinary loop reconciliation failed: ${(error as Error).message}`);
    }
  }
  if (resumeSameLoop || record.loop_run_id === null || record.slots.some((slot) => slot.advance_run_id === null)) {
    try { record = await dispatchExactCandidateFrgPair(record, prepared, deps); }
    catch (error) {
      if (error instanceof ExactCandidateFrgDispatchError) {
        record = error.record;
        if (error.gateDefect) return finalizeObservedOutcome(record, deps, "gate_defect", error.message);
      }
      return persistOutcome(record, deps, "external_or_transient_inconclusive", `ordinary loop process unavailable: ${(error as Error).message}`,
        { probe: "reattach or resume the canonical ordinary loop", wake_condition: "the candidate loop process and durable handoff are observable" });
    }
  }
  try {
    if (!deps.resolveCandidatePolicy) throw new Error("candidate policy resolver is required");
    const policy = await deps.resolveCandidatePolicy(record.candidate.engine_root);
    if (policy.repository !== record.repository || policy.baseBranch !== record.base_branch ||
        policy.implementer !== record.worker_config.implementer || policy.reviewer !== record.worker_config.reviewer ||
        policy.gatesSha256 !== record.worker_config.gates_sha256 ||
        policy.reviewPolicyHashes.standard !== record.worker_config.review_standard_sha256 ||
        policy.reviewPolicyHashes.lowRiskRound2 !== record.worker_config.review_low_risk_round2_sha256) {
      throw new Error("candidate policy identity changed during ordinary loop");
    }
    for (const identity of [record.candidate.manifest, record.candidate.lockfile, ...record.slots.map((slot) => slot.template)]) {
      if (digest(await deps.readCandidateFile(path.join(record.candidate.engine_root, identity.relative_path))) !== identity.sha256) {
        throw new Error(`${identity.relative_path} changed during ordinary loop`);
      }
    }
  } catch (error) {
    return finalizeObservedOutcome(record, deps, "gate_defect", `candidate C changed before observation: ${(error as Error).message}`);
  }
  if (record.slots.some((slot) => slot.advance_run_id === null)) {
    return persistOutcome(record, deps, "external_or_transient_inconclusive", "ordinary loop has not durably linked both exact fixture children",
      { probe: `loop --resume ${record.loop_run_id}`, wake_condition: "the same canonical loop binds both child advance runs" });
  }
  return observeExactCandidateFrgPair(record, deps);
}

/** Historical HMAC latest.json, scorer, and attestor files. Not current-candidate authority. */
export function isHistoricalFailedShipEvidencePath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return /(?:^|\/)\.agent-pipeline\/frg\/\d+\.\d+\.\d+\/latest\.json$/.test(normalized)
    || /(?:^|\/)\.agent-pipeline\/frg\/[^/]+\/(score|scorer|attestor|hmac)[^/]*$/i.test(normalized);
}

export interface OwnedSyntheticCleanupIo {
  now(): Date;
  getIssue(issueNumber: number): Promise<{ body: string; labels: string[]; state: "open" | "closed" }>;
  getPr?(prNumber: number): Promise<{ number: number; head_sha: string; state: string; merged: boolean }>;
  observeBranch?(name: string): Promise<{ name: string; sha: string } | null>;
  deleteBranch?(name: string, expectedSha: string): Promise<void>;
  observeWorktree?(worktreePath: string): Promise<{ path: string; owned: boolean; identity?: string } | null>;
  deleteOwnedWorktree?(worktreePath: string, expectedIdentity: string): Promise<void>;
}

function slotHasSyntheticFixtureProvenance(slot: ExactCandidateFrgSlot): boolean {
  return slot.synthetic_fixture?.source === "synthetic_fixture_create";
}

function hasPersistedSyntheticFixtureProvenance(record: ExactCandidateFrgRecord): boolean {
  return record.slots.some(slotHasSyntheticFixtureProvenance);
}

function stampSyntheticFixtureProvenance(slot: ExactCandidateFrgSlot, issueNumber: number, persistedAt: string): void {
  if (slotHasSyntheticFixtureProvenance(slot)) return;
  slot.synthetic_fixture = {
    persisted_at: persistedAt,
    source: "synthetic_fixture_create",
    branch_name: recordedFixtureBranch(issueNumber),
    worktree_path: recordedFixtureWorktree(issueNumber),
    worktree_identity: `issue:${issueNumber}`,
  };
}

function isPersistedFailedSynthetic(record: ExactCandidateFrgRecord): boolean {
  return record.failed_synthetic?.classification === "known_failed_synthetic"
    && hasPersistedSyntheticFixtureProvenance(record);
}

function recordedFixtureBranch(issueNumber: number): string {
  return `pipeline/${issueNumber}-frg`;
}

function recordedFixtureWorktree(issueNumber: number): string {
  return `.worktrees/pipeline-${issueNumber}-frg`;
}

function issueIdentityMatches(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot, body: string): boolean {
  const claims = parseExactCandidateFrgProvenance(body);
  return claims.length === 1
    && claims[0]!.epoch_id === record.epoch_id
    && claims[0]!.candidate_sha === record.candidate.sha
    && claims[0]!.slot_id === slot.id
    && claims[0]!.provenance_id === slot.provenance_id;
}

/**
 * Ownership-safe cleanup of known failed synthetic artifacts.
 * Mutates only identities that still match recorded provenance after an
 * explicit persisted failed-synthetic classification that itself requires
 * synthetic-fixture provenance from the fixture create path. Branch and
 * worktree deletion require a recorded non-null identity and pass that
 * identity to the mutation. GitHub issue/PR close cannot enforce observed
 * provenance atomically, so those targets become cleanup debt. Simulated
 * test results prove product behavior only; they are not operator live cleanup.
 */
export async function cleanupOwnedFailedSyntheticArtifacts(
  record: ExactCandidateFrgRecord,
  io: OwnedSyntheticCleanupIo,
): Promise<ExactCandidateFrgCleanupFact[]> {
  const observedAt = io.now().toISOString();
  const facts: ExactCandidateFrgCleanupFact[] = [];
  const push = (target: string, status: "cleaned" | "debt", detail: string) => {
    facts.push({ target, status, detail, observed_at: observedAt });
  };
  const debtWithoutMutation = (target: string, detail: string) => {
    push(target, "debt", detail);
  };

  if (!isPersistedFailedSynthetic(record)) {
    for (const slot of record.slots) {
      const issueNumber = slot.issue_number;
      if (issueNumber === null) {
        debtWithoutMutation(`issue:unknown`, "slot has no recorded issue identity; no mutation attempted");
        continue;
      }
      debtWithoutMutation(`issue:${issueNumber}`, "record is not a persisted known failed synthetic artifact; no mutation attempted");
      if (slot.pr_number !== null) {
        debtWithoutMutation(`pr:${slot.pr_number}`, "record is not a persisted known failed synthetic artifact; no mutation attempted");
      }
    }
    return facts;
  }

  for (const slot of record.slots) {
    const issueNumber = slot.issue_number;
    if (issueNumber === null) {
      debtWithoutMutation(`issue:unknown`, "slot has no recorded issue identity; no mutation attempted");
      continue;
    }
    if (!slotHasSyntheticFixtureProvenance(slot)) {
      debtWithoutMutation(`issue:${issueNumber}`, "slot lacks persisted synthetic-fixture provenance; no mutation attempted");
      if (slot.pr_number !== null) {
        debtWithoutMutation(`pr:${slot.pr_number}`, "slot lacks persisted synthetic-fixture provenance; no mutation attempted");
      }
      continue;
    }
    const recorded = slot.synthetic_fixture!;
    const issueTarget = `issue:${issueNumber}`;
    try {
      const issue = await io.getIssue(issueNumber);
      if (!issueIdentityMatches(record, slot, issue.body)) {
        debtWithoutMutation(issueTarget, "recorded synthetic identity no longer matches; no mutation attempted");
      } else if (issue.state === "closed") {
        push(issueTarget, "cleaned", "owned fixture issue already closed; no mutation");
      } else {
        debtWithoutMutation(issueTarget, "ownership-safe cleanup requires a conditional remote mutation; GitHub close cannot enforce observed provenance atomically; no mutation attempted");
      }
    } catch (error) {
      debtWithoutMutation(issueTarget, `issue identity uncertain: ${(error as Error).message}; no mutation attempted`);
    }

    const prNumber = slot.pr_number;
    if (prNumber !== null) {
      const prTarget = `pr:${prNumber}`;
      if (!io.getPr) {
        debtWithoutMutation(prTarget, "PR observer is unavailable; no mutation attempted");
      } else {
        try {
          const pr = await io.getPr(prNumber);
          const headMatches = slot.pr_head_sha === null || pr.head_sha === slot.pr_head_sha;
          if (pr.number !== prNumber || !headMatches || pr.merged) {
            debtWithoutMutation(prTarget, "recorded synthetic PR identity no longer matches; no mutation attempted");
          } else if (pr.state !== "open") {
            push(prTarget, "cleaned", "owned fixture PR already closed; no mutation");
          } else {
            debtWithoutMutation(prTarget, "ownership-safe cleanup requires a conditional remote mutation; GitHub close cannot enforce observed provenance atomically; no mutation attempted");
          }
        } catch (error) {
          debtWithoutMutation(prTarget, `PR identity uncertain: ${(error as Error).message}; no mutation attempted`);
        }
      }
    }

    const branchName = recorded.branch_name;
    const branchTarget = `branch:${branchName}`;
    if (!io.observeBranch) {
      debtWithoutMutation(branchTarget, "branch observer is unavailable; no mutation attempted");
    } else {
      try {
        const branch = await io.observeBranch(branchName);
        const expectedSha = slot.pr_head_sha;
        if (branch === null) {
          push(branchTarget, "cleaned", "owned fixture branch already absent; no mutation");
        } else if (expectedSha === null) {
          debtWithoutMutation(branchTarget, "recorded synthetic branch SHA is null; no mutation attempted");
        } else if (branch.name !== branchName || branch.sha !== expectedSha) {
          debtWithoutMutation(branchTarget, "recorded synthetic branch identity no longer matches; no mutation attempted");
        } else if (!io.deleteBranch) {
          debtWithoutMutation(branchTarget, "ownership-safe cleanup requires a conditional remote mutation; no mutation attempted");
        } else {
          await io.deleteBranch(branchName, expectedSha);
          push(branchTarget, "cleaned", "deleted owned failed synthetic branch after identity match");
        }
      } catch (error) {
        debtWithoutMutation(branchTarget, `branch identity uncertain: ${(error as Error).message}; no mutation attempted`);
      }
    }

    const worktreePath = recorded.worktree_path;
    const worktreeIdentity = recorded.worktree_identity;
    const worktreeTarget = `worktree:${worktreePath}`;
    if (!io.observeWorktree) {
      debtWithoutMutation(worktreeTarget, "worktree observer is unavailable; no mutation attempted");
    } else {
      try {
        const worktree = await io.observeWorktree(worktreePath);
        if (worktree === null) {
          push(worktreeTarget, "cleaned", "owned fixture worktree already absent; no mutation");
        } else if (worktree.identity === undefined || worktree.identity.trim() === "") {
          debtWithoutMutation(worktreeTarget, "observed worktree has no recorded ownership identity; no mutation attempted");
        } else if (!worktree.owned || worktree.path !== worktreePath || worktree.identity !== worktreeIdentity) {
          debtWithoutMutation(worktreeTarget, "target is not the recorded owned synthetic worktree; no mutation attempted");
        } else if (!io.deleteOwnedWorktree) {
          debtWithoutMutation(worktreeTarget, "ownership-safe cleanup requires a conditional remote mutation; no mutation attempted");
        } else {
          await io.deleteOwnedWorktree(worktreePath, worktreeIdentity);
          push(worktreeTarget, "cleaned", "removed owned failed synthetic worktree after identity match");
        }
      } catch (error) {
        debtWithoutMutation(worktreeTarget, `worktree identity uncertain: ${(error as Error).message}; no mutation attempted`);
      }
    }
  }

  return facts;
}

export function verifyExactCandidateFrgResult(value: unknown, expected: { epoch_id: string; candidate_sha: string }): ExactCandidateFrgRecord {
  const record = parseExactCandidateFrgRecord(value);
  if (record.epoch_id !== expected.epoch_id || record.candidate.sha !== expected.candidate_sha) throw new Error("exact-candidate FRG result identity mismatch");
  if (record.outcome !== "passed") throw new Error(`exact-candidate FRG result is not proven: ${record.outcome}`);
  if (record.loop_dispatch_certainty !== "known_complete") throw new Error("passed loop dispatch is not known complete");
  safeId(record.loop_run_id, "passed loop_run_id");
  const advanceIds = record.slots.map((slot) => safeId(slot.advance_run_id, `${slot.id} passed advance_run_id`));
  if (new Set(advanceIds).size !== 2) throw new Error("passed child advance identities must be distinct");
  for (const slot of record.slots) {
    positiveIssue(slot.issue_number, `${slot.id} passed issue_number`);
    if (slot.create_certainty !== "known_complete") throw new Error(`${slot.id} fixture create is not known complete`);
    if (slot.failure_evidence) throw new Error(`${slot.id} retains candidate failure evidence`);
    if (!slot.observation || !observationPasses(record, slot, slot.observation)) throw new Error(`${slot.id} lacks authoritative current-head completion proof`);
    if (slot.pr_head_sha === record.candidate.sha) throw new Error(`${slot.id} fixture PR head must remain distinct from engine candidate`);
  }
  return record;
}


function evidenceSubjectMatches(value: unknown, input: { issue: number; pr: number; runId: string; head: string; domain: string }): boolean {
  const parsed = parseEvidenceSubjectDetailed(value);
  return parsed.status === "ok" && parsed.subject.issue === input.issue && parsed.subject.pr === input.pr &&
    parsed.subject.run_id === input.runId && parsed.subject.candidate_sha === input.head && parsed.subject.domain === input.domain;
}

function parseExactAdvanceSummary(value: unknown): ExactAdvanceSummary {
  const summary = object(value, "ordinary advance summary") as unknown as ExactAdvanceSummary;
  if (summary.schema_version !== RUN_SCHEMA_VERSION || summary.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      typeof summary.run_id !== "string" || summary.run_id.trim() === "" || typeof summary.runId !== "string" || summary.runId.trim() === "" ||
      !Number.isSafeInteger(summary.issue) || (summary.pr !== null && !Number.isSafeInteger(summary.pr)) ||
      !Array.isArray(summary.harnesses) || !Array.isArray(summary.stages) || !Array.isArray(summary.reviews) ||
      !Array.isArray(summary.overrides) || !Array.isArray(summary.recoveries) ||
      !(summary.finalState === null || typeof summary.finalState === "string") ||
      !(summary.finalizedAt === null || typeof summary.finalizedAt === "string") ||
      !(summary.notifiedAt === null || typeof summary.notifiedAt === "string") ||
      parseEvidenceSubjectDetailed(summary.evidence_subject).status !== "ok") {
    throw new ExactCandidateFrgGateDefect("ordinary advance summary is incomplete or malformed");
  }
  for (const review of summary.reviews) {
    if (!review || typeof review !== "object" || ![1, 2].includes(review.round) ||
        typeof review.sha !== "string" || typeof review.verdict !== "string" ||
        !(review.model === undefined || typeof review.model === "string") ||
        !review.findingCounts || typeof review.findingCounts !== "object" ||
        Object.values(review.findingCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
      throw new ExactCandidateFrgGateDefect("ordinary advance summary contains a malformed review row");
    }
    if (review.ensemble !== undefined) {
      if (!review.ensemble || !Array.isArray(review.ensemble.agents) || review.ensemble.agents.some((agent) =>
        !agent || typeof agent.harness !== "string" || agent.harness.trim() === "" ||
        typeof agent.effectiveHarness !== "string" || agent.effectiveHarness.trim() === "" ||
        !(agent.model === undefined || typeof agent.model === "string") ||
        typeof agent.selfReview !== "boolean" || !["usable", "failed"].includes(agent.status))) {
        throw new ExactCandidateFrgGateDefect("ordinary advance summary contains a malformed review ensemble");
      }
    }
    if (review.harness !== undefined && (typeof review.harness !== "string" || review.harness.trim() === "")) {
      throw new ExactCandidateFrgGateDefect("ordinary advance summary contains a malformed review harness");
    }
  }
  return summary;
}

function hasCurrentFailedEngineRecovery(
  ledger: Record<string, unknown>, issueNumber: number,
  prNumber: number | null, head: string | null, advanceRunId: string,
): boolean {
  const exhausted = currentWorkflowEngineExhaustion(ledger as never, String(issueNumber));
  return exhausted !== null && exhausted.advanceRunId === advanceRunId &&
    exhausted.prNumber === prNumber && exhausted.headSha === head;
}

function reviewAttemptIsIndependent(
  input: { implementer: string },
  attempt: { harness: string; effectiveHarness: string; model?: string; selfReview: boolean; status: "usable" | "failed" },
  index: number,
): boolean {
  const lineage: ReviewerAttemptLineage = {
    index,
    configured_harness: attempt.harness,
    effective_harness: attempt.effectiveHarness,
    provider_family: mapProviderFamily(attempt.effectiveHarness, attempt.model),
    model_family: mapModelFamily(attempt.model),
    model: attempt.model,
    self_review: attempt.selfReview,
    implementer_harness: input.implementer,
    status: attempt.status,
    latency_ms: null,
    attempted: true,
    completed: true,
    billable: false,
    cost_usd: null,
  };
  return isIndependentlyEligible(lineage);
}

function acceptedIndependentReview(
  summary: ExactAdvanceSummary | null,
  input: {
    issue: number; pr: number; fileRunId: string; head: string; domain: string; implementer: string; reviewer: string;
    diffHash: string; reviewPolicyHashes: { standard: string; lowRiskRound2: string }; coverageHead?: string;
  },
): {
  accepted: boolean; subjectValid: boolean; verdict: "accepted" | "changes_requested" | "unavailable";
  headSha: string; evidenceRunId: string;
} {
  if (!summary || summary.run_id !== input.fileRunId || summary.issue !== input.issue || summary.pr !== input.pr) {
    return { accepted: false, subjectValid: false, verdict: "unavailable", headSha: "0".repeat(40), evidenceRunId: "unavailable" };
  }
  const coverageHead = input.coverageHead ?? input.head;
  const summaryAtReviewedHead = evidenceSubjectMatches(summary.evidence_subject, {
    issue: input.issue, pr: input.pr, runId: summary.runId, head: input.head, domain: input.domain,
  });
  const summaryAtCoverageHead = coverageHead !== input.head && evidenceSubjectMatches(summary.evidence_subject, {
    issue: input.issue, pr: input.pr, runId: summary.runId, head: coverageHead, domain: input.domain,
  });
  if (!summaryAtReviewedHead && !summaryAtCoverageHead) {
    return { accepted: false, subjectValid: false, verdict: "unavailable", headSha: input.head, evidenceRunId: summary.runId };
  }
  if (summary.roles?.implementer !== input.implementer || summary.roles.reviewer !== input.reviewer ||
      summary.roles.implementerSource !== "repo-config" || summary.roles.reviewerSource !== "repo-config") {
    return { accepted: false, subjectValid: false, verdict: "unavailable", headSha: "0".repeat(40), evidenceRunId: "unavailable" };
  }
  const rows = summary.reviews.filter((review) => review.sha === input.head);
  const row = rows.reduce<(typeof rows)[number] | undefined>((latest, candidate) =>
    latest === undefined || candidate.round >= latest.round ? candidate : latest, undefined);
  if (!row) {
    const stale = summary.reviews.at(-1);
    const staleSubject = parseEvidenceSubjectDetailed(stale?.evidence_subject);
    return {
      accepted: false, subjectValid: false, verdict: "unavailable",
      headSha: stale && /^[0-9a-f]{40}$/.test(stale.sha) ? stale.sha : "0".repeat(40),
      evidenceRunId: staleSubject.status === "ok" ? staleSubject.subject.run_id : "unavailable",
    };
  }
  const normalizedVerdict = row.verdict.toLowerCase();
  const verdict = ["approve", "approved", "accepted"].includes(normalizedVerdict) ? "accepted" :
    ["changes_requested", "needs-attention", "rejected"].includes(normalizedVerdict) ? "changes_requested" : "unavailable";
  const ensembleAttempts = row.ensemble?.agents ?? [];
  const attempts = ensembleAttempts.length > 0 ? ensembleAttempts : (typeof row.harness === "string" && row.harness.trim() !== "" && typeof row.selfReview === "boolean"
    ? [{ harness: row.harness, effectiveHarness: row.harness, model: row.model, selfReview: row.selfReview, status: "usable" as const }]
    : []);
  const independent = attempts.some((attempt, index) => reviewAttemptIsIndependent(input, attempt, index));
  return {
    accepted: verdict === "accepted" && independent,
    subjectValid: (() => {
      const rowSubject = parseEvidenceSubjectDetailed(row.evidence_subject);
      const pin = parseEvidenceSubjectDetailed(summary.evidence_subject);
      if (rowSubject.status !== "ok" || pin.status !== "ok" || rowSubject.subject.diff_hash !== input.diffHash ||
          rowSubject.subject.issue !== input.issue || rowSubject.subject.pr !== input.pr ||
          rowSubject.subject.run_id !== summary.runId || rowSubject.subject.candidate_sha !== input.head ||
          rowSubject.subject.domain !== input.domain) return false;
      const familyFields = (Object.keys(pin.subject) as Array<keyof EvidenceSubjectV1>)
        .filter((field) => field !== "diff_hash" && field !== "policy_hash" && field !== "candidate_sha");
      const currentR1 = summary.reviews.filter((review) => review.round === 1 && review.sha === input.head).at(-1);
      const r1Subject = parseEvidenceSubjectDetailed(currentR1?.evidence_subject);
      const r1LowRisk = currentR1 !== undefined && ["approve", "approved", "accepted"].includes(currentR1.verdict.toLowerCase()) &&
        Object.values(currentR1.findingCounts).every((count) => count === 0) && r1Subject.status === "ok" &&
        r1Subject.subject.candidate_sha === input.head && r1Subject.subject.diff_hash === input.diffHash &&
        r1Subject.subject.policy_hash === input.reviewPolicyHashes.standard &&
        familyFields.every((field) => r1Subject.subject[field] === pin.subject[field]);
      const allowedPolicyHashes = row.round === 2 && r1LowRisk
        ? [input.reviewPolicyHashes.standard, input.reviewPolicyHashes.lowRiskRound2]
        : [input.reviewPolicyHashes.standard];
      if (!allowedPolicyHashes.includes(rowSubject.subject.policy_hash)) return false;
      return familyFields.every((field) => rowSubject.subject[field] === pin.subject[field]);
    })(),
    verdict,
    headSha: row.sha,
    evidenceRunId: (() => {
      const subject = parseEvidenceSubjectDetailed(row.evidence_subject);
      return subject.status === "ok" ? subject.subject.run_id : "unavailable";
    })(),
  };
}

export async function resolveExactCandidateCurrentReviewArtifact(
  comments: readonly { author: string; body: string }[],
  input: { actor: string; currentHeadSha: string; currentDiffHash: string },
  resolveCurrency: (reviewedSha: string) => Promise<"current" | "superseded" | "unknown">,
): Promise<ReviewArtifact | null> {
  for (const comment of [...comments].reverse()) {
    if (comment.author !== input.actor || !isVerifiedPipelineReviewOutput(comment.body)) continue;
    const artifact = extractReviewArtifact(comment.body);
    if (!artifact || typeof artifact.pipelineRunId !== "string" || artifact.diffHash === null) continue;
    if (artifact.reviewedSha === input.currentHeadSha) {
      if (artifact.diffHash === input.currentDiffHash) return artifact;
      continue;
    }
    if (await resolveCurrency(artifact.reviewedSha) === "current") return artifact;
  }
  return null;
}

function passedTester(
  evidence: TesterEvidence | null,
  input: { issue: number; pr: number; runId: string; head: string; configDigest: string; domain: string; readinessSubject: unknown },
): { passed: boolean; subjectValid: boolean } {
  if (!evidence || !validateTesterEvidence(evidence).ok) return { passed: false, subjectValid: false };
  const identityBound = evidenceSubjectMatches(evidence.evidence_subject, input);
  const subject = parseEvidenceSubjectDetailed(evidence.evidence_subject);
  const readiness = parseEvidenceSubjectDetailed(input.readinessSubject);
  const familyBound = subject.status === "ok" && readiness.status === "ok" &&
    subject.subject.engine_fingerprint === readiness.subject.engine_fingerprint &&
    subject.subject.verifier_fingerprint === readiness.subject.verifier_fingerprint &&
    subject.subject.required_evidence_set_revision === readiness.subject.required_evidence_set_revision;
  const policyBound = subject.status === "ok" && subject.subject.policy_hash === input.configDigest;
  const subjectValid = identityBound && familyBound && policyBound;
  return {
    passed: evidence.run_id === input.runId && evidence.issue === input.issue && evidence.pr === input.pr &&
      evidence.candidate_sha === input.head && evidence.config_digest === input.configDigest &&
      familyBound && policyBound &&
      evidence.overall_status === "passed" && evidence.commands.length > 0 &&
      evidence.commands.every((row) => row.status === "passed" && row.exit_code === 0),
    subjectValid,
  };
}

/**
 * The ordinary post-PR binder preserves the produced suite artifact and only
 * rebinds its issue/PR evidence subject. Keep this relation closed so a copied
 * artifact cannot substitute different commands, config, timing, or producer.
 */
function testerEvidenceIsCanonicalRebind(source: TesterEvidence, rebound: TesterEvidence): boolean {
  if (!validateTesterEvidence(source).ok || !validateTesterEvidence(rebound).ok) return false;
  if (source.issue !== rebound.issue) return false;
  const {
    pr: _sourcePr,
    evidence_subject: _sourceSubject,
    ...sourceProduced
  } = source;
  const {
    pr: _reboundPr,
    evidence_subject: _reboundSubject,
    ...reboundProduced
  } = rebound;
  return digest(JSON.stringify(sourceProduced)) === digest(JSON.stringify(reboundProduced));
}

function commandOutput(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  onStdoutLine?: (line: string) => Promise<void>,
  limits: { timeoutMs: number; maxBuffer: number } | null = { timeoutMs: 30_000, maxBuffer: 50 * 1024 * 1024 },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let lineWrites = Promise.resolve();
    let boundedFailure: Error | null = null;
    const timer = limits === null ? null : setTimeout(() => {
      boundedFailure = new Error(`${command} timed out after ${limits.timeoutMs}ms`);
      child.kill();
    }, limits.timeoutMs);
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (limits !== null && Buffer.byteLength(next) > limits.maxBuffer && boundedFailure === null) {
        boundedFailure = new Error(`${command} output exceeded ${limits.maxBuffer} bytes`);
        child.kill();
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      if (!onStdoutLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        lineWrites = lineWrites.then(() => onStdoutLine(line));
        void lineWrites.catch(() => child.kill());
      }
    });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.once("close", async (code, signal) => {
      try {
        if (timer) clearTimeout(timer);
        if (onStdoutLine && lineBuffer !== "") lineWrites = lineWrites.then(() => onStdoutLine(lineBuffer));
        await lineWrites;
        if (boundedFailure) throw boundedFailure;
        if (code === 0 && signal === null) resolve(stdout);
        else reject(new CommandOutputError(`${command} exited ${signal ?? code}: ${stderr.trim()}`, stdout, stderr, code));
      } catch (error) { reject(error); }
    });
  });
}

export function defaultProductionExactCandidateFrgIo(
  input: BeginExactCandidateFrgInput,
  composition: {
    resolveConfigFn?: typeof resolveConfig;
    resolvePrimaryRepoDir?: (repoDir: string) => Promise<string>;
    listWorktrees?: (repoDir: string) => Promise<string>;
  } = {},
): ProductionExactCandidateFrgIo {
  const loopEngine = input.loopEngine ?? "claude";
  const resolveEffectiveConfig = composition.resolveConfigFn ?? resolveConfig;
  const targetCfg = resolveEffectiveConfig({ repoPath: input.repoDir, profile: loopEngine });
  const cfg = { ...targetCfg, repo: input.repository, base_branch: input.baseBranch };
  const loopStore = defaultLoopStoreDeps();
  const resolvePrimary = async (repoDir: string): Promise<string> => {
    const output = composition.listWorktrees
      ? await composition.listWorktrees(repoDir)
      : await commandOutput("git", ["worktree", "list", "--porcelain"], repoDir);
    const primary = primaryWorktreeFromPorcelain(output);
    if (!primary || !path.isAbsolute(primary) || path.normalize(primary) !== primary) {
      throw new ExactCandidateFrgGateDefect("release store primary is not authoritatively observable");
    }
    return primary;
  };
  // A caller-supplied primary is a prevalidated embedding seam. Production
  // discovery never uses the ordinary run-store resolver's fail-open fallback.
  const primaryRepoDir = composition.resolvePrimaryRepoDir?.(input.repoDir) ?? resolvePrimary(input.repoDir);
  const operationalDomain = async () => resolveEffectiveConfig({ repoPath: await primaryRepoDir, profile: loopEngine }).domain;
  return {
    now: () => new Date(),
    resolveReleaseStoreRepoDir: async () => primaryRepoDir,
    async validateTargetRuntime() {
      const primary = await primaryRepoDir;
      const origin = (await commandOutput("git", ["remote", "get-url", "origin"], primary)).trim();
      const repository = ownerRepoFromPackageRepository(origin);
      if (repository === null) throw new ExactCandidateFrgGateDefect("target primary origin is not a canonical GitHub repository");
      return { domain: await operationalDomain(), repository };
    },
    resolveCandidatePolicy: async (engineRoot) => {
      const candidate = resolveEffectiveConfig({ repoPath: engineRoot, profile: loopEngine });
      return {
        repository: candidate.repo, baseBranch: candidate.base_branch, domain: await operationalDomain(),
        implementer: candidate.harnesses.implementer, reviewer: candidate.harnesses.reviewer,
        gatesSha256: buildTesterPolicyHash({
          command_identity: candidate.test_gate.command?.trim() || null,
          enabled: candidate.test_gate.enabled,
          timeout: candidate.test_gate.timeout,
          max_output_chars: candidate.tester_evidence.max_output_chars,
        }),
        reviewPolicyHashes: {
          standard: buildReviewPolicyHash(effectiveReviewPolicy(candidate.review_policy, { round: 1, review1Risk: "standard" })),
          lowRiskRound2: buildReviewPolicyHash(effectiveReviewPolicy(candidate.review_policy, { round: 2, review1Risk: "low" })),
        },
      };
    },
    async observeOriginMainSha(repoDir) {
      const output = await commandOutput("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], repoDir);
      const fields = output.trim().split(/\s+/);
      return fields.length === 2 && fields[1] === "refs/heads/main" ? fields[0]! : null;
    },
    async readFile(file) {
      try { return await fs.readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    async listRecordEpochIds(repoDir) {
      try {
        return (await fs.readdir(path.dirname(exactCandidateFrgResultPath(repoDir, "probe"))))
          .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
          .map((name) => name.slice(0, -5));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    writeRecord: (repoDir, record) => persistExactCandidateFrgRecord(repoDir, record, {
      mkdir: (directory) => fs.mkdir(directory, { recursive: true }).then(() => undefined),
      writeFile: (file, body) => fs.writeFile(file, body),
      rename: (from, to) => fs.rename(from, to),
      syncFile: async (file) => { const handle = await fs.open(file, "r"); try { await handle.sync(); } finally { await handle.close(); } },
      syncDir: async (directory) => { const handle = await fs.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } },
    }),
    async listIssues(repository) {
      const raw = JSON.parse(await commandOutput("gh", ["api", `repos/${repository}/issues?state=all&per_page=100`, "--paginate", "--slurp"], input.repoDir)) as Array<Array<Record<string, unknown>>>;
      return raw.flat().filter((issue) => !("pull_request" in issue)).map((issue) => ({
        number: positiveIssue(issue.number, "enumerated issue number"), body: typeof issue.body === "string" ? issue.body : "",
        state: issue.state === "open" ? "open" as const : "closed" as const,
      }));
    },
    createIssue: async (repository, title, body, labels) => createIssue({ ...cfg, repo: repository }, title, body, labels),
    async runCandidateLoop(engine, argv, env, onHandoff) {
      try {
        return await commandOutput(
          shipEndCliPrefix(engine)[0]!, [...shipEndCliPrefix(engine).slice(1), ...argv], engine.engineRoot, env,
          async (line) => {
            try {
              const candidate = JSON.parse(line) as Partial<LoopRunHandoff>;
              if (candidate.kind === LOOP_RUN_HANDOFF_KIND) await onHandoff(validateExactCandidateFrgLoopHandoff(candidate));
            } catch (error) { if (error instanceof SyntaxError) return; throw error; }
          }, null,
        );
      } catch (error) {
        const recovered = recoverExpectedExactCandidateLoopExit(error);
        if (recovered !== null) return recovered;
        throw error;
      }
    },
    async readLoopDocuments(loopRunId) {
      return {
        contract: await readContract(loopStore, loopRunId), ledger: await readLedger(loopStore, loopRunId),
        handoff: await readLoopRunHandoff(loopStore, loopRunId),
      };
    },
    loopRunExists: (loopRunId) => loopRunExists(loopStore, loopRunId),
    getIssue: async (_input, issueNumber) => {
      const issue = await getIssueDetail(cfg, issueNumber);
      return { body: issue.body, labels: issue.labels, state: issue.state === "open" ? "open" : "closed", comments: issue.comments };
    },
    listPrsAnyState: async (_input, issueNumber) => listPrsForIssueAnyState(cfg, issueNumber),
    listOpenPrs: async (_input, issueNumber) => listOpenPrsForIssue(cfg, issueNumber),
    getPr: async (_input, prNumber) => {
      const pr = await getPrDetail(cfg, prNumber);
      return { number: pr.number, head_sha: pr.head_sha, base_ref: pr.base_ref, state: pr.state, merged: pr.state === "merged" || pr.merge_commit_sha !== null };
    },
    async getRequiredChecks(_input, prNumber) {
      try {
        return JSON.parse(await commandOutput("gh", ["pr", "checks", String(prNumber), "--required", "--json", "name,bucket", "-R", input.repository], input.repoDir)) as RequiredCheck[];
      }
      catch (error) {
        const recovered = recoverExactCandidateFrgChecks(error);
        if (recovered) return recovered;
        if (!String((error as Error).message).toLowerCase().includes("no required checks reported")) throw error;
        try {
          return JSON.parse(await commandOutput("gh", ["pr", "checks", String(prNumber), "--json", "name,bucket", "-R", input.repository], input.repoDir)) as RequiredCheck[];
        } catch (fallbackError) {
          const fallback = recoverExactCandidateFrgChecks(fallbackError);
          if (fallback) return fallback;
          if (String((fallbackError as Error).message).toLowerCase().includes("no checks reported")) return [];
          throw fallbackError;
        }
      }
    },
    getPrDiff: async (_input, prNumber) => getPrDiff(cfg, prNumber),
    async readAdvanceSummary(_runInput, advanceRunId) {
      let text: string;
      try { text = await fs.readFile(path.join(runDirPath(await primaryRepoDir, advanceRunId), "summary.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      try { return parseExactAdvanceSummary(JSON.parse(text)); }
      catch (error) {
        if (error instanceof ExactCandidateFrgGateDefect) throw error;
        throw new ExactCandidateFrgGateDefect(`ordinary advance summary bytes are malformed: ${(error as Error).message}`);
      }
    },
    async readAdvanceTester(_runInput, advanceRunId) {
      return readTesterEvidence(runDirPath(await primaryRepoDir, advanceRunId));
    },
    async readCurrentReviewEvidence(_runInput, issueNumber, prNumber, headSha, diffHash) {
      const actor = await getGhActor();
      if (!actor) throw new Error("authenticated review actor is unavailable");
      const detail = await getIssueDetail(cfg, issueNumber);
      const authority = await resolveExactCandidateCurrentReviewArtifact(detail.comments, {
        actor, currentHeadSha: headSha, currentDiffHash: diffHash,
      }, async (reviewedSha) => (await resolveReviewedShaCurrency(cfg, prNumber, reviewedSha, { getPrDetail, getPrCommits })).status);
      if (!authority) return null;
      const traceRunId = authority.pipelineRunId!;
      const matches: Array<{ advanceRunId: string; summary: ExactAdvanceSummary }> = [];
      for (const runId of await listRunIds(await primaryRepoDir)) {
        if (!runId.startsWith(`${issueNumber}-`)) continue;
        let text: string;
        try { text = await fs.readFile(path.join(runDirPath(await primaryRepoDir, runId), "summary.json"), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { continue; }
        if (!parsed || typeof parsed !== "object" || (parsed as { runId?: unknown }).runId !== traceRunId) continue;
        let summary: ExactAdvanceSummary;
        try { summary = parseExactAdvanceSummary(parsed); }
        catch (error) { throw new ExactCandidateFrgGateDefect(`review source summary is malformed: ${(error as Error).message}`); }
        if (summary.issue === issueNumber) matches.push({ advanceRunId: runId, summary });
      }
      if (matches.length > 1) throw new ExactCandidateFrgGateDefect("review artifact trace resolves to multiple physical runs");
      return matches[0] ? { ...matches[0], reviewedHeadSha: authority.reviewedSha, reviewedDiffHash: authority.diffHash! } : null;
    },
  };
}

export function createProductionExactCandidateFrgDeps(
  input: BeginExactCandidateFrgInput,
  io: ProductionExactCandidateFrgIo = defaultProductionExactCandidateFrgIo(input),
  releaseStoreRepoDir = input.repoDir,
): ExactCandidateFrgDeps {
  return {
    now: io.now,
    observeOriginMainSha: () => io.observeOriginMainSha(input.repoDir),
    resolveAndPrepareDeps: defaultResolveAndPrepareDeps(),
    resolveAndPrepareCandidate: io.resolveAndPrepareCandidate
      ? (boundInput, candidateSha) => io.resolveAndPrepareCandidate!(boundInput, candidateSha)
      : (boundInput, candidateSha) => productionResolveCandidate(boundInput, candidateSha, defaultResolveAndPrepareDeps()),
    readCandidateFile: async (file) => {
      const body = await io.readFile(file);
      if (body === null) throw new Error(`candidate input is missing: ${file}`);
      return body;
    },
    async resolveCandidatePolicy(engineRoot) {
      const policy = await io.resolveCandidatePolicy(engineRoot);
      return policy;
    },
    persist: (record) => io.writeRecord(releaseStoreRepoDir, record),
    async listFixtureMatches(record) {
      const templates = new Map(await Promise.all(record.slots.map(async (slot) => [
        slot.id, await io.readFile(path.join(record.candidate.engine_root, slot.template.relative_path)),
      ] as const)));
      return (await io.listIssues(record.repository)).flatMap((issue) =>
        parseExactCandidateFrgProvenance(issue.body).map((claim) => {
          const rendered = parseCandidateRenderedFrgProvenance(issue.body);
          const slot = record.slots.find((candidateSlot) => candidateSlot.id === claim.slot_id);
          const template = slot ? templates.get(slot.id) : null;
          const valid = rendered && slot && claim.epoch_id === record.epoch_id && claim.candidate_sha === record.candidate.sha &&
            claim.provenance_id === slot.provenance_id && rendered.pack_id === "factory-gate-v1" && rendered.manifest_version === "1" &&
            rendered.pack_run_id === claim.epoch_id && rendered.release_version === record.release_version &&
            rendered.template_id === claim.slot_id && rendered.template_sha256 === slot.template.sha256 &&
            rendered.manifest_sha256 === record.candidate.manifest.sha256 && template !== null &&
            issue.body === templateBody(template, record, slot);
          return { issue_number: issue.number, ...claim, ...(valid && issue.state === "open" ? {} : { slot_id: "foreign" }) };
        }));
    },
    createFixture: ({ record, title, body }) => io.createIssue(record.repository, title, body, ["pipeline:ready"]),
    async dispatchOrdinaryLoop({ engine, argv, env, onHandoff }) {
      const stdout = await executeCandidateOrdinaryLoop({
        engine, argv, env, onHandoff, targetPrimaryRepoDir: releaseStoreRepoDir,
      }, io.runCandidateLoop.bind(io));
      const handoffLines = stdout.split(/\r?\n/).filter((line) => line.includes(`\"kind\":\"${LOOP_RUN_HANDOFF_KIND}\"`));
      if (handoffLines.length !== 1) return { stdout, contract: null, ledger: null, handoff: null };
      const loopRunId = (JSON.parse(handoffLines[0]!) as LoopRunHandoff).run_id;
      const documents = await io.readLoopDocuments(loopRunId);
      return { stdout, ...documents };
    },
    async observeFixture(record, slot) {
      const issueNumber = positiveIssue(slot.issue_number, `${slot.id} issue`);
      const advanceRunId = safeId(slot.advance_run_id, `${slot.id} advance run`);
      const candidatePolicy = await io.resolveCandidatePolicy(record.candidate.engine_root);
      if (candidatePolicy.repository !== record.repository || candidatePolicy.baseBranch !== record.base_branch ||
          candidatePolicy.implementer !== record.worker_config.implementer || candidatePolicy.reviewer !== record.worker_config.reviewer ||
          candidatePolicy.gatesSha256 !== record.worker_config.gates_sha256 ||
          candidatePolicy.reviewPolicyHashes.standard !== record.worker_config.review_standard_sha256 ||
          candidatePolicy.reviewPolicyHashes.lowRiskRound2 !== record.worker_config.review_low_risk_round2_sha256) {
        throw new ExactCandidateFrgGateDefect("current candidate policy no longer matches the recorded FRG binding");
      }
      const issue = await io.getIssue(input, issueNumber);
      if (issue.state !== "open") throw new ExactCandidateFrgGateDefect(`${slot.id} issue is not open`);
      const claims = parseExactCandidateFrgProvenance(issue.body);
      if (claims.length !== 1) throw new ExactCandidateFrgGateDefect(`${slot.id} issue has ${claims.length} exact provenance claims`);
      if (claims[0]!.epoch_id !== record.epoch_id || claims[0]!.candidate_sha !== record.candidate.sha ||
          claims[0]!.slot_id !== slot.id || claims[0]!.provenance_id !== slot.provenance_id) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} issue exact provenance does not match the recorded slot`);
      }
      const rendered = parseCandidateRenderedFrgProvenance(issue.body);
      const currentTemplate = await io.readFile(path.join(record.candidate.engine_root, slot.template.relative_path));
      if (!rendered || rendered.pack_id !== "factory-gate-v1" || rendered.manifest_version !== "1" ||
          rendered.pack_run_id !== record.epoch_id || rendered.release_version !== record.release_version ||
          rendered.template_id !== slot.id || rendered.template_sha256 !== slot.template.sha256 ||
          rendered.manifest_sha256 !== record.candidate.manifest.sha256 || currentTemplate === null ||
          issue.body !== templateBody(currentTemplate, record, slot)) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} issue candidate-rendered provenance does not match the recorded slot`);
      }
      const loopDocuments = await io.readLoopDocuments(safeId(record.loop_run_id, "recorded loop run"));
      if (!isDurableLoopRunHandoff(loopDocuments.handoff) || loopDocuments.handoff.run_id !== record.loop_run_id ||
          loopDocuments.handoff.candidate_sha !== record.candidate.sha) {
        throw new ExactCandidateFrgGateDefect("ordinary loop handoff does not bind the recorded exact candidate");
      }
      const currentLedger = object(loopDocuments.ledger, "ordinary loop ledger");
      if (currentLedger.run_id !== record.loop_run_id) throw new ExactCandidateFrgGateDefect("ordinary loop ledger crosses the recorded parent run");
      const loopItem = object(object(currentLedger.items, "ordinary loop ledger items")[String(issueNumber)], `ordinary loop ledger item ${issueNumber}`);
      if (loopItem.advance_run_id !== advanceRunId) throw new ExactCandidateFrgGateDefect("ordinary loop item crosses the recorded child run");
      const loopItemState = loopItem.state;
      if (typeof loopItemState !== "string") throw new ExactCandidateFrgGateDefect("ordinary loop item state is missing");
      const linked = await io.listPrsAnyState(input, issueNumber);
      if (linked.truncated || new Set(linked.numbers).size !== linked.numbers.length) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} issue linked PR inventory is incomplete or ambiguous`);
      }
      const prs = await io.listOpenPrs(input, issueNumber);
      if (prs.length === 0) {
        if (linked.numbers.length !== 0) {
          throw new ExactCandidateFrgGateDefect(`${slot.id} issue has a historical closed or merged PR`);
        }
        const ledger = object(loopDocuments.ledger, "ordinary loop ledger");
        const exhausted = currentWorkflowEngineExhaustion(ledger as never, String(issueNumber));
        const demonstrated = exhausted !== null && exhausted.advanceRunId === advanceRunId &&
          exhausted.prNumber === null;
        if (demonstrated) {
          throw new ExactCandidateFrgRegression(`${slot.id} demonstrated an exhausted candidate-engine defect before PR creation`, {
            source: "run_store", classification: "demonstrated_candidate_regression", issue_number: issueNumber,
            advance_run_id: advanceRunId, candidate_sha: record.candidate.sha, stage: exhausted.stage,
            pr_number: null, pr_head_sha: null,
          });
        }
        throw new Error(`${slot.id} ordinary loop has not created a PR${ledger.stop && typeof ledger.stop === "object" ? " and is stopped" : ""}`);
      }
      if (prs.length !== 1) throw new ExactCandidateFrgGateDefect(`${slot.id} issue must have exactly one current open PR; observed ${prs.length}`);
      if (!linked.numbers.includes(prs[0]!)) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} current PR does not match the complete linked PR inventory`);
      }
      for (const linkedPr of linked.numbers) {
        const detail = await io.getPr(input, linkedPr);
        if (detail.merged) throw new ExactCandidateFrgGateDefect(`${slot.id} fixture history contains merged PR ${linkedPr}`, {
          source: "forge", slot_id: slot.id, issue_number: issueNumber, pr_number: linkedPr,
          candidate_sha: record.candidate.sha, observed_head_sha: detail.head_sha,
          fact: `linked PR state=${detail.state}; merged=true`,
        });
        if (linkedPr !== prs[0] && detail.state === "open") {
          throw new ExactCandidateFrgGateDefect(`${slot.id} fixture history contains an unenumerated open PR ${linkedPr}`);
        }
      }
      const before = await io.getPr(input, prs[0]!);
      if (before.state !== "open" || before.merged || before.base_ref !== record.base_branch) throw new ExactCandidateFrgGateDefect(`${slot.id} PR is not open, unmerged, and based on ${record.base_branch}`);
      const checks = await io.getRequiredChecks(input, before.number);
      const prDiff = await io.getPrDiff(input, before.number);
      const paths = diffFilePaths(prDiff);
      const currentDiffHash = computeDiffHash(prDiff);
      const ingressClaims: string[] = [];
      let summary: ExactAdvanceSummary | null = null;
      try {
        const rawSummary = await io.readAdvanceSummary(input, advanceRunId);
        summary = rawSummary === null ? null : parseExactAdvanceSummary(rawSummary);
      } catch (error) {
        if (!(error instanceof ExactCandidateFrgGateDefect)) throw error;
        ingressClaims.push("ordinary-summary:malformed");
      }
      const testerRead = await io.readAdvanceTester(input, advanceRunId);
      if (testerRead.status === "malformed") {
        if (testerRead.reason.startsWith("unreadable:")) throw new Error(`Tester evidence observer unavailable: ${testerRead.reason}`);
        ingressClaims.push("tester-evidence:malformed");
      }
      const testerEvidence = testerRead.status === "ok" ? testerRead.evidence : null;
      let testerSourceValid = testerEvidence !== null;
      let testerEvidenceRunId = testerEvidence?.run_id ?? "unavailable";
      if (testerEvidence && testerEvidence.run_id !== advanceRunId) {
        let sourceRunId: string | null = null;
        try { sourceRunId = safeId(testerEvidence.run_id, "Tester source run_id"); }
        catch {
          testerSourceValid = false;
          testerEvidenceRunId = "unavailable";
        }
        const source = sourceRunId === null ? null : await io.readAdvanceTester(input, sourceRunId);
        if (source?.status === "malformed" && source.reason.startsWith("unreadable:")) {
          throw new Error(`Tester source evidence observer unavailable: ${source.reason}`);
        }
        testerSourceValid = sourceRunId !== null && sourceRunId.startsWith(`${issueNumber}-`) &&
          source !== null && source.status === "ok" &&
          testerEvidenceIsCanonicalRebind(source.evidence, testerEvidence);
        if (!testerSourceValid) ingressClaims.push("tester-evidence:source-run-mismatch");
      }
      const after = await io.getPr(input, before.number);
      if (after.head_sha !== before.head_sha || after.base_ref !== record.base_branch || after.state !== "open" || after.merged) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} PR identity moved during observation`);
      }
      if (summary && !evidenceSubjectMatches(summary.evidence_subject, {
        issue: issueNumber, pr: before.number, runId: summary.runId, head: before.head_sha, domain: candidatePolicy.domain,
      })) {
        ingressClaims.push("ordinary-summary:subject-mismatch");
      }
      if (summary && (summary.run_id !== advanceRunId || summary.issue !== issueNumber || summary.pr !== before.number)) {
        ingressClaims.push("ordinary-summary:run-identity-mismatch");
      }
      if (summary && (summary.roles?.implementer !== record.worker_config.implementer ||
          summary.roles.reviewer !== record.worker_config.reviewer ||
          summary.roles.implementerSource !== "repo-config" || summary.roles.reviewerSource !== "repo-config")) {
        ingressClaims.push("ordinary-summary:worker-role-mismatch");
      }
      let reviewAdvanceRunId = advanceRunId;
      let review = acceptedIndependentReview(summary, {
        issue: issueNumber, pr: before.number, fileRunId: advanceRunId, head: before.head_sha, domain: candidatePolicy.domain,
        implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer,
        diffHash: currentDiffHash, reviewPolicyHashes: candidatePolicy.reviewPolicyHashes,
      });
      if (review.verdict === "unavailable" && io.readCurrentReviewEvidence) {
        const priorReview = await io.readCurrentReviewEvidence(input, issueNumber, before.number, before.head_sha, currentDiffHash);
        if (priorReview) {
          reviewAdvanceRunId = priorReview.advanceRunId;
          const sourceSummary = parseExactAdvanceSummary(priorReview.summary);
          review = acceptedIndependentReview(sourceSummary, {
            issue: issueNumber, pr: before.number, fileRunId: reviewAdvanceRunId, head: priorReview.reviewedHeadSha, domain: candidatePolicy.domain,
            implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer,
            diffHash: priorReview.reviewedDiffHash, reviewPolicyHashes: candidatePolicy.reviewPolicyHashes,
            coverageHead: before.head_sha,
          });
          const sourcePin = parseEvidenceSubjectDetailed(sourceSummary.evidence_subject);
          const currentPin = parseEvidenceSubjectDetailed(summary?.evidence_subject);
          const familyCurrent = sourcePin.status === "ok" && currentPin.status === "ok" &&
            sourcePin.subject.engine_fingerprint === currentPin.subject.engine_fingerprint &&
            sourcePin.subject.verifier_fingerprint === currentPin.subject.verifier_fingerprint &&
            sourcePin.subject.required_evidence_set_revision === currentPin.subject.required_evidence_set_revision;
          if (!review.subjectValid || !familyCurrent) {
            review = { ...review, accepted: false, subjectValid: false };
            ingressClaims.push("review-evidence:source-summary-mismatch");
          }
        }
      }
      if (testerEvidence && testerEvidence.config_digest !== record.worker_config.gates_sha256) {
        ingressClaims.push("tester-evidence:config-mismatch");
      }
      if (testerEvidence && parseEvidenceSubjectDetailed(testerEvidence.evidence_subject).status !== "ok") {
        ingressClaims.push("tester-evidence:subject-mismatch");
      }
      const tester = passedTester(testerSourceValid ? testerEvidence : null, {
        issue: issueNumber, pr: before.number, runId: testerEvidenceRunId, head: before.head_sha, domain: candidatePolicy.domain,
        configDigest: record.worker_config.gates_sha256, readinessSubject: summary?.evidence_subject,
      });
      const ledger = object(loopDocuments.ledger, "ordinary loop ledger");
      const demonstrated = hasCurrentFailedEngineRecovery(
        ledger, issueNumber, before.number, before.head_sha, advanceRunId,
      );
      const buckets = checks.map((check) => check.bucket.toLowerCase());
      const checksConclusion = checks.length === 0 || buckets.some((bucket) => !["pass", "skipping"].includes(bucket))
        ? buckets.some((bucket) => ["fail", "cancel"].includes(bucket)) ? "failure" : "pending"
        : "success";
      return {
        observed_at: io.now().toISOString(),
        issue: {
          source: "forge", labels: issue.labels,
          provenance_epoch: claims[0]!.epoch_id, provenance_candidate_sha: claims[0]!.candidate_sha,
          provenance_template_id: claims[0]!.slot_id as ExactCandidateFrgSlotId,
          provenance_template_sha256: slot.template.sha256,
        },
        pr: { source: "forge", number: before.number, head_sha: before.head_sha, state: "open", merged: false },
        ordinary: {
          source: "run_store", advance_run_id: advanceRunId,
          loop_item_state: loopItemState,
          final_state: summary?.finalState ?? "unavailable",
          regression_proof: demonstrated ? {
            source: "run_store", advance_run_id: advanceRunId, candidate_sha: record.candidate.sha,
            fixture_pr_head_sha: before.head_sha, classification: "demonstrated_candidate_regression",
          } : null,
        },
        ci: { source: "ci", head_sha: before.head_sha, required: true, check_count: checks.length, conclusion: checksConclusion },
        review: {
          source: "review", head_sha: review.subjectValid ? before.head_sha : review.headSha, independent: review.accepted, advance_run_id: reviewAdvanceRunId,
          reviewed_head_sha: review.headSha,
          evidence_run_id: review.evidenceRunId, evidence_subject_valid: review.subjectValid, verdict: review.verdict,
        },
        tester: {
          source: "tester", head_sha: testerEvidence?.candidate_sha ?? "0".repeat(40), advance_run_id: advanceRunId,
          evidence_run_id: testerEvidenceRunId,
          config_digest: testerEvidence?.config_digest ?? "0".repeat(64), evidence_subject_valid: tester.subjectValid,
          conclusion: tester.passed ? "passed" : testerEvidence?.overall_status === "failed" ? "failed" : "unavailable",
        },
        unavailable_sources: ["pending", "in_progress", "cooling"].includes(loopItemState)
          ? [`ordinary-loop-item:${loopItemState}`] : [], changed_paths: paths, ingress_claims: ingressClaims,
      };
    },
    async reobserveFixtureIdentity(record, slot, options = { requireReady: true }) {
      const issueNumber = positiveIssue(slot.issue_number, `${slot.id} issue`);
      const issue = await io.getIssue(input, issueNumber);
      if (issue.state !== "open" || (options.requireReady &&
          (pipelineStageFromLabels(issue.labels) !== "ready-to-deploy" || isBlockedInLabels(issue.labels)))) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} issue is no longer open and ready-to-deploy`);
      }
      const claims = parseExactCandidateFrgProvenance(issue.body);
      const claim = claims.length === 1 ? claims[0]! : null;
      const rendered = parseCandidateRenderedFrgProvenance(issue.body);
      const currentTemplate = await io.readFile(path.join(record.candidate.engine_root, slot.template.relative_path));
      if (!claim || claim.epoch_id !== record.epoch_id || claim.candidate_sha !== record.candidate.sha ||
          claim.slot_id !== slot.id || claim.provenance_id !== slot.provenance_id ||
          !rendered || rendered.pack_id !== "factory-gate-v1" || rendered.manifest_version !== "1" ||
          rendered.pack_run_id !== record.epoch_id || rendered.release_version !== record.release_version ||
          rendered.template_id !== slot.id || rendered.template_sha256 !== slot.template.sha256 ||
          rendered.manifest_sha256 !== record.candidate.manifest.sha256 || currentTemplate === null ||
          issue.body !== templateBody(currentTemplate, record, slot)) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} issue provenance moved during pair observation`);
      }
      const linked = await io.listPrsAnyState(input, issueNumber);
      if (linked.truncated || new Set(linked.numbers).size !== linked.numbers.length || !linked.numbers.includes(slot.pr_number!)) {
        throw new ExactCandidateFrgGateDefect(`${slot.id} issue linked PR inventory moved during pair observation`);
      }
      const prs = await io.listOpenPrs(input, issueNumber);
      if (prs.length !== 1 || prs[0] !== slot.pr_number) throw new ExactCandidateFrgGateDefect(`${slot.id} issue no longer has exactly one open PR`);
      let pr: Awaited<ReturnType<ProductionExactCandidateFrgIo["getPr"]>> | null = null;
      for (const linkedPr of linked.numbers) {
        const detail = await io.getPr(input, linkedPr);
        if (detail.merged || (linkedPr !== slot.pr_number && detail.state === "open")) {
          throw new ExactCandidateFrgGateDefect(`${slot.id} issue linked PR inventory moved during pair observation`);
        }
        if (linkedPr === slot.pr_number) pr = detail;
      }
      if (pr === null) throw new ExactCandidateFrgGateDefect(`${slot.id} current PR disappeared during pair observation`);
      return {
        issue_number: issueNumber, issue_open: issue.state === "open", pr_number: pr.number,
        pr_head_sha: pr.head_sha, pr_open: pr.state === "open" && pr.base_ref === record.base_branch, merged: pr.merged,
      };
    },
    cleanup: async (record) => cleanupOwnedFailedSyntheticArtifacts(record, {
      now: () => io.now(),
      getIssue: (issueNumber) => io.getIssue(input, issueNumber),
      getPr: io.getPr ? (prNumber) => io.getPr(input, prNumber) : undefined,
      observeBranch: io.observeBranch,
      deleteBranch: io.deleteBranch,
      observeWorktree: io.observeWorktree,
      deleteOwnedWorktree: io.deleteOwnedWorktree,
    }),
    async validateOrdinaryLoop(record) {
      const loopRunId = safeId(record.loop_run_id, "recorded loop run");
      const documents = await io.readLoopDocuments(loopRunId);
      return validateExactCandidateFrgLoopDocuments(
        documents.contract, documents.ledger, documents.handoff, loopRunId,
        record.slots.map((slot) => positiveIssue(slot.issue_number, `${slot.id} issue`)),
        record.candidate.sha, record.repository, record.base_branch,
        true, record.loop_engine,
      );
    },
    async discoverOrdinaryLoop(record) {
      const issues = record.slots.map((slot) => String(positiveIssue(slot.issue_number, `${slot.id} issue`)));
      const runId = workListRunId(record.repository, record.loop_engine, issues);
      if (!io.loopRunExists || !await io.loopRunExists(runId)) return null;
      const documents = await io.readLoopDocuments(runId);
      const children = validateExactCandidateFrgLoopDocuments(
        documents.contract, documents.ledger, documents.handoff, runId, issues.map(Number), record.candidate.sha,
        record.repository, record.base_branch, true, record.loop_engine,
      );
      return { runId, children };
    },
    // Reattach the same canonical run; the ordinary supervisor alone owns its
    // lifecycle/schedulability decision and safely no-ops terminal runs.
    ordinaryLoopNeedsResume: async () => true,
  };
}

export interface ReleaseFrgExclusionLock {
  acquire(): boolean;
  release(): void;
}

/** Shared same-host release/FRG exclusion. It makes no cross-host claim. */
export async function withReleaseFrgExclusion<T>(
  domain: string,
  fn: () => Promise<T>,
  makeLock: (lockDomain: string) => ReleaseFrgExclusionLock = (lockDomain) => new PipelineLock({ domain: lockDomain }),
): Promise<T> {
  const lock = makeLock(`release-frg-${safeId(domain, "release/FRG domain")}`);
  if (!lock.acquire()) throw new Error(`same-host release/FRG exclusion is already held for ${domain}`);
  try { return await fn(); } finally { lock.release(); }
}

export async function runProductionExactCandidateFrg(
  input: BeginExactCandidateFrgInput,
  io: ProductionExactCandidateFrgIo = defaultProductionExactCandidateFrgIo(input),
): Promise<ExactCandidateFrgRecord> {
  const target = await io.validateTargetRuntime(input);
  if (target.repository !== input.repository) {
    throw new ExactCandidateFrgGateDefect(`target primary origin ${target.repository} does not match ${input.repository}`);
  }
  if (input.operationalDomain !== undefined && input.operationalDomain !== target.domain) {
    throw new ExactCandidateFrgGateDefect("explicit operational domain does not match the target runtime");
  }
  return withReleaseFrgExclusion(target.domain, async () => {
    const boundInput = { ...input, operationalDomain: target.domain };
    const releaseStoreRepoDir = await io.resolveReleaseStoreRepoDir(input.repoDir);
    if (!path.isAbsolute(releaseStoreRepoDir) || path.normalize(releaseStoreRepoDir) !== releaseStoreRepoDir) {
      throw new ExactCandidateFrgGateDefect("release store primary must be a normalized absolute path");
    }
    const deps = createProductionExactCandidateFrgDeps(boundInput, io, releaseStoreRepoDir);
    const loadRecords = async (): Promise<ExactCandidateFrgRecord[]> => {
      const releaseEpochPrefix = `frg-${input.releaseVersion}-`;
      const relevantEpochIds = (await io.listRecordEpochIds(releaseStoreRepoDir)).filter((id) => id.startsWith(releaseEpochPrefix));
      return (await Promise.all(relevantEpochIds.map((id) =>
        loadExactCandidateFrgRecord(releaseStoreRepoDir, id, { readFile: io.readFile })))).filter((record): record is ExactCandidateFrgRecord =>
        record !== null && record.repository === input.repository && record.release_version === input.releaseVersion);
    };
    let candidate: string;
    try { candidate = exactSha(await io.observeOriginMainSha(input.repoDir), "origin/main"); }
    catch (error) {
      const records = await loadRecords();
      if (records.some((record) => record.outcome === "passed")) {
        throw new Error(`origin/main observer unavailable while preserving durable pass: ${(error as Error).message}`);
      }
      const resumable = records.filter((record) => !["stale_candidate", "exact_candidate_regression", "gate_defect"].includes(record.outcome));
      if (resumable.length === 1) {
        return persistOutcome(resumable[0]!, deps, "external_or_transient_inconclusive", `origin/main observer unavailable: ${(error as Error).message}`,
          { probe: "git ls-remote origin refs/heads/main", wake_condition: "the exact remote main SHA is observable" });
      }
      throw error;
    }
    if (input.expectedCandidateSha !== undefined &&
        exactSha(input.expectedCandidateSha, "expected candidate") !== candidate) {
      throw new ExactCandidateFrgGateDefect(
        `origin/main moved before exact-candidate FRG admission: expected ${input.expectedCandidateSha}, observed ${candidate}`,
      );
    }
    const records = await loadRecords();
    for (const prior of records.filter((record) => record.candidate.sha !== candidate &&
      !["stale_candidate", "exact_candidate_regression", "gate_defect"].includes(record.outcome))) {
      await finalizeObservedOutcome(prior, deps, "stale_candidate", `origin/main moved from ${prior.candidate.sha} to ${candidate}`);
    }
    const existing = selectExactCandidateFrgExistingRecord(records, candidate);
    const epochId = existing ? existing.epoch_id : nextExactCandidateFrgEpochId(records, input.releaseVersion, candidate);
    return runExactCandidateFrg({ ...boundInput, epochId, expectedCandidateSha: candidate }, deps, existing ?? undefined);
  });
}

export interface DiscoveredExactCandidateFrgPair {
  epoch_id: string;
  slots: Record<ExactCandidateFrgSlotId, { issue_number: number; provenance_id: string }>;
}

/** Discover exactly one exact-pair from forge provenance. Never creates fixtures. */
export function discoverExactCandidateFrgPairIssues(
  issues: readonly { number: number; body: string; state: "open" | "closed" }[],
  candidateSha: string,
  releaseVersion: string,
): DiscoveredExactCandidateFrgPair {
  const candidate = exactSha(candidateSha, "tagged candidate");
  const owned: Array<{
    issue_number: number;
    epoch_id: string;
    slot_id: ExactCandidateFrgSlotId;
    provenance_id: string;
  }> = [];
  for (const issue of issues) {
    const claims = parseExactCandidateFrgProvenance(issue.body);
    if (claims.length !== 1) continue;
    const claim = claims[0]!;
    if (claim.candidate_sha !== candidate) continue;
    if (!(EXACT_CANDIDATE_FRG_SLOT_IDS as readonly string[]).includes(claim.slot_id)) continue;
    const rendered = parseCandidateRenderedFrgProvenance(issue.body);
    if (rendered?.release_version && rendered.release_version !== releaseVersion) continue;
    owned.push({
      issue_number: issue.number,
      epoch_id: claim.epoch_id,
      slot_id: claim.slot_id as ExactCandidateFrgSlotId,
      provenance_id: claim.provenance_id,
    });
  }
  const epochs = [...new Set(owned.map((row) => row.epoch_id))];
  if (epochs.length !== 1) {
    throw new ExactCandidateFrgGateDefect(
      `expected exactly one exact-pair epoch for candidate ${candidate}; observed ${epochs.length}`,
    );
  }
  const epoch_id = epochs[0]!;
  const slots = {} as DiscoveredExactCandidateFrgPair["slots"];
  for (const slotId of EXACT_CANDIDATE_FRG_SLOT_IDS) {
    const matches = owned.filter((row) => row.epoch_id === epoch_id && row.slot_id === slotId);
    if (matches.length !== 1) {
      throw new ExactCandidateFrgGateDefect(
        `expected exactly one ${slotId} fixture for epoch ${epoch_id}; observed ${matches.length}`,
      );
    }
    slots[slotId] = { issue_number: matches[0]!.issue_number, provenance_id: matches[0]!.provenance_id };
  }
  const issueNumbers = EXACT_CANDIDATE_FRG_SLOT_IDS.map((id) => slots[id].issue_number);
  if (new Set(issueNumbers).size !== 2) {
    throw new ExactCandidateFrgGateDefect("one issue claims both exact-pair slots");
  }
  return { epoch_id, slots };
}

/**
 * Bind a tagged exact pair from the candidate engine at C plus forge identity.
 * Does not persist a checkpoint or create fixtures. Loop/advance IDs come from
 * the canonical ordinary-loop observation, not from a local FRG record.
 */
async function reconstructTaggedExactCandidateFrgRecord(
  input: BeginExactCandidateFrgInput,
  candidateSha: string,
  discovered: DiscoveredExactCandidateFrgPair,
  deps: ExactCandidateFrgDeps,
): Promise<ExactCandidateFrgRecord> {
  const candidate = exactSha(candidateSha, "tagged candidate");
  const prepared = await (deps.resolveAndPrepareCandidate
    ? deps.resolveAndPrepareCandidate(input, candidate)
    : productionResolveCandidate(input, candidate, deps.resolveAndPrepareDeps));
  if (!prepared.ok) {
    throw new ExactCandidateFrgGateDefect(`tagged retry cannot prepare candidate ${candidate}: ${prepared.error}`);
  }
  const root = path.resolve(prepared.engine.engineRoot);
  if (prepared.engine.commitSha !== candidate || !contained(root, prepared.engine.launcherPath)) {
    throw new ExactCandidateFrgGateDefect("prepared engine does not match the tagged candidate");
  }
  if (!deps.resolveCandidatePolicy) throw new ExactCandidateFrgGateDefect("candidate policy resolver is required");
  const candidatePolicy = await deps.resolveCandidatePolicy(root);
  if (candidatePolicy.repository !== input.repository || candidatePolicy.baseBranch !== input.baseBranch) {
    throw new ExactCandidateFrgGateDefect("candidate repository or base policy does not match the FRG target");
  }
  const manifestPath = path.join(root, MANIFEST_REL);
  const lockfilePath = path.join(root, LOCKFILE_REL);
  if (!contained(root, manifestPath) || !contained(root, lockfilePath)) {
    throw new ExactCandidateFrgGateDefect("candidate inputs escape prepared root");
  }
  const manifestText = await deps.readCandidateFile(manifestPath);
  const lockfile = await deps.readCandidateFile(lockfilePath);
  let manifest: {
    schema_version?: unknown; pack_id?: unknown; manifest_version?: unknown;
    templates?: Array<{ id?: unknown; file?: unknown; sha256?: unknown; title?: unknown }>;
  };
  try { manifest = JSON.parse(String(manifestText)); }
  catch { throw new ExactCandidateFrgGateDefect("candidate FRG manifest is not valid JSON"); }
  if (manifest.schema_version !== 1 || manifest.pack_id !== "factory-gate-v1" || manifest.manifest_version !== 1 ||
      !Array.isArray(manifest.templates) || manifest.templates.length !== 2 ||
      manifest.templates[0]?.id !== "clean-docs" || manifest.templates[1]?.id !== "clean-openspec") {
    throw new ExactCandidateFrgGateDefect("candidate FRG manifest identity must be factory-gate-v1@1 with exactly clean-docs and clean-openspec");
  }
  const createdAt = iso(deps.now());
  const epochId = discovered.epoch_id;
  safeId(epochId, "exact candidate epoch");
  const manifestIdentity = { relative_path: MANIFEST_REL, sha256: digest(manifestText) };
  const slots = [] as unknown as [ExactCandidateFrgSlot, ExactCandidateFrgSlot];
  for (const [index, id] of EXACT_CANDIDATE_FRG_SLOT_IDS.entries()) {
    const ref = manifest.templates[index]!;
    if (typeof ref.file !== "string" || typeof ref.sha256 !== "string" || !DIGEST_RE.test(ref.sha256) ||
        typeof ref.title !== "string" || ref.title.trim() === "") {
      throw new ExactCandidateFrgGateDefect(`candidate template ${id} manifest entry is malformed`);
    }
    relativeCandidatePath(ref.file, `candidate template ${id} file`);
    const packRoot = path.join(root, PACK_ROOT_REL);
    const absoluteTemplate = path.resolve(packRoot, ref.file);
    if (!contained(packRoot, absoluteTemplate)) {
      throw new ExactCandidateFrgGateDefect(`candidate template ${id} escapes the candidate pack`);
    }
    const rel = path.relative(root, absoluteTemplate);
    const body = await deps.readCandidateFile(absoluteTemplate);
    if (digest(body) !== ref.sha256) {
      throw new ExactCandidateFrgGateDefect(`candidate template ${id} hash mismatch`);
    }
    const found = discovered.slots[id];
    slots[index] = {
      id, epoch_id: epochId, candidate_sha: candidate,
      template: { relative_path: rel, sha256: ref.sha256 },
      title_template: ref.title,
      provenance_id: found.provenance_id,
      issue_number: found.issue_number, create_certainty: "known_complete", advance_run_id: null,
      pr_number: null, pr_head_sha: null, observation: null, failure_evidence: null,
    };
  }
  const record: ExactCandidateFrgRecord = {
    schema: EXACT_CANDIDATE_FRG_SCHEMA,
    epoch_id: epochId,
    repository: input.repository,
    operational_domain: input.operationalDomain ?? input.repository,
    base_branch: input.baseBranch,
    release_version: input.releaseVersion,
    loop_engine: input.loopEngine ?? "claude",
    candidate: {
      sha: candidate, engine_root: root, launcher_path: prepared.engine.launcherPath,
      manifest: manifestIdentity,
      lockfile: { relative_path: LOCKFILE_REL, sha256: digest(lockfile) },
    },
    loop_run_id: null,
    loop_dispatch_certainty: "uncertain",
    slots,
    worker_config: {
      implementer: candidatePolicy.implementer,
      reviewer: candidatePolicy.reviewer,
      gates_sha256: candidatePolicy.gatesSha256,
      review_standard_sha256: candidatePolicy.reviewPolicyHashes.standard,
      review_low_risk_round2_sha256: candidatePolicy.reviewPolicyHashes.lowRiskRound2,
      auto_file_repairs: false,
    },
    outcome: "pending", outcome_detail: "reconstructing tagged exact pair from authoritative sources",
    external_wait: null, cleanup: [], cleanup_debt: false,
    created_at: createdAt, updated_at: createdAt,
  };
  parseExactCandidateFrgRecord(record);
  if (!deps.discoverOrdinaryLoop) {
    throw new ExactCandidateFrgGateDefect(
      `tagged retry discovered exact-pair ${epochId} for ${candidate} but cannot reconstruct loop/advance identity from authoritative observations; refusing to create a replacement pair`,
    );
  }
  const loop = await deps.discoverOrdinaryLoop(record);
  if (!loop || loop.children.some((child) => child === null)) {
    throw new ExactCandidateFrgGateDefect(
      `tagged retry discovered exact-pair ${epochId} for ${candidate} but cannot reconstruct loop/advance identity from authoritative observations; refusing to create a replacement pair`,
    );
  }
  record.loop_run_id = loop.runId;
  record.loop_dispatch_certainty = "known_complete";
  for (const [index, slot] of record.slots.entries()) slot.advance_run_id = loop.children[index]!;
  parseExactCandidateFrgRecord(record);
  return record;
}

/**
 * Read-only reconstruction used when an immutable release tag already exists.
 * Forge provenance is the pair identity. A local FRG record may bind loop/advance
 * IDs but never proves pass. Missing, ambiguous, or unverifiable evidence fails
 * closed and never creates a replacement pair.
 */
export async function observeProductionExactCandidateFrgPass(
  input: BeginExactCandidateFrgInput,
  candidateSha: string,
  io: ProductionExactCandidateFrgIo = defaultProductionExactCandidateFrgIo(input),
): Promise<ExactCandidateFrgRecord> {
  const candidate = exactSha(candidateSha, "tagged candidate");
  const target = await io.validateTargetRuntime(input);
  if (target.repository !== input.repository) {
    throw new ExactCandidateFrgGateDefect(`target primary origin ${target.repository} does not match ${input.repository}`);
  }
  if (input.operationalDomain !== undefined && input.operationalDomain !== target.domain) {
    throw new ExactCandidateFrgGateDefect("explicit operational domain does not match the target runtime");
  }
  const releaseStoreRepoDir = await io.resolveReleaseStoreRepoDir(input.repoDir);
  if (!path.isAbsolute(releaseStoreRepoDir) || path.normalize(releaseStoreRepoDir) !== releaseStoreRepoDir) {
    throw new ExactCandidateFrgGateDefect("release store primary must be a normalized absolute path");
  }
  const discovered = discoverExactCandidateFrgPairIssues(
    await io.listIssues(input.repository),
    candidate,
    input.releaseVersion,
  );
  const prefix = `frg-${input.releaseVersion}-`;
  const ids = (await io.listRecordEpochIds(releaseStoreRepoDir)).filter((id) => id.startsWith(prefix));
  const records = (await Promise.all(ids.map((id) =>
    loadExactCandidateFrgRecord(releaseStoreRepoDir, id, { readFile: io.readFile })))).filter(
      (record): record is ExactCandidateFrgRecord => record !== null && record.repository === input.repository &&
        record.release_version === input.releaseVersion && record.candidate.sha === candidate &&
        record.epoch_id === discovered.epoch_id && record.outcome !== "stale_candidate",
    );
  if (records.length > 1) {
    throw new ExactCandidateFrgGateDefect(
      `multiple local exact-pair records claim epoch ${discovered.epoch_id} for ${candidate}`,
    );
  }
  const bound = records[0] ?? null;
  if (bound) {
    for (const slot of bound.slots) {
      const found = discovered.slots[slot.id];
      if (slot.issue_number !== found.issue_number || slot.provenance_id !== found.provenance_id) {
        throw new ExactCandidateFrgGateDefect(
          `${slot.id} local identity contradicts authoritative forge pair ${discovered.epoch_id}`,
        );
      }
    }
  }
  const guardedIo: ProductionExactCandidateFrgIo = {
    ...io,
    createIssue: async () => {
      throw new ExactCandidateFrgGateDefect("tagged retry must not create a replacement exact-pair fixture");
    },
    writeRecord: async () => undefined,
  };
  const deps = createProductionExactCandidateFrgDeps(
    { ...input, operationalDomain: target.domain },
    guardedIo,
    releaseStoreRepoDir,
  );
  const reconstructed = bound
    ? cloneRecord(bound)
    : await reconstructTaggedExactCandidateFrgRecord(
      { ...input, operationalDomain: target.domain, expectedCandidateSha: candidate },
      candidate,
      discovered,
      deps,
    );
  reconstructed.outcome = "pending";
  reconstructed.outcome_detail = "re-observing tagged exact pair from authoritative sources";
  for (const slot of reconstructed.slots) {
    slot.observation = null;
    slot.failure_evidence = null;
    const obs = await deps.observeFixture(reconstructed, slot);
    slot.observation = obs;
    slot.pr_number = obs.pr.number;
    slot.pr_head_sha = obs.pr.head_sha;
    const identity = await deps.reobserveFixtureIdentity(reconstructed, slot, { requireReady: true });
    if (identity.issue_number !== slot.issue_number || !identity.issue_open || identity.pr_number !== obs.pr.number ||
        identity.pr_head_sha !== obs.pr.head_sha || !identity.pr_open || identity.merged) {
      throw new ExactCandidateFrgGateDefect(`${slot.id} issue or PR identity moved during tagged reconstruction`);
    }
    if (!observationPasses(reconstructed, slot, obs)) {
      throw new ExactCandidateFrgGateDefect(`${slot.id} lacks authoritative current-head completion proof`);
    }
  }
  reconstructed.outcome = "passed";
  reconstructed.outcome_detail = "reconstructed tagged exact-pair pass from forge, CI, review, and Tester";
  reconstructed.updated_at = iso(io.now());
  return verifyExactCandidateFrgResult(reconstructed, { epoch_id: reconstructed.epoch_id, candidate_sha: candidate });
}

export function nextExactCandidateFrgEpochId(
  records: readonly ExactCandidateFrgRecord[], releaseVersion: string, candidate: string,
): string {
  const base = `frg-${releaseVersion}-${exactSha(candidate, "current candidate").slice(0, 12)}`;
  const staleCount = records.filter((record) => record.candidate.sha === candidate && record.outcome === "stale_candidate").length;
  return staleCount === 0 ? base : `${base}-r${staleCount + 1}`;
}

export function selectExactCandidateFrgExistingRecord(
  records: readonly ExactCandidateFrgRecord[],
  candidate: string,
): ExactCandidateFrgRecord | null {
  exactSha(candidate, "current candidate");
  const current = records.filter((record) => parseExactCandidateFrgRecord(record).candidate.sha === candidate);
  const live = current.filter((record) => record.outcome !== "stale_candidate");
  if (live.length > 1) {
    throw new ExactCandidateFrgGateDefect(`multiple release-owned records claim current candidate ${candidate}`);
  }
  return live[0] ?? null;
}
