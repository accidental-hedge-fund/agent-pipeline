## Context

See `proposal.md` for motivation and dogfood (#599, pre-merge residual CRITICAL).

**Existing pieces this change composes (does not reimplement):**

- Audited disposition primitive: `pipeline override` + `governed-overrides` / override ledger + `override-auto-resume` (auto-resume after valid disposition).
- Review-ceiling demotion (#233): `demote_and_advance` applies only at the **review** round ceiling for below-high findings — not a general post-park reflow, and never for HIGH/CRITICAL.
- Deterministic recover: `engine-scratch-recover` (`unlink_engine_scratch`), `stale-blocked-rereview` (clear leftover `blocked` when HEAD superseded reviewed-sha), loop recovery recipes for engine classes.
- Structured finding identity: `findingKey` / override-keys on review comments; severity and category on the structured review record.
- Train parks per-item on `needs-human` and continues independent peers; whole-train STOP when nothing schedulable remains.
- Ship-path autonomy doctrine: false human vs real human; outer hosts must not invent merge/override authority.

**Gap:** after a true residual park at current HEAD, no engine command re-evaluates stale/DNR/below-high keys and reflows; operators and hosts either wait forever or improvise override.

## Goals / Non-Goals

**Goals:**

- One CLI-owned supervisor pass that reflows only eligible findings and re-enters advance for the same issue.
- Fail-closed on HIGH/CRITICAL/security/authority using **record fields only**.
- Deterministic recover always before senior budget.
- One-pass fingerprint budget that does not reset on same-key new commits.
- Train/Tugboat/host thin composition: call CLI once, then STOP if still parked.

**Non-Goals:**

- Auto-override or auto-advance CRITICAL / security residuals (#599 stays human while CRITICAL).
- Replacing or weakening #1020/#1025 deterministic paths.
- Expanding `demote_and_advance` to pre-merge residual parks as the sole mechanism.
- Second recovery brain inside `train.ts` (train only invokes the CLI; classification lives in recover-parked).
- MessagingPort, grant factory, second durable scheduler, merge in advance/loop.
- Host-side severity reclassification or free-form override invention.
- Multi-pass LLM debate or unbounded fix rounds.

## Decisions

### D1: Single CLI command owns classification and disposition

**Decision:** Implement `pipeline recover-parked <n>` as the only entry that may auto-apply eligible overrides for a park fingerprint. Train, Tugboat, Hermes, and host SKILL invoke this CLI (or no-op + STOP). They MUST NOT call `pipeline override` themselves for this reflow, drop `blocked`, or reimplement classification.

**Rationale:** Stay-better constraint #11; prevents host improv that the issue was written to replace.

**Alternatives:** Inline senior logic in train (rejected: second recoverer in train). SKILL-only path without CLI (rejected: non-deterministic, untestable, host drift).

### D2: Severity and override eligibility from structured review record only

**Decision:** Override eligibility is a pure function of structured fields on the current residual findings at live PR HEAD:

| Structured evidence | Supervisor override? |
|---------------------|----------------------|
| `severity` HIGH or CRITICAL | **No** |
| `category: security` (or equivalent security category on the record) | **No** |
| `human-decision-required` / missing-authority class | **No** |
| Stale / DNR (finding key no longer present at live HEAD, or engine DNR marker) | **Yes** (audited override with evidence reason) |
| Below-high residual still present and policy allows disposition | **Yes** (audited override with `below-high` reason) |

Classifier **prose** (LLM free text) MUST NOT downgrade severity or unlock override. If the record says CRITICAL and prose says "nit", the key remains non-overridable.

**Rationale:** Stay-better #7; matches #599 fail-closed.

**Alternatives:** LLM re-score severity (rejected). Treat missing severity as below-high (rejected: fail closed — treat unknown as non-overridable).

### D3: Deterministic recover before supervisor budget

**Decision:** On enter, `recover-parked` runs existing deterministic recipes first (at minimum: engine-scratch unlink path, stale-blocked after HEAD movement re-review/clear). Outcomes:

1. Park cleared → exit success **without** spending supervisor fingerprint budget and **without** override.
2. Park remains with residual review keys at current HEAD → proceed to one-pass senior classification.
3. Unreadable HEAD / missing PR → fail closed, keep park, do not override.

**Rationale:** Stay-better #8; avoids burning the one pass on false parks.

**Alternatives:** Senior path first (rejected: wastes budget, invents overrides for scratch). Separate operator must run recipes manually (rejected: train still STOPs).

### D4: Fingerprint = (issue, stage, sorted blocking override-keys)

**Decision:** The one-pass budget key is the triple:

- issue number
- current pipeline stage label (or equivalent stage id at park)
- sorted list of blocking override-keys from the residual set used for the pass decision

A durable marker (issue comment sentinel, run-state record, or equivalent append-only evidence) records that a supervisor pass was spent for that fingerprint. A later invocation with the **same** fingerprint (including after a new commit that leaves the same key set) MUST refuse to spend another pass. A **different** sorted key set is a new fingerprint and MAY receive one new pass.

**Rationale:** Stay-better #10; matches acceptance "same keys after new commit do not reset budget".

**Alternatives:** Fingerprint includes HEAD SHA (rejected: same keys after fix commit would re-grant a pass). Issue-only budget (rejected: stage/key changes would be blocked incorrectly).

### D5: Fix round may address HIGH/CRITICAL; override path must not

**Decision:** After eligible overrides are applied (if any), if still-valid non-overridable defects remain, the command MAY run **at most one** implementer fix harness round aimed at those findings. That round:

- MAY commit and push on the managed worktree / reviewed head under existing fix disciplines.
- MUST NOT call `pipeline override` for HIGH/CRITICAL/security/authority keys.
- After the fix (or if no fix is run), re-evaluate at new HEAD. Remaining blocking keys → keep park + human notify. Cleared set → re-enter `pipeline single` / continue train for the **same** issue (not backlog restart).

If the only residuals after deterministic recover are eligible for override and all are dispositioned, skip the fix round and re-enter advance.

**Rationale:** Stay-better #9; gives #599-class items a last code fix without silent security override.

**Alternatives:** Override HIGH with "will fix later" (rejected). Unlimited fix rounds (rejected: unbounded). No fix round ever (weaker than issue acceptance).

### D6: Overrides only through existing audited path with key + evidence reason

**Decision:** Eligible dispositions call the same record path as `pipeline override` (ledger, governed validity, evidence subject binding as already required). Each disposition MUST include:

- the finding key from the review record (no keyless dispositions)
- a one-line evidence reason classified as `stale` | `DNR` | `below-high` (or an equivalent closed set of supervisor reason codes)

Prose-only or keyless dispositions are refused. No side door that clears labels without a ledger entry.

**Rationale:** Stay-better #3 and #12; reuses #override-auto-resume for re-enter when valid.

**Alternatives:** Direct label surgery (rejected). New parallel disposition format (rejected: fragments audit).

### D7: Train/Tugboat hook is thin call-once

**Decision:** When train (or Tugboat composition that drives train/advance) observes `needs-human` or leftover `blocked` after the existing deterministic enter-path resume has been attempted, it invokes `recover-parked` **once** for that item/fingerprint. If the item is still parked afterward, apply today's STOP/hold + notify behavior. Train does not classify findings itself and does not call override.

**Rationale:** Issue rules 4 and 11; keeps train free of a second recoverer (#ship-path anti-goal).

**Alternatives:** Automatic infinite re-entry (rejected). Host invents override before calling CLI (rejected).

### D8: Spec surface

**Decision:**

- **NEW** capability `supervisor-recover-parked` for the full behavior contract.
- **ADDED** `command-registry` entry requirement.
- **ADDED** / **MODIFIED** `namespaced-command-surface` so host discovery includes `recover-parked` and only forwards to CLI.
- **ADDED** `integrated-train-mode` park-hook requirement.
- **ADDED** `ship-path-autonomy-doctrine` outer-host CLI-only requirement.

Do not fork override, scratch, or stale-SHA living specs except by composition references.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Senior path accidentally overrides CRITICAL via prose | Pure eligibility from structured severity/category; unit fixture with contradictory prose |
| Fingerprint includes HEAD and re-grants passes | Spec pins sorted keys without HEAD; test same-keys-new-commit |
| Deterministic path skipped → budget wasted on scratch | Enter-order requirement + fixture that asserts no override on scratch clear |
| Train double-invokes or host also overrides | Hook is once per fingerprint; doctrine forbids host override; tests on call count |
| Fix round used as soft override (empty commit + force clear) | Post-fix re-evaluate at HEAD; residual keys re-park; no override of non-eligible keys |
| Governed-override class policy rejects supervisor actor | Map supervisor dispositions to an allowed machine/compatibility class or authenticated pipeline actor already trusted for demotion-style dispositions; fail closed if policy refuses rather than side-door |
| Plugin/host surface drift | Registry + namespaced surface + build.mjs mirror tasks |

## Migration Plan

1. Land OpenSpec planning artifacts (this change) — no application code in the planning commit.
2. Implement CLI + pure eligibility + fingerprint ledger with unit fixtures first.
3. Wire train/hook and host packaging; regenerate `plugin/` if `core/` or host templates change.
4. Validate OpenSpec; run `npm run ci`.
5. Dogfood against #599-class parks: CRITICAL must remain parked; stale/below-high fixtures reflow.

Rollback: remove or disable the command registration and train hook; parks revert to today's human STOP. Override ledger entries already written remain valid history (append-only).

## Open Questions

None that block specs or tasks. Implementation may choose fingerprint marker storage (issue sentinel vs run-state) as long as the one-pass and same-keys-after-commit behaviors are met and unit-tested via deps injection.
