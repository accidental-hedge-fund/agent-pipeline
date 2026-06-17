## 1. CLI dispatch wiring

- [ ] 1.1 Add `sweep` to the recognized no-issue-number keyword list in `pipeline.ts`; detect it in the dispatch block (alongside `release`, `intake`, `roadmap`, etc.).
- [ ] 1.2 Add `--apply` flag to the commander definition for the `sweep` mode; ensure it defaults to false (dry-run).
- [ ] 1.3 Add optional `--repo <owner/repo>` flag (default: current repo from `gh` config context).
- [ ] 1.4 Update the argument description string and help text to list `sweep` alongside peer sub-commands.
- [ ] 1.5 Import `runSweep` from `./stages/sweep.ts` and add the early dispatch call (before config resolution, mirroring the `release` and `intake` patterns).

## 2. Sufficiency heuristic

- [ ] 2.1 Implement `isSufficient(body: string, config: SweepConfig): boolean` in `sweep.ts` — checks body length ≥ `min_body_length` (default 150), presence of ≥ 2 required section headings (default: Summary, User story, Acceptance criteria, Out of scope), and body is not a single sentence.
- [ ] 2.2 Add unit tests for `isSufficient`: sufficient body passes; single-sentence body fails; missing sections fails; configurable threshold respected.

## 3. Spec-generation prompt

- [ ] 3.1 Author `core/scripts/prompts/sweep.md` with `{{issue_title}}`, `{{existing_body}}`, and `{{repo_context}}` placeholders, embedding the WHAT-not-HOW / observable-AC spec contract (Summary, User story, Acceptance criteria, Out of scope, Open questions only when ambiguous).
- [ ] 3.2 Register the prompt in `core/scripts/prompts/index.ts` (or equivalent loader) so it is injectable via the existing template-render path.

## 4. `SweepDeps` interface and `realSweepDeps()`

- [ ] 4.1 Define `SweepDeps` in `sweep.ts`: `listIssues`, `getIssueBody`, `updateIssueBody`, `runHarness`, `readFile`, `writeFile`, `gitCreateBranch`, `gitCommit`, `createPR`, `log`.
- [ ] 4.2 Implement `realSweepDeps()` wiring each dep to the real CLI/filesystem/gh-wrapper calls.

## 5. `runSweep` handler — classify and re-spec phase

- [ ] 5.1 Fetch all open issues via `deps.listIssues` (applying `--repo` if provided).
- [ ] 5.2 For each issue, call `isSufficient(body, config)` to classify; build a `ClassifiedIssue[]` list with action (`to-spec` / `sufficient`).
- [ ] 5.3 For each `to-spec` issue, invoke one `deps.runHarness` call with the `sweep.md` prompt rendered with `{{issue_title}}`, `{{existing_body}}`, `{{repo_context}}`; capture the generated spec or a failure reason.
- [ ] 5.4 Under `--apply`: call `deps.updateIssueBody` for each successfully-generated spec; record `specced` in the result list. On harness failure, record `blocked` with the reason and continue (do not abort).
- [ ] 5.5 Without `--apply`: print the proposed new body for each thin issue (summary or diff format) but make no GitHub writes.

## 6. `runSweep` handler — roadmap reconciliation phase

- [ ] 6.1 Read `ROADMAP.md` via `deps.readFile`; identify open issues absent from the per-issue sem-ver table and release-plan table.
- [ ] 6.2 For each absent issue, apply anchor-based ROADMAP mutations using helpers from `release.ts` (`insertReleasePlanRow`, `insertPerIssueRow`) and `intake.ts` (`insertDetailSectionBullet` or equivalent).
- [ ] 6.3 Under `--apply`: create a branch (e.g. `sweep/<date>-roadmap-reconcile`), commit the mutated `ROADMAP.md` via `deps.gitCommit`, and open a PR via `deps.createPR` targeting the default branch.
- [ ] 6.4 Without `--apply`: compute and print the diff of the mutated `ROADMAP.md` vs the original.

## 7. Summary report

- [ ] 7.1 After all phases complete, print a per-issue line: `#<N> <title> — <action> (<one-line reason>)`.
- [ ] 7.2 Print aggregate counts: `<inspected> inspected, <specced> re-specced, <skipped> left-as-is, <blocked> blocked`.
- [ ] 7.3 Print roadmap delta: issues added, updated (already present but adjusted), and unchanged.
- [ ] 7.4 Print a final line indicating whether writes were applied or only previewed.

## 8. Config schema extension

- [ ] 8.1 Extend `PartialConfigSchema` in `config.ts` to accept a `sweep:` sub-key with fields: `min_body_length` (number, default 150), `required_sections` (string[], default `["Summary", "User story", "Acceptance criteria", "Out of scope"]`).
- [ ] 8.2 Add unit test: valid sweep config is accepted; unknown key under `sweep:` triggers a strict-schema parse error.

## 9. Unit tests (`core/test/sweep.test.ts`)

- [ ] 9.1 Dry-run path: all thin issues get proposed specs printed; no `updateIssueBody`/`createPR` called; report printed.
- [ ] 9.2 `--apply` path: thin issues updated; sufficient issues skipped; roadmap PR opened.
- [ ] 9.3 Idempotent re-run: after first `--apply`, second run classifies all issues as sufficient; no harness calls; no updates.
- [ ] 9.4 Blocked issue: harness failure records `blocked` in report; remaining issues still processed; no abort.
- [ ] 9.5 Roadmap reconciliation dry-run: diff printed; no branch created; no PR opened.
- [ ] 9.6 Roadmap reconciliation `--apply`: branch created; PR opened; no direct commit to default branch.
- [ ] 9.7 Config override: `min_body_length: 300` causes a 200-char issue to be classified as thin.
- [ ] 9.8 `--repo` flag: `listIssues` is called with the supplied owner/repo value.

## 10. Documentation

- [ ] 10.1 Add `sweep` to the sub-command table in `README.md` (flags: `--apply`, `--repo`; behavior; dry-run example).
- [ ] 10.2 Add `sweep` to `hosts/claude/SKILL.md` (usage line + example).

## 11. Mirror + CI

- [ ] 11.1 `node scripts/build.mjs`; verify mirror is in sync.
- [ ] 11.2 `npm run ci` green end-to-end.
