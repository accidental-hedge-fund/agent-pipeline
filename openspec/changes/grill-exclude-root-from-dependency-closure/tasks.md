## 1. Walker: exclude root and parse specification-core edges

- [x] 1.1 Add walker tests in `core/test/grill-then-ready.test.ts` that fail on current behavior: root id is absent from `record.ids` and `record.per_id`; `dependency_closure_sha256` is unchanged when the root body gains a Decisions fence, rendered section, or handoff provenance; root edges come from title plus `extractSpecCore(rootBody)` and not from Decisions text. Verify those tests fail before the walker change.
- [x] 1.2 Change `walkDeclaredDependencyClosure` so the root is visited for edge discovery and cycle detection but is omitted from `record.ids` and `record.per_id`, and so root edges are parsed from title plus `extractSpecCore(rootBody)` via existing `parseDeclaredDependencyIds`. Verify the tests in 1.1 pass and that cycle, missing, inaccessible, malformed, depth, and count tests still fail closed.
- [x] 1.3 Keep hashing every reachable declared-dependency title and body. Verify a child title or body change changes `hashDependencyClosure` and that an empty declared-dependency set hashes `{ ids: [], per_id: [], fact_codes: [] }`.

## 2. Snapshot unity at preview, apply, and ready

- [x] 2.1 After the Implementer returns, preview SHALL walk the proposed specification core and sign that `dependency_closure_sha256`. Verify a proposed body that adds, removes, or changes a declared dependency updates the signed closure, and that a walk of the pre-proposal body is not what gets signed.
- [x] 2.2 Extend apply deps with the existing `fetchIssue` seam. Apply SHALL walk the proposal specification core with the same walker before the GitHub body write and SHALL exit non-zero with no write on a closure-hash mismatch or a blocking dependency fact. Verify an injected apply test covers match, mismatch, and missing-dependency refusal.
- [x] 2.3 Ready snapshot SHALL walk the live body through the same walker (root edges from applied specification core). Verify `realGrillReadySnapshot` / injected ready construction no longer treats Decisions metadata as a closure input, and that `fingerprintStaleReasons` still reports `dependency_closure_sha256` when a child issue changes.
- [x] 2.4 Handoff materialize SHALL NOT rewrite `dependency_closure_sha256` from the full body. Verify answering an authority node updates provenance and leaves the signed closure hash unchanged.

## 3. Sequence regression and existing fixtures

- [x] 3.1 Add an injected GitHub and handoff I/O test that replays preview → apply → answer every authority handoff → `pipeline triage N --stage ready`. Verify it succeeds when no bound input and no declared dependency changed, and that it would have failed on the pre-change walker.
- [x] 3.2 Assert in that sequence that adding the Decisions fence or section and updating handoff provenance does not change `dependency_closure_sha256`. Verify the hash is equal across preview sign, post-apply body, and post-handoff body.
- [x] 3.3 Assert a later dependency title or body change still produces `stale fingerprints: dependency_closure_sha256` with exit 2 and no label write. Verify a root title change stales `title_sha256` and a specification-core change stales `applied_body_sha256`.
- [x] 3.4 Update existing fingerprint fixtures that put the root in `per_id` so they use declared dependencies only (or an empty closure). Verify the existing ready, apply, and handoff tests still pass, including fail-closed cycle/missing/inaccessible/malformed/depth/count cases.

## 4. Docs

- [x] 4.1 Update `docs/adr/0002-decisions-live-in-the-issue-body.md` so it states: root identity is title plus applied specification core; dependency closure covers declared dependencies only; Pipeline-owned Decisions metadata is not a bound input. Verify those three claims are searchable and that no new CLI verb and no new per-command markdown file were added.
- [x] 4.2 Leave generated `docs/cli.md` and host SKILL verb tables unchanged unless a core edit forces `node scripts/build.mjs`. Verify `git diff -- docs/cli.md hosts` is empty when no `core/` doc-generator input changed beyond the walker, or that `node scripts/build.mjs --check` passes after a required regen.

## 5. Authenticated recovery of root-inclusive pre-change artifacts

- [x] 5.1 Add an injected test that starts from an applied Decisions body whose recorded `dependency_closure_sha256` is root-inclusive, with settled handoffs and no bound-input change. Verify `pipeline triage --stage ready` exits 2 with `stale fingerprints: dependency_closure_sha256` before the refresh.
- [x] 5.2 `pipeline refine-spec --issue N` SHALL sign a root-exclusive closure without calling Implementer or Reviewer when the live artifact's only stale fingerprint is `dependency_closure_sha256`. Verify the signed envelope preserves node ids and handoff provenance.
- [x] 5.3 Apply of that envelope SHALL persist the refreshed fingerprint and frontier, SHALL NOT create replacement authority handoffs for already-settled nodes, and a following `triage --stage ready` SHALL succeed. Verify ready still compares fingerprints and does not dual-compare formulas.

## 6. Validation

- [x] 6.1 After any `core/` edit run `node scripts/build.mjs` if host SKILL inputs changed, then run `cd core && npm test` focusing on `grill-then-ready.test.ts`. Verify the new regression tests pass.
- [x] 6.2 Run `openspec validate grill-exclude-root-from-dependency-closure` and `npm run ci` from the repo root. Verify both exit 0.
- [x] 6.3 Confirm the change adds no merge stage, no `auto_merge` config key, and no destructive git helper. Verify a search of the diff for `auto_merge`, `git push --force`, and `worktree remove --force` is empty.
