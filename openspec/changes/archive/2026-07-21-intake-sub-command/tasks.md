## 1. CLI dispatch wiring

- [ ] 1.1 Add `intake` to the recognized no-issue-number keyword list in `pipeline.ts`; detect it in the dispatch block (alongside `release`, `init`, etc.).
- [ ] 1.2 Add `--description "<text>"` option and `--release <vX.Y.Z>` option to the commander definition; ensure `--dry-run` is threaded through.
- [ ] 1.3 Update the `.argument(...)` description string and help text to list `intake` alongside peer sub-commands.
- [ ] 1.4 Import `runIntake` from `./stages/intake.ts` and add the early dispatch call (before config resolution, mirroring the `release` pattern).

## 2. Spec-generation prompt

- [ ] 2.1 Author `core/scripts/prompts/intake.md` with `{{description}}`, `{{repo_context}}`, and `{{roadmap_context}}` placeholders, embedding the WHAT-not-HOW / observable-AC spec contract (Summary, User story, Acceptance criteria, Out of scope, Open questions).
- [ ] 2.2 Register the prompt in `core/scripts/prompts/index.ts` (or equivalent loader) so it is injectable via the existing template-render path.

## 3. ROADMAP mutation helper

- [ ] 3.1 Export `insertDetailSectionBullet(text, version, bullet)` from `release.ts` using the existing anchor-scanning pattern; the insertion point is the first line of the `### vX.Y.Z` detail section (after the heading and before any existing bullets).
- [ ] 3.2 Add unit tests for `insertDetailSectionBullet`: inserts at correct position; throws "anchor not found" when the version section is absent.

## 4. `IntakeDeps` interface and `realIntakeDeps()`

- [ ] 4.1 Define `IntakeDeps` in `intake.ts`: `runHarness`, `createIssue`, `readFile`, `writeFile`, `gitCreateBranch`, `gitCommit`, `createPR`, `log`.
- [ ] 4.2 Implement `realIntakeDeps()` wiring each dep to the real CLI/filesystem/gh-wrapper calls.

## 5. `runIntake` handler

- [ ] 5.1 Validate inputs: description present; `--release` if supplied is a valid `vX.Y.Z` string; reject digit-only positional as ambiguous.
- [ ] 5.2 Read `ROADMAP.md` and derive the proposed release slot when `--release` is omitted (first open lane from the release-plan table).
- [ ] 5.3 Invoke the spec-generation harness with `{{description}}`, `{{repo_context}}` (repo name + recent issues summary), and `{{roadmap_context}}` (target version lane description from ROADMAP).
- [ ] 5.4 Deterministically build the issue body from the generated spec; apply `pipeline:ready` + `release:vX.Y.Z` labels; create the GitHub issue via `deps.createIssue`.
- [ ] 5.5 Apply the three ROADMAP mutations (release-plan row via `insertReleasePlanRow`, per-issue row via `insertPerIssueRow`, detail bullet via `insertDetailSectionBullet`) in memory; write the result.
- [ ] 5.6 Create a branch (e.g. `intake/issue-<N>-<slug>`), commit the ROADMAP edit, open a PR via `deps.createPR` targeting the default branch.
- [ ] 5.7 Under `--dry-run`: print the proposed issue body and ROADMAP diff; skip all writes, branch creation, and PR.

## 6. Unit tests (`core/test/intake.test.ts`)

- [ ] 6.1 Dry-run path: spec generated, issue body + diff printed, no `createIssue`/`createPR` called.
- [ ] 6.2 Happy path: issue created with correct labels; branch + ROADMAP PR opened; all three ROADMAP mutations present.
- [ ] 6.3 `--release` pin: all three ROADMAP mutations reference the pinned version.
- [ ] 6.4 Release slot inference: when `--release` omitted, proposed slot matches the first open lane in the fake roadmap text.
- [ ] 6.5 Error path — missing description: exits non-zero with usage error, no harness call.
- [ ] 6.6 Error path — digit-only positional: exits non-zero with disambiguation error.
- [ ] 6.7 Error path — harness failure: no issue or PR created; exits non-zero.
- [ ] 6.8 Error path — ROADMAP anchor missing: exits non-zero with anchor name in error message.

## 7. Documentation

- [ ] 7.1 Add `intake` to the sub-command table in `README.md` (flags, behavior, dry-run example).
- [ ] 7.2 Add `intake` to `hosts/claude/SKILL.md` (usage line + example).

## 8. Mirror + CI

- [ ] 8.1 `node scripts/build.mjs`; verify mirror is in sync.
- [ ] 8.2 `npm run ci` green end-to-end.
