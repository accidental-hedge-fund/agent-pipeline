## Context

The pre-merge stage runs three sequential sub-steps: docs → CI → mergeability. The docs sub-step (`updateDocs`) invokes the implementer harness against the finished PR diff, commits any documentation changes under a `docs: update documentation for #N` prefix, pushes, then returns `waiting` — forcing the CI system to re-run. Because the review-SHA gate exempts commits with that prefix, reviewers never see the docs changes. A second CI cycle adds up to `ci_timeout` seconds (900 s) to every happy-path run, every time.

## Goals / Non-Goals

**Goals:**
- Docs instruction folded into the implementing prompt so docs land inside the reviewed diff.
- Happy path traverses exactly one CI cycle (PR open → CI passes → mergeability → terminal).
- `steps.docs` key retained in `PipelineConfig` and pipeline.yml schema with resemanticised meaning.
- `DOCS_COMMIT_PREFIX` / docs-only gate code deleted (no dead code left behind).
- `pre-merge-docs.test.ts` replaced with a test that asserts the single-CI-cycle property.

**Non-Goals:**
- Fix-round prompts asking for doc updates on doc-relevant fixes (separate issue).
- Changing the OpenSpec archive step (stays as-is, still triggers a waiting cycle).
- Retroactively re-reviewing PRs that already landed docs commits via the old path.

## Decisions

### 1. Inject docs instruction as a conditional section in `implementing.md`

The implementing prompt template gains a `{{docs_instruction}}` placeholder. When `cfg.steps.docs` is `true`, `buildImplementingPrompt` substitutes a paragraph instructing the implementer to update affected documentation files (README, CLAUDE.md, config docs, etc.) in the same change. When `false`, the placeholder is substituted with an empty string, leaving no trace in the rendered prompt.

**Alternatives considered:**
- A second template file that wraps `implementing.md` — rejected: two templates for one step adds indirection with no benefit.
- Always include the docs instruction regardless of `steps.docs` — rejected: the `steps.docs` toggle must be honoured, and some repos opt out for good reason.

### 2. `steps.docs` resemanticised, not removed

Removing the key would break existing `.github/pipeline.yml` files that set `steps: { docs: false }`. The key stays; its config comment is updated from "docs-update pass in pre-merge" to "include docs instruction in implementing prompt". The strict schema continues to accept or reject the key as before.

### 3. `DOCS_COMMIT_PREFIX` and the docs-only gate deleted entirely

After this change no pipeline code path produces `docs: update documentation for #N` commits, so `DOCS_COMMIT_PREFIX`, `docsAlreadyUpdated`, `updateDocs`, `enforceDocsOnlyGate`, `enforceDocsCommitMessageGate`, and the docs branch of `isPipelineInternalCommit` are all dead. Leaving dead code risks future readers inferring invariants that no longer hold. Delete all of it.

### 4. `pre-merge-docs.test.ts` replaced with a CI-cycle-count test

The existing test file covers the docs-only file-constraint gate and commit-message gate — both deleted. The replacement test:
- Asserts that `advance()` reaches terminal in one "waiting" cycle by verifying no docs-push `waiting` return is emitted on the happy path.
- Covers the narrowed `isPipelineInternalCommit` (only openspec-archive prefix matches; docs prefix no longer matches).

## Risks / Trade-offs

- **Docs quality** — The dedicated docs pass had an isolated focus (diff only, no code changes). The implementing harness sees the full issue and may deprioritize docs under time or context pressure. → Mitigation: the docs instruction is explicit and prominent in the prompt; implementers that skip it produce a reviewable diff that humans can flag. Net safety is higher than the old path (docs now reviewed).
- **Test coverage gap** — Deleting `pre-merge-docs.test.ts` removes regression coverage for the docs-only and commit-message gates. → Mitigation: those gates are deleted; the tests would be testing removed code. New test covers the observable property (single CI cycle) instead.
- **Plugin mirror drift** — `plugin/` mirrors `core/` scripts. After the deletion the plugin must be regenerated. → Mitigation: tracked as an explicit task; CI fails on mirror drift.
