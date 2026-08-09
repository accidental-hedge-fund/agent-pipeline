## Why

Closed issue #615 populated declared dependencies for work-list runs, but the shipped
lexical parsers keep only the first `#N` after a dependency phrase. Punctuated multi-
reference forms such as `Depends on: #12, #13` or `Depends on #12 and #13` therefore drop
prerequisites silently. Loop work-list discovery and roadmap textual candidate discovery
also keep separate regular expressions, so a plan can admit edges that execution later
loses. An unavailable discovery source is treated as empty, which widens scheduling
permission instead of stopping admission. Operators and factory controllers need one
complete, auditable dependency graph before a fresh multi-item run starts.

## What Changes

- Introduce **one exported deterministic lexical dependency grammar** owned in a single
  module. Loop work-list discovery and roadmap textual candidate discovery both call it.
  They do not keep private phrase regular expressions or alias tables.
- Complete the grammar so a single declaration preserves **every** referenced prerequisite
  (comma-, `and`-, colon-, and unpunctuated multi-reference forms), plus equivalent
  `requires` / `blocked by` / `needs` phrasing and dedicated dependency sections. Bare
  `#N` outside a declaration or dependency section never becomes a dependency.
- Return stable, normalized, deduplicated prerequisite identifiers from the parser.
  Consumers only convert shape and apply in-snapshot filtering after parse.
- Report each authoritative discovery source as **`observed-empty`**,
  **`observed-with-edges`**, or **`unavailable` / `incomplete`**. An unavailable or
  incomplete source is never represented as observed-empty.
- **Refuse** fresh factory-owned or multi-item run admission with a typed, actionable
  result when an enabled authoritative source is unavailable or incomplete. Do not
  initialize a run contract or ledger in that case.
- Record, on the accepted contract and audit output, the **source of every dependency
  edge** and the **observation identity** used during compilation.
- Keep resume of an existing durable run from rewriting its accepted dependency graph;
  corrected discovery requires a new run or an explicit new contract revision.
- Preserve existing safety rules: ignore self-references, remove duplicates, reject
  cycles, and never invent edges from issue, list, table, or milestone order.
- Add table-driven fixtures shared by loop and roadmap consumers (including a captured
  fixture covering issues #890–#903, with #900's former in-set edge to #899 and external
  edge to #662).
- Regenerate packaged mirrors and keep generated documentation current. `npm run ci`
  must pass.

Out of scope:

- Changing when a correctly discovered dependency is **satisfied** (#901 owns integrated
  completion semantics).
- Performing or authorizing merges.
- Inferring dependencies from model judgment, issue order, file similarity, or milestone
  membership alone.

## Acceptance criteria

- [ ] One exported deterministic parser owns the lexical dependency grammar; loop work-list
      discovery and roadmap textual candidate discovery both call it and do not maintain
      separate phrase regular expressions or aliases.
- [ ] The grammar accepts punctuated and unpunctuated multi-reference forms (for example
      `Depends on: #12, #13` and `Depends on #12 and #13`) plus equivalent `requires`,
      `blocked by`, and `needs` forms, and preserves every referenced prerequisite.
- [ ] References in a dedicated dependency section remain supported; bare issue references
      outside a declaration or dependency section do not become dependencies.
- [ ] The parser returns stable, normalized, deduplicated prerequisite identifiers; each
      consumer performs only its own shape conversion and in-snapshot filtering after parsing.
- [ ] The same table-driven fixtures run through both consumers and produce identical
      lexical edges (punctuation, multiple references, case, self-references, duplicates,
      unrelated prose).
- [ ] A captured fixture for #890 through #903 produces the exact declared graph, including
      #900's former in-set reference to #899 and external reference to #662.
- [ ] Each authoritative discovery source is reported as `observed-empty`,
      `observed-with-edges`, or `unavailable`/`incomplete`; an unavailable source is never
      represented as observed-empty.
- [ ] A fresh factory-owned or multi-item run is refused with a typed, actionable result when
      an enabled authoritative source is unavailable or incomplete; no run contract or ledger
      is initialized.
- [ ] The accepted contract and audit output identify the source of every dependency edge
      and the observation identity used during compilation.
- [ ] Self-references are ignored, duplicates are removed, cycles are rejected, and issue,
      list, table, or milestone order never invents an edge.
- [ ] Milestone, label, roadmap-slice, explicit work-list, and roadmap-analysis selectors
      use the shared grammar for lexical discovery.
- [ ] Resuming an existing durable run does not rewrite its accepted dependency graph;
      corrected discovery requires a new run or an explicit new contract revision.
- [ ] Tests cover punctuation, multiple references, source disagreement, partial or
      truncated responses, total source failure, cycles, and parity between loop and
      roadmap consumers.
- [ ] Generated documentation and packaged mirrors are current; `npm run ci` passes.

## Capabilities

### New Capabilities

- `declared-dependency-grammar`: single exported deterministic lexical dependency grammar
  and shared fixture contract used by every consumer that extracts declared prerequisite
  references from free text (issue title/body, roadmap lines, and equivalent prose).
- `dependency-discovery-source-status`: observation identity for each authoritative
  discovery source (`observed-empty` | `observed-with-edges` | `unavailable`/`incomplete`),
  edge provenance on the accepted contract/audit trail, and fail-visible refusal of fresh
  multi-item / factory-owned run admission when an enabled source is incomplete.

### Modified Capabilities

- `work-list-declared-dependency-population`: require multi-reference-complete parsing via
  the shared grammar; stop treating source load failure as empty/independent for fresh
  multi-item runs; surface source status and edge provenance at compile time while
  preserving resume immutability of an already-accepted graph.
- `backlog-roadmap-engine`: textual dependency candidate discovery MUST call the shared
  grammar instead of a private phrase regular expression, so roadmap candidates and loop
  declared edges agree on the same lexical references.

## Impact

- `core/scripts/loop/work-list-deps.ts` (and any extracted shared grammar module) —
  complete multi-reference parsing; source observation status; fail-visible discovery
  results for fresh multi-item compile paths.
- `core/scripts/roadmap/depgraph.ts` — `findTextualDepCandidates` (and related textual
  candidate paths) stop owning a private `depends on|requires|…` regex; call the shared
  grammar.
- `core/scripts/pipeline.ts` / work-list compile entrypoints — refuse fresh multi-item
  or factory-owned admission when an enabled authoritative source is unavailable or
  incomplete; do not initialize contract/ledger on that path.
- Contract/audit artifacts for accepted runs — record per-edge source and discovery
  observation identity.
- `core/test/work-list-deps.test.ts`, `core/test/roadmap-depgraph.test.ts`, and shared
  table-driven fixtures (including #890–#903 capture) — parity and fail-visible coverage.
- `plugin/` regenerated when `core/` changes; generated docs updated if the generator is
  present.
- No change to merge authority, satisfaction semantics (#901), or inventing dependencies
  from non-declared signals.
