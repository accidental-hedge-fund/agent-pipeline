## Context

`runIntake` (`core/scripts/stages/intake.ts`) today runs in this order:

1. Validate inputs (`description`, `--release` shape).
2. `gitResolveBaseSha` + `readFileAtBase("ROADMAP.md")` (also a preflight).
3. Infer / normalize the release slot.
4. Extract ROADMAP context for the prompt.
5. **`d.runHarness(prompt, …)`** — the run's only model call.
6. Validate the generated spec body.
7. `applyRoadmapMutations(…, 0, …)` — a placeholder-issue dry apply used purely to
   validate that all ROADMAP anchors exist. `insertDetailSectionBullet` throws
   `ROADMAP anchor not found: detail-section-vX.Y.Z` here when the target release has no
   `### vX.Y.Z` section.
8–12. Clean-tree check, branch reserve, labels, `createIssue`, roadmap PR.

So the anchor validation (step 7) sits *after* the model call (step 5). Steps 2–4 are
already deterministic and already precede the harness; the only precondition that fires
late is the ROADMAP-anchor validation baked into `applyRoadmapMutations`. The existing
tests (`intake.test.ts:432`, `:450`) assert only that `createIssue` was not called — they
do not assert the harness was skipped, which is exactly the wasted-cost defect.

## Goals

- A doomed intake costs **zero tokens**: every spec-independent precondition fails before
  `d.runHarness`.
- A generated spec is **never silently discarded** because the target release lacks
  ROADMAP structure.
- No regression to the hard-won intake safety properties: pinned-base-SHA read+fork,
  create-only branch reservation before `createIssue`, `createIssue` as the last
  irreversible action.

## Decision 1 — Split anchors into "global precondition" vs. "target-release scaffold"

Intake's ROADMAP insertions depend on two structurally different anchor classes:

- **Global anchors** — the release-plan `| *(none)* |` sentinel row and the per-issue
  table header (`| # | Impact | Config | Theme | → Release | Depends on |`). These are
  single, always-present structures; their absence means `ROADMAP.md` is fundamentally
  malformed. Treat their absence as a **hard precondition failure that runs before the
  harness** (fail fast, zero tokens).
- **Target-release detail section** — the `### vX.Y.Z` heading. This is legitimately
  absent for API-created milestones and is the actual failure in #539. Treat its absence
  as a **scaffold** case, not an abort.

Rationale: this matches the observed failure exactly (`detail-section-v1.26.0`), and it
keeps a genuinely broken ROADMAP failing fast while making the common API-milestone case
self-healing. The release-plan row and per-issue row are *inserted* against the global
anchors (`insertReleasePlanRow` / `insertPerIssueRow`) and never require a pre-existing
per-version structure, so only the detail-section heading needs scaffolding.

To run the global-anchor check before the harness without duplicating logic, factor a
pure `validateGlobalRoadmapAnchors(roadmapText)` (or reuse the existing insertion helpers
against the base ROADMAP with the placeholder issue number, catching only the
global-anchor errors) and call it in the precondition block. The full
`applyRoadmapMutations` dry-apply can remain post-spec since it also needs `title` /
`oneLiner`, but it SHALL no longer be the *first* place a missing global anchor is caught.

## Decision 2 — Scaffold the detail section into the human-reviewed PR (preferred)

The intake PR is already human-reviewed before merge, so scaffolding the minimal missing
`### vX.Y.Z` detail-section heading into it is safe and is the preferred behavior: the
detail bullet, release-plan row, and per-issue row then all land in one reviewable diff.
Add a small helper beside `insertDetailSectionBullet` that inserts a minimal heading
(e.g. `### vX.Y.Z — <milestone theme or "(intake)">`) in the "Remaining work — detail
(grouped by release)" section when the heading is absent, then let the existing bullet
insertion proceed. The helper SHALL be idempotent (no-op when the heading already exists)
so re-runs and the placeholder dry-apply stay stable.

## Decision 3 — Degrade only as a fallback; never discard

If the detail section cannot be scaffolded (e.g. the detail-section container itself is
absent), intake SHALL still create the issue and print an explicit roadmap-gap report
naming the missing structure and the reconciliation command (`pipeline roadmap --apply` /
`sweep --apply`), rather than discarding the generated spec. This preserves the
"never silently discard" invariant even in the malformed-ROADMAP tail case. Scaffold is
primary; degrade is the safety net.

## Test seam

All new behavior is exercised through the existing `IntakeDeps` fake:

- Precondition-before-harness: a `runHarness` fake that increments a counter; assert the
  counter is `0` when a global anchor is removed from the ROADMAP fixture.
- Scaffold: a ROADMAP fixture whose `### vX.Y.Z` section is removed; assert the mutated
  ROADMAP (captured via the `writeFile` fake) contains the scaffolded heading plus all
  three insertions and that `createIssue` ran.

No real network, git, or subprocess calls — consistent with the intake test suite.

## Out of scope

- Reconciling every existing post-v1.23.0 ROADMAP lane (that is `roadmap --apply` /
  `sweep --apply`'s job).
- Changing the pinned-base-SHA, branch-reservation, or label-create-only invariants.
- Any change to the non-OpenSpec pipeline path or other stages.
