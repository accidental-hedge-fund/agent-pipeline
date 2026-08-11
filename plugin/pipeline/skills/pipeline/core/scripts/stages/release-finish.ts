// Operator-authorized release PR finalizer (factory simplification Phase 3).
//
// Merges an open release PR prepared by `pipeline release` after mergeability
// and check gates. Does NOT create tags or GitHub Releases — those remain the
// existing auto-tag-release + release workflows after the merge lands on base.
//
// After a successful merge, finish MAY best-effort observe the annotated tag
// and invoke the shared post-tag docs refresh helper (#978) when the local
// environment can write the default branch. Heal failure does not unmerge the
// PR; it surfaces a clear retry message. Primary CHANGELOG refresh remains the
// auto-tag workflow path.
//
// Loop-isolated: never called from advance stage dispatch. Distinct from
// `pipeline merge` (issue PRs at ready-to-deploy) because release PRs have no
// pipeline stage label and correctly fail the issue-stage gate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReleaseDocsRefreshResult } from "../release-docs-refresh.ts";

const execFileAsync = promisify(execFile);

/** Matches `release.ts` PR title format; drift-guarded vs auto-tag workflow. */
export const RELEASE_PR_TITLE_RE = /^release: ([0-9]+\.[0-9]+\.[0-9]+) — .+$/;

export interface ReleaseFinishCheck {
  name: string;
  bucket: string;
}

export interface ReleaseFinishDeps {
  log(msg: string): void;
  ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>;
  ghPrChecksRequired(pr: number): Promise<ReleaseFinishCheck[]>;
  ghPrChecksAll(pr: number): Promise<ReleaseFinishCheck[]>;
  /** Squash-merge with exact head binding (same as issue merge surface). */
  ghPrMerge(pr: number, headRefOid: string): Promise<void>;
  /**
   * Optional post-tag docs heal (#978). When provided, finish may call this
   * after a successful merge (or already-merged observation) once the version
   * tag is visible. Must not create tags. Injectable for tests.
   */
  refreshPostTagDocs?: (version: string) => Promise<ReleaseDocsRefreshResult>;
  /**
   * Optional wait/observe for annotated tag `vX.Y.Z` after merge.
   * Return true when the tag is visible and heal may run.
   */
  waitForReleaseTag?: (version: string) => Promise<boolean>;
}

export interface ReleaseFinishResult {
  pr: number;
  version: string;
  title: string;
  headRefOid: string;
  mergeCommitOid: string | null;
  alreadyMerged: boolean;
  /** Present when optional post-tag docs heal ran (or attempted). */
  docsRefresh?: ReleaseDocsRefreshResult | { skipped: true; reason: string };
}

/** Identity emitted by release prepare and required by automated finalizers. */
export interface ReleaseFinishExpectedIdentity {
  pr: number;
  version: string;
  base: string;
  head_oid: string;
}

function validateExpectedIdentity(
  pr: number,
  version: string,
  base: string,
  headOid: string,
  expected: ReleaseFinishExpectedIdentity,
): void {
  if (expected.pr !== pr) {
    throw new Error(
      `release identity PR mismatch: requested #${pr}, expected #${expected.pr}`,
    );
  }
  if (version !== expected.version) {
    throw new Error(
      `PR #${pr} version changed: expected ${expected.version}, observed ${version}`,
    );
  }
  if (base !== expected.base) {
    throw new Error(
      `PR #${pr} base changed: expected ${JSON.stringify(expected.base)}, ` +
        `observed ${JSON.stringify(base)}`,
    );
  }
  if (headOid !== expected.head_oid) {
    throw new Error(
      `PR #${pr} head changed: expected ${expected.head_oid}, observed ${headOid || "(empty)"}`,
    );
  }
}

export function parseReleasePrTitle(title: string): { version: string } | null {
  const m = RELEASE_PR_TITLE_RE.exec(String(title ?? "").trim());
  if (!m || !m[1]) return null;
  return { version: m[1] };
}

function checkMergeability(mergeable: string, mergeStateStatus: string): string | null {
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return `PR is not mergeable (mergeable=${mergeable}, mergeStateStatus=${mergeStateStatus})`;
  }
  if (mergeable === "UNKNOWN" || mergeStateStatus === "UNKNOWN") {
    return `PR mergeability is UNKNOWN — wait for GitHub to compute it and retry`;
  }
  if (mergeable !== "MERGEABLE") {
    return `PR is not MERGEABLE (mergeable=${mergeable}, mergeStateStatus=${mergeStateStatus})`;
  }
  return null;
}

function checkStatusChecks(checks: ReleaseFinishCheck[]): string | null {
  const blocking: string[] = [];
  for (const check of checks) {
    const bucket = (check.bucket ?? "").toLowerCase();
    if (bucket === "fail" || bucket === "pending" || bucket === "cancel") {
      blocking.push(`${check.name ?? "unknown"} (${bucket})`);
    }
  }
  if (blocking.length === 0) return null;
  return (
    `PR has failing or pending required checks:\n` +
    blocking.map((c) => `  - ${c}`).join("\n") +
    `\nFix or wait for the checks to pass, then retry.`
  );
}

/**
 * Optional post-tag docs heal after merge. Never creates tags; never unmerges.
 * When the auto-tag path already committed an identical tree, refresh is a no-op.
 */
async function maybeHealPostTagDocs(
  version: string,
  deps: ReleaseFinishDeps,
): Promise<ReleaseFinishResult["docsRefresh"]> {
  if (!deps.refreshPostTagDocs) {
    return { skipped: true, reason: "no refresh dep configured" };
  }
  if (deps.waitForReleaseTag) {
    deps.log(
      `[pipeline release finish] v${version}: waiting for annotated tag before optional docs heal…`,
    );
    const present = await deps.waitForReleaseTag(version);
    if (!present) {
      deps.log(
        `[pipeline release finish] v${version}: tag not visible yet — ` +
          `skipping local docs heal (auto-tag-release owns primary CHANGELOG refresh).`,
      );
      return { skipped: true, reason: "tag not visible yet" };
    }
  }
  deps.log(
    `[pipeline release finish] v${version}: optional post-tag docs refresh (idempotent if already fresh)…`,
  );
  const result = await deps.refreshPostTagDocs(version);
  if (!result.ok) {
    // Merge already succeeded — do not imply unmerge. Surface a retryable heal error.
    throw new Error(
      `Release PR merge succeeded for v${version}, but post-tag docs refresh failed. ` +
        `The version tag was not deleted. Heal with:\n` +
        `  node scripts/release-docs-refresh.mjs --version ${version} --push\n` +
        `or wait for auto-tag-release's regenerate step. Detail:\n${result.error}`,
    );
  }
  if (result.committed) {
    deps.log(
      `[pipeline release finish] v${version}: docs refresh committed ${result.commitMessage}`,
    );
  } else {
    deps.log(
      `[pipeline release finish] v${version}: docs already fresh after tag — no commit`,
    );
  }
  return result;
}

/**
 * Finish a prepared release PR: validate release title + gates, merge exact head.
 * Does not tag or publish. May optionally heal tag-derived CHANGELOG after tag
 * observation (#978) without owning tag creation.
 */
export async function finishReleasePr(
  pr: number,
  deps: ReleaseFinishDeps,
  expected?: ReleaseFinishExpectedIdentity,
): Promise<ReleaseFinishResult> {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(`invalid PR number ${pr}`);
  }
  if (expected && expected.pr !== pr) {
    throw new Error(
      `release identity PR mismatch: requested #${pr}, expected #${expected.pr}`,
    );
  }

  deps.log(`[pipeline release finish] #${pr}: inspecting…`);
  const data = await deps.ghPrView(pr, [
    "title",
    "state",
    "mergeable",
    "mergeStateStatus",
    "headRefOid",
    "baseRefName",
    "mergedAt",
    "mergeCommit",
  ]);

  const title = String(data.title ?? "");
  const parsed = parseReleasePrTitle(title);
  if (!parsed) {
    throw new Error(
      `PR #${pr} title is not a pipeline release PR.\n` +
        `  Expected: release: X.Y.Z — <theme>\n` +
        `  Actual: ${JSON.stringify(title)}\n` +
        `  Use pipeline merge only for issue PRs at ready-to-deploy; ` +
        `use pipeline release finish only for release PRs from pipeline release.`,
    );
  }

  const baseRefName = String(data.baseRefName ?? "");
  const headRefOid = String(data.headRefOid ?? "");
  if (expected) {
    validateExpectedIdentity(pr, parsed.version, baseRefName, headRefOid, expected);
  }

  const state = String(data.state ?? "").toUpperCase();
  const mergeCommit = data.mergeCommit as { oid?: string } | null | undefined;
  const alreadyMerged =
    state === "MERGED" ||
    (data.mergedAt != null && String(data.mergedAt) !== "" && String(data.mergedAt) !== "null");

  if (alreadyMerged) {
    deps.log(`[pipeline release finish] #${pr}: already merged — idempotent success`);
    const docsRefresh = await maybeHealPostTagDocs(parsed.version, deps);
    return {
      pr,
      version: parsed.version,
      title,
      headRefOid,
      mergeCommitOid: mergeCommit?.oid ?? null,
      alreadyMerged: true,
      docsRefresh,
    };
  }

  if (state !== "OPEN") {
    throw new Error(`PR #${pr} is not open (state=${state})`);
  }

  const mergeabilityError = checkMergeability(
    String(data.mergeable ?? "UNKNOWN"),
    String(data.mergeStateStatus ?? "UNKNOWN"),
  );
  if (mergeabilityError) {
    throw new Error(mergeabilityError);
  }

  if (!headRefOid) {
    throw new Error(`PR #${pr}: empty headRefOid — cannot bind merge`);
  }

  deps.log(`[pipeline release finish] #${pr}: checking status checks…`);
  let requiredChecks: ReleaseFinishCheck[];
  let noRequired = false;
  try {
    requiredChecks = await deps.ghPrChecksRequired(pr);
  } catch (err) {
    const text = `${(err as { stderr?: string; message?: string }).stderr ?? ""} ${(err as Error).message ?? ""}`;
    if (text.includes("no required checks reported")) {
      noRequired = true;
      requiredChecks = [];
    } else {
      throw err;
    }
  }

  if (noRequired) {
    let allChecks: ReleaseFinishCheck[];
    try {
      allChecks = await deps.ghPrChecksAll(pr);
    } catch (err) {
      const text = `${(err as { stderr?: string; message?: string }).stderr ?? ""} ${(err as Error).message ?? ""}`;
      if (text.includes("no checks reported")) {
        allChecks = [];
      } else {
        throw err;
      }
    }
    const checksError = checkStatusChecks(allChecks);
    if (checksError) {
      throw new Error(
        `No required checks configured, but observable checks are not green:\n` +
          checksError.replace(/^PR has failing or pending required checks:\n/, ""),
      );
    }
  } else {
    const checksError = checkStatusChecks(requiredChecks);
    if (checksError) throw new Error(checksError);
  }

  let mergeHeadRefOid = headRefOid;
  if (expected) {
    // Checks can take long enough for the PR to be retargeted or updated. Bind
    // the final mutation to a fresh observation, not only the initial view.
    const fresh = await deps.ghPrView(pr, ["title", "state", "baseRefName", "headRefOid"]);
    const freshTitle = String(fresh.title ?? "");
    const freshParsed = parseReleasePrTitle(freshTitle);
    if (!freshParsed) {
      throw new Error(`PR #${pr} is no longer a pipeline release PR`);
    }
    const freshState = String(fresh.state ?? "").toUpperCase();
    if (freshState !== "OPEN") {
      throw new Error(
        `PR #${pr} changed state before merge (state=${freshState || "UNKNOWN"}); retry to reconcile`,
      );
    }
    mergeHeadRefOid = String(fresh.headRefOid ?? "");
    validateExpectedIdentity(
      pr,
      freshParsed.version,
      String(fresh.baseRefName ?? ""),
      mergeHeadRefOid,
      expected,
    );
  }

  deps.log(
    `[pipeline release finish] #${pr}: merging release v${parsed.version} at ${mergeHeadRefOid.slice(0, 12)}…`,
  );
  await deps.ghPrMerge(pr, mergeHeadRefOid);

  const after = await deps.ghPrView(pr, ["state", "mergedAt", "mergeCommit", "headRefOid"]);
  const afterMerge = after.mergeCommit as { oid?: string } | null | undefined;
  const afterState = String(after.state ?? "").toUpperCase();
  const merged =
    afterState === "MERGED" ||
    (after.mergedAt != null && String(after.mergedAt) !== "" && String(after.mergedAt) !== "null");
  if (!merged) {
    throw new Error(
      `PR #${pr}: merge command returned but PR is not merged (state=${afterState}). Inspect GitHub before retrying.`,
    );
  }

  deps.log(
    `[pipeline release finish] #${pr}: merged v${parsed.version}. ` +
      `Tag/publish remain auto-tag-release + release workflows — this command does not tag. ` +
      `Tag-derived CHANGELOG refresh is automatic after auto-tag (#978).`,
  );

  const docsRefresh = await maybeHealPostTagDocs(parsed.version, deps);

  return {
    pr,
    version: parsed.version,
    title,
    headRefOid,
    mergeCommitOid: afterMerge?.oid ?? null,
    alreadyMerged: false,
    docsRefresh,
  };
}

/** Build gh argv; omit -R when repo is empty so cwd/git remote resolves (release config is gh-free). */
function withRepo(repo: string, args: string[]): string[] {
  if (repo && repo.trim() !== "") return [...args, "-R", repo];
  return args;
}

/**
 * Production deps for merge-only finish. Tag/publish remain workflows.
 *
 * Post-tag CHANGELOG refresh (#978) is **not** wired here by default: the
 * primary writer is auto-tag-release.yml on the default-branch checkout. Local
 * operator heal (when the workflow step failed) uses the shared helper:
 *   `node scripts/release-docs-refresh.mjs --version X.Y.Z --push`
 * Callers that intentionally heal after finish may inject `waitForReleaseTag`
 * + `refreshPostTagDocs` (see unit tests).
 */
export function realReleaseFinishDeps(repo: string, cwd?: string): ReleaseFinishDeps {
  const runOpts = { timeout: 30_000, maxBuffer: 50 * 1024 * 1024, ...(cwd ? { cwd } : {}) };
  return {
    log(msg) {
      console.error(msg);
    },
    async ghPrView(pr, fields) {
      const { stdout } = await execFileAsync(
        "gh",
        withRepo(repo, ["pr", "view", String(pr), "--json", fields.join(",")]),
        runOpts,
      );
      return JSON.parse(String(stdout)) as Record<string, unknown>;
    },
    async ghPrChecksRequired(pr) {
      const { stdout } = await execFileAsync(
        "gh",
        withRepo(repo, ["pr", "checks", String(pr), "--required", "--json", "name,bucket"]),
        runOpts,
      );
      return JSON.parse(String(stdout)) as ReleaseFinishCheck[];
    },
    async ghPrChecksAll(pr) {
      const { stdout } = await execFileAsync(
        "gh",
        withRepo(repo, ["pr", "checks", String(pr), "--json", "name,bucket"]),
        runOpts,
      );
      return JSON.parse(String(stdout)) as ReleaseFinishCheck[];
    },
    async ghPrMerge(pr, headRefOid) {
      try {
        await execFileAsync(
          "gh",
          withRepo(repo, [
            "pr",
            "merge",
            String(pr),
            "--squash",
            "--delete-branch",
            "--match-head-commit",
            headRefOid,
          ]),
          { timeout: 60_000, ...(cwd ? { cwd } : {}) },
        );
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        const stderr = String(e.stderr ?? "").toLowerCase();
        if (stderr.includes("already deleted") || stderr.includes("branch not found")) {
          return;
        }
        throw new Error(`gh pr merge failed: ${String(e.stderr ?? e.message).trim()}`);
      }
    },
  };
}
