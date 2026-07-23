## Why

The epic #528 wants an integrated `pipeline:loop` run to execute only **provably independent**
issues concurrently in separate worktrees, while keeping pre-merge, merge, base-refresh, and
post-merge reconciliation serialized. Its governing product rule is conservative: *parallelism is
opt-in and unknown overlap means serialize* — an issue pair may run concurrently only when
dependency, **declared ownership**, and **shared-surface** checks all prove disjoint.

The durable engine already models the **dependency** half of that triad
(`durable-run-dependency-integrity`, #513): it preserves and live-verifies inter-item dependencies.
But it has no model at all for the other two halves — **what surfaces an issue owns** and **which
surfaces conflict**. Without that model the planner (#530) has nothing to reason over: it cannot tell
that two issues both regenerate the same lockfile, both edit the shared review schema, or both touch
`.github/workflows/ci.yml`, and it cannot tell an *un-declared* issue (unknown ownership) apart from a
genuinely independent one. Unknown overlap is exactly the case the epic says must serialize, so the
absence of a model is not neutral — it is unsafe if the planner defaults to "no declared conflict ⇒
parallel."

This change (#529) supplies the missing model: a machine-readable, per-item **ownership + conflict
declaration**, a deterministic **normalization** of declared surfaces into a typed set, and a
deterministic **pairwise conflict evaluation** that returns `disjoint` or `conflict` with a structured
reason. It is the first of #528's three children and is a pure **planning input** — it never schedules
anything, never grants a merge, and never bypasses review (that is #530's planner and the existing,
unchanged merge barrier). Capturing this as its own capability lets the planner in #530 consume a
stable, tested contract instead of re-deriving conflict semantics inline.

## What Changes

- **A machine-readable ownership + conflict declaration on each run item.** Each contract item gains
  an optional, additive `ownership` declaration with two kinds of surface:
  - **Exclusive-ownership surfaces** — source path / module **globs** the item owns. Two items whose
    exclusive globs are disjoint do **not** conflict on that basis; overlapping globs **do**.
  - **Shared-by-default surfaces** — schema / state / lock stores, generated artifacts, shared
    configuration, public APIs, CI / workflow files, and package / version (release) files. Two items
    that both touch the *same* shared surface **conflict by default**, because a shared surface has no
    "disjoint sub-region" the way a source tree does.

  Plus **explicit `conflicts_with` edges** (manual conflict declarations naming another item) and
  reviewed **`exceptions`** (an audited note that suppresses a specific auto-derived shared-surface
  conflict for a specific pair). An absent or empty declaration means **unknown ownership**.
- **Deterministic surface normalization.** Declared surfaces are canonicalized into a sorted, de-duped
  typed set — each entry carrying its `kind`, its `pattern`, and its conflict class
  (`exclusive` | `shared`). The same declaration always normalizes to the identical set; this set is
  the unit of comparison and the artifact recorded as evidence.
- **Deterministic pairwise conflict evaluation.** A pure function evaluates an ordered/unordered pair
  of items and returns a typed verdict — `disjoint` or `conflict` — with a structured reason drawn
  from exactly one of: an **overlapping surface** (glob overlap on exclusive surfaces, or co-owned
  shared surface), an **explicit edge**, or **unknown ownership**. Reviewed exceptions suppress only
  the auto-derived shared-surface reason they name; an explicit `conflicts_with` edge is never
  suppressible.
- **Conservative unknown-ownership default.** An item with no declaration, or a relevant surface not
  covered by any declared surface, is treated as **unknown ownership**, which yields a conflict — so a
  pair is never reported `disjoint` on the strength of missing information.
- **Durable planning evidence.** Every evaluation records, as durable planning evidence, the
  normalized per-item surface sets and, per pair, the verdict and its structured reason — the audit
  trail #528 requires ("a durable run records why each pair was parallelized or serialized").
- **Planning-input-only guarantee.** Declarations, exceptions, and verdicts are inputs to planning
  only. They never authorize a merge, relax a review gate, or bypass the serialized merge barrier
  (golden rule #4); an exception suppresses only a *planning* conflict edge, never a review finding.

Out of scope for #529 (belongs to #530 / #531): the actual parallelization **planner/scheduler** that
consumes these verdicts, execution-time changed-file overlap detection and parking, and the
integration/evidence end-to-end tests.

## Acceptance Criteria

- [ ] A machine-readable schema validates an ownership + conflict declaration: it accepts a
      well-formed declaration (exclusive source globs; the shared-surface classes schema/state,
      generated-artifact, shared-config, public-API, CI/workflow, package/version; explicit
      `conflicts_with` edges; reviewed `exceptions`) and **rejects** a malformed one (unknown surface
      kind, malformed glob, or an exception missing its required reviewed justification/reference) —
      proven by unit tests on both the accept and reject paths.
- [ ] Declared surfaces normalize into a deterministic, sorted, de-duped typed set in which every
      entry carries its `kind`, `pattern`, and conflict class (`exclusive` | `shared`); re-normalizing
      the same declaration yields a byte-identical set — proven by a determinism test.
- [ ] Pairwise evaluation is deterministic and identifies **overlapping surfaces** and **explicit
      conflict edges**, returning `disjoint` or `conflict` with a structured reason; the same pair
      always yields the same verdict, and unit tests run entirely through pure inputs with **zero**
      real network, git, or subprocess calls.
- [ ] Two items with **disjoint** exact source paths / globs evaluate `disjoint`; two items with
      **overlapping** globs evaluate `conflict` naming the overlapping surface — both proven by tests
      (exact-path and glob-overlap cases).
- [ ] Two items that both own the **same generated artifact** (or the same schema/state store, package
      manifest, CI/workflow file, or release/version file) evaluate `conflict` by default; the same
      pair with an **approved reviewed exception** naming that surface evaluates `disjoint` — both
      proven by tests (shared-generated-output, package/config/state, and approved-exception cases).
- [ ] An item with **no declaration**, or with a relevant surface **not covered** by any declared
      surface, is treated as **unknown ownership** and evaluates `conflict` (never `disjoint`) — proven
      by an unknown-ownership test.
- [ ] An explicit `conflicts_with` edge yields `conflict` even when the pair's surfaces are otherwise
      disjoint, and a reviewed exception does **not** suppress that explicit edge — proven by a test.
- [ ] Planning evidence durably records the normalized per-item surface set and the per-pair verdict +
      conflict reason — proven by a test asserting a conflicted pair's evidence contains both the
      normalized set and the structured reason.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror and `npm run ci` (including
      `openspec validate --all`) is green; every new test bites (fails without the change).

## Capabilities

### New Capabilities
- `durable-run-ownership-conflicts`: a machine-readable per-item ownership + conflict declaration
  (exclusive source globs; shared-by-default surface classes; explicit conflict edges; reviewed
  exceptions), deterministic normalization of declared surfaces into a typed set, and a deterministic
  pure pairwise conflict evaluator returning `disjoint`/`conflict` with a structured reason —
  conservative on unknown ownership, recording the normalized surface set and conflict reason as
  durable planning evidence, and granting no merge or review bypass.

## Impact

- **Specs:** one new capability, `durable-run-ownership-conflicts`. No existing requirement is
  weakened; the declaration is additive to the contract item (absent/empty ⇒ unknown ownership ⇒
  conflict), so a run that declares no ownership is simply never proven parallelizable — the
  conservative status quo.
- **Code (implementation step only, not this change):** a new declaration/type surface on
  `LoopContractItem` (`core/scripts/loop/types.ts`), a new pure module (e.g.
  `core/scripts/loop/ownership.ts`) housing surface normalization and the pairwise evaluator, and the
  planning-evidence record it emits — all pure, injected-seam, no-real-I/O per the repo test
  discipline. The consuming planner/scheduler is #530.
- **Interoperability:** fully additive. A contract with no `ownership` declarations behaves exactly as
  today (every pair unknown ⇒ conflict ⇒ serialized), so no existing durable run changes behavior
  until ownership is declared. No new external write path and no auto-merge / auto-release /
  auto-deploy is introduced (golden rule #4).
