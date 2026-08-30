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

### D2 — `--issue` is a flag; `apply` is a positional sub-verb; proposal is stdin XOR `--proposal-file`

`refine-spec` stays `needsIssueNumber: false`. Callers use `pipeline refine-spec --issue N` and `pipeline refine-spec apply --issue N`. Mixing `--issue` with `--title/--body` is a usage error.

Apply transport is exclusive: stdin **or** `--proposal-file PATH`. There is no positional `<proposal>` token. A free-form positional conflicts with the no-issue-number dispatch contract (`maxPositionalsFor("refine-spec")` becomes 2 for the `apply` sub-verb only). Empty input, both sources present, or UTF-8 size above 1 MiB exits 2 with no mutation. Registry `allowedFlags` adds `issue` and `proposalFile`. Help names both `--issue` and `--proposal-file`.

`--title/--body` stays one Implementer call, gh-free, no Decisions requirement, no GitHub writes. Its stdout contract stays exactly `{ title, body, milestone }` (plus `--json` as a no-op). Issue preview requires repository `pipeline.yml` planning treatment and GitHub fetch.

Kill-switch: `apply` honors it (no body write). Preview does not. Implementation keys that on the `apply` sub-verb, not a single registry `mutatesGitHub` boolean that would also block preview. Registry stays `needsGhAuth: false` and `mutatesGitHub: false` so `--title/--body` stays usable without GitHub. `--issue` preview and `apply` resolve GitHub auth in their own handlers after flag validation.

Alternative considered: `--apply` flag like sweep. Rejected: the issue locks the positional `apply` form. Alternative considered: positional `<proposal>` blob. Rejected: it collides with issue-number dispatch.

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

Use the existing "policy-bound authority gate" clause in `canCreateHandoff` (`core/scripts/human-question-handoff.ts`). The gate evidence for a grill node is repository, issue, node ID, frontier fingerprint, and source body hash. `candidate_sha` is omitted when no PR/worktree tip exists. Do not weaken HDR for mid-flight handoffs. Grill-authority evidence SHALL NOT satisfy a mid-flight `product_judgment` create.

Map operator-required taxonomy members onto existing `HANDOFF_CLASSES` (no new class, no new CLI verb):

| Taxonomy class | `handoff_class` |
| --- | --- |
| `scope` | `product_judgment` |
| `merge-release` | `product_judgment` |
| `human-attestation` | `product_judgment` |
| `security` | `risk_authority` |
| `irreversible-operations` | `risk_authority` |

Store node identity in existing fields: `declaration_identity = grill-v1:<node_id>:<frontier_fp>:<body_sha256>` and `scope.content_hashes = [body_sha256, frontier_fp, node_id]`. `blocked_stage` is `triage`.

**Create timing (apply, not preview):** After envelope/challenge/drift checks pass, apply creates one pending grill-authority handoff per unresolved operator-required node **before** the GitHub body write. Bindings use the **proposed** body hash (the body apply will write). Create is idempotent on `declaration_identity`. Preview still writes nothing, including no handoff store.

**Answer CLI (unchanged verb):** `pipeline handoff answer <handoff-id> --issue N --text "…" [--client-request-id id]`.

**Answer failure ordering:**

1. Authorize the actor (`authorizeHandoffAnswer`). Unauthorized: ledger pending, body unchanged.
2. Re-fetch the issue body. Compute `sha256` of the live UTF-8 body.
3. Body-hash drift: exit 2, GitHub body unchanged, handoff status stays `pending`.
4. Deterministically patch only that node (resolution, provenance `handoff:<id>`, derived `## Decisions` render). Other nodes stay unchanged.
5. GitHub body write. On write failure: ledger stays `pending`, live body unchanged.
6. Persist `answered` only after the body write succeeds. On persist failure after a successful body write: body stays patched; ledger stays `pending`. A later answer with the same payload hash heals the ledger without a second body write when the live node already carries that handoff provenance (idempotent retry).
7. Concurrent different payloads against an already-answered record: existing `already_answered` refuse. Same payload or same `--client-request-id`: existing duplicate success, `advances_item: false`.

Answer never adds `pipeline:ready`. `--stage ready` stays a separate request.

### D7 — Apply is signed-envelope replay; ready is fingerprint validation

Preview emits one bounded typed **signed envelope** (see D10). Apply verifies the MAC, expiry, nonce, issue/repo binding, challenge-free verdicts, and live title/body identity **before** any body write. No model call.

Apply refuses any `challenge` (exit 2, no mutation). Apply re-fetches title and body and requires identity match with the envelope input; drift exits 2. Apply writes only the issue body.

`--stage ready` re-fetches, parses the artifact, and requires: no unresolved authority, no unresolved typed facts (D13), valid provenance for every settled node, current fingerprints listed in D12, render/artifact identity, and required-context satisfaction (D14). Any bound-input change is stale (exit 2, no labels). A valid request changes only the stage label, then reconciles leftover `pipeline:*` labels (D16).

Pickup still runs #1238 on fresh GitHub state. Do not put Implementer or Reviewer inside `--stage ready`.

### D8 — Facts use the existing dependency grammar and a bounded closure

Call the exported `parseDeclaredDependencyIds` in `core/scripts/declared-dependency-grammar.ts`. Walk a versioned bounded closure: max depth 8, max 32 distinct issue ids. Cycles, inaccessible or missing issues, malformed declarations, and closure-limit exhaustion are typed unresolved facts with closed codes:

- `dependency.cycle`
- `dependency.missing`
- `dependency.inaccessible`
- `dependency.malformed`
- `dependency.closure_exhausted`

Each fact records the code, the involved issue ids, and the edge list that was walked. Never silently truncate. Never invent a second parser.

**Ready-blocking rule (not discretionary):** any unresolved fact with one of those five codes SHALL fail `--stage ready` (exit 2, no label write). Comments are not settled specification decisions, including #1238 owned comments.

### D9 — CONTEXT proposals are Pipeline-classified; never repo writes

Shared-terminology gaps produce a typed `CONTEXT.md` proposal in the envelope. Refinement never edits repository files.

**Classification is Pipeline-owned, not model prose.** After fact lookup of `CONTEXT.md` at the trusted integration-base blob:

1. Collect glossary term ids present in that blob (ATX `**Term**:` entries, same shape as root `CONTEXT.md`).
2. Collect term ids referenced by operator-required nodes (`term_id` on the node, optional).
3. A proposal is `required` iff at least one operator-required node references a term absent from that blob. Otherwise it is `advisory`.
4. The model MAY suggest necessity. Pipeline overwrites the field. A model-written `required` with no missing referenced term is stored as `advisory`. A model-written `advisory` that matches the missing-term rule is stored as `required`.

**Recording the reviewed base:** Pipeline-owned artifact field `required_context` is:

```
{ terms: string[], integration_base_sha: string | null, context_md_sha256: string | null }
```

`integration_base_sha` and `context_md_sha256` are written only by Pipeline when the current trusted-base `CONTEXT.md` blob contains every `terms` entry. Model prose cannot set or clear those hashes. `--stage ready` recomputes the current base SHA and `CONTEXT.md` blob hash; mismatch or missing terms fails ready.

### D10 — Tamper-evident proposal envelope

Input title/body fingerprints do not stop an operator from editing a proposal body or changing `challenge` to `accept`. Preview stdout is a signed envelope, not a free-form JSON blob.

Envelope schema `grill-proposal.v1`:

- `schema_version`: `1`
- `kind`: `grill-proposal`
- `issued_at`, `expires_at` (TTL 24 hours from `issued_at`)
- `nonce` (16-byte hex)
- `repo`, `issue`
- `input`: `{ title, body, title_sha256, body_sha256, fingerprint }`
- `proposal`: `{ body, artifact, verdicts, advisory_title, advisory_milestone, context_proposals }`
- `mac`: `hmac-sha256:<hex>`

Canonical bytes: UTF-8 JSON with sorted object keys and no insignificant whitespace, covering every field except `mac`. HMAC-SHA256 uses a host-local key (same `createHmac("sha256", key)` pattern as `core/scripts/factory-reliability-gate.ts`). Key source, in order: `PIPELINE_GRILL_PROPOSAL_KEY`, then `PIPELINE_GRILL_PROPOSAL_KEY_FILE`, then gitignored `.agent-pipeline/grill-proposal.key`. If none exist at preview, Pipeline creates the gitignored key file (credential bootstrap only). Preview SHALL NOT persist the envelope itself. Do not reuse `PIPELINE_FRG_ATTESTATION_KEY`.

Apply verifies MAC, schema version, `kind`, TTL (`now` from an injected clock), `repo`/`issue` match, and that `--issue N` equals `envelope.issue` before any GitHub write. Tamper, forged verdicts, unknown version, or expired envelope exit 2 with no mutation.

**Replay:** After a successful GitHub body write, apply records the nonce as consumed in gitignored `.agent-pipeline/grill-proposals/consumed.json`. A later apply of a consumed nonce exits 2 even if the operator reverts the GitHub body. Consumed-nonce storage is host-local (same single-host scope as `lock.ts`). Cross-host double-apply of a still-valid envelope is stopped by live title/body identity on GitHub, not by the nonce ledger.

**Storage:** stdout is the envelope. Operators may redirect to a file and pass `--proposal-file`. No GitHub comment, gist, or tracked file stores the envelope.

### D11 — Closed taxonomy, schema version, and body delimiters

Taxonomy `grill-taxonomy.v1` is Pipeline-owned. Operator-required members: `scope`, `security`, `irreversible-operations`, `merge-release`, `human-attestation`. Non-authority members: `interface-contract`, `test-evidence`, `docs-surface`, `operational-default`. Unknown or disputed class stays unresolved authority and cannot record `settled-by: reviewer-accept`.

Decisions artifact schema `decisions.v1`. Unknown `schema_version` fails closed. v1 has no silent migration.

Body embedding mirrors `ISSUE_READINESS_MARKER_PREFIX` in `core/scripts/issue-readiness.ts`: exactly one HTML comment

`<!-- pipeline-decisions:v1 sha256=<64hex> -->`

immediately followed by a fenced block:

````
```pipeline-decisions-v1
<canonical artifact JSON>
```
````

The fence payload is canonical JSON (sorted keys, no insignificant whitespace). The SHA in the HTML comment is SHA-256 of those UTF-8 bytes, recorded as 64 lowercase hex with no `sha256:` prefix in the comment (the `sha256=` attribute is the prefix). A second fence, a digest mismatch, or a `-->` / fence collision inside the payload fails parse. User prose that copies the fence string yields "multiple artifacts" and fails validation. Pipeline renders `## Decisions` from the parsed artifact; divergence fails apply, handoff materialize, and `--stage ready`.

Numeric bounds (fail closed, never truncate):

| Bound | Limit |
| --- | --- |
| Envelope UTF-8 | 1 MiB |
| Artifact JSON UTF-8 | 256 KiB |
| CONTEXT proposal UTF-8 | 16 KiB |
| Nodes | 64 |
| Node question / recommendation | 2000 chars |
| Dependency closure | depth 8, 32 issues |

### D12 — Fingerprints ready recomputes

Digest algorithm for all content hashes: SHA-256 of UTF-8 bytes, recorded as `sha256:` + 64 lowercase hex.

The artifact `fingerprint` object (`grill-fingerprint.v1`) contains:

The envelope `input` block is the apply drift check: live title and live body at apply must equal `input.title` and `input.body`.

The artifact `fingerprint` object (`grill-fingerprint.v1`) is what ready recomputes. Apply writes `applied_body_sha256` as SHA-256 of the exact body it just wrote.

| Field | Source | Recompute at ready |
| --- | --- | --- |
| `title_sha256` | live issue title at preview | re-fetch title |
| `applied_body_sha256` | exact body apply writes | re-fetch body |
| `dependency_closure_sha256` | canonical JSON of sorted ids + per-id title/body hashes + typed fact codes | walk the grammar again from the live body and fetched deps |
| `integration_base_sha` | trusted integration-base revision | resolve base again |
| `context_md_sha256` | `CONTEXT.md` blob at that SHA | blob at current base |
| `provider_config_sha256` | canonical `{ implementer, reviewer, planning_model, planning_effort }` from required `pipeline.yml` | re-read config |
| `planning_treatment_sha256` | hash of the `TreatmentFingerprint` shape from `core/scripts/harness-adapters/treatment-fingerprint.ts` for the planning treatment | rebuild that fingerprint |

Ready fails if any field differs, if the artifact is missing a field, or if a seam cannot be read. A later GitHub body edit fails `applied_body_sha256` and also fails render/artifact identity when the fence is damaged.

### D13 — Unresolved typed facts always block ready

Covered by D8. The phrase "if it blocks authority completeness" is removed. The five dependency fact codes are always ready-blocking until a later preview records them resolved (cycle broken, issue fetchable, declaration well-formed, closure within bound).

### D14 — Required-context recording

Covered by D9. `--stage ready` does not trust a model-written `integration_base_sha`.

### D15 — Label-write reconciliation on `--stage ready`

Validation failure still makes **zero** label API calls.

On validation success, reuse add-first from `core/scripts/stages/triage.ts`:

1. Add `pipeline:ready` if missing.
2. Remove every other `pipeline:*` label.
3. Re-fetch labels.
4. If more than one `pipeline:*` remains, retry the remove pass once.
5. If still more than one, exit non-zero with `label_reconciliation_failed`. Do not remove `pipeline:ready` (the issue is never left unlabeled).
6. A later `--stage ready` that passes validation retries reconciliation. A later `--stage backlog` reconciles to exactly `pipeline:backlog` with no Decisions check.

`--stage ready` on an issue that already has `pipeline:ready` plus extras still validates first; on success it reconciles; on failure it writes nothing.

### D16 — `--title/--body --json` compatibility

The existing path in `runRefineSpec` stays the only `--title/--body` handler. Tests in `core/test/refine-spec.test.ts` stay green. Mixed `--issue` + `--title`/`--body` exits 2 before any harness. Unknown flags exit 2 before config resolution. `--json` on `--title/--body` still prints one object with `title`, `body`, and `milestone`. Extra fields SHALL NOT appear on that path.

## Risks / Trade-offs

- **[Risk] ADR 0002 and living triage/refine-spec specs disagree with the locked grill verb** → Mitigation: this change is the reconciliation. Tests lock refine-spec as the writer and triage as the gate.
- **[Risk] Handoff create would fail closed without reviewed SHA** → Mitigation: D6 policy-bound grill-authority gate; HDR path unchanged for mid-flight.
- **[Risk] Registry `mutatesGitHub` cannot express preview vs apply** → Mitigation: sub-verb check for kill-switch and auth; `--title/--body` stays gh-free.
- **[Risk] Two model calls increase cost vs #1238's one Implementer call** → Mitigation: grill is operator-invoked per issue, not pickup. Pickup stays #1238. Do not fold the Reviewer into `--stage ready`.
- **[Risk] Body-embedded artifact can drift from the rendered section** → Mitigation: validation fails on divergence at apply, handoff materialize, and `--stage ready`.
- **[Risk] Operators keep using comments as answers** → Mitigation: comments never settle nodes; ready gate ignores them; glossary and ADR say so.
- **[Risk] Operators edit a preview JSON before apply** → Mitigation: HMAC envelope (D10); apply verifies MAC before any write.
- **[Risk] Add-first label write leaves two `pipeline:*` labels** → Mitigation: re-fetch + one retry + typed failure; next ready/backlog reconciles; validation failure still writes nothing.
- **[Risk] Handoff persist fails after a body write** → Mitigation: D6 order; drift leaves both pending; answered persist heals on idempotent retry.
- **[Risk] Cross-host apply of a copied envelope** → Mitigation: MAC needs the host key; GitHub title/body identity stops a second write after the first host applies. Consumed-nonce ledger is host-local by the existing lock-scope disposition.

## Migration Plan

1. Ship schema, preview, apply, ready validator, and handoff materialize behind the existing commands (no new config kill-switch required for the grill itself; `--title/--body` remains).
2. Update ADR 0002 and `CONTEXT.md` in the same change.
3. Existing `pipeline:ready` issues without a Decisions artifact fail `--stage ready` until grilled. Pickup #1238 still runs for issues already at ready.
4. Rollback: revert the change. `--title/--body` and triage label writes return to current behavior.

## Open Questions

None. Plan review required the envelope, handoff lifecycle, transport, schema bounds, fact rule, CONTEXT classifier, and label reconciliation. D10–D16 lock those. The issue still locks the command split, authority taxonomy, and #1238 relationship.
