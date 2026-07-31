## Context

FRG Layer B for release **1.29.1** runs a fixed multi-item pack (`pack_id`
`factory-gate-v1`) and scores scenario `clean-item-throughput` as
≥ **K** (`min_clean_ready_to_deploy`, currently `2`) easy items reaching
`pipeline:ready-to-deploy` without an engine-class block. Issue #749 is
synthetic pack item 1: it exists so the pack has multi-item ready-to-deploy
volume, not to ship product behavior.

The living capability `factory-reliability-gate` already defines the pack and
thresholds; this change only adds a documentation provenance requirement so
the synthetic item leaves a durable in-tree breadcrumb.

## Goals / Non-Goals

**Goals:**

- Land a **minimal** docs/comment-only provenance note for clean composition
  item 1 / release 1.29.1.
- Keep the change path trivial enough that the pipeline can reach
  `pipeline:ready-to-deploy` without engine-class friction (OpenSpec valid,
  `npm run ci` green, no scoring code churn).
- Capture pack role + version so operators and later FRG audits can see why
  this PR existed.

**Non-Goals:**

- Changing FRG driver, evidence schema, thresholds, scenario inventory, or
  release preflight.
- Product features, refactors, mirror regeneration (no `core/` edits expected).
- Filing or implementing sibling clean items (item 2+); this change is only
  item 1.
- Auto-merge or review-rigor changes.

## Decisions

### D1 — Provenance location: prefer runbook, allow README one-liner

**Choice:** Prefer a single short line (or bullet) in
`docs/factory-reliability-gate-runbook.md` near the pack / clean-item-throughput
discussion, **or** one README line in the FRG / factory-gate section if that is
the smaller diff. Do not create a new top-level docs file unless neither surface
has a natural anchor.

**Rationale:** The runbook already describes the pack inventory and K; a
one-line "example / pack item provenance" note belongs next to that content.
README is acceptable per issue acceptance criteria when that is cleaner.

**Alternatives considered:**

- New `docs/frg-pack-items.md` — overkill for a synthetic one-liner.
- Code comment in `factory-reliability-gate.ts` — out of scope (no scoring /
  product code) and harder for operators to find.

### D2 — Note content is provenance only, not a new scenario id

**Choice:** The note SHALL name: pack role (`clean composition item 1` /
`clean-item-throughput` contributor), release **1.29.1**, and optionally
`factory-gate-v1`. It SHALL NOT invent a new FRG scenario id or change K.

**Rationale:** Issue scope is throughput composition, not pack redesign.

### D3 — OpenSpec delta is ADDED documentation requirement only

**Choice:** Delta under `factory-reliability-gate` uses **ADDED** requirements
for in-tree provenance of synthetic clean items. Do not **MODIFY** existing
FRG scoring requirements.

**Rationale:** Avoids archive-time loss of scoring detail and keeps this pack
item surgically scoped.

## Risks / Trade-offs

- **[Risk] Docs-only PR still fails docs freshness / generator checks** →
  Mitigation: touch only hand-authored docs or README; do not edit generated
  surfaces without regenerating; run `npm run ci` before claiming done.
- **[Risk] Reviewer expands scope into FRG scoring** → Mitigation: proposal
  and tasks explicitly forbid scoring/release code; defer out-of-scope findings.
- **[Risk] Single clean item is insufficient for K≥2 alone** → Mitigation:
  this item is pack composition item **1**; sibling pack items supply the rest
  of K. Item 1 still must itself reach ready-to-deploy cleanly.

## Migration Plan

Not applicable — additive docs note; no rollout or rollback beyond reverting
the note and OpenSpec archive entry.
