// Full SemVer milestone reconciliation (#910).
// Dry-run-first action plan + fingerprint-gated apply with partial-failure resume.
// Continuous release_model does not use this module.

import * as crypto from "node:crypto";
import type {
  CompatibilityClassification,
  CoverageBlocker,
  IssueMilestoneSnapshot,
  IssueNumber,
  MilestoneCatalogEntry,
  MilestoneSpec,
  ReconciliationAction,
  ReconciliationManifest,
  ReconciliationProgress,
  ReconciliationTargetMilestone,
} from "./types.ts";
import type { WritebackDeps } from "./writeback.ts";

const SEMVER_TITLE_RE = /^v\d+\.\d+\.\d+$/;
const PROGRESS_FILE = "reconciliation-progress.json";
/** Persisted reviewed preview artifact; apply loads this exact manifest. */
export const REVIEWED_MANIFEST_FILE = "reconciliation-manifest.json";

export interface ReconcileLiveState {
  milestones: MilestoneCatalogEntry[];
  openIssues: IssueMilestoneSnapshot[];
  /** Shipped release titles observed by the engine (e.g. git tags `v1.2.3`). */
  shippedTitles: Set<string>;
}

export interface BuildManifestInput {
  milestones: MilestoneSpec[];
  classifications: CompatibilityClassification[];
  /** Open issues in roadmap scope (filtered inventory). */
  openIssueNumbers: IssueNumber[];
  live: ReconcileLiveState;
  generatedAt?: string;
}

export type ApplyReconciliationResult =
  | { ok: true; mutations: number; resumed: boolean; noop: boolean }
  | { ok: false; reason: string; code: ApplyRefuseCode };

export type ApplyRefuseCode =
  | "coverage_blockers"
  | "fingerprint_drift"
  | "manifest_identity_mismatch"
  | "title_collision"
  | "empty_manifest"
  | "progress_invalid";

function sha12(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/**
 * Content hash of reviewed target state (identity). Live fingerprint is separate.
 */
export function computeManifestIdentity(targets: ReconciliationTargetMilestone[]): string {
  const normalized = [...targets]
    .map((t) => ({
      number: t.number ?? null,
      title: t.title,
      description: t.description,
      version_impact: t.version_impact ?? null,
      issue_numbers: [...t.issue_numbers].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return sha12(JSON.stringify(normalized));
}

/**
 * Live-state fingerprint over open-issue milestone assignments, relevant milestones,
 * and shipped-title observations (so a tag added after preview invalidates apply).
 */
export function computeLiveStateFingerprint(live: ReconcileLiveState): string {
  const issues = [...live.openIssues]
    .filter((i) => i.state === "open")
    .map((i) => ({
      n: i.number,
      s: i.state,
      mn: i.milestone_number,
      mt: i.milestone_title,
      u: i.updatedAt ?? "",
    }))
    .sort((a, b) => a.n - b.n);
  const milestones = [...live.milestones]
    .map((m) => ({
      n: m.number,
      t: m.title,
      s: m.state,
      d: sha12(m.description ?? ""),
      o: m.open_issues,
      c: m.closed_issues,
    }))
    .sort((a, b) => a.n - b.n);
  const shipped = [...live.shippedTitles].sort();
  return sha12(JSON.stringify({ issues, milestones, shipped }));
}

function isShipped(m: MilestoneCatalogEntry, shippedTitles: Set<string>): boolean {
  if (m.state !== "closed") return false;
  if (shippedTitles.has(m.title)) return true;
  // Closed SemVer title that appears in shipped set under with/without leading v
  if (SEMVER_TITLE_RE.test(m.title) && shippedTitles.has(m.title.replace(/^v/, ""))) return true;
  const withV = m.title.startsWith("v") ? m.title : `v${m.title}`;
  return shippedTitles.has(withV);
}

/**
 * Closed empty unshipped planning milestone: no open issues AND no closed
 * historical issues (closed_issues === 0). Shipped milestones are never reusable.
 */
function isReusableClosedEmpty(
  m: MilestoneCatalogEntry,
  shippedTitles: Set<string>,
): boolean {
  return (
    m.state === "closed" &&
    m.open_issues === 0 &&
    m.closed_issues === 0 &&
    !isShipped(m, shippedTitles)
  );
}

/**
 * Resolve a unique reusable milestone for a target.
 * Prefers stable number when provided.
 * Closed reopen/reuse is allowed ONLY when the reviewed target names a stable
 * milestone number — title-only matching never reopens closed milestones.
 * Title match alone reuses open non-shipped milestones when unambiguous.
 * Returns a blocker on collision without stable identity.
 */
export function resolveMilestoneIdentity(
  target: ReconciliationTargetMilestone,
  catalog: MilestoneCatalogEntry[],
  shippedTitles: Set<string>,
):
  | { ok: true; entry: MilestoneCatalogEntry | null; mode: "create" | "reuse" | "reopen" }
  | { ok: false; blocker: CoverageBlocker } {
  if (target.number !== undefined) {
    const byNum = catalog.find((m) => m.number === target.number);
    if (!byNum) {
      return {
        ok: false,
        blocker: {
          reason: "title_collision",
          detail: `Manifest names milestone number ${target.number} but it is not in the live catalog`,
        },
      };
    }
    if (isShipped(byNum, shippedTitles)) {
      // Shipped identity is immutable; only allow pure reuse when title already matches and no mutation needed
      if (byNum.title === target.title) {
        return { ok: true, entry: byNum, mode: "reuse" };
      }
      return {
        ok: false,
        blocker: {
          reason: "shipped_immutable",
          detail: `Closed shipped milestone #${byNum.number} ("${byNum.title}") is immutable; cannot bind target "${target.title}"`,
        },
      };
    }
    if (byNum.state === "closed") {
      if (!isReusableClosedEmpty(byNum, shippedTitles)) {
        return {
          ok: false,
          blocker: {
            reason: "shipped_immutable",
            detail: `Closed milestone #${byNum.number} ("${byNum.title}") is not a reusable empty unshipped planning milestone`,
          },
        };
      }
      return { ok: true, entry: byNum, mode: "reopen" };
    }
    return { ok: true, entry: byNum, mode: "reuse" };
  }

  // Dedupe by milestone number first (catalog may be stale-duplicated in tests).
  const byNumber = new Map<number, MilestoneCatalogEntry>();
  for (const m of catalog) {
    if (!byNumber.has(m.number)) byNumber.set(m.number, m);
  }
  const uniqueCatalog = [...byNumber.values()];

  // Title-only: open non-shipped reuse only — never opportunistic closed reopen.
  const openMatches = uniqueCatalog.filter(
    (m) => m.title === target.title && m.state === "open" && !isShipped(m, shippedTitles),
  );
  if (openMatches.length === 0) {
    return { ok: true, entry: null, mode: "create" };
  }
  if (openMatches.length > 1) {
    return {
      ok: false,
      blocker: {
        reason: "title_collision",
        detail: `Ambiguous milestones titled "${target.title}" (numbers: ${openMatches.map((m) => m.number).join(", ")}); name a stable identity`,
      },
    };
  }
  return { ok: true, entry: openMatches[0], mode: "reuse" };
}

/**
 * Stamp stable milestone numbers onto targets when a unique reusable live
 * identity exists (open same-title, or closed empty unshipped same-title).
 * Generated manifests then name identities so reopen is never title-opportunistic.
 */
export function bindTargetMilestoneIdentities(
  targets: ReconciliationTargetMilestone[],
  live: ReconcileLiveState,
): { targets: ReconciliationTargetMilestone[]; blockers: CoverageBlocker[] } {
  const blockers: CoverageBlocker[] = [];
  const byNumber = new Map<number, MilestoneCatalogEntry>();
  for (const m of live.milestones) {
    if (!byNumber.has(m.number)) byNumber.set(m.number, m);
  }
  const uniqueCatalog = [...byNumber.values()];

  const bound = targets.map((target) => {
    if (target.number !== undefined) return target;

    const openMatches = uniqueCatalog.filter(
      (m) => m.title === target.title && m.state === "open" && !isShipped(m, live.shippedTitles),
    );
    if (openMatches.length === 1) {
      return { ...target, number: openMatches[0].number };
    }
    if (openMatches.length > 1) {
      blockers.push({
        reason: "title_collision",
        detail: `Ambiguous open milestones titled "${target.title}" (numbers: ${openMatches.map((m) => m.number).join(", ")}); name a stable identity`,
      });
      return target;
    }

    const closedMatches = uniqueCatalog.filter((m) =>
      m.title === target.title && isReusableClosedEmpty(m, live.shippedTitles),
    );
    if (closedMatches.length === 1) {
      // Explicitly name the closed empty unshipped planning identity for reopen.
      return { ...target, number: closedMatches[0].number };
    }
    if (closedMatches.length > 1) {
      blockers.push({
        reason: "title_collision",
        detail: `Ambiguous closed milestones titled "${target.title}" (numbers: ${closedMatches.map((m) => m.number).join(", ")}); name a stable identity`,
      });
    }
    return target;
  });

  return { targets: bound, blockers };
}

/**
 * Build target milestones from plan lanes + classification coverage for every open issue.
 * Theme/epic labels never satisfy the milestoned invariant.
 */
export function buildReconciliationTargets(
  milestones: MilestoneSpec[],
  classifications: CompatibilityClassification[],
  openIssueNumbers: IssueNumber[],
): { targets: ReconciliationTargetMilestone[]; blockers: CoverageBlocker[] } {
  const blockers: CoverageBlocker[] = [];
  const classByIssue = new Map(classifications.map((c) => [c.issue_number, c]));
  const openSet = new Set(openIssueNumbers);

  // Dual membership check across plan milestones
  const seen = new Map<number, string>();
  for (const m of milestones) {
    for (const n of m.issue_numbers) {
      if (!openSet.has(n)) continue;
      const prev = seen.get(n);
      if (prev !== undefined) {
        blockers.push({
          issue_number: n,
          reason: "dual_membership",
          detail: `Issue #${n} appears in both "${prev}" and "${m.title}"`,
        });
      } else {
        seen.set(n, m.title);
      }
    }
  }

  for (const n of openIssueNumbers) {
    const c = classByIssue.get(n);
    if (!c || c.status === "unresolved_missing") {
      blockers.push({
        issue_number: n,
        reason: "unresolved_missing",
        detail:
          `Open issue #${n} has no resolved applied semver:* classification; ` +
          `theme/epic labels do not satisfy the release-milestone invariant`,
      });
      continue;
    }
    if (c.status === "unresolved_conflict") {
      blockers.push({
        issue_number: n,
        reason: "unresolved_conflict",
        detail:
          `Open issue #${n} has conflicting semver:* labels ` +
          `(${(c.conflict_labels ?? []).join(", ")}); free-form prose does not select a version`,
      });
      continue;
    }
    if (!seen.has(n)) {
      blockers.push({
        issue_number: n,
        reason: "unmilestoned",
        detail:
          `Open issue #${n} has resolved impact (${c.applied_impact}) but is not in any plan milestone; ` +
          `regenerate the SemVer plan so every open issue is assigned`,
      });
    }
  }

  const targets: ReconciliationTargetMilestone[] = milestones.map((m) => ({
    title: m.title,
    description: m.rationale,
    version_impact: m.version_impact,
    issue_numbers: m.issue_numbers.filter((n) => openSet.has(n)),
  }));

  return { targets, blockers };
}

/**
 * Diff live catalog + issue assignments against targets → ordered actions.
 */
export function planReconciliationActions(
  targets: ReconciliationTargetMilestone[],
  live: ReconcileLiveState,
  priorBlockers: CoverageBlocker[] = [],
): { actions: ReconciliationAction[]; blockers: CoverageBlocker[] } {
  const blockers = [...priorBlockers];
  const actions: ReconciliationAction[] = [];
  let seq = 0;
  const nextId = (kind: string, key: string) => {
    seq += 1;
    return `${String(seq).padStart(3, "0")}-${kind}-${key}`;
  };

  // Map issue → target title
  const issueTarget = new Map<number, string>();
  for (const t of targets) {
    for (const n of t.issue_numbers) {
      issueTarget.set(n, t.title);
    }
  }

  // Resolve each target milestone binding first
  const boundTitleToNumber = new Map<string, number>();

  for (const target of targets) {
    const resolved = resolveMilestoneIdentity(target, live.milestones, live.shippedTitles);
    if (!resolved.ok) {
      blockers.push(resolved.blocker);
      continue;
    }

    if (resolved.mode === "create") {
      actions.push({
        id: nextId("create", target.title),
        kind: "create",
        milestone_title: target.title,
        description: target.description,
        detail: `create milestone "${target.title}"`,
      });
    } else if (resolved.mode === "reopen" && resolved.entry) {
      // Only reopen when manifest names identity (number or unique title match for named target)
      actions.push({
        id: nextId("reopen", String(resolved.entry.number)),
        kind: "reopen",
        milestone_number: resolved.entry.number,
        milestone_title: resolved.entry.title,
        detail: `reopen milestone #${resolved.entry.number} ("${resolved.entry.title}") for "${target.title}"`,
      });
      if (resolved.entry.title !== target.title) {
        actions.push({
          id: nextId("rename", String(resolved.entry.number)),
          kind: "rename",
          milestone_number: resolved.entry.number,
          milestone_title: resolved.entry.title,
          new_title: target.title,
          detail: `rename milestone #${resolved.entry.number} "${resolved.entry.title}" → "${target.title}"`,
        });
      }
      if ((resolved.entry.description ?? "") !== (target.description ?? "")) {
        actions.push({
          id: nextId("desc", String(resolved.entry.number)),
          kind: "update_description",
          milestone_number: resolved.entry.number,
          milestone_title: target.title,
          description: target.description,
          detail: `update description on milestone #${resolved.entry.number}`,
        });
      }
      boundTitleToNumber.set(target.title, resolved.entry.number);
    } else if (resolved.mode === "reuse" && resolved.entry) {
      actions.push({
        id: nextId("reuse", String(resolved.entry.number)),
        kind: "reuse",
        milestone_number: resolved.entry.number,
        milestone_title: resolved.entry.title,
        detail: `reuse milestone #${resolved.entry.number} ("${resolved.entry.title}")`,
      });
      if (
        resolved.entry.title !== target.title &&
        !isShipped(resolved.entry, live.shippedTitles)
      ) {
        actions.push({
          id: nextId("rename", String(resolved.entry.number)),
          kind: "rename",
          milestone_number: resolved.entry.number,
          milestone_title: resolved.entry.title,
          new_title: target.title,
          detail: `rename milestone #${resolved.entry.number} "${resolved.entry.title}" → "${target.title}"`,
        });
      }
      if (
        (resolved.entry.description ?? "") !== (target.description ?? "") &&
        !isShipped(resolved.entry, live.shippedTitles)
      ) {
        actions.push({
          id: nextId("desc", String(resolved.entry.number)),
          kind: "update_description",
          milestone_number: resolved.entry.number,
          milestone_title: target.title,
          description: target.description,
          detail: `update description on milestone #${resolved.entry.number}`,
        });
      }
      boundTitleToNumber.set(target.title, resolved.entry.number);
    }
  }

  // Issue assign / clear_stale
  const openByNumber = new Map(live.openIssues.filter((i) => i.state === "open").map((i) => [i.number, i]));

  for (const [issueNumber, targetTitle] of issueTarget) {
    const snap = openByNumber.get(issueNumber);
    if (!snap) continue;
    const liveTitle = snap.milestone_title;
    if (liveTitle === targetTitle) {
      // Already at target — no assign (still may have been listed via reuse)
      continue;
    }
    if (liveTitle !== null && liveTitle !== undefined && liveTitle !== "") {
      actions.push({
        id: nextId("clear", String(issueNumber)),
        kind: "clear_stale",
        issue_number: issueNumber,
        milestone_title: liveTitle,
        milestone_number: snap.milestone_number ?? undefined,
        detail: `clear stale milestone "${liveTitle}" from #${issueNumber} (target "${targetTitle}")`,
      });
    }
    actions.push({
      id: nextId("assign", String(issueNumber)),
      kind: "assign",
      issue_number: issueNumber,
      milestone_title: targetTitle,
      milestone_number: boundTitleToNumber.get(targetTitle),
      detail: `assign #${issueNumber} → "${targetTitle}"`,
    });
  }

  return { actions, blockers };
}

/**
 * Build the full reviewed reconciliation manifest from plan lanes + live state.
 * Targets receive stable milestone numbers when a unique reusable identity exists
 * so apply/reopen never relies on opportunistic title-only closed matching.
 */
export function buildReconciliationManifest(input: BuildManifestInput): ReconciliationManifest {
  const generated_at = input.generatedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const { targets: rawTargets, blockers: coverageBlockers } = buildReconciliationTargets(
    input.milestones,
    input.classifications,
    input.openIssueNumbers,
  );
  const { targets, blockers: bindBlockers } = bindTargetMilestoneIdentities(
    rawTargets,
    input.live,
  );
  const { actions, blockers } = planReconciliationActions(targets, input.live, [
    ...coverageBlockers,
    ...bindBlockers,
  ]);
  const identity = computeManifestIdentity(targets);
  const live_state_fingerprint = computeLiveStateFingerprint(input.live);
  return {
    identity,
    live_state_fingerprint,
    targets,
    actions,
    coverage_blockers: blockers,
    generated_at,
  };
}

function reviewedManifestPath(outputDir: string): string {
  return `${outputDir.replace(/\/$/, "")}/${REVIEWED_MANIFEST_FILE}`;
}

/** Persist the reviewed preview manifest for exact apply execution. */
export async function saveReviewedManifest(
  outputDir: string,
  manifest: ReconciliationManifest,
  deps: Pick<WritebackDeps, "writeFile">,
): Promise<void> {
  await deps.writeFile(
    reviewedManifestPath(outputDir),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/** Load the reviewed preview manifest; null when missing or unparseable. */
export async function loadReviewedManifest(
  outputDir: string,
  deps: Pick<WritebackDeps, "readFile">,
): Promise<ReconciliationManifest | null> {
  const raw = await deps.readFile(reviewedManifestPath(outputDir));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReconciliationManifest;
    if (
      typeof parsed?.identity !== "string" ||
      typeof parsed?.live_state_fingerprint !== "string" ||
      !Array.isArray(parsed?.actions) ||
      !Array.isArray(parsed?.targets)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Gate SemVer apply without mutating: coverage blockers, identity, fingerprint.
 * Used before any apply-side write-back (including hygiene).
 */
export function validateSemverApplyReady(
  manifest: ReconciliationManifest,
  live: ReconcileLiveState,
  opts: {
    expectedIdentity?: string;
    /**
     * When resuming, the progress record supplies the expected fingerprint
     * (last successful post-action fingerprint, else apply-start).
     */
    resumeProgress?: ReconciliationProgress | null;
  } = {},
): ApplyReconciliationResult | { ok: true } {
  if (opts.expectedIdentity !== undefined && opts.expectedIdentity !== manifest.identity) {
    return {
      ok: false,
      code: "manifest_identity_mismatch",
      reason: `Manifest identity changed; run a new dry-run preview (expected ${opts.expectedIdentity}, got ${manifest.identity})`,
    };
  }

  if (manifest.coverage_blockers.length > 0) {
    return {
      ok: false,
      code: "coverage_blockers",
      reason: `Coverage blockers present (${manifest.coverage_blockers.length}); resolve classifications and regenerate the manifest`,
    };
  }

  const collision = manifest.coverage_blockers.find((b) => b.reason === "title_collision");
  if (collision) {
    return { ok: false, code: "title_collision", reason: collision.detail };
  }

  const freshFp = computeLiveStateFingerprint(live);
  const existingProgress = opts.resumeProgress ?? null;
  const resuming =
    existingProgress !== null &&
    existingProgress.manifest_identity === manifest.identity &&
    (existingProgress.status === "in_progress" || existingProgress.status === "failed") &&
    Array.isArray(existingProgress.actions) &&
    existingProgress.actions.length > 0;

  if (resuming && existingProgress) {
    const expectedFp =
      existingProgress.last_fingerprint ?? existingProgress.apply_start_fingerprint;
    if (freshFp !== expectedFp) {
      return {
        ok: false,
        code: "fingerprint_drift",
        reason: "Live state drifted; run a new dry-run preview before apply",
      };
    }
  } else if (
    existingProgress?.status === "complete" &&
    existingProgress.manifest_identity === manifest.identity
  ) {
    // Prior complete with same identity — allow re-check of fresh plan vs live
    // via apply path (may noop). Still require match to reviewed preview fp when
    // not resuming incomplete work — fall through to preview fingerprint.
    if (freshFp !== manifest.live_state_fingerprint) {
      // Converged re-apply often rebuilds live after mutations; apply will
      // recompute actions via the saved complete path. Gate only incomplete resume
      // and first apply against preview fingerprint below when not complete.
    }
  } else {
    if (freshFp !== manifest.live_state_fingerprint) {
      return {
        ok: false,
        code: "fingerprint_drift",
        reason: "Live state changed after preview; run a new dry-run preview before apply",
      };
    }
  }

  return { ok: true };
}

export async function loadLiveState(
  repo: string,
  shippedTitles: Iterable<string>,
  deps: Pick<WritebackDeps, "listMilestonesDetailed" | "listOpenIssueMilestoneSnapshots">,
  /** When set, restrict open-issue snapshots to this scope (roadmap filter). */
  scopeIssueNumbers?: Set<number>,
): Promise<ReconcileLiveState> {
  const milestones = await deps.listMilestonesDetailed(repo);
  let openIssues = await deps.listOpenIssueMilestoneSnapshots(repo);
  if (scopeIssueNumbers) {
    openIssues = openIssues.filter((i) => scopeIssueNumbers.has(i.number));
  }
  return {
    milestones,
    openIssues,
    shippedTitles: new Set(shippedTitles),
  };
}

function progressPath(outputDir: string): string {
  return `${outputDir.replace(/\/$/, "")}/${PROGRESS_FILE}`;
}

export async function loadProgress(
  outputDir: string,
  deps: Pick<WritebackDeps, "readFile">,
): Promise<ReconciliationProgress | null> {
  const raw = await deps.readFile(progressPath(outputDir));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReconciliationProgress;
  } catch {
    return null;
  }
}

export async function saveProgress(
  outputDir: string,
  progress: ReconciliationProgress,
  deps: Pick<WritebackDeps, "writeFile">,
): Promise<void> {
  await deps.writeFile(progressPath(outputDir), JSON.stringify(progress, null, 2) + "\n");
}

/**
 * Execute a reviewed reconciliation manifest with fingerprint gate and resume.
 * Callers MUST pass the exact reviewed preview manifest (from
 * loadReviewedManifest), not a freshly regenerated plan.
 */
export async function applySemverReconciliation(
  manifest: ReconciliationManifest,
  repo: string,
  outputDir: string,
  deps: WritebackDeps,
  opts: {
    /** Fresh live state for fingerprint check (required). */
    live: ReconcileLiveState;
    /**
     * Expected reviewed identity. When set and differing from manifest.identity, refuse.
     * Used when apply loads a previously reviewed identity.
     */
    expectedIdentity?: string;
    /**
     * When true, skip the internal ready-gate (caller already ran
     * validateSemverApplyReady before other write-backs such as hygiene).
     */
    gatesAlreadyChecked?: boolean;
  },
): Promise<ApplyReconciliationResult> {
  const existingProgress = await loadProgress(outputDir, deps);

  if (!opts.gatesAlreadyChecked) {
    const gate = validateSemverApplyReady(manifest, opts.live, {
      expectedIdentity: opts.expectedIdentity,
      resumeProgress: existingProgress,
    });
    if (!gate.ok) {
      if (gate.code === "manifest_identity_mismatch") {
        deps.log(
          `[roadmap] refuse apply: manifest identity mismatch ` +
            `(expected ${opts.expectedIdentity}, got ${manifest.identity})`,
        );
      } else if (gate.code === "coverage_blockers") {
        deps.log(
          `[roadmap] refuse apply: ${manifest.coverage_blockers.length} coverage blocker(s) — see dry-run listing`,
        );
        for (const b of manifest.coverage_blockers) {
          const issue = b.issue_number !== undefined ? `#${b.issue_number} ` : "";
          deps.log(`  - ${issue}[${b.reason}] ${b.detail}`);
        }
      } else if (gate.code === "fingerprint_drift") {
        deps.log(`[roadmap] refuse apply: ${gate.reason}`);
      }
      return gate;
    }
  } else if (opts.expectedIdentity !== undefined && opts.expectedIdentity !== manifest.identity) {
    return {
      ok: false,
      code: "manifest_identity_mismatch",
      reason: `Manifest identity changed; run a new dry-run preview (expected ${opts.expectedIdentity}, got ${manifest.identity})`,
    };
  }

  const freshFp = computeLiveStateFingerprint(opts.live);
  const resuming =
    existingProgress !== null &&
    existingProgress.manifest_identity === manifest.identity &&
    (existingProgress.status === "in_progress" || existingProgress.status === "failed") &&
    Array.isArray(existingProgress.actions) &&
    existingProgress.actions.length > 0;
  const priorComplete =
    existingProgress !== null &&
    existingProgress.manifest_identity === manifest.identity &&
    existingProgress.status === "complete";

  // When resume is in progress, execute the saved action list (not a re-planned one).
  // When prior complete for the same identity, treat as converged noop (do not re-fire
  // the reviewed action list against post-apply live state).
  const actionList: ReconciliationAction[] =
    resuming && existingProgress
      ? existingProgress.actions
      : priorComplete && existingProgress
        ? existingProgress.actions
        : manifest.actions;

  // Resume: always require live state matches last post-action fingerprint chain
  // (or apply-start when no actions completed). Prevents pending clear_stale/assign
  // from running after external drift mid-apply.
  if (resuming && existingProgress) {
    const expectedFp =
      existingProgress.last_fingerprint ?? existingProgress.apply_start_fingerprint;
    if (freshFp !== expectedFp) {
      deps.log(
        `[roadmap] refuse resume: live-state fingerprint drifted ` +
          `(expected ${expectedFp}, now ${freshFp}); run a new preview`,
      );
      return {
        ok: false,
        code: "fingerprint_drift",
        reason: "Live state drifted; run a new dry-run preview before apply",
      };
    }
  } else if (priorComplete) {
    // Prior complete with same identity — exact no-op convergence path
  } else if (!opts.gatesAlreadyChecked) {
    // Fresh apply fingerprint already validated in validateSemverApplyReady
  } else if (freshFp !== manifest.live_state_fingerprint) {
    deps.log(
      `[roadmap] refuse apply: live-state fingerprint drift ` +
        `(preview ${manifest.live_state_fingerprint}, fresh ${freshFp}); run a new preview`,
    );
    return {
      ok: false,
      code: "fingerprint_drift",
      reason: "Live state changed after preview; run a new dry-run preview before apply",
    };
  }

  const completedIds = new Set(
    resuming && existingProgress
      ? existingProgress.completed.map((c) => c.id)
      : priorComplete && existingProgress
        ? existingProgress.actions.map((a) => a.id)
        : [],
  );
  // Bind titles created in prior partial run
  const createdTitleToNumber = new Map<string, number>();
  if (resuming && existingProgress) {
    for (const c of existingProgress.completed) {
      if (c.result?.milestone_number !== undefined) {
        const action = actionList.find((a) => a.id === c.id);
        if (action?.kind === "create" && action.milestone_title) {
          createdTitleToNumber.set(action.milestone_title, c.result.milestone_number);
        }
      }
    }
  }

  const pending = actionList.filter((a) => !completedIds.has(a.id));
  if (pending.length === 0) {
    deps.log(`[roadmap] SemVer reconciliation: no mutations required (noop)`);
    const done: ReconciliationProgress = {
      manifest_identity: manifest.identity,
      apply_start_fingerprint: resuming && existingProgress
        ? existingProgress.apply_start_fingerprint
        : freshFp,
      last_fingerprint: freshFp,
      actions: actionList,
      completed: existingProgress?.completed ?? actionList.map((a) => ({ id: a.id })),
      next_pending_id: null,
      status: "complete",
      updated_at: new Date().toISOString(),
    };
    await saveProgress(outputDir, done, deps);
    return { ok: true, mutations: 0, resumed: Boolean(resuming), noop: true };
  }

  let progress: ReconciliationProgress = resuming && existingProgress
    ? {
        ...existingProgress,
        actions: actionList,
        status: "in_progress",
        updated_at: new Date().toISOString(),
      }
    : {
        manifest_identity: manifest.identity,
        apply_start_fingerprint: freshFp,
        last_fingerprint: freshFp,
        actions: actionList,
        completed: [],
        next_pending_id: pending[0]?.id ?? null,
        status: "in_progress",
        updated_at: new Date().toISOString(),
      };

  await saveProgress(outputDir, progress, deps);

  // Local title→number map for assigns after creates
  const titleToNumber = new Map<string, number>();
  for (const m of opts.live.milestones) {
    titleToNumber.set(m.title, m.number);
  }
  for (const [t, n] of createdTitleToNumber) {
    titleToNumber.set(t, n);
  }

  let mutations = 0;

  try {
    for (const action of pending) {
      progress = {
        ...progress,
        next_pending_id: action.id,
        updated_at: new Date().toISOString(),
      };
      await saveProgress(outputDir, progress, deps);

      const result = await executeAction(action, repo, deps, titleToNumber, opts.live);
      if (result.milestone_number !== undefined && action.milestone_title) {
        titleToNumber.set(action.milestone_title, result.milestone_number);
        if (action.new_title) {
          titleToNumber.set(action.new_title, result.milestone_number);
        }
      }
      if (result.mutated) mutations += 1;

      // Chain fingerprint after each successful action so resume detects external drift.
      const postFp = computeLiveStateFingerprint(opts.live);
      progress = {
        ...progress,
        completed: [
          ...progress.completed,
          {
            id: action.id,
            result:
              result.milestone_number !== undefined
                ? { milestone_number: result.milestone_number }
                : undefined,
          },
        ],
        last_fingerprint: postFp,
        updated_at: new Date().toISOString(),
      };
      await saveProgress(outputDir, progress, deps);
    }

    progress = {
      ...progress,
      next_pending_id: null,
      status: "complete",
      updated_at: new Date().toISOString(),
    };
    await saveProgress(outputDir, progress, deps);
    deps.log(
      `[roadmap] SemVer reconciliation complete: ${mutations} mutation(s)` +
        (resuming ? " (resumed)" : ""),
    );
    return { ok: true, mutations, resumed: Boolean(resuming), noop: mutations === 0 };
  } catch (err) {
    progress = {
      ...progress,
      status: "failed",
      updated_at: new Date().toISOString(),
    };
    await saveProgress(outputDir, progress, deps);
    throw err;
  }
}

async function executeAction(
  action: ReconciliationAction,
  repo: string,
  deps: WritebackDeps,
  titleToNumber: Map<string, number>,
  live: ReconcileLiveState,
): Promise<{ mutated: boolean; milestone_number?: number }> {
  switch (action.kind) {
    case "reuse": {
      deps.log(`[roadmap] reuse milestone #${action.milestone_number} ("${action.milestone_title}")`);
      return { mutated: false, milestone_number: action.milestone_number };
    }
    case "create": {
      const title = action.milestone_title ?? "";
      // Idempotent: if title already exists, reuse
      const existing = live.milestones.find((m) => m.title === title && m.state === "open");
      if (existing) {
        deps.log(`[roadmap] create skipped — open milestone "${title}" already exists (#${existing.number})`);
        titleToNumber.set(title, existing.number);
        return { mutated: false, milestone_number: existing.number };
      }
      const fromMap = titleToNumber.get(title);
      if (fromMap !== undefined) {
        deps.log(`[roadmap] create skipped — title "${title}" already bound to #${fromMap}`);
        return { mutated: false, milestone_number: fromMap };
      }
      const number = await deps.createMilestone(repo, title, action.description);
      deps.log(`[roadmap] created milestone "${title}" (#${number})`);
      titleToNumber.set(title, number);
      // Deps (or a prior idempotent path) may already have inserted the entry.
      if (!live.milestones.some((m) => m.number === number || m.title === title)) {
        live.milestones.push({
          id: number,
          number,
          title,
          state: "open",
          description: action.description ?? "",
          open_issues: 0,
          closed_issues: 0,
        });
      }
      return { mutated: true, milestone_number: number };
    }
    case "reopen": {
      const n = action.milestone_number;
      if (n === undefined) throw new Error(`reopen action ${action.id} missing milestone_number`);
      const entry = live.milestones.find((m) => m.number === n);
      if (entry && isShipped(entry, live.shippedTitles)) {
        throw new Error(
          `refusing to reopen shipped milestone #${n} ("${entry.title}") — release history is immutable`,
        );
      }
      if (entry && !isReusableClosedEmpty(entry, live.shippedTitles) && entry.state === "closed") {
        throw new Error(
          `refusing to reopen non-empty or non-reusable closed milestone #${n} ("${entry.title}")`,
        );
      }
      if (entry?.state === "open") {
        deps.log(`[roadmap] reopen skipped — milestone #${n} already open`);
        return { mutated: false, milestone_number: n };
      }
      await deps.reopenMilestone(repo, n);
      if (entry) entry.state = "open";
      deps.log(`[roadmap] reopened milestone #${n} ("${action.milestone_title}")`);
      return { mutated: true, milestone_number: n };
    }
    case "rename": {
      const n = action.milestone_number;
      if (n === undefined || !action.new_title) {
        throw new Error(`rename action ${action.id} missing milestone_number/new_title`);
      }
      const entry = live.milestones.find((m) => m.number === n);
      if (entry && isShipped(entry, live.shippedTitles)) {
        throw new Error(`refusing to rename shipped milestone #${n} ("${entry.title}")`);
      }
      if (entry?.title === action.new_title) {
        deps.log(`[roadmap] rename skipped — milestone #${n} already titled "${action.new_title}"`);
        return { mutated: false, milestone_number: n };
      }
      await deps.updateMilestone(repo, n, { title: action.new_title });
      if (entry) {
        titleToNumber.delete(entry.title);
        entry.title = action.new_title;
      }
      titleToNumber.set(action.new_title, n);
      deps.log(`[roadmap] renamed milestone #${n} → "${action.new_title}"`);
      return { mutated: true, milestone_number: n };
    }
    case "update_description": {
      const n = action.milestone_number;
      if (n === undefined) throw new Error(`update_description ${action.id} missing milestone_number`);
      const entry = live.milestones.find((m) => m.number === n);
      if (entry && isShipped(entry, live.shippedTitles)) {
        throw new Error(`refusing to update description of shipped milestone #${n}`);
      }
      if (entry && (entry.description ?? "") === (action.description ?? "")) {
        deps.log(`[roadmap] description update skipped — milestone #${n} already matches`);
        return { mutated: false, milestone_number: n };
      }
      await deps.updateMilestone(repo, n, { description: action.description ?? "" });
      if (entry) entry.description = action.description ?? "";
      deps.log(`[roadmap] updated description on milestone #${n}`);
      return { mutated: true, milestone_number: n };
    }
    case "clear_stale": {
      const issueNumber = action.issue_number;
      if (issueNumber === undefined) throw new Error(`clear_stale ${action.id} missing issue_number`);
      const snap = live.openIssues.find((i) => i.number === issueNumber);
      if (!snap?.milestone_title) {
        deps.log(`[roadmap] clear_stale skipped — #${issueNumber} has no milestone`);
        return { mutated: false };
      }
      await deps.clearIssueMilestone(repo, issueNumber);
      snap.milestone_number = null;
      snap.milestone_title = null;
      deps.log(`[roadmap] cleared stale milestone from #${issueNumber}`);
      return { mutated: true };
    }
    case "assign": {
      const issueNumber = action.issue_number;
      const title = action.milestone_title;
      if (issueNumber === undefined || !title) {
        throw new Error(`assign ${action.id} missing issue_number/milestone_title`);
      }
      const snap = live.openIssues.find((i) => i.number === issueNumber);
      if (snap?.milestone_title === title) {
        deps.log(`[roadmap] assign skipped — #${issueNumber} already on "${title}"`);
        return { mutated: false };
      }
      await deps.assignIssueMilestone(repo, issueNumber, title);
      if (snap) {
        snap.milestone_title = title;
        snap.milestone_number = titleToNumber.get(title) ?? action.milestone_number ?? null;
      }
      deps.log(`[roadmap] assigned #${issueNumber} to milestone "${title}"`);
      return { mutated: true };
    }
    default: {
      const _exhaustive: never = action.kind;
      throw new Error(`unknown reconciliation action kind: ${_exhaustive}`);
    }
  }
}

/** Parse shipped SemVer titles from `git tag` lines. */
export function parseShippedSemverTitles(tags: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    if (SEMVER_TITLE_RE.test(t)) {
      out.add(t);
      continue;
    }
    if (/^\d+\.\d+\.\d+$/.test(t)) {
      out.add(`v${t}`);
      out.add(t);
    }
  }
  return out;
}
