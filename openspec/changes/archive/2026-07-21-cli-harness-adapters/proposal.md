## Why

`invoke()` in `core/scripts/harness.ts` is a hard-coded `if (harness === "claude") … else if
(harness === "codex") … else <custom reviewer CLI>` chain. Everything a harness needs — argv
shape, permission/sandbox flag, model flag, effort flag, working-directory mechanism, telemetry
parsing — is inlined into that one branch, and `Harness` in `types.ts` is literally
`"claude" | "codex"`. Any third local CLI can only enter through the `review_harness` escape
hatch (#40), which spawns `<cmd> <prompt>` with **no** working directory contract, **no** model
or effort mapping, **no** preflight, and **no** telemetry — i.e. it is usable as a reviewer of a
self-contained prompt and nothing else.

The existing `executors:` registry (#314) generalizes the *remote* direction (`agent-system`
HTTP providers, `model-endpoint` chat completions) but explicitly not the local-CLI direction:
its definitions reference an API endpoint, "not a local CLI path".

Meanwhile the operator's actual question — *how do Claude Code, Codex CLI, Grok Build, Pi, and
OpenCode compare on the same pipeline stage?* — needs all five to be selectable per stage,
running headlessly in the stage worktree against the operator's already-authenticated local CLI
credentials, and to be **distinguishable in evidence**. That last part is not cosmetic: Pi and
OpenCode are harnesses that can be pointed at an Anthropic or xAI model, so recording them as
`harness: claude` would silently corrupt every treatment comparison the scoreboard produces.

## What Changes

- **A typed local-CLI adapter contract.** A new `HarnessAdapter` interface and registry
  (`core/scripts/harness-adapters/`) own everything currently inlined in `invoke()`: declared
  capabilities, headless argv construction (working directory, prompt, model, effort,
  permission/sandbox mode), a preflight probe, telemetry parsing, and treatment-identity
  description. `invoke()` becomes a dispatcher: resolve adapter → build invocation → `runCapped`
  → normalize into the existing `HarnessResult`.
- **Claude and Codex move behind adapters with zero behavior change.** Their argv (including
  telemetry mode, `PIPELINE_CODEX_NO_SANDBOX`, `PIPELINE_HARNESS_TELEMETRY=off`, `lean`,
  `sandbox`) is preserved exactly and pinned by golden-argv regression tests.
- **Three new adapters: `grok` (Grok Build), `pi`, `opencode`.** Each runs headlessly and
  non-interactively in the stage worktree, uses the CLI's own already-completed login state, and
  maps requested model/effort onto that CLI's native flags — or declares the capability
  unsupported rather than silently dropping the request.
- **Per-stage selection via the existing `executors:`/`stage_executors:` surface**, extended with
  a third executor `type: local-cli` (`{ type: local-cli, adapter, model?, effort? }`). This
  reuses one assignment surface instead of adding a competing `stage_harnesses:` key — see design
  decision 1. `local-cli` executors are valid for **every** model-invoking stage (they have a real
  execution environment, unlike `model-endpoint`). With no assignment, every stage resolves the
  harness exactly as today from the profile / `review_harness`.
- **Treatment identity that separates harness from provider.** Evidence records the adapter name,
  the CLI version, the provider/auth class when the CLI reports one, requested vs. resolved model
  and effort, resolved native flag names, fallback/throttling status, duration, and termination
  reason. An `opencode` run against an Anthropic model is recorded as
  `adapter=opencode, provider=anthropic` — never as `harness=claude`.
- **Doctor/preflight coverage per assigned adapter**: CLI missing from `PATH`, CLI present but
  unauthenticated, headless/non-interactive mode unavailable, and requested model or effort
  unsupported by that adapter — each reported *before* the stage starts, with no silent fallback
  to a different harness.
- **Termination.** Every adapter is invoked through `runCapped` with process-group kill, so a
  timeout or cancellation tears down the whole process tree, including CLIs that spawn their own
  sub-agents.
- **Docs**: setup and example stage assignments for all five adapters in the host SKILL.md files.

Non-goals: no comparative eval runner or fixture corpus; no API-key model endpoints (OpenRouter
et al. — already covered by `model-endpoint`, tracked separately); no claim that similarly named
effort levels mean equal compute across harnesses; no CLI installation or automated OAuth login;
no change to stage semantics, review-verdict policy, or the never-auto-merge stop; no cost
*extraction* work (owned by #429 — this change only records the provenance needed to attribute it).

**Verification note (golden rule 5 — verify external shapes, never guess).** Grok Build's headless
argv was verified against the installed CLI (`grok 0.2.93`: `-p/--single`, `--cwd`,
`--output-format plain|json|streaming-json`, `-m/--model`, `--reasoning-effort`,
`--permission-mode bypassPermissions`, `grok login`, `grok models`). `pi` and `opencode` are **not
installed on this machine**, so this proposal deliberately specifies their behavior (headless,
non-interactive, worktree-scoped, model/effort mapped or declared unsupported) rather than naming
flags. Task 4.1 requires their real argv be read from the installed CLI's own `--help` and recorded
in `design.md` before their adapters are written.

## Capabilities

### Added Capabilities
- `cli-harness-adapters`: the typed adapter contract and registry, the five built-in adapters,
  per-adapter capability declaration and preflight, headless/worktree/non-interactive guarantees,
  process-tree termination, adapter-vs-provider treatment identity, the preserved custom-reviewer-CLI
  fallback, and the resolution precedence between a stage executor assignment, `review_harness`,
  and the profile default.

### Modified Capabilities
- `external-stage-executors`: the `executors:` block accepts a third `type: local-cli` naming a
  registered adapter (plus optional per-executor model/effort), assignable to every model-invoking
  stage.
- `stage-cost-accounting`: stage accounting records additively carry adapter name, CLI version,
  provider/auth class, requested-vs-resolved model and effort, and termination reason.
- `doctor-preflight`: doctor checks readiness of every adapter assigned by configuration.

## Impact

- `core/scripts/harness-adapters/` (new) — `types.ts` (contract), `index.ts` (registry +
  `resolveAdapter`), `claude.ts`, `codex.ts`, `grok.ts`, `pi.ts`, `opencode.ts`
- `core/scripts/harness.ts` — `invoke()` becomes an adapter dispatcher; `parseHarnessTelemetry`
  delegates to the adapter; `runCapped` unchanged
- `core/scripts/types.ts` — `Harness` widened to the adapter-name union; `local-cli`
  `ExecutorDefinition` variant; additive harness-provenance fields on `StageAccountingRecord`
- `core/scripts/config.ts` — `local-cli` executor schema, adapter-name validation, stage
  eligibility, `review_harness` precedence
- `core/scripts/executors.ts` — `local-cli` dispatch to the adapter path (no HTTP preflight)
- `core/scripts/accounting.ts` — additive provenance fields on the record builder
- `core/scripts/stages/doctor.ts` — per-assigned-adapter readiness checks
- `core/test/` — adapter-registry, golden-argv, preflight, config, accounting, and doctor tests
  using fake-executable / dependency seams (no live provider calls)
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — setup + example stage assignments
- `plugin/` — regenerated mirror (`node scripts/build.mjs`)

## Acceptance Criteria

- [ ] A `HarnessAdapter` contract exists whose members cover, for every adapter: declared
      capabilities, capability preflight, headless invocation construction, working directory,
      prompt delivery, model, effort, timeout, permission/sandbox mode, cancellation, and
      normalized result extraction; a runtime test asserts every registered adapter implements
      every member (types are stripped, not checked).
- [ ] `invoke("claude", …)` and `invoke("codex", …)` produce byte-for-byte the same `cmd` and
      `args` after the refactor as before it, for the default, `lean`, `sandbox`,
      `PIPELINE_CODEX_NO_SANDBOX=1`, and `PIPELINE_HARNESS_TELEMETRY=off` variants — pinned by a
      golden-argv test.
- [ ] `grok`, `pi`, and `opencode` are registered adapters whose built invocation runs a
      single-turn headless request with the stage worktree as its working directory and no
      interactive prompt, given that CLI's documented login has already completed.
- [ ] For each of the three new adapters, the built argv is derived from that CLI's own
      documented headless interface (recorded in `design.md`), not invented.
- [ ] `.github/pipeline.yml` can assign a `local-cli` executor to any model-invoking stage
      (`planning`, `implementing`, `review-1`, `review-2`, `fix-1`, `fix-2`, `plan-review`,
      `shipcheck-gate`), and a run honors different adapters on different stages.
- [ ] With no `executors:`/`stage_executors:` block present, every stage resolves its harness
      exactly as before this change, with no new warning and no argv change.
- [ ] A `local-cli` executor naming an unregistered adapter is rejected at config-parse time with
      an error naming the value and listing the registered adapters — never mid-run.
- [ ] Every harness invocation yields a treatment identity carrying adapter name, CLI version,
      provider/auth class (or an explicit unknown), requested model, resolved model, requested
      effort, resolved effort, and the resolved native flag names.
- [ ] An `opencode` or `pi` invocation configured against an Anthropic model records
      `adapter` = `opencode`/`pi` and `provider` = the provider, and is never recorded with
      `harness`/`adapter` = `claude`; likewise for a Grok Build run against xAI vs. the `grok`
      adapter name.
- [ ] Requested and resolved effort are recorded verbatim and separately; no cross-harness effort
      normalization or equivalence mapping is introduced anywhere in the code or specs.
- [ ] `pipeline doctor` reports a distinct, named failure for each of: adapter CLI not on `PATH`,
      CLI present but unauthenticated, headless/non-interactive mode unavailable, and requested
      model or effort unsupported by the adapter — and `--doctor` blocks the run before the stage
      starts rather than falling back to a different harness.
- [ ] A timeout or cancellation of any adapter kills the entire process tree: a test in which the
      fake adapter CLI spawns a child observes both the CLI and its child terminated, and the
      result is flagged as timed out.
- [ ] The stage accounting record for an adapter invocation carries adapter name, CLI version,
      provider/auth class, requested/resolved model and effort, fallback-or-throttling status,
      duration, and termination reason; the fields are additive and records written before this
      change still parse.
- [ ] No credential value, token, or auth file content appears in any accounting record, event,
      log line, or error message produced by an adapter — only the provider/auth *class* name.
- [ ] A harness name that is not a registered adapter still takes the `review_harness` custom-CLI
      path (`<cmd> <prompt>`) with its existing named spawn-failure message — the #40 escape hatch
      is not regressed.
- [ ] Precedence is deterministic and tested: a `stage_executors` assignment for a review stage
      wins over `review_harness`, which wins over the profile default.
- [ ] Every new unit test uses fake executables or the injected dependency seam; the suite makes
      no real network, git, or subprocess calls to a provider, and passes with none of the three
      new CLIs installed.
- [ ] Both host SKILL.md files document setup and show an example stage assignment for all five
      adapters, and `npm run ci` passes with the regenerated `plugin/` mirror committed.
