## Context

The pipeline already binds review verdicts to commit SHA (`review-sha-gating`),
classifies pipeline-internal vs developer/fix commits (`pipeline-commits`),
caches verdicts by diff hash (`pre-merge-delta-recheck`), pins Tester suite
results to a candidate SHA (`tester-evidence` / #646), and fails closed on a
narrow README landing-page breach after merge-queue repair
(`merge-queue-repair-hold` + `docs-landing-split` / #855). Scoreboard
observability for candidate-integrity events already exists (#763 consumer:
`candidate_integrity` event type, mutation method, classification fields).

What is missing is a **single control-plane protocol** that:

1. Snapshots the approved **candidate change surface** (not only a SHA) before
   any pipeline-owned head-moving mutation.
2. Compares the post-mutation surface to that snapshot with deterministic
   path/content evidence plus declared repair scope.
3. Classifies the transition and **forces** review/readiness invalidation on
   expansion or unverified comparison — without trusting the harness to notice.

Incident shape (#793): a restack/conflict repair appended ~1,845 lines of the
retired README monolith. Operational signals looked fine; the accepted landing
page contract was lost. A weaker or differently configured model may expose this
more often, but the defect is provider-neutral.

Constraints that do not move:

- No autonomous merge; stop at `pipeline:ready-to-deploy`.
- Rigor over latency — do not demote review to “fix size looks small.”
- Single-host locks remain host-local; this protocol is evidence- and gate-
  local, not a new cross-host lock.
- Surgical-fix discipline for implementer repairs.
- #763 consumes events only; this change produces them.
- #855 owns README content restoration; this owns the reusable protocol and
  composition fixtures that use docs (and other) invariants as examples.

## Goals / Non-Goals

**Goals:**

- Define a versioned candidate-integrity **manifest** and comparison algorithm.
- Cover deterministic rebase/restack, conflict repair, pre-merge auto-fix, and
  generic recovery repair with one protocol.
- Classify transitions: `semantically_equivalent` | `expected_scoped_change` |
  `scope_expansion` | `unverified`.
- Invalidate prior review + readiness on `scope_expansion` / `unverified`;
  re-gate current head on pure restack / expected scoped change.
- Persist and hydrate manifests across restart/reattach.
- Emit durable `candidate_integrity` events #763 already understands.
- Ship deterministic regression fixtures including #793-class and multi-item
  composition.

**Non-Goals:**

- Provider- or host-specific behavior or model self-attestation.
- Replacing review with line-count or raw diff-size thresholds.
- Human-authority holds for mechanical scope/freshness failures alone.
- Restoring the README monolith (#855).
- Redefining trusted-verifier policy (#691) or prompt quality (#737).
- Scoreboard metric math (#763 already shipped).
- Cross-provider eval holdout design (#740).

## Decisions

### D1 — One shared protocol module, many call sites

**Decision:** Implement a pure/injectable `candidate-integrity` module (build
manifest, compare, classify, serialize, hydrate) used by every pipeline-owned
candidate-moving path. Call sites wrap mutations with
`capturePre → mutate → capturePost → classify → dispose` rather than each stage
inventing its own surface check.

**Covered mutation methods (closed set for v1):**

| `mutation_method` | Primary call sites |
|---|---|
| `restack` | pre-merge / merge-queue restack onto updated base |
| `rebase` | deterministic rebase / conflict-clearing rebase |
| `conflict_repair` | conflict-aware repair (deterministic or surgical) |
| `pre_merge_autofix` | pre-merge bounded auto-fix |
| `recovery_repair` | `repair_pipeline_item` / autonomous recovery mechanical repair |

**Alternatives rejected:** Per-stage ad-hoc README-only guards (already partial
for merge-queue; does not generalize). Relying solely on existing SHA +
diff-hash gates (they key identity and whole-PR hash, but do not persist an
approved surface across a mutation that claims to be “just restack,” and do not
emit the structured invalidation trail #763 expects).

### D2 — Manifest is path + content evidence, not line count

**Decision:** A `CandidateIntegrityManifest` (schema_version starting at 1)
includes at minimum:

- Identity: issue, PR (when known), run_id, domain, captured_at
- Anchors: `base_ref`, `base_sha`, `candidate_sha` (full 40-char)
- Surface: sorted changed-path set vs base (or equivalent deterministic listing)
- Per-path content digests for changed paths (or a bounded Merkle / tree digest
  over path→content-hash pairs) sufficient to detect add/remove/modify
- Optional enrichments: raw diff byte/line counts, path-class tags (e.g.
  `docs-landing`), declared repair scope from the caller
- Producer id (deterministic module name/version), not a model claim

Comparison uses:

1. Path-set symmetric difference
2. Content-digest mismatch on shared paths
3. Declared repair scope (allowlisted paths / intent from the mutation claim)
4. Known repository invariants (e.g. docs landing-page contract) as
   **post-mutation gate inputs**, not as the only classifier

**Raw size is diagnostic only.** A large legitimate fix is `expected_scoped_change`
when paths/content stay within declared scope and digests match the intended
delta. A small append of an out-of-scope path (or an in-scope path that was not
in the pre-manifest and not declared) is still expansion.

**Classification rules (normative outline):**

| Classification | Rule sketch |
|---|---|
| `semantically_equivalent` | Same path set and same per-path content digests vs base as pre-manifest; only commit identity / parent linkage may change (clean restack/rebase) |
| `expected_scoped_change` | Diff from pre-manifest is non-empty **and** entirely within declared repair scope (or an explicit allowed scoped-mutation policy for that method); no undeclared path adds/removes/content changes |
| `scope_expansion` | Any undeclared path add/remove, or content change outside declared scope, or post-mutation invariant failure tied to undeclared surface (e.g. #793 README monolith) |
| `unverified` | Missing pre-manifest, unreadable head/base, incomplete digests, or comparison failure — fail closed |

### D3 — Disposition is engine-owned; not a human hold by default

**Decision:**

- `semantically_equivalent` → re-evaluate current-head gates (CI, review-SHA /
  diff-hash / blocking keys, Tester evidence pin, docs/invariants). Prior review
  may remain usable **only** under existing review-sha-gating rules for the
  **new** head identity; integrity classification does not invent a free pass.
- `expected_scoped_change` → invalidate readiness at the old SHA; require fresh
  review (or delta-review path) and current-head gates against the new SHA.
  Matches “intended auto-fix forces re-review.”
- `scope_expansion` / `unverified` → invalidate review + readiness evidence;
  emit structured diagnostic; route to scoped review or bounded recovery; **do
  not** `setBlocked` as human-authority solely for this mechanical class; **do
  not** advance toward ready-to-deploy until a later clean classification +
  full current-head evidence exists.

**Alternatives rejected:** Human hold for every scope expansion (issue forbids
mechanical failures becoming human-authority holds). Silent proceed when CI
still green (the #793 failure mode).

### D4 — Persistence and restart hydration

**Decision:** Persist the active pre-mutation (and last post-mutation)
manifest under the run-scoped durable store (alongside run ledger / issue run
state — exact path chosen at implement time to match `run-directory-layout`
conventions). On restart/reattach:

1. Hydrate last claimed mutation + pre-manifest if a mutation was in-flight.
2. Re-read authoritative PR head; if head advanced without a completed
   post-classification, treat as `unverified` until re-classified.
3. Never silently drop the pre-manifest or re-seed it from the **post**-mutation
   head as if it were the approved surface.

### D5 — Event shape aligns with #763 consumer

**Decision:** Emit run-ledger events with `type: "candidate_integrity"` and
fields the scoreboard already reads:

- `mutation_method` (or `method`)
- `classification` (include `scope_expansion`, `unverified`, and invalidation
  markers such as `review_invalidation` / flags `invalidated_review`,
  `invalidated_readiness` as appropriate)
- `before_sha` / `after_sha` (candidate)
- base anchors when useful
- changed-path summary (bounded)
- `path_class` / `affected_path_class` when invariant classes apply
- `engine_version` when known
- review-invalidation reason string/code

Evidence bundle surfaces these events (or links them) so summary and offline
tools share one trail. No scoreboard threshold changes.

### D6 — Composition with existing gates, not replacement

**Decision:** Candidate-integrity **composes** with:

- `review-sha-gating` / delta recheck — integrity invalidation is an additional
  fail-closed input; it does not weaken pipeline-internal commit exemptions
  when the surface truly did not expand.
- `tester-evidence` (#646) — reuse SHA-pinned suite results when present;
  integrity does not re-run tests itself.
- `docs-landing-split` / docs check — used as a concrete invariant in the #793
  fixture; other invariants may be registered later without redefining #855.
- Recovery and pre-merge auto-fix — remain the mutation engines; integrity is
  the wrapper and disposition layer.

### D7 — Fixtures are deterministic and fast

**Decision:** Unit tests inject git/gh/worktree deps. Fixtures synthesize
manifest pairs and gate disposition without live network. Include:

1. #793-class: pre lean README surface → post monolith append →
   `scope_expansion` + readiness denied + docs invariant red
2. Clean rebase: identical surface digests, new SHA →
   `semantically_equivalent` + re-gate without expansion
3. Intended auto-fix: declared scope path content change →
   `expected_scoped_change` + review invalidation for new SHA
4. Restart: pre-manifest + claimed mutation incomplete → hydrate, refuse stale
   review reuse
5. Multi-item: item A accepted invariant remains after item B repair/restack
   mutates B only (composition harness)

Keep #740-style cross-provider holdouts out of this suite.

## Risks / Trade-offs

- **[Risk] Digest cost on large PRs** → Mitigation: hash only changed paths vs
  base; bound path listing; reuse git object hashes when available via injected
  deps; never block solely on wall-clock of hashing without a timeout/diagnostic.
- **[Risk] Over-classifying legitimate restacks as expansion** → Mitigation:
  pure path+content equality path for `semantically_equivalent`; golden fixture
  for clean rebase; declared scope for intentional repairs.
- **[Risk] Under-classifying expansion when digests incomplete** → Mitigation:
  incomplete comparison is `unverified` (fail closed), not silent pass.
- **[Risk] Double invalidation noise with SHA gate** → Mitigation: integrity
  runs at mutation boundaries; SHA gate continues for ordinary commits; events
  dedupe by mutation id when both fire.
- **[Risk] Call-site miss (new mutation path forgets the wrapper)** → Mitigation:
  central helper; tests that enumerate known mutation methods; lint/contract
  test listing call sites.
- **[Risk] Confusion with #855 README work** → Mitigation: this change never
  rewrites README content; fixtures only assert protocol response to a synthetic
  monolith append.

## Migration Plan

1. Spec + design (this change) lands first.
2. Implement pure module + unit tests (no behavior change until call sites wrap).
3. Wire call sites behind feature-complete protocol (no silent partial wrap:
   each method either fully wrapped or not claimed covered).
4. Emit events; confirm #763 metrics leave zero-path when events present.
5. No rollback of review rigor; if protocol must be temporarily disabled, fail
   closed to `unverified` rather than skipping classification.

## Open Questions

- Exact on-disk path for manifests under `run-directory-layout` (implementer
  chooses consistent with existing run-store conventions; document in tasks).
- Whether `expected_scoped_change` always forces full adversarial review vs
  existing delta-review path for pre-merge auto-fix (prefer reusing delta
  review when SHA/diff-hash already routes there — do not invent a third review
  kind).
- Registry of “declared repair scope” carriers per mutation method (breadcrumb
  fields vs explicit argument on the integrity helper) — default: explicit
  argument from the call site.
