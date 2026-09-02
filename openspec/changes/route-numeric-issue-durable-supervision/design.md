## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `runSingleIssueCommand` in `core/scripts/pipeline.ts` is already the canonical one-item durable supervisor (`runLoopEngine` with a one-item work-list). `pipeline single` is the public verb for that facade.
- Public mutating `pipeline <N>` currently falls through to `runAdvance` after read-only and mode-selector preservation. Hidden `pipeline run <N>` without `--detach` redirects onto that same numeric path. `--detach` spawns that path in a wrapper.
- `runAdvance` in `core/scripts/pipeline-run.ts` is already the whole-item stage executor. Loop children spawn `pipeline <N>` with `PIPELINE_NESTED_ADVANCE=1` via `dispatchItemChildArgs` / `nestedAdvanceChildEnv`. In-process recover-parked re-entry and override resume already call `runAdvance` with `emitAdvanceHandoff: false`.
- `formatLoopRunHandoff` and `loop_item_advance_linked` already publish loop identity and child advance identity. `advance_run_handoff` is the current public-numeric identity (#1049).
- RecoverySupervisor vocabulary in `CONTEXT.md`. Command-form inventory already labels numeric drive as a durable one-item drive. Living `durable-loop-supervisor` already requires one-item drives to use the same supervisor; `advance-skill-orchestration` still pins a direct-advance bypass.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: alias public mutating numeric drive to `runSingleIssueCommand`. Keep `runAdvance` as the nested executor. Do not add a second one-item scheduler.
- Make nested child admission an explicit CLI branch that cannot recurse into another supervisor.
- One canonical loop-run handoff for public numeric drive. Child advance identity only through typed linkage.
- Preserve read-only and mode-selector forms. Detach the same one-item supervisor. Forward remaining advance compatibility flags as immutable child inputs.

**Non-Goals:**

- Merge authority, a merge stage, or `auto_merge`.
- Host-owned retry policy or recovery recipes in generated SKILLs.
- A public `pipeline supervise` / `pipeline internal-advance` verb.
- Reimplementing RecoverySupervisor (#1323), issue-stage adapters (#1328), command-form inventory (#1329), train/merge exactness, ship, liveness, or the fault matrix.
- Changing multi-item `pipeline loop` child policy that omits `--once` so a loop child can reach a contract terminal.

## Decisions

### D1 — Alias public mutating numeric drive to `runSingleIssueCommand`

After the existing read-only and mode-selector returns (`--status`, `--summary`, `--unblock`, `--override`, `--remove-worktree`, flag-only `--cleanup` / `--init`), mutating `pipeline <N>` calls `runSingleIssueCommand` with the resolved issue number. Hidden `pipeline run <N>` without `--detach` stays a redirect onto that numeric path, so it inherits the alias.

`pipeline single` remains the named canonical verb. Numeric syntax is a compatibility alias. Invocation syntax does not select a different owner.

Alternative considered: keep `runAdvance` for numeric and add a thin recovery wrapper. Rejected: that is a second one-item scheduler. The holding rung already exists.

### D2 — Nested admission is an explicit non-public adapter onto `runAdvance`

`runAdvance` stays the internal executor. It is not the public numeric lifecycle owner.

Nested whole-item advancement uses one explicit adapter branch, not a second public admission:

- Spawned `pipeline/loop-execution@1` children keep `dispatchItemChildArgs` (`pipeline <N>` argv) and `PIPELINE_NESTED_ADVANCE=1`.
- The CLI treats that nested marker as a non-public adapter admission and calls `runAdvance` with mapped `AdvanceOpts`. It does not call `runSingleIssueCommand`.
- In-process recover-parked re-entry and override resume keep calling `runAdvance` directly. They do not go through public numeric aliasing.

A contract test fails if a nested child creates or attaches to a second durable supervisor, or if public mutating numeric (no nested marker) calls `runAdvance` as the top-level owner.

Do not add a public internal-advance verb. Do not invent `numeric-supervisor.ts`. The named adapter is the existing executor plus the nested-admission branch.

Alternative considered: change loop children to spawn `pipeline single <N>`. Rejected: that recursively creates another supervisor. Alternative considered: in-process `runAdvance` from the supervisor with no child argv. Rejected as a larger rewrite; the spawn seam and pin/linkage already work.

### D3 — One canonical loop-run handoff; linkage publishes child advance identity

Public mutating `pipeline <N>` emits `formatLoopRunHandoff` (same object as `pipeline single`). Hosts retain `loop_run_id` and follow `pipeline loop logs`. Child advance identity is published only through `loop_item_advance_linked` / start-linkage.

Public numeric drive does not emit top-level `advance_run_handoff`. Nested `runAdvance` continues to suppress that handoff (`PIPELINE_NESTED_ADVANCE` / `emitAdvanceHandoff: false`). Tests that pin public numeric `advance_run_handoff` are replaced with lifecycle-parity tests. Executor unit tests that call `runAdvance` directly may still assert nested suppression.

This is an intentional observability break for hosts that scraped `advance_run_handoff` from `pipeline <N>`.

### D4 — Detach the aliased public path; do not special-case a raw-advance child

`pipeline <N> --detach` and `pipeline run <N> --detach` keep the existing wrapper, lock, sentinel, and repo-resolution contract. The detached child is public mutating numeric argv without the nested marker, so it enters `runSingleIssueCommand` after D1. Do not retarget detach at a raw `runAdvance` owner.

Mode-selector flags remain incompatible with `--detach`.

### D5 — Compatibility flags are immutable child inputs on the one-item facade

Numeric `allowedFlags: "all"` stays so `--once`, `--dry-run`, `--model`, `--run-id`, `--engine-track`, and peers still parse. They do not select raw `runAdvance` as the top-level owner.

Extend `runSingleIssueCommand` / the one-item loop-engine request so those values travel as immutable child inputs into the nested adapter. Multi-item `dispatchItemChildArgs` continues to omit `--once` so a loop child can reach a `pipeline/loop-execution@1` terminal (#512). One-item compatibility is not a license to change that multi-item rule.

`--dry-run` on numeric drive still means no GitHub writes. The supervisor owns the dry-run attempt rather than skipping to an unsupervised executor.

### D6 — Generated SKILL and docs follow the loop contract

Update `core/scripts/host-skill.ts` so default numeric drive is the durable one-item path: retain `loop_run_id`, follow loop logs, follow linked advance after linkage. Reverse tests that currently forbid "`pipeline <N>` yields `loop_run_id`" and that complete numeric observation on child `run_complete` without a loop follow. Run `node scripts/build.mjs` after the renderer change. Align `docs/concepts.md` / `docs/cli.md`.

Generated SKILLs still retain `pipeline <N>` syntax. They must not recommend a raw-advance bypass.

## Risks / Trade-offs

- **[Risk] Nested spawn of `pipeline <N>` recurses into another supervisor.** → Mitigation: nested marker is checked before the public alias. Contract test fails if a nested child calls `runSingleIssueCommand`.
- **[Risk] Hosts still scrape `advance_run_handoff` from `pipeline <N>`.** → Mitigation: documented breaking observability change. Renderer, generated SKILLs, and durable docs switch to loop handoff plus linkage. Drift guards fail if the bypass prose returns.
- **[Risk] `--once` on one-item drive conflicts with loop children omitting `--once`.** → Mitigation: forward `--once` only as a one-item child input. Leave multi-item `dispatchItemChildArgs` unchanged.
- **[Risk] `runSingleIssueCommand` flag allowlist is narrower than numeric `allowedFlags: "all"`.** → Mitigation: keep numeric parsing; map known advance fields into the one-item facade. Do not silently drop parsed child inputs.
- **[Risk] Detach, override resume, and recover-parked re-entry pick the wrong owner.** → Mitigation: detach uses public numeric (supervisor). Override and recover-parked keep in-process `runAdvance` (nested adapter). Tests cover all three.
- **[Risk] Living specs currently contradict each other (durable one-item vs direct-advance packaging).** → Mitigation: this change modifies the packaging specs. Do not average them.

## Migration Plan

1. Land lifecycle-parity tests that fail on current public numeric `runAdvance` ownership, nested recursion, and host-SKILL bypass prose.
2. Add the nested-admission branch, then alias public mutating numeric drive to `runSingleIssueCommand`.
3. Forward one-item compatibility flags as child inputs. Keep multi-item `--once` omission.
4. Switch public numeric handoff to the loop handoff. Replace `advance_run_handoff` pins for the public path.
5. Update `host-skill.ts`, rebuild generated SKILLs, and align durable follow docs.
6. Keep `npm run ci` green, including `openspec validate --all` and `node scripts/build.mjs --check`.

Rollback is revert of this change. A partial rollback that aliases numeric drive without the nested-admission guard is not allowed.

## Open Questions

None. Remaining sequencing (#1323 owner completeness, later #1328 consumers) is fail-closed consumption, not an open design choice for this issue.
