## Why

`pipeline scoreboard` renders its factory metrics as terminal text (or `--json` for
machines). A maintainer who wants a durable, readable snapshot of a run window — to skim
later, keep next to a release, or open on a machine without the repo checked out — has
only two options today: screenshot the terminal, or pipe `--json` into a tool that does
not exist. Both are worse than the thing the skill already has: the numbers.

The gap is a *rendering* gap, not a data gap. Every value needed is already computed by
`buildScoreboardReport()`. Writing one self-contained `.html` file closes it without
adding a dashboard, a server, or a dependency — the file is openable offline with a
double-click and archivable with `cp`.

## What Changes

- `pipeline scoreboard` gains an optional `--html <path>` flag that writes one
  self-contained HTML document rendering the report for the selected window.
- The document is fully offline: no `<script src>`, no `<link href>`, no `@import`, no
  image/font/analytics URL, no `fetch`/`XMLHttpRequest`, no external network reference of
  any kind. Styling is a single inline `<style>` block; the file renders identically with
  networking disabled.
- The exported values are exactly the values the terminal scoreboard reports for the same
  window and artifacts — same reducer, same window semantics, same zero-denominator rules
  (`ratio: null`, `avg_ms: null` render as an explicit "n/a", never as `0`).
- The export is read-only with respect to everything but the one destination file: it
  creates, modifies, uploads, and transmits nothing — no GitHub state, no run artifacts,
  no files under `.agent-pipeline/runs/`.
- The write is atomic: the destination is written via a temporary file in the destination
  directory and renamed into place, so an unwritable path, a missing parent directory, or
  a mid-write failure leaves no partial `.html` behind and exits non-zero with a clear
  error.
- The export is deterministic: for unchanged inputs (same run artifacts, same window
  bounds, same flags), repeated exports render the same metric values.
- `--html` composes with the existing flags (`--since`/`--until`/`--days`,
  `--estimate-cost`, `--bucket`, `--by`) and with `--json`; when both are supplied, JSON
  still goes to stdout and the HTML file is written as well.
- Omitting `--html` leaves `pipeline scoreboard` byte-for-byte unchanged in both human and
  `--json` modes, and writes no file.

Non-goals: no charting library or externally hosted assets, no PDF/CSV, no hosted or
published report, no delivery/emailing/uploading workflow, no access control, no
historical trend charts beyond the existing `--bucket` series, no custom metric selection
or templating, and no organization-, customer-, or branding-specific content — the export
uses generic Agent Pipeline terminology only.

## Capabilities

### Modified Capabilities
- `factory-scoreboard`: adds the optional `--html <path>` export flag, the
  self-containment and offline-rendering guarantees, value parity with the terminal
  report, atomic all-or-nothing file writing with clear failure on invalid paths,
  determinism over unchanged inputs, and the guarantee that omitting `--html` changes
  nothing.

## Impact

- `core/scripts/scoreboard.ts` — add `html?: string` to `ScoreboardOpts`; add a `writeFile`
  (plus temp-write/rename) seam to `ScoreboardDeps`; add a `renderScoreboardHtml(report)`
  pure function and wire it into `runScoreboard()`
- `core/scripts/pipeline.ts` — add the `--html <path>` CLI option, thread it into the early
  `scoreboard` dispatch, extend the `scoreboard --help` usage line
- `core/scripts/command-registry.ts` — add `html` to the `scoreboard` entry's
  `allowedFlags`
- `core/test/scoreboard.test.ts`, `core/test/pipeline-cli.test.ts`,
  `core/test/command-registry.test.ts` — unit tests for self-containment, value parity,
  determinism, escaping, atomic failure, and unchanged default behavior
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — document the flag
- `plugin/` — regenerated mirror (`node scripts/build.mjs`)

## Acceptance Criteria

- [ ] `pipeline scoreboard --html <path>` exits `0` and leaves exactly one new file at
      `<path>` containing a complete HTML document (`<!DOCTYPE html>` … `</html>`).
- [ ] The written document contains no `<script src=`, no `<link ` with an `href`, no
      `@import`, no `src=`/`href=` attribute referencing `http://`, `https://`, `//`, or
      `data:` beyond none at all, and no `fetch(`/`XMLHttpRequest` — asserted by a test
      that scans the rendered output.
- [ ] Opening the written file with networking disabled renders the full report; a test
      asserts every styling rule is inline in a `<style>` element and no external resource
      identifier appears anywhere in the document.
- [ ] For a fixture run store and a fixed window, every metric value present in
      `formatScoreboardHuman()` output for that report appears in the HTML export with the
      same value, and `null` ratios/averages render as an explicit "n/a" rather than `0`.
- [ ] `pipeline scoreboard --html <path>` invokes no GitHub command and creates, modifies,
      or deletes no file other than `<path>` (and its transient temp sibling) — in
      particular nothing under `.agent-pipeline/runs/`.
- [ ] `pipeline scoreboard` and `pipeline scoreboard --json` without `--html` produce
      output identical to before this change and write no file.
- [ ] `pipeline scoreboard --html <path>` where `<path>`'s parent directory does not exist,
      is not writable, or `<path>` is a directory exits non-zero with an error message
      naming the path, and no file (including no temp file) remains at or beside `<path>`.
- [ ] Running the export twice over an unchanged run store with identical flags and window
      bounds produces the same rendered metric values both times.
- [ ] Run-derived strings that contain HTML metacharacters (e.g. a stage or harness name
      containing `<`, `&`, or `"`) are escaped in the output and cannot inject markup.
- [ ] `--html` composes with `--since`/`--until`/`--days`, `--estimate-cost`, `--bucket`,
      and `--by`: the exported document reflects the same window, estimates, series, and
      grouping the terminal report would show for the same invocation.
- [ ] `--html` is an accepted `scoreboard` flag in `core/scripts/command-registry.ts` and
      appears in `pipeline scoreboard --help`.
- [ ] Unit tests cover all of the above through the existing injected `ScoreboardDeps`
      seam, with no real network, git, or subprocess calls.
