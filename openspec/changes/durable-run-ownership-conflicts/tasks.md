## Tasks

## 1. Types & schema
- [ ] 1.1 Add an `ownership?` declaration to `LoopContractItem` (`core/scripts/loop/types.ts`):
      exclusive source-glob surfaces; shared-surface entries keyed by class (schema/state,
      generated artifact, shared config, public API, CI/workflow, package/version); explicit
      `conflicts_with: string[]` edges; and `exceptions` each carrying a `surface`, `justification`,
      and `review_ref`. Document that absent/empty ⇒ unknown ownership.
- [ ] 1.2 Add the typed **normalized surface** shape (`kind`, `pattern`, `class: "exclusive" |
      "shared"`) and the **verdict** shape (`disjoint | conflict` + a structured `reason` union:
      `overlapping_surface` naming the surface, `explicit_edge`, `unknown_ownership`).
- [ ] 1.3 Add a schema validator `validateOwnershipDeclaration(decl)` that accepts a well-formed
      declaration and rejects an unknown surface kind, a malformed glob, or an exception missing its
      justification/review reference; an absent declaration is valid (unknown ownership).

## 2. Normalization (pure)
- [ ] 2.1 Add `normalizeOwnership(decl)` in a new pure module (e.g. `core/scripts/loop/ownership.ts`):
      canonicalize patterns, tag each entry with its conflict class, de-duplicate, and sort by a
      documented total order so re-normalization is byte-identical.

## 3. Pairwise evaluation (pure)
- [ ] 3.1 Add `evaluateConflict(aNorm, bNorm, declA, declB)` returning `{ verdict, reason }`.
      Combine, in order: explicit `conflicts_with` edges (always conflict, never suppressible);
      unknown ownership (missing declaration or uncovered surface ⇒ conflict); shared-surface
      co-ownership (conflict unless a valid reviewed exception names that surface for the pair);
      exclusive source-glob overlap (conflict only when globs overlap). Disjoint only when none fire.
- [ ] 3.2 Implement deterministic glob overlap (exact-path and glob cases) with no I/O; confirm the
      chosen matcher's semantics with a test rather than assuming.
- [ ] 3.3 Ensure the verdict `reason` names exactly one cause and, for `overlapping_surface`, names
      the surface.

## 4. Planning evidence
- [ ] 4.1 Emit a durable planning-evidence record containing each item's normalized surface set and,
      per pair, the verdict + structured reason. Evidence is a record only — it schedules nothing.
      Follow the existing durable-run evidence/record conventions (do not invent a new store).

## 5. Tests (each must bite — fail without the change)
- [ ] 5.1 Schema: accepts a well-formed declaration; rejects unknown kind, malformed glob, and an
      exception missing justification/review ref; absent declaration is valid.
- [ ] 5.2 Normalization determinism: re-normalizing yields an identical set; each entry tagged
      `exclusive`/`shared`; duplicates collapse.
- [ ] 5.3 Exact paths & glob overlap: disjoint exact paths ⇒ `disjoint`; overlapping globs ⇒
      `conflict` naming the surface.
- [ ] 5.4 Shared generated output & package/config/state: same generated artifact / package manifest /
      schema-state store ⇒ `conflict` by default.
- [ ] 5.5 Approved exception: same shared surface + a valid reviewed exception ⇒ `disjoint`; the
      exception does **not** suppress an explicit `conflicts_with` edge.
- [ ] 5.6 Unknown ownership: no declaration ⇒ `conflict`; a surface uncovered by any declaration ⇒
      `conflict`; never `disjoint`.
- [ ] 5.7 Determinism & no-I/O: repeated evaluation is identical and records zero real
      network/git/subprocess calls via the injected seams.
- [ ] 5.8 Evidence: a conflicted pair's planning evidence contains the normalized set and the
      structured reason; a disjoint pair records its verdict and sets.
- [ ] 5.9 Planning-input-only: an exception that flips a pair to `disjoint` leaves review/pre-merge
      gates and the serialized merge barrier unchanged.

## 6. Mirror & gate
- [ ] 6.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 6.2 `npm run ci` green from repo root (`ci:core`, `build.mjs --check`, install-smoke,
      `openspec validate --all`).
