# Design

## Context

The review loop already has two convergence backstops:

1. **Exact-key early park** (`review-loop-recurrence`, #133/#144) — fires when a
   blocking finding's `findingKey` (`sha1(severity|file|line-band)`, title-stable)
   recurs in the immediately-prior round. Parks at `needs-human`.
2. **Round-budget ceiling** (`review-ceiling-demote-and-advance`, #233) — at
   `max_adversarial_rounds`, hard-parks (`park`) or demotes below-high findings and
   advances (`demote_and_advance`).

Both are blind to the **new-key-each-round** churn that dominates real
non-convergence (#186: 6 rounds, 0 key repeats; #214: new key in 6/8 rounds). The
reviewer is converging on a *surface* (same file + same finding category) but each
fix exposes the next adjacent edge, minting a fresh key. This change adds a third
backstop that clusters by surface, not by exact key.

## Key decisions

### 1. Surface key = `(normalized file + category)`, deterministic

`surfaceKey(f) = normalize(f.file) + "|" + (f.category ?? "")`, where `normalize`
lowercases the path (same normalization `findingKey` already uses). The
`ReviewFinding.category` field already exists in `review-schema.ts` (e.g.
`spec-divergence | correctness | security | …`) and is already emitted as a
`` `category: <name>` `` marker per finding — no schema change. A finding with no
`file` cannot anchor a surface and is excluded from surface clustering (it still
flows through the exact-key and ceiling guards).

**Rejected:** semantic/LLM clustering of finding text. Non-deterministic, costs a
model call per round, and `(file, category)` already captures the observed churn
shape. Out of scope per the issue.

### 2. Recoverable prior-round surfaces via a machine-readable marker

The streak computation needs each prior round's blocking `(key, surface)` pairs.
Rather than re-parse the human-readable finding lines (brittle, injection-prone),
emit a companion marker mirroring the existing `pipeline-blocking-keys` marker:

```
<!-- pipeline-blocking-surfaces: <key>~<surface>,<key>~<surface> -->
```

`formatBlockingSurfacesMarker(findings)` and
`extractBlockingSurfacesFromComment(body)` are a single-sourced pure pair. The
extractor reuses the existing marker discipline: a **full-line-anchored** regex,
**last-occurrence-wins** (guards against a reviewer-authored spoof line before the
real footer), and returns a `Map<key, surface>` (or `Set<"key~surface">`). Emitted
for every needs-attention round, including an empty marker for advisory-only rounds
(same rule as `pipeline-blocking-keys`) so a later round can't be seeded falsely.

The marker carries `key` alongside `surface` so the **new-key condition** (below)
is checkable without a second marker.

### 3. Streak + new-key trigger

For the current round, group blocking findings by `surfaceKey`. For each surface
`S` present this round:

- Walk backward through consecutive prior Review-N round comments. A round
  *carries* `S` if its `pipeline-blocking-surfaces` marker contains any pair whose
  surface equals `S`.
- `streak(S) = 1 (current) + count of consecutive immediately-prior rounds carrying S`.
- **New-key condition:** at least one current-round finding in `S` has a
  `findingKey` NOT present in the immediately-prior round's pairs for `S`. (If every
  current `S` finding is an exact repeat, the exact-key early park already owns that
  case — the surface guard defers.)
- The guard **fires for `S`** when `streak(S) >= surface_recurrence_rounds`.

This is pure set/string arithmetic over markers the pipeline itself emits — no
model call, matching the determinism of the exact-key guard.

Worked example (acceptance test a): rounds 1→2→3 each emit a *new* key on
`package.json | robustness`. At round 3, rounds 2 and 1 both carry the surface →
`streak = 3`; round-3 key absent from round 2 → new-key condition holds →
`3 >= 3` → fires. Distinct-surface case (test b): each round's finding is on a
different `(file, category)`, so no surface is carried across consecutive rounds →
every `streak = 1` → never fires.

### 4. Ordering and precedence

The check is inserted in `advanceReview` **after** the exact-key early-park check
(`review.ts:606`) and **before** the round-budget ceiling check (`review.ts:648`).
Exact-key recurrence therefore takes precedence: an exact repeat parks first and
the surface guard never runs on it. `review-loop-recurrence` is unchanged.

### 5. Fired-guard action mirrors `ceiling_action` — rigor-preserving

The guard reuses the existing convergence terminals rather than inventing one, and
**never demotes `high`/`critical`** (mirroring #233's severity floor):

- **`ceiling_action: park` (default):** post the recurrence-style punch-list
  (`reviewCeilingComment(..., "recurrence")`, reused from #133) and transition to
  `needs-human` **early**, without burning the remaining round budget. No silent
  advance — a human owns the residual call. This is the conservative default and is
  strictly rigor-preserving (it surfaces to a human *sooner*, it does not skip
  review).
- **`ceiling_action: demote_and_advance`:** partition the fired cluster's blocking
  findings; `high`/`critical` stay blocking (and will park at the ceiling as
  before), while **below-high** findings are demoted to advisory, recorded as
  audited `pipeline-override` dispositions, captured in the single tracked
  follow-up issue, and the item advances — reusing the #233 demotion primitives
  (`reviewCeilingDemotionComment`, override-sentinel recording, follow-up
  idempotency marker).

Because high/critical findings are never auto-demoted and the default is a
human-gated park, the guard adds convergence speed without reducing review
coverage — consistent with the "rigor over latency" rule.

### 6. Config knob — conservative default

`review_policy.surface_recurrence_rounds: number` (integer ≥ 0). Default `3`:
a single same-surface follow-up (streak 1) and one new-key reappearance (streak 2)
are treated as legitimate convergence; only the **third** consecutive same-surface
round is diminishing returns. `0` disables the guard entirely. Registered in
`RIGOR_GATING_PATHS` because it changes review-convergence behavior. With the
default `max_adversarial_rounds: 3`, the guard's value is most visible when a repo
raises the round cap (the #186/#214 elevated-cap shape), but it still fires the
demotion/early-park on the churning cluster specifically rather than treating all
blocking findings uniformly at the ceiling.

## Risks

- **Premature fire on legitimate iteration.** Mitigated by the conservative default
  (`3` consecutive same-surface rounds) and by never demoting high/critical.
- **Category sparsity.** If reviewers omit `category`, the surface degrades to
  `(file + "")` — still a useful clustering axis (same file, repeated churn) and
  strictly better than exact-key-only. No regression.
- **Marker drift.** The surfaces marker is single-sourced and last-occurrence
  anchored like `pipeline-blocking-keys`; a drift-guard test asserts emit/extract
  round-trip.
