## 1. Adapter contract and registry

- [ ] 1.1 Add `core/scripts/harness-adapters/types.ts` with `AdapterCapabilities`,
      `AdapterRequest`, `AdapterInvocationContext`, `AdapterInvocation`, `AdapterPreflightDeps`,
      `AdapterPreflightResult`, `AdapterProbe`, `HarnessTreatment`, and `HarnessAdapter`
      (see design decision 2).
- [ ] 1.2 Add `core/scripts/harness-adapters/index.ts` exporting the registry map,
      `resolveAdapter(name): HarnessAdapter | null`, and `registeredAdapterNames()`.
- [ ] 1.3 Tests: a runtime conformance test iterating the registry asserts every adapter
      implements every contract member with the right kind (types are stripped, not checked),
      and that `resolveAdapter` returns `null` for an unregistered name.

## 2. Move claude and codex behind adapters with zero behavior change

- [ ] 2.1 Add `harness-adapters/claude.ts` reproducing the current claude argv exactly, including
      telemetry vs. `PIPELINE_HARNESS_TELEMETRY=off` mode, `sandbox` → `--permission-mode default`,
      and `lean` → `--tools "" --strict-mcp-config` placed before the prompt positional.
- [ ] 2.2 Add `harness-adapters/codex.ts` reproducing the current codex argv exactly, including
      `--json`, `PIPELINE_CODEX_NO_SANDBOX=1` → `--dangerously-bypass-approvals-and-sandbox`,
      `-C <worktreeDir>`, `-m`, and `-c model_reasoning_effort=<effort>`.
- [ ] 2.3 Move `parseClaudeTelemetry`/`parseCodexTelemetry` and the forward transform onto their
      adapters; keep `parseHarnessTelemetry(harness, stdout)` as a thin registry lookup so existing
      callers and the #429 tests are unaffected.
- [ ] 2.4 Rewrite `invoke()` as a dispatcher: `resolveAdapter` → `buildInvocation` → `runCapped`
      (with `killProcessGroup: true`, adapter-declared `captureMode`/`transformForward`) →
      telemetry → existing `HarnessResult` + accounting. Leave `runCapped` itself untouched.
- [ ] 2.5 Preserve the unregistered-name path verbatim: `<cmd> <prompt>` with the existing
      "reviewer CLI '<name>' not found or not executable" message and `spawn_error` flag (#40).
- [ ] 2.6 Tests: a golden-argv table pinning claude and codex `cmd`/`args` for the default,
      `lean`, `sandbox`, `PIPELINE_CODEX_NO_SANDBOX=1`, and `PIPELINE_HARNESS_TELEMETRY=off`
      variants; plus a regression test that an unregistered harness name still takes the custom
      reviewer-CLI path. Prove the golden test bites by perturbing one flag order.

## 3. Grok Build adapter (argv already verified)

- [ ] 3.1 Add `harness-adapters/grok.ts` using the shapes verified in `design.md`
      (`-p`/`--single`, `--cwd`, `--output-format`, `-m/--model`, `--reasoning-effort`,
      `--permission-mode`, `--verbatim`), declaring `workingDir: "flag"` and its telemetry mode.
- [ ] 3.2 Implement its `preflight()` (CLI on `PATH`, authenticated via the CLI's own login-state
      probe, headless mode available, requested model/effort supported) and `describeTreatment()`.
- [ ] 3.3 Implement `parseTelemetry()` against the CLI's machine-readable output, degrading to
      `{ text: null, costUsd: null, usage: null }` on unparseable output without failing the stage.
- [ ] 3.4 Tests using a fake `grok` executable on a temp `PATH`: argv shape, worktree working
      directory, non-interactive completion, telemetry parse, and each preflight failure mode.

## 4. Pi and OpenCode adapters

- [ ] 4.1 **Before writing either adapter**, read each installed CLI's own `--help`/docs for its
      headless single-turn mode, working-directory control, model flag, effort control, permission
      mode, machine-readable output, and login-state probe. Record the verified shapes in
      `design.md` decision 4. Do not guess (golden rule 5).
- [ ] 4.2 Add `harness-adapters/pi.ts` from those verified shapes, declaring `false` for any
      capability the CLI does not offer rather than silently dropping the request.
- [ ] 4.3 Add `harness-adapters/opencode.ts` on the same basis.
- [ ] 4.4 Implement `preflight()` and `describeTreatment()` for both, resolving
      `providerAuthClass` from the CLI's own reported auth/provider state and `unknown` when it
      reports none — never inferred from the model name (design decision 5).
- [ ] 4.5 Tests with fake executables covering argv, worktree working directory, non-interactive
      completion, each preflight failure mode, and the adapter-vs-provider identity separation
      (a `pi`/`opencode` run on an Anthropic model is never recorded as `claude`).

## 5. Configuration: `local-cli` executors

- [ ] 5.1 Add the `local-cli` variant to `ExecutorDefinition` in `core/scripts/types.ts`
      (`{ type: "local-cli"; adapter: string; model?: string; effort?: string }`) and widen
      `Harness` to the adapter-name union.
- [ ] 5.2 Extend the strict `executors:` schema in `core/scripts/config.ts` for `local-cli`,
      rejecting unknown keys and rejecting an `adapter` that is not a registered adapter with an
      error naming the value and listing the registered names — at parse time, never mid-run.
- [ ] 5.3 Allow `local-cli` executors on **every** model-invoking stage; restate the
      `model-endpoint` execution-environment restriction so it applies to `model-endpoint` only.
- [ ] 5.4 Implement the resolution precedence (`stage_executors` → `review_harness` → profile
      default) in one place, and keep the absent-config path byte-identical to today.
- [ ] 5.5 Route `local-cli` assignments in `core/scripts/executors.ts` to the adapter path,
      bypassing the HTTP reachability preflight (which is meaningless for a local CLI) in favour of
      `adapter.preflight()`.
- [ ] 5.6 Tests: schema acceptance/rejection, unregistered-adapter parse error, `local-cli` on an
      execution-environment stage accepted, per-stage mixing of adapters in one run, precedence
      order, and the unchanged no-config path.

## 6. Treatment identity in evidence

- [ ] 6.1 Add additive optional fields to `StageAccountingRecord` / `BuildStageAccountingRecordInput`:
      adapter name, CLI version, provider/auth class, requested model, resolved model, requested
      effort, resolved effort, resolved native flag names, fallback/throttling status, and
      termination reason. Bump `STAGE_ACCOUNTING_SCHEMA_VERSION` additively.
- [ ] 6.2 Populate them from `adapter.describeTreatment()` at the `invoke()` accounting call site;
      keep effort requested-vs-resolved as two separate verbatim values with no normalization.
- [ ] 6.3 Ensure no credential value can reach a record, event, log line, or error message — only
      the coarse provider/auth *class* label — and cover it with a test.
- [ ] 6.4 Tests: full-provenance record for an adapter invocation; a pre-change record still
      parses; provider ≠ adapter for `pi`/`opencode` on an Anthropic model; unknown provider is
      recorded as `unknown` rather than inferred.

## 7. Doctor / preflight

- [ ] 7.1 Add a doctor check per adapter assigned by the resolved configuration, reporting the four
      distinguishable failures (missing CLI, unauthenticated, headless unavailable, unsupported
      model/effort) as separate named results through the existing `DoctorDeps` seam.
- [ ] 7.2 Make `--doctor` (run-start preflight) block the run on an adapter failure before the
      stage starts, with no fallback to a different harness.
- [ ] 7.3 Tests: each failure mode via fake exec results; unassigned adapters are not checked;
      `--json` envelope carries the per-adapter check ids.

## 8. Cancellation

- [ ] 8.1 Confirm every adapter path passes through `runCapped` with `killProcessGroup: true`, and
      add a runtime assertion/test that no adapter spawns detached.
- [ ] 8.2 Test: a fake adapter CLI that spawns a long-lived child is timed out; both the CLI and
      its child are observed terminated and the result is flagged `timed_out`.

## 9. Docs, mirror, and gate

- [ ] 9.1 Document all five adapters in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`: the
      operator-run login step per CLI, a `local-cli` executor example, an example per-stage
      assignment, and an explicit note that effort levels are not comparable across harnesses.
- [ ] 9.2 Regenerate the mirror: `node scripts/build.mjs`, and commit `plugin/` in the same change.
- [ ] 9.3 Run `npm run ci` from the repo root and treat red as not-done.
