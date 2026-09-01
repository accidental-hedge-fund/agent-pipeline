## 1. Registry, dispatch, and generated grammar

- [ ] 1.1 Add `grill` to `COMMAND_REGISTRY` with `needsIssueNumber: false` and allowed flags `issue`, `issues`, `milestone`, `label`, `dryRun`, `json`, `follow`, `resume` (plus peer `repoPath`/`base`/`profile`), and verify unknown `--bogus` exits 2 before config or GitHub writes
- [ ] 1.2 Add command-docs and `OPERATION_SURFACE` usage listing `--issue`, `--issues`, `--milestone`, `--label`, `--dry-run`, `status`, `--follow`, and `--resume` from that one metadata source, and verify `docs/cli.md` plus the four host SKILL tables publish the same grammar after `node scripts/build.mjs`
- [ ] 1.3 Dispatch `grill` and `grill status` in `pipeline.ts` without treating `status` or `--issue N` as an advance issue number, and verify a fake-driven test records zero advance-loop starts
- [ ] 1.4 Reject mixed selector forms with exit 2 and no harness or GitHub write, and verify `--issue` plus `--milestone` and `--issues` plus `--label` both fail closed

## 2. Frozen selection manifest

- [ ] 2.1 Resolve `--issue N` into a one-id frozen sorted manifest before any write, and verify closed issue N is reported ineligible with zero label writes
- [ ] 2.2 Resolve `--issues N,N,...` into a sorted unique frozen manifest, and verify duplicate ids collapse and closed members stay unlabeled
- [ ] 2.3 Resolve `--milestone M` through existing `milestone-open-issues.ts` listing, freeze membership, and verify a later milestone add does not join a resumed run
- [ ] 2.4 Resolve repeated `--label` as AND intersection of open issues, freeze membership, and verify a later label add does not join a resumed run
- [ ] 2.5 Persist a versioned manifest (selector, sorted ids, repo, time, integration-base SHA) with injected filesystem deps, and verify `--resume` reloads it without re-querying selector membership

## 3. Per-issue state machine and facts

- [ ] 3.1 Implement one per-issue state record (facts, design-tree frontier, accepted recommendations, typed requests, docs actions, ready-gate evidence) used by both `--issue` and batch, and verify a unit test reuses the same settlement function for both drivers
- [ ] 3.2 Fetch live title/body/labels immediately before evaluation and gather facts from trusted base, forge, config, and declared dependencies, and verify a stale-fixture test is not used as the evaluated text
- [ ] 3.3 Walk declared dependencies through existing `parseDeclaredDependencyIds` and `walkDeclaredDependencyClosure`, and verify cycle, missing/inaccessible, malformed, and closure-exhaustion facts fail ready with no silent truncate
- [ ] 3.4 Order batch work by declared dependencies, isolate per-issue failure, and continue independent peers, and verify a sibling failure does not stop a proven-independent issue
- [ ] 3.5 Persist grill-run identity and per-issue state with loop-store-style injected I/O (atomic write, exclusive create) without importing the loop supervisor, and verify unit tests perform no real filesystem except through fakes

## 4. Auto-settle, typed requests, and body writes

- [ ] 4.1 Extend `SettledBy` with `auto-accept` and keep `decisions.v1` parse/render/fence identity, and verify render divergence still fails ready
- [ ] 4.2 Auto-settle recommendations that are reversible, in scope, policy-consistent, and covered by existing authority with `settled-by: auto-accept`, and verify no handoff is created for that node
- [ ] 4.3 Treat low model confidence as non-blocking when the auto-settle predicate holds, and verify the node still settles without a typed request
- [ ] 4.4 Emit `DecisionRequest` for contradictory product requirements, map to existing `product_judgment` handoff, and verify the issue pauses while independent issues continue
- [ ] 4.5 Emit `CapabilityRequest` for missing external ability or information, map to `missing_context`, and verify discoverable repo/forge/config facts never become this request
- [ ] 4.6 Emit `AuthorityRequest` for protected actions without existing authority (`security`/`irreversible-operations` → `risk_authority`; `scope`/`merge-release`/`human-attestation` → `product_judgment`), and verify auto-accept never grants merge, release, destructive, or security authority
- [ ] 4.7 Create pending typed-request handoffs idempotently on `declaration_identity` before the body write, reuse `pipeline handoff answer` materialize, and verify comments still do not settle nodes
- [ ] 4.8 Write the Decisions artifact plus derived `## Decisions` section and persist the engine-produced authenticated frontier on grill body writes, and verify ready validation still requires that frontier

## 5. Domain documentation PR

- [ ] 5.1 Classify CONTEXT proposals required vs advisory from the integration-base blob and `term_id`s (ignore model necessity prose), and verify advisory proposals do not block ready
- [ ] 5.2 Write new glossary terms to `CONTEXT.md` and qualifying ADRs through a dedicated worktree and PR using the intake/sweep pattern, and verify no direct write to the integration branch
- [ ] 5.3 Deduplicate identical term/ADR payloads across a batch into one PR, and verify two issues settling the same term open one PR
- [ ] 5.4 Leave required-docs issues waiting until trusted-base hashes match, resume after containment, and verify promotion from a stale base is refused

## 6. Ready promotion, dry-run, status, follow

- [ ] 6.1 Call existing `validateDecisionsForReady` then the triage label-reconciliation sequence (add `pipeline:ready` first, remove others, re-fetch, one retry, `label_reconciliation_failed` keeps ready), and verify grill does not invent a second label writer
- [ ] 6.2 Keep pickup on the shared #1238 gate after grill-promoted ready, and verify a fake pickup still evaluates the fresh body
- [ ] 6.3 Guarantee grill never calls merge, merge-queue apply, train --merge, or ship, and verify a fake call log is empty for those commands
- [ ] 6.4 Implement `--dry-run` that reports frozen manifest, inferred decisions, typed requests, docs actions, and ready eligibility with zero mutations, and verify GitHub and git write fakes are unused
- [ ] 6.5 Implement `grill status --run-id` counts (selected, migrated, waiting, ready, failed) plus per-issue evidence, and verify `--follow` ends on terminal batch status
- [ ] 6.6 Implement `--resume <run-id>` against the frozen manifest, and verify selector membership is not re-queried

## 7. Migration of #1316 and grill-with-docs markers

- [ ] 7.1 Parse `decisions.v1` artifacts, HMAC frontiers, pending grill-authority handoffs, `grill-proposal.v1` envelopes, and `grill-with-docs:v1.40.1` markers, and verify a fixture with the v1.40.1 marker is recognized
- [ ] 7.2 Re-gather facts and reject stale recommendations rather than trusting a marker, and verify a changed fact invalidates the stored recommendation
- [ ] 7.3 Make replay idempotent so a second `pipeline grill --issue N` does not duplicate body edits, docs PRs, handoffs, or label transitions, and verify the fake write log stays at one of each
- [ ] 7.4 Keep `refine-spec --title/--body` non-mutating and Desk-compatible, and verify existing refine-spec stdout `{ title, body, milestone }` tests still pass
- [ ] 7.5 Convert `refine-spec --issue` / `apply` into compatibility shims that diagnose toward `pipeline grill --issue N` and do not apply already-migrated envelopes, and verify a migrated issue is not rewritten by apply
- [ ] 7.6 After replacement coverage, remove obsolete operator-facing envelope/apply controller code while keeping Decisions parse/render, taxonomy, facts, fingerprints, ready validator, and engine frontier, and verify no living spec still requires signed-envelope admission

## 8. Docs, glossary, packaging, and CI

- [ ] 8.1 Rewrite `docs/adr/0002-decisions-live-in-the-issue-body.md` so `pipeline grill` is the writer, auto-accept is in-scope provenance, docs PRs are allowed, and #1238 comments are not the spec, and verify the ADR no longer forbids repository-document writes or names refine-spec as the grill
- [ ] 8.2 Update root `CONTEXT.md` glossary for Grill, Decisions, Authority node, auto-accept, and typed requests without turning the file into implementation steps, and verify reviewer-accept remains historical provenance only
- [ ] 8.3 After any `core/` edit run `node scripts/build.mjs` and commit regenerated SKILL overlay in the same change, and verify `node scripts/build.mjs --check` passes
- [ ] 8.4 Run `openspec validate native-grill-with-docs-admission` and `npm run ci` from the repo root, and verify both exit 0
- [ ] 8.5 Dogfood `pipeline grill --milestone v1.40.1` and capture a batch report with selected, migrated, waiting, ready, and failed counts plus per-issue evidence
