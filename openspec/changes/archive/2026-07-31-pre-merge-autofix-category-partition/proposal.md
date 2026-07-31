## Why

Pre-merge delta review can raise a mixed blocking batch: some findings are allowlisted for the
bounded auto-fix path (`correctness`, `missing-dep`, `concurrency`), and some are not
(`spec-divergence`, `security`, `scope`, `product-judgment-required`, etc.). Today the gate is
all-or-nothing — `allBlockingAutoFixable` requires **every** blocking finding to be allowlisted
— so one non-allowlisted category **vetoes the entire batch** and skips auto-fix even when
surgical code fixes remain. Dogfood **#729** co-batched a HIGH `concurrency` TOCTOU with a HIGH
`spec-divergence` partial-list finding under one override key; auto-fix never ran and the item
went straight to `blocked` / `needs-human`, stranding operators on a false full-batch human hold.

## What Changes

- **BREAKING (behavior):** Replace the all-or-nothing auto-fix eligibility rule with **category
  partition**. A non-empty allowlisted subset is eligible for the existing one-attempt pre-merge
  auto-fix path even when residual non-allowlisted findings are present in the same delta batch.
- Scope the auto-fix harness prompt to the **allowlisted subset only** (not residual
  human-disposition findings).
- Keep pure-allowlisted batches unchanged: at most one auto-fix attempt, then re-delta /
  noop re-verify / exhaust / block as today.
- Keep pure non-allowlisted batches unchanged: skip the harness and escalate without an auto-fix
  attempt.
- When residual non-allowlisted findings remain (or still-broken allowlisted findings remain after
  the attempt), the block reason **SHALL** name which override keys / categories required human
  disposition versus which were auto-fix attempted.
- Living allowlist membership is **not** expanded: `security`, `scope`,
  `product-judgment-required`, `spec-divergence`, `data-loss`, `observability`, and
  empty/unknown stay excluded from auto-fix.
- OpenSpec deltas update `pre-merge-fix-round` (and the delta-recheck wording that currently
  says “all blocking findings are auto-fixable” / “a non-allowlisted category skips fix”).

## Acceptance criteria

- [ ] Mixed blocking batch with at least one allowlisted finding and at least one non-allowlisted
      finding still attempts the bounded pre-merge auto-fix once (when no prior attempt marker
      exists and an implementer harness is configured) — co-batched `spec-divergence` alone does
      not skip auto-fix for the allowlisted subset.
- [ ] Auto-fix prompt / fix scope includes only allowlisted blocking findings
      (`correctness` / `missing-dep` / `concurrency`), not residual non-allowlisted ones.
- [ ] Pure allowlisted batch: at most one auto-fix attempt, then re-delta / noop re-verify /
      exhaust / block as today (no behavior regression).
- [ ] Pure non-allowlisted batch: no harness call; escalate to `blocked` / `needs-human`.
- [ ] Residual human-required findings (and any still-blocking allowlisted findings after the
      attempt) surface a block reason that names keys/categories requiring human disposition
      versus keys/categories that were auto-fix attempted.
- [ ] Unit tests (injected seams, no live network/git/subprocess) cover: (1) mixed
      concurrency + spec-divergence → auto-fix still attempted for allowlisted subset;
      (2) all-allowlisted still attempts; (3) all-non-allowlisted still skips harness;
      (4) #729-shaped fixture would not skip auto-fix solely due to co-batched
      `spec-divergence`.
- [ ] OpenSpec change validates; living `pre-merge-fix-round` (and related) requirements
      describe partition eligibility rather than all-or-nothing veto.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `pre-merge-fix-round`: replace all-or-nothing category gate with partition eligibility;
  auto-fix allowlisted subset; residual human-required findings block with clear disposition
  naming; preserve one-attempt bound, allowlist membership, salvage, and noop re-verify.
- `pre-merge-delta-recheck`: delta blocking path routes through partition-aware fix-round
  decision (not “any non-allowlisted category ⇒ skip fix entirely”).

## Impact

- **Code (implementation phase, not this step):** `core/scripts/stages/pre_merge.ts`
  (`allBlockingAutoFixable` call site / eligibility helpers, delta-fail branch that gates
  `attemptPreMergeAutoFix`, fix-prompt scoping, block-reason text).
- **Tests:** `core/test/pre-merge-autofix.test.ts` (and any gate-path fixtures that currently
  expect mixed allowlisted + excluded to skip harness without attempt).
- **Specs:** living `pre-merge-fix-round` and `pre-merge-delta-recheck` after archive.
- **Operators / loops:** fewer false full-batch `needs-human` holds when residual
  non-allowlisted findings co-exist with mechanical allowlisted findings; residual still
  requires human disposition after (or without) the single auto-fix attempt.
- **Out of scope:** expanding the allowlist; unlimited auto-fix loops; auto-merge; review-1 /
  review-2 fix rounds; unblocking #729 itself (re-drive after this factory fix lands).
