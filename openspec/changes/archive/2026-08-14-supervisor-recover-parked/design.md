## Context

See `proposal.md` for motivation and dogfood (#599, pre-merge residual CRITICAL).

**Existing pieces this change composes (does not reimplement):**

- Audited disposition primitive: `runOverride` / `pipeline override` + governed override ledger + override-auto-resume (`core/scripts/pipeline.ts` `runOverride`, `review-policy.ts` `overrideComment` / `parseOverrideArg`).
- Review-ceiling demotion (#233): `demote_and_advance` in `stages/review-routing.ts` applies only at the **review** round ceiling for below-high findings — not post-park reflow, never HIGH/CRITICAL.
- Deterministic recover:
  - `tryResumeStaleBlocked` in `stages/stale-blocked-rereview.ts` (`cleared` | `keep` | `no-op`; fail-closed on unreadable PR/HEAD).
  - loop recovery `unlink_engine_scratch` in `pipeline.ts` (engine-scratch-only unlink; never invents override).
- Structured finding identity: `findingKey()` / review-artifact `blockingFindings` (`key`, `severity`, `title`, `surface`) via `extractReviewArtifact` / `review-history` ladder; category via structured `ReviewFinding.category` or `surfaceKey` form `file|category`.
- Issue-run lock: `/tmp/pipeline-{domain}-{N}.lock` (`lock.ts`) — host-local serialization for advance + detach; recover-parked acquires the same lock.
- Host surface generation: `OPERATION_SURFACE` in `scripts/build.mjs` (single source for Claude `pipeline:*` and Codex `$pipeline:*`); `plugin/` is regenerated, never hand-edited.
- Train parks per-item on `needs-human` / leftover `blocked` (`stages/train.ts`); whole-train STOP when nothing schedulable remains.
- Ship-path autonomy doctrine: false human vs real human; outer hosts must not invent merge/override authority.

**Gap:** after a true residual park at current HEAD, no engine command re-evaluates stale/DNR/below-high keys and reflows; operators and hosts either wait forever or improvise override.

## Goals / Non-Goals

**Goals:**

- One CLI-owned supervisor pass that reflows only eligible findings and re-enters advance for the same issue.
- Fail-closed on HIGH/CRITICAL/security/authority using **record fields only**.
- Deterministic recover always before senior budget.
- One-pass fingerprint budget that does not reset on same-key new commits or on key-set shrink after partial override.
- Train/Tugboat/host thin composition: call CLI once, then STOP if still parked.

**Non-Goals:**

- Auto-override or auto-advance CRITICAL / security residuals (#599 stays human while CRITICAL).
- Replacing or weakening #1020/#1025 deterministic paths.
- Expanding `demote_and_advance` to pre-merge residual parks as the sole mechanism.
- Second recovery brain inside `train.ts`.
- MessagingPort, grant factory, second durable scheduler, merge in advance/loop.
- Host-side severity reclassification or free-form override invention.
- Multi-pass LLM debate or unbounded fix rounds.

## Decisions

### D1: Single CLI command owns classification and disposition

**Decision:** Implement `pipeline recover-parked <n>` as the only entry that may auto-apply eligible overrides for a park fingerprint. Train, Tugboat, Hermes, and host SKILL invoke this CLI (or no-op + STOP). They MUST NOT call `pipeline override` themselves for this reflow, drop `blocked`, or reimplement classification.

Pure engine entrypoint: `runRecoverParked(cfg, issueNumber, opts, deps) → RecoverParkedResult` in a new module `core/scripts/recover-parked.ts` (or `stages/recover-parked.ts`). CLI and train both call this function; train does not shell out if it can inject the pure entry (same code path as CLI).

**Rationale:** Stay-better constraint #11.

### D2: Structured review-record source and field rules

**Decision — authoritative sources (in order):**

1. **Live residual set at PR HEAD (for still-present keys):** latest review / delta-review comment whose `reviewed-sha` equals live PR HEAD (or the newest review artifact if HEAD matches the park evidence under existing supersession rules). Parse via existing ladder:
   - `extractReviewArtifact(body).blockingFindings[]` → `{ key, severity, title, surface, confidence? }`
   - else `pipeline-blocking-keys` / `pipeline-blocking-surfaces` markers (severity `unknown` → **non-overridable**, fail-closed)
2. **Parked key set (for DNR/stale detection):** sorted keys from the **single causal current-park review artifact** only — the oldest review-ish comment whose `reviewed-sha` equals live PR HEAD (last blocking review round at that HEAD). Never union findings across historical SHAs or prior unrelated parks. Keys already dispositioned by trusted `pipeline-override` sentinels are excluded (`extractOverrides` / governed active projection). When no causal artifact can be identified at live HEAD, senior reflow fails closed.
3. **Category:** prefer structured `ReviewFinding.category` when a full verdict object is available; else parse `surface` as `surfaceKey` form `${normalizeFile}|${category}` when surface is present; category match for security is exact lowercased `security`. Missing/unknown category does **not** unlock override of high/critical; for below-high present keys without security category → eligible as `below-high`.
4. **Authority parks:** if current `blockerKind` / stage diagnostic is `human-decision-required` or missing-authority / human-authority class (`isHumanAuthorityBlocker`), senior override path is refused entirely (no key reclassification). Deterministic recover may still run first.

**Per-key classification (pure function `classifyParkedFinding`):**

| Condition on structured record | Result |
|--------------------------------|--------|
| Authority / human-decision-required / missing-authority (any presence) | `non-overridable` — **before** DNR |
| category `security` (any presence, incl. absent-at-HEAD historical) | `non-overridable` |
| `severity` ∈ {`high`,`critical`} (incl. historical park record when absent at HEAD) | `non-overridable` — **ignore all prose** |
| Key **absent** from live residual set **and** not protected above | `override-eligible` reason `stale` or `DNR` (closed code) |
| Key present, severity `unknown` or unparsable | `non-overridable` (fail-closed) |
| Key present, severity below high, not security, not authority | `override-eligible` reason `below-high` |
| Free-text / classifier prose saying "nit" | **never consulted** |

**Absent-key original record:** within the causal park artifact, park-time structured severity/category/authority SHALL be retained when merging with the live residual. Protected-class gate runs before stale/DNR so a park-time HIGH/CRITICAL/security/authority key absent from a later residual artifact **at the same HEAD** is never auto-overridden. Keys from reviews at other SHAs are not part of the current park and MUST NOT strand a later park. Only non-protected absent keys (from the causal artifact) are DNR-eligible. Senior residual load is HEAD-bound (`useLatestIfNoHeadMatch: false`).

### D3: Deterministic engine recover before fingerprint creation or senior mutation

**Order (hard):**

1. Resolve issue + park eligibility (`blocked` and/or `pipeline:needs-human` residual park). Unparked → `{ status: "not-parked" }`, no mutations.
2. Acquire issue-run lock `(domain, issue)`.
3. Read linked PR + live HEAD. Unreadable → `{ status: "fail-closed" }`, keep park, **no** fingerprint write, **no** override.
4. Deterministic recipes (no senior budget):
   - If engine-scratch / workflow-engine-defect evidence applies: invoke existing `unlink_engine_scratch` recovery action (or the same deps-injected function).
   - If stage eligible: `tryResumeStaleBlocked(cfg, issue, detail, deps)` — on `cleared`, re-check park labels; if park cleared → `{ status: "deterministic-cleared" }` exit without senior path.
5. Only if park remains: compute residual key set at live HEAD + park fingerprint; enter senior path.

**Contracts:**

- `tryResumeStaleBlocked`: `cleared` | `keep` | `no-op` (existing).
- `unlink_engine_scratch`: succeeded/failed evidence string (existing recovery result).
- Neither path posts `pipeline-override` or spends supervisor fingerprint.

### D4: Fingerprint ledger — durable, lock-serialized, write-before-side-effects

**Fingerprint identity:**

```text
F = (issueNumber, stageId, sortedBlockingKeys[])
stageId = pickStage(labels) at senior-enter (e.g. needs-human, pre-merge, review-2, fix-1)
canonicalKeys = [...blockingKeys].map(k => k.toLowerCase()).sort()
fingerprintId = sha256_hex(`${issueNumber}\n${stageId}\n${canonicalKeys.join(",")}`).slice(0, 16)
```

HEAD SHA is **not** part of F.

**Storage:** issue comment sentinel (durable, readable by later hosts), same dual-read style as override gov:

```text
<!-- pipeline-recover-parked-spent: v1 {"fingerprint":"<id>","issue":N,"stage":"<stage>","keys":["..."],"at":"<iso>"} -->
```

Extractor: pure `extractRecoverParkedSpent(comments) → SpentFingerprint[]`.

**Spend semantics (write-before-side-effects):**

1. Under issue-run lock, re-read comments for existing spent markers.
2. If F is already spent **or** any spent key-set for the same `(issue, stage)` is a **superset** of current keys (subset-after-partial-override rule — D4b) → `{ status: "already-spent" }`, no override, no fix.
3. Else **post spend sentinel first** (append-only comment). If post fails → fail-closed, no overrides.
4. Then apply eligible overrides / optional fix.
5. Partial override failure after spend: fingerprint remains spent (no second senior pass); keep park for remaining keys; no label clear without audited disposition.

**Concurrency:** issue-run lock serializes same-host train/single/recover-parked. Cross-host: GitHub comment is source of truth for "spent"; two hosts racing may both attempt post — extractor treats any matching fingerprint as spent; double override of same key is idempotent via existing override extractors / last sentinel wins, but budget is one senior pass.

**D4b — Key-set transition / subset rule:**  
When senior enter spends F for key set K, and eligible keys are overridden so remaining blocking keys K' ⊂ K, a later invocation with fingerprint on K' MUST NOT grant a new senior pass. Implementation: spent if ∃ prior spent record for same `(issue, stage)` whose `keys` set **covers** current keys (current ⊆ prior). A **new** key not in any prior spent set yields a new F that MAY receive one pass.

### D5: Fix round may address HIGH/CRITICAL; override path must not

**Decision:** After eligible overrides (if any), if still-valid non-overridable defects remain, the command MAY run **at most one** implementer fix round:

- Invocation: deps-injected `runOneImplementerFixRound({ issue, findings, worktree })` that reuses existing fix-stage harness path with an explicit **one-round cap** (does not open unbounded fix loops). Prefer composing the existing fix stage entry with `maxRounds: 1` rather than inventing a parallel implementer.
- The fix deps object **must not** include `runOverride` / must not call override for protected keys (enforced by pure eligibility gate on any disposition attempt + unit test).
- After fix (or skip): re-read live HEAD + residuals. Empty blocking set → re-enter. Remaining non-overridable → keep park.
- Fix commits allowed for HIGH/CRITICAL; override of those keys refused.

### D6: Overrides only through existing audited path with key + evidence reason

Eligible dispositions call the same record path as `runOverride` (or a shared internal `recordAuditedKeyOverride` used by both), posting `overrideComment` / governed sentinels. Each disposition MUST include:

- finding key (8 hex) from the review record
- one-line evidence reason from closed set: `stale` | `DNR` | `below-high` (reason text may be `stale: key absent at live HEAD <sha7>` etc.)

Keyless / prose-only refused. No `clearBlocked` without audited disposition except deterministic clear paths that already clear leftover block without override.

Supervisor actor: use authenticated `getGhActor()` through existing governance; map to an allowed class (e.g. low-risk deferred / machine-compatible class already trusted for demotion-style dispositions) or fail closed if policy refuses — never side-door.

### D7: Re-entry control (no recursive recover-parked)

**Decision:**

- After residual set empty (via deterministic clear, overrides, and/or successful fix that clears residuals), re-enter **same-issue** advance via deps `runSingle` / `runAdvance` with internal option `skipRecoverParked: true` (or train continues the item without calling recover-parked again in the same wave).
- `runRecoverParked` itself MUST NOT call recover-parked.
- Re-entry preserves issue-run lock ownership rules: release only after command completes; re-enter under same lock or re-acquire per existing single/advance contract — do not drop the lock mid-mutation without the normal acquire path.
- Do **not** restart from backlog selection; same issue number continues toward ready-to-deploy.

### D8: CLI result contract

```ts
export type RecoverParkedStatus =
  | "deterministic-cleared" // park cleared without senior budget
  | "recovered"             // senior path cleared residuals; re-entered or ready to re-enter
  | "still-parked"          // non-overridable remain / fix did not clear
  | "already-spent"         // fingerprint (or covering superset) spent
  | "not-parked"            // fail-closed no-op
  | "fail-closed";          // unreadable PR/HEAD or lock/IO refuse

export interface RecoverParkedResult {
  status: RecoverParkedStatus;
  issue: number;
  fingerprintId?: string;
  stageId?: string;
  keys?: string[];
  overridesApplied?: Array<{ key: string; reason: "stale" | "DNR" | "below-high" }>;
  fixRoundRan?: boolean;
  reentered?: boolean;
  message: string;
}
```

**Exit codes:**

| status | exit |
|--------|------|
| deterministic-cleared, recovered, already-spent | 0 |
| still-parked, not-parked, fail-closed | 1 |
| disallowed flags / bad args | 2 (before any mutation) |

`--json` prints `RecoverParkedResult`. Train consumes the shared engine entrypoint (not host-local classification) and maps: recovered/deterministic-cleared → continue same issue; already-spent/still-parked/fail-closed → hold + notify (today's STOP rules); never invent override.

### D9: Train / Tugboat thin hook

When train observes `needs-human` or leftover `blocked` **after** existing deterministic enter-path resume for the current advance:

1. Call `runRecoverParked` once for that issue.
2. If recovered / deterministic-cleared → allow same-issue continuation on the work list.
3. Else hold item + notify; do not call override; do not drop labels.
4. Track per-item "recover-parked attempted this park" in train local state for the wave so a spent/still-parked result is not re-invoked in a tight loop within the same train drive (fingerprint ledger is the durable guard across drives).

No merge authority from recover-parked.

### D10: Host packaging

- Add `recover-parked` to `COMMAND_REGISTRY` with explicit `allowedFlags` (repoPath, base, profile, domain, json, dryRun if supported without mutation — prefer dryRun = classify-only no write).
- Add `COMMAND_DOCS` entry.
- Append to `OPERATION_SURFACE` in `scripts/build.mjs` (not hand-written host files).
- Run `node scripts/build.mjs`; commit regenerated `plugin/` + Claude commands.
- Host entry text: forward only to `pipeline recover-parked`; forbid inventing override / label drop.

### D11: Spec surface

- NEW `supervisor-recover-parked`
- ADDED command-registry, integrated-train-mode, ship-path-autonomy-doctrine
- MODIFIED namespaced-command-surface in-scope list

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Prose reclassifies CRITICAL | Pure eligibility ignores body/prose; fixture CRITICAL+"nit" |
| Subset key set re-grants pass | D4b covering-superset spent rule + fixture |
| Budget spent on scratch | Deterministic-first before fingerprint write |
| Concurrent double pass | Issue-run lock + write-before-side-effects sentinel |
| Recursive recover via single | `skipRecoverParked` re-entry guard |
| Fix round soft-overrides | No override in fix deps; post-fix re-eval |
| Governance refuses supervisor actor | Fail closed; no label side-door |
| Host/plugin drift | OPERATION_SURFACE + build.mjs only |

## Migration Plan

1. Planning artifacts (this change) — done for proposal/specs; design revised post plan-review.
2. Implement pure eligibility + fingerprint helpers + unit fixtures first.
3. Wire CLI + deterministic compose + override + optional fix + re-enter.
4. Train hook + docs + OPERATION_SURFACE; regenerate plugin/.
5. `openspec validate supervisor-recover-parked` + `npm run ci`.
6. Dogfood: #599-class CRITICAL remains parked.

Rollback: remove registry entry + train hook; parks revert to human STOP. Spent sentinels and override ledger entries remain valid history.

## Open Questions

None remaining that block implementation. Fingerprint storage, subset rule, result contract, deterministic entrypoints, re-entry guard, and structured-record source are decided above.
