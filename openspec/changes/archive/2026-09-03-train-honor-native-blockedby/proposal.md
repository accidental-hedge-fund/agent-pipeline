## Why

`pipeline train` continues independent siblings after a contained hold (#1273), but it decides independence from a train-local lexical graph. GitHub-native `blockedBy` edges never enter that graph, so a native-only dependent of a held issue is treated as independent and can advance or merge. Live reproduction on 2026-09-03: GitHub reports #1323 blocked by #1322 and #993; train parses no in-list lexical edge; with #1322 held, `isIndependentOfHeld(1323, {1322}, trainGraph)` returns `true`. The durable loop already unions lexical, native `blockedBy`, and optional roadmap edges. Train must use that same discovery contract.

## What Changes

- Train SHALL resolve **one** authoritative dependency graph for the frozen selected work-list **before** ordering, dry-run planning, frontier computation, merge eligibility, or independent-sibling continuation.
- That graph SHALL be the shared work-list discovery result (`discoverDeclaredDependencies` / `assertDiscoveryCompleteForAdmission`): lexical body/title, GitHub-native `blockedBy`, and enabled roadmap-declared edges, after #1073 hard-wait admission.
- Train SHALL NOT keep a second lexical-only parser or a train-local GitHub query shape for declared dependencies.
- A fresh multi-item train SHALL refuse before creating its run store or advancing work when an enabled authoritative source is `unavailable` or `incomplete`.
- A direct or transitive dependent through native or mixed-source admitted edges SHALL be `dependency-skipped` and SHALL NOT advance or merge while the ancestor remains held. A genuinely independent sibling still advances and may merge (#1273).
- Dry-run and live train SHALL use the same resolved graph and SHALL produce consistent frontier / wait / held classifications.
- Dependency provenance and ignored-edge dispositions SHALL remain observable (logs and/or additive train events). They SHALL NOT be silently discarded.
- **BREAKING:** none for trains whose selected issues already declare every native edge as lexical `Depends on: #N`. A native-only dependent that previously continued after a hold will now be `dependency-skipped`. A fresh multi-item train whose native (or other enabled) source is incomplete will now refuse instead of treating that source as empty.

## Acceptance criteria

- [ ] Train consumes the shared dependency-discovery result, including lexical, GitHub-native `blockedBy`, and enabled roadmap-declared edges.
- [ ] A fresh multi-item train refuses before creating its run store or advancing work when an enabled authoritative dependency source is unavailable or incomplete.
- [ ] A direct native dependent of a held issue is reported `dependency-skipped` and is never advanced or merged.
- [ ] A transitive dependent through native and mixed-source edges is reported `dependency-skipped` and is never advanced or merged.
- [ ] A genuinely independent sibling still advances and may merge, preserving #1273.
- [ ] Dry-run and live train use the same resolved graph and produce consistent frontier/wait classifications.
- [ ] Existing #1073 hard-wait admission semantics remain intact: closed/merged and out-of-selector references do not recreate milestone deadlocks.
- [ ] Dependency provenance and ignored-edge dispositions remain observable rather than silently discarded.
- [ ] No review, merge-authority, release, or human-boundary behavior changes.
- [ ] Regression tests inject dependency I/O; no live GitHub calls occur in unit tests.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.

## Capabilities

### New Capabilities

- None. This is shared train-controller consumption of the existing work-list discovery contract.

### Modified Capabilities

- `integrated-train-mode`: Train independence, order, frontier, and skip decisions consume the shared discovery graph (lexical + native `blockedBy` + enabled roadmap), not a train-local lexical parse. Fresh multi-item trains refuse incomplete discovery before run-store init or advance.
- `train-dry-run`: Dry-run uses the same resolved graph and incomplete-source refuse as live train. Native and mixed-source waits classify as `waiting-on-deps` / not frontier-eligible the same way live train would.
- `work-list-declared-dependency-population`: Train is a consumer of the same population path as loop work-list compile. Train SHALL NOT retain a private lexical-only graph for ordering or independence.
- `dependency-discovery-source-status`: Fresh multi-item train admission is a refuse site for `unavailable` / `incomplete` enabled sources. Incomplete native `blockedBy` SHALL NOT be treated as observed-empty for train.
- `train-event-stream`: Live train records discovery provenance and ignored-edge dispositions on the work-list-resolved observation rather than dropping them.

## Impact

- Train orchestrator: `core/scripts/stages/train.ts` (`orderIssuesByDeclaredDeps`, `codeDependencyMap`, `runTrain` graph construction, `realTrainDeps` issue snapshot fetch that currently requests only `number,title,body,labels,state`).
- Shared discovery: reuse `discoverDeclaredDependencies`, `assertDiscoveryCompleteForAdmission`, and `WorkListDependencyDiscoverDeps` from `core/scripts/loop/work-list-deps.ts`. Production train wires `realWorkListDependencyDiscoverDeps`. Tests inject fakes.
- TrainDeps: add an injectable discovery seam. Do not stuff native edges into `TrainIssueSnapshot` as a second query shape.
- JSON / events: additive provenance / ignored-dep fields on existing `train_work_list_resolved` (and optional dry-run plan fields). `schema_version` stays `1`.
- Tests: `core/test/train.test.ts` currently proves textual `Depends on: #N` independence and misses native ingestion. Add injected native / mixed-source / incomplete-source fixtures that fail against today's lexical-only map.
- Does not: stop the whole train when any issue blocks; treat list order or Related prose as dependencies; change cross-selector admission (#1073); add a new parser; move recovery out of RecoverySupervisor; change review, merge authority, release, or the human boundary.
