## 1. Lifecycle-parity tests (red)

- [x] 1.1 Add a contract test that mutating `pipeline <N>` and `pipeline single <N>` create or attach to the same one-item durable run, and verify it fails while numeric still calls `runAdvance` as the top-level owner
- [x] 1.2 Add a contract test that nested `pipeline/loop-execution@1` children with `PIPELINE_NESTED_ADVANCE=1` call `runNestedWholeItemAdvance` / `runAdvance` and do not call `runSingleIssueCommand`, and verify a fixture that re-enters public numeric aliasing fails
- [x] 1.3 Add a contract test that public mutating numeric drive emits exactly one `loop_run_handoff` and does not emit top-level `advance_run_handoff`, and verify the current public-numeric handoff pin fails
- [x] 1.4 Add a host-SKILL contract test that generated prose treats `pipeline <N>` as the durable one-item drive (yields `loop_run_id`, no raw-advance bypass), and verify the current "MUST NOT claim `pipeline <N>` yields `loop_run_id`" assertion is inverted
- [x] 1.5 Add tests that `--status`, `--summary`, `--unblock`, `--override`, and `--remove-worktree` on a numeric first argument still dispatch before aliasing, and verify they do not start the one-item supervisor
- [x] 1.6 Add attached parity tests for hidden `pipeline run <N>` (no `--detach`): same supervisor as mutating `pipeline <N>` / `pipeline single <N>`; does not call top-level `runAdvance`
- [x] 1.7 Add negative recursion tests that a nested child cannot emit `loop_run_handoff` or mint a second loop supervisor
- [x] 1.8 Add detach-rejection tests that keep the current conflict lists: `run --detach` rejects `--status`/`--summary`/`--unblock`/`--override`/`--cleanup`/`--init`; numeric `--detach` rejects `--status`/`--summary`/`--unblock`/`--override` and extra positionals; `--remove-worktree --detach` still rejects

## 2. Nested adapter and public alias

- [x] 2.1 Add `runNestedWholeItemAdvance(cfg, issueNumber, opts: AdvanceOpts)` that calls `runAdvance` with `emitAdvanceHandoff: false` and never constructs argv or calls `runSingleIssueCommand`; verify 1.2 passes
- [x] 2.2 Alias public mutating `pipeline <N>` after D7 rows 1–15 to `runSingleIssueCommand` (export `admitMutatingNumericDrive` as rows 16–17), and verify the 1.1 numeric/single parity test passes
- [x] 2.3 Keep hidden `pipeline run <N>` without `--detach` on the same mutating numeric path **and** change `handleRunSubcommand` non-detach from `runAdvance` to `runSingleIssueCommand`; verify 1.6
- [x] 2.4 Keep recover-parked re-entry and override resume on in-process `runAdvance` / the nested adapter, and verify those paths do not call `runSingleIssueCommand`

## 3. Child inputs, detach, and mechanical ownership

- [x] 3.1 Introduce `OneItemChildAdvanceInputs`, store it as `RunLoopEngineInput.childAdvance`, and forward numeric compatibility flags (`--once`, `--dry-run`, `--model`, `--run-id`, `--engine-track`, `--json-events`, `--sha`) as immutable child inputs; verify `pipeline <N> --once` still enters the supervisor and does not select top-level `runAdvance`
- [x] 3.2 Keep multi-item `dispatchItemChildArgs` omitting `--once` when `childAdvance` is absent, and verify the existing loop-child `--once` omission test still passes
- [x] 3.3 Keep `pipeline <N> --detach` and `pipeline run <N> --detach` on the public numeric inner argv (no nested marker, no `pipeline single` rewrite), and verify the detached child is the one-item supervisor; assert spawn passArgs still include compatible child options and `--engine-track` when set
- [x] 3.4 Prove a mechanical-fault fixture through mutating numeric drive stays RecoverySupervisor-owned (`owned: true`; not complete, cancelled, or human-owned), and verify numeric, single, and loop still never merge
- [x] 3.5 When `childAdvance.runId` is set (operator `--run-id` or detach pre-allocation), the nested pin uses that id instead of minting a new `pinAdvanceRunIdentity`

## 4. Handoff, packaging, and docs

- [x] 4.1 Emit `formatLoopRunHandoff` from public numeric drive and publish child advance identity only through typed linkage, and verify the 1.3 handoff test passes
- [x] 4.2 Replace remaining tests that pin public numeric `advance_run_handoff` or complete numeric observation on child `run_complete` without a loop follow, and verify nested `runAdvance` still suppresses `advance_run_handoff`
- [x] 4.3 Update `core/scripts/host-skill.ts` follow/notify prose for numeric/single parity, run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` plus the 1.4 SKILL test pass; four generated SKILLs stay byte-identical
- [x] 4.4 Align `docs/concepts.md` and/or `docs/cli.md` so public numeric drive uses loop handoff plus linkage; they SHALL NOT present `pipeline <N>` as a direct-advance owner, SHALL NOT present `pipeline status <N>` as run-id discovery, and SHALL NOT present top-level `advance_run_handoff` as the canonical numeric identity
- [x] 4.5 Replace detach launcher follow prose/tests that present the pre-allocated advance `--run-id` as the public numeric canonical identity

## 5. Validation and CI

- [x] 5.1 Run `openspec validate route-numeric-issue-durable-supervision` and `openspec validate --all`, and verify both exit 0
- [x] 5.2 Run `npm run ci` from the repo root, and verify the full gate passes
- [x] 5.3 Confirm no public internal-advance verb, second one-item scheduler, grant schema, or merge stage was added, and verify `COMMAND_REGISTRY` still has no such keyword
