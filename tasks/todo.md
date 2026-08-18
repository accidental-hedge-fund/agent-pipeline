# #1111 Revised plan — tugboat detach-race single admission

## Status

- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation

## Locked decisions (post plan-review)

1. Replace `mkdir` `detach.gate` + empty-pid reclaim with a regular lock file and exclusive `flock`.
2. Loser waits for release, then re-probes `live_ship_probe`. Lock presence is not already-running.
3. Winner holds flock until `live_ship_probe` sees the child. Print `detached tugboat ship` only after that.
4. `trap` + process-death release. Dead-owner leftover file is reclaimable.
5. Path: `$STATE_ROOT/admission/<repo-token>/v<safe-milestone>.lock` (pinned `REPO_DIR` hash + `safe_of`). Not `pwd`. Not issue-run lock.
6. Concurrent fixture keeps two real `--detach` processes. Test-only start barrier. Wait for both exits. Exactly one detach line and one already-running line.
7. Extra tests: stale leftover lock file; failed spawn / expired wait then later detach. Do not weaken #1062 negatives.

See the chat revised implementation plan for Approach, files, tests, and acceptance criteria.
