## Context

`core/scripts/scoreboard.ts` is already structured for this: `buildScoreboardReport(opts,
deps)` performs all I/O through `ScoreboardDeps` (`readFile`, `readdir`, `log`) and returns
a pure `ScoreboardReport`; `formatScoreboardHuman(report)` and `formatScoreboardJson(report)`
are pure renderers over that object. `runScoreboard()` is the only place that decides where
bytes go.

An HTML export is therefore a third pure renderer plus one new write seam. The risk in this
change is not aggregation — it is (a) the export silently drifting from the terminal
numbers, (b) accidentally shipping a document that phones home, and (c) leaving a
half-written file on failure.

## Goals / Non-Goals

Goals:
- Value parity with the terminal report, structurally guaranteed rather than
  hand-maintained.
- A document that is provably offline — verifiable by scanning the produced string, not by
  trusting the author.
- All-or-nothing writes.

Non-Goals:
- Charts, interactivity, JS of any kind, theming, or templating hooks.
- Any transport (publish/upload/email), hosted rendering, or access control.
- New metrics, new run-artifact fields, or changes to existing metric definitions.

## Decisions

### 1. Render from the same `ScoreboardReport`, never from a re-read

`renderScoreboardHtml(report: ScoreboardReport): string` takes the identical object that
feeds `formatScoreboardHuman()` and `formatScoreboardJson()` in the same invocation. There
is no second scan, no second reduction, and no separate window computation, so the HTML
cannot disagree with the terminal output for that run.

Consequence: determinism over unchanged inputs follows from the reducer's existing
determinism plus a renderer that introduces no time, randomness, or environment-derived
content. The document carries the report's own `window.since`/`window.until` (already in
the report) rather than a "generated at" wall-clock stamp, which would otherwise make two
exports of the same data differ. If a generation stamp is ever wanted, it belongs in a
field the report already computes, not in `new Date()` inside the renderer.

### 2. Zero-denominator values render as an explicit `n/a`

The capability's existing rule is `ratio: null` / `avg_ms: null` when the denominator is
zero. Rendering those as `0`, `0%`, or an empty cell would misreport "no data" as "bad
result". The renderer maps `null` to a literal `n/a` (and keeps the raw numerator/
denominator visible where the human formatter already shows them).

### 3. Self-containment is enforced by a test that scans the output, not by convention

The document is a single `<!DOCTYPE html>` file with one inline `<style>` block, no
`<script>` at all, and no attribute carrying a resource identifier. A unit test asserts the
absence of `<script`, `src=`, `href=`, `@import`, `url(`, `fetch(`, `XMLHttpRequest`, and
`http`/`//` scheme-ish substrings in the rendered string for a fixture report that includes
adversarial run-derived strings.

Rationale: "no network requests" is a property of the bytes. A convention ("don't add a CDN
link") decays; a scan does not. This also makes the guarantee reviewable in one place.

No JavaScript at all — not even inline — is a deliberate simplification. It removes the
whole class of "is this inline script doing something?" review questions and keeps the
export a document rather than an application.

### 4. Escape every interpolated value

Run-derived strings (stage names, harness names, model slots, blocker kinds, diagnostic
paths and messages) come from artifacts on disk and are not trusted markup. A single
`escapeHtml()` applied at every interpolation point escapes `& < > " '`. Attribute values
are avoided entirely where possible — content goes in text nodes — so the escape surface is
small and uniform.

### 5. Atomic write via temp-file + rename, in the destination directory

`renderScoreboardHtml()` produces the full string in memory; only then is anything written.
The write goes to a temporary sibling in the destination's own directory and is renamed onto
the destination. Same-directory placement keeps the rename atomic (a cross-device rename is
a copy, which reintroduces partial-write risk). On any failure — unwritable directory,
missing parent, destination is a directory — the temp file is removed and the command exits
non-zero with an error naming the path; the destination is either the complete previous file
or absent, never truncated.

Trade-off considered and rejected: creating missing parent directories with `mkdir -p`. The
issue asks for invalid paths to *fail clearly*; silently materializing a directory tree from
a typo'd path is the opposite of that.

### 6. `--html` is additive to stdout behavior, not a mode switch

`--html` writes a file; it does not suppress or alter stdout. Without `--json`, the human
report still prints. With `--json`, JSON still prints. This keeps `--html` composable with
every existing flag and keeps the "omitting `--html` changes nothing" guarantee trivially
true — the existing code path is untouched, with the export bolted on after it.

### 7. New `writeFile`-family seam on `ScoreboardDeps`

The write goes through `ScoreboardDeps` (alongside `readFile`/`readdir`/`log`) so tests
exercise the export — including the failure and cleanup paths — with a fake filesystem and
no real I/O, matching the repo's dependency-seam convention. `realScoreboardDeps()` supplies
the `node:fs/promises` implementations.

## Risks / Trade-offs

- **Renderer drift**: the HTML renderer is a second renderer over the same report and could
  omit a metric the human formatter gains later. Mitigated by a parity test that asserts the
  metric values present in the human output also appear in the HTML for a fixture report;
  a new metric that skips the HTML renderer fails that test.
- **File size**: the whole document, including styling, is inline. For realistic windows this
  is tens of kilobytes — acceptable for the archival use case and preferable to any external
  asset.
- **No charts**: a static table-and-value document is less glanceable than a chart. Charting
  is explicitly out of scope; the existing `--bucket` series gives the chronological
  breakdown in tabular form.
