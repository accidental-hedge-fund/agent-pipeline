## Context

Issue #180 documents that the implementing/fix harness, when running in a worktree that lacks its own `node_modules`, may symlink `node_modules → <primary-checkout>/node_modules` to satisfy binary invocations. The symlink then reaches a pipeline commit via `git add -A` (run by the harness itself or by the salvage path) because `.gitignore`'s `node_modules/` pattern suppresses *directories* but not *symlinks*. On CI the symlink target is absent, producing `ENOTDIR` from `pnpm install` and halting every subsequent build and test.

The root-cause fix is already addressed by #174 (worktree-dependency-install): a properly bootstrapped worktree never needs to borrow deps from the primary checkout. This change adds defense-in-depth at three independent layers so the bug cannot recur even if the install step misfires or a harness creates unexpected symlinks.

## Goals / Non-Goals

**Goals:**
- Prevent `node_modules` (any filesystem type: directory, symlink, file) from appearing in any pipeline-authored or salvage commit.
- Block the pipeline step immediately and clearly if a harness commit sneaks in a `node_modules` entry.
- Remove an existing `node_modules` symlink from the worktree during bootstrap so CI is unblocked even if a stale worktree is reused.

**Non-Goals:**
- Preventing harnesses from creating the symlink internally (the pipeline cannot control what runs inside the harness's own execution).
- Generalizing to other generated or build-artifact paths (scope is `node_modules` only; the exclusion mechanism is extensible but this change does not extend it).
- Replacing or modifying the `.gitignore` of the target repo.

## Decisions

### Decision: `.git/info/exclude` over modifying `.gitignore`

**Chosen:** Write `node_modules` to `.git/info/exclude` in the worktree immediately after `git worktree add`.

**Rationale:** `.git/info/exclude` is worktree-local, never committed, and requires no change to the target repo's tracked files. Modifying `.gitignore` would alter the working tree (and require a commit to take effect), polluting the diff. A local exclude takes effect immediately for all subsequent `git add` calls within that worktree, including those made by the harness.

**Alternative considered:** Intercept every `git add` call with a custom wrapper — rejected because the pipeline cannot wrap git calls made inside the harness subprocess.

### Decision: Explicit pathspec exclusion in the salvage path

**Chosen:** Change `defaultGitAddAll` from `git add -A` to `git add -A -- :(exclude)node_modules`.

**Rationale:** The salvage path is pipeline-authored code and is the only place where the pipeline itself calls `git add`. Adding an explicit pathspec exclusion here is a cheap, self-contained safety net that does not depend on `.git/info/exclude` being in place. Defense-in-depth.

**Alternative considered:** Rely solely on `.git/info/exclude` — rejected because a sequencing bug in bootstrap could leave the exclude file absent when salvage runs.

### Decision: Post-commit scan in `verifyHarnessCommits`

**Chosen:** After each harness step, scan commits in `headBefore..HEAD` for any tree entry whose leading path component is `node_modules`. Block with a diagnostic if found.

**Rationale:** This is the only layer that catches a `node_modules` entry committed *by the harness itself* (not by salvage). The harness runs as an external process; the pipeline can't intercept its `git` calls. Scanning the resulting commits is the correct interception point.

**Alternative considered:** Add a pre-push hook — rejected because hooks are per-checkout config, not reliably available in a fresh worktree, and the pipeline already has a post-commit verification seam.

### Decision: Symlink removal during worktree bootstrap

**Chosen:** After `git worktree add` but before any harness runs, detect and remove a `node_modules` symlink (via `fs.lstat` + `fs.unlink`) and log the removal. Do NOT remove a directory.

**Rationale:** A stale worktree (re-created over an old path that had a symlink) or a partially-failed prior run could leave a dangling symlink that confuses the install step or the harness. Removing it proactively during bootstrap keeps the worktree in a known-good state. Limiting removal to symlinks (not directories) avoids accidentally deleting a legitimately-installed `node_modules`.

## Risks / Trade-offs

- [Risk] `:(exclude)node_modules` pathspec syntax is a git extended pathspec and requires git 2.x — Mitigation: pipeline already targets git 2.x (worktree command requires it); no additional constraint.
- [Risk] `git add -A -- :(exclude)node_modules` may behave differently across git versions for symlinks — Mitigation: regression test injects the `gitAddAll` seam and verifies it is called with the correct args; integration behavior is covered by the post-commit scan.
- [Risk] A harness that stage-commits via a mechanism other than `git add -A` (e.g., `git commit -a`) would bypass the `.git/info/exclude` check — Mitigation: the post-commit scan in `verifyHarnessCommits` remains as the authoritative backstop regardless of how the harness staged the change.
