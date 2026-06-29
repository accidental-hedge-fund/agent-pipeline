// Dedicated append-only transitions log for pipeline stage monitoring (#324).
//
// Every `[pipeline] #N:` lifecycle line is mirrored here in addition to stdout,
// so operators can monitor stage changes with a plain `tail -f` and no grep filter.
// The full log (stdout) is unchanged — this file is a strictly additive channel.

import { appendFileSync } from "node:fs";

/** Returns the transitions log path for a domain + issue number.
 *  Mirrors the `/tmp/pipeline-<domain>-<N>.*` naming of the lock/disabled/full-log files. */
export function transitionsLogPath(domain: string, issueNumber: number): string {
  return `/tmp/pipeline-${domain}-${issueNumber}.transitions.log`;
}

/** Append one lifecycle line (plus a trailing newline) to the transitions log.
 *  Best-effort: a write error is silently ignored so the caller's run is unaffected. */
export function appendTransitionLine(filePath: string, line: string): void {
  try {
    appendFileSync(filePath, line + "\n");
  } catch {
    /* non-fatal */
  }
}

/** Return a function that appends to the given path on each call.
 *  Use when the same path is written to many times (avoids repeating the path argument). */
export function makeTransitionsLogger(filePath: string): (line: string) => void {
  return (line: string) => appendTransitionLine(filePath, line);
}
