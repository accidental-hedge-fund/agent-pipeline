## Context

See `proposal.md` for why.

Today `pipeline refine-spec` is a gh-free `--title/--body` preview: one model call, canonical headings, no GitHub writes (`core/scripts/stages/refine-spec.ts`). `pipeline triage N --stage ready` is a deterministic label write with no body read (`core/scripts/stages/triage.ts`). Merged #1238 (`issue-implementation-readiness-gate`) is a pickup-time semantic gate: it writes an owned comment, never the body, and treats `--stage ready` as an admission request.

ADR 0002 already says Decisions live in the issue body and `--stage ready` is a deterministic gate. It also says bare `pipeline triage N` rewrites the body. That sentence conflicts with the locked command contract and with the living triage spec (`--stage` is required; triage never edits the body). This change supersedes that ADR sentence. Grill is `refine-spec --issue` / `apply`. Triage never writes the body.

`CONTEXT.md` already defines Grill, Decisions, and Authority node. Those terms omit reviewer-accept provenance and treat non-authority defaults as automatic without a reviewer verdict. This change reconciles the glossary with the locked taxonomy.

Planning-time `design-decision-record` (`design-decisions.json` in the run directory) is a different artifact. This change does not reuse that schema.

This is class-level pre-admission law, not a path-local mole. Shared pieces: Decisions schema, issue preview/apply, `--stage ready` validator, and the existing `pipeline handoff answer` boundary with a pre-admission policy-bound gate. The next thin issue uses that path. No new milestone scheduler and no second answer ledger.

## Goals / Non-Goals

**Goals:**

- One per-issue grill preview (Implementer then Reviewer) and a model-free apply.
- One versioned Decisions artifact in the body, with a rendered section derived from it.
- Operator-required classes settled only by authenticated hash-bound `pipeline handoff answer`.
- Model-free `--stage ready` that refuses incomplete or stale artifacts without flipping labels.
- Keep `--title/--body` refine-spec and #1238 pickup behavior as independent surfaces.

**Non-Goals:**

- Replacing or invoking #1238 inside triage.
- A milestone-level model prompt or second controller.
- A planning-stage interview loop.
- Direct `CONTEXT.md` or other repository-file edits from refinement.
- Comments as the specification.
- Applying title or milestone suggestions.
- Reusing `design-decision-record` as the body artifact.

## Decisions

### D1 — Grill is `refine-spec`; triage never edits the body

`--issue` preview and `apply` own the grill. `pipeline triage --stage` stays a label operation. `--stage ready` gains a deterministic Decisions validator before any label write. `--stage backlog` stays a label write with no artifact check.

Supersede ADR 0002's "bare `pipeline triage N` rewrites the body". Keep `--stage` required.

Alternative considered: overload `pipeline triage N` without `--stage` as the grill. Rejected: living triage spec requires `--stage`; mixing grill and labels in one verb hides mutations.

### D2 — `--issue` is a flag; `apply` is a positional sub-verb

`refine-spec` stays `needsIssueNumber: false`. Callers use `pipeline refine-spec --issue N` and `pipeline refine-spec apply --issue N`. Proposal transport is stdin or a bounded file path. Mixing `--issue` with `--title/--body` is a usage error.

`--title/--body` stays one Implementer call, gh-free, no Decisions requirement, no GitHub writes. Issue preview requires repository `pipeline.yml` planning treatment and GitHub fetch.

Kill-switch: `apply` honors it (no body write). Preview does not. Implementation keys that on the `apply` sub-verb, not a single registry `mutatesGitHub` boolean that would also block preview.

Alternative considered: `--apply` flag like sweep. Rejected: the issue locks the positional `apply` form.

### D3 — Two harness calls, reviewer sees Decisions only

Issue preview fetches current title and body, reads facts from the trusted integration-base revision plus the exact refinement context, then:

1. Invoke the resolved Implementer once with `harnesses.implementer`, `models.planning`, `effort.planning` (including `auto`).
2. Invoke the resolved Reviewer once with the proposed Decisions artifact plus the input fingerprint. No second copy of the whole-repository prompt.

Harness failure, malformed output, capability refusal, unavailable facts, or input drift: exit non-zero, no body or label mutation.

Alternative considered: one combined call. Rejected: the Implementer must not mark its own nodes `accept`; the Reviewer is independent provenance.

### D4 — Decisions artifact is Pipeline-owned; render is derived

Embed a versioned machine artifact in the body (HTML comment or equivalent Pipeline-owned fence). Render `## Decisions` from that artifact. Validation fails if they diverge.

Each stable node records: question, recommendation, authority class, resolution, provenance reference, input digests.

Pipeline validates class against a versioned closed taxonomy. The model may propose a class; an unknown or disputed class stays unresolved authority. Operator-required members SHALL include at least: `scope`, `security`, `irreversible-operations`, `merge-release`, `human-attestation`. Non-authority members are the remaining taxonomy members. Only taxonomy-validated non-authority nodes may take recommended defaults, with the eligibility reason recorded.

Do not reuse `design-decision-record`. Different lifetime (issue body vs run directory) and different authority rules.

### D5 — Reviewer verdicts are `accept` or `challenge` per unsettled node

After a valid Implementer proposal, the Reviewer returns one structured verdict per unsettled node: `accept` or `challenge`, plus a reason.

- Implementer output SHALL NOT contain `accept` as a settled-by value.
- `challenge` keeps the node unresolved, writes the challenge text into that node in the proposal, and makes the proposal ineligible for apply until a later preview.
- `accept` on a taxonomy-validated non-authority node records `settled-by: reviewer-accept` as provenance of the automatic default. It is not operator authority.
- `accept` on an operator-required class records that the recommendation was reviewed. The node stays unresolved until `pipeline handoff answer`.
- GitHub review comments and issue comments do not settle nodes.

### D6 — Extend `pipeline handoff answer`; do not add a ledger

Existing authority-bearing handoff create requires HDR evidence (finding key, fingerprint, reviewed SHA) or an already-specified policy-bound authority gate. Pre-admission has no PR tip and no reviewed SHA.

Use the existing "policy-bound authority gate" clause. The gate evidence for a grill node is repository, issue, node ID, frontier fingerprint, and source body hash. `candidate_sha` is omitted when no PR/worktree tip exists. Do not weaken HDR for mid-flight handoffs.

`pipeline handoff answer` stays the operator surface. A successful answer deterministically patches that node in the body, records the handoff provenance reference, and updates the rendered Decisions section. Drift of the bound body hash exits 2 with no mutation. Model-written `settled-by` prose cannot authorize itself.

### D7 — Apply is exact replay; ready is fingerprint validation

Preview emits one bounded typed proposal: full refined body, Decisions artifact, reviewer verdicts, input fingerprint, advisory title/milestone. Apply consumes that exact object. No model call.

Apply refuses any `challenge` (exit 2, no mutation). Apply re-fetches title and body and requires identity match with the proposal input; drift exits 2. Apply writes only the issue body.

`--stage ready` re-fetches, parses the artifact, and requires: no unresolved authority, valid provenance for every settled node, current fingerprints for issue title, dependencies, integration base, required context, provider configuration, and resolved planning treatment, plus render/artifact identity. Any bound-input change is stale (exit 2, no labels). A valid request changes only the stage label.

Pickup still runs #1238 on fresh GitHub state. Do not put Implementer or Reviewer inside `--stage ready`.

### D8 — Facts use the existing dependency grammar and a bounded closure

Call the exported declared-dependency grammar. Walk a versioned bounded closure. Cycles, inaccessible or missing issues, malformed declarations, and closure-limit exhaustion are typed unresolved facts. Never silently truncate. Never invent a second parser.

Comments are not settled specification decisions, including #1238 owned comments.

### D9 — CONTEXT proposals are typed preview output, never repo writes

Shared-terminology gaps produce a typed `CONTEXT.md` proposal in the preview. Required-for-implementation proposals block `--stage ready` until a separate reviewed PR lands and its integration-base reference is recorded in the artifact. Advisory proposals do not block. Refinement never edits repository files.

## Risks / Trade-offs

- **[Risk] ADR 0002 and living triage/refine-spec specs disagree with the locked grill verb** → Mitigation: this change is the reconciliation. Tests lock refine-spec as the writer and triage as the gate.
- **[Risk] Handoff create would fail closed without reviewed SHA** → Mitigation: D6 policy-bound grill-authority gate; HDR path unchanged for mid-flight.
- **[Risk] Registry `mutatesGitHub` cannot express preview vs apply** → Mitigation: sub-verb check for kill-switch and auth; `--title/--body` stays gh-free.
- **[Risk] Two model calls increase cost vs #1238's one Implementer call** → Mitigation: grill is operator-invoked per issue, not pickup. Pickup stays #1238. Do not fold the Reviewer into `--stage ready`.
- **[Risk] Body-embedded artifact can drift from the rendered section** → Mitigation: validation fails on divergence at apply, handoff materialize, and `--stage ready`.
- **[Risk] Operators keep using comments as answers** → Mitigation: comments never settle nodes; ready gate ignores them; glossary and ADR say so.

## Migration Plan

1. Ship schema, preview, apply, ready validator, and handoff materialize behind the existing commands (no new config kill-switch required for the grill itself; `--title/--body` remains).
2. Update ADR 0002 and `CONTEXT.md` in the same change.
3. Existing `pipeline:ready` issues without a Decisions artifact fail `--stage ready` until grilled. Pickup #1238 still runs for issues already at ready.
4. Rollback: revert the change. `--title/--body` and triage label writes return to current behavior.

## Open Questions

None. The issue locked the command contract, authority split, and #1238 relationship.
