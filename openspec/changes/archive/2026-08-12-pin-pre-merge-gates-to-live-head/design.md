## Context

See proposal.md for the #927 / #1010 failure mode. Pre-merge already has several SHA-related contracts:

- `tester-evidence` requires SHA match at **review** acquisition.
- `pre-merge-ci-gate` local mode refuses a **pass** when `pr_head_sha` ≠ live head (fail-closed on stale pass).
- `pre-merge-delta-recheck` treats a delta verdict as superseded when the head moves **during** review and re-runs at the new head.
- `pre-merge-entry-gate-head-anchor` amortizes head-bound entry gates across CI poll ticks within one session.

The production gap is different: **fail authority** and **blocking markers** produced at head H_fail remain effective after the tip moves to H_green. Local `stage_accounting` / `tester-evidence` rows for H_fail, combined with delta finding keys and autofix-exhausted accounting, can strand pre-merge even when GitHub Actions on H_green is success and regenerate-at-head is a no-op.

This design pins every pre-merge consumer of those inputs to the **live open PR head at gate start**, with explicit invalidation when the head moves.

## Goals / Non-Goals

**Goals:**

- Single live-head pin at pre-merge gate entry for tester, CI classification, and delta block authority.
- Head advance invalidates fail authority and blocking keys keyed only to the prior SHA.
- Green live-head CI (github checks success, or SHA-matched suite pass for that head) cannot be overturned by superseded fail evidence.
- Autofix noop-clean / does-not-reproduce at a green live head re-verifies or clears rather than escalating solely on prior-head exhaustion.
- Regression tests that fail if any of the three surfaces re-litigate H_fail after H_green.

**Non-Goals:**

- Changing entry-gate poll amortization (`pre-merge-entry-gate-head-anchor`).
- Weakening residual true blocks at the live head, or removing `pipeline override` for those cases.
- Skipping github CI when checks are pending or red on the live head.
- Cross-process durable “last green SHA” ledgers beyond existing run artifacts.
- Auto-merge or merge authority changes.

## Decisions

### 1. Live head is the sole gate pin source

**Decision:** At the start of each pre-merge advance that evaluates tester, CI, or delta block authority, resolve the open PR’s current head SHA (`getPrDetail` / `headRefOid` equivalent) once and pass that pin into every consumer for that evaluation.

**Why:** Multiple independent readers of `tester-evidence.json`, last `stage_accounting` test-gate row, and comment markers can disagree if each re-reads head later or skips the compare.

**Alternatives:** Trust worktree HEAD alone — rejected because worktree can lag the remote tip after concurrent push; trust comment sentinels alone — rejected because they can lag too.

### 2. Stale fail is non-authoritative (not a hard block by itself)

**Decision:** When fail evidence (tester overall_status failed/timeout/…, test-gate failure accounting, CI recovery exhaustion markers) records `candidate_sha` / `pr_head_sha` ≠ live head, classify it **stale** for blocking purposes. Stale fail MUST NOT alone produce `test-gate-exhausted`, `ci-exhausted`, or docs-stale `needs-human`. The engine either (a) re-acquires evidence / re-runs gates at the live head, or (b) defers to live-head github check status when `ci_mode: github`.

**Why:** Existing local-mode rules fail-closed on **stale pass** (correct integrity). Symmetric treatment of **stale fail** as “not current fail” is required to stop the #927 loop without inventing a pass.

**Alternatives:** Always re-run full local suite on any SHA mismatch — allowed as an implementation choice when evidence is missing for the live head, but not required when github checks already certify the live head under `ci_mode: github`.

### 3. SHA-scope delta blocking markers at gate start

**Decision:** Extend the existing mid-review supersession model so that **at gate entry**, any durable `pipeline-blocking-keys` / residual finding set is authoritative only when its reviewed/recorded SHA equals the live head (or an explicit re-evaluation at the live head has just produced them). Markers for a prior head lose blocking authority until delta re-runs at the live head.

**Why:** #427/#432 history already required not blocking on stale keys after head move during fix; #1010 shows the same class when the fail head is older than a green tip and autofix DNR does not rewrite markers.

**Alternatives:** Require operator override for every head move — rejected (observed override with zero code change). Auto-clear all findings without re-review — rejected (weakens rigor when live head still has the defect).

### 4. Does-not-reproduce + green live head → re-verify, not exhausted park

**Decision:** When the bounded pre-merge autofix returns noop-clean / does-not-reproduce at live head H, the worktree is clean, and live-head CI is green, terminal disposition MUST run the existing clean-noop re-verify / shared noop-advance evaluation at H. Escalation solely because “autofix already attempted” for findings whose only blocking evidence is keyed to a prior head is forbidden. If re-verify still blocks at H, escalate with a reason that names both the prior candidate SHA (if any) and H, and whether override is required.

**Why:** Matches observed operator recovery (override after green tip) without hiding true residual findings.

### 5. Prefer ADDED requirements over rewriting large existing blocks

**Decision:** Specs add requirements under a new capability plus ADDED deltas on existing capabilities, rather than MODIFIED rewrites of long CI/delta requirements, except where an existing requirement’s normative text is wrong for stale fail.

**Why:** Keeps archive merges surgical and avoids accidental loss of recovery-ladder detail.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Treating stale fail as non-block could hide a still-red live head if github checks are misread | Always re-resolve live head and check status for that SHA; pending/red on live head still wait/block under existing CI contracts |
| Race: head moves again during evaluation | Existing post-delta re-validation / fail-closed supersession paths remain; pin is at gate start, re-validate before record |
| Over-clearing finding keys | Only invalidate authority for keys scoped to non-live SHA; re-eval at live head can re-block |
| Double work regenerating tester evidence | Prefer github green on live head when `ci_mode: github`; regenerate only when pre-merge still needs suite evidence for the live SHA |
| Confusing operators when both SHAs appear in reasons | Standardize block text: “stale candidate \<H_fail\>; live head \<H_green\>” |

## Migration Plan

- Behavior change only; no config key required for the pin contract.
- Existing run dirs with stale `tester-evidence.json` remain on disk; acquisition treats them as stale for the new head (same as review).
- No data migration. Rollback = revert the change; worst case returns to override-required stranding on green tips.

## Open Questions

None that block specs or tasks. Implementation may choose exact helper names and whether live-head pin is a single struct passed through `AdvancePreMergeDeps` consumers — that does not change requirements.
