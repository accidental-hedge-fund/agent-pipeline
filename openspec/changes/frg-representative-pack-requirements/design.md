## Context

FRG landed via #723 / change `release-mandatory-factory-reliability-gate` and is enforced by
`pipeline release` (lookup of `.agent-pipeline/frg/<version>/latest.json`). Layer B scoring lives
in `core/scripts/factory-reliability-gate.ts` (`computeFrgEvidence`, `runFactoryGate`,
`isReleaseEligibleFrgPass`, `parseFrgEvidence`, `writeFrgEvidence`). The first release that
shipped the gate (v1.29.1) used two clean comment-only pack items (#749/#750). With zero
classified blockers, `engine_class_rate` is `null` and surfaces as `n/a` — mathematically
“pass” under the current rate rule (`null` is treated as ≤ threshold) without ever exercising
OpenSpec archive, fix→re-review, capacity cascade, CI recovery, or the #787 autonomous recovery
controller.

Separately, `.github/workflows/auto-tag-release.yml` tags on subject + `core/package.json` version
match only; it never opens FRG evidence. A hand-authored `release: X.Y.Z — …` commit on `main` can
therefore tag without a representative (or any) FRG pass, even though `pipeline release` would
have refused.

Constraints:

1. Rigor-preserving: strengthen the gate; do not loosen K, max rate, or review coverage.
2. Threshold *values* (K=2, max engine-class rate 0.25) stay fixed in this issue — only become
   empirically reviewable via a trend ledger.
3. Layer A remains hermetic (no real network/git/subprocess). Layer B remains operator/CLI live.
4. Golden rule #4: FRG still never merges or creates tags as a side effect of scoring; auto-tag
   remains the tag owner but must consult FRG evidence first.
5. Reuse durable loop ledger + FRG evidence schema; do not invent a second advance engine.
6. Synthetic pack auto-close (#754) is out of scope (behavior retained as already specified).
7. `.agent-pipeline/frg/` is **not** gitignored (unlike `runs/`, `history/`, `evals/`) — evidence
   **can and must** be committed on the release PR so auto-tag’s fresh checkout sees it.

## Goals / Non-Goals

**Goals:**

- Make release-eligible FRG pass require a **representative** pack composition with
  machine-readable per-dimension evidence.
- Define a **computable** engine-class rate whenever ≥1 item was processed (denominator fixed).
- Append a **trend ledger** entry per Layer B evidence write with explicit idempotency/fail-soft.
- Document bootstrap derivation of K=2 / 25%.
- Guard **auto-tag** with the **same** release-eligibility validator as `factory-gate` /
  `parseFrgEvidence`, before any tag create/push.
- Expose scenario observations through a **documented CLI** surface with schema validation.
- Refresh **full** Layer A waiver inventory (both current waivers cite closed issues).
- Make forged minimal `pass: true` evidence fail semantic validation (scoreboard math,
  composition, provenance).

**Non-Goals:**

- Changing numeric K or max engine-class rate values.
- Synthetic pack auto-close redesign (#754).
- Auto-merge or unattended merge.
- Replacing product milestones with FRG work-lists.
- Cryptographic signing / trusted attestation of evidence (out of scope; residual hand-crafted
  full-schema forgery remains theoretically possible — see Decision 4 integrity bar).
- Full automated chaos injection without operator fixtures (observation CLI + Layer A hermetic
  coverage for classes that fit fake deps).

## Decisions

### Decision 1 — Durable evidence contract (paths, latest pointer, commit bar)

**Stable paths** (repository root; same as today):

```text
.agent-pipeline/frg/<X.Y.Z>/<frg-run-id>/evidence.json   # immutable primary
.agent-pipeline/frg/<X.Y.Z>/latest.json                  # full evidence copy (lookup pointer)
.agent-pipeline/frg/trend-ledger.jsonl                   # append-only trend (new)
```

**`writeFrgEvidence` semantics (extend existing atomic rename pattern):**

1. Write `evidence.json` via tmp + `rename` under `frg/<version>/<run_id>/`.
2. Overwrite `latest.json` for that version via tmp + `rename` with the **same body** as the
   immutable evidence (existing behavior).
3. Append one trend-ledger line (Decision 6) after primary success; fail-soft on ledger I/O only.

**Commit / auto-tag availability:**

- `.agent-pipeline/frg/` is intentionally **trackable** (not listed in root `.gitignore`).
- Layer B operators **must** include at least `.agent-pipeline/frg/<X.Y.Z>/latest.json` (and
  preferably the sibling `…/<run_id>/evidence.json`) in the **release PR tree** so that after
  merge, `auto-tag-release.yml`’s `actions/checkout` sees the artifact at the release commit.
- A worktree-local-only write that is never committed **correctly fails** auto-tag (fail closed).
- Runbook documents this as a hard operator step; `pipeline release` continues to refuse without
  a local pass artifact and already embeds FRG in the PR body — implementation also documents
  that the **files** must land on the release branch, not only the body section.

**Schema version:** remain `FRG_SCHEMA_VERSION = 1` with **additive** fields
(`composition`, optional `recovery_aggregates`, optional `integrity`) so existing parse can grow
without a hard break for offline tooling; parsers that require release-eligibility SHALL reject
missing additive fields when `pass: true`.

### Decision 2 — Single strict release-eligibility validator

**Single source of truth:** extend `isReleaseEligibleFrgPass` (and have `parseFrgEvidence` /
`computeFrgEvidence` / auto-tag all call it) so release-eligibility is not “`pass: true` alone.”

A versioned evidence object is release-eligible only when **all** hold:

| Check | Rule |
|-------|------|
| `pass === true` | After re-deriving eligibility (writer and parser refuse inconsistent `pass`) |
| Schema | `schema_version === FRG_SCHEMA_VERSION`; parseable |
| Version binding | `evidence.version === X.Y.Z` under validation (auto-tag passes detected version) |
| Provenance | non-empty `run_id`, non-empty `loop_run_id`, `pack_id === factory-gate-v1` |
| Scenarios | exact `FRG_SCENARIO_IDS` set; enforceRequiredScenarioCriteria; frgScenariosPermitPass; capacity observed ≥ N |
| Scoreboard integrity | `item_count === per_item.length ≥ 1` (empty pack never release-eligible); counts match `per_item` class tallies; `engine_class_rate` finite in `[0,1]` and equals `engine_class_count / item_count` when `item_count ≥ 1` |
| Representative composition | every required composition dimension present and `status === "pass"` (Decision 5) |
| Recovery controller | both `recovery-controller-one-item` and `recovery-controller-multi-item` dimensions pass |
| False human_authority | `composition.false_human_authority_count === 0` (or equivalent) for injected recoverables |
| Integrity block | present and consistent (Decision 4) |

**Shared entry for CLI + workflow:**

- Export `validateReleaseEligibleFrgEvidence(raw, expectedVersion: string): FrgEvidence` that
  parses, re-runs eligibility, and throws/returns structured failure reasons.
- Auto-tag step invokes a thin Node entry (e.g. `node --experimental-strip-types
  core/scripts/factory-reliability-gate.ts --validate-tag <version>` **or** a dedicated
  one-liner script under `scripts/` that imports the same export) **after** version match and
  tag-not-exists, **before** “Create and push annotated tag”.
- Drift-guard in `core/test/auto-tag-release-workflow.test.ts` asserts step presence **and**
  ordering before tag create/push.

### Decision 3 — Engine-class rate and classification (precise)

When `item_count ≥ 1`:

```text
engine_class_rate = engine_class_count / item_count
```

- **Unit of count:** each processed pack item appears **exactly once** in `per_item` and
  contributes **at most one** taxonomy class.
- `engine_class_count` = number of items with `blocker_class === "engine-class"`.
- Multiple recovery events / attempts on the **same** item do **not** multi-count; the item’s
  terminal projected class wins (existing `itemsFromLoopLedger` projection: one row per item).
- Typed exhaustion that projects to `workflow-engine-defect` / engine-class themes increments
  that item once as engine-class.
- Unclassified clean items: `blocker_class === null`, not engine-class; they **are** in the
  denominator.
- `human_authority` / `product-class` counts remain on the scoreboard; they are **not** the
  rate denominator.
- Zero engine-class → rate `0` (never `null` / `n/a` when `item_count ≥ 1`).
- `item_count === 0` → not release-eligible; do not emit release `pass: true`.
- Reject non-finite numeric inputs at parse (`NaN`, `Infinity`).

**BREAKING vs current code:** today rate = engine / (engine+product+human) and `null` when
classified === 0.

### Decision 4 — Evidence provenance / anti-bypass integrity

Goal: a hand-authored stub `{ "pass": true, "run_id": "x", … }` must **not** parse as
release-eligible.

**Integrity bar (this change):**

1. **Full-schema parse** already rejects incomplete scenario sets and inconsistent `pass`.
2. **Scoreboard cross-checks** (Decision 2) reject invented rates/counts that do not match
   `per_item`.
3. **Composition block required** for `pass: true` (Decision 5) — clean-only stubs fail named
   dimensions.
4. **`integrity` object** written by `computeFrgEvidence` / `writeFrgEvidence`:
   - `producer`: literal `"pipeline-factory-gate"`
   - `scoreboard_fingerprint`: stable hash of canonical `per_item` + counts + rate
   - `composition_fingerprint`: stable hash of composition dimensions
   - Validator recomputes fingerprints; mismatch → unparsable / not release-eligible
5. Auto-tag and `lookupFrgPass` use the same validator.

**Residual risk (accepted):** a determined operator can craft a full valid document by hand.
Mitigation is operational (evidence produced by `pipeline factory-gate` from a real loop) plus
semantic hardness. Cryptographic signing is out of scope.

**Rejected:** Trust release PR body FRG markdown alone; optional skip secret; re-running live
FRG inside Actions.

### Decision 5 — Representative composition (machine-readable)

Add additive `composition` on `FrgEvidence`:

```ts
composition: {
  dimensions: Array<{
    id: FrgCompositionDimensionId;
    status: "pass" | "fail" | "not_observed";
    source: "ledger" | "observation" | "layer_a" | "derived";
    detail: string;
    /** Optional numeric proof (e.g. capacity N, controller entry counts). */
    observed?: number | null;
  }>;
  /** Injected recoverable classes wrongly projected human_authority. */
  false_human_authority_count: number;
  missing: string[]; // dimension ids failing / not_observed (empty when all pass)
}
```

**Required dimension ids** (stable kebab-case; freeze in code constant):

| Id | Layer B required? | Layer A | Proof |
|----|-------------------|---------|-------|
| `openspec-bearing-item` | yes | partial (openspec-multi-change) | ≥1 item with real OpenSpec change / archive path |
| `fix-rereview-cycle` | yes | no (live/observation) | ≥1 blocking finding → fix → re-review |
| `concurrency-contention` | yes | yes (capacity-blocked-retain) | observed concurrency / capacity retain ≥ N=2 |
| `managed-worktree-dirt` | yes | yes (implement-lockfile-dirt + dirt/missing coverage) | observed or hermetic + live observation |
| `process-restart-hydration` | yes | yes (resume-mid-flight) | process death + fresh resume |
| `forge-http-5xx-backoff` | yes | prefer hermetic if seam exists else observation | 5xx + bounded backoff |
| `ci-pending-red-recovery` | yes | prefer hermetic / observation | pending/red CI recovery |
| `same-head-noop-reentry` | yes | prefer hermetic / observation | same-HEAD no-op re-entry |
| `capacity-live-run-coexistence` | yes | capacity tests + observation | concurrent capacity + live-run |
| `recovery-controller-one-item` | yes | partial | production controller via **`pipeline single <N>`** |
| `recovery-controller-multi-item` | yes | partial | production controller via **`pipeline loop`** (multi-item) |

**Observation file schema** (`--observations <path>`):

```json
{
  "schema_version": 1,
  "scenarios": [
    { "id": "<FrgScenarioId>", "status": "pass|fail|warn|not_observed", "detail": "...", "observed": 2, "threshold": 2 }
  ],
  "composition": [
    { "id": "<FrgCompositionDimensionId>", "status": "pass|fail|not_observed", "detail": "...", "observed": null }
  ]
}
```

- Unknown scenario/composition ids → hard reject (CLI exit non-zero before scoring).
- Missing required composition dimension after merge with ledger projections →
  `not_observed` / fail release-eligible; `missing[]` names each.
- Auto-scored scenarios (`clean-item-throughput`, `blocker-taxonomy`) still derived from ledger;
  observation file cannot loosen numeric capacity / rate rules (`enforceRequiredScenarioCriteria`).
- `frgRequiredObservationOverrides` remains **test-only**.

Clean-only #749/#750-class packs fail composition with machine-readable missing dimensions even
when K is met.

### Decision 6 — Trend ledger append semantics

Path: `.agent-pipeline/frg/trend-ledger.jsonl`

**Entry fields (minimum):** `version`, `run_id`, `loop_run_id`, `pass`, `pack_id`, `created_at`,
`item_count`, `ready_clean_count`, `engine_class_count`, `engine_class_rate`, `thresholds`,
optional `recovery_aggregates`, optional composition summary.

**Idempotency key:** `(version, run_id)`. Re-append of the same key is a no-op (skip duplicate
line) so retries do not double-count.

**Atomicity:** append via write-to-temp-in-same-dir + `rename` of the full file **or**
`O_APPEND` single-line write with exclusive open; tests inject fs deps. Concurrent writers on
one host: last-writer for full-file rewrite must re-read and merge by key; prefer simple
read-merge-write under the existing host-local concurrency scope (same as other `/tmp` locks —
document single-host).

**latest.json:** still the per-version evidence pointer; ledger is history, not a substitute.

**Fail-soft:** if primary `evidence.json` + `latest.json` succeeded and ledger append fails:
report on stderr / notes, do **not** delete evidence, do **not** flip `pass`. Operator can
rebuild ledger from `frg/*/…/evidence.json` trees (runbook).

### Decision 7 — Measurable recovery bounds and #787 entry points

Replace vague “bounded convergence” with policy-backed limits already in-tree:

| Injected class | Canonical durable class / path | Bound |
|----------------|--------------------------------|-------|
| forge HTTP 5xx / rate limit | `transient-rate-limit` | `DEFAULT_RECOVERY_POLICY` retry_budget **5**, backoff max 900s |
| workflow / OpenSpec state | `workflow-state` | retry_budget **3**, max 300s |
| pending/red CI | `implementation-ci` | retry_budget **3**, max 600s |
| review fix cycle | `review-findings` | retry_budget **3** |
| process death / restart | `workflow-engine-defect` / resume path | retry_budget **2**; Layer A resume-mid-flight |
| capacity pressure | capacity schedule + worktree | N=`capacity_stress_n` (2); no false needs-human solely for capacity |
| same-HEAD no-op | noop-advance / verify_head_goal | must not false `human_authority` |
| true human holds | `missing-authority`, `specification-decision` | retry_budget **0**, terminal `human_authority` (legitimate) |

**Controller entry points (production #787 path):**

1. **One-item:** `pipeline single <N>` → durable one-item drive (`pipeline.ts` single command →
   loop supervisor recovery).
2. **Multi-item:** `pipeline loop --label factory-gate` (or allowed FRG milestone) → multi-item
   supervisor + `loop/recovery.ts` (`startRecoveryAttempt` / `completeRecoveryAttempt` /
   `recoverItem`).

Release-eligible composition requires both entry dimensions pass. Recovery success, exhaustion,
resumes, and elapsed-by-reason feed optional `recovery_aggregates` on evidence + ledger:

```ts
recovery_aggregates?: {
  by_reason: Record<string, { success: number; exhaustion: number; resumes: number; elapsed_ms: number }>;
}
```

False `human_authority` for injected recoverables (classes with non-zero automated recipe
budget) fails release-eligible pass via `false_human_authority_count > 0`.

### Decision 8 — Layer A waiver inventory (complete enumeration)

**Current inventory in code** (`FRG_LAYER_A_WAIVERS` / `FRG_SCENARIO_OWNERSHIP`):

| Scenario | Current Layer A | Tracking | Issue state (as of plan revision) | Disposition this change |
|----------|-----------------|----------|-------------------------------------|-------------------------|
| `capacity-blocked-retain` | test | — | — | keep test |
| `resume-mid-flight` | test | — | — | keep test |
| `openspec-multi-change` | test | — | — | keep test |
| `implement-lockfile-dirt` | test | — | — | keep test |
| `local-docs-parity` | test | — | — | keep test |
| `clean-item-throughput` | test | — | — | keep test; rate formula updates |
| `blocker-taxonomy` | test | — | — | keep test; rate formula updates |
| `pr-supersession` | **waiver** | **#729** | **CLOSED** | refresh: land hermetic/drift test **or** open-issue retarget — **prefer test** if feasible in-repo; else file/open tracking and point waiver there |
| `release-plan-row` | **waiver** | **#730** | **CLOSED** | refresh: land hermetic/drift test covering release-cut / **auto-tag FRG guard** honesty (this change’s tag path) **preferred** |
| `empty-depends-on-stack-honesty` | test | — | — | keep test |

There are **exactly two** waived scenarios; both cite closed issues. “Other closed-issue
waivers” is **not** open-ended — the inventory is these two rows only. After refresh, waiver
table and runbook match code; closed-only citations forbidden.

### Decision 9 — Observation CLI surface

```bash
pipeline factory-gate --for X.Y.Z --from-run <loop-run-id> \
  --observations path/to/observations.json
# optional additive:
# --scenario id=status:detail[:observed=N]
```

Wire into existing `FactoryGateOpts.scenarioOverrides` + new composition override path. Document
in `docs/factory-reliability-gate-runbook.md` and `docs/cli.md`. Usage string / commander options
in `pipeline.ts`.

### Decision 10 — Retire #749/#750 as non-representative

Runbook marks #749/#750-class clean composition items as **retired fixtures** for
release-eligible FRG. Gate refuses clean-only packs regardless of issue open/closed state.
Closing GitHub issues is process work during/after implementation.

### Decision 11 — Auto-tag FRG guard placement

In `.github/workflows/auto-tag-release.yml`, after:

1. detect release subject  
2. version match `core/package.json`  
3. tag does not already exist  

and **before** “Resolve release notes” / “Create and push annotated tag” (FRG must fail closed
before any tag side effect; notes resolution may stay before or after FRG but **tag create/push
must not run** without FRG pass — prefer FRG check immediately after exists=false):

- Step: validate `.agent-pipeline/frg/<version>/latest.json` via shared Node validator with
  `expectedVersion` from detect output.
- Failures: missing, unparsable, `pass: false`, not release-eligible, version mismatch →
  exit non-zero, no tag.
- Non-release pushes: unchanged successful no-op (no FRG required).
- Existing-tag: unchanged no-op.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Representative pack is slower every release | Fixed pack still dedicated; composition is minimum dimensions; K stays 2 |
| Evidence must be committed for auto-tag | Not gitignored; runbook + release procedure require commit of `latest.json`; fail closed is correct |
| Full-schema hand-forge still possible | Integrity fingerprints + composition + scoreboard math; signing out of scope |
| Observation CLI gamed with fake passes | Numeric re-validation; prefer ledger-derived composition where possible; missing dims fail |
| Ledger I/O failure | Fail-soft after primary write; rebuild documented |
| Both waivers closed | Enumerated; both refreshed this change |

## Migration Plan

1. Land schema/scoring/CLI/runbook/tests + auto-tag guard.
2. Update FRG runbook (composition, CLI, rate, ledger, bootstrap note, retired fixtures, commit bar).
3. Next release: representative pack → `factory-gate` → commit evidence on release PR → merge → auto-tag validates.
4. Close/label-retire #749/#750 when replacements exist.
5. Rollback: revert PR; auto-tag loses FRG check only if workflow reverted.

## Open Questions

_(Resolved at plan revision)_

1. **Committed evidence:** tree-committed `latest.json` under `.agent-pipeline/frg/` (not
   Actions artifact-only). Artifact-only is a follow-on if operators object.
2. **Composition shape:** nested `composition` object (Decision 5), not only free-floating
   scenario ids — clearer failure reasons and avoids exploding `FRG_SCENARIO_IDS` for every
   recovery class (scenarios remain the existing pack set; composition is parallel).
3. **Recovery aggregates:** additive optional map; absence fails only when composition claims
   controller exercise without any recoverable signal **if** we can detect that — minimum bar is
   composition dimension status pass via observation/ledger, aggregates preferred for ledger.
