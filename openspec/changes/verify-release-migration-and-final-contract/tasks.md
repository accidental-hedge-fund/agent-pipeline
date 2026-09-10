## 1. Catalog and generated surfaces

- [ ] 1.1 Update `OPERATION_SURFACE` `release` and `ship` rows so live usage and summaries present direct-release and ship-final-delegation, and verify `docs/cli.md` plus the four generated host SKILLs match after `node scripts/build.mjs` and docs generation.
- [ ] 1.2 Label any remaining `release finish` catalog text as a metadata-PR merge helper or as historical, and verify the generated `release` summary does not describe finish as the live complete-release command.
- [ ] 1.3 Add catalog regressions in the existing command-form, docs-generate, or host-skill tests, and verify they fail if the live `release` or `ship` rows present optional-FRG, finish-as-tag-or-publish-owner, ship-promotion, install, or deployment.

## 2. Ordinary docs and living-spec alignment

- [ ] 2.1 Update ordinary operator docs so the live procedure is direct-release and ship-final-delegation, and verify historical optional-FRG, finish, and ship-promotion sections are labeled historical.
- [ ] 2.2 Confirm living `ship-coordinator` and `release-simplification-contract` deltas match the implemented live tail, and verify `openspec validate verify-release-migration-and-final-contract` still passes after any needed wording fix.
- [ ] 2.3 Write the protected-file alignment report for `CLAUDE.md`, rules, settings, and commands, and verify the report exists, names required alignment or states agreement, and that those protected files are unmodified in the product diff.

## 3. Historical evidence and ownership-safe migration

- [ ] 3.1 Make complete-release and exact-candidate verification ignore old scorer, attestor, and failed-ship files as current-candidate authority, and verify injected-I/O tests reject a historical pass for a different candidate and still proceed when the old scorer is absent.
- [ ] 3.2 Add ownership-safe cleanup and migration for known failed synthetic artifacts on the existing FRG cleanup identity checks, and verify tests using injected I/O or isolated Git fixtures mutate only matching owned identities.
- [ ] 3.3 Add negative migration cases for unrelated issues, unrelated pull requests, and user worktrees, and verify those targets stay unchanged with cleanup debt rather than a broadened mutation.
- [ ] 3.4 Document that simulated cleanup is not operator proof, and verify no test or docs sentence treats a fixture cleanup as completed live operator cleanup.

## 4. Command-interface coverage

- [ ] 4.1 Add a deterministic inventory of every approved command-interface case, and verify the inventory test fails if any named case lacks a covering regression.
- [ ] 4.2 Fill remaining gaps on existing `release-complete`, `exact-candidate-frg`, `ship-adapter`, and Tester suites, and verify coverage includes milestone integration, metadata-first merge, candidate source identity, exact-two partial create and resume, same-host duplicate exclusion, fresh genuine ready-to-deploy, forged and wrong-head rejection, no fixture merge, external-wait versus regression, unchanged and changed Tester candidates, dirty pre-commit CI, stale main, tag and publication idempotency, cleanup debt, and equivalent direct-release and ship-final-delegation without deployment.

## 5. Operator checklist and stability

- [ ] 5.1 Add the committed operator post-merge checklist with exact main `C`, two unmerged ready-to-deploy results, annotated `v1.40.1` at `C`, matching versions and notes plus non-draft publication, and repeated-release idempotency, and verify every item is unchecked.
- [ ] 5.2 Confirm optional observability from #1482, permanent repository models, and review policy remain, and verify the product diff adds no temporary Sol override, synthetic fixture implementation, second scheduler, hand-edited ledger, or diagnostic-evidence deletion.

## 6. Freshness and local gate

- [ ] 6.1 Regenerate host SKILLs with `node scripts/build.mjs` and run docs check-mode, and verify both freshness checks pass.
- [ ] 6.2 Run focused injected-I/O tests for catalog, complete-release, exact-candidate FRG, ship-adapter, and the new inventory, and verify they perform no real network, git, or subprocess calls except isolated Git fixtures used by migration tests.
- [ ] 6.3 Run `openspec validate --all` and `npm run ci` from the repo root, and verify both pass without creating live FRG issues, a tag, a publication, an install, or a promotion.
