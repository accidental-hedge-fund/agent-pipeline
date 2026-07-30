// Pre-merge gate sub-step progress mirror (#682).
//
// While a loop item's advance run is linked (`loop_item_advance_linked` …
// `loop_item_advance_finished`), the supervisor polls the advance
// `events.jsonl` path and maps material pre-merge gate outcomes onto the
// durable loop trail as `loop_item_progress` events. Observability only —
// never changes CI / OpenSpec / delta / auto-fix decisions.
//
// Advance-event → progress mapping (read-side; do not invent gh field names):
//
// | Advance event                                              | domain     | step              | status            | detail |
// |------------------------------------------------------------|------------|-------------------|-------------------|--------|
// | gate_result gate=ci result=partial                         | pre_merge  | ci                | waiting           | classification? from reason |
// | gate_result gate=ci result=pass                            | pre_merge  | ci                | pass              | |
// | gate_result gate=ci result=fail                            | pre_merge  | ci                | fail              | classification from reason |
// | gate_result gate=openspec-archive result=pass\|skipped\|fail | pre_merge | openspec_archive  | pass\|skipped\|fail | |
// | delta_round                                                | pre_merge  | delta_review      | started           | |
// | gate_result gate=delta-review result=pass                  | pre_merge  | delta_review      | approve           | |
// | gate_result gate=delta-review result=fail                  | pre_merge  | delta_review      | needs_attention   | blocking_count? |
// | gate_result gate=pre-merge-autofix result=partial          | pre_merge  | autofix           | attempted         | |
// | gate_result gate=pre-merge-autofix result=pass             | pre_merge  | autofix           | success           | |
// | gate_result gate=pre-merge-autofix result=fail             | pre_merge  | autofix           | exhausted         | |
// | stage_complete stage=pre-merge outcome=blocked             | pre_merge  | terminal          | blocked           | reason_class? |
// | stage_complete stage=pre-merge outcome=advanced            | pre_merge  | terminal          | advanced          | |
// | blocker_set (CI-shaped reason, fallback if no ci gate)     | pre_merge  | ci                | fail              | classification |
//
// Spam control: at most one ci/waiting per continuous wait stretch (fingerprint
// suppresses re-emits of identical outcomes). OpenSpec archive re-polls that
// re-append identical gate_result lines are idempotent via fingerprint.

export const LOOP_ITEM_PROGRESS = "loop_item_progress";

export type PreMergeProgressDomain = "pre_merge";

export type PreMergeProgressStep =
  | "ci"
  | "openspec_archive"
  | "delta_review"
  | "autofix"
  | "terminal";

export type PreMergeProgressStatus =
  | "waiting"
  | "pass"
  | "fail"
  | "skipped"
  | "started"
  | "approve"
  | "needs_attention"
  | "attempted"
  | "success"
  | "exhausted"
  | "blocked"
  | "advanced";

/** Join keys + typed pre-merge progress payload (#682 / design Decision 1). */
export interface LoopItemProgressPayload {
  item_id: string;
  pipeline_run_id: string;
  /** Absolute advance events.jsonl path when known from linkage. */
  events?: string;
  domain: PreMergeProgressDomain;
  step: PreMergeProgressStep;
  status: PreMergeProgressStatus;
  detail?: {
    classification?: string;
    blocking_count?: number;
    reason_class?: string;
    reason?: string;
    source_advance_type?: string;
  };
}

/** Join keys from `loop_item_advance_linked`. */
export interface ProgressLinkage {
  item_id: string;
  pipeline_run_id: string;
  events?: string;
}

/** Mutable fingerprint set for one linkage attempt. */
export interface ProgressMirrorState {
  /** Fingerprints already emitted for this linkage (`step|status|extra`). */
  emitted: Set<string>;
  /** True after a ci/waiting was emitted for the current wait stretch. */
  ciWaitingOpen: boolean;
  /**
   * Generation for the current CI wait/attempt stretch. Bumped when a new
   * waiting stretch opens so a later definitive pass/fail after rebase is not
   * collapsed into the prior stretch's permanent fingerprint (#682 ca081002).
   * Starts at 0; a direct pass/fail with no prior waiting uses gen 0.
   */
  ciStretchGen: number;
  /**
   * Complete (newline-terminated) non-empty lines already consumed from the
   * advance file. Unterminated trailing fragments are never counted here.
   */
  linesConsumed: number;
}

export function createProgressMirrorState(): ProgressMirrorState {
  return { emitted: new Set(), ciWaitingOpen: false, ciStretchGen: 0, linesConsumed: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(step: string, status: string, extra = ""): string {
  return `${step}|${status}|${extra}`;
}

function basePayload(
  linkage: ProgressLinkage,
  step: PreMergeProgressStep,
  status: PreMergeProgressStatus,
  detail?: LoopItemProgressPayload["detail"],
): LoopItemProgressPayload {
  const payload: LoopItemProgressPayload = {
    item_id: linkage.item_id,
    pipeline_run_id: linkage.pipeline_run_id,
    domain: "pre_merge",
    step,
    status,
  };
  if (linkage.events) payload.events = linkage.events;
  if (detail && Object.keys(detail).length > 0) payload.detail = detail;
  return payload;
}

function tryEmit(
  state: ProgressMirrorState,
  linkage: ProgressLinkage,
  step: PreMergeProgressStep,
  status: PreMergeProgressStatus,
  out: LoopItemProgressPayload[],
  opts?: {
    fingerprintExtra?: string;
    detail?: LoopItemProgressPayload["detail"];
  },
): void {
  const fp = fingerprint(step, status, opts?.fingerprintExtra ?? "");
  if (state.emitted.has(fp)) return;
  state.emitted.add(fp);
  out.push(basePayload(linkage, step, status, opts?.detail));
}

/** Map a known CI-shaped blocker reason into a stable classification token. */
export function classifyCiBlockerReason(reason: string): string {
  const trimmed = reason.trim();
  if (/^CI failed$/i.test(trimmed)) return "ci_failed";
  if (/ci_mode:\s*local/i.test(trimmed)) return "ci_mode_local";
  if (/CI checks failed/i.test(trimmed)) return "ci_checks_failed";
  if (/timed out/i.test(trimmed) && /CI|pre-merge/i.test(trimmed)) return "ci_timeout";
  return "ci_failure";
}

function isCiShapedBlockerReason(reason: string): boolean {
  return (
    /^CI failed$/i.test(reason.trim()) ||
    /CI checks failed/i.test(reason) ||
    /ci_mode:\s*local/i.test(reason) ||
    (/\bCI\b/.test(reason) && /fail/i.test(reason))
  );
}

function parseBlockingCount(event: Record<string, unknown>): number | undefined {
  const detail = event.detail;
  if (isRecord(detail) && typeof detail.blocking_count === "number") {
    return detail.blocking_count;
  }
  if (typeof event.blocking_count === "number") return event.blocking_count;
  const reason = typeof event.reason === "string" ? event.reason : "";
  const m = reason.match(/blocking_count=(\d+)/);
  if (m) return Number(m[1]);
  const m2 = reason.match(/(\d+)\s+blocking/);
  if (m2) return Number(m2[1]);
  return undefined;
}

/**
 * Pure mapper: given linkage join keys, a slice of advance events (already
 * ordered), and mirror state, return zero or more progress payloads and the
 * updated state. Idempotent for identical outcomes; spam-controls CI waiting.
 */
export function mapAdvanceEventsToProgress(
  linkage: ProgressLinkage,
  advanceEvents: readonly unknown[],
  state: ProgressMirrorState = createProgressMirrorState(),
): { payloads: LoopItemProgressPayload[]; state: ProgressMirrorState } {
  const out: LoopItemProgressPayload[] = [];
  // Shallow-copy state so callers can treat returns as the new state object.
  const next: ProgressMirrorState = {
    emitted: new Set(state.emitted),
    ciWaitingOpen: state.ciWaitingOpen,
    ciStretchGen: state.ciStretchGen,
    linesConsumed: state.linesConsumed,
  };

  for (const raw of advanceEvents) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (typeof type !== "string") continue;

    if (type === "gate_result") {
      const gate = typeof raw.gate === "string" ? raw.gate : "";
      const result = typeof raw.result === "string" ? raw.result : "";
      const reason = typeof raw.reason === "string" ? raw.reason : undefined;

      if (gate === "ci") {
        if (result === "partial") {
          // One waiting per continuous stretch: bump stretch gen when a new
          // wait opens so later pass/fail fingerprints are distinct across
          // rebase-triggered reruns, while re-reads of the same stretch stay
          // idempotent (#682 ca081002).
          if (!next.ciWaitingOpen) {
            next.ciStretchGen += 1;
            tryEmit(next, linkage, "ci", "waiting", out, {
              fingerprintExtra: String(next.ciStretchGen),
              detail: {
                ...(reason ? { classification: reason } : {}),
                source_advance_type: "gate_result",
              },
            });
            next.ciWaitingOpen = true;
          }
        } else if (result === "pass") {
          next.ciWaitingOpen = false;
          tryEmit(next, linkage, "ci", "pass", out, {
            fingerprintExtra: String(next.ciStretchGen),
            detail: { source_advance_type: "gate_result" },
          });
        } else if (result === "fail") {
          next.ciWaitingOpen = false;
          const classification = reason ? classifyCiBlockerReason(reason) : "ci_failure";
          tryEmit(next, linkage, "ci", "fail", out, {
            fingerprintExtra: `${next.ciStretchGen}|${classification}`,
            detail: {
              classification,
              ...(reason ? { reason } : {}),
              source_advance_type: "gate_result",
            },
          });
        }
        continue;
      }

      if (gate === "openspec-archive") {
        if (result === "pass" || result === "skipped" || result === "fail") {
          tryEmit(next, linkage, "openspec_archive", result, out, {
            fingerprintExtra: reason ?? "",
            detail: {
              ...(reason ? { reason } : {}),
              source_advance_type: "gate_result",
            },
          });
        }
        continue;
      }

      if (gate === "delta-review") {
        if (result === "pass") {
          tryEmit(next, linkage, "delta_review", "approve", out, {
            detail: { source_advance_type: "gate_result" },
          });
        } else if (result === "fail") {
          const blockingCount = parseBlockingCount(raw);
          tryEmit(next, linkage, "delta_review", "needs_attention", out, {
            fingerprintExtra: blockingCount !== undefined ? String(blockingCount) : "",
            detail: {
              ...(blockingCount !== undefined ? { blocking_count: blockingCount } : {}),
              source_advance_type: "gate_result",
            },
          });
        } else if (result === "partial") {
          tryEmit(next, linkage, "delta_review", "started", out, {
            detail: { source_advance_type: "gate_result" },
          });
        }
        continue;
      }

      if (gate === "pre-merge-autofix") {
        if (result === "partial") {
          tryEmit(next, linkage, "autofix", "attempted", out, {
            detail: { source_advance_type: "gate_result" },
          });
        } else if (result === "pass") {
          tryEmit(next, linkage, "autofix", "success", out, {
            detail: { source_advance_type: "gate_result" },
          });
        } else if (result === "fail") {
          tryEmit(next, linkage, "autofix", "exhausted", out, {
            detail: { source_advance_type: "gate_result" },
          });
        }
        continue;
      }
    }

    if (type === "delta_round") {
      tryEmit(next, linkage, "delta_review", "started", out, {
        detail: { source_advance_type: "delta_round" },
      });
      continue;
    }

    if (type === "blocker_set") {
      const reason = typeof raw.reason === "string" ? raw.reason : "";
      if (reason && isCiShapedBlockerReason(reason)) {
        next.ciWaitingOpen = false;
        const classification = classifyCiBlockerReason(reason);
        tryEmit(next, linkage, "ci", "fail", out, {
          fingerprintExtra: `${next.ciStretchGen}|${classification}`,
          detail: {
            classification,
            reason,
            source_advance_type: "blocker_set",
          },
        });
      }
      // Stash reason for a subsequent stage_complete blocked mapping when the
      // same reason arrives without a separate classification path.
      continue;
    }

    if (type === "stage_complete") {
      const stage = typeof raw.stage === "string" ? raw.stage : "";
      const outcome = typeof raw.outcome === "string" ? raw.outcome : "";
      if (stage !== "pre-merge") continue;
      if (outcome === "blocked") {
        tryEmit(next, linkage, "terminal", "blocked", out, {
          detail: {
            reason_class: "blocked",
            source_advance_type: "stage_complete",
          },
        });
      } else if (outcome === "advanced") {
        tryEmit(next, linkage, "terminal", "advanced", out, {
          detail: { source_advance_type: "stage_complete" },
        });
      }
    }
  }

  return { payloads: out, state: next };
}

/**
 * Parse a full advance events.jsonl body into event objects, skipping corrupt
 * or partial lines (same spirit as run-store readEvents).
 */
export function parseAdvanceEventsJsonl(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // skip corrupt / partial tail
    }
  }
  return events;
}

/**
 * Consume newly appended advance events since `state.linesConsumed` and map
 * them to progress payloads. Updates `linesConsumed` to the count of complete
 * (newline-terminated) non-empty records only.
 *
 * An unterminated trailing fragment — e.g. a concurrent append still in flight —
 * is never counted as consumed. The next poll re-reads the full file and
 * processes that record once a terminating newline appears. Counting partial
 * tails would permanently skip the completed gate outcome on the subsequent poll.
 */
export function mapNewAdvanceLinesToProgress(
  linkage: ProgressLinkage,
  rawJsonl: string,
  state: ProgressMirrorState,
): { payloads: LoopItemProgressPayload[]; state: ProgressMirrorState } {
  // Only newline-terminated records are complete. Content after the last `\n`
  // (or the entire body when no newline exists) is an incomplete tail.
  const lastNl = rawJsonl.lastIndexOf("\n");
  const completeBody = lastNl === -1 ? "" : rawJsonl.slice(0, lastNl + 1);
  const nonemptyComplete: string[] = [];
  for (const line of completeBody.split("\n")) {
    if (line.trim()) nonemptyComplete.push(line);
  }
  const startIdx = Math.min(state.linesConsumed, nonemptyComplete.length);
  const newLines = nonemptyComplete.slice(startIdx);
  const newEvents = parseAdvanceEventsJsonl(newLines.join("\n"));
  const mapped = mapAdvanceEventsToProgress(linkage, newEvents, state);
  return {
    payloads: mapped.payloads,
    state: { ...mapped.state, linesConsumed: nonemptyComplete.length },
  };
}

/** Deps for the background mirror session (injected; no real FS in unit tests). */
export interface ProgressMirrorDeps {
  /** Read the full advance events.jsonl contents (missing → ""). */
  readAdvanceEventsFile(eventsPath: string): Promise<string>;
  /** Append one progress event to the loop trail. Non-fatal: caller catches. */
  appendProgress(payload: LoopItemProgressPayload): Promise<void>;
  /** Sleep between polls. */
  sleep(ms: number): Promise<void>;
  pollIntervalMs?: number;
}

/**
 * Arm a background poller that mirrors material pre-merge progress until
 * `stop()` is called. Failures reading/appending are best-effort (never throw
 * to the advance child). Requires a known absolute `events` path on linkage.
 */
export function armProgressMirror(
  linkage: ProgressLinkage,
  deps: ProgressMirrorDeps,
): { stop: () => Promise<void> } {
  if (!linkage.events) {
    return { stop: async () => undefined };
  }
  const eventsPath = linkage.events;
  const pollMs = deps.pollIntervalMs ?? 500;
  let state = createProgressMirrorState();
  let stopped = false;
  let loopPromise: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    let raw = "";
    try {
      raw = await deps.readAdvanceEventsFile(eventsPath);
    } catch {
      return;
    }
    const mapped = mapNewAdvanceLinesToProgress(linkage, raw, state);
    state = mapped.state;
    for (const payload of mapped.payloads) {
      try {
        await deps.appendProgress(payload);
      } catch {
        // best-effort — never block advance
      }
    }
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      await tick();
      if (stopped) break;
      try {
        // Always yield at least one macrotask so a zero-delay sleep inject
        // cannot starve the event loop (and never busy-spin the host).
        await deps.sleep(pollMs);
        await new Promise<void>((r) => setImmediate(r));
      } catch {
        break;
      }
    }
  };

  loopPromise = run();

  return {
    stop: async () => {
      stopped = true;
      // Final drain so events written just before child exit are not missed.
      await tick();
      if (loopPromise) {
        try {
          await loopPromise;
        } catch {
          // ignore
        }
      }
    },
  };
}
