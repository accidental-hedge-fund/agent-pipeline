## Context

`durable-run-dependency-integrity` (#513) defined how the engine **handles** declared
dependencies (`depends_on` / `external_depends_on`, live external verification, `skipped`
propagation, `dependency_deadlock`). Its design explicitly left **population** of those
edges out of scope: production `compileWorkListRun` still maps every resolved issue id to
`depends_on: []` before `compileContractItems`.

That gap is now a scheduling hazard. Selectors (milestone, label, roadmap-slice, explicit
work-list) resolve to an ordered list of issue numbers, then compile a contract that claims
every item is independent. In a live v1.28.1 milestone run, #608's body declares a
dependency on #607 under `## Dependency`, but the contract carried no edge. Ordering held
only because `max_active_items: 1` and the resolved list happened to be ascending.

Existing machinery this change must feed, not reimplement:

- `compileContractItems` (`loop/dependencies.ts`) — partitions in/out of snapshot, topo
  order, cycle refuse.
- External live verification / skip / deadlock — unchanged once `external_depends_on` is set.
- Roadmap textual candidate regex (`findTextualDepCandidates` in `roadmap/depgraph.ts`) —
  proven pattern for `depends on` / `requires` / `blocked by` / `needs` + `#N`.
- GitHub native issue dependencies — GraphQL `Issue.blockedBy` / `blocking` (and REST
  `issue_dependencies_summary` counts). The motivating #608 case has **empty** native
  blockedBy; body text is the only declaration today.

Call site today is synchronous `compileWorkListRun(...)` after async
`resolveSelectorIssues`. Population needs issue bodies (and optionally native edges), so
the compile path must gain an async discovery step with an injected IO seam.

## Goals / Non-Goals

**Goals:**

- Populate each work-list item's raw `depends_on` from **declared** sources before
  `compileContractItems`.
- Preserve independent-by-default when no declaration exists.
- Partition out-of-snapshot ids to `external_depends_on` via existing compilation.
- One population path for all selectors that compile through the work-list compiler.
- Deterministic union of edges; pure parsing testable without network; live reads only
  through injected deps.

**Non-Goals:**

- Inferring edges from shared files, AI source verification, or ranking heuristics.
- Mutating GitHub issue dependency relationships.
- Changing supervisor concurrency defaults or merge policy.
- Replacing goal-loop import's already-declared edges (import continues to carry its own
  contract items as today).
- Making body prose freeform NLP beyond documented lexical conventions.

## Decisions

### Decision 1 — Discover edges, then call existing `compileContractItems` (do not fork the compiler)

**Choice:** Add a discovery step that returns `RawContractItem[]` (`{ id, depends_on }`),
then pass that array to the existing `compileContractItems`. Do **not** reimplement
partition/cycle/topo inside the work-list compiler.

**Why:** Partitioning and cycle detection are already specified and tested under
`durable-loop-engine` / `durable-run-dependency-integrity`. The bug is an empty feed, not
broken handling. Alternatives considered: baking partition into `compileWorkListRun`
(duplication); rewriting contracts after init (too late — order and identity already fixed).

### Decision 2 — Authoritative sources (v1): body/title text + native GitHub blockedBy (+ roadmap edges when present)

**Choice:** Union (dedupe) the following **declared** sources per depender issue id:

| Priority for documentation | Source | Edge meaning |
|----------------------------|--------|--------------|
| A | Lexical body/title conventions | Depender's text names `#N` as a prerequisite |
| B | GitHub native `blockedBy` | Depender is blocked by issue N (GitHub relationship) |
| C | Declared roadmap / slice edge | Roadmap graph already records prerequisite → depender |

**Lexical conventions (A)** — pure, deterministic, no network in the parser:

- Match (case-insensitive) phrases already used by roadmap:
  `(?:depends on|requires|blocked by|needs)\s+#(\d+)`.
- Also scan a dedicated `## Dependency` / `## Dependencies` section (ATX heading) for
  `#(\d+)` references, so freeform sections like #608's body are captured without requiring
  the exact "depends on" phrase on every line.
- Self-references are ignored. Non-canonical ids are ignored at discovery (same spirit as
  external verification's canonical-id gate).

**Native GitHub (B)** — via injected seam (GraphQL `blockedBy` nodes that are Issues):

- For each issue in the resolved list, read `blockedBy` issue numbers in the same repo.
- Empty or unavailable native relationships contribute no edges (fail closed toward
  independent, not toward invented deps).
- Do **not** invert `blocking` into reverse edges unless the blocked issue is also in the
  snapshot **and** is reading its own `blockedBy` (each item only declares what **it**
  depends on).

**Roadmap edges (C)** — only when the compile context has a declared issue-level edge
(e.g. roadmap-slice resolution that already knows `blocked_by` / dependency graph entries
between issue numbers). No AI re-verification at loop compile time.

**Union semantics:** if any source declares depender → prerequisite, the raw item includes
that prerequisite once. Conflicting absence is fine; there is no "negative" declaration.

**Why not native-only?** Motivating production case (#608 → #607) has zero native blockedBy
and only body text. **Why not body-only?** Operators who use GitHub's dependency UI would
still be dropped. **Why not shared-file inference?** Explicitly non-declared; invents
ordering and violates "no fabricated dependencies."

### Decision 3 — Async discovery seam before (or inside) work-list compile; keep partition pure

**Choice:**

```text
resolveSelectorIssues → discoverDeclaredDependencies(ids, deps) → compileContractItems(raw)
```

- `discoverDeclaredDependencies` is async, takes issue id list + injected
  `WorkListDependencyDiscoverDeps` (e.g. `getIssueBodyTitle(n)`, `getBlockedByIssueNumbers(n)`,
  optional `getRoadmapDeclaredEdges()`).
- Pure helpers: `parseDeclaredDependencyIds(text): string[]` (and section-aware variant)
  live next to discovery and are unit-tested without IO.
- `compileWorkListRun` either becomes async or accepts pre-built `RawContractItem[]` /
  calls discovery when a deps argument is provided. Prefer a thin async wrapper used by
  `runLoopCommand` so unit tests can still call a pure compile with explicit raw items.

**Why:** Issue body and GraphQL reads are IO; partition must stay pure and network-free in
unit tests (golden rule for loop tests).

### Decision 4 — Compile-time identity stays issue-list-based; deps do not change run_id

**Choice:** `workListRunId(repo, engine, issues)` continues to hash the **resolved issue
list only**, not the discovered edge set. Discovering edges after a prior empty-deps run
does not mint a new run id for the same selector/list.

**Why:** Run identity is selector/list equivalence today. Changing the hash when operators
add a `## Dependency` section would fork runs silently. Resume of an **existing** run
keeps the contract already on disk (no re-discovery rewrite on resume). Fresh init of a
not-yet-existing run id uses discovery at compile time.

**Implication:** An already-initialized empty-deps contract is not retroactively repaired
by this change. Operators use `--new-run` (existing supersession) if they need a
recompiled contract with edges. Document that in tasks/host notes if needed; no automatic
rewrite of live ledgers.

### Decision 5 — Fail closed on IO errors during discovery

**Choice:** If fetching an issue's body or native dependencies fails for a given id,
treat that id as contributing **no** declarations from the failed source (log/emit a
non-fatal note when an event seam exists), and continue. Do **not** abort the whole run
for a single body fetch failure, and do **not** invent edges from partial parse of empty
bodies.

**Why:** Loop start must not become more fragile than today's independent compile. A hard
fail on every transient GraphQL blip would block milestone runs that currently work. The
cost is a possible missed edge under partial outage — same class of risk as any best-effort
enrichment; operators can re-init with `--new-run` after GitHub recovers. Alternative
(hard-fail compile) considered and rejected for v1.

**Exception:** validation failures **after** edges are known (duplicate ids, in-snapshot
cycles) still refuse compile via existing `LoopError("validation")`.

## Risks / Trade-offs

- **[Risk] Over-matching `#N` inside a `## Dependency` section** (e.g. narrative mentions
  of unrelated issues) → **Mitigation:** section scan is limited to dependency-named
  headings; phrase-based matches elsewhere require explicit dependency verbs; self-refs
  ignored. Tighten patterns in follow-up if false positives appear.
- **[Risk] Under-matching freeform prose** without heading or verb phrase → **Mitigation:**
  documented convention; issue template / operator guidance can standardize
  `Depends on #N` lines. Native blockedBy remains available for UI-declared deps.
- **[Risk] Existing empty-deps contracts not upgraded on resume** → **Mitigation:**
  Decision 4; document `--new-run` for recompile. Avoid silent ledger mutation mid-run.
- **[Risk] Body fetch N+1 for large milestones** → **Mitigation:** batch list API where
  practical (`gh issue list` / GraphQL multi-node); keep seam abstract so implementation
  can batch without changing the capability contract.
- **[Risk] Dual sources disagree** (body says 607, native says 609) → **Mitigation:**
  union both edges (conservative: more gates, never fewer than a single source).

## Migration Plan

1. Land pure parser + discovery + async compile feed behind existing loop CLI paths.
2. Fresh work-list inits gain edges automatically; no config flag required (behavior fix).
3. In-flight runs with empty deps continue until terminal; operators who need edges mid-flight
   supersede with `--new-run` after pull.
4. Rollback: revert the change; contracts with edges remain valid for the integrity
   machinery (empty or non-empty both supported).

## Open Questions

None blocking design. Implementation may choose GraphQL vs REST for body batching without
changing requirements, as long as the discover deps seam stays injectable and unit tests
perform zero real network/git/subprocess.
