## Context

Issue #452 states that "the gitignore scaffold only covers `.agent-pipeline/runs/` and
`.agent-pipeline/roadmap/`" and asks that the fix land "everywhere the `runs/` ignore is
established (init scaffold, config sync template, and any docs listing the ignore paths)".

**Surfaced conflict (issue text vs. code).** There is no gitignore scaffold. Verified in the
worktree at `HEAD`:

- `core/scripts/pipeline.ts:1417` (`runInit`) does exactly two things: `ensurePipelineLabels`
  and `scaffoldDefaultConfig` (`.github/pipeline.yml`). It never touches `.gitignore`.
- `core/scripts/config.ts` (`renderConfigTemplate`, `syncConfig`, `scaffoldDefaultConfig`)
  only reads/writes `.github/pipeline.yml`.
- `grep -rl gitignore core/scripts` returns only `ignored-artifact-warning.ts`,
  `run-store.ts`, `stages/fix.ts`, `stages/planning.ts` — the #445 *advisory warning* about
  gitignored artifacts left uncommitted, an unrelated concern.
- This repo's `.gitignore` entries for `.agent-pipeline/runs/` and `.agent-pipeline/roadmap/`
  are hand-authored, checked in, and repo-local.

So the issue's premise about *where* the ignore lives is wrong, but its impact statement —
"every operator repo fails the doctor preflight after their first run" — is right and is in
fact worse than described: operator repos have no coverage for `runs/` or `roadmap/` either.

## Goals / Non-Goals

**Goals**
- One declarative source of truth for engine-written `.agent-pipeline/` artifact
  directories, mechanically tied to the code that creates them.
- A delivery mechanism so operator repos actually get the ignore entries.
- A drift guard so the next artifact directory cannot ship without an ignore entry.

**Non-Goals**
- Auto-editing `.gitignore` during an advance run. Ignore delivery belongs to the explicit
  onboarding/maintenance command, not to a stage handler.
- Any behavior change to `.github/pipeline.yml` sync.

## Decisions

### D1 — Source of truth lives next to the writers, in `run-store.ts`

An exported ordered list (entry: relative path + comment) is the contract. `runsDir()` and
`issueHistoryDir()` derive their `.agent-pipeline/<name>` segment from it, and
`core/scripts/roadmap/index.ts` imports the roadmap entry rather than re-literalizing
`.agent-pipeline/roadmap`. This is what makes the drift guard meaningful: a new artifact
directory added without a contract entry has no path helper to derive from.

*Alternative rejected*: a standalone `artifact-ignore.ts` listing strings with no code
coupling — it would drift silently, which is the exact failure this issue is about.

### D2 — `pipeline init` is the delivery mechanism; `config sync` is untouched

Issue AC #2 offers a choice: "`config sync` preview/apply refreshes … **or** the ignore is
delivered by whatever mechanism established the `runs/` entry — matching the existing
convention." We take the second branch, with `init` as that mechanism:

- `config sync` is scoped, by its own spec and implementation, to `.github/pipeline.yml`:
  it validates, re-renders, and refuses to write when effective config would change. A
  `.gitignore` write has no representation in that contract, and `config-sync-command` is
  still an in-flight OpenSpec change — widening its surface here would create two competing
  deltas for the same capability.
- `init` is already the "set this repo up for the pipeline" command (labels + config), is
  documented as the recommended first step, and is idempotent and safe to re-run. Re-running
  `init` is therefore the refresh path an operator uses after upgrading the engine.

### D3 — Delimited managed block, additive, never clobbering

The block is written between fixed sentinel comments, e.g.:

```
# >>> agent-pipeline artifacts (managed by `pipeline init`) >>>
# Per-run evidence bundles written by the engine; local-only, never committed.
.agent-pipeline/runs/
# Generated roadmap artifacts; delivered through a PR by `pipeline roadmap --apply`.
.agent-pipeline/roadmap/
# Per-issue evidence history (issue-<N>.jsonl); local-only, never committed.
.agent-pipeline/history/
# <<< agent-pipeline artifacts (managed by `pipeline init`) <<<
```

Rules:
- Absent block → append (creating `.gitignore` if needed), preserving prior bytes and
  ensuring exactly one trailing newline boundary.
- Present block → replace **only** the span between the sentinels.
- Block already equal to the rendered contract → no write; report "already current".
- Lines outside the sentinels are never read for meaning and never rewritten — an operator
  who has their own `.agent-pipeline/runs/` line keeps it; a duplicate ignore entry is inert
  in git and is preferable to editing operator-authored lines.

This mirrors `scaffoldDefaultConfig`'s no-clobber posture while still allowing refresh,
which a `wx` exclusive-create could not.

### D4 — Testing seam

`ensureArtifactIgnoreBlock(repoDir, deps)` takes injectable `readFile`/`writeFile` deps in
the same style as `SyncConfigDeps`, so unit tests do no real filesystem work. The drift
guard is a pure test over the exported contract plus the rendered block text — matching the
`prompt-loader.test.ts` / `review-schema.ts` drift-guard convention.

## Risks / Trade-offs

- **An operator has already committed `.agent-pipeline/history/` files.** Adding an ignore
  entry does not untrack them, so their tree stays clean but the files remain tracked.
  Out of scope; the ignore entry is still correct going forward.
- **Duplicate entries** when an operator already hand-ignored a path (as this repo has).
  Accepted: harmless in git, and strictly safer than parsing/rewriting operator lines. For
  this repo we add the missing `history/` line by hand in the same change so the doctor
  passes immediately, independent of running `init`.

## Migration

Existing repos: run `pipeline init` once after upgrading to get the managed block; already
present artifacts simply become ignored. No engine state, config key, or label changes.
