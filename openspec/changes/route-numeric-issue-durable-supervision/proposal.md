## Why

Default `pipeline <N>` still calls `runAdvance` as its top-level lifecycle owner, while only `pipeline single` and `pipeline loop` enter durable recovery. Recovery then depends on invocation syntax. That is a shipped regression against the one-item supervisor already required by `durable-loop-supervisor`.

## What Changes

- Route every mutating `pipeline <N>` invocation as a compatibility alias for the canonical one-item durable supervisor used by `pipeline single <N>`. Invocation syntax does not change lifecycle ownership.
- Keep `runAdvance` as an internal executor only. Child advancement uses an explicit non-public adapter that cannot recursively create another supervisor.
- Emit one canonical loop-run handoff from numeric drive. Publish child advance identity only through the typed `loop_item_advance_linked` event. Do not retain a second top-level `advance_run_handoff` identity for public numeric drive.
- Preserve read-only and mode-selector forms before aliasing (`--status`, `--summary`, `--unblock`, `--override`, `--remove-worktree`, flag-only `--cleanup` / `--init`). `--detach` detaches the same one-item supervisor. Stage-specific compatibility flags (`--once`, `--dry-run`, `--model`, `--run-id`, `--engine-track`) become immutable child inputs, not lifecycle-controller selectors.
- Replace tests that pin direct numeric advancement with lifecycle-parity tests. Generated host skills recommend no bypassing issue path.
- Numeric, single, and loop still never merge.

**BREAKING (observability):** public `pipeline <N>` no longer emits a top-level `advance_run_handoff` as the canonical run identity. Hosts follow the loop handoff and the linkage event, the same as `pipeline single`.

## Capabilities

### New Capabilities

- `numeric-issue-durable-drive`: mutating default numeric invocation is a compatibility alias for the one-item durable supervisor; nested child advancement uses a non-public adapter that cannot recurse into another supervisor.

### Modified Capabilities

- `durable-loop-supervisor`: one-item numeric drive uses the same supervisor as `pipeline single`; nested `pipeline/loop-execution@1` children cannot mint a second supervisor.
- `advance-skill-orchestration`: generated follow contract treats `pipeline <N>` as the durable one-item drive, not a direct-advance bypass.
- `generated-short-host-skill`: generated SKILLs recommend no bypassing issue path and retain `pipeline <N>` as the default drive syntax.
- `monitor-filter-guidance`: numeric drive follows the loop handoff and linked advance stream, not a top-level `advance_run_handoff`.
- `advance-opts-boundary`: public numeric CLI does not call `runAdvance` as the top-level lifecycle owner.
- `pipeline-run-service`: `runAdvance` remains the internal executor importable without the CLI; it is not the public numeric lifecycle owner.
- `command-registry`: mutating numeric and hidden `run` alias share the one-item supervisor lifecycle; read-only and mode-selector forms stay distinct; `--detach` detaches that supervisor.
- `detached-launcher`: `pipeline <N> --detach` and `pipeline run <N> --detach` detach the same one-item supervisor, not a raw `runAdvance` owner.

## Impact

- **Class vs site:** public numeric `runAdvance` ownership is one class of invocation-syntax recovery bypass. The class fix is aliasing every mutating numeric drive onto `runSingleIssueCommand` and keeping `runAdvance` as a non-recursive child executor. A mole that only changes the host SKILL, or only `pipeline run`, is incomplete.
- **Reuse first:** alias public mutating numeric drive to existing `runSingleIssueCommand`. Keep existing `runAdvance`, `pipeline/loop-execution@1`, `dispatchItemChildArgs`, `PIPELINE_NESTED_ADVANCE`, `loop_item_advance_linked`, and `formatLoopRunHandoff`. Do not add a second one-item scheduler, a public supervisor verb, or host-owned retry.
- **CLI:** no new public verb. `pipeline <N>` syntax stays. `pipeline single` stays canonical. Hidden `pipeline run` stays an undocumented alias of the same mutating numeric path.
- **Sequencing:** follows lifecycle projector (#992) as compatibility-label context. Consumes RecoverySupervisor (#1323) as sole lifecycle owner. Does not reimplement issue-stage adapters (#1328), command-form inventory (#1329), train/merge exactness (#1330), ship phases (#1331), liveness (#1332), or the fault matrix (#1333).
- **Tests:** hermetic unit tests inject gh/harness/loop-engine fakes. Lifecycle-parity tests fail when numeric calls `runAdvance` as top-level owner, when a nested child creates a second supervisor, or when host SKILL recommends a bypass. No real network, git, or subprocess in unit tests.
- **Docs / packaging:** update `core/scripts/host-skill.ts`, then run `node scripts/build.mjs`. Align `docs/concepts.md` / `docs/cli.md` follow guidance. This planning change does not edit application code.

## Acceptance Criteria

- [ ] Mutating `pipeline <N>` and `pipeline single <N>` create or attach to the same durable one-item run model (same supervisor, recovery policy, attempt ledger, and terminal event contract).
- [ ] A fixture where mutating `pipeline <N>` calls `runAdvance` as its top-level lifecycle owner fails a contract test.
- [ ] Nested `pipeline/loop-execution@1` child advancement uses an explicit non-public adapter and cannot recursively create another supervisor.
- [ ] Mechanical failure through numeric invocation remains supervisor-owned (`owned: true`; not complete, cancelled, or human-owned solely for that fault).
- [ ] Public numeric drive emits one canonical loop-run handoff. Child advance identity appears only through `loop_item_advance_linked` (or equivalent typed linkage). A second top-level `advance_run_handoff` for that public invocation fails the contract test.
- [ ] Tests that currently pin direct numeric advancement as the public lifecycle are replaced with numeric/single lifecycle-parity tests.
- [ ] Generated host SKILLs retain `pipeline <N>` syntax and do not recommend a raw-advance bypass for issue drive.
- [ ] Read-only and mode-selector forms (`--status`, `--summary`, `--unblock`, `--override`, `--remove-worktree`, flag-only `--cleanup` / `--init`) still dispatch before aliasing.
- [ ] `pipeline <N> --detach` and `pipeline run <N> --detach` detach the same one-item supervisor.
- [ ] Stage-specific compatibility flags remain accepted on numeric drive as immutable child inputs, not as selectors of a different lifecycle owner.
- [ ] Numeric, single, and loop still never merge or deploy.
- [ ] Argument and output compatibility remains where it is consistent with durable ownership.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.
