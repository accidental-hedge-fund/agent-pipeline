// OpenSpec fix-round spec-delta consistency guard (#106).
//
// Spec deltas are frozen at planning time; fix rounds only edit code. A material
// fix can move the implementation away from its own spec, and pre-merge would
// then archive that stale delta into the living specs (silent corruption). The
// guard blocks "code moved, spec didn't" before archiving. All I/O is faked via
// the AdvancePreMergeDeps seam — no real git, gh, or openspec.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  enforceSpecConsistencyGuard,
  maybeArchiveOpenspec,
  reviewFlagsSpecDivergence,
  specDeltaIsStale,
  type AdvancePreMergeDeps,
  type SpecConsistencyDeps,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const cfg = { base_branch: "main" } as unknown as PipelineConfig;
const ID = "c106";
const SPEC_PATH = `openspec/changes/${ID}/specs/cap/spec.md`;
const IMPL_PATH = "core/scripts/foo.ts";
// Branch diff: planning authored the spec delta + code landed → both present.
// (This is exactly why the guard cannot use the full branch diff to detect a
// fix that skipped the spec — the delta is always here.)
const BRANCH_DIFF = `${SPEC_PATH}\n${IMPL_PATH}\n`;

const REVIEW_DIVERGENCE = [
  "## Review 2 (Adversarial) — needs-attention (commit abc1234)",
  "**Reviewer**: claude",
  "",
  "### Findings",
  "",
  "**1. [MEDIUM] Implementation no longer matches the spec delta** `override-key: medium:core/scripts/foo.ts:x`",
  "The fix changed the gate behavior; the code now diverges from spec.",
].join("\n");

// Mentions the spec but reports NO divergence — must not trip the guard.
const REVIEW_CLEAN = [
  "## Review 2 (Adversarial) — approve (commit abc1234)",
  "**Reviewer**: claude",
  "",
  "The implementation matches the spec delta correctly; only a minor naming nit, nothing blocking.",
].join("\n");

// Approving summary that contains BOTH "divergence" and "OpenSpec" — but no
// Findings section. Before the fix this would trip the guard because
// reviewFlagsSpecDivergence was called on the full body.
const REVIEW_APPROVE_DIVERGENCE_IN_SUMMARY = [
  "## Review 1 (Standard) — approve (commit def5678)",
  "**Reviewer**: codex",
  "",
  "No divergence from the OpenSpec delta; implementation matches.",
].join("\n");

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

interface ArchiveRec {
  archiveCalls: string[];
  blocked: { reason: string; stage: string }[];
}

function makeArchiveDeps(opts: {
  fixDiffPaths: string[];
  reviewBody: string;
}): { deps: AdvancePreMergeDeps; rec: ArchiveRec } {
  const rec: ArchiveRec = { archiveCalls: [], blocked: [] };
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => ({ path: "/fake/wt", slug: "issue-106" }),
    openspecIsActive: () => true,
    changeDirExists: () => true,
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "diff" && args.some((a) => a.includes("..."))) {
        return { stdout: BRANCH_DIFF, stderr: "", code: 0 };
      }
      // status --porcelain → empty so the proceed path returns before commit/push.
      return { stdout: "", stderr: "", code: 0 };
    },
    branchFixDiffPaths: async () => opts.fixDiffPaths,
    openspecArchive: async (_wt, id) => {
      rec.archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    },
    getIssueDetail: async () =>
      ({ comments: [{ author: "claude", body: opts.reviewBody, createdAt: "2026-06-10T00:00:00Z" }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    setBlocked: async (_cfg, _n, reason, stage) => {
      rec.blocked.push({ reason, stage: String(stage) });
    },
  };
  return { deps, rec };
}

// ---------------------------------------------------------------------------
// maybeArchiveOpenspec wiring — the regression these tests guard (#106)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: blocks (no archive) when a fix moved code but not the spec and the reviewer flagged divergence", async (t) => {
  // Bites without the guard: with the guard removed, maybeArchiveOpenspec would
  // call openspecArchive("c106") and return the waiting/null archive outcome —
  // both assertions below would then fail.
  const { deps, rec } = makeArchiveDeps({
    fixDiffPaths: [IMPL_PATH], // fix touched code; the change's specs/** untouched
    reviewBody: REVIEW_DIVERGENCE,
  });
  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, 106, "106/run", deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "blocked",
    reason: `stale OpenSpec delta (${ID})`,
  });
  assert.deepEqual(rec.archiveCalls, [], "a stale delta must NOT be archived");
  assert.equal(rec.blocked.length, 1, "the issue must be labeled blocked");
  assert.match(rec.blocked[0].reason, /stale spec delta/i);
  assert.equal(rec.blocked[0].stage, "pre-merge");
});

test("maybeArchiveOpenspec: proceeds to archive when the reviewer did NOT flag divergence (no false positive)", async (t) => {
  const { deps, rec } = makeArchiveDeps({
    fixDiffPaths: [IMPL_PATH], // same structural signal as the blocking case…
    reviewBody: REVIEW_CLEAN, // …but the reviewer saw no divergence → spec presumed consistent
  });
  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, 106, "106/run", deps);
  });
  // Guard passes → archive runs; faked `status --porcelain` is empty → null (continue).
  assert.equal(out, null);
  assert.deepEqual(rec.archiveCalls, [ID], "archive must proceed when there is no flagged divergence");
  assert.equal(rec.blocked.length, 0, "the consistency guard must not block here");
});

test("maybeArchiveOpenspec: approving summary with 'no divergence' language does not trip guard (regression for f13d9b94)", async (t) => {
  // Bites without the fix: before extractFindingsSection was introduced,
  // reviewFlagsSpecDivergence scanned the full review body and found "divergence"
  // + "OpenSpec" in the approving summary, causing a false-positive block even
  // though the reviewer found no actual divergence finding.
  const { deps, rec } = makeArchiveDeps({
    fixDiffPaths: [IMPL_PATH], // code moved (structural signal present)
    reviewBody: REVIEW_APPROVE_DIVERGENCE_IN_SUMMARY,
  });
  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, 106, "106/run", deps);
  });
  assert.equal(out, null, "approving summary must not block when there is no Findings section");
  assert.deepEqual(rec.archiveCalls, [ID], "archive must proceed");
  assert.equal(rec.blocked.length, 0, "false-positive block must not occur");
});

test("maybeArchiveOpenspec: proceeds when the fix ALSO updated the spec delta (revision happened)", async (t) => {
  const { deps, rec } = makeArchiveDeps({
    fixDiffPaths: [IMPL_PATH, SPEC_PATH], // fix updated the spec to match the code
    reviewBody: REVIEW_DIVERGENCE, // even though an earlier verdict flagged divergence
  });
  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, 106, "106/run", deps);
  });
  assert.equal(out, null);
  assert.deepEqual(rec.archiveCalls, [ID], "a fix that revised the spec is consistent → archive proceeds");
  assert.equal(rec.blocked.length, 0);
});

// ---------------------------------------------------------------------------
// enforceSpecConsistencyGuard — conservative-open when no fix round ran
// ---------------------------------------------------------------------------

test("enforceSpecConsistencyGuard: no fix-round commits → never blocks (does not even read the verdict)", async () => {
  let issueDetailReads = 0;
  let blocks = 0;
  const deps: SpecConsistencyDeps = {
    branchFixDiffPaths: async () => [], // no fix commit on the branch
    getIssueDetail: (async () => {
      issueDetailReads++;
      return { comments: [] };
    }) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async () => {
      blocks++;
    }) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  const out = await enforceSpecConsistencyGuard(cfg, 106, "/fake/wt", [ID], deps);
  assert.equal(out, null);
  assert.equal(issueDetailReads, 0, "skips the verdict read when no fix round ran");
  assert.equal(blocks, 0);
});

// ---------------------------------------------------------------------------
// specDeltaIsStale — pure structural half
// ---------------------------------------------------------------------------

test("specDeltaIsStale: impl changed + spec delta untouched → stale", () => {
  assert.equal(specDeltaIsStale(ID, [IMPL_PATH]), true);
  assert.equal(specDeltaIsStale(ID, [IMPL_PATH, "plugin/scripts/foo.ts"]), true);
});

test("specDeltaIsStale: spec delta also changed → not stale (revision happened)", () => {
  assert.equal(specDeltaIsStale(ID, [IMPL_PATH, SPEC_PATH]), false);
});

test("specDeltaIsStale: only the spec changed (no impl) → not stale", () => {
  assert.equal(specDeltaIsStale(ID, [SPEC_PATH]), false);
});

test("specDeltaIsStale: empty fix diff → not stale", () => {
  assert.equal(specDeltaIsStale(ID, []), false);
});

test("specDeltaIsStale: a DIFFERENT change's spec edit does not satisfy this change's specUpdated", () => {
  // Impl changed; only some OTHER change's specs were edited → c106's delta is
  // still stale. (Editing another change's spec is not editing c106's.)
  assert.equal(specDeltaIsStale(ID, [IMPL_PATH, "openspec/changes/other/specs/x/spec.md"]), true);
});

test("specDeltaIsStale: changes confined to openspec/ are never 'impl' → not stale", () => {
  // No implementation moved (everything is under openspec/), so nothing drifted.
  assert.equal(specDeltaIsStale(ID, ["openspec/changes/other/specs/x/spec.md"]), false);
});

// ---------------------------------------------------------------------------
// reviewFlagsSpecDivergence — pure verdict half
// ---------------------------------------------------------------------------

test("reviewFlagsSpecDivergence: true on explicit divergence language", () => {
  assert.equal(reviewFlagsSpecDivergence("The code diverges from spec."), true);
  assert.equal(reviewFlagsSpecDivergence("Implementation no longer matches the spec delta."), true);
  assert.equal(reviewFlagsSpecDivergence("This is inconsistent with the requirement."), true);
  assert.equal(reviewFlagsSpecDivergence("The spec and code are out of sync."), true);
  assert.equal(reviewFlagsSpecDivergence("The spec delta is stale relative to the implementation."), true);
});

test("reviewFlagsSpecDivergence: false when the spec is mentioned without divergence", () => {
  assert.equal(reviewFlagsSpecDivergence("The implementation matches the spec delta correctly."), false);
  assert.equal(reviewFlagsSpecDivergence("Add a spec scenario for the empty-input case."), false);
});

test("reviewFlagsSpecDivergence: false when there is no spec reference at all", () => {
  assert.equal(reviewFlagsSpecDivergence("LGTM — rename this variable; it no longer matches its usage."), false);
  // 'specific' must not be read as a spec mention.
  assert.equal(reviewFlagsSpecDivergence("Be more specific about the error message."), false);
});
