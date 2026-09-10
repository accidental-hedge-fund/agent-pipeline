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

export interface PublisherRecoveryObservation {
  exact_run_id: number | null;
  conclusion: "success" | "failure" | "pending";
}

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
    // Tag C is immutable release identity even while its publisher is pending,
    // failed, or left a draft. Resume only that publisher; never re-enter
    // mutable milestone/metadata/fixture/tag phases for a tagged candidate.
    const attempts = deps.publicationAttempts ?? RELEASE_PUBLICATION_ATTEMPTS;
    let recoveryAttempted = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const resumed = await deps.observePublication(`v${version}`);
      if (resumed && !resumed.draft && resumed.published_at && resumed.workflow_conclusion === "success") {
        return {
          schema_version: 1, kind: "release_complete", version, candidate_sha: taggedCandidate,
          metadata_pr: null, frg_epoch_id: durableFrg.epoch_id,
          tag: `v${version}`, published_at: resumed.published_at, already_complete: true,
        };
      }
      if (!recoveryAttempted) recoveryAttempted = await deps.recoverPublication(`v${version}`, taggedCandidate);
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

  if (beforePrepare.core !== version && !metadata) {
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
  let recoveryAttempted = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const publication = await deps.observePublication(tag);
    if (publication) {
      if (publication.tag !== tag) throw new Error("pipeline release: GitHub Release tag identity changed");
      if (publication.draft || !publication.published_at || publication.workflow_conclusion !== "success") {
        if (!recoveryAttempted) recoveryAttempted = await deps.recoverPublication(tag, candidate);
        if (attempt === attempts) throw new Error(`pipeline release: GitHub Release ${tag} remains draft or unpublished`);
      } else {
        return {
          schema_version: 1, kind: "release_complete", version, candidate_sha: candidate,
          metadata_pr: null, frg_epoch_id: frg.epoch_id,
          tag, published_at: publication.published_at, already_complete: true,
        };
      }
    } else if (!recoveryAttempted) recoveryAttempted = await deps.recoverPublication(tag, candidate);
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
  const { stdout } = await execFileAsync(file, args, { cwd, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
  return String(stdout).trim();
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

export function selectExactPublisherConclusion(
  rows: unknown,
  tag: string,
  candidate: string,
): "success" | "failure" | "pending" {
  if (!Array.isArray(rows)) throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
  const exact = rows.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return row.event === "push" && row.headBranch === tag && String(row.headSha ?? "").toLowerCase() === candidate;
  });
  if (exact.some((value) => {
    const row = value as Record<string, unknown>;
    return row.status === "completed" && row.conclusion === "success";
  })) return "success";
  if (exact.length === 0 || exact.some((value) => (value as Record<string, unknown>).status !== "completed")) return "pending";
  return "failure";
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
      const raw = JSON.parse(await gh(["pr", "list", "--repo", repository, "--state", "all", "--head", `release/v${version}`, "--json", "number,state,baseRefName,headRefOid,mergeCommit,title", "--limit", "100"])) as unknown;
      if (!Array.isArray(raw)) throw new Error("pipeline release: metadata PR list returned unknown shape");
      const matches = raw.filter((x) => x && typeof x === "object" && String((x as Record<string, unknown>).title ?? "").startsWith(`release: ${version} —`));
      if (matches.length > 1) throw new Error(`pipeline release: multiple metadata PRs claim v${version}`);
      if (matches.length === 0) return null;
      const row = matches[0] as Record<string, unknown>;
      const state = String(row.state);
      if (state !== "OPEN" && state !== "MERGED") throw new Error(`pipeline release: metadata PR for v${version} is closed without merge`);
      const merge = row.mergeCommit && typeof row.mergeCommit === "object" ? String((row.mergeCommit as Record<string, unknown>).oid ?? "") : null;
      return { pr: Number(row.number), version, base: String(row.baseRefName), head_oid: String(row.headRefOid), state, merge_commit_oid: merge || null };
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
      await git(["fetch", "origin", `refs/heads/release/v${release.version}:refs/pipeline/release-metadata/v${release.version}`]);
      const fetchedHead = exactOid(await git(["rev-parse", `refs/pipeline/release-metadata/v${release.version}`]), "fetched metadata head");
      if (fetchedHead !== exactOid(release.head_oid, "metadata PR head")) {
        throw new Error(`pipeline release: metadata PR #${release.pr} head changed before validation`);
      }
      const versions = await this.versionsAt(fetchedHead);
      if (versions.root !== release.version || versions.core !== release.version) {
        throw new Error(`pipeline release: metadata PR #${release.pr} does not set both package versions to ${release.version}`);
      }
      const changed = (await git(["diff", "--name-only", `origin/${release.base}...${fetchedHead}`]))
        .split("\n").filter(Boolean);
      try { assertReleaseManagedMetadataPaths(changed); }
      catch { throw new Error(`pipeline release: metadata PR #${release.pr} contains non-release-managed paths`); }
      for (let attempt = 1; attempt <= RELEASE_PUBLICATION_ATTEMPTS; attempt++) {
        const observed = parseObject(await gh(["pr", "view", String(release.pr), "--repo", repository, "--json", "state,headRefOid,baseRefName"]), `metadata PR #${release.pr}`);
        if (String(observed.headRefOid).toLowerCase() !== release.head_oid.toLowerCase() || observed.baseRefName !== release.base) {
          throw new Error(`pipeline release: metadata PR #${release.pr} identity changed during CI wait`);
        }
        if (observed.state === "MERGED") break;
        let checksRaw: string;
        try {
          checksRaw = await gh(["pr", "checks", String(release.pr), "--repo", repository, "--json", "name,bucket"]);
        } catch (error) {
          const message = (error as Error).message;
          if (/no checks reported/i.test(message)) checksRaw = "[]";
          else throw error;
        }
        const checks = JSON.parse(checksRaw);
        const checkState = metadataChecksState(checks);
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
        releaseRaw = await gh(["release", "view", tag, "--repo", repository, "--json", "tagName,isDraft,isPrerelease,publishedAt,body,name,url"]);
      } catch (err) {
        const message = (err as Error).message;
        if (/release not found/i.test(message)) return null;
        throw err;
      }
      {
        const row = parseObject(releaseRaw, `GitHub Release ${tag}`);
        if (String(row.tagName) !== tag || typeof row.isDraft !== "boolean" || typeof row.isPrerelease !== "boolean" ||
            (row.publishedAt !== null && typeof row.publishedAt !== "string") || typeof row.body !== "string" ||
            typeof row.name !== "string" || typeof row.url !== "string") {
          throw new Error(`pipeline release: GitHub Release ${tag} returned unknown shape`);
        }
        const tagObservation = await this.observeTag(tag);
        if (!tagObservation) throw new Error(`pipeline release: GitHub Release ${tag} exists without an observable tag`);
        if (row.isPrerelease || !row.url.trim() || row.name !== tag || row.body.trim() !== tagObservation.annotation.trim()) {
          throw new Error(`pipeline release: GitHub Release ${tag} metadata/notes do not match its annotated tag`);
        }
        const runs = JSON.parse(await gh(["run", "list", "--repo", repository, "--workflow", "release.yml", "--event", "push", "--branch", tag, "--json", "headSha,headBranch,event,status,conclusion", "--limit", "20"])) as unknown;
        const conclusion = selectExactPublisherConclusion(runs, tag, tagObservation.peeled_commit);
        return { tag, draft: row.isDraft, published_at: row.publishedAt as string | null, workflow_conclusion: conclusion };
      }
    },
    async recoverPublication(tag, candidate) {
      const runs = JSON.parse(await gh(["run", "list", "--repo", repository, "--workflow", "release.yml", "--event", "push", "--branch", tag, "--json", "databaseId,headSha,headBranch,event,status,conclusion", "--limit", "20"])) as unknown;
      if (!Array.isArray(runs)) throw new Error(`pipeline release: ${tag} publisher workflow list returned unknown shape`);
      const exact = runs.filter((value) => value && typeof value === "object" && !Array.isArray(value) &&
        (value as Record<string, unknown>).event === "push" && (value as Record<string, unknown>).headBranch === tag &&
        String((value as Record<string, unknown>).headSha ?? "").toLowerCase() === candidate &&
        (value as Record<string, unknown>).status === "completed") as Record<string, unknown>[];
      const rerunnable = exact.find((value) => value.conclusion !== "success") ?? exact.find((value) => value.conclusion === "success");
      if (!rerunnable) return false;
      const id = Number(rerunnable.databaseId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`pipeline release: failed ${tag} publisher has invalid run identity`);
      await gh(["run", "rerun", String(id), "--repo", repository]);
      return true;
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
