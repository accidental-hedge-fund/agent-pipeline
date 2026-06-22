## 1. Commander flag wiring

- [ ] 1.1 Add `--remove-worktree` option to the commander definition in `pipeline.ts`; include it in the type `PipelineOpts`.
- [ ] 1.2 Add `--force` option, documented as a modifier for `--remove-worktree`; validate that `--force` without `--remove-worktree` is a usage error (exit 2, usage message).
- [ ] 1.3 Update the argument description string to mention `--remove-worktree` alongside `--cleanup`, `--unblock`, `--override`.
- [ ] 1.4 Reject `--remove-worktree` combined with conflicting modes (`--cleanup`, `--init`, `--status`, `--unblock`, `--override`) with a usage error.

## 2. `RemoveWorktreeDeps` interface and `removeWorktreeForIssue` in `worktree.ts`

- [ ] 2.1 Define `RemoveWorktreeDeps` with: `listOnDisk`, `hasDirtyWorkdir`, `removeWorktree` (the existing sweep-scoped variant or a new thin wrapper), `pathExists`.
- [ ] 2.2 Implement `removeWorktreeForIssue(cfg, issueNumber, opts: { force?: boolean }, deps?: Partial<RemoveWorktreeDeps>): Promise<RemoveWorktreeResult>` where `RemoveWorktreeResult` is `{ removed: boolean; dirty: boolean; branch: string | null; worktree: string | null; error: string | null }`.
- [ ] 2.3 Logic: (a) find the on-disk record for issue N; not-found → `{ removed: false, dirty: false, … error: "no worktree found" }`; (b) run dirty check; dirty + no force → `{ removed: false, dirty: true, … error: "uncommitted changes" }`; (c) remove (worktree dir + local branch); failure → `{ removed: false, … error: git error msg }`; (d) success → `{ removed: true, dirty: false/true if forced, … }`.
- [ ] 2.4 Export `RemoveWorktreeResult` type from `worktree.ts`.

## 3. `runRemoveWorktree` handler in `pipeline.ts`

- [ ] 3.1 Add early-exit dispatch in the main entry-point function: if `opts.removeWorktree`, call `runRemoveWorktree(cfg, resolvedIssueNumber, opts)` and return (bypass kill switch, before `isKillSwitchActive` check).
- [ ] 3.2 Implement `runRemoveWorktree(cfg, issueNumber, opts)`: call `removeWorktreeForIssue`; format output (human text or JSON based on `opts.json`); set exit code (`process.exitCode = 1` on failure, 0 on success).
- [ ] 3.3 Human-text output: on success, print removed branch and path; on dirty (no force), print error and hint to retry with `--force`; on not-found, print issue number and error; on dirty+force success, print warning about uncommitted changes that were discarded.
- [ ] 3.4 JSON output (`--json`): `console.log(JSON.stringify(result))` — single object matching `RemoveWorktreeResult` shape; nothing else on stdout.

## 4. Issue-number resolution for `--remove-worktree`

- [ ] 4.1 `--remove-worktree` requires a numeric issue argument. Reuse the existing `resolveIssueNumber` call (after `opts.removeWorktree` check so the resolver runs for this mode).
- [ ] 4.2 Ensure that if `resolveIssueNumber` fails (e.g. invalid number format), the error is printed and the process exits non-zero (existing resolver pattern).

## 5. Unit tests (`core/test/worktree-remove.test.ts`)

- [ ] 5.1 Clean worktree removed: `removeWorktreeForIssue` with fake deps (not-dirty, remove ok) returns `{ removed: true, dirty: false, error: null, branch, worktree }`.
- [ ] 5.2 Dirty worktree without force: returns `{ removed: false, dirty: true, error: "uncommitted changes" }` and `removeWorktree` dep is NOT called.
- [ ] 5.3 Dirty worktree with force: returns `{ removed: true, dirty: true, error: null }` and `removeWorktree` dep IS called.
- [ ] 5.4 Not-found: `listOnDisk` returns no record for the issue → `{ removed: false, dirty: false, worktree: null, branch: null, error: /not found/ }`.
- [ ] 5.5 `removeWorktree` dep fails: returns `{ removed: false, error: git-error-message }`.
- [ ] 5.6 CLI smoke: `pipeline N --force` without `--remove-worktree` exits 2 with usage error.
- [ ] 5.7 CLI smoke: `pipeline N --remove-worktree` with invalid issue number exits 2.

## 6. Documentation

- [ ] 6.1 Add `--remove-worktree [--force] [--json]` to the flag table in `README.md` with a one-line description and example.

## 7. Mirror + CI

- [ ] 7.1 `node scripts/build.mjs`; confirm mirror is in sync.
- [ ] 7.2 `npm run ci` green end-to-end.
