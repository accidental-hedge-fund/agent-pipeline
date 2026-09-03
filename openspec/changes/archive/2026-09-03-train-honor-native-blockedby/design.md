## Context

See `proposal.md` for why. Current law and code:

- Loop fresh compile already calls `discoverDeclaredDependencies` then `assertDiscoveryCompleteForAdmission` (`core/scripts/loop/work-list-deps.ts`, `compileWorkListRunFresh`). Sources: lexical grammar, native GraphQL `blockedBy`, optional roadmap. Hard-wait admission (#1073) drops closed/merged and off-selector targets into `ignored_deps`.
- Train does not call that path. `runTrain` builds `ordered` and `codeDeps` from `orderIssuesByDeclaredDeps` / `codeDependencyMap`, which re-parse `title + body` via `parseDeclaredDependencyIds` and keep in-list ids only.
- Production `realTrainDeps.listMilestoneIssues` / `getIssue` request `gh --json number,title,body,labels,state`. Native `blockedBy` is never fetched. `isIndependentOfHeld` then walks that lexical-only map. Traversal itself is correct (#1273 tests); ingestion is not.
- `isIndependentOfHeld`, `computeBaseEligibleFrontier`, and `dependency-skipped` remain the right walkers once the graph is complete.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is #1323 continuing while #1322 is held because GitHub-native `blockedBy` never entered the train graph. The class is: train computes order, frontier, and independence from a train-local lexical graph while loop already owns the complete discovery contract. The next identical fault is any native-only or mixed-source dependent of a held item being advanced or merged.
2. **Shared surfaces.** Train consumes `discoverDeclaredDependencies` + `assertDiscoveryCompleteForAdmission` + `WorkListDependencyDiscoverDeps` (production: `workListDiscoverDepsForCompile` / `realWorkListDependencyDiscoverDeps`). Independence still uses `isIndependentOfHeld` on the admitted graph. Not a #1323-only mole and not a train-local `blockedBy` query.
3. **Next identical fault.** Any native, lexical, or roadmap admitted edge is in the same graph. Incomplete native observation refuses a fresh multi-item train before store init. No new mole for "GitHub native dep but empty Depends on line."

## Goals / Non-Goals

**Goals:**

- One admitted discovery graph for train order, dry-run, frontier, merge eligibility, and held-sibling independence.
- Reuse the existing work-list discovery contract as the first holding rung. Do not add a second parser.
- Refuse incomplete enabled sources on fresh multi-item train before run-store init or advance.
- Keep #1273 independent-sibling continuation and #1073 hard-wait admission.
- Keep provenance and ignored-edge dispositions observable.

**Non-Goals:**

- Stopping the whole train when any issue blocks.
- Changing cross-selector admission, Related-prose rules, or the lexical grammar.
- A train-local GraphQL client or extra `gh issue list --json` field for `blockedBy`.
- Moving recovery ownership out of RecoverySupervisor.
- Review, merge-authority, release, or human-boundary changes.
- Compiling a durable loop contract for the entire train work-list (train still uses loop only inside advance waves).

## Decisions

### 1. Reuse `discoverDeclaredDependencies`; do not extend `TrainIssueSnapshot`

**Choice:** After the frozen snapshot list is known, train calls `discoverDeclaredDependencies(issueIds, discoverDeps)` and `assertDiscoveryCompleteForAdmission`. `codeDependencyMap` / order input is the admitted `discovery.items` (`depends_on` per depender), not a re-parse of snapshot text. Production injects `workListDiscoverDepsForCompile(cfg)` (same class as fresh loop compile). Native `blockedBy` stays behind `getBlockedByIssueNumbers`. Roadmap stays behind optional `getRoadmapDeclaredEdges` (enabled empty when loop would enable it).

**Why:** The defect is ingestion, not traversal. The loop path already unions sources, classifies observation status, admits hard waits, and records provenance. A snapshot field for `blockedBy` would be a second query shape and would skip incomplete-source and admission law.

**Alternatives considered:**

- Add `blockedBy` to `TrainIssueSnapshot` and union it in `codeDependencyMap` → second GitHub shape; misses incomplete-source refuse, roadmap, and `ignored_deps`.
- Call `parseDeclaredDependencyIds` plus a train-local GraphQL helper → second parser; diverges from loop.
- Compile a full loop contract for the train list via `compileWorkListRunFresh` → extra ledger/store the train orchestrator does not use; over-scope.

### 2. Injectable `WorkListDependencyDiscoverDeps` on `TrainDeps`

**Choice:** Add `discoverDeps: WorkListDependencyDiscoverDeps` (or an equivalent thin wrapper that returns `DeclaredDependencyDiscoveryResult`) to `TrainDeps`. Unit tests inject fakes. `makeDeps` defaults to a fake that (a) reads lexical text from seeded snapshots, (b) returns fully observed empty `blockedBy` unless a test seeds native edges, (c) maps snapshot `state` into `getIssueOpenState`, (d) omits or returns `[]` for roadmap unless seeded. Existing `Depends on: #N` fixtures keep passing. New fixtures seed native / mixed / incomplete observations.

**Why:** Train tests already inject `TrainDeps` and must not call live GitHub. Defaulting native to observed-empty preserves #1273 lexical coverage while making native-empty an explicit observation, not a missing source.

**Alternatives considered:**

- Optional discover seam that falls back to lexical-only when omitted → reintroduces the bug on any unwired caller.
- Require every existing test to seed native observations → noisy, no extra coverage.

### 3. Refuse incomplete discovery before run-store init; dry-run uses the same gate

**Choice:** Run discovery and `assertDiscoveryCompleteForAdmission` after snapshot resolve and **before** `initTrainRunStore`, advance, merge, or a successful dry-run plan. Fresh multi-item (`issueIds.length >= 2`) refuses. Single-item non-factory matches loop (record observations, do not hard-refuse unless factory-owned / forceRefuse). Dry-run does not create a store; it still fails closed with the same typed error and no `train_plan`.

**Why:** Today's bug is "missing native looks like empty native." #905 already forbids that substitution for multi-item loop admission. Train must not create a run that will later treat unobserved blockers as independent siblings.

**Alternatives considered:**

- Discover after store init, then abort → leaves an empty train run directory for a refused attempt.
- Dry-run skip native reads → dry-run and live disagree on frontier.
- Treat truncated `blockedBy` as empty → the live #1323 class.

### 4. Keep `isIndependentOfHeld` as the walker; change only its graph

**Choice:** Continue to walk `Map<issue, prerequisite[]>` with existing fail-closed / reverse-edge rules. Populate that map from admitted discovery items (in-selector hard waits). Off-selector and closed candidates stay in `ignored_deps` and never enter the map.

**Why:** #1273 already defined independence as no direct or transitive path to a held item. Native and mixed-source edges are additional admitted paths, not a new independence predicate.

### 5. Additive provenance on `train_work_list_resolved`; dry-run logs the same facts

**Choice:** Append existing `edge_provenance`, `observations`, and `ignored_deps` (or an equivalent additive projection) on `train_work_list_resolved`. `schema_version` stays `1`. Dry-run prints the same facts in human/JSON plan output or logs and does not write a run store. Do not add a new event type.

**Why:** The issue requires observability, not a new catalog. Loop already stores these fields on the compile audit. Train currently has nowhere to put them.

**Alternatives considered:**

- New `train_dependency_discovery` event type → extra catalog surface for the same facts.
- Logs only → harder for `--json` supervisors; still acceptable as a fallback if payload size becomes a problem, but the additive event field is the default.

## Risks / Trade-offs

- **[Risk] Existing train tests fail if discovery is required and the default fake is incomplete.** → Mitigation: `makeDeps` supplies a lexical-from-snapshot + observed-empty-native fake so current `Depends on: #N` tests stay green.
- **[Risk] Extra GitHub GraphQL reads on every train (native `blockedBy` per selected issue).** → Mitigation: reuse `realWorkListDependencyDiscoverDeps` caching / pagination; this is the same cost loop already pays for a multi-item compile, not a new client.
- **[Risk] Native-only dependents that previously continued after a hold now skip.** → Mitigation: that is the intended class fix. Independent siblings still run.
- **[Risk] Incomplete native source now refuses a whole multi-item train.** → Mitigation: matches #905 loop law; fail closed rather than invent independence.
- **[Risk] Dual-write of lexical parse if helpers still accept snapshots.** → Mitigation: order/map helpers take admitted items (or a discovery result); snapshot-only helpers become test-only or are deleted if unused.

## Migration Plan

- No on-disk contract migration. Train graphs are resolved per invocation.
- No `schema_version` bump. Additive event / plan fields only.
- Rollback is revert of the train wiring; loop discovery is unchanged.
- Operators who relied on native-only dependents continuing after a hold must declare independence (remove the GitHub native blocker) rather than omit a `Depends on` line.

## Open Questions

None. Incomplete-source refuse, #1073 admission, and reuse of `discoverDeclaredDependencies` are fixed by the issue and existing loop contract.
