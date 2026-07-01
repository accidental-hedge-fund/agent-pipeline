## Context

The fix stage (`core/scripts/stages/fix.ts`) runs the implementer harness against review findings in the
issue's worktree, then advances through a chain of deterministic guards before pushing:

1. no-new-commit **salvage** (`trySalvageUncommittedWork`) — fires only when `headBefore === headAfter`;
2. commit-message-format gate (`enforceFixCommitGate`);
3. OpenSpec spec-delta validation (`enforceOpenspecSpecDeltaValidation`);
4. **format + test gates** (`runFormatAndTestGates`), each of which begins with a *pre-flight dirty check*
   that blocks if the worktree has any uncommitted change.

A package-manager command run by the fix harness (an `npm ci`/`npm install` to verify its work) can rewrite
a lock file — `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`, possibly nested (e.g.
`plugin/.../package-lock.json`). The harness commits its source edits but leaves the lock-file changes
uncommitted. Because a commit *was* produced, the salvage path in (1) is skipped, so the dirty lock files
survive to (4) and trip the format/test-gate dirty block. The run halts on `needs-human`; the observed
recovery in the #356 session was a manual `git add + commit`.

## Goals / Non-Goals

**Goals**
- After a fix round commits, the worktree carries no uncommitted lock-file changes — the format/test gates
  see and certify exactly what will be pushed.
- Lock-file side-effects are folded into the round's own commit, preserving its message and traceability
  trailers, so no extra commit is minted and no new SHA-classification question is raised for the #16 gate.
- The fix path stays conservative: no lock change → no behavioral change; a non-lock leftover file is never
  auto-included.

**Non-Goals**
- Changing how or when `npm ci`/the package manager is invoked (explicitly out of scope for #358).
- Auto-including arbitrary uncommitted files. Only the three recognized lock files are folded in; everything
  else still hits the existing dirty-worktree block.
- Touching the test gate's own *post-run* artifact-dirty blocks (`testgate.ts`: "Test/build command left
  uncommitted changes … Commit any generated artifacts"). Those certify that the *test command itself* left
  no drift and are a separate trust invariant; the observed #356 failure was the fix harness's own lock
  side-effect landing *before* the gates, which this change resolves. If the test-command path ever needs
  the same treatment it is a tracked follow-up, not this change.

## Decisions

**Decision: fold lock files into the round commit via `git commit --amend --no-edit`, not a new commit.**
The acceptance criteria call for the lock file to be committed "alongside the source changes in the same
commit (same commit message, same trailers)." Amending the round's HEAD achieves exactly that: the message
and `Issue:`/`Pipeline-Run:` trailers are reused verbatim, so the commit-format and trailer gates still pass.
Nothing has been pushed yet at this point in `advanceFix` (the push is the stage's final step), so amend is
safe and needs no force-push. Amend also avoids minting a separate commit that the #16 review-SHA gate would
have to classify as internal vs. developer — the round commit's identity is unchanged in kind.

**Decision: gate the inclusion on the round having produced a commit.** The helper runs only when
`headBefore && headAfter && headBefore !== headAfter`. When the harness produced no commit, path (1)'s
salvage already stages everything (`git add -A`, lock files included), so there is nothing left for this step
to do; running amend with no prior round commit would be wrong.

**Decision: restrict staging to lock-file pathspecs — only lock files are auto-included.** Staging uses an
explicit pathspec matching `package-lock.json`, `yarn.lock`, and `pnpm-lock.yaml` at any depth (git
`:(glob)**/<name>` magic, which matches the root and nested copies). A non-lock dirty file is therefore never
staged by this step and still reaches the existing dirty-worktree block — preserving the #358 out-of-scope
boundary ("Handling unrelated uncommitted files"). This is the intended, surgical behavior: the fix stage
does not silently absorb unexplained leftovers.

**Decision: injectable seam, no real git in tests.** The helper takes injectable `gitStatusPorcelain`,
`gitAddPaths`, and `gitAmendNoEdit` seams (mirroring `SalvageDeps`) and is added to `AdvanceFixDeps`. The
regression test injects fakes so it runs with no network, git, or subprocess — consistent with the repo's
dependency-seam testing convention and the CI-environment test rule. Because the core runs via
type-stripping (no `tsc`), the biting test is what actually enforces the behavior, not the types.

## Risks / Trade-offs

- *Amend rewrites the tip SHA.* Safe here because the branch is not pushed until the end of `advanceFix`; no
  history that anyone else has seen is rewritten. The regression test asserts the message/trailers survive.
- *Harness makes multiple commits and only the tip is amended.* Lock files are a side-effect of the round as
  a whole; attaching them to the round's tip commit is a natural and correct home. No requirement ties a lock
  file to a specific source commit.
- *A lock file legitimately unrelated to this round is dirty.* In practice the only way a lock file becomes
  dirty inside the round is a package-manager run during the round, so folding it in reflects what was
  actually produced/tested. Even in an edge case, committing the exact tested lock state is strictly better
  than pushing a worktree whose committed state diverges from what the test gate certified.
