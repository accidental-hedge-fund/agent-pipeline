## Context

See `proposal.md` for why. Current law and code:

- Living `ship-coordinator` already lists phase order
  `release` → wait until the release PR checks are green → `release finish`.
  `docs/runbooks/ship-milestone.md` lines 3–6 say the same.
- `core/scripts/stages/ship.ts` sequences `release_prepare` then
  `release_finish` with no waiter. `convergeReleaseFinish` in
  `core/scripts/stages/ship-adapter.ts` re-observes train/FRG, then calls
  `operations.finishRelease` once when `observeRelease` has no finish.
- Bare `finishReleasePr` (`core/scripts/stages/release-finish.ts`) takes one
  `gh pr checks` snapshot. Pending or fail throws. That leaf stays one-shot.
- Living `ship-release-check-wait` already defines classify + bounded
  `gh run rerun --failed`. Tugboat and the chain playbook adopt it
  (`release-checks-green.py`, `apply_release_check_wait_tick`). In-engine
  ship does not.
- Engine already has `getPrChecks` (`name,state,bucket,description,link`),
  `extractWorkflowRunId`, and `rerunFailedWorkflows` (`gh run rerun --failed`).
  Verified `gh pr checks --json` fields: `bucket`, `completedAt`,
  `description`, `event`, `link`, `name`, `startedAt`, `state`, `workflow`.
  There is no `conclusion` field.

**Conflict (do not average):**

- Docs and `ship-coordinator` require wait-until-green. Code one-shots finish.
  This change implements the wait. It does not weaken the docs.
- Bare `release finish` stays fail-closed on one snapshot. **Ship** must wait.
  Do not turn the leaf CLI into a poller to paper over the coordinator gap.
- Tugboat already waits. Deleting Tugboat or the playbook is out of scope
  (later v1.40.1). Tugboat SHALL NOT remain the only waiter.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is v1.39.9 HMAC ship succeeding because
   Tugboat polled PR #1204 (attempts 1–6) while unattended `pipeline ship`
   would throw `observable checks are not green: test (pending)`. The class
   is: in-engine ship omitting shared `ship-release-check-wait` and one-shotting
   finish on a pending or fail snapshot.
2. **Shared surfaces.** Living `ship-release-check-wait` classifier + bounded
   rerun recipe. `ship-coordinator` finish-converge seam adopts it. Reuse
   `getPrChecks` / `rerunFailedWorkflows`. Tugboat may keep the Python helper.
3. **Next identical fault.** The next unattended `pipeline ship` waits until
   green (or bounded rerun, or terminal fail) before finish. A pending
   snapshot does not fail the ship. Tests fail if finish is invoked on
   pending, or if a flake-eligible `test` fail does not rerun. No new mole.

## Goals / Non-Goals

**Goals:**

- In-engine `pipeline ship` waits with the shared four-outcome classifier
  before finish.
- Pending keeps waiting in the coordinator (in-process poll; same-argv
  resume allowed).
- Flake-eligible `test` fail requests one bounded `gh run rerun --failed`
  per head SHA (max 2), then resumes wait.
- Terminal fail persists ship failure without finish.
- Tests inject `gh` and clock. No live network.

**Non-Goals:**

- Changing bare `pipeline release finish` into a poller.
- Deleting `tugboat.sh` or `pipeline-ship-playbook`.
- A second recoverer inside `train.ts`.
- MessagingPort / ship-auth / grant JSON / `--skip-frg` / human `git tag`.
- Replacing Tugboat’s Python helper in this change.
- Merge inside advance/loop.

## Decisions

### 1. Wait in the finish-converge seam, not in the leaf CLI

- **Choice:** `convergeReleaseFinish` (or a seam it calls) SHALL run the
  shared waiter and SHALL call `operations.finishRelease` only on `green`.
  If `observeRelease` already has a merged finish identity, skip wait and
  reuse it. Do not add a required new `ship.ts` phase. Status MAY heartbeat
  on `release_finish` while waiting.
- **Why:** The issue’s regression seam is `convergeReleaseFinish`. The
  coordinator already treats finish as one converge step. A new phase is
  extra surface.
- **Alternative:** New `release_check_wait` phase in `ship.ts` — **rejected**
  as optional. Observability can heartbeat on `release_finish`.
- **Alternative:** Poll inside `finishReleasePr` — **rejected**. Bare
  `pipeline release finish` stays one-shot fail-closed.

### 2. TypeScript waiter in core; Tugboat Python may stay

- **Choice:** Implement the classifier and wait loop in `core/` (shared
  helper used by the ship adapter). Outcomes stay `green` / `pending` /
  `rerun` / `fail`. Request `name,state,bucket,link` (description MAY be
  included; `conclusion` SHALL NOT). Reuse `getPrChecks`,
  `extractWorkflowRunId`, and `rerunFailedWorkflows`. Tugboat MAY keep
  `release-checks-green.py`.
- **Why:** Shared law, not a Tugboat-only helper. Engine tests inject `gh`
  and clock. Calling Python from the adapter is a worse test seam.
- **Alternative:** Shell out to `release-checks-green.py` from ship-adapter
  — **rejected**. Unit tests would need a subprocess and a JSON file, not
  a `deps` fake.
- **Alternative:** Delete the Python helper in this change — **rejected**.
  Out of scope (later pack rewrite).

### 3. Pending is in-process wait, not a one-shot throw

- **Choice:** On `pending`, sleep through an injected clock and poll again
  in the same converge call. Heartbeat the ship ledger so the phase stays
  running. A numeric poll cap MAY bound one process session. Expiry while
  still pending SHALL NOT call finish and SHALL NOT persist terminal
  `fail`. Same-argv retry SHALL resume the wait. Default cadence MAY match
  Tugboat CI wait (`RELEASE_WAIT_*`) or a similar injected interval.
- **Why:** The product bug is a one-shot throw on pending. v1.39.9 needed
  six Tugboat attempts. Unattended ship must wait in-process. Durable
  resume is backup, not the happy path.
- **Alternative:** Throw “retry the same ship command” on first pending —
  **rejected**. That is the current defect class (FRG pack once used the
  same resume-to-retry throw).
- **Alternative:** Unbounded sleep with no heartbeat — **rejected**. The
  coordinator must remain restart-safe and observable.

### 4. Rerun budget is per head SHA and fail-closed when spent

- **Choice:** Default one `gh run rerun --failed` per release-PR head SHA.
  Hard max two. Record the attempt in the ship run dir or ledger before or
  with the rerun request. Restart MUST NOT reset the budget. After the
  budget is spent, a still-red flake-eligible set is `fail`. Missing run
  id or a failed rerun request consumes the attempt and is `fail`.
- **Why:** Living `ship-release-check-wait` already locks this. Do not
  invent a second budget.
- **Alternative:** Reuse pre-merge `ci-failure-classify` (infra vs
  assertion) — **rejected** in #1110. This waiter classifies by job name
  (`test`), not log signature.

### 5. Tests prove the two issue bites

Required fixtures (no real `gh`, git, or network):

1. Checks capture the waiter classifies as `pending` →
   `convergeReleaseFinish` (or the seam it calls) does not invoke finish.
   Prove the test fails against today’s one-shot finish.
2. Settled flake-eligible `test` fail with a workflow `link` → requests
   `gh run rerun --failed` once, then waits. Does not finish on that poll.
   Prove the test fails if finish or terminal fail happens first.

Inject `gh` and clock via `deps`. Existing already-finished observation
tests stay green (no wait when finish evidence is already observed).

## Risks / Trade-offs

- **[Risk]** A stuck pending check hangs the ship process.  
  **Mitigation:** Heartbeat. Numeric session cap may yield a wait
  checkpoint, not finish and not terminal fail. Same-argv retry continues.

- **[Risk]** Putting wait inside `finishReleasePr` would change the bare CLI.  
  **Mitigation:** Wait only in the ship finish-converge seam.

- **[Risk]** TypeScript classifier drifts from `release-checks-green.py`.  
  **Mitigation:** Living `ship-release-check-wait` is the contract. Engine
  tests lock the four outcomes. Tugboat tests already lock the Python helper.

- **[Risk]** Rerun budget resets on process restart and loops.  
  **Mitigation:** Persist attempts keyed by PR + head SHA in the ship run
  dir or ledger.

- **[Risk]** Scope creep into Tugboat deletion or grant/HMAC work.  
  **Mitigation:** Spec non-goals. This change only adopts the waiter in
  in-engine ship.

## Migration Plan

1. Land OpenSpec + TypeScript waiter + `convergeReleaseFinish` adoption +
   tests in one PR for #1205.
2. After any `core/` edit, run `node scripts/build.mjs` and commit
   regenerated `plugin/`.
3. `npm run ci` from the repo root.
4. Rollback: revert the PR. Tugboat wait is unchanged. Bare `release finish`
   is unchanged.

## Open Questions

None. Finish-converge seam, TypeScript waiter, pending in-process wait, and
per-SHA rerun budget are locked.
