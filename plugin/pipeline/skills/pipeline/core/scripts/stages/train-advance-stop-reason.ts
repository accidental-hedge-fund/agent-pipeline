// Pure composition of train STOP / item-error text from structured loop evidence
// (#1074). No I/O — callers inject evidence (from loop events / drive result).

/**
 * Last advance-wave loop evidence used to build human-visible train STOP /
 * item-error / train_status.blocker text. All fields optional; absent fields
 * are never invented by the composer.
 */
export interface TrainAdvanceLoopEvidence {
  /** Last `loop_run_stopped.reason` (or drive stop.reason). */
  stopReason?: string;
  /** Last `loop_item_blocked.class`. */
  blockedClass?: string;
  /** Issue number from the last blocked item (item_id). */
  blockedIssue?: number;
  /** Optional `blocker_kind` from attempt evidence. */
  blockerKind?: string;
  /** First non-empty line of a blocker comment, when available. */
  blockerCommentFirstLine?: string;
  /** Process exit code when known (non-zero on failure paths). */
  exitCode?: number;
  /** Engine / LoopError message when the wave failed without events. */
  engineMessage?: string;
}

/** Loose event shape for pure extraction (matches loop events.jsonl records). */
export interface TrainAdvanceLoopEventLike {
  kind?: string;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** Parse issue number from item_id ("42", "#42", 42). */
export function parseIssueIdFromItemId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^#?(\d+)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Item-block fields that a later successful terminal for that item may clear. */
interface ItemBlockEvidence {
  blockedClass?: string;
  blockedIssue?: number;
  blockerKind?: string;
  blockerCommentFirstLine?: string;
}

function firstLineComment(value: string): string | undefined {
  const first = value.split(/\r?\n/, 1)[0]!.trim();
  if (!first) return undefined;
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

function readItemBlockEvidence(data: Record<string, unknown>): ItemBlockEvidence | null {
  const cls = asNonEmptyString(data.class) ?? asNonEmptyString(data.blocker_class);
  const kindField =
    asNonEmptyString(data.blocker_kind) ?? asNonEmptyString(data.blockerKind);
  const commentRaw =
    asNonEmptyString(data.blocker_comment_first_line) ??
    asNonEmptyString(data.comment_first_line) ??
    asNonEmptyString(data.evidence);
  const comment = commentRaw ? firstLineComment(commentRaw) : undefined;
  if (!cls && !kindField && !comment) return null;
  const fields: ItemBlockEvidence = {};
  if (cls) fields.blockedClass = cls;
  const issue = parseIssueIdFromItemId(data.item_id ?? data.issue);
  if (cls && issue != null) fields.blockedIssue = issue;
  if (kindField) fields.blockerKind = kindField;
  if (comment) fields.blockerCommentFirstLine = comment;
  return fields;
}

function applyItemBlockToEvidence(
  out: TrainAdvanceLoopEvidence,
  fields: ItemBlockEvidence,
): void {
  if (fields.blockedClass) out.blockedClass = fields.blockedClass;
  else delete out.blockedClass;
  if (fields.blockedIssue != null) out.blockedIssue = fields.blockedIssue;
  else delete out.blockedIssue;
  if (fields.blockerKind) out.blockerKind = fields.blockerKind;
  else delete out.blockerKind;
  if (fields.blockerCommentFirstLine) {
    out.blockerCommentFirstLine = fields.blockerCommentFirstLine;
  } else {
    delete out.blockerCommentFirstLine;
  }
}

function clearItemBlockFields(out: TrainAdvanceLoopEvidence): void {
  delete out.blockedClass;
  delete out.blockedIssue;
  delete out.blockerKind;
  delete out.blockerCommentFirstLine;
}

/** Item-level successful terminals that supersede an earlier loop_item_blocked. */
function isItemSuccessfulTerminal(
  kind: string,
  data: Record<string, unknown>,
): boolean {
  if (kind === "ready_to_deploy") return true;
  if (kind === "loop_item_transitioned") {
    const to = asNonEmptyString(data.to);
    return to === "ready" || to === "ready_to_deploy";
  }
  if (kind === "loop_item_advance_finished") {
    const outcome = asNonEmptyString(data.outcome);
    return outcome === "ready_to_deploy" || outcome === "ready";
  }
  return false;
}

/**
 * Wave-level successful terminal. `loop_run_complete` with `all_done` (or no
 * failing outcome) and explicit `all_done` clear remaining item-block fields.
 * A later `loop_run_stopped` invalidates this (caller tracks that).
 */
function isWaveSuccessfulTerminal(
  kind: string,
  data: Record<string, unknown>,
): boolean {
  if (kind === "all_done") return true;
  if (kind === "loop_run_complete") {
    const outcome =
      asNonEmptyString(data.outcome) ?? asNonEmptyString(data.completion);
    if (!outcome) return true;
    return outcome === "all_done";
  }
  return false;
}

/**
 * Scan loop events (and optional drive stop / exit) into a compact evidence
 * summary. Last **terminal** wins per item: a later successful terminal
 * (`ready_to_deploy`, ledger `ready`, or wave `all_done` / `loop_run_complete`
 * with no later `loop_run_stopped`) clears that item's current
 * `loop_item_blocked` fields. Wave `all_done` does not clear a sibling that
 * never reached ready / R2D. Does not invent classes.
 */
export function extractTrainAdvanceLoopEvidence(input: {
  events?: readonly TrainAdvanceLoopEventLike[] | null;
  /** DriveSupervisorResult.stop.reason when the engine returned drive. */
  stopReason?: string | null;
  exitCode?: number | null;
  engineMessage?: string | null;
}): TrainAdvanceLoopEvidence {
  const out: TrainAdvanceLoopEvidence = {};
  const stopFromDrive = asNonEmptyString(input.stopReason);
  if (stopFromDrive) out.stopReason = stopFromDrive;

  const blockByIssue = new Map<number, ItemBlockEvidence>();
  const readyItems = new Set<number>();
  let orphanBlock: ItemBlockEvidence | undefined;
  let waveSuccessfulTerminal = false;

  const events = input.events ?? [];
  for (const ev of events) {
    const kind = typeof ev.kind === "string" ? ev.kind : "";
    const data = asRecord(ev.data) ?? {};
    if (kind === "loop_run_stopped") {
      const reason = asNonEmptyString(data.reason);
      if (reason) out.stopReason = reason;
      // A later stop remains current even if labels later say ready-to-deploy.
      waveSuccessfulTerminal = false;
    } else if (kind === "loop_item_blocked") {
      const fields = readItemBlockEvidence(data);
      if (!fields) continue;
      const issue = parseIssueIdFromItemId(data.item_id ?? data.issue);
      if (issue != null) {
        blockByIssue.set(issue, { ...fields, blockedIssue: issue });
        readyItems.delete(issue);
      } else {
        orphanBlock = fields;
      }
    } else if (isItemSuccessfulTerminal(kind, data)) {
      const issue = parseIssueIdFromItemId(data.item_id ?? data.issue);
      if (issue != null) {
        blockByIssue.delete(issue);
        readyItems.add(issue);
      }
    } else if (isWaveSuccessfulTerminal(kind, data)) {
      waveSuccessfulTerminal = true;
    }
  }

  if (waveSuccessfulTerminal) {
    // Wave all_done / loop_run_complete: clear item-block fields only for
    // items that themselves reached ready / R2D. A sibling that is still
    // blocked keeps its class. When no item-level ready was observed, a
    // sole remaining blocked item is still cleared — all_done means that
    // item finished.
    if (readyItems.size > 0) {
      for (const issue of readyItems) blockByIssue.delete(issue);
    } else if (blockByIssue.size <= 1) {
      blockByIssue.clear();
      orphanBlock = undefined;
    }
  }

  clearItemBlockFields(out);
  if (blockByIssue.size > 0) {
    let last: ItemBlockEvidence | undefined;
    for (const fields of blockByIssue.values()) last = fields;
    if (last) applyItemBlockToEvidence(out, last);
  } else if (orphanBlock && !waveSuccessfulTerminal) {
    applyItemBlockToEvidence(out, orphanBlock);
  }

  if (typeof input.exitCode === "number" && Number.isFinite(input.exitCode)) {
    out.exitCode = input.exitCode;
  }
  const eng = asNonEmptyString(input.engineMessage);
  if (eng) out.engineMessage = eng;
  return out;
}

/** True when any of the structured (1)–(3) evidence fields is present. */
export function hasStructuredTrainAdvanceEvidence(
  evidence: TrainAdvanceLoopEvidence | null | undefined,
): boolean {
  if (!evidence) return false;
  return !!(
    evidence.stopReason ||
    evidence.blockedClass ||
    evidence.blockerKind ||
    evidence.blockerCommentFirstLine
  );
}

/**
 * Compose human-visible train STOP / item-error string.
 * Priority: stop reason → blocked class+issue → blocker_kind/comment → exit/engine.
 * Never invents a class when fields are absent.
 */
export function composeTrainAdvanceStopReason(
  evidence: TrainAdvanceLoopEvidence,
  issue?: number,
): string {
  const parts: string[] = [];

  if (evidence.stopReason) {
    parts.push(evidence.stopReason);
  }

  if (evidence.blockedClass) {
    const blockedIssue = evidence.blockedIssue ?? issue;
    if (blockedIssue != null) {
      parts.push(`${evidence.blockedClass} on #${blockedIssue}`);
    } else {
      parts.push(evidence.blockedClass);
    }
  }

  if (evidence.blockerKind) {
    parts.push(evidence.blockerKind);
  }

  if (evidence.blockerCommentFirstLine) {
    // Avoid duplicating the same token already present as stop/class.
    const line = evidence.blockerCommentFirstLine;
    if (!parts.some((p) => p === line || p.includes(line))) {
      parts.push(line);
    }
  }

  const exitOnly =
    evidence.engineMessage?.trim() ||
    (evidence.exitCode != null && evidence.exitCode !== 0
      ? `pipeline advance exited with code ${evidence.exitCode}`
      : null);

  if (parts.length === 0) {
    const body = exitOnly ?? "advance failed";
    return issue != null ? `advance failed for #${issue}: ${body}` : body;
  }

  // Structured evidence present: do not make the message exit-only. Append
  // exit code only when it adds a non-zero code not already implied by text.
  if (
    exitOnly &&
    evidence.exitCode != null &&
    evidence.exitCode !== 0 &&
    !parts.some((p) => /exited with code/.test(p))
  ) {
    // Prefer not to bury class under exit-only noise: omit exit when (1)–(3)
    // already present (issue acceptance: not solely exit-only).
  }

  const body = parts.join("; ");
  return issue != null ? `advance failed for #${issue}: ${body}` : body;
}

/**
 * Evidence scoped for one issue in a multi-item wave: keep wave stop reason;
 * keep blocked class only when it matches this issue (or issue unknown).
 */
export function scopeTrainAdvanceEvidenceForIssue(
  wave: TrainAdvanceLoopEvidence,
  issue: number,
): TrainAdvanceLoopEvidence {
  const scoped: TrainAdvanceLoopEvidence = { ...wave };
  if (
    scoped.blockedClass &&
    scoped.blockedIssue != null &&
    scoped.blockedIssue !== issue
  ) {
    delete scoped.blockedClass;
    delete scoped.blockedIssue;
    // Comment/kind were tied to that blocked item — drop if class dropped.
    delete scoped.blockerKind;
    delete scoped.blockerCommentFirstLine;
  }
  return scoped;
}
