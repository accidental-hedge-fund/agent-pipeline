## Context

`pipeline doctor` already ships an `install:version-coherence` check
(`core/scripts/stages/doctor.ts`) that compares the running `VERSION` constant to the
`version` in `core/package.json` at the install root. That catches a *corrupt or
mismatched* install, but a perfectly coherent install can still be an old release: the
running code and its `package.json` agree at v1.13.0 while the project has shipped
v1.14.0. Nothing tells the operator their install lags released fixes, so degraded runs
continue until a human notices (issue #385, castrecall #5/#41/#46).

The engine's own source/release repo is a fixed constant — `accidental-hedge-fund/agent-pipeline`
(used in `scripts/build.mjs`, `scripts/install.mjs`, `scripts/postinstall.mjs`). This is
distinct from `config.repo`, which is the *target* repo the pipeline is operating on
(e.g. castrecall). The freshness check must query the engine's upstream repo, never
`config.repo`.

## Goals / Non-Goals

**Goals:**

- Detect and report when the installed engine is older than the latest released engine.
- Keep the signal loud but non-blocking — a stale install still works.
- Degrade to a silent skip when the release lookup is unavailable (offline / `gh` down).
- Reuse the existing installer `update` verb as the documented one-step remediation.
- Keep the whole check unit-testable through the existing `DoctorDeps` seam.

**Non-Goals:**

- Auto-update or background update daemons (report-only; updating stays explicit).
- Version pinning / release-channel selection (latest release tag only).
- Comparing against unreleased `main` (release tags are the contract).
- A new gh network dependency for any other stage — this lives entirely in doctor.

## Decisions

**Decision: compare against the latest GitHub *release tag*, not `main`.**

Release tags are the shipped contract. The check runs
`gh release view --repo accidental-hedge-fund/agent-pipeline --json tagName` (verified
shape: `{"tagName":"v1.13.0", ...}`) through the existing `DoctorDeps.exec` seam. The
tag carries a leading `v`; the running `VERSION` does not, so the comparison normalizes
the `v` prefix on both sides before a numeric dotted-segment compare.

**Decision: introduce a non-blocking `warn` status rather than fail-on-behind.**

Doctor's check model is currently `pass | fail | skip`, where any `fail` sets
`ok:false`, exits 1, and (under `--doctor`/`runOnStart`) aborts the run before planning.
Making "behind" a `fail` would abort every run each time a new release drops — hostile,
and contrary to the issue's "it only reports / never auto-updates" intent. A stale
install is degraded, not broken. So we add a fourth status, `warn`:

- `warn` does **not** set `ok:false` — exit code stays 0 and `runOnStart` does not abort.
- `warn` renders in the summary with its own symbol (`!`) and its remediation line.
- The doctor JSON envelope already documents `status: "warnings"` as "reserved for
  future use"; this change un-reserves it. Top-level `status` is `"warnings"` when there
  is ≥1 `warn` and 0 `fail`; still `"error"` when any `fail` is present (fail dominates).
- Each JSON check record gains an explicit `status: "pass"|"warn"|"fail"|"skip"` field so
  a scripter can pinpoint which check warned. The legacy `ok` field is retained
  (`ok === status !== "fail"`) so existing consumers reading `name`/`ok`/`reason`/`fix`
  are unaffected. This is a purely additive schema evolution.

Only the freshness check emits `warn` today; the status is defined generally so future
advisory checks can reuse it.

**Decision: offline / lookup failure ⇒ `skip`, never `warn`/`fail`.**

A missing network signal is not evidence of staleness. If `gh release view` exits
non-zero, returns empty, or yields unparseable/`tagName`-less JSON, the check returns
`skip("skipped (offline)")`. A `""` running `VERSION` (already possible on a corrupt
install, which `install:version-coherence` owns) also skips — freshness has nothing to
compare.

**Decision: reuse the installer `update` verb as the update command.**

`scripts/install.mjs update` is already an idempotent alias for `install` (atomic
temp-dir + rename; writes a `.pipeline-installer-managed` sentinel). The documented
remediation is `npx github:accidental-hedge-fund/agent-pipeline update` (or
`node scripts/install.mjs update` from a clone). No new update code path is added — the
work is to document it (README + host skill docs) and name it in the check's
remediation. Running it twice is a net no-op.

**Decision: no config knob in this change.**

A `doctor.versionCheck: warn|block|off` severity control is a plausible future
extension, but the issue's acceptance criteria don't call for it and adding channel/
severity configuration edges into the stated out-of-scope. Default behavior is a
non-blocking `warn`, always evaluated (and self-skipping when offline). A knob can be a
tracked follow-up if operators want a hard block.

## Risks / Trade-offs

- **Extra `gh` call per doctor run.** One bounded `gh release view` per invocation,
  behind the existing 30s exec timeout, and fully skipped offline. Acceptable for a
  preflight that already shells out to `gh` several times.
- **Rate limiting / auth.** `gh release view` uses the operator's existing `gh` auth
  (already validated by the `github-auth` check). A rate-limit or auth error is caught
  by the offline-skip path — it degrades to `skip`, never a false `warn`.
- **Version comparison edge cases.** Pre-release / build-metadata suffixes are rare for
  this engine (plain `x.y.z` tags). The normalizer compares dotted numeric segments and
  treats any parse ambiguity as "not behind" (skip/pass), never a false positive `warn`.

## Migration

Additive. Repos without OpenSpec are unaffected. Existing doctor JSON consumers keep
working (new `status` field is additive; `warnings` was already a documented value).
