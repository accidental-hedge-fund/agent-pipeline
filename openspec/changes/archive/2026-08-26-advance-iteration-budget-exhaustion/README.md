# advance-iteration-budget-exhaustion

When MAX_ITERATIONS is exhausted at a non-terminal stage, the advance invocation SHALL NOT print a successful done summary or exit 0. It SHALL surface budget exhaustion and, at pre-merge, park with ci-exhausted and release the worktree. Ready-to-deploy deferred finalize (#773) SHALL remain.
