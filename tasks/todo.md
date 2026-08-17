# #1099 Revised plan — needs-human only for operator scope-change text

## Status
- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation (do not start until this revised plan is accepted)

## Locked decisions (post-review)

1. One exported classifier + one exported gate applicator. Both `fix.ts` and `review-routing.ts` consume the applicator. They do not call `findUnacknowledgedComments` alone.
2. Three dispositions only. Untrusted free-form (including a neutral “LGTM”) is `operator-scope-change`.
3. Deterministic recognizers only. No LLM. No “reads as operator-authored.”
4. Heading + terminal artifact requires a recognized heading, a last-occurrence marker line, syntactic decode, and only whitespace after the last marker. Hash match is not required.
5. Recover for `ambiguous-trusted` is an in-engine stage transition to `planning`. Fallback block uses `harness-failure`, never `needs-human`.
6. Reuse `PIPELINE_COMMENT_KINDS`, `extractReviewArtifact`, `extractPipelineAttestation`, and `buildTrustedOverrideComments`. Do not add call-site regexes.
7. Do not edit the #1098 hash-after-banner bind.
8. OpenSpec change `openspec/changes/ack-gate-needs-human-only-for-operator-text/` is an implementation deliverable. Patch it in place to match these locks.

See the chat revised implementation plan for the full Approach, API, recognizers, call-site routing, tests, and acceptance criteria.
