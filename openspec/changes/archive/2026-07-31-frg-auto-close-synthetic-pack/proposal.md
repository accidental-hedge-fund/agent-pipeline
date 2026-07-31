## Why

After a successful Factory Reliability Gate (FRG) Layer B score (`pipeline factory-gate` with
release-eligible `pass: true`), synthetic `factory-gate` pack PRs and issues remain open even
though they already fulfilled their purpose: reaching `pipeline:ready-to-deploy` for
`clean-item-throughput` (and related pack scoring). On v1.29.1, pack items #749 / #750 reached
R2D as PRs #751 / #752, FRG evidence passed, and release 1.29.1 shipped — yet operators still had
to hand-close the throwaways. That is avoidable toil and confuses “what’s left to merge?” after a
release. Auto-close (never merge) is the correct terminal disposition for synthetic pack artifacts
after a release-eligible pass.

## What Changes

- **Post-pass pack disposition** — when `pipeline factory-gate` successfully writes
  release-eligible evidence with `pass: true`, the driver (or a tightly coupled post-pass hook it
  invokes) **closes without merging**:
  - each open PR associated with a pack item that contributed to the scored run (at minimum:
    `scoreboard.per_item[]` entries that are `ready_clean: true` and still have an open PR), and
  - the linked GitHub issue for those items when open.
- **Audited close comments** — deterministic comment text citing FRG version and `run_id` so
  closes are operator-auditable.
- **Hard scope limits** — only items that carry the pack selector label (`factory-gate` or the
  documented pack selector used for that run) **and** appear in the scored run’s work-list /
  scoreboard; never repo-wide “close all factory-gate”; never product-milestone items that merely
  shared a host or loop window.
- **No merge path** — never `gh pr merge`, never merge-queue enqueue as a side effect of FRG pass
  (reinforces golden rule #4 / existing FRG no-auto-merge requirement).
- **Fail-soft cleanup** — GitHub close failures are reported (stderr / events / evidence notes)
  but do **not** flip a recorded `pass: true` to fail or delete already-written evidence.
- **Opt-out flag** — e.g. `--no-close-pack` / `--keep-pack-open` skips auto-close for debugging or
  intentional land-of-provenance cases.
- **Runbook update** — `docs/factory-reliability-gate-runbook.md` documents pass ⇒ auto-close,
  merge is never part of FRG, when to opt out, and that product milestones are out of scope.
- **Hermetic unit tests** with injected `gh` deps covering pass closes, non-pass / non-release-
  eligible no-close, non-`factory-gate` never closed, opt-out skip, and close-error fail-soft.

## Acceptance Criteria

- [ ] After `pipeline factory-gate` writes release-eligible evidence with `pass: true`, open PRs
      for scored pack items that are `ready_clean: true` (and their linked open issues) are closed
      without merge, with a deterministic comment citing FRG version and `run_id`.
- [ ] Non-pass evidence (`pass: false`) and non-release-eligible scoring paths do **not** close
      pack PRs or issues.
- [ ] Only issues labeled with the pack selector (`factory-gate` or the documented selector for
      that run) that also appear in the scored run’s work-list / scoreboard are eligible to close;
      product / non-pack items are never closed by this path.
- [ ] The FRG pass path never calls merge (`gh pr merge`) or enqueues merge-queue as a side effect.
- [ ] A close failure is reported and optionally noted on evidence but leaves `pass: true` and the
      written evidence artifact intact.
- [ ] An opt-out CLI flag skips all pack closes for that invocation.
- [ ] The FRG runbook documents auto-close on pass, no-merge, opt-out, and product-milestone
      out-of-scope.
- [ ] Unit tests with injected `gh` deps cover: pass closes the right PR+issue set; non-pass /
      non-release-eligible does not close; non-pack items never closed; opt-out skips; close
      errors do not rewrite `pass`.
- [ ] OpenSpec delta for `factory-reliability-gate` covers post-pass pack disposition; `npm run ci`
      stays green after implementation (including plugin mirror if core changes).

## Capabilities

### New Capabilities

<!-- None — this is post-pass hygiene on the existing FRG driver. -->

### Modified Capabilities

- `factory-reliability-gate`: After a release-eligible FRG pass, auto-close synthetic pack open
  PRs and linked open issues (without merge); hard scope to pack-labeled scored items; fail-soft
  close errors; opt-out flag; runbook documentation. Clarify that FRG may close-without-merge as
  hygiene while still forbidding merge/tag side effects.

## Impact

- **Specs:** delta on existing `factory-reliability-gate` living spec (no new capability folder).
- **Code (implementation, not this proposal step):** primarily
  `core/scripts/factory-reliability-gate.ts` (+ tests under `core/test/`); may extend `gh.ts`
  close helpers if comment-on-close is missing; regenerate `plugin/` mirror after core edits.
- **Docs:** `docs/factory-reliability-gate-runbook.md` (and docs-freshness if generated).
- **CLI:** additive opt-out flag on `pipeline factory-gate`; default behavior changes for operators
  after a **pass** (throwaways auto-close) — intentional and fail-soft.
- **Does not:** auto-merge pack PRs; close product-milestone work; delete remote branches or local
  worktrees; change Layer B scoring thresholds, pack composition, or release preflight.
- **Siblings / evidence:** #723 FRG family; synthetic pack pattern from 1.29.1 (#749/#750 →
  PRs #751/#752 left open after pass).
