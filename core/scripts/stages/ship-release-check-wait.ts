// Shared ship-release check waiter (#1110 / #1205).
//
// Classifies a `gh pr checks --json name,state,bucket,link` capture into exactly
// one of green / pending / rerun / fail. In-engine `pipeline ship` applies this
// law before `release finish`. Tugboat may keep calling the Python helper; it
// is not the only implementation.
//
// Classification is deterministic from check metadata. It does not read a
// `conclusion` field (gh has none).

import { extractWorkflowRunId } from "../gh.ts";

export const PR_CHECKS_JSON_FIELDS = ["name", "state", "bucket", "link"] as const;

export const DEFAULT_FLAKE_ELIGIBLE_CHECKS = ["test"] as const;
export const DEFAULT_RERUN_BUDGET = 1;
export const MAX_RERUN_BUDGET = 2;
export const DEFAULT_RELEASE_CHECK_WAIT_ATTEMPTS = 120;
export const DEFAULT_RELEASE_CHECK_WAIT_MS = 10_000;

export type ReleaseCheckWaitOutcome = "green" | "pending" | "rerun" | "fail";

export interface ReleaseCheckCapture {
  name?: string;
  state?: string;
  bucket?: string;
  link?: string;
  description?: string;
}

export interface ClassifyReleaseChecksOptions {
  allowlist?: readonly string[];
  remaining?: number;
  budget?: number;
  pr?: number | string;
  failedTitle?: string;
}

export interface ReleaseCheckSidecar {
  pr: string;
  outcome: "rerun" | "fail";
  check_name: string;
  bucket: string;
  state: string;
  link: string;
  run_id: string;
  failed_test_title: string;
  reason: string;
}

export interface ClassifyReleaseChecksResult {
  outcome: ReleaseCheckWaitOutcome;
  sidecar: ReleaseCheckSidecar | null;
  failed: ReleaseCheckCapture[];
}

export interface ReleaseCheckRerunAttempt {
  run_id: string;
  at: string;
}

export interface ReleaseCheckRerunBudgetEntry {
  pr: string;
  head_sha: string;
  attempts: ReleaseCheckRerunAttempt[];
}

export interface ReleaseCheckRerunBudgetDoc {
  schema_version: 1;
  entries: ReleaseCheckRerunBudgetEntry[];
}

export interface RerunFailedWorkflowsResult {
  attempted: boolean;
  runIds: string[];
  reason?: string;
}

export interface ShipReleaseCheckWaitDeps {
  getPrChecks(pr: number): Promise<readonly ReleaseCheckCapture[]>;
  rerunFailedWorkflows(
    failed: readonly ReleaseCheckCapture[],
  ): Promise<RerunFailedWorkflowsResult>;
  sleep(ms: number): Promise<void>;
  loadAttemptCount(pr: number, headSha: string): Promise<number>;
  recordAttempt(pr: number, headSha: string, runId: string): Promise<void>;
  /**
   * Re-observe the live release-PR head after each checks capture.
   * Return the current head SHA. A mismatch with `expectedHeadSha` stops
   * the waiter without rerun or green-return.
   */
  verifyReleaseHead?(pr: number, expectedHeadSha: string): Promise<string>;
  onWaitTick?(tick: {
    pr: number;
    attempt: number;
    outcome: ReleaseCheckWaitOutcome;
    detail: string;
  }): Promise<void> | void;
  maxAttempts?: number;
  intervalMs?: number;
  rerunBudget?: number;
  allowlist?: readonly string[];
}

export class ShipReleaseCheckWaitError extends Error {
  readonly outcome: "fail" | "pending";
  constructor(outcome: "fail" | "pending", message: string) {
    super(message);
    this.name = "ShipReleaseCheckWaitError";
    this.outcome = outcome;
  }
}

const PENDING_STATES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "QUEUED",
  "WAITING",
  "REQUESTED",
]);
const PENDING_BUCKETS = new Set(["PENDING"]);
const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED"]);
const FAIL_BUCKETS = new Set(["FAIL", "FAILURE", "ERROR", "CANCEL", "CANCELLED"]);
const PASS_BUCKETS = new Set([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
  "EMPTY",
  "PASS",
  "SKIPPING",
  "SKIP",
  "",
]);
const FAIL_TITLE_RE = /^[✖×]\s+(.+)$/;

export function clampRerunBudget(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RERUN_BUDGET;
  if (n > MAX_RERUN_BUDGET) return MAX_RERUN_BUDGET;
  return Math.floor(n);
}

export function parseFlakeAllowlist(raw: unknown): readonly string[] {
  if (raw == null || raw === "") return DEFAULT_FLAKE_ELIGIBLE_CHECKS;
  if (Array.isArray(raw)) {
    const names = raw.map((item) => String(item).trim()).filter(Boolean);
    return names.length > 0 ? names : DEFAULT_FLAKE_ELIGIBLE_CHECKS;
  }
  const names = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return names.length > 0 ? names : DEFAULT_FLAKE_ELIGIBLE_CHECKS;
}

function stateOf(check: ReleaseCheckCapture): string {
  return String(check.state ?? "").toUpperCase();
}

function bucketOf(check: ReleaseCheckCapture): string {
  return String(check.bucket ?? "").toUpperCase();
}

function isPending(check: ReleaseCheckCapture): boolean {
  const st = stateOf(check);
  const bucket = bucketOf(check);
  if (PENDING_STATES.has(st) || PENDING_BUCKETS.has(bucket)) return true;
  if (FAIL_STATES.has(st) || FAIL_BUCKETS.has(bucket)) return false;
  if (bucket && !PASS_BUCKETS.has(bucket)) return true;
  return false;
}

function isFail(check: ReleaseCheckCapture): boolean {
  return FAIL_STATES.has(stateOf(check)) || FAIL_BUCKETS.has(bucketOf(check));
}

function isFlakeEligible(name: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(name);
}

export function extractFailedTestTitle(text: string | undefined | null): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const match = FAIL_TITLE_RE.exec(line.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function pickFailedCheck(
  fails: ReleaseCheckCapture[],
  allowlist: readonly string[],
): ReleaseCheckCapture {
  for (const check of fails) {
    if (!isFlakeEligible(String(check.name ?? ""), allowlist)) return check;
  }
  return fails[0]!;
}

export function formatReleaseCheckFailReason(opts: {
  pr?: number | string;
  name: string;
  bucket: string;
  link: string;
  title?: string | null;
  note?: string | null;
}): string {
  const parts: string[] = [];
  if (opts.pr !== undefined && opts.pr !== null && String(opts.pr) !== "") {
    parts.push(`PR #${opts.pr}`);
  }
  parts.push(`check ${opts.name || "?"}`);
  parts.push(opts.bucket || "fail");
  if (opts.link) parts.push(opts.link);
  let reason = parts.join(" ");
  if (opts.title) reason = `${reason} — ${opts.title}`;
  if (opts.note) reason = `${reason} (${opts.note})`;
  return reason;
}

function buildSidecar(opts: {
  outcome: "rerun" | "fail";
  pr?: number | string;
  check: ReleaseCheckCapture;
  title?: string | null;
  note?: string | null;
}): ReleaseCheckSidecar {
  const name = String(opts.check.name ?? "");
  const bucket = String(opts.check.bucket || "fail");
  const state = String(opts.check.state ?? "");
  const link = String(opts.check.link ?? "");
  const runId = extractWorkflowRunId(link) ?? "";
  const title =
    opts.title ||
    extractFailedTestTitle(opts.check.description) ||
    "";
  return {
    pr: opts.pr !== undefined && opts.pr !== null ? String(opts.pr) : "",
    outcome: opts.outcome,
    check_name: name,
    bucket,
    state,
    link,
    run_id: runId,
    failed_test_title: title,
    reason: formatReleaseCheckFailReason({
      pr: opts.pr,
      name,
      bucket,
      link,
      title: title || null,
      note: opts.note,
    }),
  };
}

export function emptyRerunBudgetDoc(): ReleaseCheckRerunBudgetDoc {
  return { schema_version: 1, entries: [] };
}

export function parseRerunBudgetDoc(raw: unknown): ReleaseCheckRerunBudgetDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyRerunBudgetDoc();
  }
  const doc = raw as { schema_version?: unknown; entries?: unknown };
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  return {
    schema_version: 1,
    entries: entries.flatMap((entry): ReleaseCheckRerunBudgetEntry[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as {
        pr?: unknown;
        head_sha?: unknown;
        attempts?: unknown;
      };
      const attempts = Array.isArray(row.attempts) ? row.attempts : [];
      return [{
        pr: String(row.pr ?? ""),
        head_sha: String(row.head_sha ?? ""),
        attempts: attempts.flatMap((attempt): ReleaseCheckRerunAttempt[] => {
          if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return [];
          const item = attempt as { run_id?: unknown; at?: unknown };
          return [{
            run_id: String(item.run_id ?? ""),
            at: String(item.at ?? ""),
          }];
        }),
      }];
    }),
  };
}

export function attemptCountFor(
  doc: ReleaseCheckRerunBudgetDoc,
  pr: number | string,
  headSha: string,
): number {
  const keyPr = String(pr);
  const keySha = String(headSha);
  for (const entry of doc.entries) {
    if (entry.pr === keyPr && entry.head_sha === keySha) {
      return entry.attempts.length;
    }
  }
  return 0;
}

export function withRecordedAttempt(
  doc: ReleaseCheckRerunBudgetDoc,
  pr: number | string,
  headSha: string,
  runId: string,
  at: string,
): ReleaseCheckRerunBudgetDoc {
  const keyPr = String(pr);
  const keySha = String(headSha);
  const entries = doc.entries.map((entry) => ({
    ...entry,
    attempts: [...entry.attempts],
  }));
  let entry = entries.find((row) => row.pr === keyPr && row.head_sha === keySha);
  if (!entry) {
    entry = { pr: keyPr, head_sha: keySha, attempts: [] };
    entries.push(entry);
  }
  entry.attempts.push({ run_id: runId, at });
  return { schema_version: 1, entries };
}

/**
 * Classify a checks capture. Uses name, state, bucket, and link only.
 * Does not read a conclusion field.
 */
export function classifyReleaseChecks(
  checks: readonly ReleaseCheckCapture[] | null | undefined,
  opts: ClassifyReleaseChecksOptions = {},
): ClassifyReleaseChecksResult {
  const allowlist = parseFlakeAllowlist(opts.allowlist);
  const budget = clampRerunBudget(opts.budget);
  const remaining = opts.remaining ?? budget;
  const pr = opts.pr;

  if (!checks || checks.length === 0) {
    return { outcome: "green", sidecar: null, failed: [] };
  }

  let pending = false;
  const fails: ReleaseCheckCapture[] = [];
  for (const check of checks) {
    if (isPending(check)) pending = true;
    if (isFail(check)) fails.push(check);
  }

  if (pending) return { outcome: "pending", sidecar: null, failed: fails };
  if (fails.length === 0) return { outcome: "green", sidecar: null, failed: [] };

  const chosen = pickFailedCheck(fails, allowlist);
  const allFlake = fails.every((check) =>
    isFlakeEligible(String(check.name ?? ""), allowlist),
  );
  const hasRunId = fails.some((check) => extractWorkflowRunId(check.link) != null);

  if (!allFlake) {
    const note =
      fails.length === 1 ? "non-flake product fail" : "mixed flake and product fail";
    return {
      outcome: "fail",
      sidecar: buildSidecar({
        outcome: "fail",
        pr,
        check: chosen,
        title: opts.failedTitle,
        note,
      }),
      failed: fails,
    };
  }
  if (!hasRunId) {
    return {
      outcome: "fail",
      sidecar: buildSidecar({
        outcome: "fail",
        pr,
        check: chosen,
        title: opts.failedTitle,
        note: "no workflow run id",
      }),
      failed: fails,
    };
  }
  if (remaining <= 0) {
    return {
      outcome: "fail",
      sidecar: buildSidecar({
        outcome: "fail",
        pr,
        check: chosen,
        title: opts.failedTitle,
        note: "rerun budget spent",
      }),
      failed: fails,
    };
  }
  return {
    outcome: "rerun",
    sidecar: buildSidecar({
      outcome: "rerun",
      pr,
      check: chosen,
      title: opts.failedTitle,
    }),
    failed: fails,
  };
}

function pendingCheckpointMessage(pr: number, attempts: number): string {
  return (
    `ship release: PR #${pr} checks still pending after ${attempts} polls; ` +
    "retry the same ship command to resume"
  );
}

function headChangedCheckpointMessage(
  pr: number,
  preparedHead: string,
  liveHead: string,
): string {
  return (
    `ship release: PR #${pr} head changed during wait ` +
    `(prepared ${preparedHead}, live ${liveHead || "unknown"}); ` +
    "retry the same ship command to resume"
  );
}

function failMessage(pr: number, classified: ClassifyReleaseChecksResult): string {
  const reason = classified.sidecar?.reason;
  if (reason) return `ship release: ${reason}`;
  return `ship release: PR #${pr} checks failed`;
}

/**
 * Poll until the waiter classifies green. Pending keeps waiting. Rerun
 * requests one bounded `gh run rerun --failed` per head SHA, then waits.
 * Fail throws without returning. Session-cap expiry while pending throws a
 * pending checkpoint (not terminal fail) so the same argv can resume.
 */
export async function waitForReleasePrChecks(opts: {
  pr: number;
  headSha: string;
  deps: ShipReleaseCheckWaitDeps;
}): Promise<void> {
  const { pr, headSha, deps } = opts;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_RELEASE_CHECK_WAIT_ATTEMPTS;
  const intervalMs = deps.intervalMs ?? DEFAULT_RELEASE_CHECK_WAIT_MS;
  const budget = clampRerunBudget(deps.rerunBudget);
  const allowlist = parseFlakeAllowlist(deps.allowlist);
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const checks = await deps.getPrChecks(pr);
    let liveHead = headSha;
    if (deps.verifyReleaseHead) {
      liveHead = await deps.verifyReleaseHead(pr, headSha);
      if (!liveHead || liveHead !== headSha) {
        throw new ShipReleaseCheckWaitError(
          "pending",
          headChangedCheckpointMessage(pr, headSha, liveHead),
        );
      }
    }
    const used = !pr || !liveHead
      ? budget
      : await deps.loadAttemptCount(pr, liveHead);
    const remaining = !pr || !liveHead ? 0 : Math.max(0, budget - used);
    const classified = classifyReleaseChecks(checks, {
      allowlist,
      remaining,
      budget,
      pr,
    });
    const detail = classified.sidecar?.reason ?? classified.outcome;
    if (deps.onWaitTick) {
      await deps.onWaitTick({ pr, attempt, outcome: classified.outcome, detail });
    }

    if (classified.outcome === "green") return;

    if (classified.outcome === "pending") {
      if (attempt >= attempts) {
        throw new ShipReleaseCheckWaitError("pending", pendingCheckpointMessage(pr, attempts));
      }
      await deps.sleep(intervalMs);
      continue;
    }

    if (classified.outcome === "rerun") {
      const runId = classified.sidecar?.run_id ?? "";
      if (!runId) {
        throw new ShipReleaseCheckWaitError("fail", failMessage(pr, classified));
      }
      try {
        await deps.recordAttempt(pr, liveHead, runId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ShipReleaseCheckWaitError(
          "fail",
          `ship release: PR #${pr} failed to record rerun attempt (${msg})`,
        );
      }
      const rerun = await deps.rerunFailedWorkflows(classified.failed);
      if (!rerun.attempted) {
        throw new ShipReleaseCheckWaitError(
          "fail",
          `ship release: PR #${pr} check test rerun failed${rerun.reason ? `: ${rerun.reason}` : ""}`,
        );
      }
      if (attempt >= attempts) {
        throw new ShipReleaseCheckWaitError("pending", pendingCheckpointMessage(pr, attempts));
      }
      await deps.sleep(intervalMs);
      continue;
    }

    throw new ShipReleaseCheckWaitError("fail", failMessage(pr, classified));
  }

  throw new ShipReleaseCheckWaitError("pending", pendingCheckpointMessage(pr, attempts));
}
