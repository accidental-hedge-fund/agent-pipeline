## Why

Output-shape enforcement is per-stage, ad-hoc, and repair-inconsistent. Plan-revision has a
regex verifier plus exactly one format-repair re-prompt (#658); review has a real single-sourced
JSON schema (`review-schema.ts`); OpenSpec authoring singularity, fix summaries, and other
implementer-facing outputs hard-block with **zero** repair loop. Format-contract blocks have
already bitten multiple harnesses (Claude on #658; Grok on #622/#658; OpenSpec multi-change on
#770). Parser-per-shape does not scale across adapters (Claude, Codex, Grok, future pi/opencode);
a versioned contract layer plus one shared bounded repair policy is the durable form.

## What Changes

- Introduce a **universal stage-output contract layer**: every implementer-facing (and
  structured-output reviewer) stage declares a machine-checkable, **versioned** output contract
  (sentinel-delimited Markdown sections and/or JSON schema — `review-schema.ts` is the in-repo
  precedent), validated by a **central** validator before stage side effects or state transitions.
- Replace the plan-revision-only format-repair implementation with **one single-sourced
  format-repair policy** (exactly one automatic re-prompt by default; total two verification
  attempts) shared by all registered contracts.
- Keep **adapter envelope normalization** separate from stage-schema validation: adapters may
  normalize transport envelopes; stage contracts validate product shape after normalization.
- After the single bounded repair is exhausted, emit a typed `pipeline/stage-diagnostic@1`
  reason of **`harness-contract`** (projecting through #760 / #787 vocabulary) rather than
  product-judgment / `needs-human` for pure shape failures.
- Add **per-adapter golden shape fixtures** (named Claude / Grok / Codex response shapes are
  **regression fixtures only**, never runtime provider branches), drift-guarded like
  `prompt-loader.test.ts`.
- Expose an **extension-adapter golden-fixture hook** aligned with the adapter/capability layer
  (#783 / #738 declaration shape) so third-party adapters can register fixtures without forking
  validation.
- Sequence with **shared harness-round (#629)** as the natural host for shared repair
  orchestration on implementer rounds; do not re-fork per-stage repair skeletons.
- `npm run ci` green; regenerate `plugin/` when `core/` changes.

## Capabilities

### New Capabilities

- `stage-output-contract`: Versioned per-stage output contracts, central validation before side
  effects, single-sourced bounded format-repair policy, terminal `harness-contract` diagnostics,
  golden shape fixtures, and extension-adapter fixture hooks. Output **shape** only — not prompt
  input semantics (#737) and not verification-capability negotiation (#738 product), though
  declaration shape stays alignable with the adapter capability layer.

### Modified Capabilities

- `harness-step-verification`: Plan-revision ack verification remains required, but its
  stage-local format-repair path and terminal `needs-human` disposition for pure shape failures
  are superseded by the shared contract layer and `harness-contract` terminal projection. Other
  stages with machine-checkable outputs register contracts rather than hard-blocking only.
- `plan-revision-output-contract`: Prompt-side acknowledgement contract remains; pure
  output-contract terminal disposition is no longer specified as `needs-human` after repair
  exhaustion — it projects through the shared layer.
- `shared-harness-round`: Shared implementer-round helper is the preferred host for invoking the
  shared format-repair policy on migrated consumers (or a thin companion helper used by both
  shared-round and non-round stages such as plan-revision / OpenSpec authoring).
- `cli-harness-adapters`: Named provider response shapes are golden fixtures only; adapters expose
  a golden-fixture registration/hook surface for extension adapters without introducing runtime
  provider branches in validation.
- `autonomous-recovery-controller`: Exhausted pure output-contract failures after the shared
  repair budget SHALL emit/project `harness-contract` under `pipeline/stage-diagnostic@1` and
  SHALL NOT park solely as product `human-decision-required` / `needs-human` for shape failure
  alone (consistent with existing capture/output-contract → harness-contract mapping).

## Impact

- **New core module(s)** under `core/scripts/` for contract registry, versioned validators, shared
  format-repair policy, and fixture loading (exact filenames left to design).
- **Stage call sites**: at minimum plan-revision (`planning.ts` + `verifyPlanRevisionOutput`),
  OpenSpec authoring singularity (`enforceOpenspecChangeSingular`), review verdict path
  (`review-schema.ts` / review parsing as the JSON-schema precedent to register rather than
  re-implement), and other implementer-facing structured outputs identified in design.
- **Shared harness-round** (`harness-round.ts`) or a companion helper used by it — orchestration
  of the single bounded repair without duplicating stage skeletons.
- **Diagnostics**: producers that currently `setBlocked(..., "needs-human")` on pure shape failure
  after zero or local repair move to `harness-contract` via stage-diagnostic projection.
- **Tests**: golden fixtures (Claude/Grok/Codex shapes), central validator unit tests, repair
  policy tests (one retry then terminal), drift guards for registered contracts, regression that
  plan-revision mid-line tolerance still works, and that multi-change OpenSpec hard-block gains
  repair where specified.
- **Living specs**: new `stage-output-contract` plus the modified capabilities above.
- **Generated mirror**: `plugin/` regenerated with `node scripts/build.mjs` when `core/` is edited.

### Out of scope

- Prompt-**input** semantics/invariants (#737 owns that boundary).
- Verification-capability negotiation product work (#738), beyond keeping declaration shape
  alignable with the adapter capability layer.
- Changing review **policy** thresholds, severity blocking, or the review verdict schema fields
  themselves (register/reuse the existing schema; do not redesign findings).
- Introducing a **parallel** diagnostic taxonomy outside `pipeline/stage-diagnostic@1`.
- Runtime branching on provider/harness name for validation acceptance.
- Auto-merge or unattended merge paths.

## Acceptance criteria

- [ ] Every in-scope implementer-facing stage with a machine-checkable output (at least:
      plan-revision acknowledgement, OpenSpec change singularity, review structured verdict)
      declares a **versioned** output contract registered with the central layer.
- [ ] Central validation runs **before** the corresponding stage side effect (posting a revised
      plan, advancing labels, adopting multi-change OpenSpec trees, accepting a review verdict
      for policy) when the stage depends on that output shape.
- [ ] Exactly **one** single-sourced format-repair policy exists (default: one automatic
      re-prompt; two verification attempts total) and is used by registered contracts; the
      plan-revision-only private repair path is removed or reduced to a thin call into that policy.
- [ ] After the shared repair budget is exhausted on a pure shape failure, the stage emits or
      projects `pipeline/stage-diagnostic@1` with reason **`harness-contract`** (or an exhaustive
      pure projection thereof) and does **not** classify the failure solely as product
      `human-decision-required` / `needs-human` for shape failure alone.
- [ ] Adapter envelope normalization remains separable from stage-schema validation (tests or
      module boundaries prove validation operates on post-normalization product output).
- [ ] Named Claude, Grok, and Codex response shapes are checked in as **golden fixtures** and
      covered by drift-guarded tests; no production code path branches validation on provider name.
- [ ] Extension adapters can register golden fixtures through the declared hook (aligned with
      #783 / adapter capability declaration) without forking the central validator.
- [ ] Existing plan-revision tolerances (mid-line header, fenced/duplicated header, tagged items)
      and review verdict parsing of valid schema-shaped output still pass.
- [ ] Unit/regression tests bite: missing contract registration, skipped validation before a side
      effect, second automatic repair beyond budget, and provider-name branch in validation each
      fail a dedicated test when reintroduced.
- [ ] `npm run ci` is green from the repo root; `plugin/` is regenerated in the same change when
      `core/` is edited.
