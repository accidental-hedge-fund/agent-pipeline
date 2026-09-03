## 1. Biting regressions (inject I/O; prove fail first)

- [ ] 1.1 Add an injected merge-mode `runTrain` fixture for issues `1322,1323` where native `blockedBy` says 1323 is blocked by 1322, bodies have no lexical `Depends on`, and 1322 returns a contained hold. Assert the test **fails** against current lexical-only `codeDependencyMap` if 1323 is advanced or merged, or if 1323 is not `dependency-skipped`. No live network, git, or subprocess.
- [ ] 1.2 Add an injected merge-mode fixture where A is held, native discovery says B is blocked by A, and C lexically declares `Depends on: #B`. Assert the test **fails** against current code if B or C is advanced or merged while A remains held.
- [ ] 1.3 Add an injected merge-mode fixture where 1322 is held, 1323 is a native dependent of 1322, and 1324 has no admitted path to 1322. Assert the test **fails** if 1324 is not advanced (or not merged when it reaches ready-to-deploy) solely because 1322 is held. Preserves #1273.
- [ ] 1.4 Add an injected fresh multi-item fixture where native `blockedBy` is `unavailable` or `incomplete` for one selected issue. Assert the test **fails** against current code if train creates a run store or invokes an advance wave. Cover both live train and `--dry-run`.
- [ ] 1.5 Add an injected dry-run fixture matching 1.1's native edge (1322 not integrated). Assert the test **fails** against current code if 1323 is `would-advance` / on_frontier instead of `waiting-on-deps`.

## 2. Shared discovery wiring

- [ ] 2.1 Add a `WorkListDependencyDiscoverDeps` (or equivalent discovery-result) seam on `TrainDeps`. Default the train test fake to lexical-from-snapshot plus fully observed empty native `blockedBy` unless a test seeds native/roadmap/incomplete observations, so existing `Depends on: #N` tests stay green. Verify `makeDeps` fixtures from #1273 still pass.
- [ ] 2.2 In `runTrain`, after the frozen snapshot list is known and **before** order, dry-run plan, frontier, `initTrainRunStore`, advance, or merge, call `discoverDeclaredDependencies` and `assertDiscoveryCompleteForAdmission`. Build order and `codeDeps` from admitted `discovery.items`, not from re-parsing snapshot title/body. Verify tasks 1.1–1.5 now pass.
- [ ] 2.3 Wire production `realTrainDeps` to `workListDiscoverDepsForCompile` / `realWorkListDependencyDiscoverDeps` (same class as fresh loop compile). Do not add `blockedBy` to the `gh issue list/view --json` snapshot shape. Verify no new GitHub query helper is introduced under `train.ts`.
- [ ] 2.4 Keep `isIndependentOfHeld` as the graph walker. Verify an injected fixture that hard-wait-ignores an off-selector native blocker (`not_on_selector`) and a closed/merged candidate (`closed`) does **not** skip or deadlock the depender, and that `ignored_deps` records those reasons.

## 3. Observability

- [ ] 3.1 On admitted live trains, append additive provenance and ignored-edge fields on `train_work_list_resolved` (`schema_version` remains `1`). Verify an injected event-store fixture for native-only 1323→1322 records native source attribution, and that an off-selector ignore remains visible. Dry-run logs or prints the same facts and still creates no run store.

## 4. Gate

- [ ] 4.1 After any `core/` edit, run `node scripts/build.mjs` from the repo root so host SKILL freshness matches. Verify `node scripts/build.mjs --check` is clean.
- [ ] 4.2 Run `openspec validate train-honor-native-blockedby` and `npm run ci` from the repo root. Verify both are green. Do not change review, merge authority, release, or the human boundary. Do not add a train-local dependency parser.
