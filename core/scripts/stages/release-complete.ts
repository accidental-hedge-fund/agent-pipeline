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

export type PublisherRemoteClass = "absent" | "pending" | "failed" | "successful";

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
    if (publication && !publication.draft && publication.published_at && publication.workflow_conclusion === "success") {
      return {
        schema_version: 1, kind: "release_complete", version, candidate_sha: taggedCandidate,
        metadata_pr: null, frg_epoch_id: durableFrg.epoch_id,
        tag: `v${version}`, published_at: publication.published_at, already_complete: true,
      };
    }
    // Tag C is immutable even while publication is incomplete. Later main
    // movement without a verified Release is tagged-stale-C, not a docs-refresh
    // completion, and never retags or recreates fixtures.
    const taggedHead = exactOid(await deps.observeOriginHead(base), `origin/${base}`);
    if (taggedHead !== taggedCandidate) throw new Error(TAGGED_STALE_C_MESSAGE);
    const attempts = deps.publicationAttempts ?? RELEASE_PUBLICATION_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const stillHead = exactOid(await deps.observeOriginHead(base), `origin/${base}`);
      if (stillHead !== taggedCandidate) throw new Error(TAGGED_STALE_C_MESSAGE);
      const resumed = await deps.observePublication(`v${version}`);
      if (resumed && !resumed.draft && resumed.published_at && resumed.workflow_conclusion === "success") {
        return {
          schema_version: 1, kind: "release_complete", version, candidate_sha: taggedCandidate,
          metadata_pr: null, frg_epoch_id: durableFrg.epoch_id,
          tag: `v${version}`, published_at: resumed.published_at, already_complete: true,
        };
      }
      await deps.recoverPublication(`v${version}`, taggedCandidate);
      if (attempt < attempts) await deps.wait(RELEASE_PUBLICATION_WAIT_MS);
    }
    throw new Error(`pipeline release: timed out resuming publisher for v${version} at ${taggedCandidate}`);
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

  if (!existingTag) {
    const notes = releaseTagNotes(version, candidate);
    await deps.createAnnotatedTag(tag, candidate, notes);
  }
  const verifiedTag = await deps.observeTag(tag);
  if (!verifiedTag || !verifiedTag.annotated || exactOid(verifiedTag.peeled_commit, `${tag} peeled commit`) !== candidate ||
      verifiedTag.annotation.trim() !== releaseTagNotes(version, candidate)) {
    throw new Error(`pipeline release: ${tag} was not observed as an annotated tag at candidate ${candidate}`);
  }

  const attempts = deps.publicationAttempts ?? RELEASE_PUBLICATION_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const stillHead = exactOid(await deps.observeOriginHead(base), `origin/${base}`);
    if (stillHead !== candidate) throw new Error(TAGGED_STALE_C_MESSAGE);
    const publication = await deps.observePublication(tag);
    if (publication) {
      if (publication.tag !== tag) throw new Error("pipeline release: GitHub Release tag identity changed");
      if (publication.draft || !publication.published_at || publication.workflow_conclusion !== "success") {
        await deps.recoverPublication(tag, candidate);
        if (attempt === attempts) throw new Error(`pipeline release: GitHub Release ${tag} remains draft or unpublished`);
      } else {
        return {
          schema_version: 1, kind: "release_complete", version, candidate_sha: candidate,
          metadata_pr: null, frg_epoch_id: frg.epoch_id,
          tag, published_at: publication.published_at, already_complete: true,
        };
      }
    } else {
      await deps.recoverPublication(tag, candidate);
    }
    if (attempt < attempts) await deps.wait(RELEASE_PUBLICATION_WAIT_MS);
  }
  throw new Error(`pipeline release: timed out waiting for published GitHub Release ${tag}`);
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
    const databaseId = Number(row.databaseId);
    const attempt = Number(row.attempt);
    const headSha = String(row.headSha ?? "").toLowerCase();
    if (!Number.isSafeInteger(databaseId) || databaseId <= 0 || !Number.isSafeInteger(attempt) || attempt < 1 ||
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

export function exactPublisherRuns(rows: readonly PublisherRunRow[], tag: string, candidate: string): PublisherRunRow[] {
  const sha = candidate.toLowerCase();
  return rows.filter((row) =>
    (row.event === "push" || row.event === "workflow_dispatch") &&
    row.headBranch === tag && row.headSha === sha);
}

export function classifyPublisherRuns(
  rows: unknown,
  tag: string,
  candidate: string,
): { class: PublisherRemoteClass; exact: PublisherRunRow[] } {
  const parsed = parsePublisherRunRows(rows, tag);
  if (parsed.length >= 100) {
    throw new Error(`pipeline release: ${tag} publisher workflow list is truncated`);
  }
  const exact = exactPublisherRuns(parsed, tag, candidate);
  if (exact.some((row) => row.status === "completed" && row.conclusion === "success")) {
    return { class: "successful", exact };
  }
  if (exact.length === 0) return { class: "absent", exact };
  if (exact.some((row) => row.status !== "completed")) return { class: "pending", exact };
  return { class: "failed", exact };
}

export function selectExactPublisherConclusion(
  rows: unknown,
  tag: string,
  candidate: string,
): "success" | "failure" | "pending" {
  const classified = classifyPublisherRuns(rows, tag, candidate);
  if (classified.class === "successful") return "success";
  if (classified.class === "failed") return "failure";
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

export function assertReleaseManagedMetadataPaths(files: readonly string[]): void {
  const allowed = new Set([
    "package.json", "core/package.json", "ROADMAP.md",
    "hosts/claude/SKILL.md", "hosts/codex/SKILL.md", "hosts/grok/SKILL.md", "hosts/opencode/SKILL.md",
  ]);
  if (files.length === 0 || files.some((file) => !allowed.has(file))) {
    throw new Error("pipeline release: metadata PR contains non-release-managed paths");
  }
}

/** Production adapter. Tests inject the complete seam and never touch git/GitHub. */
export function realCompleteReleaseDeps(
  cfg: { repo_dir: string; repo: string; base_branch?: string },
  io: { command?: (cwd: string, file: string, args: string[]) => Promise<string> } = {},
): CompleteReleaseDeps {
  const repoDir = cfg.repo_dir;
  const repository = cfg.repo;
  const base = cfg.base_branch ?? "main";
  const runCommand = io.command ?? command;
  const git = (args: string[], cwd = repoDir) => runCommand(cwd, "git", args);
  const gh = (args: string[], cwd = repoDir) => runCommand(cwd, "gh", args);
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
    async observeMetadata(version, branch) {
      const raw = JSON.parse(await gh([
        "pr", "list", "--repo", repository, "--state", "all",
        "--search", `release: ${version}`,
        "--json", "number,state,baseRefName,headRefOid,mergeCommit,title",
        "--limit", "100",
      ])) as unknown;
      if (!Array.isArray(raw)) throw new Error("pipeline release: metadata PR list returned unknown shape");
      const matches = raw.filter((x) => x && typeof x === "object" && String((x as Record<string, unknown>).title ?? "").startsWith(`release: ${version} —`));
      if (matches.length > 1) throw new Error(`pipeline release: multiple metadata PRs claim v${version}`);
      if (matches.length === 0) return null;
      const row = matches[0] as Record<string, unknown>;
      const prNumber = Number(row.number);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error(`pipeline release: metadata PR for v${version} has invalid identity`);
      const viewed = parseObject(await gh([
        "pr", "view", String(prNumber), "--repo", repository,
        "--json", "number,state,baseRefName,headRefOid,mergeCommit,title",
      ]), `metadata PR #${prNumber}`);
      const state = String(viewed.state);
      if (state !== "OPEN" && state !== "MERGED") throw new Error(`pipeline release: metadata PR for v${version} is closed without merge`);
      const headOid = exactOid(String(viewed.headRefOid ?? ""), `metadata PR #${prNumber} head`);
      const merge = viewed.mergeCommit && typeof viewed.mergeCommit === "object"
        ? String((viewed.mergeCommit as Record<string, unknown>).oid ?? "") : null;
      await fetchMetadataHead(git, prNumber, version, headOid);
      const versions = await this.versionsAt(headOid);
      if (versions.root !== version || versions.core !== version) {
        throw new Error(`pipeline release: metadata PR #${prNumber} does not set both package versions to ${version}`);
      }
      const changed = (await git(["diff", "--name-only", `origin/${branch}...${headOid}`])).split("\n").filter(Boolean);
      try { assertReleaseManagedMetadataPaths(changed); }
      catch { throw new Error(`pipeline release: metadata PR #${prNumber} contains non-release-managed paths`); }
      if (state === "MERGED") {
        const checksRaw = JSON.parse(await gh([
          "api", `repos/${repository}/commits/${headOid}/check-runs?per_page=100`, "--paginate", "--slurp",
        ])) as unknown;
        if (exactHeadCheckRunsState(checksRaw, headOid) !== "pass") {
          throw new Error(`pipeline release: metadata PR #${prNumber} has no nonempty green exact-head CI at ${headOid}`);
        }
        exactOid(merge ?? "", "metadata merge commit");
      }
      return {
        pr: prNumber, version, base: String(viewed.baseRefName), head_oid: headOid,
        state: state as "OPEN" | "MERGED", merge_commit_oid: merge || null,
      };
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
              "--title", `release: ${version} — version metadata`,
              "--body", `Version metadata only for v${version}. The invoking complete release continues with exact-head CI, merge, exact-candidate FRG, annotated tag, and publication verification.`,
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
      for (let attempt = 1; attempt <= RELEASE_PUBLICATION_ATTEMPTS; attempt++) {
        const observed = parseObject(await gh(["pr", "view", String(release.pr), "--repo", repository, "--json", "state,headRefOid,baseRefName"]), `metadata PR #${release.pr}`);
        if (String(observed.headRefOid).toLowerCase() !== release.head_oid.toLowerCase() || observed.baseRefName !== release.base) {
          throw new Error(`pipeline release: metadata PR #${release.pr} identity changed during CI wait`);
        }
        if (observed.state === "MERGED") break;
        const checksRaw = JSON.parse(await gh([
          "api", `repos/${repository}/commits/${release.head_oid}/check-runs?per_page=100`, "--paginate", "--slurp",
        ])) as unknown;
        const checkState = exactHeadCheckRunsState(checksRaw, release.head_oid);
        if (checkState === "fail") {
          throw new Error(`pipeline release: metadata PR #${release.pr} has failing checks at exact head ${release.head_oid}`);
        }
        if (checkState === "pass") break;
        if (attempt === RELEASE_PUBLICATION_ATTEMPTS) throw new Error(`pipeline release: timed out waiting for nonempty green metadata checks on PR #${release.pr}`);
        await new Promise((resolve) => setTimeout(resolve, RELEASE_PUBLICATION_WAIT_MS));
      }
      const finished = await finishReleasePr(release.pr, realReleaseFinishDeps(repository, repoDir), { pr: release.pr, version: release.version, base: release.base, head_oid: release.head_oid });
      if (!finished.mergeCommitOid) throw new Error("pipeline release: metadata merge returned no merge commit");
      return { ...release, state: "MERGED", merge_commit_oid: finished.mergeCommitOid };
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
        const runs = JSON.parse(await gh([
          "run", "list", "--repo", repository, "--workflow", "release.yml",
          "--json", "databaseId,event,headBranch,headSha,status,conclusion,attempt", "--limit", "100",
        ])) as unknown;
        const conclusion = selectExactPublisherConclusion(runs, tag, tagObservation.peeled_commit);
        return { tag, draft: row.draft, published_at: row.published_at as string | null, workflow_conclusion: conclusion };
      }
    },
    async recoverPublication(tag, candidate) {
      const runs = JSON.parse(await gh([
        "run", "list", "--repo", repository, "--workflow", "release.yml",
        "--json", "databaseId,event,headBranch,headSha,status,conclusion,attempt", "--limit", "100",
      ])) as unknown;
      const classified = classifyPublisherRuns(runs, tag, candidate);
      if (classified.class === "successful" || classified.class === "pending") return false;
      if (classified.class === "failed") {
        const newest = [...classified.exact].sort((a, b) => b.databaseId - a.databaseId)[0]!;
        if (newest.attempt > 1) {
          throw new Error(`pipeline release: exact ${tag} publisher run ${newest.databaseId} already reran (attempt ${newest.attempt})`);
        }
        await gh(["run", "rerun", String(newest.databaseId), "--repo", repository]);
        return true;
      }
      const tagObservation = await this.observeTag(tag);
      if (!tagObservation?.annotated || exactOid(tagObservation.peeled_commit, `${tag} peeled commit`) !== candidate) {
        throw new Error(`pipeline release: refusing recovery dispatch; remote ${tag} is not the annotated tag at ${candidate}`);
      }
      const head = exactOid(await this.observeOriginHead(base), `origin/${base}`);
      if (head !== candidate) throw new Error(TAGGED_STALE_C_MESSAGE);
      await gh([
        "workflow", "run", "release.yml", "--repo", repository, "--ref", tag,
        "-f", `tag=${tag}`, "-f", `candidate=${candidate}`,
      ]);
      return true;
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
