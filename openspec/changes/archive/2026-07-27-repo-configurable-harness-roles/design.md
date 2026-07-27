## Context

Role assignment today has three separate sources of truth and one of them is a lie of omission:

- **Profile** (`core/scripts/profile.ts`) declares `harnesses: { implementer, reviewer }`. It is loaded
  by name from `profiles/<name>.json` and is a *host packaging* artifact — `claude` vs `codex` — not a
  repository decision.
- **`review_harness`** (#40) overrides only the reviewer, and additionally carries reviewer-specific
  `model`, `effort`, and `prompt_delivery`.
- **Hard-coded call sites.** `intake.ts:120`, `sweep.ts:155`, `refine-spec.ts:45`, `backfill.ts:103`,
  and `roadmap-deps.ts:34,44` call `invoke("claude", …)` literally. These are primary-role work that
  today ignores even the profile.

`resolveConfig()` (`config.ts` ~L862, ~L899) reads `profile.harnesses.implementer` directly and the
strict schema deliberately rejects a `harnesses:` block — a rule the archived
`configurable-review-harness` spec states explicitly ("The `harnesses:` block SHALL remain absent from
`PartialConfigSchema` and SHALL continue to be rejected by strict validation"). **This change reverses
that requirement.** That is the one intentional spec contradiction here, and it is recorded as a
`REMOVED` + replacement pair in the `pipeline-configuration` delta rather than being silently
overwritten.

Two adjacent facts shape the routing work:

1. `Harness` is `"claude" | "codex"` (`types.ts:31`), while the adapter registry
   (`core/scripts/harness-adapters/index.ts`) already ships `claude`, `codex`, `grok`, `opencode`, and
   `pi`, each with declared `AdapterCapabilities` (`model`, `effort`, `sandbox`, `workingDir`,
   `telemetry`) and a `preflight()` that distinguishes missing-CLI from unauthenticated. The reviewer
   role is already `string`; only the implementer is narrowed.
2. The model/effort advisories are **already stale**. `warnInertModelAliases` (`config.ts` ~L1156)
   encodes "implementer-role model aliases are inert when the implementer is codex — `harness.ts`
   passes `--model` only on the claude branch". Post-#431 that is false: `invoke()` passes
   `opts.model`/`opts.reasoningEffort` to every adapter (`harness.ts:294-298`) and the codex adapter
   emits `-m` and `-c model_reasoning_effort` (`codex.ts:110-111`). Leaving the hard-coded name list in
   place while adding a third possible implementer would compound an existing false positive, so the
   advisory becomes capability-driven in this change.

## Goals / Non-Goals

**Goals**
- A repository declares its primary/secondary pairing once, and every host honors it.
- No execution path can pick a harness that is not the resolved role for that path.
- Auto model/effort routing is correct for a pairing the routing table has never seen (`grok` primary).
- A misconfigured or unready role fails loudly before any model is invoked, never by substitution.
- A run's pairing and per-call treatment are recoverable from evidence after the fact.

**Non-Goals**
- Selecting a production pairing, or re-running/re-scoring any evaluation (#600/#602/#607 territory).
- Adding harness adapters, or changing what any existing adapter's `buildInvocation` emits.
- Per-stage harness assignment (a `harnesses.review_2: …` style override). Two roles only; the existing
  `stage_executors` mechanism already covers per-stage escape hatches.
- Any change to profiles' remaining fields (invocation strings, marker footers, conventions text).

## Decisions

### Decision 1 — Two roles, not per-stage assignment

The issue asks for primary/secondary roles. Per-stage harness selection would multiply the validation
surface (N harnesses × M stages to preflight) and has an existing outlet in `stage_executors`. Roles
stay a pair.

### Decision 2 — Resolution is per-role fallback, computed once in `resolveConfig()`

`implementer = repoConfig.harnesses?.implementer ?? profile.harnesses.implementer`, and likewise for
the reviewer (with `review_harness` folded in per Decision 3). Every consumer keeps reading
`cfg.harnesses.{implementer,reviewer}`, so no stage learns about profiles. The alternative — resolving
at each call site — was rejected: it is exactly the pattern that let five call sites drift to a literal
`"claude"`.

Provenance (`repo-config` | `review_harness` | `profile`) is captured alongside each resolved role at
the same moment, because reconstructing it later from config text is guesswork.

### Decision 3 — A conflicting `review_harness` and `harnesses.reviewer` is an error, not a precedence rule

Both keys can name a reviewer command. A silent precedence order ("`review_harness` wins") is the kind
of averaging this repo's conventions forbid: the two keys are equally explicit statements of intent, and
one of them being ignored is a config bug the operator should see. Agreement is accepted (so a repo can
declare its pairing in `harnesses:` and still use `review_harness`'s structured `model`/`effort`/
`prompt_delivery`); disagreement is rejected naming both keys and values. This keeps `review_harness`
fully supported rather than deprecating it in the same change.

### Decision 4 — `Harness` widens to a registered-adapter name, validated at parse time

`Harness` becomes a string validated against the adapter registry rather than a two-member union.
Because the engine strips types instead of checking them, the union bought nothing at runtime; the real
guarantee has to be a parse-time check against `Object.keys(registry)`, with a message naming the key,
the value, and the registered names. That check is also what makes a typo (`harnesses: { implementer:
grock }`) fail before a worktree is created rather than at first spawn.

### Decision 5 — Capability-driven model/effort routing, replacing the harness-name fork

Two related sites stop switching on harness names:

- `resolveAuto(stage, harness)` currently returns `harness === "codex" ? cell.codexModel :
  cell.claudeModel`. It becomes a per-harness lookup with an explicit "no known runnable model for this
  harness/cell" outcome that resolves to **no model** — the harness's own default — rather than
  defaulting to the claude column. Defaulting to the claude column is what would hand `sonnet` to grok.
- `warnInertModelAliases` / `warnInertEffort` consult `adapter.capabilities.model` / `.effort` instead
  of the hard-coded `harness === "codex"` / `!== "claude" && !== "codex"` tests. This fixes the existing
  false positive for a codex implementer as a side effect of making the rule general — it is a
  correction of the same rule the change must touch, not opportunistic cleanup.

Adversarial stages keep resolving `claude-fable-5` regardless of harness (the archived
`stage-model-effort-routing` requirement), and the existing reviewer-model guard keeps that alias off a
`codex exec` command line. Nothing about that pathway changes; the guard's *test* generalizes from
"is the reviewer codex" to "can this reviewer harness run this alias".

### Decision 6 — Validation reuses the existing adapter-readiness preflight

`doctor-preflight` already specifies one readiness check per assigned adapter, distinguishing
missing-CLI / unauthenticated / headless-unavailable / unsupported-model-or-effort, and already forbids
substituting a harness on failure. The implementation gap is `doctor.ts:403-410`, which treats anything
outside `{claude, codex}` as a `which`-only PATH probe. Routing both resolved roles through their
adapter's own `preflight()` closes the gap without a new requirement surface, and makes a `grok`
implementer's `grok login` state a first-class check.

### Decision 7 — Evidence records roles at run identity, treatments at invocation

Roles are a run-level fact (one pairing per run) and go with run identity; treatment coordinates are
per-call and already produced by `describeTreatment` (`harness.ts:381-421`). No new capture machinery —
the run-level role record is the missing half. `deploy_ready.ts:26` already prints the implementer in
the ready-to-deploy comment; it will render the resolved pair with sources.

## Risks / Trade-offs

- **Reversing a shipped spec requirement.** Mitigated by the explicit `REMOVED` block with a migration
  note; the only fixture that can break is one asserting `harnesses:` is a parse error.
- **A repo pins a harness its operators don't have installed.** This is the intended trade (repository
  intent outranks host convenience), and the failure is loud: run-start preflight blocks with a named
  missing-CLI or unauthenticated outcome. It is not silently downgraded to the profile default.
- **Correcting the stale inert-model warning changes observed output.** A codex-implementer repo that
  sets `models.implementing` stops seeing a warning. That warning was wrong; a regression test pins the
  new behavior in both directions (capable → silent, incapable → warns).
- **Widening `Harness` removes a compile-time narrowing that was never enforced.** Backed by a runtime
  registry check plus tests, per the repo's "no `tsc` step" rule.
- **Five hard-coded `invoke("claude", …)` sites change harness for repos that configure a non-claude
  implementer.** For repos that configure nothing, the resolved implementer under the `claude` profile
  is `claude`, so those paths are unchanged; under the `codex` profile they *do* change from `claude` to
  `codex`. That is the intended correction (they were primary-role work ignoring the role), and it is
  called out here because it is the one behavior change a no-config repo can observe.

## Migration

No action for existing repositories. Adding the block is opt-in:

```yaml
harnesses:
  implementer: grok
  reviewer: codex

models:
  implementing: grok-4.5
  review: gpt-5.6-terra

effort:
  implementing: high
  review: high
```

`pipeline config sync` scaffolds the block as documented-inactive commentary; `pipeline doctor` reports
readiness for whatever pair is resolved.
