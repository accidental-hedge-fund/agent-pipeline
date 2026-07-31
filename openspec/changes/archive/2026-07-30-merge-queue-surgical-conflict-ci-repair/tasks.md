## 1. Types and hold model

- [x] 1.1 Define hold reason keys (`merge-conflict`, `checks-failed`) and a hold record
      shape (pr, issue, reason, remediation, repair_attempts, last_head_sha, checks/merge
      summary) in the merge-queue module area next to drive (#674), with pure constructors.
- [x] 1.2 Implement remediation text builders for each hold reason (PR identity + next steps).
- [x] 1.3 Confirm `gh` field shapes used for mergeability and required checks against real
      `gh pr view` / `gh pr checks --required` output before coding (golden rule #5); reuse
      existing typed helpers where present.

## 2. Hold-and-continue on ineligible candidates

- [x] 2.1 Wire drive eligibility failure paths so conflict → `merge-conflict` hold and
      blocking required checks → `checks-failed` hold without calling `mergePr`.
- [x] 2.2 Implement default **hold-item-and-continue** policy: skip merge for the held item
      and proceed to remaining ordered candidates.
- [x] 2.3 Surface held items and remediation in drive/apply operator output and run evidence.

## 3. Optional surgical repair path

- [x] 3.1 Add config and/or CLI flag to enable repair (default off); document flag names
      beside the #674 drive surface.
- [x] 3.2 When repair is enabled and budget remains, resolve the PR managed worktree via
      existing managed-worktree resolution (no unmanaged ad-hoc paths).
- [x] 3.3 Invoke fix/implementer with a prompt that encodes surgical-fix discipline
      (minimal conflict/CI-only diff; no refactors/scope expansion; destructive-op guards).
- [x] 3.4 Push repair outcomes only through normal reviewable PR head updates; do not
      force-merge.

## 4. Re-gate and merge retry

- [x] 4.1 After repair push (or re-evaluation of a held item), re-run the same eligibility
      gates as pre-merge attempt: open, R2D/policy, mergeable, required checks non-blocking.
- [x] 4.2 On re-gate pass only, call existing `mergePr` / merge surface; never a second
      unguarded merge path.
- [x] 4.3 On re-gate fail, keep/re-record the appropriate hold; do not merge.

## 5. Repair budget and evidence

- [x] 5.1 Enforce per-item `max_repair_attempts` (default 1 recommended) within a drive session.
- [x] 5.2 Optionally enforce wall-clock bound for repair-related waiting if drive waits on CI.
- [x] 5.3 On budget exhaustion, leave hold with evidence (reason, attempts, summary, head SHA)
      and stop further auto-repair for that item in the session.

## 6. Unit tests

- [x] 6.1 Conflict fixture → `merge-conflict` hold; zero merge surface calls (injected deps).
- [x] 6.2 Red required checks fixture → `checks-failed` hold; zero merge surface calls.
- [x] 6.3 Successful repair then green eligibility → re-gate pass → merge surface invoked once.
- [x] 6.4 Budget exhaust after N failed repairs → held with evidence; no attempt N+1.
- [x] 6.5 Hold-and-continue: one held item + later eligible candidate still processes the later
      candidate under default policy.
- [x] 6.6 Repair-disabled path never invokes harness; still records hold.
- [x] 6.7 Prove critical tests bite (fail without the hold/re-gate logic).
- [x] 6.8 Apply mode: planning-time `non-mergeable` / `checks-not-green` skips reach drive
      hold/repair (command-level regression); dry-run remains skip-only.

## 7. CI and mirror

- [x] 7.1 If any `core/` files change, run `node scripts/build.mjs` and commit regenerated
      `plugin/` in the same change.
- [x] 7.2 Run `npm run ci` from repo root; treat red as not-done.
- [x] 7.3 Run `openspec validate merge-queue-surgical-conflict-ci-repair` (and
      `openspec validate --all` when archiving).
