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
| `observed_rework_cost` | Historical #702 material rework rates and #576 production follow-up for similar depth×risk cohorts with `authority: observed` preferred | Invented rates; inferred joins treated as observed; n below sample floor (see §7) |
| `unknown` | No class matched after allowed sources checked; or evidence unreadable | Used as a **bucket for insufficient evidence**, not a claim of safety |

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
| No signals matched | `standard_plan` (+ `preserve_assumptions` if open questions/assumptions) |
| Conflicting signals (e.g. “low risk” label vs `auth` / public-api structural) | Prefer **more restrictive** action; record conflict diagnostic |
| Historical rework / production data unavailable | Do not invent rates; omit `observed_rework_cost`; structural/declared only |
| Irreversible / high-blast / security / compliance matched with incomplete sub-signals | Floor: `request_human_authority` or documented `deepen_technical` + `preserve_assumptions` — **never** `lightweight_plan` solely for missing history |
| Lightweight recommended but open/deferred assumptions remain | **MUST** attach `preserve_assumptions` |
| Stale evidence (expired attestation, superseded dossier) | Treat high-severity classes as incomplete → fail closed per §5 |

**Fail-closed principle:** silent under-planning of irreversible, high-blast, security, or compliance work is forbidden. Unknown non-high-severity work fails to **standard**, not minimal.

---

## 5. Human-authority boundaries

Human authority is a **closed checklist**. Satisfying it requires a real human sign-off event (operator disposition, audited authority record). The following do **not** count:

- Agent plan-review approve (including same-harness fallback)
- Optional human **feedback window** without explicit authority disposition
- Automated pre-code attestation alone (may be necessary but not sufficient for these floors when human boundary fires)
- Reviewer CLI verdicts on implementation PRs

### 5.1 Checklist (policy floor → `request_human_authority`)

1. **Irreversible:** production/data/shared-state mutation without a documented automated rollback path.
2. **High blast radius:** multi-tenant or cross-system schema/API break with external consumers, or multi-repo coordinated cutover without a staged rollout plan.
3. **Security-sensitive:** AuthN/AuthZ model change, secret handling, privilege elevation, or security boundary move.
4. **Compliance-sensitive:** regulated data processing change or audit-required control change.

When any item fires, routing includes `request_human_authority`. Agent plan-review approval alone **does not** satisfy the boundary.

### 5.2 Distinction from plan-review and feedback window

| Mechanism | Role | Satisfies human-authority boundary? |
| --- | --- | --- |
| Agent plan-review | Machine/agent quality gate on plan | **No** |
| Optional human feedback window | Opportunity for comments; may be empty | **No** (unless explicit authority disposition recorded) |
| Human authority disposition | Operator-authorized gate for §5.1 classes | **Yes** |

Open/deferred assumptions must remain reconstructable on the handoff surface when parking for human authority (see §6).

---

## 6. Assumption and open-question lineage under progressive depth

Compose with #702 `assumption_lineage` emitters. Progressive routing **never**:

- deletes open/deferred assumptions because `planning_depth` is `minimal` or action is `lightweight_plan`
- omits open/deferred items from carry-forward projections solely due to light planning
- mints a second `assumption_id` for the same logical assumption when attaching `preserve_assumptions`

Requirements:

- Lightweight paths still emit and carry lineage records.
- Implementation and review remain consumers of open items.
- `request_human_authority` handoff includes the open/deferred set from the run lineage stream.
- Status transitions stay on the same `assumption_id` (`open` → `resolved` / `deferred` / `invalidated`).

---

## 7. Offline evaluation design

Evaluation is **batch/offline** over host-local run stores + outcome stores. It does **not** require live auto-routing. Causal claims are **not** required; associational cohort rates with sample size are sufficient until observe-mode exists.

### 7.1 Join keys (#702 / #576)

| Join | Keys | Notes |
| --- | --- | --- |
| Planning investment | `run_id`, selected `planning_depth`, `risk_class` / `risk_classes` from `planning_leverage_phase` / snapshot | Selected at planning time — not post-hoc plan length |
| Assumptions | `run_id`, `assumption_id`, status, introduced/resolved phase | For open-set and reopen criteria |
| In-pipeline rework | `run_id`, `materiality`, `material_criteria`, `fix_round`, review_effort | Material ≠ ordinary formatting |
| Production outcomes | attribution `target_type: production_outcome` or run/commit/pr joins | Preserve `authority: observed \| inferred` |
| Progressive recommendation (future observe) | offline-computed action ids + `recommended_planning_depth` | Not applied in advance until policy enforces |

### 7.2 Primary outcome dimensions

1. **First-pass acceptance** — operational definition: plan-review approve without plan-revision cycle **and** implementation proceeds without replan / assumption reopen before first review pass. Report unavailable when plan-review disabled.
2. **Review effort** — `findings_blocking`, `findings_advisory`, `re_review_count` with per-field availability.
3. **Fix rounds** — count of fix-stage iterations when observed.
4. **Material rework** — rates of `materiality: material` and criterion breakdowns (not a productivity score).
5. **Post-merge production/rework** — #576 kinds (`follow_up_rework`, `reversion`, `escaped_defect`, etc.) when join exists.

Missing production or materiality → label **unavailable** / omit metric; **do not** treat missing as successful zero-rework.

### 7.3 Cohort keys and reporting

- Address rows by selected `planning_depth` × primary `risk_class` (and multi-class set when present).
- Optionally stratify by progressive class multi-label set when offline classifier is applied.
- Always report **sample size n** when showing rates.
- Partition **observed** vs **inferred** production joins; never present inferred as observed fact.
- Label rates as **associational** (or derived with availability metadata). No required causal impact claim.

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
