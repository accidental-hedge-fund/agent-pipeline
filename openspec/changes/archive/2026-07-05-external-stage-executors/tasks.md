## 0. Resolve the blocking open question (before any code)

- [x] 0.1 Resolved during plan-review (codex verdict on #314, 2026-07-05):
  **stage-scoped**, config key `stage_executors:`. `design.md` and
  `specs/external-stage-executors/spec.md` are amended to pin this shape.

## 1. Config schema — executor definitions

- [x] 1.1 Add a strict `executors:` block to `PartialConfigSchema` (`config.ts`):
  a record of name → definition with a required `type` enum
  (`agent-system` | `model-endpoint`).
- [x] 1.2 `agent-system` definition fields: `provider` (identifier), `endpoint`
  (URL), optional `credential` (env-var name / secret reference). Strict — reject
  unknown keys.
- [x] 1.3 `model-endpoint` definition fields: `base_url` (URL), `model` (name),
  optional `credential`. Strict — reject unknown keys.
- [x] 1.4 Confirm every field is independently optional/required as specified and
  that omitting `executors:` entirely leaves `resolveConfig()` output byte-for-byte
  as today.

## 2. Config schema — per-stage assignment

- [x] 2.1 Add `stage_executors:` to `PartialConfigSchema`, keyed by the exact
  `Stage` string for each model-invoking stage, each value an executor name.
- [x] 2.2 Validate at parse time that every assigned executor name exists in the
  `executors:` block; unknown name → named parse error.
- [x] 2.3 Enforce the stage-eligibility matrix at parse time: a `model-endpoint`
  executor assigned to an execution-environment stage (`planning`, `implementing`,
  `fix-1`, `fix-2`, `shipcheck-gate`) throws an error naming both the stage and the
  executor. `agent-system` is valid for any model-invoking stage.
- [x] 2.4 Single-source the model-invoking-stage set and the prompt-contained
  allowlist (`{ plan-review, review-1, review-2 }`) from `STAGES`/`types.ts`; back
  the invariant with a runtime test (types are stripped, not checked).

## 3. Executor dispatch

- [x] 3.1 Add an executor resolver (new `executors.ts`): given a stage, return its
  assigned executor definition (or `null` → use the local harness).
- [x] 3.2 Add an `agent-system` dispatch branch per the API contract pinned in
  `design.md` (`POST <endpoint>` with `{stage, prompt}`, `authorization: Bearer`
  header when credentialed, `{output}` JSON response) — map the result onto the
  same `HarnessResult` contract the stage code already consumes.
- [x] 3.3 Add a `model-endpoint` branch: `POST <base_url>/chat/completions`
  (OpenAI-compatible), read `choices[0].message.content`, return it as the harness
  output.
- [x] 3.4 Resolve credential references from the environment at invocation time
  only; never persist the value. Take an injectable `{ fetchImpl }` deps bag — no
  real network calls in tests.

## 4. Endpoint prompt self-containment

- [x] 4.1 For `model-endpoint`-delegated review stages, ensure the prompt embeds
  the PR diff, plan text, and conventions excerpt inline (extend the existing review
  prompt assembly), so the endpoint needs no repo access.
- [x] 4.2 Guard the prompt contract with a test asserting the endpoint prompt
  carries the diff/context inline for a review stage.

## 5. Outcome-contract enforcement

- [x] 5.1 Route external review results through the existing
  `parseStructuredVerdict` + review-policy path unchanged; a malformed result is a
  contract violation, not a soft pass.
- [x] 5.2 Confirm fix loops, review gates, and the `ready-to-deploy` never-merge
  stop are untouched and apply identically under external execution.

## 6. Provider preflight (fail-fast, no silent fallback)

- [x] 6.1 Add a **before-stage** preflight (`preflightExecutor`): credential-env-var
  presence + endpoint reachability probe. Outcome-contract compliance is NOT
  preflighted (no dry-run mode exists) — it is enforced **after invocation** by the
  stage's existing outcome-contract path (section 5).
- [x] 6.2 On preflight failure, block the item with an error naming the stage and
  provider; do NOT fall back to `claude`/`codex` for that stage. Stage call sites
  route a `stage_executors`-assigned stage directly to the executor dispatcher
  (never through `invokeReviewer`), so the legacy `review_harness` self-review
  fallback (#39, keyed off `spawn_error`) cannot trigger for it.

## 7. Evidence / accounting

- [x] 7.1 Extend stage accounting / evidence (`accounting.ts`, `run-store.ts`,
  evidence bundle) to record executor name + provider per delegated stage, and the
  model name for `model-endpoint` executors.
- [x] 7.2 Scrub secret values from all evidence/accounting output; record only the
  credential reference name (or nothing). Add a test asserting no configured secret
  env value appears in emitted evidence.

## 8. Documentation

- [x] 8.1 Document the `executors:` block, the two types, and the assignment surface
  in the generated `.github/pipeline.yml` template comment (`config.ts`),
  `hosts/claude/SKILL.md`, and `README.md`.
- [x] 8.2 Note the `model-endpoint`-stage-eligibility rule and the credential-by-
  reference convention in the docs.

## 9. Tests

- [x] 9.1 Schema: `agent-system` and `model-endpoint` definitions parse; unknown
  `type`/keys rejected; no `executors:` block → output identical to today.
- [x] 9.2 Stage-eligibility: `model-endpoint` on `implementing` throws a parse error
  naming stage + executor; on `review-2` is accepted; `agent-system` on
  `implementing` is accepted. Prove each test bites.
- [x] 9.3 Dispatch: via the harness/deps seam (no real network), a stage assigned an
  `agent-system` executor routes to the provider branch and an `model-endpoint`
  assignment routes to the endpoint branch.
- [x] 9.4 Contract: an external review result is validated against the verdict
  schema; a malformed result does not advance the item.
- [x] 9.5 Preflight: an unreachable/misconfigured provider blocks before the stage
  with a stage+provider-named error and no local fallback.
- [x] 9.6 Evidence: delegated stages record executor/provider (+ model for endpoint);
  secret values never appear in evidence.
- [x] 9.7 Parity: a repo with no executor config produces unchanged behavior.

## 10. Mirror + CI

- [x] 10.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit
  it in the same change.
- [x] 10.2 Run `npm run ci` from repo root; all checks green (including
  `openspec validate --all`).
