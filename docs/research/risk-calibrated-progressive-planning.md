# Risk-calibrated progressive planning (research note)

**Issue:** #703  
**OpenSpec change:** `risk-calibrated-progressive-planning`  
**Depends on:** #702 (planning-leverage / assumption lineage / material rework), #576 (production/rework outcomes)  
**Status:** Research package only. Automated planning-depth routing is **off**.  
**Vocabulary version:** `progressive-planning-v1`  
**Future staged policy id:** `progressive_planning_depth` (lifecycle state for this package: **`draft`** — not observe, not enforcing)

This note defines candidate work/risk classes, closed routing actions, escalation and safe defaults, human-authority boundaries, assumption-lineage carry-forward, offline evaluation and calibration, and the evidence-sufficiency gate before any future automation. It does **not** select `planning_depth` in the advance loop.

Related:

- [Planning-leverage and material-rework telemetry](../concepts.md#planning-leverage-and-material-rework-telemetry) (#702)
- OpenSpec design: `openspec/changes/risk-calibrated-progressive-planning/design.md`
- Pure offline helpers (optional): `core/scripts/progressive-planning/` — recommendation composition only; no advance wiring

---

## 1. Evidence inventory (prerequisites)

Inventory date for this research package: **2026-08-15** (implementation host for #703). Counts are host-local observations only; they are **not** fleet rates.

### 1.1 #702 planning-leverage / assumption / material-rework

| Source | Coverage observed on this host |
| --- | --- |
| Event types | `planning_leverage_phase`, `assumption_lineage`, `material_rework`, `planning_leverage_snapshot` (schema present in `core/scripts/planning-leverage/`) |
| Scoreboard section | `planning_leverage` on `pipeline scoreboard` (depth/risk histograms, materiality, assumption counts) |
| Runs with PL family events | **n = 0** on this host under `~/.agent-pipeline` and worktree-local stores |
| Depths / risk classes with samples | **all classes n ≈ 0** (no observed histogram) |
| Primary-tree event files | 77+ `events.jsonl` paths under ap-main-control trees; **0** lines of PL family types (emitters landed with #702; representative production windows not yet accumulated here) |

Gaps (do **not** invent rates):

- No per-depth or per-risk_class sample sizes yet.
- No material-rework rate by cohort.
- No open-assumption distributions at plan end.
- `observed_rework_cost` class cannot be calibrated from history until windows accumulate.

### 1.2 #576 production-outcome join coverage

| Source | Coverage observed on this host |
| --- | --- |
| Outcome schema / store | Present (`core/scripts/outcomes/`) |
| PL → `production_outcome` attribution | Linkage helpers exist; require durable outcome ids |
| Runs with joinable production outcomes | **n = 0** on this host for progressive-planning inventory |
| Observed vs inferred authority mix | **unavailable** (no attributions to partition) |

Gaps:

- Post-merge follow-up / reversion / escaped-defect rates by planning depth × risk class are **not** yet estimable.
- Offline eval must label production metrics `unavailable` until joins exist — never zero-fill as “no rework.”

### 1.3 Evidence-sufficiency implication

This research change **documents** policy and evaluation design. It **does not** promote staged policy `progressive_planning_depth` beyond **`draft`**. Promotion toward `observe` / `enforcing` requires the checklist in §7 after representative #702 and #576 windows exist.

---

## 2. Candidate work/risk classes

Classes are a **closed, multi-label** vocabulary of evidence dimensions. They are **not** a single numeric risk score and **not** an expected-pain float.

Assignment rules:

1. Use only **observable** structural signals, **declared** issue/OpenSpec/operator markers, or **observed historical** joins with explicit authority.
2. A run may match **multiple** classes.
3. When allowed sources for a class are missing or unreadable, that class is **absent** (or the set resolves to `unknown`) — never fabricate matches or rates.
4. LLM free-text “feels risky” is advisory only; it is **not** a standalone automation-class assignment.

### 2.1 Class catalog (`progressive-planning-v1`)

| Class id | Allowed evidence sources | Does **not** assign the class |
| --- | --- | --- |
| `ambiguity` | Conflicting acceptance criteria in issue/body; missing AC sections; high open_question count at plan end (`assumption_lineage` kind `open_question` status open); OpenSpec design open questions left unresolved | Long issue body alone; many tasks that are fully specified; open questions that are already `resolved` |
| `reversibility` | Declared destructive ops (data wipe, force-push, shared-state mutation); migrations without documented rollback; irreversible config/schema drops in plan or design | Ordinary reversible code edits; feature flags with documented kill switch; migrations with automated rollback path documented in-repo |
| `blast_radius` | Multi-package / multi-repo scope; public API or schema breaks; infra/deploy surface; path-prefix growth beyond declared module; `public-api` / `architecture` pre-code triggers | Single-module private change; docs-only; test-only; scoped internal API with no external consumers declared |
| `novelty` | First use of external integration in-repo; new subsystem directory with no pattern match; operator-declared “greenfield” marker | New file in an established pattern (e.g. another stage file under `core/scripts/stages/`); copy-extend of existing module |
| `dependency_uncertainty` | Open `Depends on` / blocked-on issues not closed; unresolved external dep versions; declared dependency grammar targets not ready | Closed dependencies; soft “nice-to-have” references without blocking semantics |
| `security_compliance` | AuthN/AuthZ, secrets, PII, regulated data, privilege elevation; pre-code `auth` trigger; compliance/audit markers in issue or design | Mention of “security” in prose without surface touch; security **docs** only with no code path to auth/secrets/PII |
| `observed_rework_cost` | Historical #702 material rework rates and #576 production follow-up for **prior completed** depth×risk cohorts with `authority: observed` preferred; must satisfy the pre-routing provenance contract (§2.3) | Invented rates; inferred joins treated as observed; n below sample floor (see §7); **any** material_rework / review / production_outcome belonging to the **target run** or completed after `recommendation_as_of` |
| `unknown` | No class matched after allowed sources checked; or evidence unreadable | Used as a **bucket for insufficient evidence**, not a claim of safety |

### 2.3 Pre-routing provenance for `observed_rework_cost`

`history_available` / `history_elevated` MUST be computed only from completed work available **before** the target recommendation. Composition rejects elevation when provenance is missing or invalid (`history_provenance_rejected`).

| Field | Rule |
| --- | --- |
| `recommendation_as_of` | ISO-8601 instant of composition |
| `history_cutoff_at` | Upper bound for cohort membership; MUST be ≤ `recommendation_as_of` |
| `target_run_id` | Run being routed; MUST NOT appear in `cohort_run_ids` |
| `cohort_run_ids` | Prior completed runs that contributed rates |
| `cohort_completed_at[run_id]` | Required for each cohort id; MUST be `< recommendation_as_of` and ≤ `history_cutoff_at` |

**Forbidden inputs (outcome leakage):**

- Target-run `material_rework`, fix-round, review_effort, or `production_outcome` records
- Any cohort run with `completed_at ≥ recommendation_as_of`
- Missing provenance object when `history_available: true`

Pure helper: `validateObservedReworkProvenance` in `core/scripts/progressive-planning/compose.ts`.

### 2.4 Per-class evidence provenance (every asserted class)

Every progressive class assertion that contributes an action floor MUST carry **immutable pre-routing evidence**:

| Field | Rule |
| --- | --- |
| `evidence[].ref` | Non-empty stable pointer (path glob, label, design marker, prior run id, event id) |
| `evidence[].source_kind` | Closed allowed set only: `structural` \| `declared` \| `historical_observed` |
| `evidence[].observed_as_of` | ISO-8601; MUST be ≤ `recommendation_as_of` (pre-routing) |

**Forbidden source kinds for class assignment** (rejected; no elevation):

| Kind | Why |
| --- | --- |
| `outcome_derived` | Target-run material_rework / production_outcome / fix-round after routing |
| `post_routing` | Evidence timestamp after `recommendation_as_of` |
| `llm_free_text` | Not a standalone automation class assignment |

**Composition behavior:**

- Structured class entries without valid evidence → `class_evidence_missing` or `class_evidence_rejected`; class is **not** matched; no action floor from it.
- Bare string class shorthand without evidence → same rejection when `require_class_evidence` is true (default).
- `unknown` may omit evidence (bucket for insufficient evidence).
- Refs encoding `production_outcome:…`, `material_rework:target…`, or `outcome_derived:…` are rejected even if `source_kind` is mislabeled as structural.

Pure helpers: `validateClassEvidenceRef`, `validateClassEvidenceAssignment` in `compose.ts`.

### 2.2 Mapping to planning-leverage `risk_class` / pre-code triggers

Progressive-planning classes are **orthogonal multi-label evidence dimensions**. Planning-leverage telemetry continues to use the closed pre-code + `unknown` set (`architecture`, `auth`, `storage`, `migration`, `public-api`, `large-diff`, `unknown`) as `risk_class` / `risk_classes` on phase records.

| Progressive class | Typical PL / pre-code joins (when present) |
| --- | --- |
| `security_compliance` | `auth` (+ declared compliance markers) |
| `blast_radius` | `public-api`, `architecture`, `large-diff` |
| `reversibility` | `migration`, storage destructive scope |
| `novelty` | often `unknown` or no pre-code class until structure appears |
| `observed_rework_cost` | join key = prior PL `planning_depth` × `risk_class` cohorts |
| `ambiguity` / `dependency_uncertainty` | not pre-code triggers; use lineage / dependency grammar |

Do **not** collapse progressive classes into a single PL `risk_class` string for routing. Multi-label progressive sets may coexist with multi-label PL `risk_classes[]`.

---

## 3. Closed routing actions

### 3.1 Vocabulary

| Action id | Meaning |
| --- | --- |
| `lightweight_plan` | Minimal planning treatment; short AC + approach; no extra feasibility zoom |
| `standard_plan` | Default planning treatment (current engine default posture) |
| `deepen_product` | Extra product / AC alignment before technical design |
| `deepen_technical` | Extra technical design (interfaces, data model, failure modes) |
| `zoom_feasibility` | Explicit feasibility / spike / interface-contract section |
| `zoom_vertical_slice` | Plan a thin vertical delivery slice first |
| `preserve_assumptions` | Force open/deferred assumptions into carry-forward review surfaces |
| `request_human_authority` | Park or hard-gate until **human** authority (not agent plan-review) |

Free-form action strings outside this set are **invalid** for machine-readable recommendations.

### 3.2 Severity partial order (most-restrictive composition)

Primary depth-like actions (exclusive pick by max severity):

```text
lightweight_plan < standard_plan < deepen_product ≈ deepen_technical
  < zoom_feasibility ≈ zoom_vertical_slice < request_human_authority
```

**Provisional hypothesis (not calibrated policy):** This total order and the non-safety class floors in §3.3 (`ambiguity`→`deepen_product`, `novelty`→`zoom_feasibility`, etc.) are **starting hypotheses** for offline fixtures. They are **not** retained as calibrated conclusions until #702/#576 cohort results show acceptable FP/FN tradeoffs relative to materially plausible alternative orderings (e.g. swapping zoom vs deepen tiers, or flooring `novelty` at `deepen_technical`). Safety floors that map incomplete `security_compliance` / irreversible work without rollback to `request_human_authority` remain fail-closed defaults independent of that calibration; only their **coexistence** with non-safety floors is re-ranked by evidence. **Evaluation result required to retain:** hold-out window report (§7) with per-class FP/FN and a sensitivity table against at least one alternative severity order; retain only if FP/FN stay within the operator-accepted band documented in that report.

Stacking rules:

- `preserve_assumptions` **stacks** with any depth action; it never replaces deepen/zoom/human.
- When both `deepen_product` and `deepen_technical` apply at the same tier, record **both** action ids; `recommended_planning_depth` is still `deep`.
- When both `zoom_feasibility` and `zoom_vertical_slice` apply, record **both**; depth remains `deep`.
- `request_human_authority` **dominates**: if its criteria fire, it is always included; primary action is `request_human_authority`.

### 3.3 Class × evidence → action mapping

| Matched class / evidence state | Primary action floor | Stacks |
| --- | --- | --- |
| No signals matched | `standard_plan` | `preserve_assumptions` if any open/deferred assumptions or open_questions |
| `ambiguity` (declared/observed open questions or conflicting AC) | `deepen_product` | `preserve_assumptions` |
| `novelty` | `zoom_feasibility` | `preserve_assumptions` if open items |
| `dependency_uncertainty` | `zoom_vertical_slice` or `deepen_product` when deps block product shape | `preserve_assumptions` |
| `blast_radius` (structural/declared) | `deepen_technical` | `zoom_feasibility` when public API/schema; `preserve_assumptions` |
| `reversibility` without automated rollback path | `request_human_authority` | `deepen_technical`, `preserve_assumptions` |
| `reversibility` with documented automated rollback | `deepen_technical` | `preserve_assumptions` |
| `security_compliance` complete sub-signals | `deepen_technical` + consider `request_human_authority` per §5 | `preserve_assumptions` |
| `security_compliance` **incomplete** sub-signals | `request_human_authority` | `deepen_technical`, `preserve_assumptions` — **never** `lightweight_plan` |
| `observed_rework_cost` high (observed history, sample floor met) | raise floor one tier above current structural recommendation (cap at human authority when history shows production follow-up on light depth) | `preserve_assumptions` |
| `observed_rework_cost` unavailable | **ignore class** (do not invent rates); use structural/declared only | — |
| `unknown` only | `standard_plan` | `preserve_assumptions` if open items — **not** forced `lightweight_plan` |
| Lightweight-favoring signal (e.g. docs-only, single private module) **and** no high-severity class | `lightweight_plan` | `preserve_assumptions` if open items remain |
| Lightweight-favoring **and** any of security / irreversibility / high blast / incomplete high-severity | **most restrictive wins** (not lightweight alone) | as required by high-severity class |
| Conflicting signals | more restrictive mapping | record `conflict` diagnostic |

Composition algorithm (offline / future observe-mode):

1. Collect matched progressive classes + evidence completeness flags.
2. Map each to an action floor (table above).
3. Take **max severity** primary action; union stackable actions.
4. If open/deferred assumptions exist and primary is `lightweight_plan` or `standard_plan`, attach `preserve_assumptions`.
5. If any human-authority boundary in §5 fires, force `request_human_authority`.
6. Emit diagnostics: `conflict`, `history_unavailable`, `subsignal_incomplete`, `unknown_default` as applicable.
7. Map to `recommended_planning_depth` (§3.4). Do **not** apply to the run in this research change.

### 3.4 Recommended `planning_depth` mapping

Uses only the existing #702 closed set: `minimal` | `standard` | `deep` | `unknown`.

| Primary routing action | `recommended_planning_depth` |
| --- | --- |
| `lightweight_plan` | `minimal` |
| `standard_plan` | `standard` |
| `deepen_product` | `deep` |
| `deepen_technical` | `deep` |
| `zoom_feasibility` | `deep` |
| `zoom_vertical_slice` | `deep` |
| `request_human_authority` | `deep` (depth recommendation for post-authority planning; human gate is separate) |
| insufficient to map | `unknown` |

Sub-actions stay in the action id field; they do **not** invent new depth enum values.

---

## 4. Escalation boundaries and safe defaults

| Evidence state | Default |
| --- | --- |
| No signals matched **and** high-severity predicate scan complete | `standard_plan` (+ `preserve_assumptions` if open questions/assumptions); diagnostic `unknown_default` |
| High-severity predicate scan **incomplete** (declarations/structure not checked) | **Not** ordinary `standard_plan`: floor `deepen_technical` + `preserve_assumptions`; diagnostic `high_severity_scan_incomplete` — never `lightweight_plan` / never `unknown_default` |
| Conflicting signals (e.g. “low risk” label vs `auth` / public-api structural) | Prefer **more restrictive** action; record conflict diagnostic |
| Structured safety conflicts (§4.1) | Fail closed to elevating floor; **never** ordinary `standard_plan` or `lightweight_plan` |
| Historical rework / production data unavailable | Do not invent rates; omit `observed_rework_cost`; structural/declared only |
| Historical rates claimed without valid pre-routing provenance (§2.3) | Treat as unavailable (`history_provenance_rejected`); structural/declared only |
| Irreversible / high-blast / security / compliance matched with incomplete sub-signals | Floor: `request_human_authority` or documented `deepen_technical` + `preserve_assumptions` — **never** `lightweight_plan` solely for missing history |
| Lightweight recommended but open/deferred assumptions remain | **MUST** attach `preserve_assumptions` |
| Stale evidence (expired attestation, superseded dossier) | Treat high-severity classes as incomplete → fail closed per §5 |

**Fail-closed principle:** silent under-planning of irreversible, high-blast, security, or compliance work is forbidden. Unknown non-high-severity work fails to **standard**, not minimal — and only after the high-severity scan attests that those predicates were evaluated.

**High-severity scan (precondition for `unknown_default` → `standard_plan`):** before the no-signals branch may select ordinary `standard_plan`, the caller MUST evaluate the §5.1 / §5.3 predicates using **structural and declared** sources (pre-code path/label triggers, design-gate classes, issue/OpenSpec markers, path-prefix scope). Omitting that scan (`high_severity_scan_complete: false`) is an adversarial / incomplete-input case: composition fails closed to deepen, not to standard. Empty `classes` with `high_severity_scan_complete: true` means “scan finished; no match,” not “scan skipped.”

### 4.1 Safety evidence conflict matrix (declared vs structural)

When declared markers and structural signals **contradict** on a safety dimension, composition records `safety_conflict` + `conflict` and applies the **elevating** floor. Clearing declarations never override elevating structure.

| Dimension | Declared clearing + structural elevating (and reverse) | Conservative floor | May reach standard/lightweight? |
| --- | --- | --- | --- |
| `rollback` | e.g. issue says “has rollback” but plan has DROP without reverse migration | `request_human_authority` + `deepen_technical` + `preserve_assumptions` | **No** |
| `security` | e.g. “docs only / not security” label vs pre-code `auth` path | `request_human_authority` + `deepen_technical` + `preserve_assumptions` | **No** |
| `compliance` | e.g. no compliance label vs regulated retention control in design | `request_human_authority` + `deepen_technical` + `preserve_assumptions` | **No** |
| `blast_radius` | e.g. “single module” claim vs multi-package public-api structural match | `deepen_technical` + `zoom_feasibility` + `preserve_assumptions` | **No** |

Representation: `ComposeRoutingInput.safety_conflicts[]` with `{ dimension, declared_polarity, structural_polarity }` where polarity ∈ {`elevating`,`clearing`}. Same-polarity pairs are not contradictions; elevating-only still applies the floor. Pure helper: `resolveSafetyConflicts`.

---

## 5. Human-authority boundaries

Human authority is a **closed checklist** with an operational data dictionary (§5.3). Satisfying it requires a real human sign-off event (operator disposition, audited authority record). The following do **not** count:

- Agent plan-review approve (including same-harness fallback)
- Optional human **feedback window** without explicit authority disposition
- Automated pre-code attestation alone (may be necessary but not sufficient for these floors when human boundary fires)
- Reviewer CLI verdicts on implementation PRs

### 5.1 Checklist (policy floor → `request_human_authority`)

Predicate ids (closed): `irreversible_no_automated_rollback` | `high_blast_radius` | `security_sensitive` | `compliance_sensitive` (see `HUMAN_AUTHORITY_PREDICATES` in schema).

1. **Irreversible (`irreversible_no_automated_rollback`):** production/data/shared-state mutation without a documented automated rollback path.
2. **High blast radius (`high_blast_radius`):** see §5.3 blast criteria — not limited to multi-tenant wording.
3. **Security-sensitive (`security_sensitive`):** AuthN/AuthZ model change, secret handling, privilege elevation, or security boundary move.
4. **Compliance-sensitive (`compliance_sensitive`):** regulated data processing change or audit-required control change.

When any predicate fires, routing includes `request_human_authority` (compose: `human_authority_boundary: true` or class floors for reversibility without rollback / incomplete security). Agent plan-review approval alone **does not** satisfy the boundary.

### 5.2 Distinction from plan-review and feedback window

| Mechanism | Role | Satisfies human-authority boundary? |
| --- | --- | --- |
| Agent plan-review | Machine/agent quality gate on plan | **No** |
| Optional human feedback window | Opportunity for comments; may be empty | **No** (unless explicit authority disposition recorded) |
| Human authority disposition | Operator-authorized gate for §5.1 classes | **Yes** |

Open/deferred assumptions must remain reconstructable on the handoff surface when parking for human authority (see §6).

### 5.3 Operational data dictionary (evidence required)

| Predicate id | Observable / declared evidence that **sets** the predicate | Evidence that **clears** or does not set | Borderline resolution |
| --- | --- | --- | --- |
| `irreversible_no_automated_rollback` | Plan/design names data wipe, DROP without reverse migration, force-push to shared branch, shared production secret rotation without dual-control rollback; `automated_rollback_documented !== true` on reversibility class | Feature-flag kill switch documented in-repo; forward+back migration pair committed; reversible config toggle with documented restore steps | **Sets:** single-repo schema DROP COLUMN of retained data with no down migration. **Does not set:** additive nullable column with documented down migration. |
| `high_blast_radius` | **Any one of:** (a) multi-tenant schema/API break; (b) cross-system / multi-repo coordinated cutover without staged rollout plan; (c) public API or wire-format break with external consumers declared or path-triggered (`public-api`); (d) **default-traffic deploy surface** per narrow criteria below (not ordinary app delivery); (e) path-prefix growth across ≥2 top-level packages **and** design-gate `architecture` / `large-diff` when coupled with public contract change | Single private module; docs-only; test-only; internal API with no external consumers declared and no `public-api` trigger; **ordinary production app release through existing CI/CD** | **Sets:** single-repo public REST field rename with external consumers in issue body. **Does not set:** rename of a non-exported helper in one package. **Sets:** change to deploy pipeline / CDN / auth gateway / ingress that alters default production traffic path, or forced all-tenant rollout without staged plan. **Does not set:** normal feature merge via existing pipeline; feature-flagged or canary rollout with documented staged plan; CI-only workflow with no deploy path. |
| `security_sensitive` | Pre-code / design-gate `auth` trigger; plan touches AuthN/AuthZ model, secret storage/handling, privilege elevation, or trust-boundary move; issue/OpenSpec security control change | Security **docs** only; mention of “security” in prose without code path to auth/secrets/PII | **Sets:** session cookie flags change. **Does not set:** README security section edit with no code. |
| `compliance_sensitive` | Explicit regulated-data marker (PII retention, audit log control, legal hold) in issue/OpenSpec; compliance label or design decision requiring audit control change | Generic “we should be careful” prose; unregulated telemetry wording without control change | **Sets:** change to audit-log retention period for regulated tenants. **Does not set:** adding an optional debug log in a non-regulated path. |

**How compose sets `human_authority_boundary`:** callers evaluate §5.3 with structural+declared sources and pass `human_authority_boundary: true` when any predicate sets. Class floors additionally force human authority for reversibility without `automated_rollback_documented: true` and for incomplete `security_compliance` sub-signals.

#### Default-traffic deploy criterion (narrow; not ordinary production delivery)

Predicate sub-clause (d) of `high_blast_radius` is **not** “any production deploy.” Ordinary application delivery through an existing pipeline does **not** set high blast by itself.

| Case | Sets high blast via deploy criterion? | Rationale |
| --- | --- | --- |
| App feature ships via existing CI/CD; no pipeline/infra change | **No** | Routine production delivery |
| Feature-flagged or canary rollout with documented staged plan | **No** | Staged / non-default path |
| CI-only workflow edit; no deploy path | **No** | No production traffic surface |
| Change to deploy pipeline, release infra, CDN, auth gateway, or cluster ingress that alters **default** production traffic path | **Yes** | Default-traffic path change |
| Forced all-tenant / default-traffic rollout without staged or canary plan | **Yes** | Unscoped blast |
| Capacity or routing cutover that moves default traffic | **Yes** | Default-traffic path change |

Pure helper: `isHighBlastDefaultTrafficDeploy` in `schema.ts` (positive/negative fixture cases in unit tests).

---

## 6. Assumption and open-question lineage under progressive depth

Compose with #702 `assumption_lineage` emitters (`core/scripts/planning-leverage/assumptions.ts`). Progressive routing **never**:

- deletes open/deferred assumptions because `planning_depth` is `minimal` or action is `lightweight_plan`
- omits open/deferred items from carry-forward projections solely due to light planning
- mints a second `assumption_id` for the same logical assumption when attaching `preserve_assumptions`

### 6.1 Traceability contract (count vs identity)

| Layer | Role |
| --- | --- |
| `assumption_lineage` event stream | Source of truth: `assumption_id`, `status`, `introduced_phase`, `resolved_in_phase`, statement |
| `projectAssumptionCurrentState` | Latest status per `assumption_id` for a `run_id` |
| `open_or_deferred_assumption_ids` | Compose input: explicit id list for open/deferred rows |
| `open_or_deferred_assumption_count` | Routing-only fallback when ids are not supplied; **does not** prove reconstructability |
| `preserved_assumption_ids` on recommendation | Echo of supplied ids; consumers re-join the lineage stream by `run_id` + id |

**Count vs id agreement:** when `open_or_deferred_assumption_ids` is non-empty, the open count is **derived** from the deduped id list. If the caller also supplies `open_or_deferred_assumption_count` and it **disagrees** with the deduped length, composition **throws** (`assumption_count_id_mismatch`) and produces **no** recommendation. Silent override of a contradictory count is forbidden.

**Reconstructability rule:** given a recommendation with `preserve_assumptions` and a run event stream, the open/deferred set MUST equal `projectAssumptionCurrentState(events, run_id)` filtered to status ∈ {`open`,`deferred`}. A count alone is insufficient for handoff surfaces.

Requirements:

- Lightweight, deep, and human-authority paths still carry the same `assumption_id` values.
- Implementation and review remain consumers of open items.
- `request_human_authority` handoff includes the open/deferred set from the run lineage stream (ids + statuses).
- Status transitions stay on the same `assumption_id` (`open` → `resolved` / `deferred` / `invalidated`).

---

## 7. Offline evaluation design

Evaluation is **batch/offline** over host-local run stores + outcome stores. It does **not** require live auto-routing. Causal claims are **not** required. **Associational rates alone are not sufficient for routing calibration** when planning depth is confounded with inherent task difficulty: deeper plans often attach to harder work that also has more rework. Calibration MUST use the confounding-controlled protocol in §7.3 before any action floor is retained or changed.

### 7.1 Join keys (#702 / #576)

| Join | Keys | Notes |
| --- | --- | --- |
| Planning investment | `run_id`, selected `planning_depth`, `risk_class` / `risk_classes` from `planning_leverage_phase` / snapshot | Selected at planning time — not post-hoc plan length |
| Assumptions | `run_id`, `assumption_id`, status, introduced/resolved phase | For open-set and reopen criteria |
| In-pipeline rework | `run_id`, `materiality`, `material_criteria`, `fix_round`, review_effort | Material ≠ ordinary formatting |
| Production outcomes | attribution `target_type: production_outcome` or run/commit/pr joins | Preserve `authority: observed \| inferred` |
| Progressive recommendation (future observe) | offline-computed action ids + `recommended_planning_depth` | Not applied in advance until policy enforces |
| Pre-routing severity strata | structural progressive class multi-label set **before** depth selection; repo/domain id; issue size band (files/LOC estimate when available) | Used for matching — never post-outcome class labels |

### 7.1.1 Source of progressive multi-label classes for offline eval (no observe-mode yet)

This research package does **not** emit observe-mode recommendations into the advance loop. Offline strata still need a progressive multi-label class set per target run. Allowed sources (immutable or blinded; **never** target-run outcomes):

| Source | Keying / procedure | Forbidden |
| --- | --- | --- |
| **A. Immutable pre-routing snapshot** (when present) | Prefer a planning-time snapshot of progressive classes + per-class evidence refs + `recommendation_as_of` stored before depth selection / implementation (future observe-mode or offline script attach). Join key: `run_id` + snapshot `as_of` ≤ first implement event. | Recomputing classes after material_rework or production_outcome exists for that run and folding those outcomes into the snapshot |
| **B. Blinded retrospective coding** | Coder (human or script) assigns progressive classes using **only** evidence available at planning start: issue body/labels at open, OpenSpec design at plan-complete, pre-code path/label triggers, path-prefix scope, declared dependency grammar — timestamped ≤ planning phase end. Record evidence refs per §2.4. Blind to review findings, fix rounds, material_rework, and production outcomes for the target run. | Unblinded coding after reading rework/production labels; using post-merge incident text as class evidence |
| **C. Prior-cohort historical only for `observed_rework_cost`** | Same §2.3 provenance; prior runs only | Target-run history |

**Join procedure for a target run R:**

1. Resolve `planning_as_of` = end of planning phase for R (or plan-review complete time).
2. Obtain progressive class multi-label set via A if snapshot exists; else B with evidence cutoff = `planning_as_of`.
3. Attach #702 selected `planning_depth`, `risk_class`/`risk_classes`, assumption ids by `run_id`.
4. Attach in-pipeline rework and #576 production outcomes **after** class assignment is frozen.
5. Form strata from step-2 classes × repo/domain × size band; then compute within-stratum outcome rates.

Until A exists in production telemetry, offline eval documents which runs used A vs B and keeps coding worksheets with evidence refs.

### 7.2 Primary outcome dimensions

1. **First-pass acceptance** — operational definition: plan-review approve without plan-revision cycle **and** implementation proceeds without replan / assumption reopen before first review pass. Report unavailable when plan-review disabled.
2. **Review effort** — `findings_blocking`, `findings_advisory`, `re_review_count` with per-field availability.
3. **Fix rounds** — count of fix-stage iterations when observed.
4. **Material rework** — rates of `materiality: material` and criterion breakdowns (not a productivity score).
5. **Post-merge production/rework** — #576 kinds (`follow_up_rework`, `reversion`, `escaped_defect`, etc.) when join exists **and** the run is outcome-eligible under §7.2.1.

Missing production or materiality → label **unavailable** / omit metric; **do not** treat missing as successful zero-rework.

For each reported rate, also report: **n**, **unavailable count**, and an uncertainty band (Wilson or bootstrap CI when n ≥ 10; otherwise withhold rate and report n only).

### 7.2.1 Post-merge time-at-risk and censoring

Post-merge production/rework comparisons use a **fixed follow-up eligibility horizon** so recent merges are not scored as “no incident.”

| Rule | Value / treatment |
| --- | --- |
| Default observation horizon | **H = 14 days** after merge (or after production deploy time when that is the attribution anchor). Constant: `DEFAULT_POST_MERGE_OBSERVATION_HORIZON_DAYS`. Operators may document a longer H for a window (e.g. 30 days) but must not mix H within one report without stratification. |
| Eligibility | A run is **outcome-eligible** for binary “any production follow-up within H” only when `eval_as_of ≥ merge_at + H`. |
| Not yet observable | If `eval_as_of < merge_at + H`, label production metrics **`not_yet_observable`** (a form of right-censoring). Count these under **unavailable / not-yet-observable**, **not** under negative (no incident). |
| Observed negative | Eligible run with no production_outcome of the measured kinds with `detected_at` ∈ `(merge_at, merge_at + H]` and join authority recorded. |
| Observed positive | Eligible run with ≥1 such outcome in the window. |
| Late discovery after H | Incidents with `detected_at > merge_at + H` are reported in a separate **late_discovery** bucket; they do **not** convert an eligible negative into a positive for the primary H-window rate (optional sensitivity: H=30 or H=90 tables). |
| Missing merge/deploy anchor | Production metric **unavailable** (not negative). |

**Reporting:** every post-merge rate table columns MUST include `n_eligible`, `n_not_yet_observable`, `n_unavailable_join`, `n_positive`, `n_negative`, and optional `n_late_discovery`. Never zero-fill not-yet-observable as success.

### 7.3 Cohort keys, matching, and confounding controls

**Naive depth×outcome tables are banned as sole calibration evidence.** Hard work both receives deeper plans and has more rework; an unadjusted association will look like “deep planning causes rework.”

**Comparable pre-routing cohorts:**

1. Form strata **before** looking at outcomes: progressive multi-label class set (or PL `risk_classes[]`), repository/domain, and optional size band.
2. Within each stratum, compare runs that received different planning actions / depths (observational) **or** compare offline **counterfactual recommendations** against actual selected depth without claiming causation.
3. Prefer exact stratum match; when sparse, coarsen class set (drop novelty/ambiguity first; never drop security/reversibility/blast from the match key).
4. Report **within-stratum** outcome deltas with n per cell; do not pool across high-severity and docs-only work.
5. Sensitivity: re-run tables with an alternative severity order (§3.2) and show whether retain/revise decisions flip.
6. Uncertainty: every retained floor must cite stratum ids, n, CI/withheld flag, and whether production joins were observed vs inferred.

**Reporting rules (continued):**

- Always report **sample size n** when showing rates.
- Partition **observed** vs **inferred** production joins; never present inferred as observed fact.
- Label rates as **associational within matched strata** (or derived with availability metadata). No required causal impact claim — but also **no** routing calibration from unmatched pooled associations alone.

### 7.4 False-positive and false-negative (operational)

| Kind | Definition |
| --- | --- |
| **False positive (over-planning)** | Recommended action was `deepen_*`, `zoom_*`, or `request_human_authority`, and the run completed with ordinary (non-material) rework, no production follow-up (when observed), and no later human-authority requirement — **and** a lighter cohort with similar structural class historically shows comparable outcomes (associational). Cost: delay / planning effort. |
| **False negative (under-planning)** | Recommended action was `lightweight_plan` or `standard_plan`, and the run later showed material rework, production follow-up/reversion, assumption reopen + replan, or a human-authority escalation that the checklist would have required up front. |

Rates are reportable per class or cohort when sample size allows; otherwise report n and withhold rate.

### 7.5 Calibration loop

1. Define a time window W₁ of completed runs with PL telemetry.
2. Hold out a later window W₂ (or alternate hosts when multi-host data exists).
3. Compute cohort rates, FP/FN per §7.4, and conflict diagnostic frequency.
4. Revise class thresholds / action floors in the research note version (bump vocabulary version if mappings change).
5. Re-run offline on W₂; compare.
6. Only after evidence-sufficiency checklist (§7.7) consider staged-policy promotion to **`observe`** (log recommendations; keep selected depth as today).
7. **`enforcing`** only after observe-window evidence_refs and stage-policy-lifecycle validation.

### 7.6 Banned proxy-only success metrics

Claims of progressive-planning “success” **must not** rest solely on:

- plan file byte length or section count
- planning wall-clock alone
- token spend alone
- longer prose or more OpenSpec files

At least one **primary outcome** dimension from §7.2 must be reported. Planning investment may appear as a **cost** dimension alongside outcomes, not as quality itself.

Forbidden collapsed fields as primary success metrics: `leverage_score`, `productivity_score`, `expected_pain`, single overall risk score.

### 7.7 Evidence-sufficiency checklist (before observe / enforcing)

Record this checklist (with window ids and n) before promoting `progressive_planning_depth` beyond `draft`:

- [ ] #702: ≥ **N_min** runs with non-`unknown` `planning_depth` in window (suggested starting floor: **30** runs; raise per class if variance high)
- [ ] #702: each high-severity progressive class intended for automation has **n ≥ 10** structural/declared matches **or** is marked “manual-only until n met”
- [ ] #702: material_rework events present for the same window with non-unknown materiality on a usable subset
- [ ] #576: production_outcome joins exist for a documented subset; observed vs inferred mix reported
- [ ] Offline eval report exists with cohort tables, FP/FN definitions applied, banned-proxy attestation
- [ ] No config key forces `enforcing` without stage-policy lineage + non-empty `evidence_refs`
- [ ] Human-authority checklist unchanged or change recorded with authority review

**Current status (2026-08-15 inventory):** all sample floors **unmet** (n ≈ 0). Automation remains **disabled**; policy id stays **`draft`**.

### 7.8 Manual / scripted evaluation path

Until observe-mode logging exists, evaluation is **manual or scripted** from:

- `.agent-pipeline/runs/*/events.jsonl` (PL family + other stage events)
- outcomes store / `production_outcome` records
- `pipeline scoreboard` JSON `planning_leverage` section

Pure helpers under `core/scripts/progressive-planning/` compose recommendations and safe defaults for fixtures and offline scripts. They are **not** wired into advance.

---

## 8. Staged policy placement

| Item | Value |
| --- | --- |
| Policy id | `progressive_planning_depth` |
| Research package state | **`draft`** |
| Allowed next non-enforcing state | `observe` (log recommended actions; do not auto-select depth) |
| `enforcing` | Forbidden without validated lifecycle lineage and non-empty `evidence_refs` to offline eval / observe windows |
| Config | This change adds **no** always-on auto-routing switch and **no** default `enforcing` entry |

Advance continues to resolve `planning_depth` via existing selection (`resolvePlanningLeverageSelection` / config / explicit), not progressive-planning automation.

---

## 9. Non-goals (explicit)

- Automated planning-depth routing in advance/loop (this issue)
- Single opaque risk score or universal expected-pain field as routing input
- Treating longer planning time, longer plans, or higher token spend as inherent success
- Merge-in-advance or review-rigor demotion
- Replacing #702 emitters or #576 outcome stores
- Reversing papercut backlog policy

---

## 10. Implementation notes for pure helpers

Module: `core/scripts/progressive-planning/`

- Closed action / class enums
- Most-restrictive composition
- Safe defaults (unknown → standard; security incomplete → not lightweight)
- `preserve_assumptions` stacking
- `recommended_planning_depth` closed enum
- No `risk_score` / `expected_pain` / `leverage_score` fields on recommendation objects

Tests: fixture-only, no network/git/subprocess.

---

## 11. Revision history

| Version | Date | Notes |
| --- | --- | --- |
| progressive-planning-v1 | 2026-08-15 | Initial research package for #703; host evidence n≈0; automation off |
| progressive-planning-v1 (challenge pass) | 2026-08-15 | Pre-routing rework provenance; high-severity scan gate; human-authority data dictionary; assumption_id lineage; confounding-controlled offline eval; severity order marked provisional |
| progressive-planning-v1 (challenge pass 2) | 2026-08-15 | Per-class evidence provenance; safety conflict matrix; narrow default-traffic deploy; count/id agreement; offline class sources A/B; post-merge H-day censoring |
