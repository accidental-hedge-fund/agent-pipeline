## Why

Issue #263 extracted the advance-loop lifecycle into `pipeline-run.ts`, but left a type-level cycle: `pipeline-run.ts` type-imports fat `CliOpts` from `pipeline.ts` while `pipeline.ts` imports the advance API from `pipeline-run.ts`. `CliOpts` is a kitchen-sink Commander surface (scoreboard, evals, correction, queue, loop, report, …) that advance does not need. Manual “kept in sync” duplicates (`REVIEW_CEILING_MARKER`, `ceilingRound`, `evidenceTimestamp`) and residual dead stage imports in `pipeline.ts` paper over the incomplete split. The architectural review (2026-07-27) flagged this residual as the next minimal cycle break before any larger command-handler rewrite.

## What Changes

- Introduce a thin **`AdvanceOpts`** (name may be `AdvanceOpts` or an equivalent export) owned **outside** the Commander/CLI surface so the advance loop no longer depends on fat `CliOpts`.
- Change `runAdvance` / `dispatch` (and any advance-only helpers that currently take `CliOpts`) to accept `AdvanceOpts` instead of `CliOpts`.
- Break the type cycle: `pipeline-run.ts` SHALL NOT import (type or value) from `pipeline.ts`.
- Single-source duplicated markers/helpers (`REVIEW_CEILING_MARKER`, `ceilingRound`, `evidenceTimestamp`) so both CLI and run modules consume one definition.
- Delete residual dead stage imports from `pipeline.ts` that only existed for the pre-extraction inline loop (keep any still-used symbols, e.g. `reviewStage` helpers used by override/ceiling CLI paths).
- CLI (`pipeline.ts`) continues to own fat `CliOpts` for Commander parsing and maps the advance-relevant subset into `AdvanceOpts` at the call site.
- Prefer command-handler registration long-term; **this issue is the minimal cycle break only** — no full rewrite of all ~30 subcommands.
- Edit `core/`, regenerate `plugin/` via `node scripts/build.mjs` in the same change. No auto-merge.

## Acceptance criteria

- [ ] An `AdvanceOpts` (or equivalent) type exists owned outside `pipeline.ts` / the Commander surface and contains only fields the advance loop actually consumes (at minimum the current set used by `runAdvance`/`dispatch`: e.g. `dryRun`, `model`, `once`, `override`, `jsonEvents`, `profile`, `runId` — exact bag verified against call sites at implement time).
- [ ] `runAdvance` and advance-loop `dispatch` accept `AdvanceOpts`, not fat `CliOpts`.
- [ ] `pipeline-run.ts` has **no** import (type or value) from `./pipeline.ts` (cycle broken at the module graph level).
- [ ] Fat `CliOpts` remains on the CLI surface for Commander / non-advance commands; advance invocation maps CLI opts → `AdvanceOpts` without changing operator-visible advance behavior.
- [ ] `REVIEW_CEILING_MARKER`, `ceilingRound`, and `evidenceTimestamp` each have a **single** definition consumed by both CLI and run paths (no manual “kept in sync” local copies).
- [ ] Dead stage imports left over from the #263 extraction are removed from `pipeline.ts`; still-used imports remain.
- [ ] Existing advance / lifecycle / override tests continue to pass; any import-path updates are non-breaking or covered by re-exports where needed.
- [ ] Unit tests assert the cycle break and/or single-sourced helpers (e.g. no `pipeline.ts` import in `pipeline-run.ts`; shared marker/helper identity or pure helper parity).
- [ ] `core/` changes are mirrored with `node scripts/build.mjs`; `openspec validate` and `npm run ci` pass.
- [ ] No full command-handler framework rewrite of all subcommands is introduced; no auto-merge path is added.

## Capabilities

### New Capabilities

- `advance-opts-boundary`: Thin advance options bag owned outside the Commander surface; module-cycle break between CLI and advance-run; single-sourced review-ceiling / evidence helpers shared by CLI and run; residual dead stage-import cleanup in the CLI module.

### Modified Capabilities

- `pipeline-run-service`: `runAdvance` (and related advance-loop entrypoints) take the thin advance options type instead of fat `CliOpts`, and remain importable without importing the CLI module.

## Impact

- **Core modules:** `core/scripts/pipeline-run.ts`, `core/scripts/pipeline.ts`, and a small shared owner module if helpers/`AdvanceOpts` are extracted (exact file layout is a design decision).
- **Tests:** advance lifecycle tests, override/ceiling pure helpers (`ceilingRound`), any import-path consumers of `CliOpts` as the advance bag; possible new cycle/boundary regression tests.
- **Living specs:** new `advance-opts-boundary`; delta on `pipeline-run-service`.
- **Generated mirror:** `plugin/` regenerated with `node scripts/build.mjs`.
- **Out of scope:** full command-handler registration rewrite of all ~30 subcommands; splitting fat `CliOpts` into per-command opts bags beyond what advance needs; behavior changes to stage semantics, review policy, auto-merge, or operator CLI flags.
