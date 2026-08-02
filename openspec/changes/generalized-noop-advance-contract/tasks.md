## 1. Shared contract module

- [ ] 1.1 Add a shared pure decision module under `core/scripts/` (name per design) exporting evaluation inputs/outputs: `advance` | `escalate` | `not-applicable`, evidence payload (stage, HEAD SHA, rationale class, note), and injectable goal-check type
- [ ] 1.2 Implement preconditions: only evaluate goal checks on confirmed clean no-new-commit after salvage (non-empty range and successful salvage → `not-applicable`)
- [ ] 1.3 Implement evidence helper that formats the attested note / structured fields without inventing commits
- [ ] 1.4 Unit-test pure matrix (satisfied → advance, unsatisfied → escalate, not-applicable paths) with injected fakes only — no real network/git/subprocess

## 2. Fix-stage migration (behavior-preserving)

- [ ] 2.1 Route post-harness no-new-commit path through shared evaluation using existing pure helpers as goal checks (`decideExternalCommitAdvance`, `decideDoesNotReproduceAdvance`, and fail-closed remainder)
- [ ] 2.2 Express override-empty pre-harness skip as goal satisfaction under the shared contract (or documented pre-harness phase API) without changing `fix-1`/`fix-2` transitions
- [ ] 2.3 Record attested evidence on shared-path advances; keep existing disposition sentinels where still required (does-not-reproduce SHA anchor)
- [ ] 2.4 Confirm existing fix regression tests still pass; adjust only to assert shared evaluation is used if needed; tests must still bite on regressions

## 3. Pre-merge migration (behavior-preserving)

- [ ] 3.1 Adapter: map `noop-clean` + re-verify result into shared evaluation (`pre-merge-findings-clear` vs escalate) in autofix / SHA-gate call sites without collapsing #628 module boundaries
- [ ] 3.2 Preserve one-attempt bound and durable attempt/noop markers; do not add a second marker scheme
- [ ] 3.3 Preserve category partition (#747): mixed batches still auto-fix allowlisted subset; clean no-commit terminal disposition uses shared evaluation
- [ ] 3.4 Express archive empty-active / coherent archive satisfaction as a thin goal check used by pre-merge archive path so #714 dual-outcome cannot return (#714 regression fixture)
- [ ] 3.5 Keep #698 regression tests green and ensure they fail if clean no-commit hard-blocks without goal/re-verify

## 4. Planning implement / #588

- [ ] 4.1 Implement `implement-deliverable-present` goal check (declared OpenSpec change / accepted planning deliverable at HEAD, clean tree, gates)
- [ ] 4.2 Wire planning implement (shared harness-round consumer) to shared evaluation on clean no-new-commit instead of unconditional `no-commits` block
- [ ] 4.3 Add **fresh process/re-entry** regression: planning commit already has OpenSpec deliverable → implement no new commit → advance without empty commit; test fails if only helper is covered
- [ ] 4.4 Missing deliverable still fails closed with existing no-commits / recovery behavior

## 5. Recovery (#787) first recipe

- [ ] 5.1 Register deterministic first recipe for `no-commits` → `implementation-ci`: call shared evaluation with current stage goal checks
- [ ] 5.2 On advance: attested evidence + redispatch/continue; do **not** charge model-repair budget
- [ ] 5.3 On escalate: next recipe or fail-closed; no recovery-only gate bypass
- [ ] 5.4 Unit tests for recipe ordering and budget non-charge with injected controller/stage seams

## 6. Cross-cutting cleanup and gates

- [ ] 6.1 Remove dead private duplicate decision skeletons only after parity tests pass
- [ ] 6.2 Update any stage diagnostic / recipe text if needed so operators see goal-satisfied vs still-broken distinctly (no review-policy change)
- [ ] 6.3 Regenerate `plugin/` via `node scripts/build.mjs` if `core/` paths are mirrored
- [ ] 6.4 Run `openspec validate generalized-noop-advance-contract` and `npm run ci`; fix until green
- [ ] 6.5 Confirm issue #588 can be closed as subsumed once acceptance criteria are met
