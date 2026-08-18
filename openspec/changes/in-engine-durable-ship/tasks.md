## 1. Merge-first in train --merge

- [x] 1.1 Add a merge-first prelude to `train --merge`: every work-list item already at `pipeline:ready-to-deploy` with an open mergeable PR is merged and base-contained before any plan or implement mutation.
- [x] 1.2 Fail the train if a non-R2D sibling is planned or implemented while an earlier R2D open mergeable PR remains open. A `merge-first` log line alone SHALL NOT count as compliance.
- [x] 1.3 Keep existing post-advance serial merge wave for items that become R2D during the current wave. Do not add a second merge implementation.
- [x] 1.4 Fixture: R2D #A + MERGEABLE open PR and ready #B → first mutation is merge of #A. The fixture fails if #B is planned or implemented first. Inject deps only.

## 2. Dead-holder interrupt classification

- [x] 2.1 Classify mid-stage kill / crash / SIGTERM / reboot / network drop with a dead holder as a resume-eligible interrupt, not `workflow-engine-defect`.
- [x] 2.2 Do not keep `workflow-engine-defect` as the current class solely because a leftover loop outcome says `harness-failure`.
- [x] 2.3 Keep a live holder on the existing coexistence-wait path.
- [x] 2.4 Unit-test 2.1–2.3 with injected process-liveness / lock / wrapper seams.

## 3. Coexistence takeover of a dead holder

- [x] 3.1 Treat a dead lock, dead PID, or corpse loop/run directory as not live. Take over the same item on the first cycle that observes the dead holder.
- [x] 3.2 Do not record `coexistence_wait` for that corpse. Do not cycle waits into `supervisor_no_progress`.
- [x] 3.3 Fixture: killed implementer + recovered dead lock + reused loop id → takeover of #N, not two or more `coexistence_wait`s, not `supervisor_no_progress`.

## 4. Recovery controller and loop reuse

- [x] 4.1 First recipe for a dead-holder interrupt is resume of the same item (existing implementing-resume / stranded-stage path). Do not claim `restart_workflow_engine` first.
- [x] 4.2 Do not consume the `workflow-engine-defect` class budget for that interrupt. A no-op `unlink_engine_scratch` does not escalate to that class.
- [x] 4.3 Re-invoke of the same ship/milestone must not treat a reused dead loop id as a live holder.
- [x] 4.4 Fixture: 2026-08-16 kill-then-re-ship sequence fails if `restart_workflow_engine` is claimed or the defect budget reaches zero.

## 5. Milestone-only ship CLI and ledger

- [x] 5.1 Accept `pipeline ship --milestone vX.Y.Z` without `--authorization` and without `--for` when the milestone title is a semver. Derive version from that title. Fail closed if the title is not a semver and no explicit version is supplied.
- [x] 5.2 Persist one typed ship ledger keyed by repository, base, and milestone. Resume the same record on a second invoke. Do not require a grant fingerprint.
- [x] 5.3 Compose existing verbs only: `train --merge` → release → wait checks → `release finish` → wait GitHub Release → `engine-promote`. Do not invent a second merge policy.
- [x] 5.4 Second invoke while an earlier R2D PR is open continues the ledger and merge-firsts; it does not implement a newer sibling.
- [x] 5.5 `pipeline ship status --milestone vX.Y.Z` reads that ledger with no mutation.
- [x] 5.6 Advance / single / loop still never invoke ship. Isolation tests still pass.
- [x] 5.7 Leave any parked `--authorization` path unrequired and undocumented as the operator surface.

## 6. Ship fail-closed and leftover-block composition

- [x] 6.1 Ship fails if composed `train --merge` would implement a sibling while an R2D MERGEABLE PR is still open.
- [x] 6.2 Compose #1095 recovered-block law: leftover `loop_item_blocked` / `blocked_theme` plus live R2D without live `blocked` merges; it does not STOP-then-farm.
- [x] 6.3 Fixture: leftover `implementation-ci` + live R2D #A + ready #B → merge A, do not implement B first.

## 7. Host phrase, notify, and doctrine

- [x] 7.1 Map `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z` in Claude, Codex, Grok, Hermes, OpenClaw, omp, and OpenCode skills (detach if the CLI is blocking).
- [x] 7.2 Status/stop read `pipeline ship status` / the Pipeline ledger. Notify on phase, item, and terminal failure from exact child-run identities.
- [x] 7.3 Hermes on non-human failure re-invokes the same `pipeline ship --milestone` argv only. Human-authority status stops the host and says so. No classify, no run-dir janitor, no invented `single`/`loop`.
- [x] 7.4 Update ship runbook, supervisor README, and #1001 / #971 doctrine so they cannot be read as “never in-engine ship.” Tugboat is not the product owner.
- [x] 7.5 Update Tugboat thinness tests so they forbid Tugboat-as-owner, not the product string `pipeline ship --milestone` in skills/docs.
- [x] 7.6 Update golden-rule 4 twins and merge-authority skill copy: `pipeline ship --milestone` is a loop-isolated operator surface and does not require a grant file.

## 8. Mirror and gate

- [x] 8.1 If `core/` changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 8.2 Run `openspec validate in-engine-durable-ship` and `npm run ci` and fix failures until green.
