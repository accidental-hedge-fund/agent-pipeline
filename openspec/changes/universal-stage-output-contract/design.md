## Context

Today three different output-shape patterns coexist:

1. **Plan-revision** (`verifyPlanRevisionOutput` + `PLAN_REVISION_FORMAT_REPAIR_ADDENDUM` in
   `planning.ts`): pure function + exactly one stage-local re-prompt; terminal block uses
   `needs-human` (#658).
2. **Review verdict** (`review-schema.ts` → `{{schema_block}}`, `review-parsing.ts`): real
   single-sourced JSON schema, drift-guarded, no shared repair policy (parse failure is
   stage-local).
3. **OpenSpec singularity** (`enforceOpenspecChangeSingular`): hard-block when ≠1 new change;
   **zero** repair loop (#770 evidence).

Shared harness-round (#629) already owns the common implementer-round skeleton
(reattach → headBefore → invoke → salvage → verify → format/test → push). PR #787 /
#760 added `pipeline/stage-diagnostic@1` including reason `harness-contract` for capture and
output-contract failures, projecting to engine-owned recovery rather than human authority.

Issue #777 generalizes (1) into a universal layer, registers (2)/(3) and peers, and fixes the
terminal disposition so pure shape exhaustion is `harness-contract`, not product judgment.

## Goals / Non-Goals

**Goals:**

- Versioned, machine-checkable output contracts for every in-scope implementer-facing (and
  structured-output reviewer) stage.
- One central validation entrypoint used before stage side effects.
- One shared format-repair policy (single bounded re-prompt) replacing plan-revision-only repair.
- Terminal pure shape failure → `pipeline/stage-diagnostic@1` reason `harness-contract`.
- Adapter envelope normalization ≠ stage schema validation (layered).
- Golden fixtures for named Claude/Grok/Codex shapes; extension-adapter fixture hook.
- Preserve existing plan-revision shape tolerances and review schema field contract.

**Non-Goals:**

- Prompt **input** invariants (#737).
- Verification-capability negotiation product (#738) beyond declaration-shape alignment.
- Redesigning review findings schema, severity policy, or review rigor demotion.
- Parallel diagnostic taxonomy outside stage-diagnostic@1.
- Runtime `if (harness === "grok")` validation branches.
- Auto-merge / unattended merge.

## Decisions

### Decision 1 — Contract registry + versioned descriptors (not ad-hoc regex islands)

Introduce a small registry of **stage output contracts**. Each entry declares at least:

| Field | Purpose |
| --- | --- |
| `id` | Stable contract id (e.g. `plan-revision.ack@1`, `openspec.change-singular@1`, `review.verdict@1`) |
| `version` | Integer or `@N` suffix; bumps when the machine-checkable shape changes |
| `kind` | `markdown-sections` \| `json-schema` \| `filesystem-shape` (extensible closed set) |
| `validate(input) → { ok, reason, normalized? }` | Pure validation |
| `repairAddendum?` | Short format-repair instruction text when repair is applicable |
| `sideEffectGate` | Documented side effect that MUST NOT run until `ok` (post plan, accept verdict, …) |

**Why registry over only documenting patterns?** Stages already diverge; a registry is the
single place CI/tests can assert “every in-scope stage has a contract” and “validation is
invoked before side effect X.”

**Alternative considered:** Only extract shared repair and leave validators private. Rejected —
the issue explicitly requires machine-checkable contracts per stage and central validation.

### Decision 2 — Two layers: adapter envelope vs stage schema

```
harness stdout / FS snapshot
        │
        ▼
 adapter envelope normalization   ← transport (telemetry frames, capture wrappers)
        │
        ▼
 stage-output-contract validate   ← product shape (sections / JSON / singularity)
        │
   ok ──┼── fail → shared format-repair (≤1) → re-validate
        │              │
        ▼              exhausted → harness-contract diagnostic; no side effect
   stage side effect
```

**Why separate?** Issue recommendation: “Keep adapter envelope normalization separate from
stage-schema validation.” Mixing them recreates provider branches inside product gates.

### Decision 3 — Shared format-repair policy (exactly one re-prompt by default)

Single helper, e.g. `runWithFormatRepair({ validate, invoke, repairAddendum, budget: 1 })`:

1. Invoke harness (or accept already-captured output for post-hoc paths).
2. Validate.
3. On pure contract failure and budget remaining: re-invoke once with original prompt +
   contract `repairAddendum` (or a shared generic addendum + contract-specific bullets).
4. Re-validate; on success proceed; on fail → terminal `harness-contract`.

**Why one retry?** Matches #658 shipped policy and the issue’s “single bounded retry.” More
retries burn implementer cost without fixing systematic contract/prompt bugs.

**Where it lives:** Prefer a pure orchestration helper under `core/scripts/` that
`shared-harness-round` **and** non-round stages (plan-revision, OpenSpec authoring) both call.
Do **not** bury validation only inside harness-round — plan-revision is not a commit-producing
shared-round consumer today.

**Alternative considered:** Only wire repair through harness-round. Rejected for plan-revision /
authoring coverage.

### Decision 4 — Terminal disposition is `harness-contract`, not `needs-human`

#658 intentionally used `needs-human` after format-repair exhaustion to avoid auto-loop
re-dispatch traps. #760/#787 then introduced typed `harness-contract` projecting to
`workflow-engine-defect` / recover disposition (engine-owned, not human authority).

This change **updates** pure shape exhaustion to emit stage-diagnostic reason
`harness-contract`. Product `human-decision-required` remains reserved for attested product
authority findings.

**Migration note:** Plan-revision scenarios in `harness-step-verification` that require
terminal `needs-human` for missing ack **after retries** are MODIFIED accordingly. Loop
recovery already classifies output-contract → harness-contract; stage producers must emit
consistent diagnostics so classification is not prose-scraped.

### Decision 5 — In-scope contracts for the first cut

| Contract id | Kind | Source of truth today | Repair |
| --- | --- | --- | --- |
| `plan-revision.ack@1` | markdown-sections | `verifyPlanRevisionOutput` | yes (migrate #658) |
| `openspec.change-singular@1` | filesystem-shape | `enforceOpenspecChangeSingular` | yes (re-prompt: exactly one change dir) |
| `review.verdict@1` | json-schema | `review-schema.ts` + parsers | yes if parse/schema fail is pure shape (not empty product findings) |

Additional structured-output stages (shipcheck, design interrogation/response, auto-merge
judge) SHOULD register in the same change **when** they already have a machine-checkable
schema constant; if wiring all at once is too large, the registry MUST still be exhaustive for
the three above, and a drift test MUST list the remaining structured-output stages as
**follow-up registrations** (tracked, not silently omitted forever). Prefer registering all
existing schema-backed stages in this change when low-cost.

Commit-message format checks (fix subject patterns) remain under
`harness-step-verification` / commit gates — they are not stdout contracts, but MAY later
gain a `commit-message` kind; not required for #777 first cut.

### Decision 6 — Golden fixtures are fixtures only

Store frozen stdout (or FS manifests) for:

- Grok mid-line `## Feedback Incorporated` (#622 shape)
- Claude well-formed line-start ack
- Codex (or second Claude) fenced/duplicated-header tolerated shape
- Review fenced JSON verdict
- OpenSpec multi-change failure manifest (expected `ok: false`)

Tests assert: `validate(fixture)` expected result. **Forbidden:** `if (adapterName === "grok")
return ok`.

Extension adapters (#783): registry exposes `registerGoldenFixture({ adapter, contractId,
fixturePath, expect })` or a test-only discovery glob under a documented path so extension
packs can drop fixtures without engine provider switches.

### Decision 7 — Versioning and drift guards

- Contract id includes version (`@1`). Breaking shape change → new version; old id retired or
  dual-supported only during a documented migration window (prefer hard cut inside one release).
- Drift tests (pattern of `prompt-loader.test.ts` / review-schema tests):
  - every in-scope stage id appears in the registry;
  - plan-revision repair no longer owns a private full retry loop;
  - repair budget constant is single-sourced;
  - golden fixtures still pass/fail as recorded;
  - no provider-name branch in validate modules (static scan or architecture test).

### Decision 8 — Sequence with #629

Shared harness-round is a **dependency preference**, not a hard merge-order lock:

- If shared-round already landed on the integration branch, host repair orchestration calls from
  it where implementer rounds already go through the helper.
- If not, land the pure contract + repair helpers first; shared-round consumes them when merged.
  Specs require shared-round consumers to use the shared repair policy once both exist — no
  permanent private repair fork.

## Risks / Trade-offs

- **[Risk] OpenSpec “exactly one change” repair rewrites authoring more than format** →
  Mitigation: repair addendum is surgical (“leave a single change directory; remove extras or
  merge”); still may burn a full authoring invoke — accepted vs operator unblock.
- **[Risk] Review parse failure after repair still yields empty findings** → Mitigation:
  distinguish pure unparseable shape (repair + harness-contract) from valid empty findings
  array (product outcome). Do not reclassify empty findings as contract failure.
- **[Risk] Changing plan-revision terminal from needs-human to harness-contract alters loop
  recovery** → Mitigation: aligns with #760 projection; ensure durable class is engine-owned
  recover, not human hold; regression tests on projection.
- **[Risk] Over-centralization slows stage iteration** → Mitigation: contracts stay thin pure
  functions; stage product policy (when to revise, what to post) remains stage-owned.
- **[Risk] Fixture rot as prompts change** → Mitigation: fixtures pin **response shapes**, not
  full prompt transcripts; update only when intentional tolerance changes.

## Migration Plan

1. Land registry + shared repair helper + diagnostics wiring with plan-revision as first
   consumer (behavior-preserving for mid-line/fence tolerances; terminal disposition change).
2. Register OpenSpec singularity + review verdict; delete private plan-revision repair skeleton.
3. Add golden fixtures + drift guards.
4. Wire remaining schema-backed stages or record explicit follow-up list in tasks with tests
   that fail if the follow-up list grows without issue links.
5. Regenerate `plugin/`; `npm run ci`.

Rollback: revert the change; no durable on-disk schema migration. In-flight issues blocked under
old `needs-human` for shape failure may need one operator re-run after upgrade to pick up
harness-contract classification.

## Open Questions

- Exact module filename (`stage-output-contract.ts` vs split registry/validate/repair) — leave
  to implementer; specs constrain behavior, not path.
- Whether filesystem-shape repair for OpenSpec uses the same invoke seam as authoring or a
  narrower “fix singularity only” prompt — prefer same authoring harness with repair addendum
  unless evidence shows wasteful full rewrites, then narrow.
- Whether shipcheck / design-* / auto-merge judge are same-PR or immediate follow-up — prefer
  same-PR when each is a thin register+call; otherwise tasks section 5 lists them with issue
  linkage requirement.
