## Why

The durable loop already has full dependency integrity once edges exist on the contract
(`compileContractItems` partitions in-snapshot vs external, cycle-checks, live-verifies
externals, propagates `skipped`, reports `dependency_deadlock`). Production work-list
compilation never feeds that machinery: `compileWorkListRun` hardcodes `depends_on: []`
for every issue after milestone, label, roadmap-slice, or explicit-list resolution. Declared
cross-item prerequisites (e.g. #608's body `## Dependency` on #607) are dropped at compile
time; correct order has held only by luck (`max_active_items: 1` + ascending list order).
Any reordering of the resolved list, or future concurrency greater than one, would start a
dependent before its prerequisite.

## What Changes

- Before compiling a work-list run, the engine SHALL resolve **declared** per-item
  dependencies from authoritative sources and pass them into `compileContractItems` (no
  more hardcoded empty lists for every item).
- In-snapshot declarations become order-constraining `depends_on`; out-of-snapshot
  declarations become `external_depends_on` and are live-verified by existing
  `durable-run-dependency-integrity` behavior.
- Items with no declared dependency remain independent (`depends_on: []` /
  `external_depends_on: []`) — **no fabricated edges**.
- Applies to every selector path that resolves into a work-list before compilation
  (milestone, label, roadmap-slice, and explicit work-list), whenever a source declares
  dependencies for a resolved issue.
- Unit tests prove population, partition, no-fabrication, and that the empty-deps hardcode
  path is gone; regression bites without the fix.

Out of scope:

- Changing how the scheduler/supervisor *handles* already-declared edges (owned by
  `durable-run-dependency-integrity` / `durable-run-independent-scheduler`).
- Inferring dependencies from shared files, AI source-verification, or other non-declared
  signals (roadmap's optional candidate machinery stays roadmap-only).
- Auto-merge, review demotion, or raising default `max_active_items` for milestone runs.
- GitHub issue-dependency *mutation* (write-back of edges to GitHub).

## Acceptance criteria

- [ ] Work-list compilation (after any selector resolves to issue ids) no longer hardcodes
      empty `depends_on` for every item; each item's declared edges are populated before
      `compileContractItems`.
- [ ] When issue A declares a dependency on issue B and both are in the resolved snapshot,
      the compiled contract records B in A's in-snapshot `depends_on` (not only input order).
- [ ] When issue A declares a dependency on issue Z and Z is **not** in the snapshot, the
      compiled contract records Z on A's `external_depends_on` (and not on in-snapshot
      `depends_on`), so existing live external verification holds A until Z is satisfied.
- [ ] When no authoritative source declares a dependency for an item, that item compiles
      with empty `depends_on` and empty `external_depends_on` (independent-by-default).
- [ ] Compilation remains deterministic and cycle-checked: the same declared edge set
      yields the same ordered contract; an in-snapshot cycle still fails validation.
- [ ] Milestone, label, roadmap-slice, and explicit work-list selectors all use the same
      population path (no selector-specific empty hardcode remaining).
- [ ] Unit tests cover declared in-snapshot, external, no-declaration, and multi-source
      consistency with injected fakes (no real network/git/subprocess); the primary
      regression fails if population is skipped.
- [ ] `npm run ci` is green; `plugin/` is regenerated if `core/` changes.

## Capabilities

### New Capabilities

- `work-list-declared-dependency-population`: resolve declared per-issue dependencies from
  authoritative sources at work-list compile time and feed them into
  `compileContractItems`, preserving independent-by-default when nothing is declared and
  partitioning out-of-snapshot ids as external dependencies.

### Modified Capabilities

- `durable-loop-engine`: clarify that production work-list compilation (not only abstract
  "declared dependencies") is responsible for supplying raw declared edges before
  snapshot compilation — so the existing dependency-ordering requirement is actually
  reachable from milestone/label/roadmap-slice/explicit-list selectors.

## Impact

- `core/scripts/pipeline.ts` — `compileWorkListRun` (and any helper it gains) stops mapping
  every id to `depends_on: []`; accepts or resolves declared edges per issue.
- New pure discovery helper (likely under `core/scripts/loop/` or adjacent) plus an IO
  seam for reading issue bodies / native dependency relationships / roadmap edges when
  needed — unit tests inject fakes.
- Possible reuse of textual patterns already used by roadmap depgraph
  (`depends on` / `requires` / `blocked by` / `needs` + `## Dependency` convention), without
  adopting file-sharing or AI verification candidates.
- `core/test/*` — regression coverage for population + partition; existing loop/supervisor
  tests remain valid when contracts still carry empty deps for independent items.
- `plugin/` regenerated via `node scripts/build.mjs` when `core/` changes.
- No change to ledger transition graph, merge barrier, review rigor, or auto-merge policy.
