## 1. CLI dispatch and registry

- [ ] 1.1 Add `decompose` to `COMMAND_REGISTRY` with `needsIssueNumber: false`, GitHub/config auth flags, and allowlisted option attributes (`epic`, `description`, `apply`, `release`, `maxChildren`, `maxEffort`, allow-xl override, and peers required by the handler).
- [ ] 1.2 Wire positional dispatch in `pipeline.ts` (and help text) so `pipeline decompose` invokes the handler without an issue-number positional and without stage advance.
- [ ] 1.3 Add Commander options: `--epic <n>`, `--description <text>`, `--apply`, `--release <vX.Y.Z>`, `--max-children <n>`, `--max-effort <S|M|L|XL>`, and the documented XL override flag.
- [ ] 1.4 Reject missing `--epic` with a non-zero usage error before harness invocation.

## 2. Config defaults

- [ ] 2.1 Extend pipeline config schema with optional `decompose.max_children` and `decompose.max_effort` (defaults: 12 and `M`).
- [ ] 2.2 CLI flags override config for a single invocation; document keys in config comments / schema help if the repo pattern requires it.

## 3. Decomposition prompt and plan schema

- [ ] 3.1 Author `core/scripts/prompts/decompose.md` with placeholders for epic title/body, optional description seed, max children, max effort, and WHAT-not-HOW child contract.
- [ ] 3.2 Define a parseable plan schema (stable child `key`, title, sections, effort, `depends_on_keys`) and a pure validator that rejects malformed plans.
- [ ] 3.3 Register the prompt in the existing prompt loader path.

## 4. Pure graph helpers

- [ ] 4.1 Implement pure cycle detection over plan keys; return a named cycle path on failure.
- [ ] 4.2 Implement pure sizing/cardinality checks against max-children and max-effort (including XL refusal without override).
- [ ] 4.3 Implement provenance marker format helpers: render marker for `parent` + `key`; parse markers from issue bodies for idempotency matching.

## 5. `DecomposeDeps` and `runDecompose` handler

- [ ] 5.1 Define `DecomposeDeps` (getIssue, createIssue, ensureLabel, addLabels, listIssues or search-for-children, runHarness, roadmap/git/PR seams, log) and `realDecomposeDeps()`.
- [ ] 5.2 Load epic issue; invoke harness once; validate plan schema, bounds, and cycles before any write.
- [ ] 5.3 Dry-run path: print preview notice, child table (title, summary, AC outline, deps, effort), and exit 0 without GitHub/git mutations.
- [ ] 5.4 Apply path: ensure labels create-only; label parent `pipeline:epic`; match existing children by provenance; create missing children with WHAT-not-HOW bodies, grammar-legal `Depends on` / Dependencies section, parent reference, and triage label (`pipeline:ready` vs `pipeline:backlog` from open questions); map sibling keys to issue numbers after create/match.
- [ ] 5.5 Apply path: open ROADMAP.md PR for children (pin base SHA; no default-branch commit; never merge); isolate checkout mutation via throwaway worktree or existing isolation helper.
- [ ] 5.6 Fail closed on cycle, bound, harness, or epic-missing errors with non-zero exit and no partial creates when validation fails before the create loop; document idempotent resume for mid-loop crashes.

## 6. Parent exclusion in loop selectors

- [ ] 6.1 Exclude issues labeled `pipeline:epic` from `milestone` and `label` results in `resolveSelectorWorkList` (or a pure filter it calls).
- [ ] 6.2 Leave explicit work-list selectors unchanged (epic number remains eligible when named).
- [ ] 6.3 Unit-test exclusion with injected inventory (no network).

## 7. Unit tests

- [ ] 7.1 Dry-run: prints plan; zero createIssue / createPR / label writes.
- [ ] 7.2 Apply happy path: N children created with parent marker, deps, triage labels; parent gets `pipeline:epic`; ROADMAP PR opened once; no merge call.
- [ ] 7.3 Cycle: non-zero exit; no creates.
- [ ] 7.4 Max-children / XL without override: non-zero exit; no creates.
- [ ] 7.5 Idempotency: second apply with same keys creates zero duplicates.
- [ ] 7.6 Parent exclusion: milestone/label resolution drops `pipeline:epic`; explicit work list keeps it.
- [ ] 7.7 Registry/dispatch: `lookupCommand("decompose")` metadata; unsupported flag exit code 2.
- [ ] 7.8 Missing `--epic` / missing epic issue: non-zero usage or not-found errors.

## 8. Documentation

- [ ] 8.1 README: command table row — dry-run default, `--apply`, not intake / not roadmap-order-only / not loop-execute; example invocations.
- [ ] 8.2 Host SKILL (`hosts/claude/SKILL.md` and any Codex/shared skill surface that lists sub-commands): usage + composition with loop/merge-queue.
- [ ] 8.3 Document ready vs backlog label choice and `pipeline:epic` exclusion behavior.

## 9. Mirror and CI

- [ ] 9.1 After any `core/` or host SKILL edit: `node scripts/build.mjs` and commit regenerated `plugin/`.
- [ ] 9.2 `npm run ci` green (core tests, mirror check, openspec validate, docs/scripts gates).
