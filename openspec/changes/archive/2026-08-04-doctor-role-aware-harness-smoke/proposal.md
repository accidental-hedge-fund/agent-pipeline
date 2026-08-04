## Why

Static doctor readiness and adapter interface conformance only prove that CLIs exist and
implement members. Failures that only a live CLI shows — auth expiry, silent version drift,
changed/deprecated flags, new output shapes, PATH/env gaps in detached launches — still surface
mid-stage as opaque product blocks (for example `Plan generation failed (exit -1)` when a detached
advance lacked `~/.local/bin`). A role-aware, treatment-exact runtime smoke under
`pipeline doctor --harness-smoke` is the missing dynamic complement to #636 static preflight and
the declared cheap `runtimeSmoke` hooks from #783.

## What Changes

- **Opt-in dynamic harness smoke.** `pipeline doctor --harness-smoke` runs, for each unique
  **configured** adapter/role/model/effort treatment, one cheap canned prompt in a throwaway
  scratch repository (or equivalent isolated cwd) and reports pass/fail with remediation.
- **Role-aware contracts (treatment-exact).**
  - **Implementer** smoke proves: (a) spawn + exit 0, (b) a commit with required trailers appears,
    (c) output passes the stage-output-contract validator (#777), (d) telemetry parses when the
    adapter declares telemetry.
  - **Reviewer** smoke proves: (a) spawn + exit 0, (b) a structured read-only verdict that passes
    the review verdict contract, (c) **no** repository mutation, (d) telemetry parses when
    declared. Reviewer-only adapters are **not** required to create commits.
- **Registry-driven treatment enumeration.** Smoke exercises every unique configured built-in or
  external adapter/role/model/effort coordinate from active config + the runtime registry — not a
  hardcoded built-in name list. It consumes adapter-declared smoke/readiness hooks from #783 as
  the cheap readiness phase, then runs the role-aware canned prompt.
- **Standalone, promotion-gate ready.** Runnable without starting an advance loop; designed as
  step 1 of the harness promotion gate (companion issue). Default `pipeline doctor` remains
  deterministic and model-free; only `--harness-smoke` spends model tokens.
- **Test seam discipline.** Real subprocess I/O is **by design** for the live smoke path and stays
  out of the unit-test suite. Unit tests cover orchestration via injected deps. `npm run ci`
  green; regenerate `plugin/` when `core/` changes.
- **Operator cost disclosure.** Command help documents expected spend: one cheap model call per
  configured treatment per invocation.

**Non-goals (explicit):**

- Static preflight/conformance and doctor registry integration ownership (#636 — already the
  static complement; sequence with/after it).
- Eval-campaign capability inventory, corpus, or tier concerns (#600 / #602 / #603).
- Replacing production preflight-on-invoke (#636 production treatment gate) or weakening review
  rigor / autonomous-merge policy.
- Requiring reviewer-only adapters to create commits or mutate the repo.
- Folding real CLI smoke into `npm test` / CI unit gates.

## Capabilities

### New Capabilities

- `doctor-harness-smoke`: Opt-in role-aware, treatment-exact dynamic runtime smoke for every
  unique configured adapter/role/model/effort coordinate; implementer vs reviewer assertions;
  scratch-repo isolation; stage-output-contract and telemetry checks; deps-injected unit coverage
  of orchestration; promotion-gate-ready standalone command path.

### Modified Capabilities

- `doctor-preflight`: Default `pipeline doctor` remains deterministic and model-free; document and
  wire the `--harness-smoke` opt-in so the “no model calls under any circumstances” rule applies
  only to the static/default doctor path, not the explicit dynamic smoke flag. Doctor summary /
  `--json` composition and exit-code contract remain coherent when smoke results are included.

## Impact

- `core/scripts/stages/doctor.ts` (or a co-located harness-smoke module) — treatment enumeration,
  smoke orchestration, result folding into doctor summary / `--json`
- `core/scripts/pipeline.ts` / command registry — `--harness-smoke` flag, help text with spend
  estimate
- Adapter registry consumers — resolve configured implementer/reviewer treatments and declared
  `runtimeSmoke` / role capabilities (#783)
- Stage-output-contract validators (#777) — pure validate over smoke product output (reviewer
  verdict; implementer stage-shaped output as designed)
- Commit-trailer expectations for implementer smoke (Issue / Pipeline-Run trailers)
- Throwaway scratch repo / temp cwd lifecycle (create, smoke, cleanup; no pollution of operator
  worktrees)
- Unit tests with injected deps under `core/test/`; no real network/git/subprocess in unit suite
- Docs / CLI help for spend disclosure; regenerate `plugin/` when `core/` changes
- No change to merge authority, review-policy thresholds, or production preflight-on-invoke ownership

## Acceptance criteria

Observable, falsifiable outcomes that make #780 done:

- [ ] `pipeline doctor --harness-smoke` is runnable standalone and exits 0 only when every smoke
      treatment for the active configuration passes; any failed treatment yields non-zero exit and
      actionable remediation naming the adapter/role (and model/effort when set).
- [ ] Smoke enumerates **every unique configured** built-in or external
      adapter/role/model/effort coordinate from config + runtime registry (not a hardcoded
      built-in-only list); unassigned registered adapters are not required to be smoked.
- [ ] For each **implementer** treatment, the smoke proves in a throwaway scratch repo: spawn +
      exit 0, a new commit with the required trailers, stage-output-contract validation success,
      and telemetry parse success when the adapter declares telemetry.
- [ ] For each **reviewer** treatment, the smoke proves: spawn + exit 0, structured verdict
      output that passes the review verdict contract, **no** repository mutation, and telemetry
      parse when declared — and does **not** require commit creation for reviewer-only adapters.
- [ ] Orchestration consumes adapter-declared readiness/`runtimeSmoke` hooks (#783) as the cheap
      readiness phase before the canned model prompt; readiness failure short-circuits that
      treatment without a model call when possible.
- [ ] Default `pipeline doctor` (no `--harness-smoke`) remains deterministic and does **not**
      invoke a language model or consume inference tokens.
- [ ] Command help for `--harness-smoke` documents expected spend (one cheap model call per
      configured treatment per invocation).
- [ ] Unit tests cover smoke orchestration via injected deps and perform **no** real network,
      git, or subprocess I/O; live smoke is kept out of the unit-test suite by design.
- [ ] `npm run ci` is green; any `core/` change regenerates and commits the `plugin/` mirror.
