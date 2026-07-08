## Why

Some repositories commit **generated build artifacts** (a `dist/` directory, a plugin
manifest, a generated mirror) and enforce their freshness in CI with a check the pipeline
does **not** run locally — e.g. `git diff --exit-code -- dist` or
`openclaw plugins build --check`. When a fix or auto-fix round edits source but does not
rebuild those artifacts, the round commits stale generated files. The pipeline's own
test/build gate can pass (the freshness check is a *separate* CI step, not the local test
command), so the item advances to `ready-to-deploy` and then loses a full round-trip to a
CI artifact-drift failure. This exact shape recurred across issues #9, #5, #11, #53, #55,
#51 and PR #60.

This is the same class as **#358** (`fix-commit-lockfile-inclusion`), one level up: a
lock-file rewrite is a commit side-effect of a source edit produced by a *package-manager*
command, and a committed build artifact is a commit side-effect of a source edit produced
by a *build* command. #358 already folds the package-manager side-effect into the round
commit before the gates certify; this change does the same for a repo-declared build
command's output.

The pipeline must not infer which paths are "generated" vs "source" (that is repo-specific
and brittle). Instead a repo **declares** a build command — analogous to how it already
declares a test command for the test gate — and the pipeline runs it after fix/auto-fix
edits and folds the resulting artifact changes into the same commit. Repos that declare no
build command are unaffected.

## What Changes

- **New config key `build_command`** (a bare shell string, top-level in `.github/pipeline.yml`,
  mirroring `setup_command`). Absent → the feature is inert and fix/auto-fix behave exactly as
  today. There is **no** default/guessed build command and no generic "CI has an artifact guard"
  fallback — explicit declaration is required to activate the behavior.
- **Fix stage (`core/scripts/stages/fix.ts`)**: after the fix round's commit — and after the
  existing lock-file inclusion (#358), but **before** the format/test gates — when a build command
  is declared and the round produced a commit against a clean worktree, the stage SHALL run the
  build command and fold any resulting artifact changes into the round's HEAD commit
  (`git commit --amend --no-edit`), preserving that commit's message and `Issue:`/`Pipeline-Run:`
  trailers. No separate commit is minted.
- **Auto-fix path (`core/scripts/testgate.ts` fix loop)**: after each test-gate fix-harness
  attempt commits and passes the existing clean-tree / commit-format / trailer checks — and
  **before** the test command re-runs — the same rebuild-and-fold applies to that attempt's commit.
- **Build failure is surfaced, never swallowed**: if the declared build command exits non-zero, the
  round blocks with an explicit build-failure reason (needs-human) and no amend occurs. The pipeline
  never commits stale or broken artifacts.
- The rebuild-and-fold logic is placed behind an injectable dependency seam (a build runner plus the
  git status/add/amend seams) so its unit tests use fakes and perform no real git, network, or
  subprocess call.

## Capabilities

### New Capabilities
- `fix-commit-build-artifact-inclusion`: When a repo declares a build command, fix and auto-fix
  rounds run it after their edits and fold the resulting generated-artifact changes into the same
  round commit before the gates certify — so committed artifacts match the committed source and CI
  artifact-drift checks no longer fail on drift the round itself introduced. When no build command is
  declared, behavior is unchanged.

## Acceptance Criteria

- [ ] A repository can declare a build command in `.github/pipeline.yml` (`build_command: <shell string>`),
      analogous to the existing test-command declaration; it is parsed, validated, and surfaced by the
      config schema.
- [ ] When a **fix**-stage round produces a commit against a clean worktree and a build command is
      declared, the pipeline runs that command **before** the format/test gates and folds any resulting
      artifact changes into the round's HEAD commit — same message, same `Issue:`/`Pipeline-Run:` trailers,
      no separate commit.
- [ ] When an **auto-fix** (test-gate fix-loop) attempt produces a commit and a build command is declared,
      the same rebuild-and-fold applies to that attempt's commit before the test command re-runs.
- [ ] When **no** build command is declared, fix/auto-fix rounds behave exactly as they do today: the build
      command is never run, no amend occurs, and no new failure mode is introduced.
- [ ] When the declared build command exits non-zero, the round **blocks** with an explicit build-failure
      reason (needs-human) and performs **no** amend — it never commits stale or broken artifacts.
- [ ] After a fix round completes on a repo with a declared build command, re-running the build command
      against the committed source produces **no** diff (the committed artifacts match the build output).
- [ ] The step folds only changes the build command itself introduced: it runs only when the post-commit
      worktree is clean, and an unrelated pre-existing dirty path is left untouched so the existing
      dirty-worktree block still fires on it.
- [ ] Regression: a scenario equivalent to #9/#5/#11/#53/#55/#51/PR #60 — a fix edits `src/` without
      rebuilding `dist/`/the manifest — with a declared build command now yields a round commit whose
      artifacts are rebuilt, so the repo's artifact-drift CI check passes. The test **bites**: with the
      rebuild-and-fold removed, the same input leaves the artifact stale/uncommitted.
- [ ] The rebuild-and-fold behavior is exercised through injected seams (fake build runner + git
      status/add/amend); the unit tests perform no real git, network, or subprocess call.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror in the same change and `npm run ci` is green.

## Impact

- `core/scripts/config.ts` (new `build_command` key + schema/render/validate wiring).
- `core/scripts/stages/fix.ts` (+ its `AdvanceFixDeps` seam) and `core/scripts/testgate.ts` (+ its deps
  seam), plus a small helper module mirroring `lockfile-side-effects.ts`, with co-located tests under
  `core/test/`.
- The generated `plugin/` mirror (regenerated via `scripts/build.mjs`).
- No changes to state-machine edges, to the test gate's own post-run artifact-dirty certification blocks
  (a separate trust invariant — see `design.md` Non-Goals), or to how/when the lock-file inclusion runs.
