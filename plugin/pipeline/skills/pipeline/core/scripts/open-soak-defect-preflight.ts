// Open soak-defect preflight for `pipeline release` (#755).
//
// After FRG pass resolution and before any version-file mutation, discovery
// classifies open engine-class soak defects attributable to the candidate's
// soak evidence. Typed terminal / recovery-exhaustion evidence is preferred;
// labels (`bug` + `pipeline:engine-class`) are a historical fallback only.
// Converged intermediate recoveries do not block. The only skip path is an
// audited non-empty override reason recorded on the release PR body.

import { classifyFrgBlocker } from "./factory-reliability-gate.ts";
import type { ClusterEntry } from "./improve.ts";

// ---------------------------------------------------------------------------
// Labels (operator / release index markers — not pipeline stage labels)
// ---------------------------------------------------------------------------

/** Stable engine-class marker for release/operator queries (#755). */
export const ENGINE_CLASS_MARKER_LABEL = "pipeline:engine-class";

/** GitHub conventional defect index label. */
export const BUG_LABEL = "bug";

/** Backlog-only stage index — auto-filed issues are never advanced past this. */
export const BACKLOG_LABEL = "pipeline:backlog";

/**
 * Labels for an auto-filed issue. Engine-class clusters get `pipeline:backlog`,
 * `bug`, and `pipeline:engine-class`. All other auto-files stay backlog-only.
 */
export function autoFileLabelsForCluster(c: Pick<ClusterEntry, "category" | "signal" | "durableRunBlocker">): string[] {
  if (isEngineClassAutoFileCluster(c)) {
    return [BACKLOG_LABEL, BUG_LABEL, ENGINE_CLASS_MARKER_LABEL];
  }
  return [BACKLOG_LABEL];
}

/**
 * Whether a papercut / durable-run-blocker / correction cluster projects to
 * FRG engine-class. Durable-run-blocker uses typed `blockerClass` via
 * {@link classifyFrgBlocker}. Free-text papercut/correction signals are
 * conservative: only explicit engine-class themes (never the unknown→engine
 * default of `classifyFrgBlocker` on arbitrary prose).
 */
export function isEngineClassAutoFileCluster(
  c: Pick<ClusterEntry, "category" | "signal" | "durableRunBlocker">,
): boolean {
  if (c.category === "durable-run-blocker" && c.durableRunBlocker) {
    return classifyFrgBlocker(c.durableRunBlocker.blockerClass) === "engine-class";
  }
  const signal = c.signal ?? "";
  if (/workflow-engine-defect/i.test(signal)) return true;
  if (
    /capacity|worktree.?cap|lockfile|docs.?fresh|pr.?supersed|archive.?false|pr_opened.?strand|resume.?strand/i.test(
      signal,
    )
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Discovery / classification types
// ---------------------------------------------------------------------------

export type SoakDefectClassificationSource = "typed" | "label-fallback";

/** Open GitHub issue shape for candidate-window discovery (injected deps). */
export interface SoakDefectCandidateIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  body: string;
  /** ISO-8601 created_at from GitHub. */
  createdAt: string;
  /**
   * Optional #760 typed disposition / reason projection when present on the
   * issue or a ledger join. Values projecting to engine-class force typed
   * classification when candidate-linked.
   */
  typedDisposition?: string | null;
  /** Optional #763 discovery/candidate run ids when present. */
  candidateRunIds?: string[];
}

/**
 * Typed soak evidence from durable recovery ledgers / stage diagnostics (#787).
 * Prefer this over issue labels for engine-class classification.
 */
export interface TypedSoakEvidence {
  /** Linked open issue number when known; null when evidence has no GitHub issue yet. */
  issueNumber?: number | null;
  loopRunId: string | null;
  frgRunId?: string | null;
  /** True when the item remained terminal / recovery-exhausted at run end. */
  terminal: boolean;
  /**
   * True when a recoverable intermediate blocker was recovered in-run and is
   * no longer terminal. Such events MUST NOT block release alone.
   */
  recovered: boolean;
  /** True when the blocker projects to FRG engine-class. */
  engineClass: boolean;
  blockerClass?: string | null;
  title?: string;
  reasonKey?: string;
  fingerprint?: string;
}

export interface OpenSoakDefectPreflightInput {
  version: string;
  frgRunId: string;
  loopRunId: string | null;
  /** Previous release tag name (e.g. `v1.29.0`), or empty when none. */
  previousTag: string | null;
  /**
   * ISO-8601 timestamp of the previous release tag (for created-since window).
   * Null when unknown — pure label-fallback without soak linkage is then skipped.
   */
  previousTagCreatedAt: string | null;
  /**
   * Explicit audited override reason from the release CLI. Empty/whitespace is
   * treated as absent. There is no silent env/config skip.
   */
  overrideReason?: string | null;
}

export interface OpenSoakDefectPreflightDeps {
  listOpenIssues: () => Promise<SoakDefectCandidateIssue[]>;
  /**
   * Optional typed terminal/recovery evidence for the candidate soak.
   * When omitted, only issue body markers + label fallback participate.
   */
  listTypedSoakEvidence?: () => Promise<TypedSoakEvidence[]>;
}

export interface BlockingSoakDefect {
  issueNumber: number | null;
  title: string;
  classificationSource: SoakDefectClassificationSource;
  reasonKey?: string;
}

export interface OpenSoakDefectWaiver {
  issueNumbers: number[];
  reason: string;
}

export type OpenSoakDefectPreflightResult =
  | {
      ok: true;
      blocking: BlockingSoakDefect[];
      waived?: OpenSoakDefectWaiver;
    }
  | {
      ok: false;
      blocking: BlockingSoakDefect[];
      message: string;
    };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Collect non-empty soak identity strings for body/title matching. */
export function soakIdentityIds(frgRunId: string, loopRunId: string | null): string[] {
  const ids: string[] = [];
  if (loopRunId && loopRunId.trim()) ids.push(loopRunId.trim());
  if (frgRunId && frgRunId.trim()) ids.push(frgRunId.trim());
  return ids;
}

export function issueReferencesSoak(issue: SoakDefectCandidateIssue, soakIds: string[]): boolean {
  if (soakIds.length === 0) return false;
  const hay = `${issue.title}\n${issue.body ?? ""}`;
  if (soakIds.some((id) => hay.includes(id))) return true;
  if (Array.isArray(issue.candidateRunIds)) {
    return issue.candidateRunIds.some((id) => typeof id === "string" && soakIds.includes(id));
  }
  return false;
}

/**
 * Engine-class signals from issue body/title (durable-run-blocker auto-file
 * body shape, free-form markers, optional #760 disposition fields).
 */
export function issueHasTypedEngineClassMarkers(issue: SoakDefectCandidateIssue): boolean {
  if (issue.typedDisposition && classifyFrgBlocker(issue.typedDisposition) === "engine-class") {
    return true;
  }
  const body = issue.body ?? "";
  const title = issue.title ?? "";
  const classMatch = body.match(/Blocker class:\s*([a-z0-9-]+)/i);
  if (classMatch && classifyFrgBlocker(classMatch[1]) === "engine-class") return true;
  if (/workflow-engine-defect/i.test(body) || /workflow-engine-defect/i.test(title)) return true;
  if (/disposition:\s*engine-class/i.test(body)) return true;
  if (/"blocker_class"\s*:\s*"engine-class"/i.test(body)) return true;
  if (/"classification"\s*:\s*"engine-class"/i.test(body)) return true;
  return false;
}

export function hasEngineClassLabelFallback(issue: SoakDefectCandidateIssue): boolean {
  const labels = issue.labels ?? [];
  return labels.includes(BUG_LABEL) && labels.includes(ENGINE_CLASS_MARKER_LABEL);
}

function createdAtMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Whether the issue falls in the post-previous-tag window. When the previous
 * tag timestamp is unknown, returns false (label-fallback alone cannot open
 * the whole history).
 */
export function issueInPostTagWindow(
  issue: SoakDefectCandidateIssue,
  previousTagCreatedAt: string | null,
): boolean {
  if (!previousTagCreatedAt) return false;
  const tagMs = createdAtMs(previousTagCreatedAt);
  const issueMs = createdAtMs(issue.createdAt);
  if (!Number.isFinite(tagMs) || !Number.isFinite(issueMs)) return false;
  return issueMs >= tagMs;
}

function blockingKey(b: BlockingSoakDefect): string {
  if (b.issueNumber != null) return `n:${b.issueNumber}`;
  return `t:${b.title}|${b.reasonKey ?? ""}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Discover and classify open engine-class soak defects for a candidate release.
 * Pure relative to deps — unit tests inject issue/ledger fakes; zero network.
 */
export async function runOpenSoakDefectPreflight(
  input: OpenSoakDefectPreflightInput,
  deps: OpenSoakDefectPreflightDeps,
): Promise<OpenSoakDefectPreflightResult> {
  const soakIds = soakIdentityIds(input.frgRunId, input.loopRunId);
  const openIssues = (await deps.listOpenIssues()).filter((i) => i.state === "OPEN");
  const openByNumber = new Map(openIssues.map((i) => [i.number, i]));

  const typed = deps.listTypedSoakEvidence ? await deps.listTypedSoakEvidence() : [];
  const blockingMap = new Map<string, BlockingSoakDefect>();

  const addBlocking = (b: BlockingSoakDefect): void => {
    const key = blockingKey(b);
    const existing = blockingMap.get(key);
    // Prefer typed over label-fallback when both paths hit the same issue.
    if (existing && existing.classificationSource === "typed") return;
    if (existing && b.classificationSource === "label-fallback") return;
    blockingMap.set(key, b);
  };

  // --- Typed evidence path (authoritative when present) ---
  for (const ev of typed) {
    if (!ev.engineClass) continue;
    // Converged intermediate recoveries never block.
    if (ev.recovered && !ev.terminal) continue;
    if (!ev.terminal) continue;

    // Attribute to candidate soak when run ids match (or evidence omits ids and
    // the caller already scoped the list to this soak).
    const evIds = [ev.loopRunId, ev.frgRunId].filter((x): x is string => !!x && x.trim() !== "");
    if (evIds.length > 0 && soakIds.length > 0) {
      const linked = evIds.some((id) => soakIds.includes(id));
      if (!linked) continue;
    }

    const issueNum = ev.issueNumber ?? null;
    if (issueNum != null) {
      const open = openByNumber.get(issueNum);
      if (!open) continue; // closed or missing — not an open release defect
      addBlocking({
        issueNumber: issueNum,
        title: open.title || ev.title || `issue #${issueNum}`,
        classificationSource: "typed",
        reasonKey: ev.reasonKey ?? ev.blockerClass ?? "terminal-engine-class",
      });
      continue;
    }

    // Join ledger-terminal evidence to open issues via fingerprint / soak id /
    // blocker class markers so missing issueNumber still yields a typed block.
    const matched = openIssues.filter((issue) => {
      const hay = `${issue.title}\n${issue.body ?? ""}`;
      if (ev.fingerprint && hay.includes(ev.fingerprint)) return true;
      if (ev.loopRunId && hay.includes(ev.loopRunId)) return true;
      if (ev.blockerClass && new RegExp(`Blocker class:\\s*${escapeRegExp(ev.blockerClass)}`, "i").test(hay)) {
        return soakIds.length === 0 || soakIds.some((id) => hay.includes(id));
      }
      return false;
    });
    if (matched.length > 0) {
      for (const open of matched) {
        addBlocking({
          issueNumber: open.number,
          title: open.title || ev.title || `issue #${open.number}`,
          classificationSource: "typed",
          reasonKey: ev.reasonKey ?? ev.blockerClass ?? "terminal-engine-class",
        });
      }
      continue;
    }

    // Explicit typed projection without a joinable open issue (tests / ledger-only).
    if (ev.title || ev.reasonKey) {
      addBlocking({
        issueNumber: null,
        title: ev.title ?? ev.reasonKey ?? "typed terminal engine-class defect",
        classificationSource: "typed",
        reasonKey: ev.reasonKey ?? ev.blockerClass ?? "terminal-engine-class",
      });
    }
  }

  // --- Open issues: soak-linked body markers (typed) + label fallback ---
  for (const issue of openIssues) {
    const soakLinked = issueReferencesSoak(issue, soakIds);
    const inWindow = issueInPostTagWindow(issue, input.previousTagCreatedAt);
    const typedMarkers = issueHasTypedEngineClassMarkers(issue);

    // Typed: candidate-linked (soak id or #763 run ids) + engine-class body/disposition.
    // Also accept typed markers on post-tag window issues when soak body link is missing
    // but disposition fields mark engine-class terminal defects (historical soak window).
    if (typedMarkers && (soakLinked || inWindow)) {
      // Prefer not to double-count if already typed from ledger with same number.
      addBlocking({
        issueNumber: issue.number,
        title: issue.title,
        classificationSource: "typed",
        reasonKey: "issue-typed-markers",
      });
      continue;
    }

    // Label fallback: both markers required; only when typed evidence is absent
    // for this issue. Window OR soak linkage required.
    if (!hasEngineClassLabelFallback(issue)) continue;
    if (!soakLinked && !inWindow) continue;
    // If we already have a typed entry for this issue, skip label-fallback.
    const existing = blockingMap.get(`n:${issue.number}`);
    if (existing?.classificationSource === "typed") continue;
    addBlocking({
      issueNumber: issue.number,
      title: issue.title,
      classificationSource: "label-fallback",
      reasonKey: "bug+pipeline:engine-class",
    });
  }

  const blocking = [...blockingMap.values()].sort((a, b) => {
    const an = a.issueNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.issueNumber ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return a.title.localeCompare(b.title);
  });

  if (blocking.length === 0) {
    return { ok: true, blocking: [] };
  }

  const reason = (input.overrideReason ?? "").trim();
  if (reason) {
    const issueNumbers = blocking
      .map((b) => b.issueNumber)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    return {
      ok: true,
      blocking,
      waived: { issueNumbers, reason },
    };
  }

  return {
    ok: false,
    blocking,
    message: formatOpenSoakDefectBlockMessage(input, blocking),
  };
}

/**
 * Doctor-grade fail-closed message: version, soak identity, per-issue list,
 * classification source, remediation (close/fix, re-run soak/FRG, override).
 */
export function formatOpenSoakDefectBlockMessage(
  input: Pick<OpenSoakDefectPreflightInput, "version" | "frgRunId" | "loopRunId" | "previousTag">,
  blocking: BlockingSoakDefect[],
): string {
  const soakParts: string[] = [];
  if (input.loopRunId) soakParts.push(`loop_run_id=${input.loopRunId}`);
  if (input.frgRunId) soakParts.push(`frg_run_id=${input.frgRunId}`);
  const soakLine = soakParts.length > 0 ? soakParts.join(" ") : "(soak identity unknown)";

  const lines = blocking.map((b) => {
    const num = b.issueNumber != null ? `#${b.issueNumber}` : "(no issue number)";
    const reason = b.reasonKey ? ` [${b.reasonKey}]` : "";
    return `  - ${num} — ${b.title}${reason} (source: ${b.classificationSource})`;
  });

  return [
    `[pipeline release] open engine-class soak defects block release preparation for v${input.version}.`,
    `Soak identity: ${soakLine}` +
      (input.previousTag ? `; previous tag: ${input.previousTag}` : "; no previous tag"),
    `Open blocking defects (${blocking.length}):`,
    ...lines,
    "",
    "Remediation:",
    "  1. Fix and close the listed issues (or confirm they are not engine-class terminal defects), then re-run soak/FRG if needed.",
    "  2. Re-run: pipeline factory-gate --for " + input.version,
    "  3. For a deliberate exception only: pipeline release " +
      input.version +
      ' --allow-open-soak-defects "<reason>"',
    "     (reason is recorded on the release PR body; silent skip is not available).",
  ].join("\n");
}

/**
 * Release PR body section when an audited open-soak-defect override was used.
 */
export function formatOpenSoakDefectWaiverSection(waiver: OpenSoakDefectWaiver, blocking: BlockingSoakDefect[]): string {
  const items =
    blocking.length > 0
      ? blocking.map((b) => {
          const num = b.issueNumber != null ? `#${b.issueNumber}` : "(no issue number)";
          return `- ${num} — ${b.title} (${b.classificationSource})`;
        })
      : waiver.issueNumbers.map((n) => `- #${n}`);

  return [
    "### Open soak-defect override (#755)",
    "",
    "The following open engine-class soak defects were **explicitly waived** for this release preparation:",
    "",
    ...items,
    "",
    `**Override reason:** ${waiver.reason}`,
    "",
    "_Recorded because `--allow-open-soak-defects` was supplied. Silent skip is not available._",
  ].join("\n");
}
