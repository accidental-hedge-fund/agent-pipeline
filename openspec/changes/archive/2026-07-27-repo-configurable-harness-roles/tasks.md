# Tasks — repo-configurable-harness-roles (#608)

## 1. Role type and registry validation

- [x] 1.1 Widen `Harness` in `core/scripts/types.ts` from the `"claude" | "codex"` union to a
  registered-adapter name, and extend `PipelineConfig.harnesses` with per-role provenance
  (`implementerSource` / `reviewerSource`: `"repo-config" | "review_harness" | "profile"`).
- [x] 1.2 Export the registered adapter names from `core/scripts/harness-adapters/index.ts` as the
  single source of truth for validation, and add a helper that resolves a harness name to its adapter
  or returns the known-names list for the error message.
- [x] 1.3 Tests (`harness-adapters.test.ts`): the exported name list matches the registry keys exactly
  (runtime-checked, since types are stripped).

## 2. Config schema and role resolution

- [x] 2.1 Add the strict `harnesses` block (`implementer?`, `reviewer?`, `.strict()`) to
  `PartialConfigSchema` in `core/scripts/config.ts`, with `.describe()` text on both keys for JSON
  Schema generation.
- [x] 2.2 Replace the direct `profile.harnesses.implementer` read in `resolveConfig()` with per-role
  resolution (repo config → profile) and record each role's source.
- [x] 2.3 Fold `review_harness` into reviewer resolution: agreement accepted (structured model/effort/
  prompt-delivery still applied), disagreement rejected with a message naming both keys and both values.
- [x] 2.4 Validate both resolved role names against the adapter registry at parse time; reject naming the
  key, the value, and the registered names, before any stage runs.
- [x] 2.5 Tests (`config.test.ts`): both roles declared; each role declared alone; block absent
  (byte-identical to today under both profiles); unknown key inside the block rejected; unregistered
  harness name rejected with the names listed; `review_harness` agreeing and conflicting.

## 3. Capability-driven model/effort advisories

- [x] 3.1 Rewrite `warnInertModelAliases` and `warnInertEffort` in `config.ts` to consult the resolved
  role adapter's `capabilities.model` / `.effort` instead of the hard-coded harness-name tests. Update
  the stale header comments that claim `harness.ts` passes `--model` only on the claude branch.
- [x] 3.2 Update the `models`/`effort` key `.describe()` strings, which currently assert
  "honored only by the claude implementer harness (codex ignores them)".
- [x] 3.3 Tests: a capable role harness (codex, model: true) emits **no** inert warning — the current
  false positive; an incapable role harness still warns naming the key, value, role, and harness.

## 4. Auto routing for any resolved role harness

- [x] 4.1 Generalize `resolveAuto` in `core/scripts/stage-routing.ts` from the
  `harness === "codex" ? codexModel : claudeModel` fork to a per-harness lookup with an explicit
  "no known runnable model" outcome that yields **no model** rather than the claude column.
- [x] 4.2 Thread the resolved role harness (implementer for implementer-role keys, reviewer for
  `review`) into every `expandAutoModel`/`expandAutoEffort` call in `resolveConfig()`.
- [x] 4.3 Generalize the reviewer-model guard (`resolveReviewerModelForHarness` and the config-parse-time
  claude-only-alias rejection) from "is the reviewer codex" to "can this reviewer harness run this
  alias", preserving today's codex behavior exactly.
- [x] 4.4 Tests (`stage-routing.test.ts`, `config.test.ts`): claude primary → `sonnet`; codex primary →
  `gpt-5.5`; repo-config role beats profile; a non-built-in primary (`grok`) never receives `sonnet` or
  any other harness-exclusive alias; effort unchanged across harnesses; adversarial stages still resolve
  `claude-fable-5` and still omit `-m` for a codex reviewer.

## 5. Primary-role routing

- [x] 5.1 Replace the literal `invoke("claude", …)` calls with the resolved implementer in
  `stages/intake.ts:120`, `stages/sweep.ts:155`, `stages/refine-spec.ts:45`, `stages/backfill.ts:103`,
  and `stages/roadmap-deps.ts:34,44` (threading `cfg` through the deps seam where it is not already
  available).
- [x] 5.2 Audit the remaining implementer-role sites (`planning.ts`, `fix.ts`, `pre_merge.ts`,
  `eval.ts`, `visual.ts`, `testgate.ts`) to confirm each reads `cfg.harnesses.implementer` and none
  narrows the value back to the two built-in names.
- [x] 5.3 Tests: with `implementer: grok` and injected fakes, planning, implementing, fix,
  pre-merge repair, intake, and sweep each target the `grok` adapter; a repo-wide assertion that no
  primary-role stage passes a literal harness name to `invoke`.

## 6. Secondary-role routing

- [x] 6.1 Confirm/repair reviewer-role resolution in `stages/review-routing.ts`, `stages/pre_merge.ts`
  (delta review), `stages/shipcheck.ts`, and `stages/design_gate.ts` so each targets
  `cfg.harnesses.reviewer`.
- [x] 6.2 Keep the `invokeReviewer` same-harness fallback (#39) intact and ensure the design-gate
  reviewer identity independence test compares the two **resolved** roles.
- [x] 6.3 Tests: with `reviewer: codex`, plan review, review-1, review-2, pre-merge delta review,
  shipcheck, and the design gate each target `codex`; fallback path still records
  `same-harness-fallback`.

## 7. Pre-run validation

- [x] 7.1 In `stages/doctor.ts` (~L403), replace the `BUILT_IN_HARNESSES` PATH-only branch with the
  resolved role adapters' own `preflight()`, emitting one stably-identified check per resolved role and
  distinguishing missing-CLI, unauthenticated, and unsupported-model/effort outcomes.
- [x] 7.2 Confirm run-start preflight aborts on a role readiness failure with no harness substitution.
- [x] 7.3 Tests (`doctor.test.ts`): each outcome reproducible through the injected deps seam, no real
  subprocess; a `grok` role reports its unauthenticated state rather than passing a bare `which` probe.

## 8. Evidence

- [x] 8.1 Record the resolved implementer, reviewer, and each role's source at run identity in
  `core/scripts/evidence-bundle.ts`; keep writes non-fatal.
- [x] 8.2 Render the resolved pair with sources in the ready-to-deploy comment
  (`stages/deploy_ready.ts:26`).
- [x] 8.3 Tests: role + source recorded for each of the three sources; a failing write does not fail the
  run; treatment coordinates still recorded per invocation with unknown resolved values left unknown.

## 9. Config surface, docs, mirror, gate

- [x] 9.1 Extend `generateConfigSchema`, `scaffoldDefaultConfig`, and `syncConfig` in `config.ts` so
  `pipeline config schema` exposes the block and `pipeline config sync` scaffolds it as
  documented-inactive commentary that round-trips without changing effective behavior.
- [x] 9.2 Document the `harnesses:` block (with the `grok` primary / `codex` secondary example from
  #608) in the host SKILL.md config sections under `hosts/`.
- [x] 9.3 Regenerate the mirror: `node scripts/build.mjs`, commit `plugin/` in the same change.
- [x] 9.4 Run `npm run ci` from the repo root and confirm green, including `build.mjs --check` and
  `openspec validate --all`.
