## Context

The pipeline already binds review verdicts to commit SHA (`review-sha-gating`),
classifies pipeline-internal vs developer/fix commits (`pipeline-commits`),
caches verdicts by diff hash (`pre-merge-delta-recheck`), pins Tester suite
results to a candidate SHA (`tester-evidence` / #646), and fails closed on a
narrow README landing-page breach after merge-queue repair
(`merge-queue-repair-hold` + `docs-landing-split` / #855). Scoreboard
observability for candidate-integrity events already exists (#763 consumer in
`core/scripts/scoreboard-stabilization.ts`:
`computeCandidateIntegrityMetrics`).

What is missing is a **single control-plane protocol** that:

1. Snapshots the approved **candidate change surface** (canonical per-path
   patch evidence, not only a SHA) before any pipeline-owned head-moving
   mutation.
2. Compares the post-mutation surface to that snapshot with deterministic
   path/content evidence plus declared repair scope — including when the
   integration **base SHA moves** under a clean restack/rebase.
3. Classifies the transition and **forces** review/readiness invalidation on
   expansion or unverified comparison — without trusting the harness to notice.
4. Persists lifecycle state authoritatively (not only as optional evidence)
   so restart/reattach cannot silently reseed the approved surface from the
   post-mutation head.

Incident shape (#793): a restack/conflict repair appended ~1,845 lines of the
retired README monolith. Operational signals looked fine; the accepted landing
page contract was lost. A weaker or differently configured model may expose this
more often, but the defect is provider-neutral.

Constraints that do not move:

- No autonomous merge; stop at `pipeline:ready-to-deploy`.
- Rigor over latency — do not demote review to “diff size looks small.”
- Single-host locks remain host-local; this protocol is evidence- and gate-
  local, not a new cross-host lock.
- Surgical-fix discipline for implementer repairs.
- #763 consumes events only; this change produces them.
- #855 owns README content restoration; this owns the reusable protocol and
  composition fixtures that use docs (and other) invariants as examples.

## Goals / Non-Goals

**Goals:**

- Define a versioned candidate-integrity **manifest** with **canonical per-path
  patch evidence** (status, base preimage, candidate postimage) sufficient
  across base movement.
- One mandatory mutation **lifecycle wrapper** used by every covered call site.
- Cover deterministic rebase/restack, conflict repair, pre-merge auto-fix, and
  generic recovery repair with one protocol; inventory and classify all other
  head-moving paths.
- Classify transitions: `semantically_equivalent` | `expected_scoped_change` |
  `scope_expansion` | `unverified`.
- Precise re-gating matrix per classification (including: semantic equivalence
  must not preserve ready-to-deploy without current-head gates).
- Authoritative, atomic durable store for manifests + lifecycle state; hydrate
  on restart with explicit incomplete-state behavior.
- Bounded failure disposition for repeated expansion/unverified (no human hold
  solely for integrity; no readiness; no merge; finite retry + durable
  diagnostics).
- Emit durable `candidate_integrity` events matching the **actual** #763 field
  reads.
- Ship deterministic regression fixtures including #793-class (self-contained
  integrity fixture + #855 invariant when available) and multi-item composition.

**Non-Goals:**

- Provider- or host-specific behavior or model self-attestation.
- Replacing review with line-count or raw diff-size thresholds.
- Human-authority holds for mechanical scope/freshness failures alone.
- Restoring the README monolith (#855).
- Redefining trusted-verifier policy (#691) or prompt quality (#737).
- Scoreboard metric math (#763 already shipped).
- Cross-provider eval holdout design (#740).
- Wrapping non-candidate-moving paths (intake branch reserve, roadmap
  writeback, OpenSpec archive-only plain push) into this protocol when they do
  not rewrite an approved PR candidate surface under a “restack/repair”
  claim — those remain covered by existing SHA/diff-hash gates (see inventory).

## Decisions

### D1 — One shared protocol module + mandatory lifecycle wrapper

**Decision:** Implement a pure/injectable `candidate-integrity` module (build
manifest, compare, classify, serialize, hydrate) and a **single mandatory
mutation wrapper** that every covered call site must use. No stage invents its
own surface check or partial lifecycle.

**Lifecycle state machine (normative, closed):**

```
idle
  → pre_persisted          # pre-manifest durable; mutation MUST NOT start before this
  → mutation_claimed       # side-effect intentionally begun (may partially succeed)
  → authoritative_post_read  # re-read PR head + base (even after mutation error)
  → classified             # post-manifest built; transition class assigned; event emitted
  → disposed               # gate invalidation / re-route applied; terminal for this mutation_id
```

**Hard rules:**

| Condition | Required behavior |
|---|---|
| Pre-persist fails | **Abort mutation** — no push/rebase/force-with-lease |
| Mutation throws or reports failure | Still transition to `authoritative_post_read` then `classified` (or `unverified` if re-read fails). Head may have moved on the remote. |
| Head advanced without completed classification (crash mid-lifecycle) | On resume: hydrate pre-manifest; re-read head; classify as incomplete → fail closed (`unverified` until classified); **never** reseed pre-manifest from post head |
| Classification complete | Dispose: invalidate and/or re-gate per D5 matrix; append `candidate_integrity` event |

Helper shape (illustrative):
`runCandidateMovingMutation({ method, subject, declaredScope?, mutate })`
implements the state machine and returns classification + disposition.

**Covered mutation methods (closed set for v1 enforcement):**

| `mutation_method` | Primary call sites | Declared scope allowed? |
|---|---|---|
| `restack` | merge-queue / pre-merge restack onto updated base when framed as restack | No (empty scope; only `semantically_equivalent` or expansion/unverified) |
| `rebase` | `runDeterministicConflictRebase`, pre-merge conflict rebase, CI one-shot rebase | No (same as restack) |
| `conflict_repair` | conflict-aware surgical repair paths that edit to clear conflicts | Yes — frozen at pre-persist from repair claim |
| `pre_merge_autofix` | `performPreMergeAutoFix` / pre-merge bounded auto-fix | Yes — finding paths / explicit path list from autofix claim |
| `recovery_repair` | `repair_pipeline_item` / autonomous recovery mechanical repair | Yes — diagnostic-scoped paths when known; else empty → only equivalent or expansion |

**Aliases for #763 counting:** Prefer exact method strings above. Scoreboard
already counts methods containing `repair` / `restack` and classification
substrings; keep method names containing those tokens where accurate
(`recovery_repair`, `conflict_repair`, `restack`). Do **not** invent a parallel
`repair` string that loses call-site specificity — `by_mutation_method` is a
full histogram.

### D2 — Canonical per-path patch evidence (base-aware)

**Decision:** Path→candidate-blob digests alone are **insufficient** when the
integration base moves. Manifest surface entries are **canonical patch records**:

For each path in the candidate-vs-base changed surface:

| Field | Meaning |
|---|---|
| `path` | Final path (post-rename destination if renamed) |
| `status` | `A` add \| `M` modify \| `D` delete \| `R` rename (optional `C` copy if git reports) |
| `old_path` | Source path when `R`/`C`; null otherwise |
| `base_blob` | Content digest of base-side/preimage blob (null for pure adds) |
| `candidate_blob` | Content digest of candidate-side/postimage blob (null for pure deletes) |
| `similarity` | Optional rename similarity score when status is `R` |

**Comparison algorithm (normative outline):**

1. Build pre and post canonical entry maps keyed by **normalized path identity**
   (for renames: compare as delete+add of content identity, or as `R` with
   same `old_path`→`path` and blob pair).
2. **Semantic equivalence** when:
   - The multiset of `(status, path, old_path?, base_blob, candidate_blob)`
     patch records is identical between pre and post **relative to their
     respective bases**, OR (when base SHA changed) the **candidate-side
     content surface** is identical: same final path set, same
     `candidate_blob` per path, same delete set (paths absent on candidate
     that were present on pre-candidate), and rename pairs preserve
     content identity — i.e. the PR still introduces the same tree delta
     *content* even if base preimages differ.
   - Practical v1 rule for clean restack/rebase with base movement:
     - Project candidate tree paths that differ from **current** base into
       patch records.
     - Equivalence holds when the set of
       `(path, status, candidate_blob, old_path)` matches pre after
       re-expressing pre records against the new base via re-diff of the
       **same candidate tree** (if candidate tree content identical and
       only base moved, re-diff may change `base_blob`/`status` for paths
       base also touched — see step 3).
   - **Authoritative v1 definition for `semantically_equivalent`:**
     candidate trees are content-identical at the path surface that the
     candidate introduces: for every path, `candidate_blob` (or absence)
     matches pre-manifest’s candidate-side map, and the changed-path set
     vs **each** base is allowed to differ only in `base_blob`/status when
     the candidate blob at that path is unchanged and undeclared paths
     were not introduced. Simpler operational check used in code:
     1. Build `candidate_side_map`: path → candidate blob (or DELETE marker).
     2. Pre and post maps equal ⇒ `semantically_equivalent`.
     3. If maps differ ⇒ not equivalent; apply declared-scope rules.
3. **Expected scoped change** when the symmetric difference of
   candidate-side maps is non-empty and **every** differing path is covered
   by declared repair scope (see D3).
4. **Scope expansion** when any differing path is outside declared scope
   (including undeclared add of `README.md` monolith content).
5. **Unverified** when pre-manifest missing, authoritative head/base
   unreadable, digests incomplete (binary/unreadable without digest policy),
   rename detection failed open, or comparison threw.

**Binary / unreadable paths:** Prefer git object OIDs (`git rev-parse
<path>:<blob>` / `ls-tree`) via injected deps so binary content never needs
to be fully read. If OID unavailable, mark entry incomplete → whole
comparison `unverified` (fail closed). Never skip a path silently.

**Raw size** (line/byte counts) may enrich diagnostics and events only.

### D3 — Declared repair scope

**Decision:** Declared scope is an explicit argument to the mutation wrapper,
frozen at `pre_persisted` time (immutable for that `mutation_id`).

**Syntax (v1):**

```ts
type DeclaredRepairScope = {
  /** Exact repo-relative paths (posix, no leading ./). Primary matcher. */
  paths: string[];
  /**
   * Optional directory prefixes ending with `/` (e.g. `core/test/`).
   * A path matches if it equals a declared path or has a declared directory
   * prefix. No general glob language in v1 (no `**`, no `*`) — keeps matching
   * deterministic and reviewable. Call sites expand globs before freeze if needed.
   */
  directories?: string[];
  /** Optional human/engine reason string for diagnostics. */
  reason?: string;
};
```

**Matching rules:**

| Event | Covered by scope? |
|---|---|
| Modify path `P` | `P` in `paths` or under a declared directory prefix |
| Add path `P` | same |
| Delete path `P` | same — delete of `P` requires `P` in scope |
| Rename `old` → `new` | **both** `old` and `new` must be in scope (or under declared directories). One-sided rename is expansion. |
| Content change on in-scope path | covered |
| Any path not matched | expansion |

**Which methods may declare non-empty scope:**

| Method | Scope |
|---|---|
| `pre_merge_autofix` | Required when content change is intended; derive from blocking finding file paths + any explicit autofix path list. Empty scope ⇒ only `semantically_equivalent` is non-expansion (noop). |
| `recovery_repair` / `conflict_repair` | Optional; when empty, any candidate-side map delta is `scope_expansion`. |
| `restack` / `rebase` | **Must** be empty. Any delta is `scope_expansion` (or `unverified`). |

### D4 — Authoritative durable store (not optional evidence)

**Decision:** Manifests and lifecycle records live in an **authoritative**
atomic store under the run directory, keyed by:

`domain` (when known) + `issue` + `pr` (when known) + `run_id` + `mutation_id`

Layout (chosen to match run-store conventions in `run-store.ts`):

```
.agent-pipeline/runs/<run-id>/candidate-integrity/
  <mutation_id>.json          # full record: lifecycle state + pre + post + classification
  active.json                 # pointer to in-flight mutation_id for this subject (atomic rename)
```

- Writes use temp + fsync + rename (same family as durable loop store / stage
  attempt ledger claim-before-side-effect), **not** best-effort-only append.
- Pre-persist failure ⇒ mutation aborts (wrapper hard rule).
- `appendEvent(..., type: "candidate_integrity")` remains **observability** and
  may stay non-fatal for control flow; **disposition authority** is the
  integrity store + in-process classification return value, never “bundle
  write succeeded.”
- Evidence bundle / summary **surfaces** transitions; missing bundle does not
  clear invalidation.

**Restart / incomplete lifecycle:**

| State on disk | Resume behavior |
|---|---|
| `pre_persisted` only | Hydrate pre-manifest; **do not** start a new mutation until operator/engine re-enters wrapper; if head already ≠ pre `candidate_sha`, force `authoritative_post_read` → classify (`unverified` if cannot complete) |
| `mutation_claimed` | Re-read authoritative PR head/base; build post; classify; dispose |
| `authoritative_post_read` without classification | Complete classification from stored pre + re-read |
| `classified` / `disposed` | Terminal for that mutation_id; readiness uses disposition |
| Missing store after claimed head move | Treat as `unverified`; refuse pre-mutation review as readiness authority |

### D5 — Re-gating matrix (precise)

For every covered mutation that yields a new authoritative candidate SHA:

| Classification | Review for readiness | Ready-to-deploy | CI / Tester / invariants | Internal-commit exemption |
|---|---|---|---|---|
| `semantically_equivalent` | Re-evaluate review-SHA gate on **new** head. Prior approve may apply **only** if existing exact-SHA / residual rules already allow it for that head — integrity does **not** invent carry-forward. Pipeline-internal-only exemption on an **unchanged** head remains; a restack that **changes SHA** is not “unchanged head,” so internal-commit exemption **cannot** treat pre-mutation approve as automatic authority for the new SHA without the gate’s normal residual path. | **Must not** preserve prior `ready-to-deploy` label/claim solely because surface is equivalent. Clear or re-check readiness; re-enter current-head gates. | Full re-eval on new SHA | Cannot launder pre-mutation approve through internal-commit rules for the post-mutation SHA |
| `expected_scoped_change` | **Fresh review required** (delta-review path when pre-merge already routes there; otherwise full review). Pre-mutation approve is not readiness authority. | Blocked until new review + gates pass | Full re-eval | Autofix commits already must not match `isPipelineInternalCommit` (`PRE_MERGE_AUTOFIX_PREFIX`); integrity adds explicit invalidation flag so residual heuristics cannot reuse old approve |
| `scope_expansion` | Invalidate prior review as readiness authority; route to scoped review or bounded recovery | Blocked | N/A until re-classified cleanly | Invalidation wins over residual reuse |
| `unverified` | Same fail-closed as expansion | Blocked | N/A until classified | Same |
| No-op (SHA unchanged, no mutation) | Existing rules | Existing rules | Existing rules | Unchanged |

**Implementation hook:** Persist a durable invalidation record
`{ from_sha, to_sha, mutation_id, classification, invalidated_review,
invalidated_readiness, reason }` consumed by `pre-merge-sha-gate` /
deploy-ready paths so residual identity heuristics cannot authorize the new
SHA after expansion/unverified/expected_scoped_change.

### D6 — Bounded failure disposition (no human hold for integrity alone)

**Decision:** Repeated `scope_expansion` / `unverified` on the same item:

1. Never `setBlocked` as **human-authority** solely for this mechanical class
   (no “needs human because integrity said expansion”).
2. Never advance to ready-to-deploy or call `mergePr` as success for that head.
3. Count integrity failures per issue+PR in the integrity store / stage-attempt
   ledger family (reuse claim-before-side-effect patterns from
   `stage-attempt-ledger.ts`).
4. **Retry budget (v1):** at most **N = 2** additional covered mutations after
   the first expansion/unverified on the same pre-expansion surface generation
   (configurable constant, default 2). After budget exhaust:
   - Stop further automatic candidate-moving repairs/restacks for that item in
     this run.
   - Leave durable diagnostics + `candidate_integrity` events.
   - Item remains in review/recovery-eligible state for **normal** whole-item
     execution when an operator or later engine entry re-enters with a new
     intentional change — not a human hold label for integrity alone.
5. Merge-queue: expansion/unverified ⇒ not re-gate eligible; typed diagnostic
   hold naming integrity classification is allowed as **queue state**, not as
   human merge-authority grant.

### D7 — Call-site inventory (implementation gate)

Before coding wrappers, implementers complete this inventory. Each path is
**Covered** (must use wrapper), **Out of scope** (documented reason), or
**Follow-up** (tracked issue if needed).

| Site | File / symbol | Head movement? | v1 disposition |
|---|---|---|---|
| Merge-queue deterministic conflict rebase | `stages/merge-queue.ts` `runDeterministicConflictRebase` | Yes (force-with-lease) | **Covered** — `rebase` / `restack` |
| Merge-queue mechanical repair | `stages/merge-queue.ts` `runSharedMechanicalRepair` | Yes via autofix | **Covered** — `conflict_repair` or `recovery_repair` |
| Pre-merge conflict rebase | `stages/pre-merge-conflict-rebase.ts` | Yes (force-with-lease) | **Covered** — `rebase` |
| Pre-merge CI one-shot rebase | `stages/pre-merge-ci-gate.ts` | Yes (force-with-lease) | **Covered** — `rebase` |
| Pre-merge auto-fix | `stages/pre-merge-autofix.ts` `performPreMergeAutoFix` | Yes (plain push) | **Covered** — `pre_merge_autofix` |
| Recovery repair | `loop/repair-pipeline-item.ts` | Yes (via autofix / push) | **Covered** — `recovery_repair` |
| Fix stage push | `stages/fix.ts` | Yes | **Out of scope for v1 “approved surface restack”** — developer/fix commits already invalidate review-SHA; not a restack claim. Do not bypass integrity by framing fix as restack. |
| Planning / implement push | `stages/planning.ts` | Yes | **Out of scope** — creates initial candidate; no pre-approved surface to preserve |
| OpenSpec archive push | `stages/pre-merge-openspec-archive.ts` | Yes (plain push, internal commit) | **Out of scope for expansion protocol** — pipeline-internal commit class; residual SHA gate applies. Not a restack/repair surface rewrite claim. |
| Eval / visual fix push | `stages/eval.ts`, `stages/visual.ts` | Yes | **Out of scope for v1** — same as fix stage (explicit content change already forces re-review) |
| Intake / sweep / backfill branch reserve | intake/sweep/backfill | Ref create | **Out of scope** — no approved PR candidate surface |
| Roadmap writeback | `roadmap/writeback.ts` | Yes | **Out of scope** — roadmap delivery, not PR candidate restack |

**Bypass prevention:** Contract test lists Covered sites and asserts each
imports/calls the shared wrapper. New force-with-lease call sites must be
added to the inventory test or fail CI.

### D8 — Event shape aligned with actual #763 consumer

Inspected: `core/scripts/scoreboard-stabilization.ts`
`computeCandidateIntegrityMetrics` (and tests in
`core/test/scoreboard-stabilization.test.ts`).

**Required event:** `type: "candidate_integrity"` (exact).

**Fields the consumer actually reads today:**

| Field | Consumer use |
|---|---|
| `type` | Must equal `candidate_integrity` |
| `mutation_method` or `method` | Histogram `by_mutation_method`; `repair`/`restack` substring heuristics for repair/restack counters |
| `classification` (also falls back to `kind`, `invalidation_reason`) | scope_expansion / unverified / review_invalidation / readiness_invalidation / post_repair_invariant / invariant_escape / post_merge detection via **substring includes** |
| `invalidated_review` === true | review_invalidations++ |
| `invalidated_readiness` === true | readiness_invalidations++ |
| `path_class` or `affected_path_class` | `by_path_class` |
| `engine_version` | `by_engine_version` (else run.json engine.version) |

**Producer SHALL emit (v1):**

```json
{
  "type": "candidate_integrity",
  "mutation_id": "...",
  "mutation_method": "restack|rebase|conflict_repair|pre_merge_autofix|recovery_repair",
  "classification": "semantically_equivalent|expected_scoped_change|scope_expansion|unverified",
  "before_sha": "<40-hex>",
  "after_sha": "<40-hex>",
  "base_sha_before": "<40-hex|null>",
  "base_sha_after": "<40-hex|null>",
  "changed_path_summary": ["…bounded…"],
  "invalidated_review": true,
  "invalidated_readiness": true,
  "invalidation_reason": "scope_expansion: undeclared path README.md",
  "path_class": "docs-landing",
  "engine_version": "…"
}
```

Notes:

- Put the classification string in `classification` **without** relying solely
  on `invalidation_reason` for class (consumer falls back but tests should use
  explicit classification).
- Set boolean flags `invalidated_review` / `invalidated_readiness` when
  disposition invalidates (more reliable than substring-only).
- `changed_path_summary` is **bounded for events only**; full canonical
  manifest remains in the integrity store.
- Do not change scoreboard metric math.

### D9 — Composition with existing gates

Candidate-integrity **composes** with:

- `review-sha-gating` / delta recheck — integrity invalidation is an additional
  fail-closed input (D5).
- `tester-evidence` (#646) — reuse SHA-pinned suite results when present;
  integrity does not re-run tests; stale Tester evidence for old SHA cannot
  authorize new SHA.
- `docs-landing-split` / `readme-landing-contract.ts` (#855) — used as a
  concrete invariant in fixtures and merge-queue re-gate; integrity protocol
  does not own README product text.
- Recovery and pre-merge auto-fix — remain the mutation engines; integrity is
  the wrapper and disposition layer.
- Stage-attempt ledger claim-before-side-effect — pattern template for
  pre-persist abort.

### D10 — Fixtures (#793 ownership clarified)

1. **Self-contained integrity fixture (owned by #857):** Synthesize pre
   manifest with lean `README.md` candidate blob; post manifest with large
   undeclared README content change / path append; assert
   `scope_expansion` + readiness denied + review invalidated. Does **not**
   assert #855 product copy; only protocol disposition.
2. **Composition with #855 when available:** Same transition also fails
   `evaluateReadmeLandingContract` / merge-queue readme gate — proves
   invariant layer still fails closed. If #855 helpers are present in-tree
   (they are: `readme-landing-contract.ts`), call them; do not fork a second
   product contract.
3. Clean rebase: candidate-side maps equal, SHA changes →
   `semantically_equivalent`, no expansion, readiness not auto-preserved.
4. Intended auto-fix: declared scope path content change →
   `expected_scoped_change` + fresh review required.
5. Restart hydration: pre-manifest + `mutation_claimed` incomplete → hydrate,
   refuse stale review.
6. Multi-item: item A invariant/disposition intact after item B mutation only.

**Additional test matrix (from plan review):** base movement, add/delete/rename,
binary/unreadable → unverified, missing PR/base → unverified, no-op autofix
(SHA unchanged), partial mutation failure still re-reads head, multi-item
isolation of integrity store keys.

### D11 — Approach pattern citation

Follow **claim-before-side-effect** from `stage-attempt-ledger.ts`
(`claimAndPersistStageAttempt`: claim + durable persist; on persist failure
roll back and **do not** perform the side-effect) and **authoritative HEAD
re-read after mutation** from `pre-merge-conflict-rebase.ts` /
`resolveRebasePushResult` (#771): success claims require verified head
movement; unverified post-rebase HEAD is not treated as clean success.
Candidate-integrity generalizes both: pre-manifest durable before mutation;
post-classification only after authoritative re-read; incomplete comparison
is `unverified`.

## Risks / Trade-offs

- **[Risk] Digest cost on large PRs** → Hash via git object OIDs for changed
  paths only; bound event summaries; full manifest on disk.
- **[Risk] Over-classifying legitimate restacks** → Candidate-side map equality
  for equivalence; golden clean-rebase fixture; empty scope on restack/rebase.
- **[Risk] Under-classifying when digests incomplete** → `unverified` fail closed.
- **[Risk] Call-site miss** → Inventory table + contract test; CI fails on
  unlisted force-with-lease sites in covered modules.
- **[Risk] Confusion with #855** → Self-contained integrity fixture + optional
  composition; never rewrite README product text here.
- **[Risk] Residual review-SHA reuse after restack** → Explicit invalidation
  record + D5 matrix; semantic equivalence still re-checks readiness.
- **[Risk] Event schema drift vs #763** → Emit fields the consumer already
  reads; add booleans for invalidation; tests assert scoreboard counters move.

## Migration Plan

1. Spec + design (this change) — plan revision incorporates review feedback.
2. Implement pure module + store + unit tests (no behavior change until
   Covered sites wrap).
3. Wire Covered sites only through the mandatory wrapper (all or nothing per
   method; do not claim coverage without wrap).
4. Emit events; confirm #763 metrics leave zero-path when events present.
5. If protocol must be temporarily disabled, fail closed to `unverified`
   rather than skipping classification.

## Open Questions (resolved at plan revision)

| Question | Resolution |
|---|---|
| On-disk path | `.agent-pipeline/runs/<run-id>/candidate-integrity/` (D4) |
| Full vs delta review on expected_scoped_change | Prefer existing pre-merge delta-review path when already routed; else full review. No third review kind. |
| Declared scope carrier | Explicit wrapper argument frozen at pre-persist (D3). |
| Semantic equivalence vs ready-to-deploy | Equivalence does **not** preserve ready-to-deploy (D5). |
| Human hold on integrity failure | Forbidden as sole disposition (D6). |
