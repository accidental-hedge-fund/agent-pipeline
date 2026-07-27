## Why

The eval runner's local-CLI path silently drops the treatment's effort coordinate.
`runCell` passes `effort: cell.treatment.effort` into `realInvokeHarness`
(`core/scripts/evals/executor.ts`), which forwards it to `harness.invoke()` as `effort:` —
but `InvokeOptions` reads `reasoningEffort`, and only `opts.reasoningEffort` is threaded into
`adapter.buildInvocation({ ..., effort })`. The key is unknown to `InvokeOptions`, so it is
discarded. Because the repo runs Node's type-stripping with **no `tsc` step**, nothing fails:
the object literal is accepted at runtime and the field evaporates.

The consequence is the worst failure mode a rigor product can have — *confidently wrong
measurements*. Every local-harness eval cell runs at the CLI's own default reasoning effort
while its `treatment_id` (`harness=codex,model=…,effort=high`), its `config_hash`, its cell
record's `effort` field, and every scoreboard/comparative report built on top of them assert an
effort coordinate that was never delivered. An effort axis in an experiment therefore measures
nothing: all of its cells are the same treatment wearing different labels, and any "high effort
beats low effort" (or the reverse) conclusion drawn from those runs is an artifact.

The same class of drop exists at one more spot on this path: an unregistered harness name (the
custom-reviewer-CLI path, #40) has no adapter and no effort flag at all, so a treatment declaring
an effort against such a harness is recorded as a completed treatment carrying a coordinate the
invocation could not express. The API/`model-endpoint` executor path is **not** affected — it
threads `effort` through `deriveModelEndpointOverride` → `encodeEffort`, which already fails
closed on an inexpressible effort.

## What Changes

- **Deliver the eval cell's effort to the harness CLI.** The eval → `invoke()` seam maps the
  eval-domain `effort` coordinate onto the canonical `InvokeOptions.reasoningEffort`, so the
  resolved adapter emits its native flag (`--effort` for claude, `-c model_reasoning_effort=` for
  codex, `--reasoning-effort` for grok, `--thinking` for pi, `--variant` for opencode). A cell
  declaring no effort stays byte-identical to today (no flag).
- **A regression test that bites on argv, not on an options object.** Driving the eval invocation
  path against a fake CLI on `PATH` that echoes its arguments, a cell requesting a non-default
  effort SHALL produce the adapter's effort flag with the requested value. The test must fail on
  the pre-fix code — asserting only that `invoke()` received some option would not have caught
  this bug, since the pre-fix call site *did* pass an option, just under a dead name.
- **Close the drop at the type seam so the class of bug cannot recur silently.** The eval-side
  harness invocation argument type and `InvokeOptions` are joined by a single explicit mapping
  site with a runtime-backed test, per the repo's rule that type-only guarantees are not enforced
  (no `tsc`).
- **Never claim an undeliverable effort coordinate.** When a cell's treatment declares an effort
  but the resolved harness cannot express one (an unregistered/custom CLI with no adapter, or an
  adapter whose capability declares no effort control), the cell SHALL fail as an infrastructure
  error before invocation rather than run at default effort and be recorded as a completed
  treatment at the declared effort.

Out of scope: changing any default effort matrix or stage-routing value (`stage-routing.ts`,
`effort:` config); changing `model-endpoint` executor effort semantics (`executors.ts`
`encodeEffort` is correct and untouched); re-running or re-scoring experiments already recorded —
this change makes the defect impossible going forward, it does not retro-correct past artifacts.

## Acceptance Criteria

- [ ] An eval cell whose treatment declares `effort: "high"` against the `codex` harness produces
      a harness invocation whose argv contains `-c model_reasoning_effort=high`.
- [ ] The same cell against the `claude` harness produces argv containing `--effort high`.
- [ ] An eval cell whose treatment declares **no** effort produces argv byte-identical to today's
      (no effort flag of any kind).
- [ ] The argv-level regression test fails against the pre-fix code (the effort flag is absent)
      and passes after the fix — demonstrated, not asserted.
- [ ] Two eval cells differing only in their declared effort produce different harness argv;
      before this change they produced identical argv.
- [ ] A cell whose treatment declares an effort against a harness with no effort capability
      (unregistered/custom CLI, or an adapter declaring `effort: false`) is recorded as an
      infrastructure error naming the harness and the undeliverable effort, and no harness
      invocation occurs for it.
- [ ] No cell record can carry an `effort` coordinate in its `treatment_id`/identity that was not
      actually requested of the harness — covered by a test asserting the delivered argv against
      the recorded coordinate.
- [ ] The `model-endpoint` executor path is unchanged: its existing effort override/encoding tests
      pass untouched.
- [ ] Non-eval pipeline invocation sites (planning, fix, review-routing, intake, sweep,
      design-gate) are unchanged — they already pass `reasoningEffort` and their argv is
      byte-identical.
- [ ] `npm run ci` is green from the repo root, including the regenerated `plugin/` mirror.

## Capabilities

### Modified Capabilities

- `stage-eval-runner`: the local-CLI harness execution path gains an explicit requirement that a
  cell's declared effort coordinate is actually delivered to the harness invocation, and that a
  cell may never be recorded as a completed treatment carrying an effort coordinate the resolved
  harness could not express.

## Impact

- `core/scripts/evals/executor.ts` — `realInvokeHarness` (the mapping site); a pre-invocation
  effort-capability check in `runCell`'s local-harness branch.
- `core/scripts/harness.ts` — `InvokeOptions` documentation of the canonical field name (no
  behavior change for existing callers).
- Tests: `core/test/harness.test.ts` (argv-level, fake-CLI-on-`PATH` pattern already established
  there for `--permission-mode` and codex sandbox argv), `core/test/evals-executor.test.ts`
  (capability check and recorded-coordinate honesty, injected fakes only).
- `plugin/` mirror regeneration (`node scripts/build.mjs`).
- No change to the label-driven state machine, to review rigor, or to any config surface.
