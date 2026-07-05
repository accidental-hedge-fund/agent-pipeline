## Context

`config.ts` resolves `.github/pipeline.yml` into a `PipelineConfig`. The `models:` block already supports per-stage Claude aliases (`planning`, `implementing`, `review`, `fix`, `intake`, `sweep`) merged as `fileConfig.models?.<k> ?? DEFAULT_CONFIG.models.<k>`, with `warnInertModelAliases` emitting a non-blocking advisory when a `models.*` alias is set for a codex-backed role (`MODEL_ALIAS_ROLES`).

Effort has no such surface. The only per-stage effort in the whole engine is `planning.ts:568`, `reasoningEffort: "medium"` on the plan-review `invokeReviewer` call. `harness.ts` already accepts `InvokeOptions.reasoningEffort` and, **for codex only**, appends `-c model_reasoning_effort=<value>` (harness.ts:128); for claude and custom reviewer CLIs it is *silently ignored* (harness.ts:77).

The pipeline splits stages across two harness roles taken from the active profile (`profile.harnesses`, not file config):

- **Primary** (`cfg.harnesses.implementer`): `planning`, `implementing`, `fix-1`, `fix-2`, `pre-merge` — claude under `--profile claude`, codex under `--profile codex`.
- **Alternative** (`cfg.harnesses.reviewer`): `plan-review`, `review-1`, `review-2` — codex under `--profile claude`, claude under `--profile codex`, overridable by `review_harness`.
- **Always-claude** (never inert regardless of profile): `intake`, `sweep`.

## Goals / Non-Goals

**Goals**
- Repos can set per-stage reasoning effort in `.github/pipeline.yml` (`effort:` block), symmetric to `models:`.
- Both `models:` and `effort:` accept an `auto` sentinel that derives a good `(model, effort)` from a fixed routing matrix keyed on the stage's task-nature, output-permanence, and harness assignment.
- `auto` is fully resolved to concrete strings at config-load time — downstream stage code never branches on `"auto"`.
- The alternative reviewer harness gains independent model + effort control via a structured `review_harness` form, resolved round-aware (review-1 Iterative, review-2/plan-review Definitive).
- Effort threads to both harnesses: codex `-c model_reasoning_effort` (existing) and claude `--effort` (new).

**Non-Goals**
- Per-step harness selection (claude-vs-codex per stage) beyond the existing `review_harness` reviewer override — out of scope.
- A validated allowlist of model/effort string values — `.strict()` key validation plus the inert-alias advisory remain the safeguards, as with `models:` today.
- Changing which stages run, the review-SHA gate, or any convergence behavior.

## The routing matrix (`auto` resolution)

`resolveAuto(stage, harness, profile)` maps each stage to a `(nature, permanence)` cell, then to a `(model, effort)` pair. The model is then constrained by the stage's harness (claude-only aliases never emitted for codex-backed stages).

| nature \ permanence | Ephemeral | Iterative | Definitive |
|---|---|---|---|
| **Mechanical** | gpt-5.5 / low | gpt-5.5 / low | sonnet / medium |
| **Analytical** | sonnet / low | opus / medium | claude-fable-5 / high |
| **Adversarial** | claude-fable-5 / medium | claude-fable-5 / high | claude-fable-5 / max |

Stage classification (source of truth for the resolver):

| stage | harness role | nature | permanence | auto model (claude profile) | auto model (codex profile) | auto effort |
|---|---|---|---|---|---|---|
| intake | always-claude | Analytical | Ephemeral | sonnet | sonnet | low |
| sweep | always-claude | Analytical | Ephemeral | sonnet | sonnet | low |
| planning | primary | Analytical | Iterative | opus | opus | medium |
| implementing | primary | Mechanical | Iterative | sonnet | gpt-5.5 | low |
| fix-1 / fix-2 | primary | Mechanical | Iterative | sonnet | gpt-5.5 | low |
| plan-review | alternative | Adversarial | Definitive | claude-fable-5 | claude-fable-5 | max |
| review-1 | alternative | Adversarial | Iterative | claude-fable-5 | claude-fable-5 | high |
| review-2 | alternative | Adversarial | Definitive | claude-fable-5 | claude-fable-5 | max |

## Decisions

**Decision: `auto` is resolved per-stage, not per-config-key, but still at load time.** The config keys are six (`planning`, `implementing`, `review`, `fix`, `intake`, `sweep`) while the routing table has eight stage rows — because one key can back stages of different classification (notably `effort.planning`, which drives both the Analytical/Iterative *planning* stage and the Adversarial/Definitive *plan-review* stage). To honor the table without a stage seeing `"auto"`, `resolveConfig()` computes a **resolved per-stage routing map** at load time: for each concrete stage it takes that stage's config value and, when it is `auto`, expands it via `resolveAuto(stage, …)` using the stage's own row. Stage code reads a concrete value for its stage; the literal `"auto"` never escapes config resolution. This is the reconciliation between acceptance criteria "plan-review effort from `cfg.effort.planning`" and "plan-review resolves as Definitive → max": the *key* consulted is `effort.planning`; the *classification* applied to an `auto` value is plan-review's own.

**Decision: harness constrains the resolved model, never the effort.** `gpt-5.5` is codex-only; `sonnet`/`opus`/`claude-fable-5` are claude-only. For Mechanical/Iterative primary stages the resolver picks `gpt-5.5` under the codex profile and `sonnet` under the claude profile — the two profile columns in the table above. Alternative-harness (Adversarial) stages always resolve model `claude-fable-5` regardless of profile; whether it is *honored* depends on the reviewer harness (see Conflict 2). Effort values are harness-agnostic and are not remapped.

**Decision: always emit the full model id `claude-fable-5`.** The short alias `fable-5` is not recognized by the Claude CLI and errors at runtime; every `auto`-resolved Adversarial value uses `claude-fable-5`. A unit test asserts no resolved value equals `fable-5`.

**Decision: structured `review_harness` unpacks to three fields.** `review_harness: { command, model?, effort? }` sets `cfg.harnesses.reviewer = command`, `cfg.harnesses.reviewerModel = model`, `cfg.harnesses.reviewerEffort = effort`. The string shorthand `review_harness: claude` keeps `reviewerModel`/`reviewerEffort` undefined, so review routing falls back to `cfg.models.review` / `cfg.effort.review` exactly as today. `invokeReviewer` receives `reviewerModel ?? cfg.models.review` and `reviewerEffort ?? cfg.effort?.review`, each `auto`-resolved round-aware.

**Decision: supersede the non-overridable plan-review medium cap.** The `plan-review-effort-controls` requirement pinning plan-review to a non-configurable `medium` is REMOVED and replaced with a requirement sourcing effort from resolved `cfg.effort.planning`, which still defaults to `medium` when unset — so default behavior is unchanged, but an operator can now raise it (e.g. to `max`, matching the Adversarial/Definitive classification). This is a deliberate reversal of a prior rigor-preserving cap; it is *rigor-preserving-or-increasing* because the default is unchanged and the only new freedom is to raise effort.

**Decision: update `DEFAULT_CONFIG.models.review` to `claude-fable-5` (needs maintainer ratification).** Rationale: `claude-fable-5` is now available and is the `auto` routing choice for every Adversarial stage; making it the default aligns the review slot with the intended routing and strengthens (does not weaken) review rigor. Scope of impact is narrow: the reviewer model is only *honored* when the reviewer harness is claude — i.e. under `--profile codex` or when `review_harness: claude` is set; under the default `--profile claude` the reviewer is codex and the alias is inert (warned), so the default flip is a no-op there. A regression test pins the chosen default and asserts the full-id form. **Rollback:** if the maintainer prefers the conservative path, keep `"opus"` and rely on `models.review: auto` / `claude-fable-5` opt-in; the rest of this change is unaffected.

**Decision: inert-effort advisory targets the harness that ignores effort.** By symmetry with `warnInertModelAliases`, warn when `effort.<key>` is explicitly set for a stage whose backing harness ignores per-stage effort. Post-change both claude (`--effort`) and codex (`-c model_reasoning_effort`) honor effort, so the only inert case is a **custom reviewer CLI** set via `review_harness` (which honors neither flag). This deviates from the issue's literal "warn for a codex stage" wording, which is based on the false premise that codex ignores effort (it does not — `harness.ts:128`). Flagged for maintainer confirmation; if the maintainer instead wants no effort advisory at all, drop the requirement — it is additive and non-blocking either way.

## Risks / Trade-offs

- **Per-stage-vs-per-key resolution subtlety.** `effort.planning` feeding two differently-classified stages is the one non-obvious mapping; a unit test asserts `planning` (Analytical/Iterative → medium) and `plan-review` (Adversarial/Definitive → max) resolve differently from the same `auto` key.
- **Claude `--effort` flag is unverified against the shipped Claude CLI.** If `claude` has no `--effort` flag, effort on claude stages is inert and the advisory should flip to claude stages instead of custom CLIs. Verifying the flag against the real CLI is task 3.1 — do not guess (golden rule 5).
- **Default-review flip visibility.** Under `--profile codex` (reviewer = claude), changing the default from `opus` to `claude-fable-5` is a real behavior change for repos that never set `models.review`. The regression test makes the new default explicit; the proposal calls it out for ratification.
- **Mirror drift.** All edits are under `core/`; `plugin/` is regenerated via `node scripts/build.mjs` and committed in the same change (golden rule 1).
