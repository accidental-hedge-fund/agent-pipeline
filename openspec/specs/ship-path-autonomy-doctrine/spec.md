# ship-path-autonomy-doctrine Specification

## Purpose
Gives the pipeline a durable shared memory of ship-path autonomy: a short living doctrine for operators and agents, a versioned preamble pinned into plan/implement/fix/intake runs, an engine-dogfood class-vs-site planning bar, and outer-supervisor guidance that distinguishes recoverable engine faults from true human authority.

## Requirements

### Requirement: Living ship-path autonomy doctrine document SHALL exist and cover the five doctrine points

The repository SHALL provide a short canonical operator- and agent-readable document at `docs/ship-path-autonomy.md` (or an equivalent path linked from concepts under that title). The document SHALL state all of the following:

1. **Ship path:** `train` advances over **base-eligible frontiers** via the loop/advance wave and, when merge is authorized, an optional serial **merge barrier** for code-stacked dependencies — not N×`single` STOP shells, and not “all ready-to-deploy then merge” when a child needs parent commits on base.
2. **Recovery ladder:** classify → deterministic recipe (unlink scratch, resync, pin head, clear stale block) → verify / re-review / rerun CI → bounded model repair (`repair_pipeline_item` / fix harness) → **real** human handoff only for human-authority classes.
3. **False human vs real human:** engine scratch, stale identity/labels, capacity, and workflow-engine defects are **not** true `human-decision-required` / janitor work; true product judgment and missing authority remain parked (handoff path such as #647), not scratch cleanup.
4. **Class over site:** engine dogfood failures MUST fix the shared classifier, recipe, gate adoption, or controller; a pure path-local patch is incomplete unless it lands the class law.
5. **Anti-goals:** threshold→general LLM as first recoverer; second recoverer inside `train.ts`; PR stacking onto parent PR head; merge inside advance/loop; reversing papercut backlog policy (#538) for papercuts.

The document SHALL remain short enough to pin as factory memory; long rationale MAY stay in issues/epic text and SHALL NOT be required inside every harness prompt.

#### Scenario: Doctrine file exists with five points

- **WHEN** a contributor opens `docs/ship-path-autonomy.md` (or the equivalent path linked from concepts)
- **THEN** the document SHALL exist
- **AND** it SHALL include explicit coverage of ship path, recovery ladder, false vs real human, class over site, and the listed anti-goals

#### Scenario: Doctrine stays pin-sized

- **WHEN** the living doctrine is used as factory memory for operators and agents
- **THEN** it SHALL be a short constitution-style document rather than a full skill dump or epic essay

---

### Requirement: Ship-path autonomy preamble SHALL be single-sourced, versioned, and injected into plan, implement, fix, and authoring prompt builds

The prompt-builder seam (`core/scripts/prompts/index.ts` or equivalent single module) SHALL define one versioned short preamble derived from the living doctrine. Built prompts for at least the following builders SHALL include that preamble:

- planning and planning_openspec
- implementing
- fix, test_fix, eval_fix, and visual_fix (when those builders exist)
- intake, refine-spec, and sweep

The preamble SHALL:

- Carry a stable machine-checkable marker string including a version token (e.g. `<!-- pipeline-ship-path-autonomy: v1 -->`).
- Remain a tight constitution (target on the order of ≤40 lines), not the full living-doc essay.
- Be single-sourced (one constant or equivalent), not copy-pasted as divergent prose across templates.
- Be subject to the same pin / snapshot discipline as other standing prompt content for the process lifetime so a mid-run skill or docs edit cannot silently change the preamble for that process without a new engine load.

The preamble SHALL state at least: recovery ladder order (deterministic recipe before bounded model repair before real human), false-human vs real-human distinction, class-over-site for engine dogfood, and the anti-goals that advance never merges and that pure site-local moles are incomplete without class law.

#### Scenario: Planning prompt includes versioned marker

- **WHEN** `buildPlanningPrompt` or `buildPlanningOpenspecPrompt` builds a prompt
- **THEN** the returned string SHALL contain the stable ship-path autonomy version marker

#### Scenario: Implementing prompt includes versioned marker

- **WHEN** `buildImplementingPrompt` builds a prompt
- **THEN** the returned string SHALL contain the stable ship-path autonomy version marker

#### Scenario: Fix-family prompts include versioned marker

- **WHEN** `buildFixPrompt`, `buildTestFixPrompt`, `buildEvalFixPrompt`, or `buildVisualFixPrompt` builds a prompt
- **THEN** the returned string SHALL contain the stable ship-path autonomy version marker

#### Scenario: Authoring prompts include versioned marker

- **WHEN** `buildIntakePrompt`, `buildRefineSpecPrompt`, or `buildSweepPrompt` builds a prompt
- **THEN** the returned string SHALL contain the stable ship-path autonomy version marker

#### Scenario: Preamble is single-sourced across builders

- **WHEN** the listed builders each emit a prompt
- **THEN** each built prompt SHALL embed the same shared preamble text (byte-for-byte for the shared block)
- **AND** the marker version token SHALL match across those builders for a given engine load

#### Scenario: Drift-guard test bites when marker is removed

- **WHEN** the shared preamble marker is removed from the constant or dropped from a listed builder’s injection map
- **THEN** the unit test suite SHALL fail with an assertion naming the missing marker or builder

---

### Requirement: Autonomy preamble SHALL NOT override surgical-fix discipline for ordinary product review findings

When fix-family prompts include the ship-path autonomy preamble, they SHALL still instruct surgical minimal-diff discipline, destructive-operation safety scope, and pre-commit severity self-check for ordinary product review findings. The preamble SHALL add factory-class judgment for engine recovery, pipeline self-host, and ship-path dogfood work; it SHALL NOT replace or contradict the requirement that ordinary review findings receive minimal finding-scoped fixes.

#### Scenario: Fix prompt carries both autonomy marker and surgical discipline

- **WHEN** `buildFixPrompt` builds a prompt for a normal review-fix round
- **THEN** the returned string SHALL contain the ship-path autonomy version marker
- **AND** it SHALL still instruct minimal finding-scoped diffs and forbid refactors / scope-broadening / opportunistic cleanup for ordinary findings

#### Scenario: Autonomy text does not authorize always-broaden fixes

- **WHEN** the autonomy preamble is rendered in a fix-family prompt
- **THEN** it SHALL NOT instruct the harness to ignore surgical discipline for ordinary product review findings
- **AND** it MAY instruct class-over-site changes when the work is engine recovery or pipeline self-host dogfood

---

### Requirement: Engine-dogfood planning and intake bar SHALL require class-vs-site answers

For issues that are clearly engine/pipeline self-host or ship-path recover work (domain dogfood, labels/theme, body markers, or equivalent clear signals), planning and intake/authoring prompt instructions SHALL require the plan or issue body to answer:

1. whether the fix is **class** (shared classifier, recipe, gate, or controller) vs **site** (path-local only),
2. which shared surfaces change so the class law lands,
3. how the next identical fault does not require a new mole issue.

Instructions SHALL state that spot-fix-only / path-local-only plans are insufficient for that class. Enforcement for this change SHALL be at prompt/instruction level at minimum (stronger deterministic gates are allowed but not required).

#### Scenario: Planning prompt states engine-dogfood class bar

- **WHEN** a planning or planning_openspec prompt is built
- **THEN** the returned string SHALL instruct that engine/self-host/ship-path-recover work must answer class vs site, shared surface changes, and non-recurrence without a new mole issue

#### Scenario: Intake or refine-spec prompt states the same bar for authored engine issues

- **WHEN** an intake, refine-spec, or sweep prompt is built
- **THEN** the returned string SHALL carry the engine-dogfood class-vs-site bar (or an equivalent shared clause from the autonomy preamble) so newly minted engine issues inherit the acceptance expectation

---

### Requirement: External supervisor contract SHALL distinguish recoverable engine outcomes from true human-authority waits

`docs/supervisor.md` SHALL NOT teach unconditional “wait for human” for every `needs-human` or blocked outcome. The supervisor failure guidance SHALL:

- Direct recoverable engine/workflow classes toward loop recovery and/or re-train after the deterministic recipe, not operator janitor file-delete or label surgery as the default response.
- Keep true human-authority / product-judgment cases on wait / handoff behavior (including the existing human-question handoff path).
- Preserve the non-goal that supervisors do not gain merge authority, a second durable scheduler, or a second state machine from this guidance.

#### Scenario: Supervisor doc is not unconditional human-wait

- **WHEN** an operator or outer host reads the supervisor failure table for `needs-human` / blocked
- **THEN** the documented action SHALL distinguish recoverable engine/workflow recovery from true human-authority wait
- **AND** it SHALL NOT instruct a single unconditional “wait for human” for all blocked outcomes

#### Scenario: Supervisor authority boundary unchanged for merge

- **WHEN** supervisor docs are updated for autonomy orientation
- **THEN** they SHALL still forbid inventing merge authority, auto_merge config, or a second control plane outside existing operator-authorized merge commands

---

### Requirement: Doctrine presence and preamble injection SHALL be regression-tested with packaging freshness

The change SHALL include unit tests that prove listed prompt builders emit the autonomy marker and critical invariant content. After any `core/` edit for this capability, `node scripts/build.mjs` SHALL run and any changed SKILL/catalog outputs SHALL be committed so `build.mjs --check` and `npm run ci` pass. No `plugin/` copy of `core/scripts/prompts` SHALL be generated.

#### Scenario: CI-facing tests cover preamble injection

- **WHEN** the core unit test suite runs
- **THEN** at least one test SHALL fail if a listed builder omits the ship-path autonomy version marker

#### Scenario: Packaging freshness stays green after core prompt changes

- **WHEN** implementation edits files under `core/scripts/prompts/`
- **THEN** `node scripts/build.mjs` SHALL run without generating a `plugin/` prompt copy
- **AND** changed SKILL/catalog outputs, if any, SHALL be included in the same change
- **AND** `node scripts/build.mjs --check` SHALL pass

### Requirement: Outer supervisors SHALL reflow parked residuals only via recover-parked CLI

External supervisors and thin hosts (including Tugboat composition, Hermes/host skill guidance, and `docs/supervisor.md` failure tables for residual review parks) SHALL direct post-park reflow of review residuals through the engine `pipeline recover-parked` command at most once per park fingerprint, or else STOP and notify a human. They SHALL NOT invent `pipeline override` dispositions, silently drop `blocked`/`needs-human`, reclassify structured HIGH/CRITICAL/security findings, or grow a second recoverer/state machine for this purpose. True human-authority classes (`human-decision-required`, missing authority, product judgment) and still-valid HIGH/CRITICAL/security residuals after recover-parked SHALL remain human wait/handoff work. Deterministic engine classes (scratch unlink, stale-SHA resume) SHALL continue to prefer engine recipes before any supervisor senior pass.

#### Scenario: Supervisor docs point residual parks at recover-parked

- **WHEN** an operator or outer host reads supervisor guidance for a residual review park at current HEAD after deterministic resume
- **THEN** the documented action SHALL be `pipeline recover-parked` once (or equivalent CLI) then STOP if still parked
- **AND** it SHALL NOT instruct host-improvised override or label surgery as the default reflow

#### Scenario: Host must not auto-override CRITICAL residuals

- **WHEN** a parked residual includes structured CRITICAL or security findings
- **THEN** outer-host guidance SHALL NOT teach auto-override of those keys
- **AND** recover-parked refuse + human notify remains the correct outcome

#### Scenario: Supervisor authority boundary unchanged for merge

- **WHEN** supervisor or Tugboat docs mention recover-parked
- **THEN** they SHALL still forbid inventing merge authority, auto_merge config, or a second control plane outside existing operator-authorized merge commands

### Requirement: Status output and generated host SKILLs SHALL carry the recover-parked-once then STOP doctrine

Status output and the four generated host SKILLs SHALL apply the existing outer-supervisor residual-park rule: reflow through `pipeline recover-parked` at most once per park fingerprint, then STOP and notify. They SHALL NOT invent `pipeline override`, drop `blocked`/`needs-human`, or auto-override HIGH/CRITICAL/security/authority. That rule SHALL apply to `pipeline status` (prose and JSON) and generated host SKILLs, not only to `docs/supervisor.md`. Train's in-wave RecoverySupervisor recovery SHALL remain the train path. Status and SKILL text SHALL NOT tell a host to auto-invoke `recover-parked` from inside `pipeline train`. Claude's permission classifier SHALL NOT be required for this doctrine and SHALL NOT be treated as an authorization mechanism. The doctrine SHALL remain host-neutral.

`docs/supervisor.md` SHALL keep the residual-park row that already names recover-parked once then STOP. A regression test SHALL fail if status next-action text, generated SKILL authority/follow text, or the supervisor residual-park row again instructs an inferred override as the autonomous next action.

#### Scenario: Status and SKILL match supervisor residual-park rule

- **WHEN** an operator or outer host reads status output, a generated host SKILL, and `docs/supervisor.md` for a residual review park at current HEAD
- **THEN** all three SHALL name `pipeline recover-parked` once then STOP if still parked
- **AND** none SHALL instruct host-improvised override or label surgery as the default reflow

#### Scenario: Host-neutral doctrine does not depend on Claude permissions

- **WHEN** the same residual park is handled by a Codex, Grok, or OpenCode host
- **THEN** status and SKILL guidance SHALL still forbid inferred override
- **AND** the absence of a permission classifier SHALL NOT be treated as override authority

#### Scenario: Train still does not auto-invoke recover-parked

- **WHEN** supervisor or SKILL text describes a train-held residual park
- **THEN** it SHALL NOT instruct the host to invoke `recover-parked` from inside `pipeline train`
- **AND** in-wave RecoverySupervisor recovery SHALL remain the documented train path
