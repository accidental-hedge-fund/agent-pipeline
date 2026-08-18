## Context

See proposal.md — Why. Option 1 ship waits for release-PR checks in two composers:

- `examples/supervisor/shell/tugboat.sh` (primary Buzz path)
- `examples/supervisor/shell/pipeline-ship-playbook.sh` (alternate)

Both call `release-checks-green.py`. That helper returns `1` / `0` / `-1`. On `-1` both composers write `release-finish` failed and `exit 1`. Neither calls `gh run rerun --failed`. Neither waits again.

`failure_detail` then greps `release-finish.err` or `LOG_FILE` for `fail|error|block`. Train items already printed `[pipeline] tester-evidence: trusted-surface blocked…` into that log. Buzz concatenates it after `PR #N checks failed`.

Constraints:

- Host composers stay thin. They compose CLI + wait + notify. They do not become a second ship brain.
- `gh pr checks --json` fields (verified): `bucket`, `completedAt`, `description`, `event`, `link`, `name`, `startedAt`, `state`, `workflow`. There is no `conclusion` field.
- Engine already has `getPrChecks` (`name,state,bucket,description,link`), `extractWorkflowRunId`, `rerunFailedWorkflows` (`gh run rerun <id> --failed`), and `fetchCheckLogExcerpt`.
- Pre-merge `ci-failure-classify` maps log signatures to `infra` / `assertion` / `unknown`. It does **not** rerun assertion flakes. The #1109 fail was `AssertionError` in job `test`. Reusing that classifier here would still STOP.
- Host-local locks stay single-host. This waiter is one process on one host.
- Advance never merges. No `auto_merge`.

Conflict (do not average):

- Living `tugboat-thin-ship` says any settled fail is immediately terminal.
- This change replaces that for flake-eligible test jobs only.
- Pre-merge assertion class stays as-is. This waiter uses **job role**, not log signature.

## Goals / Non-Goals

**Goals:**

- One shared classifier + bounded rerun recipe + structured fail-detail helper for every ship release-PR waiter.
- First flake-eligible `test` fail reruns failed jobs and resumes wait.
- STOP after budget or a non-test product fail, with check name + run URL as the lead reason.
- Re-Ship after later green reuses the open release PR.

**Non-Goals:**

- Implementing `pipeline ship` (#1096). The new capability is the law that #1096 must adopt when it waits.
- Changing pre-merge to rerun assertion-class fails.
- Fixing or skipping the detach-race product test (sibling #1111).
- A second recoverer inside `train.ts`.
- Cross-host CI mutex.

## Decisions

### 1. New capability is the class law; composers are adoption sites

- **Choice:** Add `ship-release-check-wait`. Modify `tugboat-thin-ship` and `supervisor-ship-playbook` so both call the same helper. Do not patch only Tugboat.
- **Why:** Class-over-site. The next waiter (playbook, later `pipeline ship`) must not need a new mole.
- **Alternative:** Tugboat-only `-1` branch — **rejected**. That is a site mole.
- **Alternative:** Put the recipe only in `core/scripts` and add a new `pipeline` verb this issue — **rejected** as extra surface. Composers may shell out to `gh run rerun --failed` through the shared helper. Engine reuse of `rerunFailedWorkflows` is allowed if a TypeScript port of the classifier lands; it is not required for Option 1.

### 2. Classify by job role, not pre-merge log class

- **Choice:** A settled fail is **rerun-eligible** only when every failed check’s `name` is flake-eligible. The default allowlist is `test`. Documented equivalents are names of the same unit-test job class (the repo Actions job that runs `npm test` / `node --test`). Any failed check outside that allowlist is **terminal**. Mixed failed sets are terminal.
- **Why:** #1109’s fail was `AssertionError` in `test`. Pre-merge would call that `assertion` and not rerun. The release tree already passed local `npm run ci`. A flake-eligible test job is the class this waiter recovers. A release-file build fail is product and must STOP.
- **Alternative:** Reuse `ci-failure-classify` — **rejected**. It would miss this incident.
- **Alternative:** Rerun every failed check — **rejected**. That papers over a broken release tree.

Pending-first: if any check is pending / queued / in progress, the set is pending. Do not classify fail while another check is still running. Current helper is order-dependent (first `FAILURE` wins even if a later item is pending). The shared helper SHALL scan the whole set.

### 3. Bound: default 1 rerun, hard max 2

- **Choice:** Default budget is **1** `gh run rerun --failed` per release-PR head SHA per waiter invocation. Configurable up to **2**. After the budget is spent, a still-red flake-eligible set is STOP.
- **Why:** Matches pre-merge’s one-shot rerun budget. One rerun would have recovered #1109 if the test was flake. Two is the issue’s upper bound. Unbounded rerun is a hang.
- **Persistence:** In-process counter plus a sidecar under the ship run dir (for example `release-checks.rerun`) keyed by PR + head SHA + run id. A process restart in the same run dir must not reset the budget. Absence of a durable run dir fails closed: do not rerun without recording the attempt.
- **Unavailable rerun:** no run id in `link`, or `gh run rerun --failed` fails → record the attempt as consumed (or explicitly unavailable) and STOP with that reason. Do not loop.

### 4. Shared helper owns classify + detail; composers keep the wait loop

- **Choice:** Extend `release-checks-green.py` (preferred) or add one sibling helper in `examples/supervisor/shell/`. The helper:

  1. Reads a `gh pr checks --json` capture.
  2. Prints one token: `green` / `pending` / `rerun` / `fail` (numeric `1` / `0` / `2` / `-1` is acceptable if existing `1`/`0`/`-1` stay stable and `rerun` is a new distinct token).
  3. On `rerun` or `fail`, writes a structured sidecar (check name, bucket/state, `link`, PR if supplied) that `failure_detail` prefers.

  Composers: on `rerun` and budget remaining → `gh run rerun --failed <id>` extracted from `link` (`/actions/runs/(\d+)`), increment budget, sleep, continue the existing loop. On `fail` or budget spent → write_state failed using the sidecar, do not call `pipeline release finish`.

- **Why:** Thin composers. One pure helper is unit-tested the same way `release-checks-green.test.ts` already tests classify. Option 1 pack parity already hashes this helper.
- **Alternative:** Inline bash classify in both scripts — **rejected**. Drift.
- **JSON fields:** waiters SHALL request `name,state,bucket,link`. They MAY add `description,workflow`. They SHALL NOT request `conclusion`. Update the Tugboat/playbook field-schema tests.

If a new sibling helper is added, add it to `OPTION1_CRITICAL_PACK_IDS` and the install loop.

### 5. Fail detail prefers the checks sidecar; never lead with leftover train warns

- **Choice:** When the waiter STOPs on checks, `failure_detail` for `release-finish` SHALL prefer the structured sidecar over `LOG_FILE` greps. It SHALL include PR, check name, bucket/state, run URL. It SHALL include the last failed test title when `gh run view --log-failed` (or the check `description`) yields one (for example a `✖ …` line). It SHALL NOT select a line matching `tester-evidence` or `trusted-surface blocked` as the lead reason.
- **Why:** #1109’s Buzz line was `PR #1109 checks failed; [pipeline] tester-evidence: trusted-surface blocked…`. That warn is unrelated. Operators need the check URL.
- **Alternative:** Filter `tester-evidence` only from `LOG_FILE` greps and keep the rest — **insufficient**. The sidecar is the source of truth for this fail class.

### 6. Re-Ship stays idempotent via existing PR reuse

- **Choice:** Do not add a second release-PR discovery path. Keep `find_open_release_pr` / title match. After a waiter STOP, a later Ship for the same version MUST reuse the still-open PR once checks are green (or after this waiter reruns them). `pipeline release` may exit non-zero; that is not “open another PR.”
- **Why:** Issue requirement 4. Already specified in `tugboat-thin-ship`. This change only restates it for the post-fail resume case.

### 7. Tests inject fixtures; prove the #1109 bite

Required fixtures (no real `gh`, git, or network):

1. First poll: only `test` fail with a `link` → helper says `rerun`; composer/fake requests one rerun; second poll: `test` pass → proceed (would have prevented the #1109 STOP).
2. First poll `test` fail, rerun once, second poll still fail → STOP; detail has check name + run URL; detail does not start with `tester-evidence` / `trusted-surface`.
3. First poll: non-test product fail → `fail`; no rerun.
4. Mixed `test` fail + product fail → `fail`; no rerun.
5. Pending + fail in one capture → `pending` (whole-set pending-first).
6. `failure_detail` with a checks sidecar plus a `LOG_FILE` that contains a `tester-evidence` warn → lead reason is the sidecar, not the warn.

Static asserts: both composers call the shared helper; both request `link`; neither treats raw `-1` as immediate `exit 1` without the recipe (unless the helper token is terminal `fail`).

## Risks / Trade-offs

- **[Risk]** Rerunning a real product assertion in `test` hides a broken release.  
  **Mitigation:** Budget 1 (max 2). Local `release-prepare` already ran `npm run ci`. A second fail STOPs with the test title and URL.

- **[Risk]** Job rename (`test` → `unit`) skips rerun.  
  **Mitigation:** Allowlist is documented and tested. A rename without an allowlist update fails closed (terminal), which is safe.

- **[Risk]** `link` missing → cannot rerun.  
  **Mitigation:** STOP and name the check plus “no workflow run id.” Do not hang.

- **[Risk]** Numeric token change breaks installed helpers.  
  **Mitigation:** Keep `1`/`0`/`-1` meaning. Add a distinct rerun token. Refresh Option 1 pack; doctor parity fails on stale helpers.

- **[Risk]** Scope creep into #1096 or pre-merge.  
  **Mitigation:** Spec non-goals. New capability is the adoption law only.

- **[Risk]** Unbounded wait after rerun if checks never leave pending.  
  **Mitigation:** Existing `RELEASE_WAIT_ATTEMPTS` still caps the loop.

## Migration Plan

1. Land OpenSpec + helper + both composers + tests in one PR for #1110.
2. After merge/promote: refresh installed Tugboat + `release-checks-green.py` (and any new sibling) from `examples/supervisor/shell/`.
3. Re-Ship `v1.39.3` (or the current milestone) reuses open release PR #1109 if it is still open and later green.
4. Rollback: reinstall previous Option 1 pack. No GitHub schema change.

## Open Questions

- None. Job-role classifier, budget 1 (max 2), sidecar fail detail, and dual-composer adoption are locked.
