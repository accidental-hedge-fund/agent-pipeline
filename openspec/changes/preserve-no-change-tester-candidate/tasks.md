## 1. Reproduce the Candidate Mismatch

- [ ] 1.1 Add an injected-I/O regression that drives the test gate through an initial failure, a successful clean no-change fix invocation, the real `enforceTestFixCommitFormat` empty-range behavior, and a passing rerun; verify the test fails against the pre-change mandatory-commit contract.
- [ ] 1.2 Extend the regression through Tester persistence and the actual PR-head/implementation-role rebind boundary; verify the pre-change path either blocks at commit verification or exposes evidence that does not match the observed PR head.

## 2. Preserve No-Change Candidates

- [ ] 2.1 Update the test-fix prompt so material changes still require the prescribed commit and trailers while a verified clean no-change retry forbids an empty commit; verify prompt tests distinguish both instructions.
- [ ] 2.2 Update the existing test-gate attempt flow to recognize unchanged HEAD plus no product dirt as a no-change candidate, re-run the required command, and skip commit/trailer verification only for that path; verify the focused regression passes and a repeated test failure remains within the bounded failure flow.
- [ ] 2.3 Preserve the unchanged candidate in Tester production and PR delivery/rebind integration; verify passed implementation-role evidence names the freshly observed PR head and no unpublished local candidate is attested.

## 3. Retain Candidate-Changing and Fail-Closed Protections

- [ ] 3.1 Add or strengthen focused coverage showing a material test fix still requires a correctly formatted, trailer-bearing commit, build-artifact handling when configured, successful rerun, publication, independent review, and exact PR-head binding; verify the changed-candidate tests fail when any required proof is omitted.
- [ ] 3.2 Run the existing replacement-PR and Tester-rebind negative coverage with added assertions for unrelated heads, stale evidence, and unobservable remote state; verify every case remains fail-closed and the #1543 handoff protections are unchanged.

## 4. Validate the Existing Fake-Issue Templates

- [ ] 4.1 Add deterministic coverage that loads and renders both manifest-owned `clean-docs` and `clean-openspec` templates and verifies their exact pack-run-scoped fixture paths, executable test paths, resolved placeholders, and manifest identity without creating live fixtures.
- [ ] 4.2 Verify rendered OpenSpec paths use one deterministic lowercase kebab-case identifier within the existing length bound for ordinary, punctuated, uppercase, repeated-separator, and long pack-run ids; confirm both template identities remain distinguishable.
- [ ] 4.3 Verify both rendered templates preserve implementer-owned pre-archive tasks separately from controller-owned archive, ready-to-deploy, non-merge cleanup, and later lifecycle observations.

## 5. Generated Artifacts and Repository Gates

- [ ] 5.1 Run `node scripts/build.mjs` after all `core/` edits and verify `node scripts/build.mjs --check` reports fresh generated host artifacts with no `plugin/` tree introduced.
- [ ] 5.2 Run `openspec validate preserve-no-change-tester-candidate` and the focused Node test files; verify all change structure and candidate/template regressions pass.
- [ ] 5.3 Run the full `npm run ci` gate from the repository root and verify it passes without changes to model defaults, independent review policy, protected configuration, or merge/release behavior.
