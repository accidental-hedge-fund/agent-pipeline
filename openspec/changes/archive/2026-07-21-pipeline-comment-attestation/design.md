## Context

`findUnacknowledgedComments` (`core/scripts/issue-context-snapshot.ts`) counts a comment posted after the plan anchor as human input unless it is (a) classified `pipeline` by `classifyComment`, (b) authored by a trusted actor, and (c) either free of `NEGATION_PATTERNS` language **or** verified, untampered review output per `isVerifiedPipelineReviewOutput`.

Clause (c)'s verified branch exists because genuine review verdicts routinely use objection wording in finding text. It is implemented only for the review-verdict comment, whose `<!-- review-artifact: … -->` footer carries a `bodyHash` binding the exact rendered prefix. Every other pipeline comment type relies on the fragile "carries no objection language" branch — a latent trap that #471 sprang: `advisoryAdvanceComment` says "advances **instead** of routing to a fix round", matching `/\binstead\b/i`.

## Goals / Non-Goals

Goals:
- Any pipeline-posted comment can prove it is untampered pipeline output, using the same forgery-resistance properties as the review artifact.
- Membership in the contract is enumerable and drift-guarded, so the #471 recurrence mode (new comment type silently outside the contract) fails a test rather than a production run.

Non-Goals:
- Loosening `NEGATION_PATTERNS`, or trusting a pipeline-styled body that does not verify.
- A cryptographic signature / shared secret. `bodyHash` is not a signature; it is tamper-evidence over a body whose author is *separately* trust-checked. Adding a secret is out of scope (and would need key distribution the skill has no home for).
- Retrofitting attestations onto comments already posted in live threads.

## Decisions

### Decision 1 — Generic attestation marker, not "add another heading to an allowlist"

Add `<!-- pipeline-attest: <base64url(JSON)> -->` as a footer line, payload `{ kind, bodyHash }` where `bodyHash = sha256(body-text-preceding-the-marker-line)`. Verification mirrors `isVerifiedPipelineReviewOutput` exactly: last-occurrence-wins, nothing may follow the marker line, and the recomputed hash must match.

*Why not a heading allowlist?* An allowlist of headings is exactly what the gate already has via `classifyComment`, and it is forgeable by copying the heading. The recurrence class in #471 is "pipeline output whose wording looks like an objection"; only a body-binding artifact distinguishes real output from a heading plus human prose.

*Why a second marker instead of reusing `review-artifact`?* `ReviewArtifact` is a strongly-typed review record (`round`, `reviewedSha`, `diffHash`, `blockingKeys`, `review1Risk`) consumed by the SHA gate and verdict cache. Stuffing non-review comments into it would force meaningless field values and risk them being mistaken for verdicts by `extractReviewArtifact` consumers (e.g. `review-sha-gating`, `verdict-diff-cache`). Two markers, one verifier: `isVerifiedPipelineOutput(body)` returns true when either the review artifact verifies or the attestation verifies.

### Decision 2 — Single-sourced registry + an attesting post helper

Export one registry (`PIPELINE_COMMENT_KINDS`) naming every comment type the engine posts, and route pipeline comment posts through a helper that appends the attestation for the given kind. The registry is the drift-guard's enumeration source and the `kind` vocabulary.

Two guards, because each alone is insufficient:
1. **Behavioral guard** — for each registry entry, render a representative body and assert `isVerifiedPipelineOutput(body)` **and** that `findUnacknowledgedComments` returns `[]` for a trusted author posting it after the plan anchor. Catches an entry that is registered but not actually attested.
2. **Source guard** — scan `core/scripts/**` for pipeline comment heading literals (`## Pipeline…`, `## Pipeline Complete`, `## Pre-Planning Context`, …) and fail on any not represented in the registry. Catches a new comment type that never joined the registry at all.

The source guard is a text scan, which is coarse; it is accepted deliberately because the failure it prevents (silent factory stall) costs far more than an occasional false positive, and an allowlist of intentionally-unregistered literals keeps it maintainable.

### Decision 3 — Gate change is one predicate swap; no new trust

`findUnacknowledgedComments` replaces `isVerifiedPipelineReviewOutput(c.body)` with `isVerifiedPipelineOutput(c.body)`. All other conditions — `classifyComment === 'pipeline'`, membership in `trustedComments`, the `NEGATION_PATTERNS` scan for unverified bodies — are unchanged. Consequences preserved from #390:
- Attested body + untrusted author → still counted (trust is checked first).
- Attested body + appended human text → verification fails → objection scan applies → counted.
- Unattested legacy comment with objection wording → gates once; a plain trusted acknowledgement clears it permanently via the existing anchor branch. No legacy bypass path is introduced.

### Decision 4 — Attestation participates in `classifyComment`

The attestation marker joins the pipeline machine-sentinel marker set so an attested comment is structurally `pipeline` regardless of its heading. This keeps a future comment type from needing a heading change to be classified, and matches how `<!-- pipeline-audit:` is already treated.

## Risks / Trade-offs

- **Marker is copyable.** Anyone can copy an attested body verbatim and repost it. This grants nothing: the copy still fails the trusted-author check. Verbatim reposting by the trusted actor is indistinguishable from the original by design — accepted, same as #390.
- **Comment bodies grow by one hidden line.** Negligible; hidden in rendered Markdown.
- **Source-scan guard false positives** (a heading literal in a comment/docstring). Mitigated with an explicit allowlist; keep it short and justify each entry.
- **Attestations must be appended last.** Any builder that appends after `cfgFooter` would break verification; the attesting helper is the last step of posting, and the behavioral guard catches violations per type.
