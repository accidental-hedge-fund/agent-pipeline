## Context

`pre-merge-fix-round` (#359) interposes one bounded auto-fix between a blocking pre-merge delta
review and `needs-human`. Eligibility is pure and fail-closed:

```ts
// pre_merge.ts today
export function isAutoFixableFinding(f: ReviewFinding): boolean {
  const cat = (f.category ?? "").toLowerCase().trim();
  return cat === "correctness" || cat === "missing-dep";
}
```

Reviewer prompts already encourage categories including `concurrency` (severity rubric in
`prompts/index.ts`: race/ordering bugs are **high**; category examples include `concurrency`).
Dogfood #668 / PR #672 hit pre-merge delta blocks on concurrency-shaped HIGH findings (lock
ownership, PID identity, macOS `/proc` probe). Those are surgical implementer fixes — the same
class as `correctness` — but the allowlist sent them straight to `needs-human`.

Review-2 also advanced under severity policy with medium advisories that later reappeared as HIGH
at delta on the same fingerprint. Existing resolved-finding verification (#496/#533-era,
`pre-merge-delta-recheck`) demotes unverified re-assertions of **settled** findings
(`resolved-by-fix` / `overridden`). Prior-round **advisories** that never blocked are not settled
under that rule, so they can still hard-block at delta without new evidence.

## Goals / Non-Goals

**Goals:**

- Expand the auto-fix allowlist only where a surgical implementer fix is safe without product
  judgment; document an explicit category matrix (in/out + rationale).
- Guarantee: allowlisted + no prior auto-fix commit → always one auto-fix + one re-review (no
  silent first-hop skip bugs).
- Give #668-class `concurrency` findings the same one-shot autonomy path as `correctness`.
- Carry forward prior-round advisory disposition at delta when the same fingerprint reappears
  without new head-state evidence, coordinated with existing settled-finding machinery.
- Keep fail-closed, one-attempt, surgical-fix, and developer-commit classification invariants.

**Non-Goals:**

- Auto-fixing `security`, `scope`, or `product-judgment-required`.
- A second auto-fix attempt, or removing `needs-human` when the fix is exhausted / re-review still
  blocks.
- Re-opening "never re-review" / full delta-context redesigns (#496/#533) — this change is
  **allowlist + routing + advisory carry-forward**, not a new review architecture.
- Formalizing a closed `ReviewFinding.category` enum in the JSON schema (optional follow-up).
- Auto-merge or any change to the human merge gate.
- Merge-queue work (#675).

## Decisions

### 1. Expand the allowlist by category, not invent a second "near-allowlist hold" path

Issue #680 offers two shapes for near-allowlist code defects (e.g. concurrency):

- carefully scoped allowlist expansion, **or**
- a pre-merge fix hold that still invokes the implementer once before `needs-human`.

**Decision:** expand the allowlist. A second routing path would duplicate the existing one-attempt
marker, surgical-fix prompt, re-review, and rollback machinery for the same outcome (one implementer
invoke, then escalate if still blocking). Keep a single eligibility predicate.

**Expanded allowlist:** `{ correctness, missing-dep, concurrency }` (case-insensitive, trimmed).

### 2. Category matrix (audit: why each is in or out)

| Category | Allowlist? | Rationale |
| --- | --- | --- |
| `correctness` | **In** | Mechanical code defect; implementer can apply the recommended fix without product judgment. (#359) |
| `missing-dep` | **In** | Wiring/import/package omission; surgical and testable. (#359) |
| `concurrency` | **In (new)** | Race, lock ownership, PID identity, probe, ordering defects are code-level; same surgical-fix shape as correctness; #668 dogfood class. Re-review still gates the result. |
| `security` | **Out** | Auth/boundary mistakes need human judgment; false-positive auto-fix risk is high. |
| `scope` | **Out** | Whether the change is in-scope is a product/plan decision, not a code patch. |
| `product-judgment-required` | **Out** | Explicitly non-mechanical. |
| `spec-divergence` | **Out** | Has its own bounded repair path (`performBoundedSpecRepair` / direction field); not this allowlist. |
| `data-loss` | **Out** | Risk of irreversible impact; human must own remediation shape. |
| `observability` | **Out** | Often advisory hardening; when blocking, product taste (what to log/metric) dominates. |
| absent / empty / unrecognized | **Out** | Fail-closed: auto-fix only on positive allowlisted signal. |

Eligibility remains **all-or-nothing**: if any blocking finding is out, skip auto-fix for the whole
entry (do not partial-fix a mixed set).

### 3. No change to bound, prompt, commit classification, or re-review budget

Reuse #359 machinery unchanged:

- at most one auto-fix per entry; crash-safe via `PRE_MERGE_AUTOFIX_PREFIX` on the commit subject
- `buildFixPrompt` surgical discipline
- developer-classified commit (`isPipelineInternalCommit` stays false)
- single post-fix delta re-review; does not consume `max_adversarial_rounds`
- rollback on harness/dirty/no-commit failure

This change only widens the pure eligibility helpers and documents the matrix.

### 4. Advisory carry-forward reuses settled-surface demotion, not a parallel policy

**Problem:** review-2 advances with advisory findings; delta re-raises the same fingerprint as
HIGH without new evidence → hard block + (if category allowlisted) auto-fix churn, or
`needs-human` if not.

**Decision:** extend the existing settled-finding / surface demotion path so a prior-round
**advisory** finding (below policy threshold or `blocking: false`) is treated as a soft disposition
for carry-forward purposes:

- Inject prior advisory dispositions into the delta verification context (alongside
  resolved-by-fix / overridden when already present), OR match on surface/fingerprint against the
  prior-round digest's advisory partition.
- When a delta finding matches that prior advisory surface/fingerprint and cites **no new
  head-state evidence**, demote it to advisory (audit in comment/event) rather than block.
- When the delta finding cites current head state as evidence of a **new or worsened** defect,
  keep it blocking under normal policy — then the expanded allowlist may auto-fix once.

This reuses partition/demotion seams instead of inventing a second disposition store. It does
**not** auto-approve unverified security escalations: demotion is surface/fingerprint + evidence
gated, and security still never auto-fixes if it remains blocking.

### 5. Tests prove the expansion bites

Update `isAutoFixableFinding` / `allBlockingAutoFixable` unit tests and at least one end-to-end
DI path through `enforceReviewShaGate` / delta block:

- `concurrency` alone → auto-fix attempted
- mixed `concurrency` + `correctness` → auto-fix attempted
- `security` (alone or mixed) → no auto-fix, immediate escalate
- prior auto-fix commit → exhausted, no second attempt
- advisory carry-forward demotion without head evidence; verified regression still blocks

Each new assertion should fail if the allowlist or demotion path is removed.

## Risks / Trade-offs

- **[Risk] Reviewer mislabels a judgment call as `concurrency`.** → Mitigation: post-fix adversarial
  re-review; surgical-fix self-check; one-attempt bound; security/scope/product-judgment remain out.
- **[Risk] Over-broad allowlist later.** → Mitigation: matrix is normative in the living spec;
  expansions require OpenSpec + tests, not drive-by string adds.
- **[Risk] Advisory carry-forward demotes a real regression.** → Mitigation: require absence of
  head-state evidence for demotion; verified regressions stay blocking (same bar as settled
  re-assertion demotion).
- **[Risk] Category drift in free-text `category`.** → Mitigation: fail-closed on unrecognized;
  optional later work to tighten schema hints (out of scope).

## Migration Plan

- Purely additive eligibility expansion + demotion coordination.
- No config key, no schema migration, no behavior change for runs that never hit delta block.
- Rollback: revert the allowlist helper and demotion hook; prior `correctness`/`missing-dep` path
  remains the #359 baseline.

## Open Questions

- None blocking planning. If dogfood later shows frequent blocking categories that are still
  mechanical (e.g. a stable `reliability` token), expand the matrix with a new change — do not
  pre-emptively widen here.
