## 1. Types and manifest dual-form validation

- [ ] 1.1 Extend `core/scripts/evals/types.ts` with named-pair treatment shapes (`NamedPair`, role coordinates, treatment form discriminant), new modes `implementing-paired` and `pipeline-paired`, and additive pair-loop evidence fields on cell detail
- [ ] 1.2 Update `validateManifest` in `manifest.ts` to accept exactly one of Cartesian axes or named-pairs form; reject mixes, empty pairs, duplicate ids, missing roles, unknown role fields, and mode/form mismatches
- [ ] 1.3 Implement named-pair plan expansion (fixtures × pairs × replicates) with `treatment_id = pair.id` and full primary/reviewer coordinates on each cell; leave Cartesian expansion unchanged
- [ ] 1.4 Add unit tests in `evals-manifest.test.ts` for all rejection cases and deterministic pair expansion/plan-only identity preservation

## 2. Pair-loop executor (`implementing-paired`)

- [ ] 2.1 Add a pair-loop orchestration path in `executor.ts` that runs primary implement → collect actual git diff → reviewer review on that diff → policy-partition findings → conditional primary fix → re-review
- [ ] 2.2 Wire production prompt builders/templates for implement, review, and fix; append only the eval no-commit/no-push override on implement/fix
- [ ] 2.3 Reuse production review parsers and review-policy partitioning; record strict/tolerant/unparseable provenance per review step; never treat unparseable as approval
- [ ] 2.4 Apply a single per-cell wall-clock timeout across the whole loop; attribute auth/preflight failures with `failed_role` primary|reviewer
- [ ] 2.5 Persist pair evidence on the cell record (`pair_id`, coordinates, `fix_invoked`, blocking counts before/after, parse provenance, duration)
- [ ] 2.6 Tests with fake harnesses: no-fix path, fix-and-converge path, malformed review output, primary auth failure, reviewer auth failure, timeout spanning the loop

## 3. Pipeline-paired deployable graph

- [ ] 3.1 Implement `pipeline-paired` stage graph: plan → plan-review → conditional plan revision → implement → standard review → fix-1 → adversarial review → fix-2 (no third review)
- [ ] 3.2 Pass live handoffs between stages (plan, plan-review feedback, revised plan, current diff, review-1 context, blocking findings)
- [ ] 3.3 Resolve pipeline.yml slot coupling and reviewer overrides with pair-coordinate overlay (design D6); fail closed on conflicting reviewer declarations
- [ ] 3.4 Label review-2 / pre-fix-2 findings separately from final post-fix-2 worktree state on the cell record
- [ ] 3.5 Tests for graph order, handoff content, skip plan-revision when no blocking plan-review feedback, no fabricated third review, override/slot routing

## 4. Isolation boundary across multi-role invocations

- [ ] 4.1 Keep eval instruction contract and command-deny shim installed for every primary and reviewer invocation in a paired cell
- [ ] 4.2 Restore instruction paths / remove shim only after the last harness invocation (for clean diff/check collection) and on terminal failure/teardown paths
- [ ] 4.3 Extend `evals-boundary-shim.test.ts` / agent-contract tests to assert mid-loop contract presence and post-loop clean evidence collection

## 5. Fixture plugin-mirror allowance, grading, and reporting

- [ ] 5.1 Allow generator-owned `plugin/` paths in fixture `allowed_change_paths` validation; test unlisted plugin paths still out of scope when boundary declared
- [ ] 5.2 Apply deterministic implementation grading to final worktree state of completed paired cells; skip non-completed paired cells
- [ ] 5.3 Extend comparative summary for named-pair experiments with pair identity, fix invocation, blocking before/after, malformed review counts, quality, duration, reliability
- [ ] 5.4 Tests for grading final tree (no-fix and post-fix) and summary pair diagnostics

## 6. No-write guarantees and end-to-end fake integration

- [ ] 6.1 Assert paired modes use eval `gh` surface + process boundary; recording fakes show zero successful production GitHub mutations across a full pair loop
- [ ] 6.2 Integration-style fake tests covering routing, contract gates, isolation, no-write, and evidence semantics without live model/network/git
- [ ] 6.3 Confirm existing Cartesian single-role eval tests remain green without fixture changes

## 7. Mirror, CI, and OpenSpec

- [ ] 7.1 Regenerate `plugin/` with `node scripts/build.mjs` after any `core/` edits; commit mirror with core
- [ ] 7.2 Run `npm run ci` from repo root; fix until green including `openspec validate --all`
- [ ] 7.3 Prove new tests bite (fail without the paired-mode implementation, pass with it) for at least the no-fix, fix-and-converge, malformed-output, and no-write cases
