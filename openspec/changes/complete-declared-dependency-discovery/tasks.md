## 1. Shared lexical grammar

- [ ] 1.1 Extract or re-home one pure exported grammar API (for example `parseDeclaredDependencyIds`) so both loop and roadmap can import it without network/git/subprocess dependencies.
- [ ] 1.2 Complete the phrase grammar for optional colon and multi-reference lists (`#N` separated by commas, whitespace, and/or `and`) while preserving dependency-section scanning and rejecting bare out-of-context `#N`.
- [ ] 1.3 Keep normalization rules: canonical ids only, ignore self-id when provided, dedupe with first-seen order.
- [ ] 1.4 Replace the private roadmap `findTextualDepCandidates` phrase regex with a call to the shared grammar; keep only consumer-side inventory membership and edge orientation after parse.
- [ ] 1.5 Ensure `extractRoadmapDeclaredEdges` continues to use the shared grammar for prerequisites on each line (no second phrase implementation).

## 2. Shared fixtures and grammar tests

- [ ] 2.1 Add table-driven fixtures covering punctuation, multi-reference, case, self-references, duplicates, dependency sections, and unrelated prose.
- [ ] 2.2 Add a captured fixture for issues #890–#903 that expects the exact declared graph, including #900 → #899 (in-set) and #900 → #662 (external).
- [ ] 2.3 Run the same fixtures through the loop lexical path and the roadmap textual candidate path; assert identical lexical prerequisite sets (modulo fixed inventory filtering).
- [ ] 2.4 Prove existing single-reference #615 cases still pass (no regression on simple `Depends on #N`).

## 3. Discovery source status

- [ ] 3.1 Introduce a closed observation status type: `observed-empty` | `observed-with-edges` | `unavailable`/`incomplete`.
- [ ] 3.2 Change discovery seams so null, throw, truncation past safety bound, and partial responses classify as unavailable/incomplete — never as observed-empty.
- [ ] 3.3 Return observation records alongside raw edges from discovery (per source and scope) without inventing edges.
- [ ] 3.4 Unit-test source disagreement (union when both fully observed), partial/truncated responses, and total source failure with injected fakes only.

## 4. Fail-visible fresh multi-item / factory admission

- [ ] 4.1 On fresh multi-item or factory-owned compile, refuse admission with a typed actionable error when any enabled authoritative source is unavailable or incomplete.
- [ ] 4.2 Ensure a refused attempt does not write a run contract, ledger, or run identity.
- [ ] 4.3 When every enabled source is fully observed (empty or with edges), keep existing compile → cycle check → contract init path.
- [ ] 4.4 Confirm resume of an existing durable run does not re-discover or rewrite the accepted dependency graph.
- [ ] 4.5 Add regression tests for refuse-on-incomplete and no-ledger-on-refuse paths.

## 5. Edge provenance and audit identity

- [ ] 5.1 Record contributing source for every accepted dependency edge (lexical / native-blocked-by / roadmap-declared).
- [ ] 5.2 Record observation identity and status for each enabled source scope used during a successful compile on the contract and/or audit output.
- [ ] 5.3 Keep fields additive so older on-disk contracts remain readable on resume.
- [ ] 5.4 Tests assert provenance for multi-source unions and single-source edges.

## 6. Selector coverage and safety invariants

- [ ] 6.1 Verify milestone, label, roadmap-slice, and explicit work-list selectors all use the shared population + grammar path.
- [ ] 6.2 Keep self-ref ignore, dedupe, cycle refuse, and no edges from list/table/milestone order alone.
- [ ] 6.3 Confirm no change to dependency **satisfaction** semantics (owned by #901) and no merge authorization changes.

## 7. Packaging and CI

- [ ] 7.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 7.2 Update generated documentation if the generator is present (`docs:check` / generate-docs path).
- [ ] 7.3 Run `npm run ci` from the repo root and fix failures until green.
