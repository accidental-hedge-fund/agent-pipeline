## 1. Pure declaration parsing

- [x] 1.1 Add a pure helper (e.g. under `core/scripts/loop/` or adjacent) that extracts prerequisite issue ids from title/body text: phrase forms (`depends on|requires|blocked by|needs` + `#N`) and `#N` under `## Dependency` / `## Dependencies` sections.
- [x] 1.2 Ignore self-references and non-canonical ids; return stable deduped string ids.
- [x] 1.3 Unit-test the pure parser for phrase matches, section matches, self-ref ignore, no false edges from unrelated prose outside dependency context, and empty input.

## 2. Discovery seam and union

- [x] 2.1 Define `WorkListDependencyDiscoverDeps` (or equivalent) with injectable reads for issue title/body, native `blockedBy` issue numbers, and optional roadmap declared edges.
- [x] 2.2 Implement `discoverDeclaredDependencies(issueIds, deps)` that unions all sources per depender into `RawContractItem[]` (`{ id, depends_on }`).
- [x] 2.3 On per-issue IO failure for a source, contribute no edges from that source (fail closed toward independent); do not abort the whole discovery unless required for a hard compile invariant later.
- [x] 2.4 Provide a real deps factory used by the loop CLI path (GraphQL/REST as practical); keep it out of unit tests.

## 3. Wire work-list compile

- [x] 3.1 Change the production work-list compile path so it no longer maps every id to `depends_on: []` before `compileContractItems`.
- [x] 3.2 On **fresh** run init (selector → issues → compile), await discovery then `compileContractItems(rawItems)`; keep `workListRunId` based on issue list only (deps do not change run identity).
- [x] 3.3 Keep resume of an existing run on the on-disk contract (no silent re-discover overwrite).
- [x] 3.4 Ensure milestone, label, roadmap-slice, and explicit work-list selectors all reach the same population path (single compile entrypoint).

## 4. Tests

- [x] 4.1 Unit test: in-snapshot declaration → `depends_on` includes prerequisite; not on `external_depends_on`.
- [x] 4.2 Unit test: out-of-snapshot declaration → `external_depends_on`; not on in-snapshot `depends_on`.
- [x] 4.3 Unit test: no declarations → empty lists (independent-by-default); input order does not invent edges.
- [x] 4.4 Unit test: multi-source union (body + native) dedupes and includes both ids.
- [x] 4.5 Unit test: in-snapshot cycle from discovered edges fails validation (existing cycle behavior).
- [x] 4.6 Regression: prove the test bites when population is skipped / empty hardcode restored.
- [x] 4.7 All new tests use injected fakes — zero real network, git, or subprocess.

## 5. Verify and mirror

- [x] 5.1 Run the new/related core test files; fix failures.
- [x] 5.2 If `core/` changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change.
- [x] 5.3 Run `npm run ci` from repo root until green (`ci:core`, `build.mjs --check`, install smoke, `openspec validate --all`).
