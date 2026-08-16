## Context

See `proposal.md` for why. Current law and code:

- Living `release-sub-command` defines an idempotent two-call protocol:
  first call produces unsigned FRG artifacts and returns
  `awaiting_frg_attestation`; the post-attestation call returns `complete`
  via shared `runRelease`.
- Living `factory-reliability-gate` already requires a fresh candidate pack
  per post-1.33 request and refuses caller-authored pass claims. Hybrid v2
  (#1036) is on base.
- `core/scripts/factory-release-prepare.ts` already writes
  `pack-instance.json` with `loop_run_id: null`, scans only runs that carry
  `factory-release-binding.json`, and refuses the newest unbound
  `factory-gate` loop. The unused `startBoundPackLoop` hook is the existing
  start seam. Default generate does not call it, so the first call fails
  `pack_loop_missing` / `missing_generator`.
- Pack templates and `renderFrgPackIssues` already exist under
  `frg-packs/factory-gate-v1/`. `runFactoryGate` already scores
  `--from-run` without requiring `--observations` for ledger-derived
  required-live ids; hybrid v2 supplies Layer A TAP hashes.
- Public JSON statuses today are `awaiting_frg_attestation`, `complete`,
  and `failed`. Checkpoint phases already include `frg_running`.

**Conflict (do not average):** the living two-call protocol says the first
call creates unsigned artifacts. Issue #1037 says the first call starts a
bound pack loop and returns in-progress / awaiting, and must not invent
`pass`. This change **inserts** start/resume ticks before unsigned
artifacts exist. It does not delete the attestation two-call.

**Class vs site (engine-dogfood bar):** this is a **class** fix to the
durable generator. The site symptom is “1.34+ prepare returns
`missing_generator`.” The class is: post-1.33 FRG generation must itself
start and bind the candidate pack loop. Shared surfaces that must change:
default `startBoundPackLoop`, pack-issue create/reuse, binding persist,
`factory-gate --from-run` score with no `--observations`,
`latest.json` write-on-genuine-pass. After this lands, the next identical
fault does **not** need a new mole issue.

## Goals / Non-Goals

**Goals:**

- Make the existing `startBoundPackLoop` hook the production default.
- Return a distinct `in_progress` JSON status while the bound loop is not
  terminal. Keep `awaiting_frg_attestation` for the attestation wait.
- Resume the same `loop_run_id` on re-invoke. Never adopt an unbound loop.
- Score a terminal bound loop through `runFactoryGate` / `--from-run`.
  Never pass `--observations`.
- Write release-eligible `latest.json` `pass: true` only on a genuine
  scorer pass.

**Non-Goals:**

- Tugboat default / `--skip-frg` change (later child).
- Auto-tag or pin `no-frg-*` (later children).
- Fabricated observations or test-only all-pass overrides in production.
- Scoring a product milestone as FRG.
- Merge, tag, pin, install, or rollback authority on prepare.
- New live fault-injection seams.
- Changing hybrid v2 required-live / Layer A ownership (#1036).

## Decisions

### 1. Wire the unused start seam; do not add a second generator

**Choice:** Default `generateDurableUnsignedFrg` / `runFactoryReleasePrepare`
SHALL call `startBoundPackLoop` when reconcile finds no matching binding.
The start function creates or reuses pack issues via `renderFrgPackIssues`,
dispatches `pipeline loop --engine-track candidate` with the pack work-list
or `--label factory-gate`, writes `factory-release-binding.json`, and
returns `{ loop_run_id }`. Unit tests inject that seam.

**Why:** The hook and binding format already exist. A second generator
would fork the #953 path.

**Alternatives considered:**

- Keep “operator binds a loop” as the durable contract → rejected; that
  is the 1.34+ ship failure.
- Start the loop from `factory-gate` `startLoop` instead of prepare →
  rejected; the durable interface named by ship is `factory-release
  prepare`.

### 2. New public status `in_progress`; do not overload attestation wait

**Choice:** While the bound loop is not terminal, return
`status: "in_progress"` with `loop_run_id` and checkpoint, exit 0.
Consumers MUST branch on `status`, not only exit code.
`awaiting_frg_attestation` remains the attestation wait after unsigned
artifacts exist.

**Why:** Returning `awaiting_frg_attestation` before unsigned artifacts
exist would lie about the checkpoint. Inventing `complete` / `pass` is
banned.

**Alternatives considered:**

- Reuse `failed` + `pack_loop_missing` until an operator starts a loop →
  rejected; that is current broken behavior.
- Block the first call until the pack loop finishes → rejected; a pack
  loop is long-running. Dispatch and re-invoke is the existing
  checkpoint style.

### 3. Terminal score is `factory-gate --from-run`, never `--observations`

**Choice:** When the bound loop is terminal, call `runFactoryGate` with
`fromRun: loop_run_id` and `writeEvidence: true`. Do not pass
`observations`, `scenarioOverrides` from the request, or a work-directory
observations file. Hybrid v2 inside the scorer supplies required-live
from the ledger and Layer A TAP hashes on the candidate SHA.

**Why:** Issue #1037 forbids a synthetic `--observations` file. #1036
already owns scoring rules.

**Alternatives considered:**

- Keep prepare’s internal collector as the only scorer → rejected; it
  still comments “never Layer A” and would drift from hybrid v2.
- Hand-build an observations file from the ledger and pass
  `--observations` → banned.

### 4. `latest.json` `pass: true` only on genuine release-eligible pass

**Choice:** Persist scorer output as-is. A fail MAY write `latest.json`
with `pass: false`. A `pass: true` pointer is written only when
`isReleaseEligibleFrgPass` is true. Prepare MUST NOT flip fail to pass.

**Why:** Release and auto-tag read `latest.json`. A forged pass unblocks
ship. A recorded fail must stay distinguishable from a missing artifact.

### 5. Binding remains the only adopt rule

**Choice:** Keep the current scan: only a run with
`factory-release-binding.json` matching fingerprint + candidate + version
+ manifest is adoptable. The newest unbound `factory-gate` loop is never
adopted. A stale recorded `loop_run_id` is cleared and start/resume
runs again only after that refusal.

**Why:** Existing tests already lock this (`ba5b5ff5`). Adopting an
unbound loop would score the wrong pack.

## Risks / Trade-offs

- **[Risk] Wrappers treat any exit 0 as “unsigned artifacts ready.”** →
  Mitigation: `in_progress` is a distinct `status`. Help text and
  runbook name the multi-tick protocol. Attestation still requires
  `awaiting_frg_attestation`.
- **[Risk] Dispatching `pipeline loop` from prepare looks like a second
  scheduler.** → Mitigation: prepare calls the existing durable loop
  entry on the candidate track. It does not merge and does not add a
  factory control plane.
- **[Risk] Pack-issue create races across hosts.** → Mitigation: reuse
  issues that already carry this pack_run_id / template provenance.
  Bind the loop after the issue set is known. Cross-host duplicate
  issues are not release-eligible for a foreign fingerprint.
- **[Risk] Scoring before the loop is terminal yields `not_observed`
  required-live and a fail `latest.json`.** → Mitigation: score only
  when the bound loop is terminal. In-progress ticks do not write
  release-eligible pass.
- **[Trade-off] First-call `pack_loop_missing` is no longer the durable
  “bind it yourself” contract.** Wrappers that parsed that defect as
  success-with-homework must switch to `in_progress` + re-invoke.

## Migration Plan

1. Land start/resume + `in_progress` + `--from-run` score + tests +
   runbook/help + `plugin/` mirror on this issue’s implementation.
2. Existing #953 two-call attestation behavior stays after unsigned
  artifacts exist.
3. Hybrid v2 (#1036) is a base dependency; do not re-pin scoring.
4. Later Tugboat / auto-tag / `no-frg-*` children consume this
   generator. They are not this change.

Rollback: revert the change. Prepare returns `pack_loop_missing` again.
Ship stays unable to auto-produce genuine FRG evidence.

## Open Questions

None that block specs or tasks. Public in-progress status is
`in_progress`. Score entry is `factory-gate --from-run` with no
`--observations`.
