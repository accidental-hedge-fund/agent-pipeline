## Context

Pre-merge has two OpenSpec touchpoints, in this order within `advancePreMerge`:

1. **Archive step** — `maybeArchiveOpenspec` (called at `pre_merge.ts:239`, with
   `if (archiveOutcome) return archiveOutcome;` at line 240). It computes the active change
   candidates from the branch diff, then for each calls `openspec.archive`. Today, when
   `archive` reports `unavailable: true`, it logs and `return null` (non-blocking skip).
2. **Validation gate** — "Step 2.5" (`pre_merge.ts:402–428`). Only reached if the archive
   step returned `null`. It runs `openspec validate --all`; when the CLI is unavailable it
   logs and skips non-blocking.

The bug (#308) is in (1): a non-blocking skip when there are active candidates leaves the
change unarchived. The PR advances to `ready-to-deploy` and an orphaned
`openspec/changes/<id>/` directory merges to `main`, which then blocks the next issue's
planning ("expected exactly one change"). Observed on #275/#300 → blocked #289 → manual
cleanup PR #307.

There is a documented policy mismatch: `doctor`'s `openspec-cli` check already fails when
OpenSpec is active and the CLI is missing ("required because OpenSpec is enabled for this
repo"), and planning blocks with an install hint — but the archive step and the README say
the pre-merge step is skipped non-blocking.

## Goals / Non-Goals

**Goals:**
- Make a missing `openspec` CLI block the archive step (`openspec-invalid`) when there is an
  active change to archive — never silently skip it.
- Keep the "no active change ⇒ nothing required" path unchanged (no regression for repos that
  have an `openspec/` workspace but no change to finalize on this PR).
- Align the README so "active OpenSpec ⇒ CLI required" reads consistently across `doctor`,
  planning, and pre-merge.

**Non-Goals:**
- Flipping the **validation gate** (Step 2.5) to block on a missing CLI. See decision below.
- Adding a repo-CI `openspec validate --all` gate — tracked separately as #315.
- Changing planning's existing install-hint block or `doctor`'s `openspec-cli` check.

## Decisions

### Decision: Block only the archive step; leave the validation gate non-blocking

The archive step is the precise enforcement point for "the CLI is required when there is
OpenSpec work to finalize," and it runs *first*:

- If active candidates exist **and** the CLI is missing, the archive step now blocks and
  returns immediately (line 240) — the validation gate is never reached. So the "candidates +
  missing CLI" case is fully covered by the archive change alone.
- The validation gate is reached only when the archive step returned `null` — i.e. there were
  **no** active candidates. Making the validation gate block on a missing CLI there would
  block PRs that introduced no OpenSpec change (e.g. ordinary code-only PRs on a repo that
  merely *has* an `openspec/` directory), directly regressing the acceptance criterion "no
  active candidates ⇒ pre-merge continues unaffected." The OpenSpec project context also
  requires the integration to leave the freeform path usable on repos that don't actively use
  it.

Therefore the validation gate keeps its current non-blocking skip. This is internally
consistent: by construction, the only way the validation gate sees a missing CLI is when this
PR had nothing to archive, and a change that *was* archived earlier was already validated at
draft, at revision, and by `openspec archive` itself.

### Decision: Reuse the existing archive-failure outcome shape

The new branch mirrors the adjacent `!res.success` path exactly —
`setBlocked(cfg, issueNumber, <reason>, "pre-merge", "openspec-invalid")` then
`return { advanced: false, status: "blocked", reason }`. Using the same `openspec-invalid`
block type keeps the blocked-recovery surface uniform (a missing CLI and a malformed change
both surface as `openspec-invalid`, both resolved by fixing the CLI/change and re-running).
The reason string names the missing CLI and the change id so the operator knows to install
`openspec` and re-run, not to edit the change.

### Decision: Keep the early no-candidates guard ahead of the CLI call

`if (candidates.length === 0) return null;` already sits above the candidate loop, so the new
blocking branch can only fire when there is genuine archive work. No additional guard is
needed; the no-candidates path never touches the CLI.

## Risks / Trade-offs

- **Risk:** A repo that legitimately runs the pipeline without the `openspec` CLI installed,
  but whose PR authored an OpenSpec change, now blocks at pre-merge instead of silently
  shipping. This is the intended correction — `doctor` and planning already require the CLI in
  that situation, and silently shipping an unarchived change is the corruption this fixes. The
  block is actionable (install the CLI, re-run).
- **Trade-off:** We do not unify the two skip sites into one helper. The validation gate's
  skip is deliberately retained (see decision above), so a shared "require CLI" helper would
  obscure rather than clarify the asymmetry. Keeping the two sites distinct, with the
  rationale recorded here, is simpler and matches the surrounding code.
