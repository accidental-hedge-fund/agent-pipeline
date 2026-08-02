## Context

After #263, advance-loop lifecycle lives in `core/scripts/pipeline-run.ts` and is exported as `runAdvance` / `dispatch`. The CLI (`core/scripts/pipeline.ts`) still owns:

- Fat `CliOpts` (~150 lines covering every subcommand’s Commander attributes).
- Commander program construction (`buildCmd`), dispatch of ~30 commands, and several pure helpers also used by advance (`ceilingRound` export; local `REVIEW_CEILING_MARKER` and `evidenceTimestamp`).

`pipeline-run.ts` currently:

```ts
import type { CliOpts } from "./pipeline.ts";
```

while `pipeline.ts` imports runtime symbols from `pipeline-run.ts`. That is a real cycle at the type graph (and would be a value cycle if the type import ever became a value import). To avoid importing more from the CLI, the run module keeps local copies of:

- `REVIEW_CEILING_MARKER` (comment: “kept in sync manually”)
- `ceilingRound` (duplicate of the exported CLI helper)
- `evidenceTimestamp` (duplicate ISO stamp helper)

`pipeline.ts` also still imports stage modules (`planningStage`, `fixStage`, `preMergeStage`, …) that the inline loop no longer uses; only symbols still needed for CLI-side override/ceiling/status paths (e.g. `reviewStage.tagCeilingFindingLines`) should remain.

Living spec `pipeline-run-service` still documents `runAdvance(..., opts: CliOpts, ...)`, which codifies the incomplete extraction.

## Goals / Non-Goals

**Goals:**

- Thin advance options type owned outside the Commander surface.
- No `pipeline-run.ts` → `pipeline.ts` import (cycle broken).
- Single definition for the three duplicated helpers/markers.
- Remove dead stage imports from the CLI module.
- Update living contracts so the service signature matches the new bag.
- Preserve operator-visible advance behavior and existing test injectability (`AdvanceDeps`).

**Non-Goals:**

- Full command-handler framework rewrite / per-command opts types for all subcommands.
- Changing advance stage semantics, review policy, auto-loop budgets, or CLI flag names.
- Moving Commander construction out of `pipeline.ts`.
- Auto-merge or merge-surface changes.
- Cross-host concurrency work unrelated to this cycle.

## Decisions

**Decision: Own `AdvanceOpts` outside `pipeline.ts` (prefer co-located with the run service or a tiny shared module).**

`AdvanceOpts` is the runtime contract of the advance loop, not of Commander. Placing it in `pipeline-run.ts` (exported) or a small neutral module (e.g. `advance-opts.ts` / shared constants module) both satisfy “outside the CLI surface.” Prefer the smallest layout that avoids reintroducing a cycle:

- If only `AdvanceOpts` + re-export of helpers is needed, exporting `AdvanceOpts` from `pipeline-run.ts` is enough for the run side; the CLI maps into it.
- If shared markers/helpers need to be imported by **both** modules without either importing the other, put those in a **neutral third module** that neither CLI nor run treats as the other’s parent.

Alternatives considered:

- *Keep `CliOpts` and use `Pick<CliOpts, ...>` in pipeline-run.* Still requires a type import from `pipeline.ts` → cycle remains.
- *Move fat `CliOpts` into a third module and have both import it.* Breaks the cycle but keeps advance coupled to the kitchen sink; does not meet “thin bag for advance.”
- *Full per-command opts split now.* Correct long-term direction (issue notes prefer command handlers) but out of scope for the minimal #630 cycle break.

**Decision: Field bag is “what advance consumes today,” not a speculative superset.**

Implementers SHALL derive the field list from `opts.*` reads in `pipeline-run.ts` (currently at least: `dryRun`, `model`, `once`, `override`, `jsonEvents`, `profile`, `runId`). Optional fields remain optional. Adding unused scoreboard/loop/queue fields is forbidden by this change.

CLI mapping: at the advance call site, construct `AdvanceOpts` from `CliOpts` (explicit field pick or a tiny pure mapper). Structural compatibility (`AdvanceOpts` assignable from a subset of `CliOpts`) is fine; reverse dependence is not.

**Decision: Single-source `REVIEW_CEILING_MARKER`, `ceilingRound`, and `evidenceTimestamp` via a neutral module (or export from one module that does not create a cycle).**

Recommended shape:

1. Neutral module (e.g. under `core/scripts/`) exports:
   - `REVIEW_CEILING_MARKER` (string constant)
   - `ceilingRound(body: string): 1 | 2 | null` (pure; keep existing anchored regex behavior)
   - `evidenceTimestamp(): string` (ISO at seconds precision, same format as today)
2. `pipeline.ts` and `pipeline-run.ts` both import from that module.
3. Existing tests that import `ceilingRound` from `pipeline.ts` keep working via re-export from `pipeline.ts` (same pattern as `AdvanceDeps` re-exports after #263).

Alternatives considered:

- *Export from pipeline-run and re-export from pipeline.* Forces CLI to import run for pure string helpers; couples CLI pure paths to the heavy run module graph. Acceptable only if implementers measure no test/import pain; neutral module is preferred.
- *Export from pipeline and have run import pipeline.* Reintroduces the cycle (exactly today’s failure mode).

**Decision: Delete only truly dead stage imports from `pipeline.ts`.**

Before removal, verify each `import * as X from "./stages/..."` has no remaining references in `pipeline.ts`. Keep imports that CLI-side handlers still use (observed: `reviewStage` for ceiling finding tagging). Do not “clean” stage modules themselves.

**Decision: Update `pipeline-run-service` living requirement text to `AdvanceOpts` (or equivalent) rather than inventing a parallel advance API.**

`runAdvance` remains the sole advance-loop entrypoint exported for the CLI and tests. Signature change is a **type/contract** change; runtime behavior (stages, labels, events, bundles, auto-loop) stays identical for the same logical options.

**Decision: Prove the cycle break with a regression test, not only a type-level hope.**

Because this repo strips types at runtime (no `tsc` gate), a pure type-only guarantee is insufficient. The test suite SHALL include a runtime-checkable assertion such as:

- static/source scan: `pipeline-run.ts` source text does not match an import from `./pipeline.ts` / `pipeline.ts`; and/or
- identity: both modules resolve the same exported marker constant / `ceilingRound` function reference from the shared owner.

Prefer a small source-graph or export-identity test co-located under `core/test/`, following existing drift-guard patterns.

## Risks / Trade-offs

- **[Risk] Mapper drift: CLI gains a new advance-relevant flag but forgets to map it into `AdvanceOpts`.** → Mitigation: derive fields from run-side reads; optional unit test that lists required keys; keep mapper next to the `runAdvance` call site; review discipline on advance flag additions.
- **[Risk] Re-export churn for tests importing `ceilingRound` / types from `pipeline.ts`.** → Mitigation: re-export from `pipeline.ts` for backward compatibility (same #263 pattern for `AdvanceDeps`).
- **[Risk] Neutral module becomes a new junk drawer.** → Mitigation: only the three duplicated helpers/marker (and optionally `AdvanceOpts` if that layout wins); no scoreboard/loop types.
- **[Risk] Scope creep into full command registry handlers.** → Mitigation: explicit non-goal; tasks checklist forbids rewriting non-advance commands.
- **[Risk] Living `pipeline-run-service` purpose still TBD from archive.** → Mitigation: delta only the requirements that change; optional purpose one-liner if implementers touch the living file at archive time.

## Migration Plan

1. Land shared helper owner + `AdvanceOpts` without behavior change.
2. Switch `runAdvance`/`dispatch` signatures; map at CLI call site; delete run→CLI type import.
3. Remove dead stage imports; re-export helpers as needed.
4. Regenerate `plugin/`; run `npm run ci`.
5. No operator migration: flags and advance outcomes unchanged. Rollback is revert of the PR.

## Open Questions

- None blocking. Implementer may choose “`AdvanceOpts` in `pipeline-run.ts` + helpers in neutral module” vs “both in one neutral module” as long as the cycle-break and single-source requirements hold.
