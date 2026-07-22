## Why

A fix round whose correct result is a **human decision**, not a code change, has no sanctioned
terminal outcome. Today the harness either invents a no-op commit or makes none — and a
no-commit round that is not covered by the #391 does-not-reproduce carve-out falls through to
`` `<stage>` reported success but produced no new commits `` with `blockerKind: "no-commits"`,
which `blockerKindToInterventionKind` maps to `"test-build-failure"`. The pipeline therefore
records a product/authority impasse as a test/build failure and discards the distinction.

Observed on `comamitc/goal-loop` #7 (2026-07-21): adversarial review established that the
requested cross-engine native `/goal` enforcement cannot be truthfully implemented without a
trusted Claude host status/control interface — an **absent external capability**, i.e. a durable
product decision, not a code edit. fix-2 made no commit and was terminalized as a test/build
failure.

This is distinct from #391 (`fix-round-noop-advance`). That carve-out handles a finding that
**does not reproduce at the reviewed SHA** and correctly advances to the round's next stage. A
missing host capability, absent authority, or a conflicting acceptance criterion is *not* a
non-reproducing finding: it must never advance and must never clear a blocking finding.

## What Changes

- **`core/scripts/prompts/fix.md`**: add one bounded, machine-readable `needs human decision`
  outcome for a no-commit fix round, declared with a single controlled line per affected finding:

      <!-- pipeline-needs-human-decision: <category> <override-key> <finding-fingerprint> {{reviewed_sha}} | <one-line decision request> -->

  with `<category>` drawn from the closed set `product-decision` | `authority` |
  `external-dependency`. The prompt states explicitly that this outcome does **not** resolve or
  suppress the finding and does **not** advance the item.
- **`core/scripts/stages/fix.ts`**: add exported pure functions
  `parseHumanDecisionDeclarations` and `decideHumanDecisionPark`, mirroring the existing
  `parseDoesNotReproduceDeclarations` / `decideDoesNotReproduceAdvance` seam. On the no-commit
  path these are evaluated **before** the #391 does-not-reproduce advance: any valid
  human-decision declaration parks the round, so a mixed round can never advance.
- **`core/scripts/types.ts`**: add `BlockerKind` member `"human-decision-required"` with its own
  `BLOCKER_RECIPES` entry pointing at the existing `--unblock` / `--override` verbs.
- **`core/scripts/intervention.ts`**: map `"human-decision-required"` to the existing
  `HumanInterventionKind` member `"product-judgment-required"` — **not** `"test-build-failure"`.
  No taxonomy member is added, renamed, or removed.
- **`core/scripts/review-policy.ts`**: add `humanDecisionComment(...)`, an attested, durable
  `## Pipeline: Human decision required` comment carrying the category, decision request,
  finding key/fingerprint, reviewed SHA and stage — readable by a human and by the audit trail.
- Regression tests in `core/test/` covering each category, a malformed declaration, a missing
  evidence field, a stale reviewed SHA, an unmatched finding identity, the mixed
  human-decision + does-not-reproduce round, and preservation of the pure #391 path.

Explicitly **not** in scope: any change to the #391 does-not-reproduce path's own behavior;
routing `already-fixed` / `not-reproducible` evidence to the override surface (issue-comment
context — already served by #391); auto-amending an issue's acceptance criteria; any implicit
resumption authority.

## Capabilities

### New Capabilities
- `fix-human-decision-outcome`: a bounded, machine-readable `needs human decision` outcome for a
  no-commit fix round — its declaration grammar, validation rules, fail-closed fallback, park
  routing, blocker/intervention classification, durable evidence comment, and its precedence over
  the #391 does-not-reproduce advance.

### Modified Capabilities
- (none — `fix-round-noop-advance`'s requirements are unchanged; this change adds a
  higher-precedence outcome evaluated before it, and the new capability pins that the
  does-not-reproduce path is preserved unchanged.)

## Impact

- `core/scripts/prompts/fix.md` — new outcome section.
- `core/scripts/stages/fix.ts` — parser, decision function, no-commit-path branch.
- `core/scripts/types.ts` — one new `BlockerKind` + recipe.
- `core/scripts/intervention.ts` — one new `case` in `blockerKindToInterventionKind`.
- `core/scripts/review-policy.ts` — new attested comment renderer.
- `core/test/` — regression suite; `prompt-loader.test.ts` drift guard for the new prompt section.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).
- No change to labels, the state machine's stage set, config schema, or any other stage.

## Acceptance Criteria

- [ ] `core/scripts/prompts/fix.md` documents exactly one `needs human decision` declaration
      line, its three-value closed category set, and the rule that it neither resolves a finding
      nor advances the item; a `prompt-loader.test.ts` drift guard fails if the section is removed.
- [ ] `parseHumanDecisionDeclarations` is an exported pure function that returns `[]` for absent
      or malformed input and never touches network, git, or subprocesses.
- [ ] A declaration is accepted only when **all** hold: category ∈ the closed set; `(key,
      fingerprint)` matches a finding rendered into this round's prompt; reviewed SHA equals the
      current worktree `HEAD`; the decision request is a non-empty single line. Any other
      declaration is ignored.
- [ ] A fix round with no new commit, nothing salvaged, and ≥1 accepted declaration blocks with
      `blockerKind: "human-decision-required"` — never `"no-commits"`, never
      `"test-gate-exhausted"`, and never a successful/advancing outcome.
- [ ] That blocker maps to `HumanInterventionKind` `"product-judgment-required"` in the emitted
      `human_intervention` event, not `"test-build-failure"`.
- [ ] The park posts one durable `## Pipeline: Human decision required` comment per accepted
      declaration, carrying category, decision request, finding key, fingerprint, reviewed SHA and
      stage, attested like the other pipeline-authored comments.
- [ ] The outcome never transitions the item to `review-2`, `pre-merge`, or `ready-to-deploy`, and
      the declared findings remain in the blocking set — no override, disposition, or suppression
      is recorded on their behalf.
- [ ] A round with no accepted declaration retains today's exact fail-closed behavior
      (`blockerKind: "no-commits"`, same reason text).
- [ ] A round mixing ≥1 accepted human-decision declaration with does-not-reproduce declarations
      parks; the #391 advance is not taken.
- [ ] A round with only valid does-not-reproduce declarations still advances exactly as it does
      today (`fix-1` → `review-2`, `fix-2` → `pre-merge`).
- [ ] Resumption remains the existing human-driven `--unblock` / `--override` flow; the
      implementation adds no automatic resume, no acceptance-criteria edit, and no new authority.
- [ ] Regression tests cover: a valid `product-decision` park; each of the three categories;
      a malformed declaration; a missing decision request; a stale reviewed SHA; an unmatched
      `(key, fingerprint)`; the mixed round; and the preserved #391 path. Each bites against the
      pre-change fix stage.
- [ ] `npm run ci` passes (core tests, `build.mjs --check` mirror, install smoke,
      `openspec validate --all`).
