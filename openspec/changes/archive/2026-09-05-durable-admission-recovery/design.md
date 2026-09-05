## Context

See `proposal.md` for motivation and the delta specs for normative behavior.

The first holding rungs already exist:

- `persistPublicEntrypointAdmission` writes the generic run-store shape consumed by unique-operation collection, while `initRunDir` intentionally swallows telemetry failures. Direct merge and merge-queue call the helper; direct single and train-nested merge still lack equivalent proven paths.
- `REQUIRED_PUBLIC_ENTRYPOINTS`, the unique-operation collector, `uniqueOperationSloFailure`, and RecoverySupervisor observation adapters already define the coverage and lifecycle surfaces. No second ledger or controller is needed.
- `resolveAndPrepareCandidateEngine` already proves the exact canonical candidate root, nested-core readiness, and cleanliness. Its current production callers are ship, hybrid-v2 collection, and the standalone resolve-and-prepare surface; missing future consumers need a correspondence guard.
- `DeliveryStageInvariant`, stage-attempt ledgers, Candidate epochs, `dispatchResume`, `publish_unpublished_stage_commit`, and loop reconciliation already own implementation recovery. The defect is evidence typing: commits-ahead and an OpenSpec proposal are currently accepted as an “implement deliverable,” while reconciliation selects any merged linked PR before considering artifact role or the reopened actionable stage.
- Grill already has canonical fingerprints and one injectable issue-body update seam, but production body writes pass Markdown as `--body <text>`. The installed `gh` CLI confirms `gh issue edit --body-file -` reads the body from stdin.

The living `operation-reliability` spec contains an older allowance to continue when the factory-control root is unknown, while the later archived contract requires protected work to fail closed. This change follows the explicit #1454 and archived-contract authority: the fail-closed rule supersedes that allowance.

## Goals / Non-Goals

**Goals:**

- Complete the archived admission work on the existing generic store and prove it at every required execution route.
- Make stage completion evidence role-exact and Candidate-epoch-exact so planning provenance cannot become implementation completion.
- Keep every inconclusive recovery under the existing RecoverySupervisor lifecycle.
- Bound Decisions size and eliminate large generated bodies from process argv.

**Non-Goals:**

- A new run store, success ledger, recovery controller, candidate bootstrapper, host engine, or public command.
- A #1452-specific branch or a general rule that every merged linked PR completes an issue.
- Replaying or fabricating commands to populate Factory Reliability Gate coverage.
- Changing merge/release authority, enabling auto-merge, or allowing advance, loop, or single to merge.
- Making all best-effort telemetry writes control-critical.

## Decisions

### D1 — Finish the archived strict admission contract on the generic run store

Keep `persistPublicEntrypointAdmission` as the shared contract, but split pre-I/O binding from publication as designed by the archived change. Binding fixes the public entrypoint, physical `runId`, root `logicalOperationId`, domain, repository, optional issue, and approved canonical control root before any write. A direct admission mints the root identity once; nested and resumed admissions must supply their existing root identity and cannot mint a replacement.

The acknowledged writer reuses the generic `run.json` and `events.jsonl` schemas and layout but does not reuse `initRunDir`'s error-swallowing behavior. Through an injected durability seam it writes same-directory temporary files, flushes them, atomically renames them, flushes final files, flushes the run directory and parent runs directory, then reads both files back. Acknowledgement requires equality of run id, logical id, entrypoint, run kind, domain/repository binding, and canonical approved root. Every failure returns one typed result carrying the original binding.

The direct single, merge, merge-queue apply, and train-nested merge adapters consume only an acknowledged result. Single passes the root identity to its child loop. Train retains a distinct outer `train` physical record and writes a distinct `merge` physical record with the same root identity before each submission. Dry-run merge-queue remains read-only.

Alternative considered: make `initRunDir` strict for every caller. Rejected because its broader telemetry contract is deliberately best effort.

Alternative considered: add a unique-operation stamp ledger. Rejected because the existing generic artifact is already the collector's source.

### D2 — Extend the existing admission inventory into an executable route matrix

Keep the inventory adjacent to `REQUIRED_PUBLIC_ENTRYPOINTS` and compare independent sets so an omission cannot be hidden by deriving one from the other. Each entrypoint lists its direct producer and all applicable nested, resume/recovery, and generated-host routes. Each route is exercised through injected admission and protected-operation seams; a string declaration or source scan is insufficient. Set equality rejects missing, duplicate, and unknown entries, while behavioral tests prove ordering, approved root, identity propagation, and zero protected calls after refusal.

Candidate-engine consumers use the same pattern: the route matrix declares every place that can execute candidate code and behaviorally proves the returned launcher came from `resolveAndPrepareCandidateEngine` for the requested SHA. This extends the current gate rather than adding a bootstrap layer.

Alternative considered: source regexes over helper names. Rejected because a named helper can still be bypassed at runtime.

### D3 — Represent planning and implementation as role-typed evidence on existing stage records

Extend the existing stage invariant/attempt observation shapes with a closed artifact role and binding, rather than creating a new completion database. Planning evidence binds the accepted planning artifact identity and its originating candidate/commit. Implementation evidence binds the product implementation postcondition to the exact current HEAD Candidate epoch. The implementing observer must prove the issue's required product delta or an explicitly declared implementation no-op goal; a changed OpenSpec proposal, commit-ahead fact, pipeline authorship trailer, or PR alone is not that proof.

`dispatchResume` and `publish_unpublished_stage_commit` consult this shared observer. They may skip another implementation invocation only when the current Candidate epoch already has authoritative implementation-role proof and required cleanliness/gates pass. A planning-only salvage remains valuable provenance but selects implementation re-entry, not post-implementation publication.

The existing `createDefaultImplementDeliverableProbe` is the seam to deepen. Its current “branch-introduced OpenSpec proposal exists” predicate becomes a planning-artifact observer, while implementation satisfaction moves to the same stage-goal contract used after a normal implementation round. Recovery, same-process timeout, `recover-parked`, and ordinary re-entry use that one predicate.

Alternative considered: special-case OpenSpec change `stamp-required-unique-op-admissions` or issue #1452. Rejected because the next planning-only recovery would repeat the defect.

Alternative considered: infer implementation from any commits ahead of base. Rejected because planning and checkpoint commits are deliberately ahead of base.

### D4 — Make linked-PR reconciliation artifact-role and stage aware

Extend the existing linked-PR observation fact with an authoritative role/candidate binding obtained from pipeline-owned stage evidence and exact git/forge identity. `selectAuthoritativeLinkedPr` may select merged integration proof only for the operation being reconciled. A merged planning PR records planning integration, not implementation integration. Unknown or conflicting role stays `uncertain`.

`verifiedForwardTarget` first honors the live issue's current actionable stage. An open issue at `pipeline:ready` or a mid-flight delivery stage cannot move to loop state `merged` from a planning-role PR. If exact implementation completion is absent, reconciliation reconstructs or keeps the item dispatchable and RecoverySupervisor continues ownership. A merged-and-contained implementation PR still prevents duplicate publication or replay.

Alternative considered: retain “any linked merged PR wins” and add a reopened-issue exception. Rejected because it encodes the incident site instead of the planning-versus-implementation class.

### D5 — Use Candidate epoch as the invalidation boundary for all candidate-bound facts

Continue using normalized HEAD SHA as the Candidate epoch in issue-stage adapters and stage-attempt ledgers. When HEAD changes, invalidate implementation satisfaction, test results, review verdicts, design/eval/shipcheck results, completion observations, Decision bindings, AuthorityRequests, and grants. Planning provenance may remain linked to its own artifact identity but cannot be relabeled as current implementation proof.

RecoverySupervisor reconciles after candidate movement and chooses re-entry, reconstruction, cooling, external wait, or an independently valid typed request. Recipes and process exit never set completion. No adapter-local terminal or second retry policy is introduced.

### D6 — Compact Decisions by referencing the canonical fingerprint corpus

Reuse the top-level `GrillFingerprint`, `required_context`, node input digests, and handoff bindings. Newly written authority evidence stores bounded human-readable evidence plus content-addressed references to the canonical context, dependency closure, specification core, candidate epoch, question, recommendation, and authority scope. Repeated nodes share these digests rather than embedding the full corpora. Parsing remains backward-compatible for existing `decisions.v1` bodies, while the next grill rewrite canonicalizes them to the bounded representation.

A central issue-body byte/character limit check runs after canonical render and before publication or ready promotion. It never truncates digest or handoff fields. An irreducibly oversized body becomes a typed validation failure.

Alternative considered: truncate every node's evidence strings. Rejected because unstructured truncation can remove the evidence or binding that makes a protected request verifiable.

### D7 — Send all grill body mutations through one stdin-backed publisher

Replace the duplicated production `updateIssueBody` implementations in grill apply, compatibility refine-spec, and handoff materialization with one injected publisher. Production invokes `gh issue edit <N> -R <repo> --body-file -`, passes the complete Markdown as stdin, and captures bounded stdout/stderr. Tests inspect argv and stdin separately and include a body larger than the former argv threshold.

The publisher returns a closed result union such as acknowledged, GitHub rejection, spawn failure, stdin failure, or validation failure. Null `spawnSync.status` is handled before numeric-exit rendering and carries the OS error code/message when present. Callers report the typed mechanical observation and preserve RecoverySupervisor ownership; only acknowledged publication proceeds to body-hash re-fetch and ready-label work.

Alternative considered: write a temporary body file. Supported by the spec, but stdin avoids cleanup and secret-bearing residual files while using the CLI's documented `--body-file -` surface.

### D8 — Keep collection and release gating evidence-only

The existing collector continues to map qualifying approved-root artifacts to observed entrypoints and aggregate by root Logical Operation. Admission adds presence, not success. Numeric drive never becomes single; raw train merge events never replace a nested merge artifact; multiple physical records under one logical id count once for success. `uniqueOperationSloFailure` remains in release preparation as a hard failure. Historical failed evidence is not rewritten; only later real authorized operations can produce new evidence.

## Risks / Trade-offs

- **[Risk] Strict fsync/read-back admission makes a previously tolerated telemetry outage block protected work.** → Limit strictness to required admissions, return typed mechanical evidence, and keep general telemetry best effort.
- **[Risk] Role classification for old PRs lacks enough evidence.** → Treat it as uncertain and retain ownership; do not guess implementation from title, labels, or merge state.
- **[Risk] An implementation no-op can be confused with a planning-only change.** → Require the declared stage goal and exact-candidate observer, not an empty range or generic OpenSpec presence.
- **[Risk] Candidate movement causes more re-review and retesting.** → This is intentional invalidation; reuse only evidence whose binding still matches the new epoch.
- **[Risk] Compact Decisions migration changes canonical hashes.** → Recompute the canonical body/frontier and rebind pending handoffs through the existing post-write recovery sequence; never accept a pre-migration hash after rewrite.
- **[Risk] A publication succeeds remotely but the local process loses its result.** → Preserve the existing re-fetch/body-hash reconciliation before retry; the non-argv transport changes delivery, not side-effect certainty rules.
- **[Risk] Inventory rows become stale as hosts are regenerated.** → Generate host surfaces from the CLI contract and make inventory/host correspondence part of the same hard CI gate.

## Migration Plan

1. Land the strict admission binding/writer, failure adapter, inventory, and archived direct/nested integrations with hermetic durability and ordering tests.
2. Route every current candidate-engine consumer through the inventory-backed shared resolve-and-prepare assertion.
3. Add role-typed stage evidence, update implementing resume/publication, and update linked-PR reconciliation with the planning-only and reopened-actionable regressions.
4. Add Candidate-epoch invalidation checks across implementation, gates, decisions, and authority evidence.
5. Canonicalize newly written Decisions evidence and move every grill body writer to the shared stdin publisher with size and null-status regressions.
6. Regenerate only generator-owned host/docs artifacts, run focused tests, `node scripts/build.mjs`, `openspec validate --all`, and `npm run ci`.
7. Use ordinary authorized operations to gather later FRG evidence. Do not replay, merge, release, or fabricate work solely to backfill coverage.

Rollback is a code rollback. Additive run artifacts and compact Decisions remain parseable evidence and grant no authority. A rollback must not rewrite historical operation outcomes.
