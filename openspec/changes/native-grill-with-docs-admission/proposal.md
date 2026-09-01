## Why

PR #1316 / #1072 shipped a single-issue Implementer → Reviewer signed-envelope protocol. It cannot select a batch, treats broad authority classes as mandatory handoffs even when a recommendation is inferable, forbids repository domain-document writes, and requires a separate ready command. The installed grill-with-docs skill is host-local and interactive, so it cannot be a runtime dependency of the pipeline CLI. Routine backlog admission needs one native, versioned grill-with-docs-to-ready operation.

## What Changes

- Add `pipeline grill` as the canonical admission operation: select open issues, gather repository and GitHub facts, walk each issue design tree in dependency rounds, auto-settle evidence-backed recommendations that stay inside existing scope and authority, record the sharpened specification and domain documentation, and request `pipeline:ready` when deterministic admission checks pass.
- Support exactly one selector per invocation: `--issue N`, `--issues N,N,...`, `--milestone M`, or one or more `--label L` filters (AND intersection). Resolve selection once into a frozen, sorted, versioned manifest before the first write.
- Ask an operator only for an irreducible `DecisionRequest`, a `CapabilityRequest` that needs supplied input, or a protected `AuthorityRequest`. Low model confidence alone is not a human boundary. Auto-accept never grants merge, release, destructive, security, or other protected authority.
- Write newly settled project-specific vocabulary to `CONTEXT.md` and write a concise ADR for a qualifying hard-to-reverse trade-off. Repository-document writes use a dedicated worktree and PR. They never write the integration branch. Required documentation waits for trusted-base integration. Advisory documentation does not block admission.
- Promote eligible issues to `pipeline:ready` inside the same durable operation after the existing model-free ready validator passes. Pickup still runs the independent #1238 implementation-readiness gate. The operation never merges or deploys.
- **BREAKING** (after replacement coverage): retire `pipeline refine-spec --issue` / `apply` as the intake controller. Keep `pipeline refine-spec --title/--body` as the non-mutating Desk preview. Migrate or intentionally invalidate existing #1316 envelopes, host-local frontiers, and `grill-with-docs:v1.40.1` markers with actionable diagnostics. Replay MUST NOT duplicate body edits, doc PRs, handoffs, or label transitions.

## Capabilities

### New Capabilities

- `grill-with-docs-admission`: native CLI operation, selector contract, frozen manifest, shared per-issue state machine, auto-settle and typed-request semantics, domain-document PR path, ready promotion, batch isolation, dry-run, resume/status/follow, and #1316 / `grill-with-docs:v1.40.1` migration.

### Modified Capabilities

- `grill-then-ready-refinement`: stop treating signed-envelope preview/apply as the intake controller; keep the Decisions artifact, fingerprints, taxonomy, dependency walker, and model-free ready validator; replace “never write repository files” and “always hand off operator-required classes” with the new auto-settle, typed-request, and docs-PR rules; point ADR 0002 and the glossary at `pipeline grill`.
- `refine-spec-preview`: keep `--title/--body` as a non-mutating preview; after migration, `--issue` / `apply` are not a second admission controller.
- `triage-sub-command`: `pipeline grill` may invoke the same `--stage ready` validator and label-reconciliation path; the gate stays model-free and is not a #1238 bypass.
- `command-registry`: register `grill` with selector, dry-run, status, follow, and resume flags. Publish the selector grammar from that registry plus co-located docs metadata (coordinate with #1355; do not add a second grammar module).
- `pipeline-state-machine`: recognize `grill` as a no-issue-number keyword; grill may write `pipeline:ready` only through the existing ready gate; grill never merges or deploys.
- `human-question-handoff`: typed grill requests reuse the existing handoff ledger and `pipeline handoff answer`. Do not create a second answer ledger. Do not auto-create a handoff for every operator-required taxonomy class when existing authority already covers the recommendation.
- `issue-implementation-readiness-gate`: a grill-promoted `pipeline:ready` label still hits the shared pickup-time gate.
- `generated-cli-reference`: generated `docs/cli.md` and host SKILL tables expose the grill selector grammar from the same registry/docs/OPERATION_SURFACE source as other verbs.

## Impact

- **CLI:** new `core/scripts/stages/grill.ts` (or equivalent dedicated handler) plus thin `pipeline.ts` dispatch. Register in `command-registry.ts`, `command-docs.ts`, and `OPERATION_SURFACE`. Do not split `pipeline.ts` (#990). Do not shell out to a host Skill tool or mattpocock/skills.
- **Reuse:** `grill-decisions.ts`, `grill-facts.ts`, `grill-fingerprint.ts`, `grill-taxonomy.ts`, `grill-ready.ts`, `declared-dependency-grammar.ts`, `milestone-open-issues.ts`, `human-question-handoff.ts`, `worktree.ts`, and the intake/sweep docs-PR pattern. Do not invent a second dependency parser, ready validator, answer ledger, or loop scheduler.
- **GitHub writes:** issue body (Decisions artifact + rendered section), typed-request handoffs when required, one docs PR per batch when domain documents change, and `pipeline:ready` label reconciliation. Never write `main`. Never merge or deploy.
- **Docs:** rewrite `docs/adr/0002-decisions-live-in-the-issue-body.md` and the root `CONTEXT.md` Grill / Decisions / Authority-node / reviewer-accept glossary so they name `pipeline grill` and the new auto-settle rules.
- **Tests:** injected GitHub, repository, model, clock, and filesystem seams. No real network, git, or subprocess in unit tests.
- **Packaging:** `node scripts/build.mjs` after `core/` edits. `npm run ci` must pass.

## Acceptance Criteria

- [ ] `pipeline grill` accepts exactly one of `--issue N`, `--issues N,N,...`, `--milestone M`, or one or more `--label L`, plus `--dry-run` and resumable status/follow/resume, and rejects mixed selectors with a usage error.
- [ ] Single-issue and batch runs share one per-issue state machine and the same auto-settle / typed-request rules.
- [ ] Selection is frozen into a versioned sorted manifest before the first write; later milestone or label drift does not add or drop members of a running batch.
- [ ] Closed issues are reported as ineligible and are never relabeled.
- [ ] Each selected issue records facts, the current design-tree frontier, accepted recommendations, unresolved typed requests, documentation actions, and ready-gate evidence.
- [ ] Models never ask the operator for a fact that the repository, forge, configuration, or declared dependencies already provide.
- [ ] Evidence-backed recommendations that are reversible, in scope, policy-consistent, and covered by existing authority auto-settle without an operator round-trip.
- [ ] Low model confidence alone does not pause an issue.
- [ ] Only an irreducible `DecisionRequest`, a `CapabilityRequest` that needs supplied input, or a protected `AuthorityRequest` pauses that issue; independent issues continue.
- [ ] Auto-accept never grants merge, release, destructive, security, or other protected authority.
- [ ] Settled decisions are written into the GitHub issue body with stable provenance. Comments are not the specification.
- [ ] New project-specific vocabulary updates `CONTEXT.md`. A qualifying hard-to-reverse trade-off creates a concise ADR. Those writes use a dedicated worktree and PR, are deduplicated across the batch, and never land directly on the integration branch.
- [ ] Required documentation waits until the trusted integration base contains the change. Advisory documentation does not block admission. No issue is promoted from a stale base.
- [ ] Eligible issues are promoted to `pipeline:ready` inside the same operation after the existing model-free ready validator passes, and they carry exactly one `pipeline:*` stage label.
- [ ] The next pickup still runs the #1238 implementation-readiness gate against fresh GitHub state.
- [ ] The operation never merges or deploys.
- [ ] Existing #1316 envelopes / frontiers / handoffs and `grill-with-docs:v1.40.1` markers are migrated or intentionally invalidated with actionable diagnostics. Replay does not duplicate body edits, doc PRs, handoffs, or label transitions.
- [ ] Registry, `--help`, generated CLI reference, and host SKILL tables expose the selector grammar from one source of truth.
- [ ] Unit tests cover one issue, explicit list, milestone, repeated-label intersection, selection drift, dependency ordering, auto-accept, each typed request, shared docs deduplication, resume, partial batch failure, stale inputs, and ready-label reconciliation.
- [ ] Living specs and ADR 0002 no longer require single-issue-only grill or forbid repository-document writes.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.
- [ ] First production run against `--milestone v1.40.1` produces a batch report with selected, migrated, waiting, ready, and failed counts plus per-issue evidence.
