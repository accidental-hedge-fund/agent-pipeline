// Complete, independently invokable SemVer release coordinator (#1563).
//
// The durable authorities are GitHub and origin refs. Every mutation is preceded
// by a fresh observation, so restarting the command reconciles an already
// prepared/merged metadata PR, exact-candidate FRG, tag, or publication.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  artifactSubdir,
  RELEASE_PUBLISHER_RECOVERY_ARTIFACT,
} from "../artifact-ignore.ts";
import { primaryWorktreeFromPorcelain } from "../run-store.ts";
import {
  observeProductionExactCandidateFrgPass,
  runProductionExactCandidateFrg,
  verifyExactCandidateFrgResult,
  type ExactCandidateFrgRecord,
} from "../exact-candidate-frg.ts";
import { finishReleasePr, realReleaseFinishDeps } from "./release-finish.ts";
import { withLock } from "../lock.ts";
import { isAuthoritativeReleaseNotFound } from "../gh.ts";
import {
  realReleaseDeps,
  resolveVersion,
  runRelease,
  type ReleaseOpts,
  type ReleasePrepareResult,
} from "./release.ts";

const execFileAsync = promisify(execFile);
const OID_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const RELEASE_PUBLICATION_ATTEMPTS = 120;
export const RELEASE_PUBLICATION_WAIT_MS = 10_000;
export const RELEASE_DISPATCH_OBSERVE_ATTEMPTS = 30;

export interface ReleaseImplementationPr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  base: string;
  merge_commit_oid: string | null;
}

export interface ReleaseMilestoneMember {
  number: number;
  state: "OPEN" | "CLOSED";
  implementation_prs: ReleaseImplementationPr[];
}

export interface CompleteReleaseMilestone {
  number: number;
  title: string;
  issues: ReleaseMilestoneMember[];
}

export interface ObservedMetadataRelease {
  pr: number;
  version: string;
  base: string;
  head_oid: string;
  state: "OPEN" | "MERGED";
  merge_commit_oid: string | null;
}

export interface PublishedReleaseObservation {
  tag: string;
  draft: boolean;
  published_at: string | null;
  workflow_conclusion: "success" | "failure" | "pending" | "unknown";
}

export type PublisherRemoteClass = "absent" | "pending" | "failed" | "successful" | "unknown";

export const GITHUB_WORKFLOW_RUN_STATUSES = [
  "queued", "in_progress", "completed", "waiting", "requested", "pending",
] as const;
export const GITHUB_WORKFLOW_RUN_CONCLUSIONS = [
  "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
  "startup_failure", "success", "timed_out",
] as const;
export const RETRYABLE_PUBLISHER_CONCLUSIONS = ["failure", "timed_out", "startup_failure"] as const;
export const RELEASE_METADATA_PROVENANCE_MARKER =
  "_Prepared by the bounded `pipeline release prepare` helper_";
export const LEGACY_RELEASE_METADATA_PROVENANCE_MARKER =
  "_Prepared by `pipeline release`_";
export const METADATA_PR_JSON_FIELDS =
  "number,title,body,baseRefName,headRefName,headRefOid,author,state,isCrossRepository,headRepositoryOwner,mergeCommit";

export function releaseMetadataTitle(version: string): string {
  return `release: ${version} — version metadata`;
}

export function releaseMetadataTitlePrefix(version: string): string {
  return `release: ${version} — `;
}

/** Exact `release: VERSION — THEME` with one nonempty single-line theme. */
export function isReleaseMetadataTitle(title: unknown, version: string): boolean {
  if (typeof title !== "string" || !VERSION_RE.test(version)) return false;
  if (title.includes("\n") || title.includes("\r")) return false;
  const prefix = releaseMetadataTitlePrefix(version);
  if (!title.startsWith(prefix)) return false;
  const theme = title.slice(prefix.length);
  return theme.length > 0 && theme === theme.trim() && !theme.includes("—");
}

function lastNonemptyLine(body: string): string {
  const lines = body.split(/\r\n|\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== "") return lines[i]!;
  }
  return "";
}

function hasKnownMetadataProvenance(body: string): boolean {
  const line = lastNonemptyLine(body);
  return line === RELEASE_METADATA_PROVENANCE_MARKER || line === LEGACY_RELEASE_METADATA_PROVENANCE_MARKER;
}

function jsonSafeInteger(value: unknown, min: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return null;
  return value;
}

function isVerifiedPublication(publication: PublishedReleaseObservation | null): publication is PublishedReleaseObservation {
  return Boolean(publication && !publication.draft && publication.published_at && publication.workflow_conclusion === "success");
}

function isPublishedPending(publication: PublishedReleaseObservation | null): boolean {
  return Boolean(publication && !publication.draft && publication.published_at && publication.workflow_conclusion === "pending");
}

export interface PublisherRunRow {
  databaseId: number;
  event: string;
  headBranch: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  attempt: number;
}

export interface PublisherRecoveryObservation {
  exact_run_id: number | null;
  conclusion: "success" | "failure" | "pending";
}

export interface PublisherRecoveryEpisode {
  schema_version: 1;
  workflow: "release.yml";
  tag: string;
  candidate: string;
  state: "dispatched" | "rerun_requested";
  run_id?: number;
}

export const TAGGED_STALE_C_MESSAGE =
  "pipeline release: tagged-stale-C: origin/main moved after the annotated tag and publication is not a verified success. Tags are never force-moved or deleted. Git cannot atomically create a tag while asserting an unrelated protected main ref remains C; this is the documented non-atomic tag-boundary race.";

export interface CompleteReleaseResult {
  schema_version: 1;
  kind: "release_complete";
  version: string;
  candidate_sha: string;
  metadata_pr: number | null;
  frg_epoch_id: string;
  tag: string;
  published_at: string;
  already_complete: boolean;
}

export interface CompleteReleaseDeps {
  log(message: string): void;
  withRunLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  resolveMilestones(version: string): Promise<CompleteReleaseMilestone[]>;
  observeOriginHead(base: string): Promise<string>;
  commitContained(commit: string, baseHead: string): Promise<boolean>;
  versionsAt(commit: string): Promise<{ root: string; core: string }>;
  observeMetadata(version: string, base: string): Promise<ObservedMetadataRelease | null>;
  prepareMetadata(version: string, base: string, opts: ReleaseOpts): Promise<ReleasePrepareResult>;
  finishMetadata(release: ObservedMetadataRelease): Promise<ObservedMetadataRelease>;
  observeExactFrg(version: string, candidate: string, base: string): Promise<ExactCandidateFrgRecord>;
  runExactFrg(version: string, candidate: string, base: string): Promise<ExactCandidateFrgRecord>;
  verifyExactFrg(record: ExactCandidateFrgRecord, candidate: string): void;
  observeTag(tag: string): Promise<{ annotated: boolean; peeled_commit: string; annotation: string } | null>;
  createAnnotatedTag(tag: string, candidate: string, notes: string): Promise<void>;
  observePublication(tag: string): Promise<PublishedReleaseObservation | null>;
  recoverPublication(tag: string, candidate: string): Promise<boolean>;
  wait(ms: number): Promise<void>;
  publicationAttempts?: number;
  dispatchObserveAttempts?: number;
}

export function releaseTagNotes(version: string, candidate: string): string {
  return `v${version}\n\nVerified exact-candidate release at ${candidate}.`;
}

function exactOid(value: string, label: string): string {
  const oid = value.trim().toLowerCase();
  if (!OID_RE.test(oid)) throw new Error(`pipeline release: ${label} is not an exact 40-character commit OID`);
  return oid;
}

function compareVersions(a: string, b: string): number {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) throw new Error("pipeline release: package version is not SemVer X.Y.Z");
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return 0;
}

export async function validateReleaseMilestone(
  version: string,
  base: string,
  milestones: readonly CompleteReleaseMilestone[],
  observeHead: () => Promise<string>,
  contained: (commit: string, baseHead: string) => Promise<boolean>,
): Promise<string> {
  if (milestones.length !== 1) {
    throw new Error(`pipeline release: expected exactly one milestone matching v${version}; observed ${milestones.length}`);
  }
  const milestone = milestones[0]!;
  if (milestone.issues.length === 0) throw new Error(`pipeline release: milestone ${milestone.title} is empty`);
  const head = exactOid(await observeHead(), `origin/${base}`);
  for (const issue of milestone.issues) {
    if (issue.state !== "CLOSED") throw new Error(`pipeline release: milestone issue #${issue.number} is still open`);
    const merged = issue.implementation_prs.filter((pr) => pr.state === "MERGED" && pr.base === base && pr.merge_commit_oid);
    if (merged.length === 0) {
      throw new Error(`pipeline release: issue #${issue.number} has no merged implementation PR targeting ${base}`);
    }
    let integrated = false;
    for (const pr of merged) {
      const merge = exactOid(pr.merge_commit_oid!, `issue #${issue.number} merge commit`);
      if (await contained(merge, head)) integrated = true;
    }
    if (!integrated) {
      throw new Error(`pipeline release: issue #${issue.number} has no merged implementation PR contained in origin/${base}`);
    }
  }
  return head;
}

function assertMetadataIdentity(value: ObservedMetadataRelease, version: string, base: string): void {
  if (value.version !== version || value.base !== base || !Number.isSafeInteger(value.pr) || value.pr <= 0) {
    throw new Error("pipeline release: observed metadata PR identity conflicts with the requested release");
  }
  exactOid(value.head_oid, "metadata PR head");
  if (value.state === "MERGED") exactOid(value.merge_commit_oid ?? "", "metadata merge commit");
}

/** Complete metadata, exact-pair FRG, immutable tag, and publication in order. */
async function runCompleteReleaseLocked(
  versionArg: string,
  opts: ReleaseOpts,
  cfg: { repo_dir: string; repo: string; base_branch?: string; release_model?: "semver" | "continuous" },
  deps: CompleteReleaseDeps = realCompleteReleaseDeps(cfg),
): Promise<CompleteReleaseResult | null> {
  if (cfg.release_model === "continuous") throw new Error("pipeline release is unavailable for the continuous release model");
  const base = cfg.base_branch ?? "main";
  let version: string;
  if (VERSION_RE.test(versionArg)) {
    version = versionArg;
  } else {
    const initialHead = exactOid(await deps.observeOriginHead(base), `origin/${base}`);
    const initialVersions = await deps.versionsAt(initialHead);
    if (initialVersions.root !== initialVersions.core) throw new Error("pipeline release: package versions disagree at origin head");
    version = resolveVersion(versionArg, initialVersions.core);
  }

  if (opts.dryRun) {
    await validateReleaseMilestone(version, base, await deps.resolveMilestones(version), () => deps.observeOriginHead(base), deps.commitContained);
    deps.log(`[pipeline release] dry-run: v${version} milestone is complete; no metadata, fixture, tag, or publication mutation performed`);
    return null;
  }

  // Completed identity is the immutable tag C, not the current moving base.
  // Post-tag docs refresh is allowed to advance main without invalidating C.
  const completedTag = await deps.observeTag(`v${version}`);
  if (completedTag) {
    const taggedCandidate = exactOid(completedTag.peeled_commit, `v${version} peeled commit`);
    const taggedVersions = await deps.versionsAt(taggedCandidate);
    const expectedNotes = releaseTagNotes(version, taggedCandidate);
    if (!completedTag.annotated || completedTag.annotation.trim() !== expectedNotes) {
      throw new Error(`pipeline release: existing v${version} annotation does not match the release identity`);
    }
    if (taggedVersions.root !== version || taggedVersions.core !== version) {
      throw new Error(`pipeline release: existing v${version} does not contain matching package versions`);
    }
    const durableFrg = await deps.observeExactFrg(version, taggedCandidate, base);
    deps.verifyExactFrg(durableFrg, taggedCandidate);
    const publication = await deps.observePublication(`v${version}`);
    if (isVerifiedPublication(publication)) {
      return {
        schema_version: 1, kind: "release_complete", version, candidate_sha: taggedCandidate,
        metadata_pr: null, frg_epoch_id: durableFrg.epoch_id,
        tag: `v${version}`, published_at: publication.published_at, already_complete: true,
      };
    }
    // Tag C is immutable even while publication is incomplete. A matching
    // non-draft published Release with the exact publisher still pending is the
    // docs-push window (Release, then main C→D, then workflow success). Wait
    // without recovery. Other incomplete publication plus moved main is
    // tagged-stale-C and never retags or recreates fixtures.
    return waitForVerifiedPublication(deps, {
      tag: `v${version}`,
      candidate: taggedCandidate,
      version,
      base,
      metadata_pr: null,
      frg_epoch_id: durableFrg.epoch_id,
      already_complete: true,
      timeout: `pipeline release: timed out resuming publisher for v${version} at ${taggedCandidate}`,
    });
  }

  // Only an unfinished release is gated by mutable milestone membership.
  await validateReleaseMilestone(version, base, await deps.resolveMilestones(version), () => deps.observeOriginHead(base), deps.commitContained);

  let metadata = await deps.observeMetadata(version, base);
  if (metadata) assertMetadataIdentity(metadata, version, base);
  const beforePrepare = await deps.versionsAt(exactOid(await deps.observeOriginHead(base), `origin/${base}`));
  if (beforePrepare.root !== beforePrepare.core) throw new Error("pipeline release: package versions disagree before metadata preparation");
  if (compareVersions(beforePrepare.core, version) > 0) throw new Error(`pipeline release: origin/${base} already has newer version ${beforePrepare.core}`);

  if (!metadata) {
    if (beforePrepare.core === version || beforePrepare.root === version) {
      throw new Error(
        `pipeline release: origin/${base} already has v${version} without a validated release-managed metadata PR`,
      );
    }
    const prepared = await deps.prepareMetadata(version, base, { ...opts, noEdit: true, skipFrg: true });
    metadata = { ...prepared, state: "OPEN", merge_commit_oid: null };
    assertMetadataIdentity(metadata, version, base);
  }
  if (metadata?.state === "OPEN") {
    metadata = await deps.finishMetadata(metadata);
    assertMetadataIdentity(metadata, version, base);
  }

  // Metadata is integrated before candidate C is frozen and before fixtures.
  const candidate = exactOid(await deps.observeOriginHead(base), `origin/${base}`);
  if (metadata?.merge_commit_oid && !await deps.commitContained(exactOid(metadata.merge_commit_oid, "metadata merge commit"), candidate)) {
    throw new Error(`pipeline release: metadata merge is not contained in frozen candidate ${candidate}`);
  }
  const candidateVersions = await deps.versionsAt(candidate);
  if (candidateVersions.root !== version || candidateVersions.core !== version) {
    throw new Error(`pipeline release: v${version} metadata is not integrated at candidate ${candidate}`);
  }
  const preFrgMilestoneHead = await validateReleaseMilestone(
    version, base, await deps.resolveMilestones(version), () => deps.observeOriginHead(base), deps.commitContained,
  );
  if (preFrgMilestoneHead !== candidate) {
    throw new Error(`pipeline release: origin/${base} moved after candidate freeze; refusing fixtures for stale ${candidate}`);
  }

  const tag = `v${version}`;
  const existingTag = completedTag;
  const existingPublication = existingTag ? await deps.observePublication(tag) : null;
  if (existingTag) {
    if (!existingTag.annotated || exactOid(existingTag.peeled_commit, `${tag} peeled commit`) !== candidate ||
        existingTag.annotation.trim() !== releaseTagNotes(version, candidate)) {
      throw new Error(`pipeline release: existing ${tag} conflicts with candidate ${candidate}; tags are never force-moved`);
    }
    if (existingPublication && !existingPublication.draft && existingPublication.published_at && existingPublication.workflow_conclusion === "success") {
      return {
        schema_version: 1, kind: "release_complete", version, candidate_sha: candidate,
        metadata_pr: metadata?.pr ?? null, frg_epoch_id: `reconciled-${candidate.slice(0, 12)}`,
        tag, published_at: existingPublication.published_at, already_complete: true,
      };
    }
  }

  const frg = await deps.runExactFrg(version, candidate, base);
  deps.verifyExactFrg(frg, candidate);
  const current = await validateReleaseMilestone(
    version, base, await deps.resolveMilestones(version), () => deps.observeOriginHead(base), deps.commitContained,
  );
  if (current !== candidate) throw new Error(`pipeline release: origin/${base} moved from candidate ${candidate} to ${current} after FRG; refusing stale tag`);
  const preTagHead = exactOid(await deps.observeOriginHead(base), `origin/${base}`);
  if (preTagHead !== candidate) {
    throw new Error(`pipeline release: origin/${base} moved from candidate ${candidate} to ${preTagHead} after FRG; refusing stale tag`);
  }

  if (!existingTag) {
    const notes = releaseTagNotes(version, candidate);
    await deps.createAnnotatedTag(tag, candidate, notes);
  }
  const verifiedTag = await deps.observeTag(tag);
  if (!verifiedTag || !verifiedTag.annotated || exactOid(verifiedTag.peeled_commit, `${tag} peeled commit`) !== candidate ||
      verifiedTag.annotation.trim() !== releaseTagNotes(version, candidate)) {
    throw new Error(`pipeline release: ${tag} was not observed as an annotated tag at candidate ${candidate}`);
  }

  return waitForVerifiedPublication(deps, {
    tag,
    candidate,
    version,
    base,
    metadata_pr: null,
    frg_epoch_id: frg.epoch_id,
    already_complete: true,
    timeout: `pipeline release: timed out waiting for published GitHub Release ${tag}`,
  });
}

async function waitForVerifiedPublication(
  deps: CompleteReleaseDeps,
  input: {
    tag: string;
    candidate: string;
    version: string;
    base: string;
    metadata_pr: number | null;
    frg_epoch_id: string;
    already_complete: boolean;
    timeout: string;
  },
): Promise<CompleteReleaseResult> {
  const attempts = deps.publicationAttempts ?? RELEASE_PUBLICATION_ATTEMPTS;
  const complete = (publication: PublishedReleaseObservation): CompleteReleaseResult => {
    if (publication.tag !== input.tag) throw new Error("pipeline release: GitHub Release tag identity changed");
    return {
      schema_version: 1, kind: "release_complete", version: input.version, candidate_sha: input.candidate,
      metadata_pr: input.metadata_pr, frg_epoch_id: input.frg_epoch_id,
      tag: input.tag, published_at: publication.published_at!, already_complete: input.already_complete,
    };
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const publication = await deps.observePublication(input.tag);
    if (publication && publication.tag !== input.tag) throw new Error("pipeline release: GitHub Release tag identity changed");
    if (isVerifiedPublication(publication)) return complete(publication);
    const stillHead = exactOid(await deps.observeOriginHead(input.base), `origin/${input.base}`);
    if (stillHead !== input.candidate) {
      const reobserved = await deps.observePublication(input.tag);
      if (reobserved && reobserved.tag !== input.tag) throw new Error("pipeline release: GitHub Release tag identity changed");
      if (isVerifiedPublication(reobserved)) return complete(reobserved);
      if (isPublishedPending(reobserved)) {
        if (attempt < attempts) {
          await deps.wait(RELEASE_PUBLICATION_WAIT_MS);
          continue;
        }
        throw new Error(input.timeout);
      }
      throw new Error(TAGGED_STALE_C_MESSAGE);
    }
    if (isPublishedPending(publication)) {
      if (attempt < attempts) {
        await deps.wait(RELEASE_PUBLICATION_WAIT_MS);
        continue;
      }
      throw new Error(input.timeout);
    }
    await deps.recoverPublication(input.tag, input.candidate);
    if (publication && (publication.draft || !publication.published_at || publication.workflow_conclusion !== "success") &&
        attempt === attempts) {
      throw new Error(`pipeline release: GitHub Release ${input.tag} remains draft or unpublished`);
    }
    if (attempt < attempts) await deps.wait(RELEASE_PUBLICATION_WAIT_MS);
  }
  throw new Error(input.timeout);
}

export async function runCompleteRelease(
  versionArg: string,
  opts: ReleaseOpts,
  cfg: { repo_dir: string; repo: string; base_branch?: string; release_model?: "semver" | "continuous" },
  deps: CompleteReleaseDeps = realCompleteReleaseDeps(cfg),
): Promise<CompleteReleaseResult | null> {
  const lockDomain = createHash("sha256")
    .update(`${cfg.repo.toLowerCase()}\n${cfg.base_branch ?? "main"}`)
    .digest("hex")
    .slice(0, 24);
  return deps.withRunLock(`complete-release-${lockDomain}`, () =>
    runCompleteReleaseLocked(versionArg, opts, cfg, deps));
}

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
    return String(stdout).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    throw new Error([err.message, String(err.stderr ?? ""), String(err.stdout ?? "")].filter(Boolean).join("\n"));
  }
}

function parseObject(stdout: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`pipeline release: ${label} returned malformed JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`pipeline release: ${label} returned an unknown shape`);
  return value as Record<string, unknown>;
}

function flattenPages(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`pipeline release: ${label} returned an unknown shape`);
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

export function parsePublisherRunRows(rows: unknown, tag: string): PublisherRunRow[] {
  if (!Array.isArray(rows)) throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
  return rows.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`pipeline release: ${tag} publisher run ${index} returned unknown shape`);
    }
    const row = value as Record<string, unknown>;
    const databaseId = jsonSafeInteger(row.databaseId, 1);
    const attempt = jsonSafeInteger(row.attempt, 1);
    const headSha = String(row.headSha ?? "").toLowerCase();
    if (databaseId === null || attempt === null ||
        typeof row.event !== "string" || typeof row.headBranch !== "string" || !OID_RE.test(headSha) ||
        typeof row.status !== "string" || (row.conclusion !== null && typeof row.conclusion !== "string")) {
      throw new Error(`pipeline release: ${tag} publisher run ${index} is malformed`);
    }
    return {
      databaseId, event: row.event, headBranch: row.headBranch, headSha, status: row.status,
      conclusion: row.conclusion === null ? null : String(row.conclusion), attempt,
    };
  });
}

function parsePublisherWorkflowRun(value: unknown, tag: string, index: number): PublisherRunRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pipeline release: ${tag} publisher run ${index} returned unknown shape`);
  }
  const row = value as Record<string, unknown>;
  const databaseId = jsonSafeInteger(row.id, 1);
  const attempt = jsonSafeInteger(row.run_attempt, 1);
  const headSha = String(row.head_sha ?? "").toLowerCase();
  if (databaseId === null || attempt === null ||
      typeof row.event !== "string" || typeof row.head_branch !== "string" || !OID_RE.test(headSha) ||
      typeof row.status !== "string" || (row.conclusion !== null && typeof row.conclusion !== "string")) {
    throw new Error(`pipeline release: ${tag} publisher run ${index} is malformed`);
  }
  return {
    databaseId, event: row.event, headBranch: row.head_branch, headSha, status: row.status,
    conclusion: row.conclusion === null ? null : String(row.conclusion), attempt,
  };
}

/** Flatten `gh api --paginate --slurp` workflow-run pages and fail closed unless total_count matches. */
export function parsePublisherWorkflowRunPages(raw: unknown, tag: string): PublisherRunRow[] {
  const pages = Array.isArray(raw) ? raw : [raw];
  if (pages.length === 0) throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
  let total: number | null = null;
  const runs: unknown[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
    }
    const rec = page as Record<string, unknown>;
    const count = rec.total_count;
    const list = rec.workflow_runs;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(list)) {
      throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
    }
    if (total === null) total = count;
    else if (count !== total) {
      throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
    }
    runs.push(...list);
  }
  const parsed = runs.map((value, index) => parsePublisherWorkflowRun(value, tag, index));
  const ids = new Set<number>();
  for (const run of parsed) {
    if (ids.has(run.databaseId)) {
      throw new Error(`pipeline release: ${tag} publisher workflow list returned duplicate run identities`);
    }
    ids.add(run.databaseId);
  }
  if (ids.size !== total) {
    throw new Error(`pipeline release: ${tag} publisher workflow list is truncated`);
  }
  return parsed;
}

export function exactPublisherRuns(rows: readonly PublisherRunRow[], tag: string, candidate: string): PublisherRunRow[] {
  const sha = candidate.toLowerCase();
  return rows.filter((row) =>
    (row.event === "push" || row.event === "workflow_dispatch") &&
    row.headBranch === tag && row.headSha === sha);
}

const WORKFLOW_STATUS = new Set<string>(GITHUB_WORKFLOW_RUN_STATUSES);
const WORKFLOW_CONCLUSION = new Set<string>(GITHUB_WORKFLOW_RUN_CONCLUSIONS);
const RETRYABLE_CONCLUSION = new Set<string>(RETRYABLE_PUBLISHER_CONCLUSIONS);
const PENDING_WORKFLOW_STATUS = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

function classifyExactPublisherRun(row: PublisherRunRow): Exclude<PublisherRemoteClass, "absent"> {
  if (row.status === "completed" && row.conclusion === "success" && WORKFLOW_CONCLUSION.has(row.conclusion)) {
    return "successful";
  }
  if (row.status === "completed" && row.conclusion !== null && RETRYABLE_CONCLUSION.has(row.conclusion) &&
      WORKFLOW_CONCLUSION.has(row.conclusion)) {
    return "failed";
  }
  if (WORKFLOW_STATUS.has(row.status) && PENDING_WORKFLOW_STATUS.has(row.status) && row.conclusion === null) {
    return "pending";
  }
  return "unknown";
}

export function classifyPublisherRuns(
  rows: unknown,
  tag: string,
  candidate: string,
): { class: PublisherRemoteClass; exact: PublisherRunRow[] } {
  const parsed = parsePublisherRunRows(rows, tag);
  const exact = exactPublisherRuns(parsed, tag, candidate);
  if (exact.length === 0) return { class: "absent", exact };
  const classes = exact.map(classifyExactPublisherRun);
  if (classes.includes("successful")) return { class: "successful", exact };
  if (classes.includes("unknown")) return { class: "unknown", exact };
  if (classes.includes("pending")) return { class: "pending", exact };
  if (classes.every((value) => value === "failed")) return { class: "failed", exact };
  return { class: "unknown", exact };
}

export function selectExactPublisherConclusion(
  rows: unknown,
  tag: string,
  candidate: string,
): "success" | "failure" | "pending" | "unknown" {
  const classified = classifyPublisherRuns(rows, tag, candidate);
  if (classified.class === "successful") return "success";
  if (classified.class === "failed") return "failure";
  if (classified.class === "unknown") return "unknown";
  return "pending";
}

export function metadataChecksState(rows: unknown): "pending" | "pass" | "fail" {
  if (!Array.isArray(rows)) throw new Error("pipeline release: metadata checks returned unknown shape");
  if (rows.length === 0) return "pending";
  const buckets = rows.map((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error("pipeline release: metadata check returned unknown shape");
    }
    return String((check as Record<string, unknown>).bucket ?? "");
  });
  if (buckets.some((bucket) => bucket === "fail" || bucket === "cancel")) return "fail";
  return buckets.every((bucket) => bucket === "pass" || bucket === "skipping") ? "pass" : "pending";
}

export function exactHeadCheckRunsState(raw: unknown, headOid: string): "pending" | "pass" | "fail" {
  const head = headOid.toLowerCase();
  const pages = Array.isArray(raw) ? raw : [raw];
  const runs = pages.flatMap((page) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new Error("pipeline release: exact-head check-runs returned unknown shape");
    }
    const list = (page as Record<string, unknown>).check_runs;
    if (!Array.isArray(list)) throw new Error("pipeline release: exact-head check-runs returned unknown shape");
    return list;
  });
  const exact = runs.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("pipeline release: exact-head check-run returned unknown shape");
    }
    return String((value as Record<string, unknown>).head_sha ?? "").toLowerCase() === head;
  });
  if (exact.length === 0) return "pending";
  const conclusions = exact.map((value) => {
    const row = value as Record<string, unknown>;
    return { status: String(row.status ?? ""), conclusion: String(row.conclusion ?? "") };
  });
  if (conclusions.some((row) => row.status === "completed" && ["failure", "cancelled", "timed_out", "startup_failure"].includes(row.conclusion))) {
    return "fail";
  }
  if (conclusions.every((row) => row.status === "completed" && (row.conclusion === "success" || row.conclusion === "skipped" || row.conclusion === "neutral"))) {
    return conclusions.some((row) => row.conclusion === "success") ? "pass" : "pending";
  }
  return "pending";
}

async function fetchMetadataHead(
  git: (args: string[], cwd?: string) => Promise<string>,
  pr: number,
  version: string,
  headOid: string,
): Promise<void> {
  const dest = `refs/pipeline/release-metadata/v${version}`;
  try {
    await git(["fetch", "--force", "origin", `pull/${pr}/head:${dest}`]);
  } catch {
    try {
      await git(["fetch", "--force", "origin", `${headOid}:${dest}`]);
    } catch (error) {
      throw new Error(
        `pipeline release: metadata PR #${pr} head ${headOid} is not retrievable after source-branch deletion: ${(error as Error).message}`,
      );
    }
  }
  const fetched = exactOid(await git(["rev-parse", dest]), "fetched metadata head");
  if (fetched !== headOid) {
    throw new Error(`pipeline release: metadata PR #${pr} fetched head ${fetched} does not match immutable head ${headOid}`);
  }
}

function parseReleaseManagedMetadataPr(
  raw: Record<string, unknown>,
  expected: { version: string; base: string; repo: string; actor: string; pr?: number },
): ObservedMetadataRelease {
  const number = jsonSafeInteger(raw.number, 1);
  if (number === null) {
    throw new Error(`pipeline release: metadata PR for v${expected.version} has invalid identity`);
  }
  if (expected.pr != null && number !== expected.pr) {
    throw new Error(`pipeline release: metadata PR #${expected.pr} identity changed during observation`);
  }
  const author = raw.author && typeof raw.author === "object" && !Array.isArray(raw.author)
    ? raw.author as Record<string, unknown>
    : null;
  const owner = raw.headRepositoryOwner && typeof raw.headRepositoryOwner === "object" && !Array.isArray(raw.headRepositoryOwner)
    ? raw.headRepositoryOwner as Record<string, unknown>
    : null;
  const repoOwner = expected.repo.split("/")[0] ?? "";
  const login = typeof author?.login === "string" ? author.login : "";
  const ownerLogin = typeof owner?.login === "string" ? owner.login : "";
  const actor = expected.actor.trim();
  // Fail closed: another authenticated operator cannot resume this metadata PR.
  if (
    !isReleaseMetadataTitle(raw.title, expected.version) ||
    typeof raw.body !== "string" || !hasKnownMetadataProvenance(raw.body) ||
    raw.baseRefName !== expected.base ||
    raw.headRefName !== `release/v${expected.version}` ||
    (raw.state !== "OPEN" && raw.state !== "MERGED") ||
    raw.isCrossRepository !== false ||
    !actor || !login || login.toLowerCase() !== actor.toLowerCase() || typeof author?.is_bot !== "boolean" ||
    !repoOwner || ownerLogin !== repoOwner
  ) {
    throw new Error(`pipeline release: metadata PR #${number} is not a validated release-managed metadata PR`);
  }
  const head_oid = exactOid(String(raw.headRefOid ?? ""), `metadata PR #${number} head`);
  const merge = raw.mergeCommit && typeof raw.mergeCommit === "object" && !Array.isArray(raw.mergeCommit)
    ? String((raw.mergeCommit as Record<string, unknown>).oid ?? "")
    : "";
  const merge_commit_oid = raw.state === "MERGED" ? exactOid(merge, "metadata merge commit") : (merge || null);
  return {
    pr: number,
    version: expected.version,
    base: expected.base,
    head_oid,
    state: raw.state,
    merge_commit_oid,
  };
}

export function assertReleaseManagedMetadataPaths(files: readonly string[]): void {
  const allowed = new Set([
    "package.json", "core/package.json", "ROADMAP.md",
    "hosts/claude/SKILL.md", "hosts/codex/SKILL.md", "hosts/grok/SKILL.md", "hosts/opencode/SKILL.md",
  ]);
  if (files.length === 0 || files.some((file) => !allowed.has(file))) {
    throw new Error("pipeline release: metadata PR contains non-release-managed paths");
  }
}

/** Authoritative PR file list; remains valid after merge-commit, squash, rebase, and source-branch deletion. */
export function parsePullRequestChangedFiles(raw: unknown, pr: number): string[] {
  const rows = flattenPages(raw, `metadata PR #${pr} files`);
  return rows.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`pipeline release: metadata PR #${pr} file ${index} returned unknown shape`);
    }
    const filename = (value as Record<string, unknown>).filename;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error(`pipeline release: metadata PR #${pr} file ${index} is missing filename`);
    }
    return filename;
  });
}

function publisherRecoveryPath(repoDir: string, tag: string, candidate: string): string {
  const id = createHash("sha256")
    .update(`release.yml\n${tag}\n${candidate.toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(artifactSubdir(repoDir, RELEASE_PUBLISHER_RECOVERY_ARTIFACT), `${id}.json`);
}

export function parsePublisherRecoveryEpisode(
  raw: unknown,
  expected: { tag: string; candidate: string },
): PublisherRecoveryEpisode {
  const candidate = exactOid(expected.candidate, `${expected.tag} publisher recovery candidate`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`pipeline release: publisher recovery episode for ${expected.tag} at ${candidate} is malformed`);
  }
  const row = raw as Record<string, unknown>;
  const storedCandidate = typeof row.candidate === "string"
    ? exactOid(String(row.candidate), `${expected.tag} stored publisher recovery candidate`)
    : "";
  if (
    row.schema_version !== 1 || row.workflow !== "release.yml" || typeof row.tag !== "string" ||
    row.tag !== expected.tag || storedCandidate !== candidate
  ) {
    throw new Error(`pipeline release: publisher recovery episode for ${expected.tag} at ${candidate} is malformed`);
  }
  if (row.state === "dispatched") {
    return { schema_version: 1, workflow: "release.yml", tag: expected.tag, candidate, state: "dispatched" };
  }
  const runId = jsonSafeInteger(row.run_id, 1);
  if (row.state !== "rerun_requested" || runId === null) {
    throw new Error(`pipeline release: publisher recovery episode for ${expected.tag} at ${candidate} is malformed`);
  }
  return {
    schema_version: 1,
    workflow: "release.yml",
    tag: expected.tag,
    candidate,
    state: "rerun_requested",
    run_id: runId,
  };
}

/** Production adapter. Tests inject the complete seam and never touch git/GitHub. */
export function realCompleteReleaseDeps(
  cfg: { repo_dir: string; repo: string; base_branch?: string },
  io: {
    command?: (cwd: string, file: string, args: string[]) => Promise<string>;
    wait?: (ms: number) => Promise<void>;
    publicationAttempts?: number;
    dispatchObserveAttempts?: number;
    loadPublisherRecoveryEpisode?: (key: {
      workflow: "release.yml";
      tag: string;
      candidate: string;
    }) => Promise<PublisherRecoveryEpisode | null>;
    persistPublisherRecoveryEpisode?: (episode: PublisherRecoveryEpisode) => Promise<void>;
    finishReleasePr?: (
      pr: number,
      expected: { pr: number; version: string; base: string; head_oid: string },
    ) => Promise<{ mergeCommitOid: string | null }>;
  } = {},
): CompleteReleaseDeps {
  const repoDir = cfg.repo_dir;
  const repository = cfg.repo;
  const base = cfg.base_branch ?? "main";
  const runCommand = io.command ?? command;
  const git = (args: string[], cwd = repoDir) => runCommand(cwd, "git", args);
  const gh = (args: string[], cwd = repoDir) => runCommand(cwd, "gh", args);
  const publicationAttempts = io.publicationAttempts ?? RELEASE_PUBLICATION_ATTEMPTS;
  const dispatchObserveAttempts = io.dispatchObserveAttempts ?? RELEASE_DISPATCH_OBSERVE_ATTEMPTS;
  const waitFn = io.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const finishPr = io.finishReleasePr ?? ((pr, expected) =>
    finishReleasePr(pr, realReleaseFinishDeps(repository, repoDir), expected));
  async function loadExactPublisherRuns(tag: string, candidate: string): Promise<PublisherRunRow[]> {
    const sha = exactOid(candidate, `${tag} publisher candidate`);
    const raw = JSON.parse(await gh([
      "api", "--paginate", "--slurp",
      `repos/${repository}/actions/workflows/release.yml/runs?per_page=100&head_sha=${sha}`,
    ])) as unknown;
    return parsePublisherWorkflowRunPages(raw, tag);
  }
  async function defaultLoadPublisherRecoveryEpisode(key: {
    workflow: "release.yml";
    tag: string;
    candidate: string;
  }): Promise<unknown> {
    try {
      return JSON.parse(await fs.promises.readFile(publisherRecoveryPath(repoDir, key.tag, key.candidate), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function loadPublisherRecoveryEpisode(tag: string, candidate: string): Promise<PublisherRecoveryEpisode | null> {
    const key = { workflow: "release.yml" as const, tag, candidate: exactOid(candidate, `${tag} publisher recovery candidate`) };
    const raw = io.loadPublisherRecoveryEpisode
      ? await io.loadPublisherRecoveryEpisode(key)
      : await defaultLoadPublisherRecoveryEpisode(key);
    if (raw == null) return null;
    return parsePublisherRecoveryEpisode(raw, key);
  }
  async function persistPublisherRecoveryEpisode(episode: PublisherRecoveryEpisode): Promise<void> {
    if (io.persistPublisherRecoveryEpisode) {
      await io.persistPublisherRecoveryEpisode(episode);
    } else {
      const dest = publisherRecoveryPath(repoDir, episode.tag, episode.candidate);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp.${process.pid}`;
      await fs.promises.writeFile(tmp, `${JSON.stringify(episode)}\n`, "utf8");
      await fs.promises.rename(tmp, dest);
    }
    const readBack = await loadPublisherRecoveryEpisode(episode.tag, episode.candidate);
    if (
      !readBack ||
      readBack.tag !== episode.tag ||
      readBack.candidate !== episode.candidate ||
      readBack.state !== episode.state ||
      (episode.state === "rerun_requested" && readBack.run_id !== episode.run_id)
    ) {
      throw new Error(`pipeline release: publisher recovery episode for ${episode.tag} at ${episode.candidate} failed read-back`);
    }
  }
  return {
    log: console.error,
    withRunLock: (key, fn) => withLock(key, fn),
    async resolveMilestones(version) {
      const rows = flattenPages(JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repository}/milestones?state=all&per_page=100`])) as unknown, "milestone list");
      const matches = rows.filter((x) => x && typeof x === "object" && [version, `v${version}`].includes(String((x as Record<string, unknown>).title ?? "")));
      const result: CompleteReleaseMilestone[] = [];
      for (const raw of matches) {
        const row = raw as Record<string, unknown>;
        const number = Number(row.number);
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error("pipeline release: milestone has invalid identity");
        const issuesRaw = flattenPages(JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repository}/issues?milestone=${number}&state=all&per_page=100`])) as unknown, "milestone issues");
        const issues: ReleaseMilestoneMember[] = [];
        for (const item of issuesRaw) {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("pipeline release: milestone member has unknown shape");
          const issue = item as Record<string, unknown>;
          if (issue.pull_request) continue;
          const issueNumber = Number(issue.number);
          const state = String(issue.state ?? "").toUpperCase();
          if (!Number.isSafeInteger(issueNumber) || !["OPEN", "CLOSED"].includes(state)) throw new Error("pipeline release: milestone issue identity/state is unknown");
          const detail = parseObject(await gh(["issue", "view", String(issueNumber), "--repo", repository, "--json", "closedByPullRequestsReferences"]), `issue #${issueNumber}`);
          if (!Array.isArray(detail.closedByPullRequestsReferences)) throw new Error(`pipeline release: issue #${issueNumber} closing PR shape is unknown`);
          const prs: ReleaseImplementationPr[] = [];
          for (const ref of detail.closedByPullRequestsReferences) {
            if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error(`pipeline release: issue #${issueNumber} closing PR identity is unknown`);
            const prNumber = Number((ref as Record<string, unknown>).number);
            const pr = parseObject(await gh(["pr", "view", String(prNumber), "--repo", repository, "--json", "number,state,baseRefName,mergeCommit"]), `PR #${prNumber}`);
            if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !["OPEN", "CLOSED", "MERGED"].includes(String(pr.state))) {
              throw new Error(`pipeline release: issue #${issueNumber} closing PR state/identity is unknown`);
            }
            const merge = pr.mergeCommit && typeof pr.mergeCommit === "object" ? String((pr.mergeCommit as Record<string, unknown>).oid ?? "") : null;
            prs.push({ number: prNumber, state: String(pr.state) as ReleaseImplementationPr["state"], base: String(pr.baseRefName), merge_commit_oid: merge || null });
          }
          issues.push({ number: issueNumber, state: state as "OPEN" | "CLOSED", implementation_prs: prs });
        }
        result.push({ number, title: String(row.title), issues });
      }
      return result;
    },
    observeOriginHead: async (branch) => {
      await git(["fetch", "origin", branch]);
      return git(["rev-parse", `origin/${branch}`]);
    },
    commitContained: async (commit, head) => {
      try { await git(["merge-base", "--is-ancestor", commit, head]); return true; } catch { return false; }
    },
    async versionsAt(commit) {
      const root = JSON.parse(await git(["show", `${commit}:package.json`])) as { version?: unknown };
      const core = JSON.parse(await git(["show", `${commit}:core/package.json`])) as { version?: unknown };
      return { root: String(root.version ?? ""), core: String(core.version ?? "") };
    },
    async observeAuthenticatedActor() {
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      if (!login) throw new Error("pipeline release: authenticated GitHub actor is missing");
      return login;
    },
    async observeMetadata(version, branch) {
      const raw = JSON.parse(await gh([
        "pr", "list", "--repo", repository, "--state", "all",
        "--search", `release: ${version}`,
        "--json", METADATA_PR_JSON_FIELDS,
        "--limit", "100",
      ])) as unknown;
      if (!Array.isArray(raw)) throw new Error("pipeline release: metadata PR list returned unknown shape");
      const matches = raw.filter((x) => x && typeof x === "object" && isReleaseMetadataTitle((x as Record<string, unknown>).title, version));
      if (matches.length > 1) throw new Error(`pipeline release: multiple metadata PRs claim v${version}`);
      if (matches.length === 0) return null;
      const listedNumber = jsonSafeInteger((matches[0] as Record<string, unknown>).number, 1);
      if (listedNumber === null) {
        throw new Error(`pipeline release: metadata PR for v${version} has invalid identity`);
      }
      const actor = await this.observeAuthenticatedActor();
      const viewed = parseObject(await gh([
        "pr", "view", String(listedNumber), "--repo", repository,
        "--json", METADATA_PR_JSON_FIELDS,
      ]), `metadata PR #${listedNumber}`);
      const parsed = parseReleaseManagedMetadataPr(viewed, {
        version, base: branch, repo: repository, actor, pr: listedNumber,
      });
      await fetchMetadataHead(git, parsed.pr, version, parsed.head_oid);
      const versions = await this.versionsAt(parsed.head_oid);
      if (versions.root !== version || versions.core !== version) {
        throw new Error(`pipeline release: metadata PR #${parsed.pr} does not set both package versions to ${version}`);
      }
      const filesRaw = JSON.parse(await gh([
        "api", "--paginate", "--slurp",
        `repos/${repository}/pulls/${parsed.pr}/files?per_page=100`,
      ])) as unknown;
      try { assertReleaseManagedMetadataPaths(parsePullRequestChangedFiles(filesRaw, parsed.pr)); }
      catch { throw new Error(`pipeline release: metadata PR #${parsed.pr} contains non-release-managed paths`); }
      if (parsed.state === "MERGED") {
        const checksRaw = JSON.parse(await gh([
          "api", `repos/${repository}/commits/${parsed.head_oid}/check-runs?per_page=100`, "--paginate", "--slurp",
        ])) as unknown;
        if (exactHeadCheckRunsState(checksRaw, parsed.head_oid) !== "pass") {
          throw new Error(`pipeline release: metadata PR #${parsed.pr} has no nonempty green exact-head CI at ${parsed.head_oid}`);
        }
      }
      return parsed;
    },
    async prepareMetadata(version, branch, opts) {
      const primary = primaryWorktreeFromPorcelain(await git(["worktree", "list", "--porcelain"]));
      if (!primary || !path.isAbsolute(primary)) {
        throw new Error("pipeline release: cannot resolve the primary worktree for metadata preparation");
      }
      const worktree = path.join(primary, ".worktrees", `release+v${version}`);
      if (fs.existsSync(worktree)) {
        const registered = (await git(["worktree", "list", "--porcelain"], primary)).split("\n\n")
          .some((entry) => entry.split("\n")[0] === `worktree ${worktree}`);
        if (!registered) throw new Error(`pipeline release: metadata worktree path exists but is not registered: ${worktree}`);
        const status = await git(["status", "--porcelain"], worktree);
        const branchName = await git(["branch", "--show-current"], worktree);
        if (status || (branchName && branchName !== `release/v${version}`)) {
          throw new Error(`pipeline release: retained metadata worktree is not a clean release/v${version} checkout: ${worktree}`);
        }
        if (!branchName) {
          const retainedHead = exactOid(await git(["rev-parse", "HEAD"], worktree), "retained metadata worktree head");
          const expectedBase = exactOid(await git(["rev-parse", `origin/${branch}`], primary), `origin/${branch}`);
          if (retainedHead !== expectedBase) {
            throw new Error(`pipeline release: retained metadata worktree is not based at current origin/${branch}`);
          }
        } else {
          const retainedHead = exactOid(await git(["rev-parse", "HEAD"], worktree), "retained metadata branch head");
          const retainedVersions = await this.versionsAt(retainedHead);
          if (retainedVersions.root === version && retainedVersions.core === version) {
            const changed = (await git(["diff", "--name-only", `origin/${branch}...${retainedHead}`], worktree)).split("\n").filter(Boolean);
            assertReleaseManagedMetadataPaths(changed);
            const remote = await git(["ls-remote", "--heads", "origin", `refs/heads/release/v${version}`], worktree);
            if (remote) {
              const remoteHead = exactOid(remote.split(/\s+/)[0] ?? "", "retained remote metadata head");
              if (remoteHead !== retainedHead) throw new Error(`pipeline release: retained release/v${version} conflicts with its remote branch`);
            } else {
              await git(["push", "-u", "origin", `release/v${version}`], worktree);
            }
            const created = await gh([
              "pr", "create", "--repo", repository, "--base", branch, "--head", `release/v${version}`,
              "--title", releaseMetadataTitle(version),
              "--body", `Version metadata only for v${version}. The invoking complete release continues with exact-head CI, merge, exact-candidate FRG, annotated tag, and publication verification.\n\n${RELEASE_METADATA_PROVENANCE_MARKER}`,
            ], worktree);
            const match = created.match(/\/pull\/(\d+)/);
            if (!match) throw new Error("pipeline release: retained metadata PR creation returned no PR identity");
            return { schema_version: 1, kind: "release_prepare", version, pr: Number(match[1]), base: branch, head_oid: retainedHead };
          }
          const expectedBase = exactOid(await git(["rev-parse", `origin/${branch}`], primary), `origin/${branch}`);
          if (retainedHead !== expectedBase) throw new Error(`pipeline release: retained metadata branch has an unknown partial state`);
          await git(["checkout", "--detach", `origin/${branch}`], worktree);
          await git(["branch", "-D", `release/v${version}`], worktree);
        }
      } else {
        await git(["worktree", "add", "--detach", worktree, `origin/${branch}`], primary);
      }
      const releaseDeps = realReleaseDeps(worktree);
      // Complete-release stdout is reserved for its one terminal JSON document.
      releaseDeps.stdout = console.error;
      releaseDeps.stderr = console.error;
      const result = await runRelease(version, { ...opts, noEdit: true, skipFrg: true, dedicatedWorktree: true }, { ...cfg, repo_dir: worktree, base_branch: branch }, releaseDeps);
      if (!result) throw new Error("pipeline release: metadata prepare returned no identity");
      return result;
    },
    async finishMetadata(release) {
      await fetchMetadataHead(git, release.pr, release.version, exactOid(release.head_oid, "metadata PR head"));
      const versions = await this.versionsAt(release.head_oid);
      if (versions.root !== release.version || versions.core !== release.version) {
        throw new Error(`pipeline release: metadata PR #${release.pr} does not set both package versions to ${release.version}`);
      }
      const changed = (await git(["diff", "--name-only", `origin/${release.base}...${release.head_oid}`]))
        .split("\n").filter(Boolean);
      try { assertReleaseManagedMetadataPaths(changed); }
      catch { throw new Error(`pipeline release: metadata PR #${release.pr} contains non-release-managed paths`); }
      const observeManaged = async () => {
        const actor = (await gh(["api", "user", "--jq", ".login"])).trim();
        if (!actor) throw new Error("pipeline release: authenticated GitHub actor is missing");
        const viewed = parseObject(await gh([
          "pr", "view", String(release.pr), "--repo", repository, "--json", METADATA_PR_JSON_FIELDS,
        ]), `metadata PR #${release.pr}`);
        const parsed = parseReleaseManagedMetadataPr(viewed, {
          version: release.version, base: release.base, repo: repository, actor, pr: release.pr,
        });
        if (parsed.head_oid !== release.head_oid) {
          throw new Error(`pipeline release: metadata PR #${release.pr} identity changed during CI wait`);
        }
        return parsed;
      };
      for (let attempt = 1; attempt <= publicationAttempts; attempt++) {
        const observed = await observeManaged();
        const checksRaw = JSON.parse(await gh([
          "api", `repos/${repository}/commits/${release.head_oid}/check-runs?per_page=100`, "--paginate", "--slurp",
        ])) as unknown;
        const checkState = exactHeadCheckRunsState(checksRaw, release.head_oid);
        if (checkState === "fail") {
          throw new Error(`pipeline release: metadata PR #${release.pr} has failing checks at exact head ${release.head_oid}`);
        }
        if (observed.state === "MERGED") {
          if (checkState !== "pass") {
            throw new Error(`pipeline release: metadata PR #${release.pr} has no nonempty green exact-head CI at ${release.head_oid}`);
          }
          return observed;
        }
        if (checkState === "pass") break;
        if (attempt === publicationAttempts) throw new Error(`pipeline release: timed out waiting for nonempty green metadata checks on PR #${release.pr}`);
        await waitFn(RELEASE_PUBLICATION_WAIT_MS);
      }
      const preMerge = await observeManaged();
      if (preMerge.state === "MERGED") {
        const mergedChecksRaw = JSON.parse(await gh([
          "api", `repos/${repository}/commits/${release.head_oid}/check-runs?per_page=100`, "--paginate", "--slurp",
        ])) as unknown;
        if (exactHeadCheckRunsState(mergedChecksRaw, release.head_oid) !== "pass") {
          throw new Error(`pipeline release: metadata PR #${release.pr} has no nonempty green exact-head CI at ${release.head_oid}`);
        }
        return preMerge;
      }
      const finished = await finishPr(release.pr, { pr: release.pr, version: release.version, base: release.base, head_oid: release.head_oid });
      if (!finished.mergeCommitOid) throw new Error("pipeline release: metadata merge returned no merge commit");
      return { ...preMerge, state: "MERGED", merge_commit_oid: finished.mergeCommitOid };
    },
    async runExactFrg(version, candidate, branch) {
      const result = await runProductionExactCandidateFrg({ repoDir, repository, baseBranch: branch, releaseVersion: version, expectedCandidateSha: candidate });
      return result;
    },
    async observeExactFrg(version, candidate, branch) {
      return observeProductionExactCandidateFrgPass(
        { repoDir, repository, baseBranch: branch, releaseVersion: version, expectedCandidateSha: candidate },
        candidate,
      );
    },
    verifyExactFrg(record, candidate) {
      verifyExactCandidateFrgResult(record, { epoch_id: record.epoch_id, candidate_sha: candidate });
    },
    async observeTag(tag) {
      const ls = await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
      if (!ls) return null;
      const lines = ls.split("\n").map((line) => line.trim().split(/\s+/));
      const direct = lines.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0] ?? "";
      const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ?? "";
      if (!peeled) return { annotated: false, peeled_commit: direct, annotation: "" };
      const observeRef = `refs/pipeline/release-observe/${tag}`;
      await git(["fetch", "--force", "origin", `refs/tags/${tag}:${observeRef}`]);
      const fetchedObject = exactOid(await git(["rev-parse", observeRef]), `${tag} fetched tag object`);
      if (fetchedObject !== exactOid(direct, `${tag} remote tag object`)) {
        throw new Error(`pipeline release: ${tag} moved while its immutable identity was observed`);
      }
      if (await git(["cat-file", "-t", observeRef]) !== "tag") {
        throw new Error(`pipeline release: ${tag} is not an annotated tag`);
      }
      const fetchedPeeled = exactOid(await git(["rev-parse", `${observeRef}^{}`]), `${tag} fetched peeled commit`);
      if (fetchedPeeled !== exactOid(peeled, `${tag} remote peeled commit`)) {
        throw new Error(`pipeline release: ${tag} peeled identity moved during observation`);
      }
      const annotation = await git(["for-each-ref", "--format=%(contents)", observeRef]);
      return { annotated: true, peeled_commit: fetchedPeeled, annotation: annotation.trim() };
    },
    async createAnnotatedTag(tag, candidate, notes) {
      const local = `refs/tags/${tag}`;
      let localExists = false;
      try { await git(["rev-parse", "--verify", local]); localExists = true; } catch {}
      if (localExists) {
        const kind = await git(["cat-file", "-t", local]);
        const peeled = exactOid(await git(["rev-parse", `${local}^{}`]), `${tag} local peeled commit`);
        const annotation = (await git(["for-each-ref", "--format=%(contents)", local])).trim();
        if (kind !== "tag" || peeled !== candidate || annotation !== notes.trim()) {
          throw new Error(`pipeline release: local ${tag} conflicts with candidate/notes; refusing force or delete`);
        }
      } else {
        await git(["tag", "-a", tag, candidate, "-m", notes]);
      }
      try {
        await git(["push", "origin", local]);
      } catch (error) {
        const raced = await this.observeTag(tag);
        if (raced?.annotated && exactOid(raced.peeled_commit, `${tag} raced peeled commit`) === candidate &&
            raced.annotation.trim() === notes.trim()) return;
        throw error;
      }
    },
    async observePublication(tag) {
      let releaseRaw: string;
      try {
        releaseRaw = await gh(["api", `repos/${repository}/releases/tags/${tag}`]);
      } catch (err) {
        const message = (err as Error).message;
        if (isAuthoritativeReleaseNotFound(message)) return null;
        throw new Error(`pipeline release: GitHub Release ${tag} observation is unknown: ${message}`);
      }
      {
        const row = parseObject(releaseRaw, `GitHub Release ${tag}`);
        const tagName = String(row.tag_name ?? "");
        const htmlUrl = String(row.html_url ?? "");
        if (tagName !== tag || typeof row.draft !== "boolean" || typeof row.prerelease !== "boolean" ||
            (row.published_at !== null && typeof row.published_at !== "string") || typeof row.body !== "string" ||
            typeof row.name !== "string" || !htmlUrl.trim()) {
          throw new Error(`pipeline release: GitHub Release ${tag} returned unknown shape`);
        }
        const tagObservation = await this.observeTag(tag);
        if (!tagObservation) throw new Error(`pipeline release: GitHub Release ${tag} exists without an observable tag`);
        if (row.prerelease || row.name !== tag || String(row.body).trim() !== tagObservation.annotation.trim()) {
          throw new Error(`pipeline release: GitHub Release ${tag} metadata/notes do not match its annotated tag`);
        }
        const runs = await loadExactPublisherRuns(tag, tagObservation.peeled_commit);
        const conclusion = selectExactPublisherConclusion(runs, tag, tagObservation.peeled_commit);
        return { tag, draft: row.draft, published_at: row.published_at as string | null, workflow_conclusion: conclusion };
      }
    },
    async recoverPublication(tag, candidate) {
      const classified = classifyPublisherRuns(await loadExactPublisherRuns(tag, candidate), tag, candidate);
      if (classified.class === "successful" || classified.class === "pending") return false;
      if (classified.class === "unknown") {
        throw new Error(`pipeline release: exact ${tag} publisher run status/conclusion is unknown`);
      }
      if (classified.class === "failed") {
        const newest = [...classified.exact].sort((a, b) => b.databaseId - a.databaseId)[0]!;
        if (newest.attempt > 1) {
          throw new Error(`pipeline release: exact ${tag} publisher run ${newest.databaseId} already reran (attempt ${newest.attempt})`);
        }
        const episode = await loadPublisherRecoveryEpisode(tag, candidate);
        if (episode?.state === "rerun_requested") {
          if (episode.run_id !== newest.databaseId) {
            throw new Error(
              `pipeline release: publisher recovery episode for ${tag} at ${candidate} records rerun of run ${episode.run_id}, not ${newest.databaseId}`,
            );
          }
          return true;
        }
        await persistPublisherRecoveryEpisode({
          schema_version: 1,
          workflow: "release.yml",
          tag,
          candidate: exactOid(candidate, `${tag} publisher recovery candidate`),
          state: "rerun_requested",
          run_id: newest.databaseId,
        });
        await gh(["run", "rerun", String(newest.databaseId), "--repo", repository]);
        return true;
      }
      const tagObservation = await this.observeTag(tag);
      if (!tagObservation?.annotated || exactOid(tagObservation.peeled_commit, `${tag} peeled commit`) !== candidate) {
        throw new Error(`pipeline release: refusing recovery dispatch; remote ${tag} is not the annotated tag at ${candidate}`);
      }
      const head = exactOid(await this.observeOriginHead(base), `origin/${base}`);
      if (head !== candidate) throw new Error(TAGGED_STALE_C_MESSAGE);
      const episode = await loadPublisherRecoveryEpisode(tag, candidate);
      if (!episode) {
        await persistPublisherRecoveryEpisode({
          schema_version: 1,
          workflow: "release.yml",
          tag,
          candidate: exactOid(candidate, `${tag} publisher recovery candidate`),
          state: "dispatched",
        });
        await gh([
          "workflow", "run", "release.yml", "--repo", repository, "--ref", tag,
          "-f", `tag=${tag}`, "-f", `candidate=${candidate}`,
        ]);
      }
      for (let attempt = 1; attempt <= dispatchObserveAttempts; attempt++) {
        await waitFn(RELEASE_PUBLICATION_WAIT_MS);
        const observed = classifyPublisherRuns(await loadExactPublisherRuns(tag, candidate), tag, candidate);
        if (observed.class !== "absent") return true;
      }
      throw new Error(
        `pipeline release: recovery dispatch for ${tag} at ${candidate} did not become an observable exact-identity release.yml run`,
      );
    },
    wait: waitFn,
    publicationAttempts,
    dispatchObserveAttempts,
  };
}
