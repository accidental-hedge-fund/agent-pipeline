## Why

The product *is* the multi-item factory: capacity reclaim, resume, OpenSpec multi-change archive,
implement lock side-effects, and pre-PR generator parity. Unit CI (`npm run ci`) and optional
two-item pilots do not catch those composition failures. The v1.29.0 durable loop
(`loop-4d2de11c6c029a2f-s1`) showed ~3/11 ready-to-deploy with heavy engine-class
`blocked_needs_human` — capacity cascade, OpenSpec archive false-pass, lockfile dirty block,
resume/`pr_opened` strand, docs gate after PR — after green unit tests and partial hermetic pilots.
Treating multi-item soak as “Tier C when convenient” makes it unrepeatable under schedule pressure.
**Every release** (patch, minor, major) must prove factory reliability with a recorded Factory
Reliability Gate (FRG) before the release PR is ready / the version is tagged.

## What Changes

- **FRG as a mandatory release gate** — same class of requirement as green `npm run ci`: no release
  tag and no release PR marked ready-to-deploy without a recorded FRG pass artifact for that
  version.
- **Minimum multi-item scenario pack** that exercises composition (not only single-issue advance):
  capacity under blocked retain, resume mid-flight, OpenSpec multi-change / foreign active change,
  implement lock side-effects, local CI/docs parity, clean-item throughput, blocker taxonomy
  scoreboard, PR supersession (stale second PR), and release-cut plan-row honesty.
- **Two mandatory layers:**
  - **Layer A — Hermetic FRG scenarios** in CI (fake-deps composition tests) for scenario classes
    that can be deterministic.
  - **Layer B — Live FRG run** every release: multi-item `pipeline:loop` (or equivalent durable
    driver) against a real repo with a fixed scenario pack, producing a machine-checkable pass/fail
    evidence bundle (run_id, contract hash, per-item outcomes, blocker classes, scoreboard).
- **Scripted entrypoint** (e.g. `pipeline factory-gate` / `pipeline release-check --for vX.Y.Z`) so
  the procedure is the same every release — not freestyle agent soak.
- **Release integration** — `pipeline release` / release path documents and enforces: refuse green
  / ready without FRG evidence for the target version (automation or documented checklist until
  automation lands; machine-check preferred).
- **Numeric thresholds** for clean-item count (K), capacity stress (N), and max engine-class blocker
  rate — living in the FRG runbook; checked by the driver, not vibes.
- **Process honesty for contract stacking** — live FRG warns or fails when items with empty
  `depends_on` still stack OpenSpec changes across branches (cross-item pollution).

Non-goals: auto-merge; replacing unit tests or OpenSpec validate; using the full product milestone
as the gate (too slow/noisy — dedicated stable pack only). Reliability code fixes (#712, #714,
#716, #718, #722, #729, #730) remain sibling issues; this change owns the **gate contract**,
runbook, hermetic pack, live driver, and release refusal surface.

## Acceptance Criteria

- [ ] A written FRG runbook is checked into `docs/` (or hosts skill docs) with numeric pass criteria
      (at least: minimum clean ready-to-deploy count K, capacity stress N, max engine-class rate)
      and a fixed scenario-pack inventory mapped to pass criteria.
- [ ] Hermetic composition tests cover (or carry explicit issue-linked waivers with no silent gaps):
      capacity cascade under blocked retain; resume mid-flight with no permanent dead `pr_opened`
      advance; OpenSpec multi-change / foreign active archive consistency; implement lockfold /
      known lock dirt messaging; pre-PR docs/generator parity.
- [ ] A live FRG driver CLI exists, starts a multi-item durable loop against the scenario pack (or
      documented selector), and emits a machine-readable pass/fail report including run_id, version
      target, per-item outcomes, blocker-class scoreboard, and overall pass/fail.
- [ ] Pass/fail for live FRG is machine-checkable from loop ledger/events where possible; human
      judgment is only for intentionally injected product-class holds.
- [ ] The release path documents **no tag / no release PR ready-to-deploy without an FRG pass for
      that version**, and either enforces the check in `pipeline release` (or release automation)
      or fails a documented equivalent checklist gate that release must record.
- [ ] Release evidence attaches or links the FRG run_id + pass summary on the release PR (comment
      or artifact path).
- [ ] Engine-class blocker rate above the runbook threshold fails the FRG; clean-item throughput
      below K fails the FRG.
- [ ] At least one successful FRG is recorded for the first release that ships this gate (target:
      v1.29.1 or the next release after the gate lands); a subsequent release reuses the **same**
      driver and runbook (repeatability, not a one-off).
- [ ] `npm run ci` remains green and includes the hermetic FRG scenario pack; hermetic tests perform
      zero real network/git/subprocess I/O.
- [ ] No auto-merge path is introduced (golden rule #4).

## Capabilities

### New Capabilities

- `factory-reliability-gate`: Mandatory multi-item Factory Reliability Gate — runbook, scenario pack,
  hermetic Layer A tests, live Layer B driver, machine-readable evidence/pass artifact, blocker
  taxonomy thresholds, and attachment to the release version under test.

### Modified Capabilities

- `release-sub-command`: Release preparation SHALL require a recorded FRG pass for the resolved
  version before treating the release as ready to tag / open as an unblocked release PR path
  (fail closed or document-bound equivalent that the release command checks).

## Impact

- **Specs:** new `factory-reliability-gate` capability; additive requirements on `release-sub-command`.
- **Code (implementation, not this proposal step):** FRG runbook under `docs/`; hermetic scenario
  tests under `core/test/`; live driver CLI entry (core scripts + plugin mirror regen); release
  path check that looks up FRG evidence for the target version; possible reuse of factory-scoreboard
  / durable-loop evidence projections.
- **Process:** every release (patch/minor/major) runs Layer B; PRs that touch loop/worktree/pre-merge/
  implement gates get Layer A in CI.
- **Does not:** auto-merge; replace `npm run ci`; require full product milestones as the gate;
  invent a second durable ledger (reuses durable loop + evidence bundle).
- **Siblings:** reliability fixes #712, #714, #716, #718, #722, #729, #730 land independently;
  FRG hermetic pack should fail without those classes of fix (or waive with explicit issue links).
