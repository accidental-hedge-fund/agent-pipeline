// Release-owned exact-candidate Final Regression Gate (#1558).
//
// This module composes the shared candidate resolve-and-prepare boundary with
// the ordinary `pipeline loop <issue> <issue>` surface. It deliberately owns
// no scheduler, merge path, recovery controller, score, or attestation.

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { CandidateEngine } from "./ship-end-candidate.ts";
import {
  resolveAndPrepareCandidateEngine,
  runCandidateEngineProcess,
  type CandidateEngineProcessResult,
  type ResolveAndPrepareCandidateEngineDeps,
} from "./ship-end-candidate.ts";
import { PIPELINE_SUPPRESS_AUTO_FILE_ENV } from "./stages/papercut.ts";

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
  ci: { source: "ci"; head_sha: string; required: boolean; conclusion: "success" | "failure" | "pending" };
  review: {
    source: "review";
    head_sha: string;
    independent: boolean;
    verdict: "accepted" | "changes_requested" | "unavailable";
  };
  tester: {
    source: "tester";
    head_sha: string;
    worker_config_sha256: string;
    conclusion: "passed" | "failed" | "unavailable";
  };
  unavailable_sources: string[];
  ingress_claims?: string[];
}

export interface ExactCandidateFrgSlot {
  id: ExactCandidateFrgSlotId;
  epoch_id: string;
  candidate_sha: string;
  template: ExactCandidateInputIdentity;
  provenance_id: string;
  issue_number: number | null;
  create_certainty: SideEffectCertainty;
  ordinary_run_id: string | null;
  pr_number: number | null;
  pr_head_sha: string | null;
  observation: ExactCandidateFrgObservation | null;
}

export interface ExactCandidateFrgCleanupFact {
  target: string;
  status: "cleaned" | "debt";
  detail: string;
  observed_at: string;
}

export interface ExactCandidateFrgRecord {
  schema: typeof EXACT_CANDIDATE_FRG_SCHEMA;
  epoch_id: string;
  repository: string;
  base_branch: string;
  release_version: string;
  candidate: {
    sha: string;
    engine_root: string;
    launcher_path: string;
    manifest: ExactCandidateInputIdentity;
    lockfile: ExactCandidateInputIdentity;
  };
  slots: [ExactCandidateFrgSlot, ExactCandidateFrgSlot];
  worker_config: {
    implementer: string;
    reviewer: string;
    gates_sha256: string;
    auto_file_repairs: false;
  };
  outcome: ExactCandidateFrgOutcome;
  outcome_detail: string;
  external_wait: { probe: string; wake_condition: string } | null;
  cleanup: ExactCandidateFrgCleanupFact[];
  cleanup_debt: boolean;
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
  }): Promise<{ run_id: string }>;
  observeFixture(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): Promise<ExactCandidateFrgObservation>;
  cleanup?(record: ExactCandidateFrgRecord): Promise<ExactCandidateFrgCleanupFact[]>;
}

export interface BeginExactCandidateFrgInput {
  repoDir: string;
  repository: string;
  baseBranch: string;
  releaseVersion: string;
  implementer: string;
  reviewer: string;
  gatesSha256: string;
  candidateEngineRootEnv?: string | null;
}

export interface ExactCandidateFrgRecordStoreDeps {
  mkdir(directory: string): Promise<void>;
  writeFile(file: string, body: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
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
  await deps.rename(temporary, destination);
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

function templateBody(template: string, record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot): string {
  return template
    .replaceAll("{{release_version}}", record.release_version)
    .replaceAll("{{pack_run_id}}", record.epoch_id)
    .replaceAll("{{pack_id}}", "factory-gate-v1")
    .replaceAll("{{manifest_version}}", "1")
    .replaceAll("{{manifest_sha256}}", record.candidate.manifest.sha256)
    .replaceAll("{{template_id}}", slot.id)
    .replaceAll("{{template_sha256}}", slot.template.sha256) +
    `\n<!-- pipeline-exact-frg:v1 epoch=${record.epoch_id} candidate=${record.candidate.sha} slot=${slot.id} provenance=${slot.provenance_id} -->\n`;
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
  if (slot.issue_number !== null) positiveIssue(slot.issue_number, `slot ${expected}.issue_number`);
  if (!["known_absent", "known_complete", "uncertain"].includes(slot.create_certainty)) {
    throw new Error(`slot ${expected}.create_certainty is malformed`);
  }
  if (slot.ordinary_run_id !== null) safeId(slot.ordinary_run_id, `slot ${expected}.ordinary_run_id`);
  if (slot.pr_number !== null) positiveIssue(slot.pr_number, `slot ${expected}.pr_number`);
  if (slot.pr_head_sha !== null) exactSha(slot.pr_head_sha, `slot ${expected}.pr_head_sha`);
  if (slot.observation !== null) {
    const observation = slot.observation;
    iso(new Date(observation.observed_at));
    if (observation.issue?.source !== "forge" || !Array.isArray(observation.issue.labels) ||
        typeof observation.issue.provenance_epoch !== "string" ||
        !EXACT_CANDIDATE_FRG_SLOT_IDS.includes(observation.issue.provenance_template_id) ||
        !DIGEST_RE.test(observation.issue.provenance_template_sha256)) {
      throw new Error(`slot ${expected}.observation issue provenance is malformed`);
    }
    exactSha(observation.issue.provenance_candidate_sha, `slot ${expected}.observation.issue.provenance_candidate_sha`);
    if (observation.pr?.source !== "forge" || !["open", "closed"].includes(observation.pr.state) ||
        typeof observation.pr.merged !== "boolean") throw new Error(`slot ${expected}.observation PR is malformed`);
    positiveIssue(observation.pr.number, `slot ${expected}.observation.pr.number`);
    exactSha(observation.pr.head_sha, `slot ${expected}.observation.pr.head_sha`);
    for (const [name, evidence] of [["ci", observation.ci], ["review", observation.review], ["tester", observation.tester]] as const) {
      if (!evidence || typeof evidence !== "object") throw new Error(`slot ${expected}.observation.${name} is malformed`);
      exactSha(evidence.head_sha, `slot ${expected}.observation.${name}.head_sha`);
    }
    if (observation.ci.source !== "ci" || typeof observation.ci.required !== "boolean" ||
        !["success", "failure", "pending"].includes(observation.ci.conclusion) ||
        observation.review.source !== "review" || typeof observation.review.independent !== "boolean" ||
        !["accepted", "changes_requested", "unavailable"].includes(observation.review.verdict) ||
        observation.tester.source !== "tester" || !DIGEST_RE.test(observation.tester.worker_config_sha256) ||
        !["passed", "failed", "unavailable"].includes(observation.tester.conclusion) ||
        !Array.isArray(observation.unavailable_sources)) throw new Error(`slot ${expected}.observation evidence is malformed`);
    if (slot.pr_number !== observation.pr.number || slot.pr_head_sha !== observation.pr.head_sha) {
      throw new Error(`slot ${expected}.observation does not match its recorded PR identity`);
    }
  }
  return slot;
}

export function parseExactCandidateFrgRecord(value: unknown): ExactCandidateFrgRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("exact-candidate FRG result must be an object");
  const record = value as ExactCandidateFrgRecord;
  if (record.schema !== EXACT_CANDIDATE_FRG_SCHEMA) throw new Error(`exact-candidate FRG schema must be ${EXACT_CANDIDATE_FRG_SCHEMA}`);
  safeId(record.epoch_id, "epoch_id");
  nonEmpty(record.repository, "repository");
  nonEmpty(record.base_branch, "base_branch");
  nonEmpty(record.release_version, "release_version");
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
  const filledIssues = record.slots.flatMap((slot) => slot.issue_number === null ? [] : [slot.issue_number]);
  if (new Set(filledIssues).size !== filledIssues.length || record.slots[0].provenance_id === record.slots[1].provenance_id) {
    throw new Error("FRG slot identities must be distinct");
  }
  if (!record.worker_config || !record.worker_config.implementer || !record.worker_config.reviewer ||
      !DIGEST_RE.test(record.worker_config.gates_sha256) || record.worker_config.auto_file_repairs !== false) {
    throw new Error("worker_config is malformed or repair auto-filing is enabled");
  }
  if (!["pending", "passed", "stale_candidate", ...EXACT_CANDIDATE_FRG_NON_PASS].includes(record.outcome)) {
    throw new Error("FRG outcome is malformed");
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
    iso(new Date(fact.observed_at));
  }
  if (record.cleanup_debt !== record.cleanup.some((fact) => fact.status === "debt")) throw new Error("cleanup debt does not match cleanup facts");
  nonEmpty(record.outcome_detail, "outcome_detail");
  iso(new Date(record.created_at));
  iso(new Date(record.updated_at));
  return record;
}

export async function beginExactCandidateFrg(
  input: BeginExactCandidateFrgInput,
  deps: ExactCandidateFrgDeps,
): Promise<{ record: ExactCandidateFrgRecord; engine: CandidateEngine }> {
  const observed = exactSha(await deps.observeOriginMainSha(input.repoDir), "origin/main");
  const prepared = await (deps.resolveAndPrepareCandidate
    ? deps.resolveAndPrepareCandidate(input, observed)
    : productionResolveCandidate(input, observed, deps.resolveAndPrepareDeps));
  if (!prepared.ok) throw new Error(`exact-candidate FRG prepare failed: ${prepared.error}`);
  const root = path.resolve(prepared.engine.engineRoot);
  if (prepared.engine.commitSha !== observed || !contained(root, prepared.engine.launcherPath)) {
    throw new Error("prepared engine does not match the selected origin/main candidate");
  }
  const manifestPath = path.join(root, MANIFEST_REL);
  const lockfilePath = path.join(root, LOCKFILE_REL);
  if (!contained(root, manifestPath) || !contained(root, lockfilePath)) throw new Error("candidate inputs escape prepared root");
  const manifestText = await deps.readCandidateFile(manifestPath);
  const lockfile = await deps.readCandidateFile(lockfilePath);
  let manifest: { templates?: Array<{ id?: unknown; file?: unknown; sha256?: unknown; title?: unknown }> };
  try { manifest = JSON.parse(String(manifestText)); } catch { throw new Error("candidate FRG manifest is not valid JSON"); }
  if (!Array.isArray(manifest.templates) || manifest.templates.length !== 2 ||
      manifest.templates[0]?.id !== "clean-docs" || manifest.templates[1]?.id !== "clean-openspec") {
    throw new Error("candidate FRG manifest must contain exactly clean-docs and clean-openspec");
  }
  const createdAt = iso(deps.now());
  const epochId = `frg-${input.releaseVersion}-${observed.slice(0, 12)}`;
  const manifestIdentity = { relative_path: MANIFEST_REL, sha256: digest(manifestText) };
  const slots = [] as unknown as [ExactCandidateFrgSlot, ExactCandidateFrgSlot];
  for (const [index, id] of EXACT_CANDIDATE_FRG_SLOT_IDS.entries()) {
    const ref = manifest.templates[index]!;
    if (typeof ref.file !== "string" || typeof ref.sha256 !== "string" || !DIGEST_RE.test(ref.sha256)) throw new Error(`candidate template ${id} manifest entry is malformed`);
    const rel = path.join(PACK_ROOT_REL, ref.file);
    const body = await deps.readCandidateFile(path.join(root, rel));
    if (digest(body) !== ref.sha256) throw new Error(`candidate template ${id} hash mismatch`);
    slots[index] = {
      id, epoch_id: epochId, candidate_sha: observed,
      template: { relative_path: rel, sha256: ref.sha256 },
      provenance_id: digest(`${epochId}\0${id}\0${ref.sha256}`),
      issue_number: null, create_certainty: "known_absent", ordinary_run_id: null,
      pr_number: null, pr_head_sha: null, observation: null,
    };
  }
  const record: ExactCandidateFrgRecord = {
    schema: EXACT_CANDIDATE_FRG_SCHEMA,
    epoch_id: epochId,
    repository: input.repository,
    base_branch: input.baseBranch,
    release_version: input.releaseVersion,
    candidate: {
      sha: observed, engine_root: root, launcher_path: prepared.engine.launcherPath,
      manifest: manifestIdentity,
      lockfile: { relative_path: LOCKFILE_REL, sha256: digest(lockfile) },
    },
    slots,
    worker_config: {
      implementer: input.implementer,
      reviewer: input.reviewer,
      gates_sha256: input.gatesSha256,
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

export async function reconcileExactCandidateFrgPair(
  source: ExactCandidateFrgRecord,
  deps: ExactCandidateFrgDeps,
): Promise<ExactCandidateFrgRecord> {
  const record = cloneRecord(parseExactCandidateFrgRecord(source));
  let matches: RemoteFixtureMatch[] = [];
  for (const slot of record.slots) {
    // Re-observe the entire epoch immediately before every possible create.
    matches = await deps.listFixtureMatches(record);
    const foreign = matches.filter((match) => match.epoch_id === record.epoch_id &&
      (!EXACT_CANDIDATE_FRG_SLOT_IDS.includes(match.slot_id as ExactCandidateFrgSlotId) || match.candidate_sha !== record.candidate.sha));
    if (foreign.length > 0) return persistOutcome(record, deps, "gate_defect", "foreign issue claims exact-pair epoch");
    const candidates = matchesForSlot(matches, record, slot);
    if (candidates.length > 1) return persistOutcome(record, deps, "gate_defect", `duplicate ${slot.id} fixture matches`);
    if (candidates.length === 1) {
      const issue = positiveIssue(candidates[0]!.issue_number, `${slot.id} issue`);
      if (slot.issue_number !== null && slot.issue_number !== issue) return persistOutcome(record, deps, "gate_defect", `${slot.id} fixture identity changed`);
      slot.issue_number = issue;
      slot.create_certainty = "known_complete";
      record.updated_at = iso(deps.now());
      await deps.persist(record);
      continue;
    }
    if (slot.issue_number !== null) return persistOutcome(record, deps, "gate_defect", `${slot.id} recorded issue is absent from authoritative reconciliation`);
    if (slot.create_certainty === "uncertain") {
      slot.create_certainty = "known_absent";
      record.updated_at = iso(deps.now());
      await deps.persist(record);
    }
    const template = String(await deps.readCandidateFile(path.join(record.candidate.engine_root, slot.template.relative_path)));
    const body = templateBody(template, record, slot);
    const title = `test(frg): ${record.release_version} ${record.epoch_id} ${slot.id}`;
    try {
      slot.issue_number = positiveIssue(await deps.createFixture({ record, slot, title, body }), `${slot.id} create result`);
      slot.create_certainty = "known_complete";
      record.updated_at = iso(deps.now());
      await deps.persist(record);
    } catch (error) {
      slot.create_certainty = "uncertain";
      record.updated_at = iso(deps.now());
      await deps.persist(record);
      matches = await deps.listFixtureMatches(record);
      const foreign = matches.filter((match) => match.epoch_id === record.epoch_id &&
        (!EXACT_CANDIDATE_FRG_SLOT_IDS.includes(match.slot_id as ExactCandidateFrgSlotId) || match.candidate_sha !== record.candidate.sha));
      if (foreign.length > 0) return persistOutcome(record, deps, "gate_defect", "foreign issue claims exact-pair epoch");
      const recovered = matchesForSlot(matches, record, slot);
      if (recovered.length > 1) return persistOutcome(record, deps, "gate_defect", `ambiguous ${slot.id} create response`);
      if (recovered.length === 1) {
        slot.issue_number = positiveIssue(recovered[0]!.issue_number, `${slot.id} recovered issue`);
        slot.create_certainty = "known_complete";
        record.updated_at = iso(deps.now());
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
  return ["loop", String(issues[0]), String(issues[1]), "--engine-track", "candidate"];
}

export async function dispatchExactCandidateFrgPair(
  source: ExactCandidateFrgRecord,
  engine: CandidateEngine,
  deps: ExactCandidateFrgDeps,
): Promise<ExactCandidateFrgRecord> {
  const record = cloneRecord(parseExactCandidateFrgRecord(source));
  if (engine.commitSha !== record.candidate.sha || path.resolve(engine.engineRoot) !== path.resolve(record.candidate.engine_root) ||
      path.resolve(engine.launcherPath) !== path.resolve(record.candidate.launcher_path)) throw new Error("prepared engine does not match FRG candidate binding");
  const argv = exactCandidateFrgLoopArgv(record);
  const start = async (bound: CandidateEngine, env: NodeJS.ProcessEnv) =>
    deps.dispatchOrdinaryLoop({ engine: bound, argv, env: { ...env, [PIPELINE_SUPPRESS_AUTO_FILE_ENV]: "1" } });
  const started: CandidateEngineProcessResult<{ run_id: string }> = deps.runCandidateProcess
    ? await deps.runCandidateProcess(engine, start)
    : await productionRunCandidate(engine, start);
  if (!started.ok) throw new Error(`exact-candidate FRG loop start failed: ${started.error}`);
  const runId = safeId(started.value.run_id, "ordinary loop run id");
  for (const slot of record.slots) slot.ordinary_run_id = runId;
  record.updated_at = iso(deps.now());
  await deps.persist(record);
  return record;
}

function observationPasses(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgSlot, obs: ExactCandidateFrgObservation): boolean {
  const head = obs.pr.head_sha;
  return obs.unavailable_sources.length === 0 &&
    obs.issue.source === "forge" && obs.issue.labels.includes("pipeline:ready-to-deploy") &&
    obs.issue.provenance_epoch === record.epoch_id && obs.issue.provenance_candidate_sha === record.candidate.sha &&
    obs.issue.provenance_template_id === slot.id && obs.issue.provenance_template_sha256 === slot.template.sha256 &&
    obs.pr.source === "forge" && obs.pr.state === "open" && !obs.pr.merged &&
    obs.ci.source === "ci" && obs.ci.required && obs.ci.head_sha === head && obs.ci.conclusion === "success" &&
    obs.review.source === "review" && obs.review.independent && obs.review.head_sha === head && obs.review.verdict === "accepted" &&
    obs.tester.source === "tester" && obs.tester.head_sha === head && obs.tester.conclusion === "passed" &&
    obs.tester.worker_config_sha256 === record.worker_config.gates_sha256;
}

export function classifyExactCandidateFrgObservation(
  record: ExactCandidateFrgRecord,
  slot: ExactCandidateFrgSlot,
  obs: ExactCandidateFrgObservation,
): ExactCandidateFrgOutcome {
  if (observationPasses(record, slot, obs)) return "passed";
  if (obs.unavailable_sources.length > 0 || obs.ci.conclusion === "pending" || obs.review.verdict === "unavailable" || obs.tester.conclusion === "unavailable") {
    return "external_or_transient_inconclusive";
  }
  if (obs.review.verdict === "changes_requested" && obs.review.head_sha === obs.pr.head_sha) return "ordinary_review_revision";
  if ((obs.ci.conclusion === "failure" && obs.ci.head_sha === obs.pr.head_sha) ||
      (obs.tester.conclusion === "failed" && obs.tester.head_sha === obs.pr.head_sha)) return "exact_candidate_regression";
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
  await deps.persist(record);
  return record;
}

export async function observeExactCandidateFrgPair(source: ExactCandidateFrgRecord, deps: ExactCandidateFrgDeps): Promise<ExactCandidateFrgRecord> {
  const record = cloneRecord(parseExactCandidateFrgRecord(source));
  const current = exactSha(await deps.observeOriginMainSha(record.candidate.engine_root), "current origin/main");
  if (current !== record.candidate.sha) return persistOutcome(record, deps, "stale_candidate", `origin/main moved from ${record.candidate.sha} to ${current}`);
  const classifications: ExactCandidateFrgOutcome[] = [];
  for (const slot of record.slots) {
    if (slot.issue_number === null || slot.ordinary_run_id === null) return persistOutcome(record, deps, "gate_defect", `${slot.id} lacks bound issue or ordinary run identity`);
    const obs = await deps.observeFixture(record, slot);
    slot.observation = obs;
    slot.pr_number = obs.pr.number;
    slot.pr_head_sha = obs.pr.head_sha;
    classifications.push(classifyExactCandidateFrgObservation(record, slot, obs));
  }
  const outcome: ExactCandidateFrgOutcome = classifications.every((item) => item === "passed") ? "passed" :
    classifications.includes("gate_defect") ? "gate_defect" :
    classifications.includes("exact_candidate_regression") ? "exact_candidate_regression" :
    classifications.includes("ordinary_review_revision") ? "ordinary_review_revision" : "external_or_transient_inconclusive";
  const wait = outcome === "external_or_transient_inconclusive"
    ? { probe: "re-observe forge, CI, review, and Tester for the recorded PR heads", wake_condition: "all authoritative observers return a current conclusive result" }
    : null;
  await persistOutcome(record, deps, outcome, `fixture outcomes: ${classifications.join(",")}`, wait);
  if (deps.cleanup && !["ordinary_review_revision", "external_or_transient_inconclusive"].includes(outcome)) {
    let facts: ExactCandidateFrgCleanupFact[];
    try { facts = await deps.cleanup(record); }
    catch (error) { facts = [{ target: record.epoch_id, status: "debt", detail: (error as Error).message, observed_at: iso(deps.now()) }]; }
    record.cleanup.push(...facts);
    record.cleanup_debt = record.cleanup.some((fact) => fact.status === "debt");
    record.updated_at = iso(deps.now());
    await deps.persist(record);
  }
  return record;
}

/** One ordinary exact-pair runner tick. Resume retains the same candidate and pair. */
export async function runExactCandidateFrg(
  input: BeginExactCandidateFrgInput,
  deps: ExactCandidateFrgDeps,
  existing?: ExactCandidateFrgRecord,
): Promise<ExactCandidateFrgRecord> {
  let record: ExactCandidateFrgRecord;
  let prepared: CandidateEngine;
  if (existing) {
    record = cloneRecord(parseExactCandidateFrgRecord(existing));
    if (record.repository !== input.repository || record.base_branch !== input.baseBranch ||
        record.release_version !== input.releaseVersion || record.worker_config.implementer !== input.implementer ||
        record.worker_config.reviewer !== input.reviewer || record.worker_config.gates_sha256 !== input.gatesSha256) {
      return persistOutcome(record, deps, "gate_defect", "resume input does not match the recorded FRG epoch");
    }
    const current = exactSha(await deps.observeOriginMainSha(input.repoDir), "current origin/main");
    if (current !== record.candidate.sha) {
      return persistOutcome(record, deps, "stale_candidate", `origin/main moved from ${record.candidate.sha} to ${current}`);
    }
    const result = await (deps.resolveAndPrepareCandidate
      ? deps.resolveAndPrepareCandidate(input, record.candidate.sha)
      : productionResolveCandidate(input, record.candidate.sha, deps.resolveAndPrepareDeps));
    if (!result.ok) return persistOutcome(record, deps, "gate_defect", `candidate resume prepare failed: ${result.error}`);
    prepared = result.engine;
    if (path.resolve(prepared.engineRoot) !== path.resolve(record.candidate.engine_root) ||
        path.resolve(prepared.launcherPath) !== path.resolve(record.candidate.launcher_path)) {
      return persistOutcome(record, deps, "gate_defect", "prepared candidate root changed within epoch");
    }
  } else {
    const begun = await beginExactCandidateFrg(input, deps);
    record = begun.record;
    prepared = begun.engine;
  }
  record = await reconcileExactCandidateFrgPair(record, deps);
  if (record.outcome !== "pending") return record;
  if (record.slots.some((slot) => slot.ordinary_run_id === null)) {
    record = await dispatchExactCandidateFrgPair(record, prepared, deps);
  }
  return observeExactCandidateFrgPair(record, deps);
}

export function verifyExactCandidateFrgResult(value: unknown, expected: { epoch_id: string; candidate_sha: string }): ExactCandidateFrgRecord {
  const record = parseExactCandidateFrgRecord(value);
  if (record.epoch_id !== expected.epoch_id || record.candidate.sha !== expected.candidate_sha) throw new Error("exact-candidate FRG result identity mismatch");
  if (record.outcome !== "passed") throw new Error(`exact-candidate FRG result is not proven: ${record.outcome}`);
  for (const slot of record.slots) {
    if (!slot.observation || !observationPasses(record, slot, slot.observation)) throw new Error(`${slot.id} lacks authoritative current-head completion proof`);
    if (slot.pr_head_sha === record.candidate.sha) throw new Error(`${slot.id} fixture PR head must remain distinct from engine candidate`);
  }
  return record;
}
