## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `runSingleIssueCommand` in `core/scripts/pipeline.ts` is already the canonical one-item durable supervisor (`runLoopEngine` with a one-item work-list). `pipeline single` is the public verb for that facade.
- Public mutating `pipeline <N>` currently falls through to `runAdvance` after read-only and mode-selector preservation (`pipeline.ts` after `--override` returns). Hidden `pipeline run <N>` without `--detach` rewrites `numArg` onto that same numeric path. `handleRunSubcommand` without `--detach` still calls `runAdvance` directly (test/direct callers).
- `--detach` is handled **before** config resolution: `pipeline run <N> --detach` and `pipeline <N> --detach` both call `handleRunSubcommand`, which `spawnDetached`s a wrapper whose inner argv is `pipeline.ts <N> [passArgs]` with **no** `PIPELINE_NESTED_ADVANCE` marker.
- `runAdvance` in `core/scripts/pipeline-run.ts` is already the whole-item stage executor. Loop children spawn `pipeline <N>` with `PIPELINE_NESTED_ADVANCE=1` via `dispatchItemChildArgs` / `nestedAdvanceChildEnv`. In-process recover-parked re-entry and override resume already call `runAdvance` with `emitAdvanceHandoff: false`.
- `formatLoopRunHandoff` and `loop_item_advance_linked` already publish loop identity and child advance identity. `advance_run_handoff` is the current public-numeric identity (#1049).
- RecoverySupervisor vocabulary in `CONTEXT.md`. Command-form inventory already labels numeric drive as a durable one-item drive. Living `durable-loop-supervisor` already requires one-item drives to use the same supervisor; `advance-skill-orchestration` still pins a direct-advance bypass.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: alias public mutating numeric drive to `runSingleIssueCommand`. Keep `runAdvance` as the nested executor. Do not add a second one-item scheduler.
- Name one command-dispatch seam with a frozen precedence table. Mode selectors and read-only forms dispatch before aliasing. Current `--detach` rejection behavior stays.
- Define a typed child-input bag (`OneItemChildAdvanceInputs`). Capture it from numeric compatibility flags, store it on the one-item `RunLoopEngineInput`, and pass it into `runAdvance` only through the non-public adapter.
- Detached child is the same one-item supervisor. Keep repo-resolution-before-artifacts, issue-run lock, sentinel, timeout watchdog, and compatible child-option forwarding.
- One canonical loop-run handoff for public numeric drive. Child advance identity only through typed linkage.
- Parity coverage for hidden `pipeline run <N>` attached and detached. Negative recursion tests for nested children.

**Non-Goals:**

- Merge authority, a merge stage, or `auto_merge`.
- Host-owned retry policy or recovery recipes in generated SKILLs.
- A public `pipeline supervise` / `pipeline internal-advance` verb.
- Reimplementing RecoverySupervisor (#1323), issue-stage adapters (#1328), command-form inventory (#1329), train/merge exactness, ship, liveness, or the fault matrix.
- Changing multi-item `pipeline loop` child policy that omits `--once` so a loop child can reach a contract terminal.
- Widening `COMMAND_REGISTRY.single.allowedFlags`. `pipeline single <N> --once` stays rejected. Numeric `allowedFlags: "all"` stays the compatibility parser.
- Replacing `pipeline/loop-execution@1` spawn with in-process `runAdvance` (pin/linkage/stdio isolation already work).

## Approach

Follow the existing one-item facade, not a new scheduler.

`runSingleIssueCommand` in `core/scripts/pipeline.ts` already compiles `{ type: "work-list", value: [String(issueNumber)] }`, calls `runLoopEngine` with `autoSupersedeTerminal: true`, and emits `formatLoopRunHandoff` from `onRunReady`. `pipeline single` is that facade. Tests already inject `SingleIssueCommandDeps.runLoopEngine` (see `core/test/pipeline-cli.test.ts`, `advanceIssueThroughSingle`).

This change aliases public mutating numeric drive onto that same function. Child inputs use the existing `toAdvanceOpts` mapper (`CliOpts` → `AdvanceOpts`) so `pipeline-run.ts` never imports the CLI. Nested spawn keeps `dispatchItemChildArgs` + `nestedAdvanceChildEnv`; the new CLI branch calls a named adapter instead of the public alias.

## Decisions

### D1 — Alias public mutating numeric drive to `runSingleIssueCommand`

After the precedence table in D7, mutating `pipeline <N>` calls `runSingleIssueCommand` with the resolved issue number string and the original `CliOpts`. Hidden `pipeline run <N>` without `--detach` stays a redirect onto that numeric path (existing `numArg` rewrite), so it inherits the alias.

`handleRunSubcommand` without `--detach` also calls `runSingleIssueCommand` (today it calls `runAdvance` at the non-detach tail). Direct test callers of that function must not keep a raw-advance owner.

`pipeline single` remains the named canonical verb. Numeric syntax is a compatibility alias. Invocation syntax does not select a different owner.

Alternative considered: keep `runAdvance` for numeric and add a thin recovery wrapper. Rejected: that is a second one-item scheduler. The holding rung already exists.

### D2 — Nested admission is an explicit non-public adapter onto `runAdvance`

`runAdvance` stays the internal executor. It is not the public numeric lifecycle owner.

Add an exported adapter `runNestedWholeItemAdvance(cfg, issueNumber, opts: AdvanceOpts)` in `core/scripts/pipeline.ts` (or a tiny adjacent module that already imports both CLI-neutral types and `runAdvance`). The adapter:

- Calls `runAdvance(cfg, issueNumber, { ...opts, emitAdvanceHandoff: false })`.
- Does not call `runSingleIssueCommand`.
- Does not construct argv.
- Does not call `buildCmd().parse`, `main()`, or the public numeric alias.

Nested whole-item advancement uses that adapter, not a second public admission:

- Spawned `pipeline/loop-execution@1` children keep `dispatchItemChildArgs` (`pipeline <N>` argv) and `PIPELINE_NESTED_ADVANCE=1`.
- The CLI treats `isNestedAdvanceChild()` / `PIPELINE_NESTED_ADVANCE=1` as nested admission **before** the public alias and calls `runNestedWholeItemAdvance(cfg, issue, toAdvanceOpts(opts))`.
- In-process recover-parked re-entry and override resume keep calling `runAdvance` directly (they already pass `AdvanceOpts`; they may call the adapter). They do not go through public numeric aliasing.

**Resolution of “must not rebuild public numeric argv or re-enter CLI dispatch”:** the adapter itself never rebuilds argv and never enters the public alias. The existing loop-execution spawn remains the process boundary (pin, linkage, stdio inherit). That child process re-enters `pipeline.ts` only far enough to take the nested-admission branch. A fixture that treats that child as public mutating `pipeline <N>` (calls `runSingleIssueCommand`, emits `loop_run_handoff`, or mints a second supervisor) fails.

Do not add a public internal-advance verb. Do not invent `numeric-supervisor.ts`.

Alternative considered: change loop children to spawn `pipeline single <N>`. Rejected: that recursively creates another supervisor. Alternative considered: in-process `runAdvance` from the supervisor with no child argv. Rejected as a larger rewrite; the spawn seam and pin/linkage already work.

### D3 — One canonical loop-run handoff; linkage publishes child advance identity

Public mutating `pipeline <N>` emits `formatLoopRunHandoff` (same object as `pipeline single`). Hosts retain `loop_run_id` and follow `pipeline loop logs`. Child advance identity is published only through `loop_item_advance_linked` / start-linkage.

Public numeric drive does not emit top-level `advance_run_handoff`. Nested `runAdvance` continues to suppress that handoff (`PIPELINE_NESTED_ADVANCE` / `emitAdvanceHandoff: false`). Tests that pin public numeric `advance_run_handoff` are replaced with lifecycle-parity tests. Executor unit tests that call `runAdvance` directly may still assert nested suppression.

This is an intentional observability break for hosts that scraped `advance_run_handoff` from `pipeline <N>`.

### D4 — Detach the aliased public path; do not special-case a raw-advance child

Detached-child launch form (frozen):

1. Launcher: existing `handleRunSubcommand` detach branch. Resolve git root **before** any wrapper dir / run-store pointer / lock artifact. Derive domain. Reject current mode-selector combinations (D7). Restore-dead-wrapper / live-holder behavior unchanged.
2. Wrapper: existing `spawnDetached` → `detach.ts` `_wrapper`. Wrapper acquires the `(domain, issue)` issue-run lock, writes sentinel on every exit, honors timeout watchdog, packs harness env, sets `ISSUE_RUN_LOCK_HELD`.
3. Inner argv: `node --experimental-strip-types pipeline.ts <N> [passArgs]`. **No** `PIPELINE_NESTED_ADVANCE`. **No** `--detach` on the inner process. **No** `pipeline single` rewrite.
4. Inner process is therefore public mutating numeric drive and aliases to `runSingleIssueCommand` (D1).
5. `passArgs` remain compatible child options plus launcher pins: `--profile`, `--repo-path`, `--base`, `--domain`, `--model`, `--dry-run`, `--once`, `--sha`, `--doctor`, `--fail-fast`, `--json-events` when set, **`--engine-track` when set** (today this is omitted; add it so the flag survives detach), and always `--run-id <preallocated-advance-id>`.
6. Pre-allocated `--run-id` is an **immutable nested-advance pin** (`AdvanceOpts.runId`), not the public canonical loop identity. The inner supervisor emits `formatLoopRunHandoff` onto wrapper stdout (`pipeline.log`). `run-store.json` may still point at the nested advance dir. Launcher stderr must not tell hosts to follow `pipeline logs <preallocated-id>` as the canonical numeric identity.

Mode-selector flags remain incompatible with `--detach` per the current rejection table (D7). Do not “fix” the existing `run --detach` vs `N --detach` cleanup/init asymmetry.

### D5 — Typed child-input boundary

Numeric `allowedFlags: "all"` stays so `--once`, `--dry-run`, `--model`, `--run-id`, `--engine-track`, `--json-events`, `--sha`, and peers still parse. They do not select raw `runAdvance` as the top-level owner. Do not widen `single.allowedFlags`.

**Capture** at the public numeric / hidden-run / detach-inner CLI using the existing mapper:

```ts
export type OneItemChildAdvanceInputs = Pick<
  AdvanceOpts,
  | "dryRun"
  | "model"
  | "once"
  | "runId"
  | "engineTrack"
  | "jsonEvents"
  | "profile"
  | "candidateShaOverride"
>;
```

`toAdvanceOpts` already maps those fields from `CliOpts` (`--sha` → `candidateShaOverride`). Add `engineTrack` to the `toAdvanceOpts` `Pick` so the mapper’s types match the body.

**Store** on the one-item supervisor payload as `RunLoopEngineInput.childAdvance?: OneItemChildAdvanceInputs`. `runSingleIssueCommand` passes `childAdvance: toAdvanceOpts(opts)` into `runLoopEngine`. Multi-item `runLoopCommand` omits `childAdvance`.

**Consume** in `defaultRunLoopEngine` → `realDispatchItem(cfg, engine, { childAdvance: input.childAdvance })`:

- If `childAdvance.runId` is set, use it as the nested pin instead of minting `pinAdvanceRunIdentity`.
- Forward `once`, `dryRun`, `model`, `engineTrack`, `jsonEvents`, `candidateShaOverride` onto `dispatchItemChildArgs` **only when `childAdvance` is present**.
- Multi-item callers still call `realDispatchItem(cfg, engine)` with no `childAdvance`, so they still omit `--once` (#512).

**Adapter invoke:** the nested CLI branch and in-process re-entry call `runNestedWholeItemAdvance(cfg, issue, toAdvanceOpts(opts))` / `runAdvance` with that mapped bag. They do not rebuild `["pipeline", String(n), ...]` or re-parse Commander.

`--dry-run` on numeric drive still means no GitHub writes. The supervisor owns the dry-run attempt rather than skipping to an unsupervised executor.

`--doctor` / `--fail-fast` stay supervisor-process preflight flags (not `AdvanceOpts`). Detach continues to forward them to the inner supervisor process.

### D6 — Generated SKILL and docs follow the loop contract

Update `core/scripts/host-skill.ts` so default numeric drive is the durable one-item path: retain `loop_run_id`, follow loop logs, follow linked advance after linkage. Reverse tests that currently forbid "`pipeline <N>` yields `loop_run_id`" and that complete numeric observation on child `run_complete` without a loop follow. Run `node scripts/build.mjs` after the renderer change. Align `docs/concepts.md` / `docs/cli.md`. Durable docs must not present `pipeline status <N>` as run-id discovery and must not present a top-level `advance_run_handoff` as the canonical numeric identity.

Generated SKILLs still retain `pipeline <N>` syntax. They must not recommend a raw-advance bypass.

### D7 — Command-dispatch seam and precedence table

**Seam:** after flag validation and named-command dispatch, a numeric first argument (including hidden `run` rewritten to that number) is handled by one exported function, `admitMutatingNumericDrive`, **only after** the table below returns.

Frozen precedence for a numeric first arg or `pipeline run <N>` rewrite. Do not reorder.

| Order | Form | Action | Notes |
| --- | --- | --- | --- |
| 1 | Flag validation (`validateFlags`) | reject exit 2 | numeric/`run` keep `allowedFlags: "all"` |
| 2 | `--remove-worktree` + `--detach` (and other `rwConflicts`) | reject | already before detach |
| 3 | `pipeline run` extra positionals | reject | before detach |
| 4 | `pipeline run <N> --detach` + `--status` / `--summary` / `--unblock` / `--override` / `--cleanup` / `--init` | reject | keep this list; it is wider than row 6 |
| 5 | `pipeline run <N> --detach` | `handleRunSubcommand` detach | D4; return |
| 6 | `pipeline <N> --detach` extra positionals | reject | |
| 7 | `pipeline <N> --detach` + `--status` / `--summary` / `--unblock` / `--override` | reject | **do not add** `--cleanup` / `--init` here; current behavior |
| 8 | `pipeline <N> --detach` | `handleRunSubcommand` detach | D4; return |
| 9 | Named commands (`status`, `unblock`, `override`, `cleanup`, `init`, …) | existing dispatch | unchanged |
| 10 | Flag-only `--cleanup` / `--init` on numeric-or-absent | existing dispatch | before numeric parse |
| 11 | `pipeline <N> --summary` | `runSummary` | before gh / kill-switch |
| 12 | `pipeline <N> --status` | `runStatus` | before kill-switch |
| 13 | `pipeline <N> --remove-worktree` | `runRemoveWorktree` | before kill-switch |
| 14 | Kill-switch | exit 0 | flag-form unblock/override currently sit **after** this; keep |
| 15 | `pipeline <N> --unblock` / `--override` | existing | not the supervisor alias |
| 16 | Nested marker `PIPELINE_NESTED_ADVANCE=1` | `runNestedWholeItemAdvance` | D2; never `runSingleIssueCommand` |
| 17 | Remaining mutating numeric | `runSingleIssueCommand` | D1 |

`admitMutatingNumericDrive` is rows 16–17 only. Tests inject `{ runSingleIssue, runNestedWholeItemAdvance }` and never call real network/git/subprocess.

### D8 — Direct `runAdvance` owners in this repo (closed list)

Public lifecycle owners that this change must stop:

- `pipeline.ts` mutating numeric tail (today `await runAdvance(...)` after mode preservation).
- `handleRunSubcommand` non-detach tail (today `await runAdvance(...)`).

Nested executors that must stay `runAdvance` / adapter:

- `realDispatchItem` spawn with `PIPELINE_NESTED_ADVANCE=1` → nested CLI branch.
- `runOverride` in-process resume (`deps.runAdvance`).
- `reenterAdvanceAfterRecoverParked` (`deps.runAdvance`).

A change that only aliases default numeric and leaves `handleRunSubcommand` or detach inner argv on raw `runAdvance` is incomplete.

## Risks / Trade-offs

- **[Risk] Nested spawn of `pipeline <N>` recurses into another supervisor.** → Mitigation: nested marker is checked before the public alias (D7 row 16). Contract test fails if a nested child calls `runSingleIssueCommand` or emits `loop_run_handoff`.
- **[Risk] Hosts still scrape `advance_run_handoff` from `pipeline <N>`.** → Mitigation: documented breaking observability change. Renderer, generated SKILLs, and durable docs switch to loop handoff plus linkage. Drift guards fail if the bypass prose returns.
- **[Risk] `--once` on one-item drive conflicts with loop children omitting `--once`.** → Mitigation: forward `--once` only when `RunLoopEngineInput.childAdvance` is set. Leave multi-item `dispatchItemChildArgs` unchanged.
- **[Risk] `runSingleIssueCommand` flag allowlist is narrower than numeric `allowedFlags: "all"`.** → Mitigation: keep numeric parsing; map known advance fields into `childAdvance`. Do not silently drop parsed child inputs. Do not widen `single.allowedFlags`.
- **[Risk] Detach, override resume, and recover-parked re-entry pick the wrong owner.** → Mitigation: detach inner argv is public numeric (supervisor). Override and recover-parked keep in-process `runAdvance` (nested adapter). Tests cover all three plus hidden `run`.
- **[Risk] Detach pre-allocated `--run-id` is mistaken for the canonical loop identity.** → Mitigation: treat it as nested pin only. Replace launcher follow prose and tests that pin `pipeline logs <preallocated-id>` as the public numeric identity.
- **[Risk] Living specs currently contradict each other (durable one-item vs direct-advance packaging).** → Mitigation: this change modifies the packaging specs. Do not average them.

## Migration Plan

1. Land lifecycle-parity tests that fail on current public numeric `runAdvance` ownership, nested recursion, hidden `run` attached/detached bypass, and host-SKILL bypass prose.
2. Add `runNestedWholeItemAdvance` and the nested-admission branch (D7 row 16). Alias public mutating numeric and `handleRunSubcommand` non-detach to `runSingleIssueCommand`.
3. Thread `OneItemChildAdvanceInputs` through `RunLoopEngineInput` / `realDispatchItem`. Keep multi-item `--once` omission. Forward `--engine-track` on detach.
4. Switch public numeric handoff to the loop handoff. Replace `advance_run_handoff` pins for the public path. Nested `runAdvance` still suppresses it.
5. Update `host-skill.ts`, rebuild generated SKILLs, and align durable follow docs.
6. Keep `npm run ci` green, including `openspec validate --all` and `node scripts/build.mjs --check`. This planning revision claims no suite pass.

Rollback is revert of this change. A partial rollback that aliases numeric drive without the nested-admission guard is not allowed.

## Open Questions

None. Remaining sequencing (#1323 owner completeness, later #1328 consumers) is fail-closed consumption, not an open design choice for this issue.
