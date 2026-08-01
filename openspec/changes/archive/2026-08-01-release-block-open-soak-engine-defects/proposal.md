## Why

v1.29.0 was tagged while six open engine-defect issues from its own milestone soak
(`loop-4d2de11c6c029a2f-s1`) still existed — filed 1.4–4.4 hours earlier. FRG proves the candidate
can pass a reliability pack; it does not prove that soak-filed engine defects were closed or
explicitly waived. Today a release-time query for those defects is unreliable: auto-filed engine
issues are inconsistently labeled (`bug` missing; some labeled `enhancement`), and labels alone are
not an authoritative classifier after #787 canonical diagnostics. Release preparation must fail
closed on open, candidate-linked engine-class soak defects unless an audited override is recorded.

## What Changes

- **Release open-soak-defect preflight** — Before the version bump in `runRelease`, `pipeline
  release` SHALL discover open engine-class soak defects attributable to the candidate's soak
  (FRG/durable `loop_run_id` and/or issues created since the previous release tag with candidate
  linkage) and fail closed with a doctor-grade remediation listing them when any exist.
- **Authoritative classification over labels** — Primary soak-defect classification SHALL use #787
  canonical stage diagnostics plus durable recovery terminal evidence. A typed, candidate-linked
  recovery exhaustion or terminal engine defect blocks release; a recoverable intermediate blocker
  that converged in the same run does not. Labels remain an operator/compatibility index and a
  fallback only for historical records missing typed evidence. Consume #760 reason/disposition and
  #763 discovery/candidate attribution when present; do not wait on those issues to ship this gate.
- **Audited override** — An explicit CLI/config override flag SHALL allow deliberate exceptions.
  Using it SHALL record override evidence in the release PR body (issues waived + reason). Silent
  skip SHALL NOT exist.
- **Label hygiene for auto-filed engine defects** — Auto-filed engine-class issues from durable-run
  blocker auto-file, papercut/improve auto-file, and FRG-related auto-file paths SHALL carry the
  `bug` label and a stable blocker-class / engine-class marker in addition to `pipeline:backlog`, so
  historical and operator queries remain usable.

## Acceptance Criteria

- [ ] `pipeline release` (live path), after version resolution and before any version-file mutation,
      fails closed when at least one open engine-class soak defect is attributable to the
      candidate's soak / window, listing each blocking issue number and a remediation path.
- [ ] A recoverable intermediate blocker that converged in the same soak run does **not** block
      release; only open terminal / recovery-exhausted engine-class defects (or open issues still
      representing them) block.
- [ ] Typed candidate-linked evidence blocks even when labels are missing or wrong (e.g. no `bug`,
      mislabeled `enhancement`).
- [ ] Label-based fallback still selects historical open engine-class records that carry `bug` +
      the documented engine-class marker when typed evidence is unavailable.
- [ ] An explicit override path exists; using it is the only way past an open-defect set, and the
      release PR body records waived issue numbers and the override reason (no silent skip).
- [ ] Auto-filed engine-class issues from loop blocker auto-file and papercut/improve paths are
      created with `pipeline:backlog`, `bug`, and the engine-class marker labels.
- [ ] Unit tests with injected `gh`/deps fakes cover: open-defect block, clean path, override path,
      label-based selection fallback, and converged-intermediate non-block. Zero real network/git.
- [ ] `npm run ci` is green; `plugin/` is regenerated when `core/` changes; no auto-merge path is
      introduced.

## Capabilities

### New Capabilities

- `release-open-soak-defect-preflight`: Discover, classify, and gate release preparation on open
  engine-class soak defects attributable to the candidate release's soak evidence — primary typed
  diagnostics/terminal recovery evidence, label fallback for history, doctor-grade failure output,
  and audited override contract.

### Modified Capabilities

- `release-sub-command`: Invoke the open-soak-defect preflight after FRG pass resolution (or with
  FRG evidence available for `loop_run_id`) and **before** version bump / mutation; surface override
  on the CLI; record override evidence on the release PR body when used.
- `papercut-auto-file`: For engine-class auto-filed issues, require `bug` and engine-class marker
  labels in addition to `pipeline:backlog` (narrows the prior "only backlog" rule for this class).
- `durable-run-blocker-auto-file`: Same label hygiene for engine-class durable-run-blocker filings.

## Impact

- **Code**: `core/scripts/stages/release.ts` (`runRelease` preflight ordering), new pure helper(s)
  for discovery/classification under `core/scripts/` (release or factory-adjacent), papercut and
  durable-run-blocker auto-file label construction, release PR body builder, CLI flag wiring.
- **Tests**: Co-located unit tests with injected deps; no real network.
- **Docs**: Operator/release notes or FRG/release runbook cross-link describing the gate and
  override.
- **Out of scope**: FRG pack composition/thresholds; CI workflow changes; implementing #760/#763
  full scoreboards; auto-merge/auto-tag.
