## 1. Run-store helper

- [ ] 1.1 Add `latestSummaryForIssue(repoDir, issueNumber, deps)` to `core/scripts/run-store.ts`: filters `listRunIds()` by `<issueNumber>-` prefix, reads and parses `summary.json` from most-recent match, returns the bundle or `null`.
- [ ] 1.2 Export the new helper from `run-store.ts` so `pipeline.ts` can import it.

## 2. Update `runSummary()`

- [ ] 2.1 Accept `repoDir` as a parameter in `runSummary()` (alongside existing `cfg` and `issueNumber`).
- [ ] 2.2 Call `latestSummaryForIssue(repoDir, issueNumber, deps)` first; fall back to `readBundle(stateDir, issueNumber)` only when it returns `null`.
- [ ] 2.3 Update the "no bundle found" error message to name both the run-directory path and the legacy path.
- [ ] 2.4 Update the call site in the `--summary` CLI dispatch block to pass `repoDir`.

## 3. Add `pipeline summary <run-id>` sub-command

- [ ] 3.1 Add `summary` as a recognized no-issue-number keyword in the CLI positional dispatch (pipeline.ts).
- [ ] 3.2 Implement the handler: given a run-id string, read `summary.json` from `.agent-pipeline/runs/<run-id>/`; print summary on success, exit non-zero with the expected path on failure.
- [ ] 3.3 Update CLI help text to document both `--summary <N>` and `pipeline summary <run-id>`.

## 4. Tests

- [ ] 4.1 Write `core/test/pipeline-summary.test.ts` with injectable deps covering:
  - run-directory summary found (happy path)
  - run-directory summary absent → legacy fallback succeeds
  - run-directory summary corrupt → legacy fallback succeeds
  - both locations absent → exit non-zero, error message names both paths
  - `pipeline summary <run-id>` exact match succeeds
  - `pipeline summary <run-id>` with unknown run-id exits non-zero

## 5. Mirror and docs

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate `plugin/` mirror; confirm `build.mjs --check` passes.
- [ ] 5.2 Update `README.md` to document run-directory-first read order and `pipeline summary <run-id>`.
- [ ] 5.3 Update `hosts/claude/SKILL.md` (and other host SKILL.md files if they document `--summary`).
- [ ] 5.4 Run `npm run ci` from the repo root; confirm all tests pass and the mirror check is green.
