## Context

The human-input gate (`findUnacknowledgedComments` in `issue-context-snapshot.ts`) blocks stage boundaries (review-1, fix, …) when comments after the plan anchor look like unacknowledged operator input. Self-exclusion for engine posts is a **three-part** contract established by #390 / #471 / #484:

1. **Structural classification** (`classifyComment`) — known headers + machine-sentinel HTML markers.
2. **Trusted author** — pipeline actor / `trusted_override_actors`.
3. **Verified output** — `isVerifiedPipelineOutput` (review-artifact, generic `pipeline-attest`, …) exempts objection-language bodies; unverified pipeline-styled bodies with negation prose still gate.

Design-gate (#436) posts progress under `## Design Interrogation` with a durable hidden `<!-- design-gate-state: … -->` snapshot and challenge prose that routinely matches `NEGATION_PATTERNS` ("do not", "instead", …). When design-gate was introduced, those markers were **not** added to the classification / attestation inventory, so successful design-gate runs false-blocked review-1 as "unacknowledged human input" (dogfood #784, #762). That is the same recurrence class as #390 / #471 / #484, not a product-semantics bug in the interrogation loop.

Partial recovery hooks landed during those dogfood fix loops; this change **formalizes the requirement surface** and closes remaining inventory / living-spec drift so the class cannot re-open silently.

## Goals / Non-Goals

**Goals:**

- Design-gate engine comments are structurally `pipeline` under `classifyComment`.
- New design-gate posts join the verified-output contract so challenge prose cannot false-block.
- Trusted, verified design-gate comments after the plan produce **zero** unacknowledged human-input findings.
- Stale threads that only carry a terminal decodable `design-gate-state` (no `pipeline-attest`) still self-exclude when trusted — without inventing a general unverified trust path.
- Living OpenSpec and drift guards name design-interrogation explicitly as a #390-class extension.
- Forge resistance preserved: non-trusted authors, non-decodable forgeries, and human text after terminal markers still gate.

**Non-Goals:**

- Changing design-gate trigger, challenge schema, disposition, or needs-human park product behavior.
- Disabling or relaxing the human-input gate for unmarked free-form comments.
- Auto-acking comments that merely "look automated" without a structural marker.
- Cross-host identity for the pipeline actor; trust remains the existing actor / `trusted_override_actors` path.
- Retroactively rewriting historical GitHub comment bodies in production threads.

## Decisions

### Decision 1 — Dual structural recognition (heading + durable-state path)

Recognize design-gate output via:

1. Heading `## Design Interrogation` in the pipeline header inventory (`PIPELINE_COMMENT_HEADERS` / equivalent), **and**
2. Verified-output acceptance of a **terminal, decodable** `<!-- design-gate-state: … -->` artifact for the human-input gate (and composition into `isVerifiedPipelineOutput`).

*Why both?* Production comments always use the heading; classification-by-heading is the cheap primary path and matches other stage posts. The durable-state path covers (a) gate exemption when challenge prose would fail the unverified objection scan, and (b) recovery for pre-attestation / stale-install posts that end on a valid state blob without `pipeline-attest`.

*Why not only add `design-gate-state` to `PIPELINE_SENTINEL_MARKERS`?* Substring sentinel membership alone would classify forged partial markers as pipeline without proving decodability. Classification may still treat the sentinel as a structural hint if desired, but **verification** MUST require terminal + decodable semantics (same last-occurrence / nothing-after-marker discipline as review-artifact and pipeline-attest). Prefer verification predicates over "any substring means trusted."

### Decision 2 — Prefer `pipeline-attest` on new posts; accept design-gate-state for recovery

New design-gate comment builders SHALL end with the registry path used by other engine kinds:

1. Render human-readable body + encode durable `design-gate-state`.
2. Append `pipeline-attest` last via `attestPipelineComment("design-interrogation", …)` so the attest marker is the terminal line (bodyHash binds the full prefix including the state line).

`isVerifiedPipelineOutput` SHALL return true when **either**:

- generic `pipeline-attest` verifies, **or**
- a design-gate-specific verifier accepts a terminal decodable `design-gate-state` on a design-interrogation-shaped body (stale / recovery path).

*Why not bodyHash-free trust for all pipeline-styled bodies?* That re-opens the #390 forgery / objection-language hole. The design-gate-state exception is narrow: the stage already treats that artifact as the authoritative rehydration record on crash/resume; verification reuses the same decode and terminal-marker rule. Non-decodable or non-terminal shapes fail closed.

*Order constraint:* When both markers are present, `pipeline-attest` MUST be last so attest verification remains last-occurrence / terminal. Builders that put attest before state break attest verification; tests must lock the real renderer order.

### Decision 3 — Registry membership, not ad-hoc call-site hope

Register kind `design-interrogation` in `PIPELINE_COMMENT_KINDS` with `verify: "pipeline-attest"` and heading `## Design Interrogation`. The existing behavioral drift guard (render each registered kind → verify → trusted self-exclude under `findUnacknowledgedComments`) then covers design-gate. Source-guard note: the heading does not start with `## Pipeline`, so membership is for enumeration / behavioral guard — same pattern as review-verdict and pre-merge-delta-review.

### Decision 4 — Gate change is inventory + predicate composition, not a new trust model

`findUnacknowledgedComments` continues to require:

- structural `pipeline` classification (or, as defense-in-depth for stale classification inventories, a trusted verified design-gate / pipeline body that would otherwise short-circuit as human), **and**
- trusted author, **and**
- verified output **or** no objection language.

No change to plain-ack anchors, operator-surface anchors, or `NEGATION_PATTERNS`. No new config key.

### Decision 5 — Spec surface is two capabilities

- `issue-context-snapshot` owns classification inventory, verification composition, and gate scenarios (same home as #390 / #471 / #484).
- `design-interrogation-gate` owns the posting obligation for design-gate comments (attested render path). That keeps the stage owner responsible for not shipping unattested progress comments again.

## Risks / Trade-offs

- **[Risk] Stale install / partial deploy** → Operator runs an old skill build that still posts unattested design-gate comments while the gate code expects attestation. **Mitigation:** terminal decodable `design-gate-state` recovery path remains accepted as verified; durable recovery must not re-block on that shape alone.
- **[Risk] Forged design-gate-state blob** → Anyone can paste a heading + fake marker. **Mitigation:** decode must succeed; terminal marker rule; trusted-author check still required for self-exclusion.
- **[Risk] Human text after marker** → Operator edits a design-gate comment or replies by editing. **Mitigation:** non-empty suffix after terminal marker fails verification → objection scan applies → gates.
- **[Risk] Inventory drift again for the next non-`## Pipeline:` stage comment** → **Mitigation:** registry + behavioral drift guard; this change adds design-interrogation explicitly and documents the #390-class checklist for future stage comments.
- **[Trade-off] Two verification forms for one stage** → Slightly more complex than attest-only, but required for recovery of already-posted production comments without rewriting history.

## Migration Plan

1. Land classification + registry + attest render + verification composition + tests (or confirm already-present recovery code against the new requirements and close residual gaps).
2. Regenerate `plugin/` if `core/` changes; `npm run ci` green.
3. Existing issue threads with design-gate comments: no rewrite required — terminal decodable state (and/or new attest on future posts) is enough for resume.
4. Rollback: revert the change; worst case returns to false-blocks (safe fail-closed for real human input, noisy for design-gate).

## Open Questions

- None blocking. Optional follow-up (out of scope): whether punch-list / needs-human design-gate comments share the same renderer path exclusively, or any secondary post kind needs its own registry entry — implementation MUST audit design-gate post sites and register every kind that posts.
