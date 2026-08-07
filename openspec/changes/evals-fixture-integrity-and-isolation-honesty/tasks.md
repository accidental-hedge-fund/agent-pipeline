## 1. Fixture contract: smoke-only mark and corpus labeling

- [ ] 1.1 Add an explicit smoke-only mark to the fixture type and loader in `core/scripts/evals/types.ts` / `fixture.ts` (field name chosen at implementation; validate empty `grader_refs` ⇔ smoke-only consistency; reject graded+smoke).
- [ ] 1.2 Mark every committed empty-`grader_refs` fixture under `core/evals/fixtures/` as smoke-only; leave graded fixtures unmarked/false.
- [ ] 1.3 Unit tests: accept empty+smoke, reject empty without mark, reject non-empty+smoke; prove each test fails without the validation.

## 2. Static fixture integrity preflight (reachability + path tokens)

- [ ] 2.1 Add a preflight module under `core/scripts/evals/` with injectable deps (`catFile` / git object probe, fixture list) that verifies each corpus (and experiment-referenced) `base_commit` is a commit object or runs declared bootstrap.
- [ ] 2.2 Add static path-token sanity for public/hidden check command strings against the repo test-layout policy (`core/test/` vs root `test/`).
- [ ] 2.3 Register the static checks on `pipeline doctor` (model-free) with remediation text naming fixture id and SHA/path.
- [ ] 2.4 Unit tests with fakes: missing object fails naming fixture+SHA; present object passes; no real network; optional real-clone smoke when object exists.

## 3. Deep cell-like preflight and experiment gate

- [ ] 3.1 Implement deep preflight: temporary worktree at pin using the same layout helpers as `runCell`, same bootstrap surface public checks assume, no model invocation.
- [ ] 3.2 Prove public baseline healthy at pin; prove seeded/hidden biting probes fail at pin; fail naming fixture + check/defect id when non-biting or baseline red.
- [ ] 3.3 Validate generator-owned `allowed_change_paths` completeness when public checks require `plugin/` mirror regen.
- [ ] 3.4 Wire deep preflight into experiment start (`run.ts` or equivalent) before treatments; classify failures as infrastructure with preflight-named reasons.
- [ ] 3.5 Unit tests (injected worktree/checks): baseline fail, non-biting seed, missing plugin allowance, unresolvable path — all block treatments and stay out of quality aggregates.

## 4. EvalGhSurface disposition and honest isolation

- [ ] 4.1 Audit all eval call sites for real in-process mutating `gh` use; wire `createEvalGhSurface` where needed, or confirm none exist on the local-CLI path.
- [ ] 4.2 Remove ornamental unused `gh: EvalGhSurface` threading from `realInvokeHarness` / `HarnessInvokeArgs` / `PairedLoopInput` when unused, **or** actually invoke the surface; update callers and types.
- [ ] 4.3 Reword comments in `gh-eval-surface.ts`, `executor.ts`, and tests so local-CLI protection is attributed to PATH boundary + credential strip, not surface injection into the child.
- [ ] 4.4 Update host/operator isolation docs (SKILL.md / eval docs sources) to state cooperative validity fence; absolute-path escape and OS sandbox (#618) out of scope.
- [ ] 4.5 Regression tests: process-boundary denial still recorded; surface unit tests remain for in-process refuse-and-record; no test claims child protection via surface construction alone.

## 5. Corpus repairs for known integrity failures

- [ ] 5.1 Fix or replace fixtures that use wrong test roots, incomplete `allowed_change_paths` (add generator-owned `plugin/` paths where required), or non-biting seeded defects identified by preflight.
- [ ] 5.2 Prefer new fixture ids when replacing graded seeds so historical campaign identity is not silently retargeted; record provenance.
- [ ] 5.3 Re-run static (+ deep as applicable) preflight against the full committed corpus until green.

## 6. Reporting and quality-pool exclusion

- [ ] 6.1 Ensure comparative/grade reporting excludes smoke-only fixtures, preflight failures, and non-`completed` infra classes from quality aggregates (pin with a test that would fail if they are pooled).
- [ ] 6.2 Ensure preflight reason strings are stable and distinguishable in cell/doctor output.

## 7. Mirror, CI gate, and validation

- [ ] 7.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 7.2 Run `cd core && npm test` for affected suites; run `npm run ci` from repo root until green.
- [ ] 7.3 Run `openspec validate evals-fixture-integrity-and-isolation-honesty` (and `openspec validate --all` before ready-to-deploy archive).
