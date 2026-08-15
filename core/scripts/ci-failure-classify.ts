/**
 * Deterministic pre-merge CI failure classification (#679 / #1081).
 *
 * Maps check metadata + optional log excerpts to one of:
 *   - docs_stale — generate-docs --check / generator-owned freshness fail
 *   - infra    — runner/setup/IPC/OOM/cancelled/transient GH infrastructure
 *   - assertion — product test/lint/type failures with assertion/compiler output
 *   - unknown  — cannot classify confidently
 *
 * Mixed sets prefer `assertion` so we never paper over product red with re-run-only.
 * Pure docs_stale (no assertion/infra) is regen-able, not unknown.
 * Pure; no I/O.
 */

import type { CheckRun } from "./types.ts";

export type CiFailureClass = "docs_stale" | "infra" | "assertion" | "unknown";

export interface ClassifyCiFailureInput {
  /** Definitive failed checks (bucket fail/cancel). */
  failed: CheckRun[];
  /** Optional per-check or aggregate log excerpt(s). */
  logExcerpt?: string | null;
}

/** Infrastructure / flake signatures (case-insensitive substring match). */
const INFRA_SIGNATURES: readonly string[] = [
  "unable to deserialize cloned data",
  "invalid or unsupported version",
  "the runner has received a shutdown signal",
  "the job was not started because recent account payments have failed",
  "no space left on device",
  "enospc",
  "killed process",
  "out of memory",
  "oom-kill",
  "oom killed",
  "java.lang.outofmemoryerror",
  "the operation was canceled",
  "the operation was cancelled",
  "runner setup failed",
  "failed to set up runner",
  "error: process completed with exit code 143", // SIGTERM
  "connection reset by peer",
  "temporary failure in name resolution",
  "could not resolve host",
  "rate limit",
  "502 bad gateway",
  "503 service unavailable",
  "gateway timeout",
  "socket hang up",
  "econnreset",
  "etimedout",
  "the self-hosted runner lost communication",
  "docker: error response from daemon",
  "cannot connect to the docker daemon",
];

/**
 * Product assertion / compiler / lint signatures.
 * Avoid ultra-generic phrases (e.g. bare "exit code 1", bare check names) that
 * would classify every red check as assertion.
 */
const ASSERTION_SIGNATURES: readonly string[] = [
  "assertionerror",
  "assertion failed",
  "assert.equal",
  "assert.strictEqual",
  "assert.deep.equal",
  "assert.deepequal",
  "assert.ok(",
  "assert.fail",
  "expected ",
  "to deeply equal",
  "to strict equal",
  "should equal",
  "failing tests:",
  "tests failed",
  "failed tests:",
  "npm err! test failed",
  "error ts",
  "typescript error",
  "error: ts",
  "error[e",
  "cannot find name '",
  "is not assignable to",
  "typeerror:",
  "referenceerror:",
  "syntaxerror:",
  "cannot find module",
  "module not found",
  "compilation failed",
  "build failed",
  "lint failed",
  "not ok ",
];

/**
 * Generator-owned docs freshness signatures (#1081).
 * Keep these specific so a product test mentioning CHANGELOG.md is not
 * classified as regen-able.
 */
const DOCS_STALE_SIGNATURES: readonly string[] = [
  "generate-docs --check: stale generated docs:",
  "stale generated docs:",
  "run: node scripts/generate-docs.mjs",
];

function haystackForCheck(check: CheckRun, logExcerpt?: string | null): string {
  const parts = [
    check.name ?? "",
    check.bucket ?? "",
    check.state ?? "",
    check.description ?? "",
    logExcerpt ?? "",
  ];
  return parts.join("\n").toLowerCase();
}

function matchesAny(haystack: string, signatures: readonly string[]): boolean {
  for (const sig of signatures) {
    if (haystack.includes(sig.toLowerCase())) return true;
  }
  return false;
}

/**
 * Classify a single failed check (plus optional shared log excerpt).
 * Cancel buckets lean infra unless assertion text is also present.
 */
export function classifySingleCheck(
  check: CheckRun,
  logExcerpt?: string | null,
): CiFailureClass {
  const haystack = haystackForCheck(check, logExcerpt);
  const bucket = (check.bucket ?? "").toLowerCase();
  const hasAssertion = matchesAny(haystack, ASSERTION_SIGNATURES);
  const hasInfra =
    bucket === "cancel" ||
    matchesAny(haystack, INFRA_SIGNATURES);
  const hasDocsStale = matchesAny(haystack, DOCS_STALE_SIGNATURES);

  if (hasAssertion) return "assertion";
  if (hasInfra) return "infra";
  if (hasDocsStale) return "docs_stale";
  return "unknown";
}

/**
 * Classify a set of definitive failures into exactly one overall class.
 * Mixed assertion + anything → assertion. Pure infra → infra. Pure docs_stale
 * (no assertion/infra) → docs_stale. Else unknown unless infra is present.
 */
export function classifyCiFailure(input: ClassifyCiFailureInput): CiFailureClass {
  const { failed, logExcerpt } = input;
  if (!failed || failed.length === 0) return "unknown";

  let anyAssertion = false;
  let anyInfra = false;
  let anyDocsStale = false;
  let anyUnknown = false;

  for (const check of failed) {
    const cls = classifySingleCheck(check, logExcerpt);
    if (cls === "assertion") anyAssertion = true;
    else if (cls === "infra") anyInfra = true;
    else if (cls === "docs_stale") anyDocsStale = true;
    else anyUnknown = true;
  }

  // Mixed set policy: prefer assertion so product red is never hidden.
  if (anyAssertion) return "assertion";
  if (anyInfra && !anyUnknown) return "infra";
  if (anyInfra && anyUnknown) return "infra"; // unknown + infra still takes re-run budget
  if (anyDocsStale && !anyUnknown) return "docs_stale";
  return "unknown";
}
