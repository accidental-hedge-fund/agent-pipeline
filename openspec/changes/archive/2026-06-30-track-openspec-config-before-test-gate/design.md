## Context

OpenSpec treats `openspec/config.yaml` as **project config**, not a transient cache:

- `openspec init` creates it (`createConfig()` writes `schema: <DEFAULT_SCHEMA>`).
- Root inspection reports a missing config as `openspec_config_missing`, and `ensureDefaultConfig()`
  lazily writes `openspec/config.yaml` the first time a command runs in an initialized repo that
  lacks it (e.g. `openspec new change`, `openspec validate`).
- `readProjectConfig(projectRoot)` reads `schema`, `context`, `rules`, `store`, `references`.

Our planning prompt (`planning_openspec.md`) instructs the harness to run
`openspec new change <name>` and `openspec validate <name>`, and to commit **only** under
`openspec/changes/<name>/`. So on an already-initialized repo with no committed `config.yaml`, the
CLI writes `config.yaml` as a side effect and the harness's change-scoped commit does not include
it → the file is left untracked.

The existing OpenSpec-scoped salvage (`salvageIfNoNewCommit(..., "openspec/")`,
`harness-uncommitted-salvage`) only stages/commits when the harness produced **no** new commit
(`headAfter === headBefore`). When the authoring harness *did* commit the change, salvage is
skipped and the stray `config.yaml` survives untracked. The implementation harness then runs and
the test gate's pre-run dirty check (`testgate.ts`) blocks with a generic message that lists no
paths.

> Note: the `agent-pipeline` repo itself does **not** track `openspec/config.yaml`, so this very
> change is a live reproduction surface — a clean confirmation that the fix is needed.

## Goals / Non-Goals

**Goals**
- Leave the worktree free of untracked OpenSpec project config (`openspec/config.yaml`) before
  implementation and the test gate, by committing it during OpenSpec planning/setup.
- Make the test-gate dirty-tree block self-diagnosing by naming the offending paths.

**Non-Goals**
- No change to the `openspec.bootstrap` path — `openspec init` + `git add -A` already commits
  `config.yaml`.
- No broadening of the OpenSpec-scoped salvage semantics (it stays "no new commit"); the config
  commit is a **separate, unconditional** step so it also fires when the harness committed.
- No change to which `openspec` commands the prompt runs, and no change to the freeform
  (non-OpenSpec) path.
- The secondary "plain `blocked` vs `pipeline:blocked` label" integration note in the issue is a
  worker-side concern and is explicitly out of scope here.

## Decisions

### D1 — Reactive commit after authoring, not proactive before it

`config.yaml` is created **lazily** by the CLI, so before the authoring harness runs the file
does not reliably exist; a proactive "ensure config then commit" step would have to force-create it
by relying on a CLI side effect. Instead, commit it **after** authoring + salvage, by which point
`openspec new change`/`validate` has deterministically created it. This mirrors how the bootstrap
path already behaves (commit config as part of OpenSpec setup) without depending on CLI internals.

### D2 — Dedicated, scoped, idempotent commit step

Add a small helper (e.g. `commitOpenspecProjectConfig(wtPath, issueNumber, pipelineRunId, deps)`)
that:
1. Runs `git status --porcelain -- openspec/config.yaml` (in the worktree).
2. If the file is untracked or modified, `git add -- openspec/config.yaml` then `git commit` with a
   trailered message such as `chore: track openspec/config.yaml (#<n>)`.
3. If the porcelain output is empty (already committed / unchanged), it is a **no-op** — no commit,
   no error.

Scoping the `git add` to exactly `openspec/config.yaml` keeps the commit inside the existing
authoring path-constraint guard (`allowPattern: /^openspec\//`) and avoids sweeping unrelated
files. The step is injectable behind a `Deps` seam (fake `gitStatus`/`gitAdd`/`gitCommit`) so unit
tests do no real git, matching the repo's salvage/verify test pattern. It runs **before** the
path-constraint `verifyHarnessCommits` so the committed config is part of the verified range.

### D3 — Surface porcelain paths in the test-gate dirty block

`testgate.ts`'s `defaultGitDirty` returns a boolean. To name paths, capture the porcelain output
once and reuse it:
- Add a `gitStatusPorcelain(cwd): Promise<string>` seam (default: `git status --porcelain`), and
  derive dirtiness from `output.trim().length > 0` (keep `gitDirty` for callers that only need the
  boolean, or repurpose it — design detail for the implementer).
- At both dirty-block sites (pre-run dirty, and passing-run-left-artifacts), append the trimmed
  porcelain output to the `blockReason`, truncated via the gate's existing output-cap helper so a
  large list can't blow up the GitHub comment.

The block message stays human-readable: the existing sentence, then a short labeled block of the
porcelain lines, e.g.:

```
Worktree has uncommitted changes before the test gate ran. All changes must be committed so test
results can be trusted. Uncommitted paths:
?? openspec/config.yaml
```

## Risks / Trade-offs

- **An extra commit on the branch.** One small `chore:` commit per run when the CLI created
  `config.yaml`. Acceptable — it is foundational project config that *should* be tracked, and the
  commit is internal (`chore:`), so the review-SHA gate classifies it as pipeline-internal and does
  not invalidate any verdict.
- **Truncation of the porcelain list.** A pathological worktree with hundreds of dirty paths is
  truncated; that is strictly better than today's zero-path message and is bounded by the existing
  cap.

## Migration / Rollout

Pure additive behavior on the OpenSpec planning path and the test gate; no config keys, no schema
changes, no effect on repos that don't use OpenSpec or on the bootstrap path. Ships with regression
tests that bite, and the regenerated `plugin/` mirror.
