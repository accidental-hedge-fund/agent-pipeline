## Context

FRG Layer B (`pipeline factory-gate`) scores a durable loop run against the fixed
`factory-gate-v1` pack and writes immutable evidence under `.agent-pipeline/frg/<version>/…`.
Release-eligible `pass: true` requires non-empty `loop_run_id`, `pack_id=factory-gate-v1`, and
scenario criteria (see living `factory-reliability-gate` spec and
`docs/factory-reliability-gate-runbook.md`).

Synthetic pack items are filed with the `factory-gate` label, advanced to
`pipeline:ready-to-deploy`, and scored via `scoreboard.per_item[]` (`ready_clean`). They are **not**
meant to land on main as product work. Today the driver exits after writing evidence; open R2D PRs
and issues remain, creating post-release operator toil (observed on 1.29.1: PRs #751/#752).

Existing hard constraint (golden rule + FRG spec): **FRG never merges**. Close-without-merge is
compatible with that rule and is the operator-standard answer today; this change encodes it.

Relevant seams already present:

- Evidence + release-eligibility checks in `core/scripts/factory-reliability-gate.ts`
  (`computeFrgEvidence`, `writeFrgEvidence`, `runFactoryGate` / CLI entry).
- `gh.ts` has `closePr(cfg, prNumber)` (no comment body today) and issue comment helpers; issue
  close may need a small typed wrapper or dep-injected close that posts a comment then closes.
- Unit tests inject `deps` fakes (no real network/git/subprocess) — same pattern for close hygiene.

## Goals / Non-Goals

**Goals:**

- After a successful **release-eligible** FRG write with `pass: true`, auto-close open pack PRs
  and linked open pack issues for scored contributing items.
- Keep scoring authoritative: evidence write and `pass` are committed before / independent of
  cleanup success.
- Hard-limit blast radius to pack-labeled items present in the scored run.
- Document operator-visible behavior and opt-out.

**Non-Goals:**

- Auto-merge of pack PRs or any merge-queue side effect.
- Closing product-milestone / non-pack items that happened to run on the same host or in another
  loop.
- Auto-delete of remote branches or local worktrees (optional stretch only if trivial and scoped
  to pack head refs).
- Changing Layer B thresholds, pack composition rules, or release preflight.
- Replacing human authority for product merge/release.

## Decisions

### 1. Trigger: release-eligible `pass: true` only

**Choice:** Run pack auto-close only when the driver is about to return (or has just written)
release-eligible evidence with `pass: true` — same criteria as today’s evidence writer
(non-empty `loop_run_id`, `pack_id=factory-gate-v1`, scenario criteria met).

**Why:** Failures and offline/non-release scoring must not tear down open pack work an operator
may still be debugging. Aligns cleanup with “this evidence is release-usable.”

**Alternatives considered:**

- Close on any `pass: true` including non-release-eligible offline scores → rejected; offline
  scoring does not persist evidence by default and is not an operator “done” signal.
- Close whenever `clean-item-throughput` passes regardless of overall FRG → rejected; partial
  scenario success is not terminal for the pack.

### 2. Placement: post-evidence hook inside the FRG driver

**Choice:** Invoke close hygiene from the FRG driver immediately after a successful evidence write
when `pass && releaseEligible`, behind a pure helper (e.g. `closeFrgPackArtifacts`) with injected
`gh` / ledger resolution deps.

**Why:** Single operator entrypoint (`pipeline factory-gate`); no second CLI; testable without
real I/O; evidence already durable before cleanup side effects.

**Alternatives considered:**

- Separate `pipeline factory-gate close-pack` command only → rejected as default path (operators
  would forget); optional later as manual retry if needed.
- Release-command side effect → rejected; release may run hours later and should not own pack
  lifecycle.

### 3. Candidate set: scoreboard + open PR/issue resolution, filtered by pack label

**Choice:** Start from `evidence.scoreboard.per_item[]` (or equivalent loop work-list for the
scored `loop_run_id`). For each item with `ready_clean: true` (minimum; implementer MAY also close
other open pack items that appear on the scored work-list if still open — design prefers
**scored ready_clean + open** as the must-close set). Resolve issue number from `item_id` and open
PR via existing PR-resolution / ledger fields. **Require** the issue still carries the pack
selector label (`factory-gate` or the documented selector used for that run) before closing PR or
issue. Skip already-closed resources.

**Why:** Issue acceptance criteria name ready_clean + open PR at minimum; label filter prevents
closing product work that somehow shares an item id shape.

**Alternatives considered:**

- Close every open PR labeled `factory-gate` in the repo → rejected (repo-wide blast radius).
- Close only PRs without closing issues → rejected; leaves throwaway issues open.

### 4. Close comment contract

**Choice:** Deterministic comment body, e.g.

```text
FRG <version> pass (run_id=<…>): synthetic factory-gate pack item scored ready-to-deploy; closing without merge.
```

Posted on both PR and issue close paths (comment-then-close or `gh pr/issue close --comment` if
verified). No free-form LLM text.

**Why:** Auditable, stable for tests and operators.

### 5. Fail-soft and pass authority

**Choice:** Capture per-item close outcomes; append failures to stderr and optionally to in-memory
`notes` / a sibling summary returned to the caller. **Never** rewrite `evidence.pass`, delete
written evidence files, or flip exit code from 0 to non-zero solely because cleanup failed.
Prefer best-effort: continue remaining closes after one failure.

**Why:** FRG scoring is the product of this command; close is hygiene. Operators can hand-close
on failure; a false FRG fail would block release incorrectly.

**Note on evidence mutability:** Evidence files are documented as immutable. Prefer recording
cleanup outcomes via stderr / CLI summary / optional non-mutating return field rather than
rewriting `evidence.json` after write. If notes must be durable, append only a **separate**
sidecar or include planned close outcomes in notes **before** write — do not invalidate the
pass artifact. Implementation picks the simplest approach that keeps `pass` authoritative.

### 6. Opt-out flag

**Choice:** CLI flag `--no-close-pack` (or `--keep-pack-open`; pick one name at implement, document
in runbook). Default: close on release-eligible pass. Flag short-circuits the helper entirely.

**Why:** Debugging mid-pack scoring, intentional provenance land, or dry-run-like inspection.

### 7. No merge helpers on this path

**Choice:** Close path uses only close/comment APIs. Tests assert merge/merge-queue deps are not
invoked. Existing “FRG SHALL NOT introduce auto-merge” requirement is retained and clarified that
close-without-merge is the allowed terminal disposition for synthetic pack artifacts.

### 8. Tests

**Choice:** Hermetic unit tests with fake `closePr` / `closeIssue` / label+PR resolvers:

| Case | Expectation |
|------|-------------|
| Release-eligible pass | Closes expected open PR+issue set with standard comment |
| `pass: false` | Zero closes |
| Non-release-eligible score | Zero closes |
| Non-`factory-gate` / non-pack item | Never closed even if on a fake scoreboard |
| Opt-out | Zero closes |
| Close throws | Reported; `pass` remains true; evidence path unchanged |

No real network/git/subprocess.

## Risks / Trade-offs

- **[Risk] Closing a pack PR an operator intended to merge for provenance** → Mitigation: opt-out
  flag + runbook guidance that provenance land is human and opt-out-required.
- **[Risk] Mis-resolved PR closes product work** → Mitigation: dual gate (scored work-list **and**
  pack label); never repo-wide label close; unit tests for non-pack exclusion.
- **[Risk] Race: PR merged by human between score and close** → Mitigation: close is fail-soft;
  treat already-closed/merged as skip or non-fatal.
- **[Risk] Evidence immutability vs audit notes** → Mitigation: do not rewrite `pass` or delete
  evidence; prefer stderr/summary or pre-write notes (Decision 5).
- **[Trade-off] Closing only `ready_clean` vs all open pack items on the run** → Prefer must-close
  for ready_clean scored items (issue AC); MAY extend to other open pack items on the same scored
  work-list if they are still open and pack-labeled (helps leave a clean board after pass). Spec
  will require ready_clean set; allow broader scored-pack open items as long as filters hold.

## Migration Plan

- Purely additive default behavior after next deploy of the skill/engine.
- No data migration. Existing open throwaways from past FRG runs are **not** retroactively closed
  unless an operator re-runs factory-gate scoring against that run (re-score may re-trigger close
  if pass and still open — acceptable hygiene).
- Rollback: ship with opt-out default flip only if needed; or revert the post-pass hook while
  keeping tests/docs.

## Open Questions

- Exact CLI flag name (`--no-close-pack` vs `--keep-pack-open`) — implementer picks one; runbook
  and `--help` must match.
- Whether to close non-`ready_clean` open pack items still on the scored work-list after overall
  pass (e.g. product-class holds intentionally left open) — default **no** unless they are
  clearly throwaway and pack-labeled; prefer only `ready_clean` for the must-close set to avoid
  closing intentional holds.
- Whether `gh pr close --comment` / `gh issue close --comment` field shapes need a thin `gh.ts`
  extension vs comment-then-close — verify with real `gh` help before coding (golden rule #5).
