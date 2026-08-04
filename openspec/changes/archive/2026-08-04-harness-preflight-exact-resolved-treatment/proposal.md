## Why

Registry-driven doctor checks, adapter conformance, and open harness identity already landed
(#608 / #783). Production model invocation still does not prove that the **exact resolved stage
treatment** — adapter, role, model, effort, sandbox/tool policy, prompt-size limit, and executable —
can actually run before work mutates the worktree or spends tokens. Detached launches can lose PATH
context relative to the foreground process. Unsupported or unavailable capabilities can therefore
reach an expensive or mutating stage and fail mid-flight without #760-class typed remediation.

## What Changes

- **Production preflight-on-invoke for the exact resolved treatment.** Before every production
  local-CLI harness model call (implementer and reviewer), the pipeline preflights the fully
  resolved `{adapter, role, model, effort, sandbox/tool policy}` (plus prompt-size and executable
  readiness) for that invocation — not a coarse “CLI on PATH” doctor check alone.
- **One path for built-in and registered adapters.** Externally registered and compatibility
  adapters from #783 use the same preflight-before-invoke surface as built-ins. No ambient model
  default and no silent treatment fallback when a setting is unsupported or a probe fails.
- **Absolute executable resolution and foreground/detached PATH parity.** Resolve and record an
  absolute executable path before detached launch; detached and foreground environment treatment
  for harness CLI discovery SHALL be equivalent (same resolved binary when PATH-equivalent).
- **Fail closed before mutation with typed remediation.** Unsupported, unavailable,
  unauthenticated, incompatible, oversize-prompt, or missing-executable outcomes block **before**
  spawn and before stage mutation that depends on a successful harness turn, with #760-compatible
  typed reason / intervention classification and bounded diagnostic quality comparable to custom
  executor failures.
- **Consume landed probe and limit surfaces.** Use #779’s materialized `maxPromptBytes` check and
  #778’s once-per-run version/fingerprint probe as inputs to this gate (one probe path; no second
  independent always-on version exec). Dynamic authenticated smoke remains #780.
- **Tests, docs, mirror.** Integration-style unit tests (injected deps) prove exact resolved request
  reaches preflight for implementer and reviewer; PATH/absolute-executable regressions; capability
  rejection cases; `plugin/` regenerated with any `core/` change; `npm run ci` green.

**Non-goals (explicit):**

- Re-implementing registry-driven doctor enumeration, `allAdapters()` conformance, or open harness
  string typing (#608 / PR #619 — already landed).
- Dynamic authenticated smoke beyond cheap readiness (#780).
- Eval-only preflight ownership (#601 / #653 paths may share helpers; this change owns production).
- Weakening review rigor, autonomous merge, or inventing ambient model defaults.
- Expanding doctor’s optional run-start suite into a full substitute for per-invocation preflight.

## Capabilities

### New Capabilities

- `production-treatment-preflight`: Production preflight-on-invoke for the exact resolved harness
  treatment; absolute executable resolution; no silent fallback; typed remediation before mutation;
  shared built-in/extension path; consumption of #778 probe and #779 prompt-size limits.

### Modified Capabilities

- `cli-harness-adapters`: Production invoke dispatches the exact resolved `AdapterRequest` (and role)
  through adapter preflight before `buildInvocation`/spawn; capability refusals remain distinguishable
  and do not drop settings silently; registered-adapter spawn/preflight diagnostics match bounded
  quality expectations already required of custom executors.
- `detached-launcher`: Detached launch resolves harness-relevant executables to absolute paths under
  the same environment treatment as foreground; PATH parity regressions are test-guarded.
- `production-treatment-fingerprint`: Confirm production preflight is the owner/producer of the
  once-per-run binary/version (and absolute path) probe result that fingerprint accounting consumes
  — one shared helper, no dual probe paths.

## Impact

- `core/scripts/harness.ts` and/or a shared production preflight-before-invoke helper used by
  invoke / stage dispatch
- `core/scripts/harness-adapters/*` — preflight request shape (role, sandbox/tool policy), absolute
  executable resolution, integration with `cli-version-probe.ts` / treatment fingerprint
- `core/scripts/detach.ts` (and any launch env packing) — absolute executable + PATH equivalence
- Stage entry points that invoke harnesses (implementer + reviewer) only as needed to pass the
  exact resolved treatment into the shared gate
- Escalation / intervention classification mapping for preflight failure classes (#760 vocabulary)
- Tests under `core/test/` with injected deps (no real network/git/subprocess for unit gates)
- Docs / config reference only if operator-facing failure messages or doctor vs invoke semantics
  change; regenerate `plugin/` when `core/` changes
- No change to merge authority, review-policy thresholds, or OpenSpec archive rules

## Acceptance criteria

Observable, falsifiable outcomes that make #636 done:

- [ ] Production harness invoke (or its sole preflight-before-invoke helper) runs preflight with the
      **exact resolved** adapter, role, model, effort, and sandbox/tool policy for that call before
      any model-consuming spawn for both implementer and reviewer roles (proven by injected-deps
      tests that capture the preflight request).
- [ ] Built-in and externally registered (or compatibility) adapters use the **same** preflight path;
      a synthetic registered adapter failure is classified and messaged with the same bounded
      diagnostic quality class as a built-in/custom-executor style failure (no bare untyped throw).
- [ ] Capability rejection blocks **before** spawn for at least: unsupported model, unsupported
      effort, unsupported sandbox/tool policy, oversize/unknown prompt limit (#779), and missing
      executable — each distinguishable and remediated.
- [ ] Missing, unauthenticated, and headless-unavailable outcomes remain distinguishable and do not
      fall back to another harness or ambient default model/treatment.
- [ ] Absolute executable path is resolved and recorded (when resolution succeeds) before detached
      launch; a regression test proves foreground and detached harness CLI resolution are PATH-
      equivalent for the same adapter command.
- [ ] Production preflight consumes the once-per-run version/binary probe helper (#778 seam) rather
      than adding a second always-on per-call version exec; fingerprint/accounting may read the
      cached result.
- [ ] Preflight failures surface #760-compatible typed reason / intervention classification (not
      free-form only) with operator-actionable remediation text.
- [ ] `npm run ci` is green; any `core/` change regenerates and commits the `plugin/` mirror; config
      schema/docs stay coherent if operator-facing surfaces change.
