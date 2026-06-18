## 1. CLI dispatch wiring

- [ ] 1.1 Add `isTriageCommand = numArg === "triage"` detection to the dispatch block in `pipeline.ts`, before the normal issue-advance path.
- [ ] 1.2 Add `--stage <stage>` option to the Commander definition; the second positional argument is the issue number.
- [ ] 1.3 Update the argument description string and `--help` text to list `triage` alongside peer sub-commands (`release`, `intake`, `sweep`, `roadmap`).
- [ ] 1.4 Import `runTriage` from `./stages/triage.ts` and wire the early dispatch call (before config resolution, mirroring the `intake` / `sweep` pattern).

## 2. `TriageDeps` interface and `realTriageDeps()`

- [ ] 2.1 Define `TriageDeps` in `triage.ts`:
  - `getIssueLabels(issueNumber: number): Promise<string[]>`
  - `addLabel(issueNumber: number, label: string): Promise<void>`
  - `removeLabel(issueNumber: number, label: string): Promise<void>`
  - `log(msg: string): void`
- [ ] 2.2 Implement `realTriageDeps()` wiring each dep to the typed `gh` wrappers in `gh.ts`.

## 3. `runTriage` handler

- [ ] 3.1 Validate inputs: issue number is a positive integer; `--stage` is present; if `--stage` value is not in `["backlog", "ready"]`, exit non-zero with an error naming the rejected value and listing the allowed values.
- [ ] 3.2 Fetch current labels for the issue via `deps.getIssueLabels`.
- [ ] 3.3 Compute the set of current `pipeline:*` labels on the issue.
- [ ] 3.4 If the issue already carries exactly the target label and no other `pipeline:*` label, call `deps.log("already set: pipeline:<stage>")` and exit 0 (idempotent no-op, no GitHub write).
- [ ] 3.5 Remove all other `pipeline:*` labels via `deps.removeLabel`, then add the target via `deps.addLabel`.
- [ ] 3.6 Log the outcome (e.g. "set pipeline:<from> → pipeline:<to>" or "added pipeline:<to>").

## 4. Unit tests (`core/test/triage.test.ts`)

- [ ] 4.1 Happy path — set `ready` from `backlog`: verify `removeLabel("pipeline:backlog")` and `addLabel("pipeline:ready")` called; no other writes.
- [ ] 4.2 Happy path — set `backlog` from `ready`: verify the inverse.
- [ ] 4.3 Idempotent no-op: issue already has `pipeline:ready` and no other `pipeline:*` label; `--stage ready` triggers no `addLabel` or `removeLabel` calls.
- [ ] 4.4 Operator reset from mid-flight: issue has `pipeline:planning`; `--stage backlog` removes `pipeline:planning` and adds `pipeline:backlog`.
- [ ] 4.5 Multiple existing `pipeline:*` labels: issue has both `pipeline:ready` and `pipeline:planning` (corrupted state); `--stage backlog` removes both and adds `pipeline:backlog`.
- [ ] 4.6 Error path — `--stage planning` rejected: exits non-zero, no `addLabel`/`removeLabel` calls.
- [ ] 4.7 Error path — `--stage review-2` rejected: exits non-zero, no write calls.
- [ ] 4.8 Error path — missing `--stage` flag: exits non-zero with usage error.
- [ ] 4.9 Error path — non-numeric issue argument: exits non-zero with a clear error.

## 5. Documentation

- [ ] 5.1 Add `triage` to the sub-command table in `README.md` (syntax, flags, behavior, example).
- [ ] 5.2 Add `triage` to `hosts/claude/SKILL.md` (usage line + example).

## 6. Mirror + CI

- [ ] 6.1 `node scripts/build.mjs`; verify mirror is in sync.
- [ ] 6.2 `npm run ci` green end-to-end.
