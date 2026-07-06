# Design

## Context

Two independent surfaces carry pipeline run evidence today:

1. **Finalization comment** — `notifyBundlePath()` in `pipeline-run.ts` posts one PR/issue
   comment per run recording only the local bundle path plus a `pipeline N --summary` hint.
   It is invoked from the finalize path in `pipeline-run.ts` after `finalizeRun()` writes
   `summary.json`, using the `notifiedAt` stamp to post at most once per run.
2. **On-disk bundles** — `finalizeRun()` in `run-store.ts` writes the durable per-run
   `.agent-pipeline/runs/<run-id>/summary.json` and rewrites the legacy
   `<stateDir>/<issue>/evidence.json`. The `EvidenceBundle.stages[]` array already carries
   `enteredAt` / `exitedAt` / `outcome` per stage (see `evidence-bundle` and
   `run-directory-layout` specs); `evidence-bundle.ts` already has a pure `formatDuration()`
   that renders an `enteredAt`/`exitedAt` pair as `12s` / `1m03s`.

This change surfaces already-captured stage timing data in two new places. It does **not**
touch how `enteredAt` / `exitedAt` / harness durations are measured (explicitly out of
scope in #377).

## Decisions

### 1. Render the timing table into the comment body from the finalized bundle

`notifyBundlePath()` already runs after finalization but currently ignores the bundle. It
will read the finalized `EvidenceBundle` (the same object `finalizeBundle()`/`finalizeRun()`
produced) and render a Markdown table from `bundle.stages[]`, one row per recorded stage:
`| stage | enteredAt → exitedAt | duration | outcome |`. The visible run id is shown as a
labeled field. The existing local path line and `--summary` hint stay, demoted to a
"secondary / optional" note.

A new **pure** exported helper in `evidence-bundle.ts` —
`formatStageTimingTableMarkdown(bundle)` — produces the table string, reusing
`formatDuration()`. Keeping it pure and colocated with `formatSummary()` lets tests assert
the rendered Markdown without any I/O and lets the comment builder and the human summary
share one source of truth for duration formatting.

**Why the comment body, not a link:** acceptance criteria require the table to be complete
and correct when the local run directory is unavailable (different machine). Embedding the
data in the GitHub comment body is the only way to guarantee no field depends on local FS
access.

**No-accounting guarantee:** the table draws only from `stage`, `enteredAt`, `exitedAt`,
and `outcome`. It never reads `commands`, `prompts`, `reviews`, or `accounting`, so the
existing "Public finalization comments do not include accounting payloads" requirement is
preserved by construction. Wall-clock stage durations are not usage-derived token/cost data.

### 2. Append-only issue-level history JSONL, written at finalization

A new artifact accumulates one compact record per finalized run for an issue. **JSONL
(one JSON object per line) is chosen over a JSON array** specifically because appending a
line is inherently non-destructive: prior entries are never read, rewritten, or risk being
truncated by a concurrent finalize, which directly satisfies "re-run appends, never
replaces." A single JSON array would require read-modify-write and reintroduce the
overwrite hazard this change is meant to remove.

- **Location:** `.agent-pipeline/history/issue-<N>.jsonl` (repo-scoped, under the same
  `.agent-pipeline/` tree the run store already owns — reboot-durable, unlike `/tmp`).
- **Write point:** `finalizeRun()` in `run-store.ts`, after `summary.json` and the legacy
  `evidence.json` writes, using `appendFile` (create-on-first-write). This is the one place
  that already knows the run directory, issue, stateDir, and finalized bundle.
- **Entry shape (compact, timing-focused):**
  `{ schema_version, run_id, issue, pr, branch, final_state, finalized_at, stages: [{ stage, enteredAt, exitedAt, durationMs, outcome }] }`.
  Commands/prompts/reviews are intentionally excluded — the history artifact is a timing
  rollup, not a second full bundle. `run_id` uses the filesystem-safe run-directory basename
  (same identifier `summary.json` uses) so a history entry joins back to its run directory.
- **Non-fatal:** wrapped in try/catch and logged like the sibling summary/evidence writes;
  a failure never fails the run (consistent with `run-artifact-conventions`).
- **Sanitization:** the line is serialized through the same `sanitizeDeep` +
  `redactSecrets` + `sanitize` chain used for `summary.json`, so no secret can reach the
  artifact.

**Why a separate artifact rather than "stop overwriting evidence.json":** the legacy
`evidence.json` is a single-run, full bundle that existing consumers (`pipeline N --summary`,
legacy readers) expect to reflect the latest run. Preserving that contract (acceptance
criterion: legacy consumers keep working) means the multi-run history lives in a new,
purpose-built append-only file rather than changing the legacy file's semantics.

### 3. Explicitly out of scope

- Committing/publishing either artifact into the target repository.
- Any long-term repo-policy decision about where durable evidence should live beyond this
  issue-level history artifact.
- Changing how stage timing is captured/measured.

## Testability

- `formatStageTimingTableMarkdown` is pure — tests feed a synthetic `EvidenceBundle` and
  assert row-per-stage, duration formatting, run-id field presence, and absence of any
  command/prompt/accounting text.
- The history append is exercised through `finalizeRun` with injected `RunStoreDeps` fakes
  (in-memory `appendFile`) per the repo's dependency-seam convention: finalize twice for one
  issue → assert two lines, each a valid entry with its own run id, and prior line unchanged.
