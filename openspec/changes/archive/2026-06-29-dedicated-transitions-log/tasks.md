## 1. Transitions-log writer

- [ ] 1.1 Add an append-only transitions-log writer that derives the path from
  `cfg.domain` and the issue number (`/tmp/pipeline-<domain>-<N>.transitions.log`),
  opens in append mode, and exposes a single `logTransition(line)`-style seam.
- [ ] 1.2 Make every append best-effort/non-fatal: on a write error, still print
  the line to stdout and continue the run.
- [ ] 1.3 Inject the writer through a `Deps`-style seam so unit tests use a fake
  (no real filesystem).

## 2. Route lifecycle lines through the writer

- [ ] 2.1 Route `printOutcome` (the `from → to: …` and `at <stage> — …` lines) in
  `pipeline-run.ts` through the writer.
- [ ] 2.2 Route the run-start lines (`starting at stage=…`, `run id …`), the
  `pipeline label removed; stopping.` line, and the terminal `done — …` line.
- [ ] 2.3 Route the `unblocked at <stage>` line in `pipeline.ts`.
- [ ] 2.4 Pin `<N>` to the originally supplied argument so the transitions-log path
  matches the documented full-log path even when the number resolves to a linked
  issue.

## 3. Cleanup

- [ ] 3.1 Extend `runCleanup` so each swept merged-PR issue also unlinks its
  `/tmp/pipeline-<domain>-<N>.transitions.log` (best-effort; missing file and
  unlink failure do not abort the sweep).

## 4. Host guidance

- [ ] 4.1 Update `hosts/claude/SKILL.md` monitoring guidance to recommend
  `tail -f /tmp/pipeline-<domain>-<N>.transitions.log` (no grep), noting it carries
  only lifecycle lines and so avoids the test-gate fixture false matches.
- [ ] 4.2 Mirror the same guidance into `hosts/codex/SKILL.md`.
- [ ] 4.3 Regenerate the plugin mirror with `node scripts/build.mjs` and commit it.

## 5. Tests and CI

- [ ] 5.1 Unit test: each mirrored lifecycle line is byte-for-byte equal to the
  stdout line (advance, blocked, run-start, run-id, unblocked, label-removed, done).
- [ ] 5.2 Unit test: a second dispatch appends to (does not truncate) the file.
- [ ] 5.3 Unit test: a writer error is non-fatal — stdout line still emitted, run
  continues.
- [ ] 5.4 Unit test: `--cleanup` unlinks the transitions log for a swept merged-PR
  issue and tolerates a missing file.
- [ ] 5.5 Prove the tests bite (fail without the wiring), then run `npm run ci`
  green (core tests + `build.mjs --check` + install smoke).
