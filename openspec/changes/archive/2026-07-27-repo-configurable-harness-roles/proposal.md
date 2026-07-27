## Why

A repository cannot today declare which harnesses it wants driving its work. The **implementer**
(primary) role is taken solely from the active profile (`profile.harnesses.implementer`, `config.ts`
~L862) and the strict config schema *rejects* a `harnesses:` block outright, so the primary harness is
a property of **which host launched the run** (`/pipeline` under Claude Code → claude; `$pipeline`
under Codex → codex) rather than a property of the repository. Only the reviewer is configurable, via
`review_harness` (#40). The consequence is that the same repo, worked by two different operators, is
worked by two different primary harnesses with no record of intent — and a pairing chosen from
comparative evaluation (#600/#602, now made trustworthy by the evaluator isolation boundary of #607)
cannot be adopted as *this repository's* production pairing.

Three concrete gaps make the current state worse than "profile-only":

1. Several primary-role paths bypass the role entirely and hard-code a harness — `intake.ts:120`,
   `sweep.ts:155`, `refine-spec.ts:45`, `backfill.ts:103`, and `roadmap-deps.ts:34,44` all call
   `invoke("claude", …)` literally. Even the profile's implementer does not govern them.
2. `Harness` is typed `"claude" | "codex"` (`types.ts:31`) while the adapter registry already ships
   `claude`, `codex`, `grok`, `opencode`, and `pi` (`core/scripts/harness-adapters/`). Only the
   reviewer role can name a non-built-in harness.
3. Model/effort routing forks on `harness === "codex"` versus everything-else (`stage-routing.ts`
   `resolveAuto`), and the inert-alias advisory hard-codes "implementer role is inert when the
   implementer is codex" (`config.ts` `warnInertModelAliases`) — a rule that is *already stale*, since
   the codex adapter honors `-m`/`-c model_reasoning_effort` (`harness-adapters/codex.ts:110-111`) and
   `invoke()` passes model/effort to **every** adapter (`harness.ts:294-298`). A grok primary would
   silently receive `sonnet`, a claude-only alias, for every Mechanical stage.

## What Changes

- **BREAKING (schema-permissive, behavior-preserving):** `.github/pipeline.yml` gains a strict
  `harnesses:` role block with `implementer` and `reviewer` keys. The previous contract — "a repo that
  sets `harnesses:` receives a strict-schema parse error" — is reversed. Repos that omit the block see
  no behavior change whatsoever; the profile continues to supply both roles.
- **Repository config outranks the profile, per role.** A role present in `harnesses:` wins; a role
  absent falls back to the profile default. Profiles become host/UI defaults only.
- **Role precedence with `review_harness` is defined and non-silent.** `review_harness` remains
  supported (including its structured `command`/`model`/`effort`/`prompt_delivery` form). When both it
  and `harnesses.reviewer` name a reviewer command, the conflict is surfaced rather than averaged.
- **Every primary-role execution path routes through the resolved implementer** — planning, plan
  revision, implementing, fix rounds, pre-merge repair, eval fix, visual fix, intake, sweep,
  refine-spec, backfill, and roadmap-deps. The hard-coded `invoke("claude", …)` call sites become
  role-resolved.
- **Every secondary-role execution path routes through the resolved reviewer** — plan review, review
  rounds 1 and 2, pre-merge delta review, shipcheck, and the design-interrogation gate. The existing
  same-harness self-review fallback (#39) is unchanged in shape and stays labelled
  `same-harness-fallback` in the reviewer identity record.
- **Model/effort routing becomes harness-aware for the resolved roles, not profile-aware.**
  `resolveAuto` resolves per *resolved role harness* (covering a `grok` primary and a `codex`
  secondary), and the inert-alias/inert-effort advisories are driven by the adapter's declared
  `AdapterCapabilities` rather than a hard-coded harness name list — correcting the stale
  "implementer-model is inert on codex" warning as part of the same rule.
- **Role assignments are validated before a run starts.** An unresolvable harness name fails at
  config-parse time naming the key and the known adapters; CLI presence, authentication, and
  model/effort compatibility for both resolved roles are checked by the existing adapter-readiness
  preflight, which already forbids substituting a different harness on failure.
- **Resolved roles and treatment coordinates enter run evidence.** The evidence bundle records the
  resolved implementer and reviewer, each role's source (`repo-config` vs `profile` vs
  `review_harness`), and the per-invocation adapter treatment already captured by
  `describeTreatment` — so a run's harness pairing is auditable after the fact.
- **Config surface, docs, generated plugin mirror, and regression coverage** are updated together:
  `pipeline config schema` exposes the block, `pipeline config sync` scaffolds it as documented-inactive
  commentary, `pipeline doctor` checks both resolved roles, and `node scripts/build.mjs` regenerates
  `plugin/`.

Out of scope: choosing a production pairing or re-running any evaluation (that is downstream of #607);
any auto-merge behavior; changing the eval runner's treatment axes; adding new harness adapters.

## Capabilities

### New Capabilities
- `configurable-harness-roles`: repository-level declaration of the primary (implementer) and
  secondary (reviewer) harness roles, their precedence over profile defaults, the routing guarantee
  that every primary/secondary execution path uses the resolved role, pre-run validation of the
  resolved roles, and the recording of resolved roles and treatment coordinates in run evidence.

### Modified Capabilities
- `pipeline-configuration`: the requirement that harness roles come from the profile and that a
  `harnesses:` key is a parse error is removed and replaced by repo-config-over-profile resolution;
  the inert-`models.*` advisory becomes adapter-capability-driven rather than keyed on `codex`.
- `configurable-review-harness`: `review_harness` no longer asserts that `harnesses:` is rejected by
  strict validation; its precedence relative to `harnesses.reviewer` is specified.
- `stage-model-effort-routing`: auto model resolution respects the **resolved role harness** for any
  registered adapter rather than forking between the two built-in harnesses.

## Impact

- **Config**: `core/scripts/config.ts` (`PartialConfigSchema`, `resolveConfig`, `warnInertModelAliases`,
  `warnInertEffort`, `generateConfigSchema`, `syncConfig`, `scaffoldDefaultConfig`).
- **Types**: `core/scripts/types.ts` (`Harness` widened from the two-name union to a registered-adapter
  name; `PipelineConfig.harnesses` gains role-source provenance).
- **Routing**: `core/scripts/stage-routing.ts` (`resolveAuto` and the routing matrix's harness fork).
- **Stages**: `planning.ts`, `fix.ts`, `pre_merge.ts`, `review-routing.ts`, `shipcheck.ts`,
  `design_gate.ts`, `eval.ts`, `visual.ts`, `intake.ts`, `sweep.ts`, `refine-spec.ts`, `backfill.ts`,
  `roadmap-deps.ts`, `doctor.ts`, `deploy_ready.ts`.
- **Evidence**: `core/scripts/evidence-bundle.ts` role/treatment records.
- **Packaging/docs**: `hosts/*/SKILL.md` config documentation, regenerated `plugin/` mirror.
- **Tests**: `core/test/` — config precedence, role routing per stage, auto-routing for a grok primary
  and codex secondary, validation failures, and evidence records. No real network, git, or subprocess.
- **Dependency**: #607 (evaluator isolation boundary) must land before this configuration is used to
  select a production pairing from comparative evaluations. It is already archived
  (`openspec/changes/archive/2026-07-27-eval-agent-isolation-boundary`); this change does not depend on
  it for implementation, only for the intended downstream use.

## Acceptance Criteria

- [ ] `.github/pipeline.yml` containing `harnesses: { implementer: grok, reviewer: codex }` resolves
      without error, and `resolveConfig()` returns `implementer === "grok"` and `reviewer === "codex"`
      under **both** the `claude` and the `codex` profile.
- [ ] A repo config that omits the `harnesses:` block resolves to byte-identical config to today's
      behavior for both roles, under both profiles.
- [ ] A `harnesses:` block setting only `implementer` leaves `reviewer` at the profile default, and
      vice versa.
- [ ] An unknown key inside `harnesses:` (e.g. `harnesses: { reviewr: codex }`) is rejected by strict
      validation naming the offending key.
- [ ] A harness name that resolves to no registered adapter is rejected at config-parse time with a
      message naming the key, the value, and the registered adapter names; no stage runs.
- [ ] Setting both `harnesses.reviewer` and `review_harness.command` to different commands surfaces the
      conflict rather than silently picking one.
- [ ] `grep` over `core/scripts/stages/` finds no literal `invoke("claude"` / `invoke("codex"` call in a
      primary-role path — `intake`, `sweep`, `refine-spec`, `backfill`, and `roadmap-deps` all resolve
      the implementer from config.
- [ ] With `harnesses.implementer: grok`, an injected-fake test proves the planning, implementing, fix,
      pre-merge-repair, intake, and sweep invocations each target the `grok` adapter.
- [ ] With `harnesses.reviewer: codex`, an injected-fake test proves plan review, review-1, review-2,
      pre-merge delta review, shipcheck, and the design gate each target the `codex` adapter.
- [ ] With `harnesses.implementer: grok` and `models.implementing: auto`, the resolved model is one the
      grok adapter can run and is **not** the claude-only alias `sonnet`.
- [ ] With `harnesses.reviewer: codex` and `models.review: auto`, no claude-only alias reaches the
      `codex exec` invocation (the existing `-m` omission behavior is preserved).
- [ ] Explicitly configuring `models.implementing` for a harness whose adapter declares `model: false`
      emits the inert advisory; configuring it for `codex` (which declares `model: true`) does **not**
      emit it — the current false-positive warning is gone.
- [ ] `pipeline doctor` emits a readiness check for each resolved role harness, distinguishing
      missing-CLI, unauthenticated, and unsupported-model/effort outcomes; run-start preflight aborts on
      failure without substituting another harness.
- [ ] The evidence bundle for a run records the resolved implementer and reviewer, each role's source
      (`repo-config` / `review_harness` / `profile`), and the per-invocation treatment coordinates.
- [ ] `pipeline config schema` output contains the `harnesses` block with descriptions for both keys,
      and `pipeline config sync` round-trips a config containing the block without changing effective
      behavior.
- [ ] `npm run ci` is green from the repo root, including `node scripts/build.mjs --check` (the `plugin/`
      mirror is regenerated and committed) and `openspec validate --all`.
