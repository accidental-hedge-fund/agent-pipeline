## Purpose

Provide a single CLI-owned supervisor pass that reflows parked review residuals when findings are stale, DNR, or below-high, while hard-refusing auto-override of HIGH, CRITICAL, security, and human-authority classes, so train and thin hosts can re-enter advance once without inventing dispositions.

## ADDED Requirements

### Requirement: recover-parked CLI SHALL reflow a park with one supervised pass per fingerprint

The pipeline SHALL expose a `recover-parked` command that accepts an issue (or linked PR→issue) number. When invoked for an item that is parked with `pipeline:blocked` and/or `pipeline:needs-human` (or equivalent residual park after review/fix/pre-merge residual block at the current head), the command SHALL:

1. Run deterministic engine recover first (see deterministic-first requirement).
2. If the park remains, load residual blocking findings against the **live PR HEAD**.
3. Classify each residual key as override-eligible or non-overridable under the structured-record rules.
4. For override-eligible keys only, record audited dispositions through the existing `pipeline override` / governed override path.
5. Optionally run at most one implementer fix round for remaining still-valid non-overridable defects (fix ≠ override).
6. When the residual blocking set is empty after those steps, re-enter `pipeline single` (or equivalent same-issue advance continuation) without restarting the item from backlog.
7. When non-overridable residuals remain at the (possibly new) HEAD, keep the park and surface a human notify path.

The command SHALL NOT merge, SHALL NOT invent a second state machine, and SHALL NOT drop `blocked`/`needs-human` without an audited disposition or a successful deterministic clear.

#### Scenario: Stale or below-high park reflows via override and re-enters single

- **WHEN** a parked item's residual blocking keys at live HEAD are all override-eligible (stale/DNR and/or below-high)
- **AND** the park fingerprint has not already spent a supervisor pass
- **THEN** `recover-parked` SHALL record an audited override for each eligible key with a key-bound evidence reason
- **AND** SHALL re-enter same-issue advance (`pipeline single` or equivalent)
- **AND** SHALL NOT restart the item from backlog selection

#### Scenario: Still-valid HIGH or CRITICAL remains parked

- **WHEN** residual findings at live HEAD include still-valid HIGH or CRITICAL keys
- **THEN** `recover-parked` SHALL NOT record an override disposition for those keys
- **AND** the item SHALL remain parked (`blocked` and/or `needs-human` as applicable)
- **AND** a human notify / punch-list path SHALL remain available

#### Scenario: Unparked item is a no-op fail-closed

- **WHEN** the target issue is not in a residual park state eligible for supervisor reflow
- **THEN** `recover-parked` SHALL exit without applying overrides
- **AND** SHALL NOT mutate labels solely to force a reflow

---

### Requirement: Override eligibility SHALL use structured review-record severity and category only

For each residual finding considered during a supervisor pass, override eligibility SHALL be determined solely from structured fields on the review record (at minimum `severity`, `category`, and the finding/override key identity). The command SHALL treat a finding as **non-overridable** when any of the following hold on the structured record:

- `severity` is HIGH or CRITICAL
- `category` is security (or the repository's structured security category equivalent on the record)
- the residual is classified as `human-decision-required` / missing-authority

The command SHALL treat a finding as **override-eligible** only when it is not non-overridable and matches a closed supervisor reason class of stale, DNR (do-not-reopen / no longer present at live HEAD), or below-high residual. Free-text classifier prose, host skill narrative, or model opinion SHALL NOT reclassify a structured CRITICAL/HIGH/security finding as a nit or otherwise unlock override.

#### Scenario: Structured CRITICAL cannot be overridden by nit prose

- **WHEN** the structured review record marks a residual finding `severity: CRITICAL` (or HIGH, or `category: security`)
- **AND** any classifier or prose output claims the finding is a nit, stale, or safe to ignore
- **THEN** `recover-parked` SHALL refuse override for that finding key
- **AND** SHALL keep the park for human disposition

#### Scenario: Below-high residual is override-eligible

- **WHEN** a residual blocking finding at live HEAD has structured severity below HIGH
- **AND** it is not security-category and not human-decision-required
- **AND** the fingerprint budget remains
- **THEN** `recover-parked` MAY record an audited override for that key with evidence reason `below-high` (or equivalent closed code)

#### Scenario: Key absent at live HEAD is stale/DNR eligible

- **WHEN** a parked blocking override-key is no longer present in the residual set at live PR HEAD
- **AND** the key's structured park-time record is not HIGH, CRITICAL, security-category, or human-authority
- **AND** the fingerprint budget remains
- **THEN** `recover-parked` MAY disposition that key as stale or DNR through the audited override path
- **AND** SHALL cite the finding key and a one-line stale/DNR evidence reason

#### Scenario: Park-time protected key absent from later residual at same HEAD remains non-overridable

- **WHEN** the causal current-park review artifact (oldest review at live HEAD) recorded structured severity HIGH or CRITICAL, or category security, or human-authority for a key
- **AND** that key is absent from a later live residual artifact at the same HEAD
- **THEN** `recover-parked` SHALL NOT record a stale/DNR override for that key
- **AND** SHALL keep the park for human disposition (protected-class gate before DNR)

#### Scenario: Historical protected key from another SHA does not strand a later park

- **WHEN** a prior review at a different reviewed-sha recorded HIGH or CRITICAL (or security/authority) for a key without an override
- **AND** the current park residual at live HEAD has only other keys (the prior key is not in the causal park artifact)
- **THEN** `recover-parked` SHALL NOT treat that historical key as part of the current park
- **AND** SHALL classify and reflow only from the causal park artifact merged with the live residual

---

### Requirement: Deterministic engine recover SHALL run before any supervisor override or extra fix

Before spending the supervisor fingerprint budget, applying any override, or starting an extra implementer fix round, `recover-parked` SHALL attempt existing deterministic recover applicable to the park evidence, including at least:

- engine-scratch / workflow-engine-defect scratch unlink recover when scratch-only porcelain or scratch residual evidence is present
- stale-blocked re-review / clear when leftover `blocked` is stale because PR HEAD moved past the blocking reviewed-sha under existing supersession rules

When deterministic recover clears the park, the command SHALL exit successfully without recording supervisor overrides and without consuming the one-pass supervisor fingerprint budget. When HEAD or the linked PR cannot be read, the command SHALL fail closed, keep the park, and SHALL NOT override.

#### Scenario: Scratch or stale-SHA park clears without override

- **WHEN** the park is solely engine-scratch residual or stale blocked after HEAD movement that deterministic recover can clear
- **THEN** `recover-parked` SHALL run that deterministic path
- **AND** SHALL NOT record a supervisor override for residual review keys solely to clear the park
- **AND** SHALL NOT mark the supervisor fingerprint as spent for a senior pass that did not run

#### Scenario: Unreadable HEAD fails closed

- **WHEN** the linked open PR or PR HEAD cannot be read during recover-parked
- **THEN** the command SHALL keep the park
- **AND** SHALL NOT apply overrides

---

### Requirement: Supervisor pass budget SHALL be one per issue-stage-keys fingerprint

The pipeline SHALL allow at most **one** supervisor senior pass per fingerprint defined as `(issue number, stage identity at park, sorted list of blocking override-keys)`. After a pass is spent for a fingerprint, a later `recover-parked` invocation with the same fingerprint SHALL refuse to spend another supervisor pass (no second override batch and no second supervisor-budgeted extra fix round for that fingerprint). A new commit that leaves the **same** sorted blocking override-keys SHALL NOT create a new fingerprint. A different sorted key set SHALL be a new fingerprint and MAY receive one new pass. Deterministic-only clears that never enter the senior path SHALL NOT consume the senior fingerprint budget.

#### Scenario: Same keys after a new commit do not get a second pass

- **WHEN** a supervisor pass was already recorded for fingerprint F = (issue, stage, sorted keys K)
- **AND** a new commit lands but the residual sorted blocking keys remain K
- **AND** `recover-parked` is invoked again
- **THEN** the command SHALL NOT spend another supervisor pass for F
- **AND** SHALL NOT apply a new supervisor override batch for those keys solely from recover-parked
- **AND** the item SHALL remain subject to human override / punch list if still parked

#### Scenario: New key set grants a new fingerprint pass

- **WHEN** residual sorted blocking keys change from K1 to K2 after work on the item
- **AND** no supervisor pass has been spent for the fingerprint that includes K2
- **THEN** `recover-parked` MAY perform one senior pass for the new fingerprint

#### Scenario: Second identical park fingerprint is idempotent refuse

- **WHEN** the same fingerprint is presented a second time while still parked after a spent pass
- **THEN** `recover-parked` SHALL exit without re-running the senior override/fix budget
- **AND** SHALL leave human recovery as the remaining path

#### Scenario: Subset keys after partial override do not re-grant a senior pass

- **WHEN** a supervisor pass was spent for key set K at stage S
- **AND** eligible keys in K were dispositioned so remaining blocking keys K' are a subset of K
- **AND** `recover-parked` is invoked again with residual keys K'
- **THEN** the command SHALL treat the senior budget as already spent for that residual set
- **AND** SHALL NOT run another supervisor override batch or supervisor-budgeted extra fix for K' solely because the fingerprint string changed

#### Scenario: Spend marker is written before override side effects

- **WHEN** `recover-parked` enters the senior path for an unspent fingerprint
- **THEN** it SHALL record the durable spend marker for that fingerprint before posting override dispositions
- **AND** if a later step fails after the marker is written, a retry with the same fingerprint SHALL refuse another senior pass

---

### Requirement: recover-parked SHALL expose a closed result contract for train and CLI consumers

The command and its pure engine entrypoint SHALL return a closed status from at least: `deterministic-cleared`, `recovered`, `still-parked`, `already-spent`, `not-parked`, `fail-closed`. Train and other in-process consumers SHALL use that result (or the shared entrypoint) rather than inventing a second classifier. Thin hosts that only invoke the CLI SHALL stop or hold when the outcome is still parked (or equivalent non-zero park result) and SHALL NOT invent override.

#### Scenario: Train maps recovered vs still-parked from the shared result

- **WHEN** train invokes recover-parked for a parked item
- **AND** the result status is `recovered` or `deterministic-cleared`
- **THEN** train MAY continue same-issue advance without backlog restart
- **WHEN** the result status is `still-parked`, `already-spent`, or `fail-closed`
- **THEN** train SHALL hold/STOP that item under existing park rules without inventing an override

#### Scenario: Re-entry does not recursively invoke recover-parked

- **WHEN** recover-parked re-enters `pipeline single` / advance for the same issue after a successful clear
- **THEN** that re-entry SHALL carry an internal guard that prevents nested recover-parked on the same stack
- **AND** SHALL preserve the existing issue-run lock contract for that issue

---

### Requirement: Extra fix round MAY code-fix non-overridable defects and MUST NOT override them

After eligible overrides (if any), when still-valid non-overridable findings remain (HIGH, CRITICAL, security, or authority), `recover-parked` MAY invoke at most one implementer fix round aimed at those findings. That fix round MAY produce commits on the managed worktree under existing surgical-fix disciplines. The supervisor path SHALL NOT record an override for those non-overridable keys. After the fix attempt (or if skipped), the command SHALL re-evaluate residuals at the live HEAD: empty blocking set → re-enter same-issue advance; remaining non-overridable keys → keep park for human.

#### Scenario: Fix may commit for HIGH/CRITICAL without override

- **WHEN** residuals include still-valid HIGH or CRITICAL keys and the fingerprint budget allows the senior path
- **THEN** `recover-parked` MAY run one implementer fix round that commits a code fix
- **AND** SHALL refuse any override disposition for those HIGH/CRITICAL keys

#### Scenario: Residuals after fix keep the park

- **WHEN** the optional fix round completes and HIGH/CRITICAL (or other non-overridable) keys still block at the new HEAD
- **THEN** the item SHALL remain parked for human
- **AND** no override of those keys SHALL be recorded by recover-parked

#### Scenario: Override of non-overridable keys is refused even if requested internally

- **WHEN** any recover-parked internal step would disposition a HIGH, CRITICAL, security, or human-decision-required key via override
- **THEN** that disposition SHALL be refused
- **AND** the finding SHALL remain blocking

---

### Requirement: Override payloads SHALL cite finding key and closed evidence reason

Every override recorded by `recover-parked` SHALL include the finding key from the review record and a one-line evidence reason drawn from a closed supervisor reason set that includes at least stale, DNR, and below-high. Keyless dispositions and prose-only dispositions without a finding key SHALL be refused. Dispositions SHALL go through the existing audited override ledger path (not a side door that clears labels without a ledger entry).

#### Scenario: Key-bound stale reason accepted

- **WHEN** an eligible stale key is dispositioned by recover-parked
- **THEN** the override record SHALL include that finding key
- **AND** SHALL include a one-line evidence reason identifying stale (or DNR/below-high as applicable)

#### Scenario: Keyless disposition refused

- **WHEN** a recover-parked path would post an override without a finding key
- **THEN** the engine SHALL refuse the disposition
- **AND** SHALL NOT clear the corresponding block solely from that attempt

---

### Requirement: Unit coverage SHALL prove eligibility, budget, deterministic-first, and fix-vs-override with injected deps

The change SHALL include unit tests that inject I/O via deps and perform no real network, git, or subprocess calls. Coverage SHALL include at least: stale/below-high reflow; structured CRITICAL refuse despite nit prose; same fingerprint after new commit refuses second pass; deterministic scratch/stale-SHA clear without override and without spending senior budget; extra fix allowed for HIGH/CRITICAL while override of those keys is refused. After any `core/` implementation edits, the generated `plugin/` mirror SHALL be regenerated in the same change when required by mirror rules.

#### Scenario: CRITICAL-with-nit-prose fixture refuses override

- **WHEN** unit tests run the recover-parked pure eligibility / command fixture with structured CRITICAL and prose "nit"
- **THEN** the test SHALL fail if an override for that key is recorded

#### Scenario: Deterministic-first fixture records no supervisor override

- **WHEN** unit tests run a scratch-only or stale-SHA park fixture that deterministic recover clears
- **THEN** the test SHALL fail if a supervisor override was recorded or senior fingerprint budget was spent

#### Scenario: Negative fixtures cover each protected structured condition

- **WHEN** unit tests run recover-parked fixtures for structured HIGH, CRITICAL, `category: security`, `human-decision-required`, and missing-authority residuals
- **THEN** each fixture SHALL fail if an override for the protected key/class is recorded
- **AND** classifier prose SHALL not unlock override in any of those fixtures

#### Scenario: Partial-override subset fixture refuses second senior pass

- **WHEN** unit tests spend a pass for keys including both eligible and HIGH/CRITICAL keys, apply only eligible overrides, then re-invoke with the remaining HIGH/CRITICAL subset
- **THEN** the test SHALL fail if a second supervisor pass (override batch or budgeted extra fix) runs for that subset
