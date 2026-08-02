// Shared advance/CLI helpers owned outside both pipeline.ts (Commander) and
// pipeline-run.ts (advance loop). Both modules import from here so neither
// needs a cross-import for REVIEW_CEILING_MARKER, ceilingRound, or
// evidenceTimestamp — the #630 cycle break (#263 residual).

/** First line of the punch-list comment posted when a review round hits the
 *  round ceiling and parks the item at `needs-human` (emitted by review.ts's
 *  `reviewCeilingComment`). A controlled string the pipeline owns end-to-end. */
export const REVIEW_CEILING_MARKER = "## Pipeline: Review ceiling reached";

/**
 * The review round recorded in a ceiling comment (#135) — the round `--override`
 * auto-resumes into. Reads the controlled `Review N re-ran …` line the pipeline
 * itself emits (review.ts's `reviewCeilingComment`). Line-anchored and
 * first-match-wins: the controlled line precedes any reviewer-authored finding
 * text, so injected content later in the body can never override it (the
 * e8b1f0b4 lesson — a whole-body `pipeline:review-N` regex matched finding
 * prose). Returns null when the line is absent.
 */
export function ceilingRound(body: string): 1 | 2 | null {
  const m = body.match(/^Review ([12]) re-ran /m);
  return m ? (Number(m[1]) as 1 | 2) : null;
}

/** ISO 8601 timestamp at seconds precision (fractional seconds stripped, `Z` suffix). */
export function evidenceTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
