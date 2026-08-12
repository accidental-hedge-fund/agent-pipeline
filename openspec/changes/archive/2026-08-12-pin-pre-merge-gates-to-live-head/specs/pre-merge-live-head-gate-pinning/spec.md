## Purpose

Ensure every pre-merge tester, CI, and delta-review gate pins its inputs to the live open PR head SHA, invalidates superseded-SHA fail authority when the head advances, and refuses to block a green tip solely on stale fail evidence or prior-head finding keys.

## ADDED Requirements

### Requirement: Pre-merge gates SHALL pin inputs to the live open PR head at gate start

When pre-merge evaluates tester evidence, CI / test-gate classification, or delta-review blocking authority for an issue with an open PR, the pipeline SHALL resolve the current open PR head SHA (live head / `headRefOid` equivalent) at the start of that evaluation and SHALL use that live head as the sole currency pin for those inputs for the remainder of the evaluation. The pipeline SHALL NOT treat a superseded candidate SHA from an earlier fail, an older `stage_accounting` test-gate row, or a prior-head finding marker as the evaluation head.

#### Scenario: Gate start resolves live head once for all three surfaces

- **WHEN** pre-merge enters an evaluation that may consume tester evidence, CI/test-gate classification, or delta blocking markers
- **THEN** the pipeline SHALL resolve the open PR’s current head SHA before those consumers decide pass/fail/block
- **AND** every consumer in that evaluation SHALL compare recorded SHAs against that same live head pin

#### Scenario: Superseded fail candidate is not the evaluation head

- **WHEN** the live open PR head is SHA `H_green`
- **AND** the most recent `tester_evidence` record has `candidate_sha` equal to prior fail SHA `H_fail` where `H_fail ≠ H_green`
- **THEN** the pipeline SHALL NOT treat `H_fail` as the head under evaluation for pre-merge tester or CI disposition
- **AND** SHALL pin evaluation to `H_green`

---

### Requirement: Head advance SHALL invalidate fail authority keyed only to the prior SHA

When the live PR head advances from SHA A to SHA B (A ≠ B), the pipeline SHALL invalidate pre-merge **fail** and **exhaustion** authority that is keyed only to A for tester evidence, local test-gate accounting, CI recovery exhaustion markers that are per-head, and delta blocking keys recorded only against A. Invalidation means those A-scoped records SHALL NOT alone produce `blocked` / `needs-human` for head B. The pipeline SHALL re-evaluate at B (re-acquire evidence, re-run delta, and/or consult live-head github checks) before applying a new fail or block disposition for B.

#### Scenario: Fail tester evidence for A does not fail B after head move

- **WHEN** the live head moves from `H_fail` to `H_green`
- **AND** the only tester-evidence fail record has `candidate_sha = H_fail`
- **THEN** pre-merge SHALL classify that record as non-current for `H_green`
- **AND** SHALL NOT set `test-gate-exhausted` or equivalent suite-fail block solely from that record

#### Scenario: Per-head CI exhaustion for A does not exhaust B

- **WHEN** recovery budget for head `H_fail` is exhausted
- **AND** the live head is now `H_green` (distinct SHA)
- **THEN** the pipeline SHALL NOT treat the `H_fail` exhaustion as budget exhaustion for `H_green`
- **AND** SHALL apply existing per-head budget rules for `H_green` only

#### Scenario: Invalidation regression fails if prior-head fail still blocks

- **WHEN** a regression test supplies fail evidence and blocking keys for `H_fail` and a live head of `H_green` with green checks
- **THEN** the test SHALL assert that pre-merge does not block solely on the `H_fail` evidence
- **AND** that assertion SHALL fail if the implementation still escalates from the prior-head fail alone

---

### Requirement: Green live-head CI SHALL NOT be overturned by superseded fail evidence

When the live open PR head is SHA H and github-mode CI checks for H are definitively successful (or, under local mode, a SHA-matched test-gate pass exists for H), the pipeline SHALL NOT set pre-merge `blocked` / `needs-human` using only tester fail rows, `stage_accounting` test-gate failure rows, or docs-stale / generate-docs narratives whose recorded candidate or test SHA is not H. Green certification of H remains mandatory: pending or failed checks on H continue to wait or recover/block under existing `pre-merge-ci-gate` contracts.

#### Scenario: GitHub success on H_green ignores H_fail tester fail

- **WHEN** the live head is `H_green` and `getPrChecks` (or equivalent) reports success for `H_green`
- **AND** the only tester-evidence / test-gate fail rows name `candidate_sha` / `pr_head_sha` = `H_fail` where `H_fail ≠ H_green`
- **THEN** pre-merge SHALL NOT return `blocked` with a CI or suite-fail reason keyed only to `H_fail`
- **AND** SHALL proceed past the suite/CI fail path that would have applied had the live head still been `H_fail`

#### Scenario: Red checks on live head still block or recover

- **WHEN** the live head is H and github checks for H are definitively failing
- **THEN** the pipeline SHALL follow existing CI recovery and exhaustion contracts for H
- **AND** SHALL NOT skip those contracts because older evidence for another SHA was green

#### Scenario: Docs-stale narrative at old SHA does not block green tip alone

- **WHEN** a prior delta or autofix path recorded a docs-stale / `generate-docs --check` blocking claim against `H_fail`
- **AND** the live head is `H_green` with green github checks and no SHA-matched re-evaluation that still finds the defect at `H_green`
- **THEN** pre-merge SHALL NOT escalate to `needs-human` solely on that prior-head docs-stale claim

---

### Requirement: Blocking delta findings SHALL be SHA-scoped for pre-merge authority

A pre-merge blocking delta finding, residual blocking set, or `pipeline-blocking-keys` marker SHALL carry or be associated with the head SHA at which it was recorded. The pipeline SHALL treat such a finding as having blocking authority for the live head only when its recorded SHA equals the live head, or when a fresh evaluation at the live head has re-asserted it. A finding recorded only against head A SHALL NOT automatically block head B without re-evaluation at B, except under an explicit audited override or carry-forward policy already defined by other capabilities that still requires live-head evaluation before terminal block.

#### Scenario: Finding keys from H_fail do not auto-block H_green

- **WHEN** a durable blocking-key marker names finding key `K` recorded against reviewed SHA `H_fail`
- **AND** the live open PR head is `H_green` where `H_green ≠ H_fail`
- **THEN** pre-merge SHALL NOT `setBlocked` solely because key `K` remains in the prior-head marker set
- **AND** SHALL re-run or re-verify delta evaluation at `H_green` before any new block disposition for those findings

#### Scenario: Finding re-asserted at live head still blocks

- **WHEN** delta evaluation at live head `H_green` produces blocking findings under the active `review_policy`
- **THEN** the pipeline SHALL route those findings through the existing fix-round / escalation path for `H_green`
- **AND** MAY record SHA-scoped blocking markers for `H_green`

#### Scenario: Control — same-head residual still blocks

- **WHEN** the recorded blocking keys’ reviewed SHA equals the live head
- **AND** those findings remain unresolved and not overridden
- **THEN** pre-merge SHALL still block at the live head exactly as under existing residual-block contracts

---

### Requirement: Does-not-reproduce at green live head SHALL prefer re-verify over stale exhaustion

When the bounded pre-merge autofix path reports a valid does-not-reproduce or clean no-commit (noop-clean) outcome at live head H, the worktree is clean with no new commit, and CI for H is green (github success on H, or SHA-matched local pass for H), the pipeline SHALL re-verify residual blocking findings at H (or clear block authority for findings that only had prior-head keys) before escalating. The pipeline SHALL NOT set `blocked` / `needs-human` solely because the autofix attempt budget is exhausted when the only remaining blocking keys or fail narrative are scoped to a prior head A ≠ H. When re-verify at H still finds residual blocking findings, the pipeline SHALL escalate under existing one-attempt rules and the block reason SHALL name both the prior candidate SHA (when applicable) and live head H, and SHALL state whether an audited `pipeline override` is required.

#### Scenario: #1010-class path — DNR + green tip does not need override for stale key

- **WHEN** live head is `H_green` with green github checks
- **AND** autofix at `H_green` is noop-clean / does-not-reproduce with a clean worktree
- **AND** the only durable blocking key was recorded against prior fail head `H_fail`
- **THEN** pre-merge SHALL re-verify or clear authority at `H_green` rather than escalate solely as autofix-exhausted on that prior-head key
- **AND** SHALL NOT require an operator override solely to advance past that stale key when re-verify is clean

#### Scenario: Residual true block at live head still escalates with dual-SHA reason

- **WHEN** re-verify at live head H still reports residual blocking findings under the active policy
- **AND** autofix budget for the entry is exhausted
- **THEN** the pipeline SHALL set `blocked` / `needs-human` under existing residual rules
- **AND** the reason text SHALL include the live head SHA H
- **AND** when a prior candidate SHA A was involved, SHALL include A and whether override is required

#### Scenario: Dirty or failed autofix is unchanged

- **WHEN** autofix leaves a dirty worktree without successful salvage, times out, or otherwise fails under existing non-noop error paths
- **THEN** the pipeline SHALL follow existing pre-merge fix-round failure contracts
- **AND** SHALL NOT treat this requirement as a free pass past those failures

---

### Requirement: Regression coverage SHALL replay the fail-head-to-green-head history

The test suite SHALL include a regression that drives pre-merge with injectable deps (no real network, git, or subprocess): prior fail evidence and blocking keys at SHA `H_fail`, live head and green checks at SHA `H_green`, and an autofix seam that reports does-not-reproduce / noop-clean at `H_green`. The test SHALL assert that pre-merge does not block solely on the prior-head suite/delta narrative, that evaluation pins to `H_green`, and that a control case with residual blocks at `H_green` still blocks.

#### Scenario: Fail→green head fixture pins to green head only

- **WHEN** the fixture supplies `H_fail` fail tester/test-gate rows and `H_green` live head with green checks
- **THEN** the pre-merge evaluation under test SHALL use `H_green` for tester, CI, and delta authority
- **AND** SHALL NOT produce `blocked` / `needs-human` solely from the `H_fail` rows

#### Scenario: Control residual at green head still blocks

- **WHEN** the same fixture style supplies residual blocking findings re-verified at `H_green`
- **THEN** pre-merge SHALL still block under residual-finding rules
- **AND** the test SHALL fail if residual live-head findings are silently dropped
