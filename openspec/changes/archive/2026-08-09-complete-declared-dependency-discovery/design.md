## Context

#615 (`work-list-declared-dependency-population`) wired declared edges into work-list
compile. Production still loses prerequisites when a single declaration names more than
one issue:

- Shared phrase regex spirit: `(?:depends on|requires|blocked by|needs)\s+#(\d+)`
- That pattern captures **one** `#N` per match. Forms such as `Depends on: #12, #13` and
  `Depends on #12 and #13` drop later references (and the colon form may miss entirely).
- Loop owns `parseDeclaredDependencyIds` in `core/scripts/loop/work-list-deps.ts`.
  Roadmap owns a private copy in `findTextualDepCandidates`
  (`core/scripts/roadmap/depgraph.ts`). Drift is already possible; multi-ref incompleteness
  is shared.

Separately, discovery IO currently **fail-closes toward independent**:

- `getIssueTitleBody` / `getBlockedByIssueNumbers` returning `null`, throwing, or partial
  GraphQL truncation contributes **no edges** from that source.
- The living #615 requirement documents that as intentional. For a **fresh multi-item or
  factory-owned** run, missing GitHub or issue text is not the same as "this issue has no
  dependencies." Treating incomplete observation as empty **widens** scheduling permission
  and can admit a run whose contract is silently under-constrained.

Stakeholders: operators starting milestone/work-list/roadmap-slice runs; factory
controllers that refuse incomplete packs; roadmap analysis (textual candidates must match
what the loop will later enforce).

## Goals / Non-Goals

**Goals:**

- One exported deterministic lexical grammar for declared dependency text.
- Multi-reference completeness for documented phrase and section forms.
- Loop and roadmap textual consumers share that grammar and share table-driven fixtures.
- Per-source observation status that distinguishes empty, with-edges, and
  unavailable/incomplete.
- Fail-visible refusal of fresh multi-item / factory-owned admission when an **enabled
  authoritative** source is unavailable or incomplete (no contract/ledger init).
- Edge provenance + observation identity on the accepted contract and audit trail.
- Resume leaves an already-accepted graph unchanged.

**Non-Goals:**

- Satisfaction / completion semantics for correctly discovered edges (#901).
- Merge authorization or auto-merge.
- Inferring dependencies from model judgment, issue order, file similarity, or milestone
  membership.
- Freeform NLP beyond the documented lexical grammar.
- Making single-item ad-hoc exploratory advance redesign its entire discovery policy
  (this change targets multi-item / factory-owned freshness; single-item paths must not
  silently invent edges, but need not gain the same hard admission refuse if the product
  still treats one-item runs as non-dependency packs — design decision below).

## Decisions

### Decision 1 — Single pure grammar module; consumers only convert shape

**Choice:** Extract (or re-home) one pure module exporting the lexical API used by both
loop population and roadmap textual candidates, for example:

- `parseDeclaredDependencyIds(text, selfId?) → string[]` — stable, normalized,
  deduplicated prerequisite ids in first-seen order.
- Optional lower-level helpers if needed for roadmap line context (depender first-ref
  already handled by `extractRoadmapDeclaredEdges`).

Roadmap `findTextualDepCandidates` MUST call this parser on each issue's title+body (then
filter to inventory members and drop self-edges). It MUST NOT keep a private phrase regex.

**Why:** The acceptance criteria require one owner and identical lexical edges under
shared fixtures. Alternatives rejected: keep two regexes "in sync by review" (already
failed); have roadmap import loop internals through a deep path without a public pure
export (coupling without a clear API).

**Placement:** Prefer a small pure module under `core/scripts/loop/` (or a neutral
`core/scripts/deps/` if loop→roadmap import direction is awkward). Roadmap may import the
pure grammar; the pure module MUST NOT import roadmap or network code.

### Decision 2 — Lexical grammar: phrase + reference list + dependency sections

**Choice:** Document and implement a deterministic grammar roughly:

1. **Phrase declaration** (case-insensitive):  
   `(depends on|requires|blocked by|needs)` + optional `:` + whitespace +
   **reference-list**.
2. **Reference-list**: one or more `#N` separated by commas, whitespace, and/or the word
   `and` (and equivalent unpunctuated spacing). Every canonical `#N` in the list is kept.
3. **Dependency section**: ATX heading matching `Dependency` / `Dependencies` (any level);
   all `#N` in the section body until the next ATX heading are kept (existing #615
   behavior).
4. **Ignore**: bare `#N` outside phrase or section; self-id when provided; non-canonical
   ids (`0`, leading zeros as non-canonical if current gate says so); duplicates after
   first seen.

Examples that MUST produce multiple prerequisites when present:

- `Depends on: #12, #13`
- `Depends on #12 and #13`
- `blocked by #1, #2 and #3`
- `_(blocked by #607, #608)_` (roadmap writeback style)

**Why not NLP?** Operators need stable, reviewable, fixture-locked behavior. **Why not
only the first `#N`?** That is the production bug (#905). **Why keep section scanning?**
Bodies such as #608 / factory packs use `## Dependency` without repeating the phrase on
every line.

### Decision 3 — Observation status is first-class; unavailable ≠ empty

**Choice:** Each authoritative source observation for a compile carries one of:

| Status | Meaning |
|--------|---------|
| `observed-empty` | Source was successfully observed; it contributed zero edges for that scope |
| `observed-with-edges` | Source was successfully observed; it contributed one or more edges |
| `unavailable` / `incomplete` | Source could not be fully observed (null, throw, truncated page, partial response, missing required field) |

Rules:

- Never coerce `unavailable`/`incomplete` into `observed-empty`.
- Union of **successfully observed** edges remains the edge set used for compilation when
  admission proceeds.
- Source disagreement (A reports edge, B empty) is allowed when both are fully observed;
  the union still applies. Disagreement is auditable; it does not by itself refuse
  admission.

**Authoritative sources (unchanged set from #615):** lexical body/title, GitHub native
`blockedBy`, optional roadmap declared edges when enabled for the compile context.

### Decision 4 — Fail-visible admission for fresh multi-item / factory-owned runs

**Choice:** When compiling a **fresh** run that is multi-item (resolved snapshot size ≥ 2)
or factory-owned (factory reliability / factory controller compile path), if **any enabled
authoritative source** is `unavailable` or `incomplete` for any snapshot item (or for a
list-level source such as roadmap edges when that source is enabled), the compile path
SHALL:

1. Return a **typed, actionable** error/result (name the source, the issue or list scope,
   and the incompleteness class: total failure vs truncation vs null observation).
2. **Not** write a run contract, ledger, or run identity for that attempt.

When every enabled source is fully observed (empty or with edges), compile proceeds as
today: union edges → `compileContractItems` → cycle refuse → init contract.

**Resume:** If a run already exists on disk, ordinary resume does **not** re-discover or
rewrite the accepted dependency graph. Corrected discovery requires a new run or an
explicit new contract revision path (out of band for this change if no revision API exists
yet — do not invent silent rewrite on resume).

**Single-item non-factory paths:** Prefer the same observation reporting for consistency.
Hard refusal of single-item exploratory advance on a flaky `blockedBy` read is optional
product policy; if implemented, keep the typed error. Do **not** silently invent edges.
Default recommended in implementation: apply the same refuse rule whenever dependency
population is enabled for a fresh work-list compile, so one code path stays honest. If
tests show single-item friction, document a narrow exception in tasks only after product
confirmation — do not silently restore fail-closed-independent for multi-item.

**Why change #615 fail-closed-independent?** That disposition optimized for "never invent
edges" but also "never block on missing data." #905 elevates **completeness before
admission** for multi-item packs: missing data is a stop, not independence.

### Decision 5 — Provenance and audit fields on accepted compile

**Choice:** When admission succeeds, the accepted contract and/or compile audit artifact
SHALL identify:

- For each dependency edge (or per prerequisite on an item): contributing source(s)
  (`lexical` | `native-blocked-by` | `roadmap-declared`).
- For each enabled source observation used during compilation: status and a stable
  observation identity (enough to re-open the same compile decision in tests/logs —
  e.g. source name + scope issue id + status; not necessarily a cryptographic hash).

Exact JSON field names are implementation detail; behavior is normative. Prefer additive
fields so older contracts remain readable on resume.

### Decision 6 — Shared fixtures, including #890–#903 capture

**Choice:** One table-driven fixture set:

- Synthetic rows: punctuation, multi-ref, case, self-ref, duplicates, bare prose, section
  forms.
- Captured row set for issues **#890–#903** as they declared at the motivating run,
  including **#900 → #899** (in-set) and **#900 → #662** (external).

Both loop population (lexical path) and roadmap textual candidate extraction run the same
inputs and assert identical lexical prerequisite sets (shape conversion differences only
after parse).

### Decision 7 — Cycles, self-refs, order

**Choice:** Unchanged composition with `durable-loop-engine`:

- Self-refs ignored at parse/discovery.
- Duplicates removed.
- In-snapshot cycles still refuse compile (no contract init).
- List/table/milestone order never invents edges.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Fail-visible admission increases compile failures under flaky `gh` | Typed error + retry guidance; do not paper over with empty deps; existing gh transient retry may apply at the discovery seam before status is finalized |
| Stricter multi-ref grammar might over-capture prose after a phrase | Fixture lock; stop list boundaries at sentence end or next phrase if needed; prefer completeness on explicit lists over clever NLP |
| Roadmap import of loop module creates layering tension | Keep grammar pure and network-free; if layering is wrong, place under a neutral path both may import |
| Provenance fields bloat contract JSON | Additive, compact enums; optional audit sidecar if contract size is a concern — behavior still requires source of every edge |
| #615 living text says fail-closed-independent | This change **modifies** that requirement for fresh multi-item/factory admission; archive must update living specs |
| #901 satisfaction work may touch dependency types | Stay clear of satisfaction semantics; only discovery/admission/provenance |

## Migration Plan

1. Land grammar + shared fixtures first (behavior-preserving for single-ref cases already
   covered by #615 tests).
2. Switch roadmap textual candidates to the shared parser; prove parity fixtures green.
3. Introduce observation status without refuse (or behind the fresh multi-item path).
4. Enable refuse on incomplete sources for fresh multi-item / factory compile; no ledger
   write.
5. Add provenance fields to accepted contract/audit.
6. Regenerate `plugin/`, update docs if generator present, run `npm run ci`.

Rollback: revert the change; older runs resume from on-disk contracts without re-parse.

## Open Questions

1. **Single-item fresh advance:** apply hard refuse on incomplete sources for all work-list
   compiles, or only multi-item/factory? Recommendation: all dependency-populating fresh
   compiles, unless a documented exception is required.
2. **Roadmap analysis CLI** (not a durable run): when textual candidates use the shared
   grammar, should unavailable native/GitHub sources affect roadmap phases? Scope of #905
   is primarily durable multi-item admission; roadmap change is lexical parity. Keep
   roadmap IO failure behavior as today unless a clear factory path depends on it.
3. **Observation identity format** for audit (structured object vs opaque string) — pick
   during implementation; scenarios require only that identity is present and stable for a
   given observation.
