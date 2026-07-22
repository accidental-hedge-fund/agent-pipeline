## Context

`handleRunSubcommand` (`core/scripts/pipeline.ts`) owns the detached launch path for both
`pipeline <N> --detach` (canonical) and `pipeline run <N> --detach` (alias). Today its
ordering is:

1. parse/validate the issue number,
2. pin the run-store run id,
3. compute `repoDir = findGitRoot(start) ?? start` — **never fails**,
4. build the forwarded arg list,
5. `spawnDetached(...)` → creates `~/.pipeline/runs/<N>/<ts>/`, opens `pipeline.log`,
   spawns the wrapper, waits for the lock handshake,
6. write `run-store.json`, print the wrapper dir, exit 0.

Validation of the cwd happens only inside the spawned process, in `resolveConfig`, which
throws `no git repo found at or above <startDir>` and exits 2. By then steps 3–6 already
happened.

## Goals / Non-Goals

**Goals**

- Make repo resolution a hard precondition of the detached launch: it either yields a repo
  root or the command exits 2 having written nothing.
- Remove the silent `?? runStoreStart` fallback so a run-store path can only ever be derived
  from a validated git root.
- Keep the failure message identical to the inner run's, so operators and supervising agents
  see one string for one condition.

**Non-Goals**

- Changing *which* directory is the right repo root for a managed-worktree launch (#472).
- Changing wrapper directory layout, sentinel schema, lock protocol, or the `run-store.json`
  contract.

## Decisions

### Decision 1 — validate in the launcher, not only in the child

The check must be in the parent because the artifacts (wrapper dir, log, pointer) are created
by the parent. Deferring to the child is what produced the stray-artifact behavior. The child
keeps its own `resolveConfig` validation; the two are consistent because both use
`findGitRoot` on the same start path (`--repo-path` resolved, else cwd).

*Alternative rejected:* have the wrapper delete its own run directory when the inner run
exits 2. That is a cleanup-after-damage design, races with a supervising poller that has
already read the path off stdout, and cannot un-print the misleading "detached run started"
line or the exit 0.

### Decision 2 — exit code 2, existing message text

Exit 2 is the repo's established "operator/usage precondition failed" code, matching
`resolveConfig`'s path and the existing early `release`/`intake` dispatch guards in
`pipeline.ts`, which already do exactly this check-then-`process.exit(2)` pattern. Reusing
the same message string keeps grep-ability for supervising agents.

### Decision 3 — the fallback is deleted, not made conditional

`findGitRoot(start) ?? start` is the defect's root: it converts "unresolvable" into "pretend
cwd is a repo". After this change the only expression producing a run-store path takes the
resolved root, so no future caller can reintroduce the stray location by forgetting a guard.

### Decision 4 — test through a dependency seam, no subprocess

`RunSubcommandDeps` already injects `spawnDetached`. Extend it with the git-root resolution
(and the start-directory source) so a unit test can drive "no repo found" deterministically
and assert (a) `process.exitCode === 2`, (b) the injected `spawnDetached` was never called,
and (c) no path was written. This honors the repo rule that unit tests do no real network,
git, or subprocess work. A complementary assertion covers the success ordering: resolution
happens before `spawnDetached`, and the run-store dir passed onward is rooted at the resolved
git root.

## Risks

- **Behavior change for launches that "worked" from a non-repo cwd.** There were none: those
  launches always ended in an inner exit 2. The change converts a misleading exit 0 into an
  honest exit 2, which a supervising orchestrator should treat as a launch failure.
- **`--repo-path` pointing at a non-repo directory now fails at launch instead of in the
  child.** Same net outcome, earlier and quieter; the error names the resolved `--repo-path`.
