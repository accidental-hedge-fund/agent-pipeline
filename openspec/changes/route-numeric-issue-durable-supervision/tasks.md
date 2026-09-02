## 1. Lifecycle-parity tests (red)

- [ ] 1.1 Add a contract test that mutating `pipeline <N>` and `pipeline single <N>` create or attach to the same one-item durable run, and verify it fails while numeric still calls `runAdvance` as the top-level owner
- [ ] 1.2 Add a contract test that nested `pipeline/loop-execution@1` children with `PIPELINE_NESTED_ADVANCE=1` call `runAdvance` and do not call `runSingleIssueCommand`, and verify a fixture that re-enters public numeric aliasing fails
- [ ] 1.3 Add a contract test that public mutating numeric drive emits the canonical loop-run handoff and does not emit top-level `advance_run_handoff`, and verify the current public-numeric handoff pin fails
- [ ] 1.4 Add a host-SKILL contract test that generated prose treats `pipeline <N>` as the durable one-item drive (yields `loop_run_id`, no raw-advance bypass), and verify the current "MUST NOT claim `pipeline <N>` yields `loop_run_id`" assertion is inverted
- [ ] 1.5 Add tests that `--status`, `--summary`, `--unblock`, `--override`, and `--remove-worktree` on a numeric first argument still dispatch before aliasing, and verify they do not start the one-item supervisor

## 2. Nested adapter and public alias

- [ ] 2.1 Add an explicit nested-admission branch that calls `runAdvance` when the nested marker is set, and verify the 1.2 nested-child test passes without creating a second supervisor
- [ ] 2.2 Alias public mutating `pipeline <N>` (after mode preservation) to `runSingleIssueCommand`, and verify the 1.1 numeric/single parity test passes
- [ ] 2.3 Keep hidden `pipeline run <N>` without `--detach` on the same mutating numeric path, and verify it enters the one-item supervisor rather than top-level `runAdvance`
- [ ] 2.4 Keep recover-parked re-entry and override resume on in-process `runAdvance`, and verify those paths do not call `runSingleIssueCommand`

## 3. Child inputs, detach, and mechanical ownership

- [ ] 3.1 Forward numeric compatibility flags (`--once`, `--dry-run`, `--model`, `--run-id`, `--engine-track`) as immutable child inputs on the one-item facade, and verify `pipeline <N> --once` still enters the supervisor and does not select top-level `runAdvance`
- [ ] 3.2 Keep multi-item `dispatchItemChildArgs` omitting `--once`, and verify the existing loop-child `--once` omission test still passes
- [ ] 3.3 Keep `pipeline <N> --detach` and `pipeline run <N> --detach` on the public numeric child (no nested marker), and verify the detached child is the one-item supervisor
- [ ] 3.4 Prove a mechanical-fault fixture through mutating numeric drive stays RecoverySupervisor-owned (`owned: true`; not complete, cancelled, or human-owned), and verify numeric, single, and loop still never merge

## 4. Handoff, packaging, and docs

- [ ] 4.1 Emit `formatLoopRunHandoff` from public numeric drive and publish child advance identity only through typed linkage, and verify the 1.3 handoff test passes
- [ ] 4.2 Replace remaining tests that pin public numeric `advance_run_handoff` or complete numeric observation on child `run_complete` without a loop follow, and verify nested `runAdvance` still suppresses `advance_run_handoff`
- [ ] 4.3 Update `core/scripts/host-skill.ts` follow/notify prose for numeric/single parity, run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` plus the 1.4 SKILL test pass
- [ ] 4.4 Align `docs/concepts.md` and/or `docs/cli.md` so public numeric drive uses loop handoff plus linkage, and verify they no longer present `pipeline <N>` as a direct-advance owner

## 5. Validation and CI

- [ ] 5.1 Run `openspec validate route-numeric-issue-durable-supervision` and `openspec validate --all`, and verify both exit 0
- [ ] 5.2 Run `npm run ci` from the repo root, and verify the full gate passes
- [ ] 5.3 Confirm no public internal-advance verb, second one-item scheduler, grant schema, or merge stage was added, and verify `COMMAND_REGISTRY` still has no such keyword
