## Context

FRG Layer B for release **1.34.0** runs a fixed multi-item pack (`pack_id`
`factory-gate-v1`) and scores scenario `clean-item-throughput` as
≥ **K** (`min_clean_ready_to_deploy`, currently `2`) easy items reaching
`pipeline:ready-to-deploy` without an engine-class block. Issue #959 is
synthetic pack item 1: it exists so the pack has multi-item ready-to-deploy
volume, not to ship product behavior. See `proposal.md` for motivation.

Representative FRG composition (OpenSpec-bearing item, fix→re-review, N≥2
contention, recovery classes) is **not** this item's job. Clean-only packs alone
do not mint release-eligible pass; this item only contributes clean throughput
inside a broader pack. Post-pass FRG auto-close without merge is already
specified and out of implementation scope for this change.

## Goals / Non-Goals

**Goals:**

- Land a **minimal** docs or fixture-only provenance artifact for clean
  composition item 1 / release **1.34.0**.
- Keep the change path trivial enough that the pipeline can reach
  `pipeline:ready-to-deploy` without engine-class friction (OpenSpec valid,
  `npm run ci` green, no scoring code churn).
- Capture pack role + version so operators and later FRG audits can see why
  this PR existed.

**Non-Goals:**

- Changing FRG driver, evidence schema, thresholds, scenario inventory, or
  release preflight.
- Product features, refactors, mirror regeneration (no production `core/scripts/`
  edits expected).
- Filing or implementing sibling clean items (item 2+); this change is only
  item 1.
- Auto-merge, review-rigor demotion, or re-implementing pack auto-close.
- Claiming that this single item alone makes a release-eligible FRG pack.

## Decisions

### D1 — Prefer a one-line runbook/README provenance note; fixture allowed

**Choice:** Prefer a single short line (or bullet) in
`docs/factory-reliability-gate-runbook.md` near pack / `clean-item-throughput`
content, **or** one README line in the FRG / factory-gate section. As an
equivalent alternative when that is cleaner for the implementer, add a small
run-scoped JSON fixture under `core/test/fixtures/frg/` (for example
`core/test/fixtures/frg/v1.34.0/clean-composition-item-1.json`) with
`release_version: "1.34.0"` and a hermetic unit test that pins that value.
Do not create a new top-level docs file unless neither surface has a natural
anchor.

**Rationale:** Issue body allows "trivial docs/fixture change only." The
1.29.1 pack used a docs provenance note; 1.33.0 clean templates used run-scoped
fixtures. Either form satisfies clean throughput without product code. Prefer
docs when the smaller diff; fixture when a unit-test bite is desired without
editing operator runbooks.

**Alternatives considered:**

- New `docs/frg-pack-items.md` — overkill for a synthetic one-liner.
- Code comment in `factory-reliability-gate.ts` — out of scope (no scoring /
  product code) and harder for operators to find.
- Shared non-run-scoped fixture path — collides with other pack runs; avoid.

### D2 — Note/fixture content is provenance only, not a new scenario id

**Choice:** The artifact SHALL name: pack role (`clean composition item 1` /
`clean-item-throughput` contributor), release **1.34.0**, and optionally
`factory-gate-v1`. It SHALL NOT invent a new FRG scenario id or change K.

**Rationale:** Issue scope is throughput composition, not pack redesign.

### D3 — OpenSpec delta is ADDED provenance requirement only

**Choice:** Delta under `factory-reliability-gate` uses **ADDED** requirements
for in-tree provenance of synthetic clean items for release 1.34.0. Do not
**MODIFY** existing FRG scoring requirements.

**Rationale:** Avoids archive-time loss of scoring detail and keeps this pack
item surgically scoped.

### D4 — One OpenSpec change only; no production behavior

**Choice:** Exactly one active change for #959. Implementation touches only
docs/README **or** fixture+test (plus this OpenSpec folder). No
`node scripts/build.mjs` regeneration unless a mirrored production path is
unexpectedly edited (it should not be).

**Rationale:** Synthetic pack items must stay low-friction for clean R2D.

## Risks / Trade-offs

- **[Risk] Docs-only PR still fails docs freshness / generator checks** →
  Mitigation: touch only hand-authored docs or README; do not edit generated
  surfaces without regenerating; run `npm run ci` before claiming done.
- **[Risk] Reviewer expands scope into FRG scoring or representative pack** →
  Mitigation: proposal and tasks explicitly forbid scoring/release code; defer
  out-of-scope findings to follow-up issues.
- **[Risk] Single clean item is insufficient for K≥2 alone** → Mitigation:
  this item is pack composition item **1**; sibling pack item #960 supplies the
  rest of K. Item 1 still must itself reach ready-to-deploy cleanly.
- **[Risk] Misreading this as release-eligible FRG alone** → Mitigation: design
  and proposal state that clean-only packs do not satisfy release-eligible pass;
  this item is throughput volume only.

## Migration Plan

Not applicable — additive docs/fixture note; no rollout or rollback beyond
reverting the note/fixture and OpenSpec archive entry.
