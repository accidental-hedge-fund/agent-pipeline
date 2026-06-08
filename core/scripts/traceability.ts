// Commit traceability trailers (#20): every commit the pipeline produces carries
// structured git trailers linking it back to the originating GitHub issue and the
// specific pipeline run, so a `git log` can be grepped for "all work from run X".
//
// Two pieces:
//   - `makePipelineRunId`  — the per-dispatch run identifier (generated once in
//     the orchestrator, then threaded into every commit operation).
//   - `withTrailers`       — appends the `Issue:` / `Pipeline-Run:` trailers to a
//     commit message for the commits the pipeline writes directly.

/** Git trailer key for the originating issue. */
export const ISSUE_TRAILER_KEY = "Issue";
/** Git trailer key for the pipeline run identifier. */
export const RUN_TRAILER_KEY = "Pipeline-Run";

/**
 * Generate the pipeline run identifier for an issue dispatch.
 *
 * Format: `<issueNumber>/<UTC-ISO-datetime>` at seconds precision, e.g.
 * `42/2026-06-08T14:32:00Z`. It is deterministic, human-readable, embeds the
 * issue number for redundancy, and needs no external storage. Generated once per
 * dispatch (before any stage runs) and reused for every commit, so all commits
 * from a single run share the same value — `git log --grep="Pipeline-Run: 42/"`
 * then surfaces every commit from every run on issue #42.
 *
 * `now` is injectable so the format is unit-testable against a fixed instant.
 */
export function makePipelineRunId(issueNumber: number, now: Date = new Date()): string {
  // toISOString() yields `...:SS.mmmZ`; drop the milliseconds for a clean
  // seconds-precision stamp (matches the convention used elsewhere in the CLI).
  const iso = now.toISOString().replace(/\.\d+Z$/, "Z");
  return `${issueNumber}/${iso}`;
}

/**
 * Append the `Issue:` and `Pipeline-Run:` git trailers to a commit message,
 * separated from the preceding subject/body by a blank line (standard git
 * trailer format, parsed by `git interpret-trailers`).
 *
 * Used for the commits the pipeline creates directly (docs-update,
 * openspec-archive, openspec-init). Harness-instructed commits get the same
 * trailers via prompt-template instructions instead.
 */
export function withTrailers(message: string, issueNumber: number, pipelineRunId: string): string {
  return `${message}\n\n${ISSUE_TRAILER_KEY}: #${issueNumber}\n${RUN_TRAILER_KEY}: ${pipelineRunId}`;
}
