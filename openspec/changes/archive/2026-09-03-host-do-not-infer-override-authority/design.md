## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- `core/scripts/status-json.ts` — `deriveNextAction(stage, blocked)` returns prose. For `needs-human` it currently says `use --override "<key>: <reason>"`. `StatusPayload.schema_version` is `"1"` with additive fields (`possibly_wedged`, `event_stream_write_health`, `handoffs`).
- `core/scripts/operation-surface.ts` — host/SKILL catalog. Override `desc` is currently “Disposition a review finding and auto-resume the advance loop”.
- `core/scripts/host-skill.ts` — `renderHostSkill` Authority section lists merge/ship only. Follow contract already forbids follower merge. Four hosts are byte-identical.
- `core/scripts/types.ts` `BLOCKER_RECIPES` — `needs-human` and `human-decision-required` print `$pipeline {{N}} --override "..."` as an executable next step. Snapshots in `core/test/blocked-recipes.test.ts` pin the strings.
- `core/scripts/recover-parked.ts` — one pass per park fingerprint; spend markers already live on issue comments; extractors are pure. Eligibility (stale/DNR/below-high vs HIGH/CRITICAL/security/authority) stays.
- `docs/supervisor.md` already states recover-parked once then STOP; do not invent override. Generated SKILLs and status do not.

`COMMAND_REGISTRY` / `command-form-inventory` already classify `override` as `supervised-lifecycle` + `typed-response`. This change does not reclassify that form.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: extend status JSON, `OPERATION_SURFACE`, `BLOCKER_RECIPES`, and `renderHostSkill`. Reuse recover-parked spend extractors already on issue comments.
- Typed host-guidance projection so hosts do not infer override authority from prose.
- Shared wording on all four generated hosts. Tests fail if inferred override returns as the autonomous next action.
- Keep recover-parked eligibility and governed override recording unchanged.

**Non-Goals:**

- A new public verb, store, recoverer, or host-specific state machine.
- Engine self-repair for train/ship (`workflow-engine-defect` child operation). Separate issue.
- Changing override class policy, evidence, expiry, renewal, or auto-resume.
- Teaching train to auto-invoke `recover-parked`.
- Using Claude Auto permissions as authorization, or weakening host permissions.
- A new engine check that the GitHub actor “is a human” vs “is a host”. The engine cannot distinguish those without a second authority channel. Guidance is the control; operator-approved exact argv still records.

## Decisions

### D1 — Additive `host_guidance` on the existing status envelope

Add a closed enum to `StatusPayload` (intended key `host_guidance`):

| Value | Meaning for the host |
| --- | --- |
| `continue` | Follow / proceed. No operator disposition required. |
| `recover-parked` | Residual park; current fingerprint unspent. MAY run `pipeline recover-parked <N>` once. |
| `human-disposition-required` | STOP. Request the exact operator disposition. MUST NOT invent or run `pipeline override`. |
| `operator-merge` | Stage is `ready-to-deploy`. Merge remains operator-authorized. |

Keep `next_action` as human-readable prose. Rewrite the `needs-human` string so it does not instruct autonomous `--override`. Align prose with the enum.

`schema_version` stays `"1"` (same additive pattern as write-health).

Spend detection reuses recover-parked comment extractors already available to status assembly (`StatusIssueDetail.comments`). Do not add a new store. If spend cannot be determined, emit `human-disposition-required` (fail closed).

Extend `deriveNextAction` (or a sibling assembler in the same module) with the extra inputs it needs (park/spend evidence). Do not create a status controller or a host state machine. The enum is a projection.

Alternative considered: prose-only rewrite of `next_action`. Rejected: the issue asks for a typed signal where practical, and prose is what the host inferred from.

Alternative considered: bump `schema_version` to `"2"`. Rejected: existing additive-field rule already covers this.

Alternative considered: reuse ship’s boolean `human_authority`. Rejected: residual parks need recovery-first vs human-disposition as two states, not one bit.

### D2 — Catalog text is `OPERATION_SURFACE` plus generated docs

Change the override `desc` on `OPERATION_SURFACE` so `renderHostSkill` and generated `docs/cli.md` pick up operator-supplied wording from the same catalog. Align co-located command-docs metadata if it is a separate string. Do not add a second SKILL table.

Keep usage `override <n> "<key>: <reason>"`.

### D3 — Recipes keep the example, add the operator-path qualifier

Edit `BLOCKER_RECIPES` for every kind that prints an override command (`needs-human`, `human-decision-required`, and any other hit). Keep the copy-paste example for humans. Add: operator must supply the exact key/reason; this is not host authority; recovery-first is `pipeline recover-parked`. Update snapshots. Do not invent a parallel recipe map.

### D4 — Compact Authority / follow text, not a recovery essay

Extend the existing `renderHostSkill` Authority section and the follow STOP list with:

- override is operator-supplied / explicitly approved
- residual park: recover-parked once per fingerprint, then STOP and notify
- never invent override or drop `blocked`
- do not invoke recover-parked from inside `pipeline train`

This matches the merge-authority compact policy already in the SKILL. It is not a per-kind recipe catalog and does not violate “SKILLs SHALL NOT encode recovery recipes” as a second recoverer.

### D5 — Tests bite the class, not one host

Pin:

- `deriveNextAction` / status JSON for `needs-human` and residual-park fixtures (unspent, spent, unknown spend)
- all four generated SKILL files plus `renderHostSkill` (byte-identical; operator qualifier; STOP rule; no inferred-override next action)
- override-bearing recipe snapshots
- existing recover-parked HIGH/CRITICAL/security/authority refuse tests remain

A Claude-only assertion is not enough.

## Risks / Trade-offs

- **[Risk] Status mis-classifies a question-blocked item as `recover-parked`.** → Mitigation: emit `recover-parked` only for residual review parks / `needs-human` stage. `recover-parked` already no-ops on ineligible items. Fail closed to `human-disposition-required` when evidence is ambiguous.
- **[Risk] Hosts ignore the enum and keep reading prose.** → Mitigation: rewrite prose too; tests fail on the pre-change `--override` instruction.
- **[Risk] Recipe text grows and snapshot churn is noisy.** → Mitigation: surgical qualifier on override-bearing kinds only; other kinds unchanged.
- **[Risk] Compact SKILL text is read as a second recoverer.** → Mitigation: explicit “not from inside train”; living spec says compact STOP rule is not a recipe catalog.
- **[Risk] Follow-up engine self-repair is conflated with this change.** → Mitigation: proposal and this design mark it out of scope.

## Migration Plan

No protocol break. Additive JSON field; old consumers ignore it. Regenerated SKILLs and `docs/cli.md` ship in the same change. After `core/` edits run `node scripts/build.mjs`. Rollback is revert of the guidance/status commit; override recording and recover-parked eligibility do not migrate.

## Open Questions

None. Field key `host_guidance` and enum members are locked here so specs and tasks do not drift; implementation tests pin the JSON names.
