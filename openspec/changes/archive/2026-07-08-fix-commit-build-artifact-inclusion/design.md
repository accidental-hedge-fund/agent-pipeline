## Context

The fix stage (`core/scripts/stages/fix.ts`) runs the implementer harness against review findings,
then advances through deterministic guards before pushing: no-new-commit salvage → commit-message-format
gate → OpenSpec spec-delta validation → **lock-file inclusion (#358)** → **format + test gates**
(`runFormatAndTestGates`). The auto-fix loop lives one level down, inside the test gate
(`core/scripts/testgate.ts`): on a failing test command it invokes the fix harness up to
`test_gate.max_attempts` times, each attempt committing and then re-running the command.

Both paths commit source edits. Neither rebuilds a repo's **committed generated artifacts**
(`dist/`, a plugin manifest, a generated mirror). Repos that guard artifact freshness in CI with a
check the pipeline does not run locally — `git diff --exit-code -- dist`, `openclaw plugins build --check`
— therefore fail CI on drift the fix itself introduced. The pipeline's own test gate does not catch it
when the freshness check is a *separate* CI step rather than the local test command (#9, #5, #11, #53,
#55, #51, PR #60).

This is the #358 shape one level up. #358 (`fix-commit-lockfile-inclusion`) folds a package-manager
side-effect (a rewritten lock file) into the round commit before the gates certify. Here the side-effect
is a *build* output produced by a repo-declared build command.

## Goals / Non-Goals

**Goals**
- A repo can declare a build command; fix and auto-fix rounds run it after their edits and fold the
  resulting artifact changes into the same round commit, so committed artifacts match committed source.
- Folding uses `git commit --amend --no-edit`, preserving the round commit's message and
  `Issue:`/`Pipeline-Run:` trailers — no extra commit, no new SHA-classification question for the #16 gate.
- A build failure is surfaced explicitly (block) and never results in a committed stale/broken artifact.
- Undeclared repos are unaffected: the feature is fully inert.

**Non-Goals**
- Inferring which paths are "generated" vs "source". The pipeline runs the *declared build command* and
  folds *its output*; it does not classify artifact boundaries (explicitly out of scope for #387).
- A default/guessed build command or a generic "CI has an artifact guard → run the repo build" fallback for
  repos that declared nothing. Explicit declaration is required (see the Open-Question decision below).
- Adding build behavior to planning or review stages — this is scoped to fix and auto-fix commits.
- Changing the test gate's own *post-run* artifact-dirty block ("Test/build command left uncommitted
  changes … Commit any generated artifacts"). That certifies the *test command itself* left no drift and is
  a separate trust invariant; if it ever needs the build-command treatment it is a tracked follow-up.

## Decisions

**Decision: a repo-declared `build_command`, not artifact-boundary inference.** #387's out-of-scope is
explicit: the pipeline "only runs the declared build command, it does not infer artifact boundaries." So a
new top-level `build_command` (a bare shell string, run via `bash -c`, mirroring `setup_command`) is the
activation surface. This mirrors the existing test-command declaration the acceptance criteria call for.

**Decision (Open Question): explicit declaration required; no generic fallback.** The issue floats a generic
"if CI has a committed-artifact guard, the fix prompt should run the repo build" fallback. We reject it for
the first cut: detecting "CI has an artifact guard" is exactly the artifact-boundary inference the issue puts
out of scope, and guessing a build command (`npm run build`?) risks running the wrong command or a
destructive one on repos that never opted in. Explicit `build_command` keeps the behavior deterministic,
auditable, and inert-by-default — consistent with how `test_gate`, `eval_gate`, and `setup_command` all
activate only on declaration. A prompt-level nudge can be a separate follow-up if data shows it is needed.

**Decision: fold via `git commit --amend --no-edit`, gated on a clean post-commit worktree.** The build runs
only when the round produced a commit *and* the worktree is clean, so any dirt observed after the build is
attributable to the build. We then stage that output and amend the round's HEAD — reusing its message and
trailers verbatim (so the commit-format/trailer gates still pass) and minting no separate commit (so the #16
review-SHA gate has no new commit to classify). Nothing is pushed until the end of `advanceFix`, so amend
needs no force-push. When the build yields no diff, no amend occurs and the SHA is preserved. Requiring a
clean tree before the build means an *unrelated* leftover dirty path is never swept into the build commit —
it still reaches the existing dirty-worktree block, preserving that guard.

**Decision: run the build whenever the round produced a commit, not only when "source dirs" changed.** AC
phrasing mentions "changes files under source directories," but classifying source dirs is the inference the
issue puts out of scope. Because a build command is idempotent, running it after any round commit is safe: a
commit that changed nothing build-relevant yields no artifact diff and the amend is a no-op. This keeps the
trigger simple and boundary-free at the cost of one build run per committing round on opted-in repos — an
acceptable, rigor-preserving trade (the repo opted in by declaring the command).

**Decision: cover both fix and auto-fix, because either can be the last source mutation.** If only the fix
stage folded artifacts, an auto-fix attempt inside the test gate could still land a source edit whose
artifacts are never rebuilt (the test command may pass without the CI-only freshness check). If only the
auto-fix path folded, a fix round whose test command passes on the first run (no fix-loop entry) would never
rebuild. Both paths call the same helper.

**Decision: build failure blocks with a distinct reason.** A non-zero build exit means the declared build is
broken against the committed source; committing its partial/stale output would ship exactly the drift this
change prevents. The round blocks (needs-human) with an explicit build-failure reason distinct from the
test-gate's "failed after N fix attempt(s)" message, and performs no amend.

**Decision: injectable seam, no real git/subprocess in tests.** The helper takes an injectable build runner
plus git status/dirty/add/amend seams (mirroring `LockfileSideEffectsDeps`) and is added to `AdvanceFixDeps`
and the test-gate deps. The biting regression test injects fakes and runs with no network, git, or
subprocess — consistent with the repo's dependency-seam convention. Because the core runs via type-stripping
(no `tsc`), the biting test is what enforces the behavior.

## Risks / Trade-offs

- *Amend rewrites the tip SHA.* Safe: the branch is unpushed until the end of `advanceFix`; the regression
  test asserts message/trailers survive.
- *A build run per committing round adds latency on opted-in repos.* Accepted and rigor-preserving: the repo
  opted in, correctness (fresh artifacts) beats a saved build, and an idempotent build on an unchanged source
  set is cheap-to-no-op in practice. Undeclared repos pay nothing.
- *The build command has side-effects beyond artifacts (network, global installs).* Same trust model as the
  existing `setup_command`/`test_gate.command`: the operator owns the declared command; the pipeline runs it
  in the managed worktree only.
- *Build output overlaps a genuinely unrelated leftover.* Mitigated by the clean-tree gate: the fold only
  runs when the post-commit tree is clean, so there is no unrelated leftover to conflate at fold time.
