## Context

See `proposal.md` for why.

Today admission is `pipeline refine-spec --issue N` (Implementer then Reviewer, signed `grill-proposal.v1` envelope to stdout) plus `pipeline refine-spec apply --issue N` (HMAC verify, body-only write) plus a separate `pipeline triage N --stage ready`. Operator-required taxonomy classes always wait for `pipeline handoff answer`. Refinement must not write `CONTEXT.md` or ADRs. Host-local `grill-with-docs` cannot be a CLI runtime dependency.

Already in `core/scripts/`: Decisions artifact parse/render (`grill-decisions.ts`), bounded dependency walker (`grill-facts.ts` + `declared-dependency-grammar.ts`), fingerprints (`grill-fingerprint.ts`), closed taxonomy (`grill-taxonomy.ts`), model-free ready validator (`grill-ready.ts`), HMAC frontier (`grill-frontier.ts`), grill-authority handoffs (`grill-handoff.ts` + `human-question-handoff.ts`), milestone listing (`milestone-open-issues.ts`), worktree + PR pattern (`worktree.ts`, intake/sweep), command registry + `OPERATION_SURFACE`, and the #1238 pickup gate.

This change is class-level pre-admission law. The next thin issue, and the v1.40.1 milestone, use the same `pipeline grill` path.

## Goals / Non-Goals

**Goals:**

- One native CLI verb that selects, grills, writes spec + domain docs, and requests `pipeline:ready`.
- First holding rung of reuse: existing grill modules, ready validator, handoff ledger, selector listing helpers, worktree/PR, registry/docs catalogs.
- Engine-side auto-settle for evidence-backed recommendations that stay inside existing authority.
- Durable batch with frozen membership, per-issue isolation, dry-run, and resume.

**Non-Goals:**

- Splitting `pipeline.ts` (#990).
- A new command-grammar module (#1355 owns that extraction).
- Coupling grill batch lifecycle to the pipeline loop supervisor.
- A second scheduler, answer ledger, dependency parser, or ready validator.
- Host Skill / mattpocock/skills at runtime.
- Merge, deploy, or writes to the integration branch.
- Replacing or invoking #1238 inside grill or triage.

## Decisions

### D1 — Verb is `pipeline grill`; do not overload `refine-spec`

`refine-spec` stays the Desk `--title/--body` preview. Admission is a new no-issue-number keyword `grill`. Mixing grill with advance/loop/train is a usage error.

Alternative considered: extend `refine-spec --issue` into a mutating batch. Rejected: preview vs mutate vs ready vs docs-PR would hide side effects behind one already-overloaded verb.

### D2 — Reuse existing Commander flags; one selector per invocation

Use the existing `--issue`, `--issues`, `--milestone`, and `--label` (repeatable) options. Exactly one selector form is required. Repeated `--label` is AND intersection. `--issue` and `--issues` are distinct forms. `status` is a sub-verb. `--resume <run-id>`, `--follow`, `--dry-run`, and `--json` are flags.

Alternative considered: a new `--selector` DSL. Rejected: train/loop/merge-queue already teach these flags.

### D3 — Thin dispatch in `pipeline.ts`; handler module owns the operation

Add `core/scripts/stages/grill.ts` (plus focused helpers next to existing `grill-*.ts`). Register in `COMMAND_REGISTRY`, `command-docs.ts`, and `OPERATION_SURFACE`. Do not split `pipeline.ts`. Selector usage text is single-sourced in command-docs / OPERATION_SURFACE so generated CLI and host SKILL tables stay in sync (#1355 coordination: consume the registry, do not extract a new grammar module here).

### D4 — Frozen versioned selection manifest

Resolve membership once before the first write. Persist a versioned manifest: selector, resolved issue ids sorted ascending, fetch identity (repo, time, integration-base SHA). Closed issues at resolve time are ineligible and never relabeled. A later milestone or label change does not add or drop members of that run. `--resume` reloads the manifest; it does not re-query membership.

Listing reuses `milestone-open-issues.ts` for `--milestone` and existing GitHub issue-list helpers for labels and explicit ids. Do not invent a second listing client.

Alternative considered: live re-query like `pipeline loop`. Rejected: the issue locks freeze-before-write so label/milestone drift cannot silently change a running batch.

### D5 — Shared per-issue state machine; batch is a driver

Single-issue and batch call the same per-issue machine. The batch driver walks declared-dependency order using `walkDeclaredDependencyClosure` / `parseDeclaredDependencyIds`. It processes currently unblocked issues, isolates failures, and continues dependency-independent peers. It does not enqueue into the loop supervisor.

Per-issue durable state records: facts, design-tree frontier, accepted recommendations, unresolved typed requests, documentation actions, ready-gate evidence.

### D6 — Reuse Decisions artifact, taxonomy, fingerprints, and ready validator

Keep `decisions.v1` in the issue body and the derived `## Decisions` section. Keep `grill-taxonomy.v1`. Keep fingerprint fields and the model-free `validateDecisionsForReady`. Grill writes the body; `pipeline grill` then calls that validator before any ready label write. `pipeline triage N --stage ready` stays a valid operator path through the same validator.

Extend `SettledBy` with `auto-accept` (additive). Do not mint a parallel body schema.

Keep the engine-produced HMAC frontier as ready-gate anti-tamper, written by grill when it writes the body. It is not an operator-facing preview envelope. Document it as host-local authenticity, same class as other host-local artifacts.

### D7 — One planning-treatment Implementer call per unblocked frontier round; engine auto-settles

Facts come from the trusted integration base, forge, config, and declared dependencies. Models never ask the operator for discoverable facts.

For each issue, maintain a design tree. Process every currently unblocked frontier node. The Implementer proposes question, recommendation, evidence, and class. The engine then:

- Auto-settles when the recommendation is reversible, in scope, policy-consistent, and covered by existing authority. Provenance is `settled-by: auto-accept`.
- Emits `DecisionRequest` when product requirements contradict.
- Emits `CapabilityRequest` when external ability or information is missing.
- Emits `AuthorityRequest` when the action is security-sensitive, irreversible, merge/release, or human-attested **and** existing authority does not cover it.

Low confidence is not a pause. Auto-accept never grants merge, release, destructive, security, or other protected authority.

Do not keep the signed Reviewer envelope as a required intake step. The Reviewer two-call protocol is obsolete controller machinery.

Alternative considered: keep Reviewer `accept`/`challenge` as a mandatory second call. Rejected: it is the round-trip the issue is replacing.

### D8 — Typed requests reuse the existing handoff ledger

Map onto existing `HANDOFF_CLASSES` (no new class, no new CLI verb):

| Typed request | `handoff_class` |
| --- | --- |
| `DecisionRequest` | `product_judgment` |
| `CapabilityRequest` | `missing_context` |
| `AuthorityRequest` for `security` / `irreversible-operations` | `risk_authority` |
| `AuthorityRequest` for `scope` / `merge-release` / `human-attestation` | `product_judgment` |

Create only for unresolved typed requests, using the existing policy-bound grill-authority gate (repo, issue, node ID, frontier fingerprint, body hash; `candidate_sha` omitted when no tip). Do not auto-create a handoff for every operator-required taxonomy class when auto-settle applies. `pipeline handoff answer` still materializes into the body. An answer does not itself flip `pipeline:ready`.

### D9 — Domain docs via one worktree and PR per batch

Reuse the intake/sweep worktree + branch + `gh pr create` pattern. Never write the integration branch. Newly settled project-specific vocabulary updates `CONTEXT.md` using the existing glossary format. A qualifying hard-to-reverse trade-off creates a concise ADR under `docs/adr/`. Deduplicate identical term/ADR payloads across the batch into one PR.

Classify required vs advisory from the integration-base `CONTEXT.md` blob and `term_id` references, as `grill-context.ts` already does. Required docs block ready until `required_context.integration_base_sha` and `required_context.context_md_sha256` match a trusted base that contains every required term. Advisory docs do not block. Resume after that PR is on the trusted base. Do not promote from a stale base.

### D10 — Ready promotion is the existing gate, invoked by grill

After body, provenance, dependency facts, required domain terms, and fresh fingerprints pass `validateDecisionsForReady`, grill performs the same label reconciliation as `triage --stage ready`: add `pipeline:ready` first, remove other `pipeline:*` labels, re-fetch, retry one remove pass, persistent extras → `label_reconciliation_failed` without dropping `pipeline:ready`.

This is not a bypass of #1238. Pickup still evaluates the fresh body.

Grill never calls `merge`, `merge-queue --apply`, `train --merge`, or `ship`.

### D11 — Durable grill-run store copies the loop-store I/O seam, not the loop contract

Persist run identity, frozen manifest, per-issue state, and events under a grill-run directory with injected filesystem deps (atomic write, exclusive create — same seam style as `loop/store.ts`). Do not import the loop contract, supervisor, or work-list scheduler. `--follow` streams that run’s events until a terminal batch status. `pipeline grill status --run-id` prints the projection. `--resume` continues the same manifest.

Alternative considered: enqueue selected issues into `pipeline loop`. Rejected: the issue forbids coupling lifecycle ownership to loop.

### D12 — Native workflow; no host skill at runtime

Prompts live in `core/scripts/prompts/`. Behavior is versioned in this change. The CLI must not shell out to a personal Codex skill, a host Skill tool, or mattpocock/skills.

### D13 — Migration then removal of #1316 controller machinery

During replacement coverage:

1. Parse existing `decisions.v1` artifacts, HMAC frontiers, pending grill-authority handoffs, `grill-proposal.v1` envelopes, and `<!-- grill-with-docs:v1.40.1 -->` markers plus Decisions sections.
2. Re-gather facts. Reject stale recommendations. Do not trust a marker alone.
3. Auto-settle still-current recommendations. Create typed requests only when irreducible.
4. Idempotent writes: replay must not duplicate body edits, docs PRs, handoffs, or label transitions.
5. `pipeline refine-spec --issue` / `apply` become compatibility shims that diagnose and point at `pipeline grill --issue N`, or no-op when the issue is already migrated.

After replacement tests pass, remove obsolete operator-facing envelope/apply controller code. Keep Decisions parse/render, taxonomy, facts, fingerprints, ready validator, and engine-produced frontier.

`--title/--body` refine-spec stays.

## Risks / Trade-offs

- **[Risk] Auto-settle over-grants product defaults** → Mitigation: closed predicate (reversible, in-scope, policy-consistent, existing authority). Protected classes without existing authority become `AuthorityRequest`. Tests for each typed request and for auto-accept refusal on protected actions.
- **[Risk] Host-local HMAC frontier fails on another host** → Mitigation: body remains the spec; frontier is anti-tamper. Document single-host authenticity. Do not make the operator-facing protocol depend on copying the key.
- **[Risk] Docs PR stalls the whole batch** → Mitigation: required-docs wait is per-issue. Independent issues continue. Advisory docs never block.
- **[Risk] Dual controllers during migration duplicate writes** → Mitigation: idempotent migration keys (issue + body hash + request identity). Compatibility shim does not apply envelopes that grill already materialized.
- **[Risk] Frozen manifest hides newly opened milestone issues** → Mitigation: intended. Operator starts a new grill run for new members.
- **[Risk] Design-tree rounds explode token cost** → Mitigation: reuse `MAX_NODES` / `MAX_NODE_TEXT` bounds. One Implementer call per unblocked frontier round, not per node.

## Migration Plan

1. Land `pipeline grill` with tests. Keep `refine-spec --issue` / `apply` as shims.
2. Dogfood `--milestone v1.40.1`: migrate markers, re-gather facts, auto-settle, typed requests, docs PR, ready promotion, batch report (selected / migrated / waiting / ready / failed).
3. After replacement coverage, delete obsolete envelope/apply controller and rewrite ADR 0002 + `CONTEXT.md` glossary.
4. Rollback: revert the PR. Existing Decisions bodies remain readable. Ready validator fail-closed on unknown `settled-by` until the new enum is present.

## Open Questions

None. Selector grammar, auto-settle vs typed requests, docs-PR, ready-gate reuse, and loop non-coupling are locked by the issue.
