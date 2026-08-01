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
  /**
   * Optional closed issues for fingerprint / issue-number reconciliation.
   * Terminal ledger evidence with `issueNumber: null` must not emit a synthetic
   * unlinked blocker when a closed GitHub issue already records that fingerprint
   * (closing the defect clears the release gate).
   */
  listClosedIssues?: () => Promise<SoakDefectCandidateIssue[]>;
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

/**
 * Parse structured #760 / auto-file attribution from an issue body when present.
 * Free-form prose alone is not enough — only explicit disposition/blocker-class
 * lines and affected-run lists project into typed fields.
 */
export function projectIssueTypedAttribution(body: string | null | undefined): {
  typedDisposition: string | null;
  candidateRunIds: string[];
  fingerprint: string | null;
  /** True when the body explicitly records a terminal stop / exhaustion. */
  terminalStop: boolean | null;
} {
  const text = body ?? "";
  let typedDisposition: string | null = null;
  const classMatch =
    text.match(/\*\*Blocker class\*\*:\s*([a-z0-9-]+)/i) ??
    text.match(/Blocker class:\s*([a-z0-9-]+)/i) ??
    text.match(/typed[_ ]disposition:\s*([a-z0-9-]+)/i) ??
    text.match(/disposition:\s*([a-z0-9-]+)/i);
  if (classMatch) typedDisposition = classMatch[1]!.toLowerCase();

  let fingerprint: string | null = null;
  const fpMatch =
    text.match(/\*\*Evidence fingerprint\*\*:\s*([^\s\n]+)/i) ??
    text.match(/Evidence fingerprint:\s*([^\s\n]+)/i);
  if (fpMatch) fingerprint = fpMatch[1]!.trim();

  const candidateRunIds: string[] = [];
  // Prefer the structured "Affected run IDs" section; also accept #763-style lists.
  const runSection = text.match(
    /(?:###\s*Affected run IDs|candidate[_ ]run[_ ]ids?)\s*:?\s*\n((?:[-*]\s*.+\n?)*)/i,
  );
  if (runSection) {
    for (const line of runSection[1]!.split("\n")) {
      const m = line.match(/^[-*]\s*`?([^\s`]+)`?\s*$/);
      if (m) candidateRunIds.push(m[1]!);
    }
  }

  let terminalStop: boolean | null = null;
  const termMatch = text.match(/\*\*Terminal stop\*\*:\s*(yes|no)\b/i);
  if (termMatch) terminalStop = termMatch[1]!.toLowerCase() === "yes";

  return { typedDisposition, candidateRunIds, fingerprint, terminalStop };
}

/** Whether issue text / haystack contains a defect fingerprint token. */
export function issueMatchesFingerprint(
  issue: Pick<SoakDefectCandidateIssue, "title" | "body">,
  fingerprint: string,
): boolean {
  if (!fingerprint || !fingerprint.trim()) return false;
  const hay = `${issue.title}\n${issue.body ?? ""}`;
  return hay.includes(fingerprint);
}

function createdAtMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** Candidate-link check for typed evidence against soak ids. */
function typedEvidenceLinkedToSoak(
  ev: TypedSoakEvidence,
  soakIds: string[],
): boolean {
  const evIds = [ev.loopRunId, ev.frgRunId].filter((x): x is string => !!x && x.trim() !== "");
  // Caller-scoped lists (no ids on evidence) are treated as already candidate-scoped.
  if (evIds.length === 0) return true;
  if (soakIds.length === 0) return true;
  return evIds.some((id) => soakIds.includes(id));
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
  const closedIssues = deps.listClosedIssues
    ? (await deps.listClosedIssues()).filter((i) => i.state === "CLOSED")
    : [];

  const typed = deps.listTypedSoakEvidence ? await deps.listTypedSoakEvidence() : [];
  const blockingMap = new Map<string, BlockingSoakDefect>();
  /**
   * Issues for which usable typed evidence already determined recovered /
   * non-terminal / non-engine-class (or already classified as typed). Label
   * fallback MUST NOT override that determination (#755 review 2).
   */
  const suppressLabelFallback = new Set<number>();

  const addBlocking = (b: BlockingSoakDefect): void => {
    const key = blockingKey(b);
    const existing = blockingMap.get(key);
    // Prefer typed over label-fallback when both paths hit the same issue.
    if (existing && existing.classificationSource === "typed") return;
    if (existing && b.classificationSource === "label-fallback") return;
    blockingMap.set(key, b);
    if (b.issueNumber != null && b.classificationSource === "typed") {
      suppressLabelFallback.add(b.issueNumber);
    }
  };

  const openIssuesMatchingEvidence = (ev: TypedSoakEvidence): SoakDefectCandidateIssue[] => {
    return openIssues.filter((issue) => {
      // Explicit issue linkage is authoritative when present.
      if (ev.issueNumber != null) return issue.number === ev.issueNumber;
      // Defect-specific identity required before projecting terminal/recovery
      // evidence onto an open issue. blockerClass / typedDisposition are
      // category-level and would over-join unrelated same-class soak issues
      // (one terminal occurrence marking a recovered sibling as terminal).
      if (!ev.fingerprint) return false;
      const soakLinked = soakIds.length === 0 || issueReferencesSoak(issue, soakIds);
      if (!soakLinked) return false;
      return issueMatchesFingerprint(issue, ev.fingerprint);
    });
  };

  // --- Typed coverage (including recovered / non-terminal / non-engine) ---
  // Record issues that usable typed evidence already speaks for so label
  // fallback cannot resurrect them as release blockers.
  for (const ev of typed) {
    if (!typedEvidenceLinkedToSoak(ev, soakIds)) continue;
    const covers =
      (ev.recovered && !ev.terminal) || !ev.terminal || !ev.engineClass;
    if (!covers) continue;
    if (ev.issueNumber != null) {
      suppressLabelFallback.add(ev.issueNumber);
      continue;
    }
    for (const open of openIssuesMatchingEvidence(ev)) {
      suppressLabelFallback.add(open.number);
    }
  }

  // --- Typed evidence path (authoritative when present) ---
  for (const ev of typed) {
    if (!ev.engineClass) continue;
    // Converged intermediate recoveries never block.
    if (ev.recovered && !ev.terminal) continue;
    if (!ev.terminal) continue;
    if (!typedEvidenceLinkedToSoak(ev, soakIds)) continue;

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

    // Join ledger-terminal evidence to open issues only via defect-specific
    // linkage (issue number handled above; fingerprint here). Soak identity
    // is an additional constraint — never sufficient alone; blocker class /
    // disposition alone is category-level and MUST NOT join.
    const matched = openIssuesMatchingEvidence(ev);
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

    // Fingerprint present: reconcile against closed GitHub records before any
    // synthetic unlinked blocker. A closed matching issue means the defect was
    // resolved and MUST NOT reappear as a ledger-only block.
    if (ev.fingerprint) {
      const closedMatch = closedIssues.some(
        (issue) =>
          issueMatchesFingerprint(issue, ev.fingerprint!) &&
          (soakIds.length === 0 || issueReferencesSoak(issue, soakIds)),
      );
      if (closedMatch) continue;
      // Open+closed search found nothing → no GitHub-backed record for this
      // fingerprint. Emit synthetic only when the evidence names a defect
      // surface (title/reason) so empty shells do not invent blockers.
      if (ev.title || ev.reasonKey) {
        addBlocking({
          issueNumber: null,
          title: ev.title ?? ev.reasonKey ?? "typed terminal engine-class defect",
          classificationSource: "typed",
          reasonKey: ev.reasonKey ?? ev.blockerClass ?? "terminal-engine-class",
        });
      }
      continue;
    }

    // No defect-specific identity and no open join: leave unmatched terminal
    // evidence synthetic rather than borrowing terminal state from same-class
    // open issues. Only for explicit ledger-only projections (title/reason).
    if (ev.title || ev.reasonKey) {
      addBlocking({
        issueNumber: null,
        title: ev.title ?? ev.reasonKey ?? "typed terminal engine-class defect",
        classificationSource: "typed",
        reasonKey: ev.reasonKey ?? ev.blockerClass ?? "terminal-engine-class",
      });
    }
  }

  // --- Open issues: label fallback only (body markers are non-authoritative) ---
  // Uncorroborated issue body text (workflow-engine-defect strings, disposition
  // markers, etc.) MUST NOT alone establish a typed terminal block — that would
  // treat open tracking notes for in-run recoveries as release blockers.
  // Typed classification comes solely from the ledger/diagnostic path above,
  // which requires terminal / recovery-exhaustion evidence.
  for (const issue of openIssues) {
    const soakLinked = issueReferencesSoak(issue, soakIds);
    const inWindow = issueInPostTagWindow(issue, input.previousTagCreatedAt);

    // Label fallback: both markers required; only when typed evidence is absent
    // for this issue. Window OR soak linkage required.
    if (!hasEngineClassLabelFallback(issue)) continue;
    if (!soakLinked && !inWindow) continue;
    // Typed evidence already classified or determined recovered/non-engine.
    if (suppressLabelFallback.has(issue.number)) continue;
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
