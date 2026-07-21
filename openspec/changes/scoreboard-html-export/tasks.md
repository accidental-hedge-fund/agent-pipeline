## 1. Option plumbing

- [ ] 1.1 Add an optional `html?: string` field to `ScoreboardOpts` in
      `core/scripts/scoreboard.ts`.
- [ ] 1.2 Extend `ScoreboardDeps` with the write seam used by the export (temp write,
      rename, remove), and implement it in `realScoreboardDeps()` over `node:fs/promises`.
- [ ] 1.3 Add `--html <path>` to the `scoreboard` command in `core/scripts/pipeline.ts`,
      thread `opts.html` into the early scoreboard dispatch, and extend the
      `scoreboard --help` usage line.
- [ ] 1.4 Add `html` to the `scoreboard` entry's `allowedFlags` in
      `core/scripts/command-registry.ts`.

## 2. Renderer

- [ ] 2.1 Add `escapeHtml()` and apply it at every interpolation point for run-derived
      strings (stage, harness, model slot, blocker kind, group keys, diagnostic path and
      message).
- [ ] 2.2 Implement `renderScoreboardHtml(report: ScoreboardReport): string` producing one
      complete document: `<!DOCTYPE html>`, a single inline `<style>` block, no `<script>`,
      no external resource identifier.
- [ ] 2.3 Render the window bounds, totals, and every metric the human formatter renders —
      autonomy rate, cost per ready PR, cost-source coverage, cost/accounting groups,
      full-run and per-stage durations, harness calls per successful PR, retry/fix rounds,
      blocker rates by kind, needs-human rate, fallback rate, and gate pass rates.
- [ ] 2.4 Render `null` ratios and `null` averages as an explicit `n/a`, never `0`.
- [ ] 2.5 Render the `--bucket` series and the `--by` grouping sections when present, and
      omit those sections entirely when absent.
- [ ] 2.6 Render diagnostics (severity, code, path, message) when present.
- [ ] 2.7 Keep the renderer pure — no clock, no randomness, no environment reads.

## 3. Write path

- [ ] 3.1 In `runScoreboard()`, after the existing stdout behavior, write the export when
      `opts.html` is set; leave stdout behavior unchanged in both human and `--json` modes.
- [ ] 3.2 Render the full document in memory before any write occurs.
- [ ] 3.3 Write to a temporary sibling in the destination's directory and rename onto the
      destination.
- [ ] 3.4 On any failure, remove the temporary file and throw an error naming the
      destination path so the CLI exits non-zero; leave no partial destination file.

## 4. Tests

- [ ] 4.1 Self-containment scan: rendered output contains no `<script`, `src=`, `href=`,
      `@import`, `url(`, `fetch(`, `XMLHttpRequest`, or `http`/`//` resource reference.
- [ ] 4.2 Value parity: for a fixture report, every metric value in
      `formatScoreboardHuman()` output also appears in the HTML export.
- [ ] 4.3 Zero-denominator rendering: `ratio: null` and `avg_ms: null` render as `n/a`, not
      `0`.
- [ ] 4.4 Escaping: a fixture whose stage/harness/diagnostic strings contain `<`, `&`, `"`,
      and `'` produces escaped output with no injected markup.
- [ ] 4.5 Determinism: rendering the same report twice produces identical output.
- [ ] 4.6 Atomicity: a fake write seam that fails mid-write leaves no destination file, the
      temp file is removed, and the error names the path.
- [ ] 4.7 Invalid destination (missing parent directory, destination is a directory,
      unwritable directory) fails clearly and non-zero with no file left behind.
- [ ] 4.8 Read-only guarantee: an export invocation performs no GitHub call and writes
      nothing under `.agent-pipeline/runs/`.
- [ ] 4.9 Unchanged default: without `--html`, human and `--json` output are unchanged and
      the write seam is never invoked.
- [ ] 4.10 Composition: `--html` together with `--since`/`--until`/`--days`,
      `--estimate-cost`, `--bucket`, and `--by` exports a document reflecting the same
      window, estimates, series, and grouping as the terminal report.
- [ ] 4.11 CLI/registry: `--html` is an accepted `scoreboard` flag and appears in
      `scoreboard --help`.
- [ ] 4.12 All tests use the injected `ScoreboardDeps` seam — no real network, git, or
      subprocess calls.

## 5. Docs, mirror, gate

- [ ] 5.1 Document `--html <path>` in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`,
      noting it is offline and local-only.
- [ ] 5.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 5.3 Run `npm run ci` from the repo root and confirm it is green.
