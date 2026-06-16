## 1. Archive idempotency — once-per-branch guard

- [x] 1.1 Add `archiveAlreadyDone(gitFn, wtPath, baseBranch, issueNumber): Promise<boolean>` in `pre_merge.ts`: reads `git log --format=%s origin/<base>..HEAD` and returns `true` when any commit headline starts with `OPENSPEC_ARCHIVE_PREFIX` concatenated with the issue number; pure and injectable.
- [x] 1.2 Add `archiveAlreadyDone` to `AdvancePreMergeDeps` as an optional seam (default: the real implementation above).
- [x] 1.3 In `maybeArchiveOpenspec`, call `archiveAlreadyDone` as the first check; if `true`, return `null` immediately (archive already committed; proceed to next gate).

## 2. CI-failure convergence — block immediately on exhausted rebase

- [x] 2.1 In `advance()` CI-failure path: when `agg.failed.length > 0` AND `alreadyRebased === true`, call `setBlocked` with label `needs-human` and the failing check list, then return `blocked` — without returning `waiting` first.
- [x] 2.2 In `advance()` CI-failure path: when `agg.failed.length > 0` AND `alreadyRebased === false` AND `tryRebaseAndPush` returns `false`, call `setBlocked` with label `needs-human` immediately (already the code path; verify the label is `needs-human` not `test-gate-exhausted`).

## 3. Tests

- [x] 3.1 `archiveAlreadyDone`: returns `true` when log contains `OPENSPEC_ARCHIVE_PREFIX + issueNumber`; returns `false` when log is empty or contains other commits; injectable gitFn fake.
- [x] 3.2 `maybeArchiveOpenspec` with `archiveAlreadyDone` returning `true`: returns `null` without calling `openspecArchive` or `gitInWorktree` for add/commit/push.
- [x] 3.3 `advance()` CI failure + `rebaseAlreadyAttempted=true`: calls `setBlocked` with `needs-human` label and check-name details; returns `{ status: "blocked" }`.
- [x] 3.4 `advance()` CI failure + `rebaseAlreadyAttempted=false` + `tryRebaseAndPush` returns `false`: calls `setBlocked` with `needs-human` label; returns `{ status: "blocked" }`.

## 4. Mirror + CI

- [x] 4.1 `node scripts/build.mjs`; `npm run ci` green.
