## Context

Pre-merge runs a focused adversarial **delta review** when the PR head moved with a real
developer/fix commit after the last reviewed SHA. Blocking findings that pass the category
allowlist (`correctness`, `missing-dep`) get **one** bounded auto-fix via
`performPreMergeAutoFix` (#359). Success path: commit → amend with `PRE_MERGE_AUTOFIX_PREFIX`
→ push → single post-fix delta re-review (#371). Dirty no-commit path: salvage (#547) or
fail-closed rollback. Clean no-commit path today (#553): return `{ status: "error", diagnostic }`
naming the worktree; the delta block path falls through to `setBlocked` / `needs-human`.

Dogfood (#683 / PR #696): delta re-raised a stale classification finding against a SHA that
**already** used `needs-human` for that off-ramp. Auto-fix correctly left a clean tree; the
pipeline still hard-blocked. Loop then advertised `advance` while GitHub still had `blocked`,
until `supervisor_no_progress`.

Existing related specs that this design must **not** regress:

| Capability | Constraint to preserve |
|------------|------------------------|
| `pre-merge-fix-round` | At most one auto-fix attempt; surgical-fix prompt; developer-classified fix commit |
| `harness-uncommitted-salvage` | Dirty no-commit still salvages, pushes, re-reviews |
| `pre-merge-delta-recheck` | Post-fix re-review uses local post-fix head; supersession / SHA currency |
| `fix-round-noop-advance` | Full fix-stage does-not-reproduce is a **different** surface; do not conflate prompt formats unless reusing patterns deliberately |
| Review rigor | Re-verify is still a real check — not “no-op ⇒ approve” |

## Goals / Non-Goals

**Goals:**

1. Clean auto-fix no-op is **ambiguous**, not terminal: re-verify findings on current HEAD.
2. Proceed without human when re-verify is clean; escalate once with a clear recipe when not.
3. Preserve one-attempt bound, salvage, dirty fail-closed, prior-prefix detection, and CI gates.
4. Improve block-comment quality so operators can tell no-op-false-positive from no-op-still-broken.
5. Optionally stop loop schedule from advertising `advance` for already-blocked items without unblock.

**Non-Goals:**

- Expanding auto-fix category allowlist (#680).
- Changing #181 CI fail-closed.
- Auto-merge or inventing empty commits.
- Replacing delta review with a pure static analyzer for all finding types (only prefer cheap
  HEAD checks for pure classification/control-flow claims; full delta re-run remains valid).
- Changing full fix-stage (`fix-1`/`fix-2`) no-commit policy beyond what is already in
  `fix-round-noop-advance` (unless a shared helper is a pure extract with no behavior change).

## Decisions

### Decision 1: Distinguish clean no-op from generic auto-fix error

**Choice:** Introduce an explicit result status (or equivalent discriminated outcome) from
`performPreMergeAutoFix` / `attemptPreMergeAutoFix` for the confirmed clean no-commit case —
e.g. `noop-clean` carrying the #553 diagnostic string — separate from `error` (dirty,
timeout, amend/push failure, unreadable HEAD, pre-dirty tree).

**Why:** Callers currently treat any non-`fix-committed` as “fall through to block.” A
dedicated status makes the re-verify branch intentional and testable without parsing diagnostic
strings.

**Alternatives:**

- Parse diagnostic text → fragile.
- Always re-verify on any `error` → wrong for dirty/timeout (must not pretend HEAD was rechecked
  when the tree was reset or the harness never finished).

### Decision 2: Re-verify = one delta re-review at current HEAD (primary path)

**Choice:** On `noop-clean`, re-run the **same** post-auto-fix delta re-review machinery already
used after a successful fix commit, anchored to the **unchanged** head SHA (`headBefore`), with
diff range still `reviewed-sha...HEAD`. Do **not** invent a second auto-fix. Do **not**
increment review-2 ceiling. Count as consuming the single auto-fix attempt (the attempt already
ran) so a later pre-merge entry with still-blocking findings sees the attempt exhausted via an
explicit durable marker.

**Durable marker for no-op attempt:** Because there is **no** `PRE_MERGE_AUTOFIX_PREFIX` commit,
the one-attempt bound cannot rely only on commit-subject scan. The design requires a durable
marker the next pre-merge entry can read without run-local state only:

- **Preferred:** post a trusted pipeline comment (or sentinel in the delta / auto-fix audit
  comment) that records “pre-merge auto-fix attempted at SHA `<head>`; outcome: noop-clean”
  before or with the re-verify result, and treat that marker as prior attempt when scanning for
  the one-attempt bound; **or**
- Reuse an existing durable channel if one already records auto-fix attempts without a commit
  (confirm in implementation; do not invent a second store under the run dir as sole authority).

If re-verify **approves**, proceed (no block). If re-verify **still blocks**, escalate once with
the no-op recipe. If re-verify is **unparseable** / head currency unknown, fail closed to the
existing conservative re-review / block paths — do not invent approval.

**Alternatives:**

- Trust harness “does not reproduce” declarations only (#fix-round-noop-advance pattern) →
  helpful later, but #683 needs pipeline-side re-verify even when the harness is silent.
- Deterministic-only HEAD assertion without reviewer → good as a **fast path** for pure
  classification findings when cheap and decisive; insufficient as the sole general mechanism.

### Decision 3: Optional cheap HEAD assertion for classification claims

**Choice:** Prefer, when a blocking finding is a pure classification/control-flow claim with a
cited file/region, a cheap injectable check (re-read cited lines or a small pure predicate over
file content at HEAD) **before or as part of** deciding the finding still blocks. If the
predicate proves the recommended behavior is already present and no contradictory failing check
exists, treat the finding as not reproducible for re-verify purposes. If the check cannot prove
either way, fall through to full delta re-review.

**Why:** #683-class false positives are exactly “HEAD already does the right thing.” A cheap
check reduces another expensive harness call when decisive, without replacing adversarial review
for real correctness bugs.

### Decision 4: #553 disclosure stays; terminal disposition changes

**Choice:** Keep naming the worktree and stating the harness left no recoverable work. Change
only the **terminal** step: re-verify instead of immediate `needs-human`. On still-broken
escalation, **combine** the disclosure with the new recipe (auto-fix made no diff; finding still
present at path).

**Why:** Disclosure was the right operator UX; the bug is treating disclosure as hard terminal.

### Decision 5: Modify living requirements that currently mandate hard block on clean no-op

**Choice:** Explicit **MODIFIED** deltas for:

1. `pre-merge-fix-round` — “roll back on failure” / no-commit escalation carve-out for clean no-op.
2. `harness-uncommitted-salvage` — “ran-but-no-recoverable-work … escalate to needs-human” becomes
   re-verify-then-disposition.

Do not leave contradictory living requirements after archive.

### Decision 6 (optional): Loop `next_actions` for blocked items

**Choice:** When live labels include `pipeline:blocked` and there is no recorded unblock path,
`computeNextAction` / reconciliation **SHALL NOT** emit an actionable `advance` that implies a
dispatch can clear the item. Prefer `hold` / `waiting` / explicit unblock guidance consistent with
`loop-blocked-item-hold-continuation`.

**Why:** Dogfood confusion: schedule said `advance` while GitHub blocked. Scope this as optional
in proposal acceptance so the pre-merge fix can ship alone if loop work is deferred.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Infinite re-verify without a commit marker re-attempts auto-fix | Durable prior-attempt marker for noop-clean; one-attempt bound tests |
| Approving on silent no-op without re-verify | Spec + tests require re-verify seam call; fail closed if re-verify unavailable |
| Extra delta harness cost on every no-op | Acceptable vs human stranding; optional cheap HEAD check short-circuits when decisive |
| Conflating dirty error with noop-clean | Discriminated status; dirty still rolls back and blocks without “approved” |
| Weakening salvage / #547 | Dirty path unchanged; only clean branch diverges |
| Loop optional work slips | Acceptance criterion marked optional; primary AC are pre-merge |

## Migration Plan

1. Spec this change (this OpenSpec folder).
2. Implement result status + caller re-verify branch + durable attempt marker + tests.
3. Regenerate `plugin/` if `core/` changes; `npm run ci`.
4. Archive OpenSpec at pre-merge as usual.
5. No data migration; behavior change is path-local to pre-merge auto-fix.

Rollback: revert the pre-merge branch; living specs after archive would need a follow-up change
to restore old hard-block if ever desired (not expected).

## Open Questions

1. **Exact durable marker** for noop-clean prior attempt (comment sentinel vs existing event/
   evidence field that survives host switch) — resolve during implementation by inspecting
   current pre-merge auto-fix audit comments and one-attempt scan code.
2. **Whether** to also teach the fix harness a pre-merge “does not reproduce” declaration
   (parity with `fix-round-noop-advance`) as a **secondary** signal — nice-to-have; not required
   for #698 if pipeline re-verify is mandatory.
3. **Ship loop next_actions fix in the same PR** vs follow-up issue — default: include if small;
   otherwise file follow-up and keep optional AC unchecked until then.
