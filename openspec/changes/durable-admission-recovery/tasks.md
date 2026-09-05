## 1. Durable Admission Contract

- [x] 1.1 Add immutable pre-I/O admission binding and acknowledged/typed-failure result shapes to the existing generic run-store admission path; verify tests prove direct admission mints once, nested/resumed admission reuses the supplied root Logical Operation, and identity conflicts fail before protected work.
- [x] 1.2 Make the strict admission writer atomically publish and flush final `run.json` and `events.jsonl`, flush their run directory and parent runs directory, and read-back verify the complete binding; verify injected tests fail every directory-create, temporary-write, file-flush, rename, final-file-flush, directory-flush, read-back, parse, and identity-mismatch point without acknowledging the stamp.
- [x] 1.3 Remove candidate-worktree fallback for covered required admissions and require the approved canonical control-host root; verify unavailable, unapproved, and canonical-path-mismatch fixtures return typed failure and execute no protected adapter.
- [x] 1.4 Extend the existing mechanical observation adapter for admission refusal so it records the same pre-bound logical id, physical run id, entrypoint, domain, repository, issue, and known-absent side-effect certainty; verify the observation remains non-human and RecoverySupervisor-owned without minting identity.

## 2. Required Entrypoint and Nested Integration

- [x] 2.1 Route direct `pipeline single` through acknowledged admission before supervised drive and pass the admitted root identity to its child loop; verify network-free artifact tests prove distinct physical records, equal Logical Operation identity, admission-before-drive ordering, and zero drive calls after failure.
- [x] 2.2 Route direct `pipeline merge` through acknowledged admission before merge submission and bind its supervision/observation context to the admission; verify approved-root artifact/read-back success and zero merge calls plus owned failure evidence after any stamp refusal.
- [x] 2.3 Route `pipeline merge-queue --apply` through acknowledged admission after input validation but before merge or repair work while keeping dry-run read-only; verify tests prove no apply side effect begins after persistence failure and that admission grants no merge/release authority.
- [x] 2.4 Pre-bind train's outer physical and Logical Operation identities, require a durably published matching outer train session for merge mode, and persist a distinct nested `merge` artifact before each submission; verify outer `train` and nested `merge` records retain distinct run ids and one root logical id, while degraded outer or nested persistence invokes no merge and mints no replacement root.
- [x] 2.5 Build the executable admission route inventory for every `REQUIRED_PUBLIC_ENTRYPOINTS` member, direct and nested producers, resume/recovery routes, and applicable generated hosts; verify set-correspondence and behavioral tests fail missing, duplicate, unknown, name-only, and bypassing routes while generated hosts remain thin CLI delegates.

## 3. Candidate-Engine Gate Coverage

- [x] 3.1 Inventory every production candidate-engine consumer and route it through the existing `resolveAndPrepareCandidateEngine` seam; verify injected call traces prove no ship, FRG, release, recovery, or host-adapter candidate process spawns from identity-only resolution or a caller-supplied launcher.
- [x] 3.2 Add the hard correspondence test between candidate-engine consumers and the shared gate; verify it fails a consumer missing exact-SHA, approved canonical root, SHA-plus-lockfile readiness, or pre/post-bootstrap cleanliness proof, including a root that moves before spawn.

## 4. Role-Exact Implementation and Recovery Evidence

- [x] 4.1 Extend existing stage invariant/attempt observations with closed planning-versus-implementation artifact roles and exact Candidate-epoch bindings; verify parsing and contract tests reject missing, unknown, conflicting, or prior-epoch role evidence for a completing observation.
- [x] 4.2 Deepen the shared implement-deliverable observer so commits-ahead, an OpenSpec proposal, planning authorship, and planning PR state are provenance only; verify the normal implementation path and every resume/recovery caller use one exact-candidate product-postcondition predicate.
- [x] 4.3 Correct implementing re-entry so a salvaged planning-only commit invokes or schedules the implementation harness instead of entering post-implementation gates; verify a hermetic crash-recovery fixture records the implementing invocation and cannot transition directly to design-gate, review, or completion.
- [x] 4.4 Correct `publish_unpublished_stage_commit` and same-process timeout recovery to require current implementation-role proof; verify planning-only salvage/checkpoint fixtures do not push, create an implementation PR, or transition to review, while a proved implementation candidate still uses the existing gated non-force publication path.
- [x] 4.5 Extend linked-PR observation and reconciliation with artifact role and exact candidate binding; verify a hermetic reopened `pipeline:ready` fixture with an older merged planning PR stays actionable and RecoverySupervisor-owned, while a merged-and-contained exact implementation PR still prevents duplicate publication or replay.
- [x] 4.6 Apply Candidate-epoch invalidation to implementation satisfaction, tests, reviews, design/eval/shipcheck results, Decisions, authority requests/grants, and completion observations; verify movement from `E1` to `E2` requires each applicable fact to be re-proved before advancement.
- [x] 4.7 Verify admission or completion evidence gaps select only RecoverySupervisor-owned re-entry, reconstruction, cooling, external wait, or independently valid typed request outcomes; assert regression fixtures create neither ownerless terminals, false-human projections, command-local terminal shortcuts, nor a second recovery controller.

## 5. Bounded Decisions and Grill Publication

- [x] 5.1 Canonicalize newly written Decisions authority evidence to bounded summaries plus content-addressed references over the existing top-level fingerprints, required context, candidate epoch, and authority scope; verify repeated authority nodes reuse digests rather than duplicate context, dependency, or specification corpora and legacy `decisions.v1` input remains parseable until rewrite.
- [x] 5.2 Add one canonical post-render issue-body size check that preserves all evidence fingerprints and handoff bindings; verify an irreducibly oversized body returns typed failure with no truncation, body mutation, or `pipeline:ready` promotion.
- [x] 5.3 Replace duplicated grill, refine-spec compatibility, resume/migration, and handoff materialization body writers with one injected publisher using `gh issue edit --body-file -` and stdin; verify a generated body above the former argv threshold is delivered completely and no argv element contains its Markdown.
- [x] 5.4 Return a closed typed result for grill publication acknowledgement, GitHub rejection, spawn failure, stdin failure, and validation failure; verify null process status retains bounded OS diagnostics, is never rendered as success or misleading `exit null`, and leaves lifecycle ownership with RecoverySupervisor.

## 6. Collection, Hard Gates, and Repository Verification

- [x] 6.1 Verify unique-operation collection observes only qualifying approved-root direct and train-nested artifacts, aggregates physical attempts by root Logical Operation, and leaves `single`, `merge`, and `merge-queue` missing for drive-only, raw train-event, partial, invalid, or out-of-root inputs.
- [x] 6.2 Verify admission stamps contribute entrypoint presence only and cannot establish success, implementation completion, merge completion, merge/release authority, or release eligibility; run focused FRG tests proving `uniqueOperationSloFailure` remains a release-prepare hard failure for absent required coverage.
- [x] 6.3 After every `core/` edit run `node scripts/build.mjs`; at completion refresh only generator-owned host/docs artifacts and verify `node scripts/build.mjs --check`, inventory/hard-gate tests, and affected focused suites pass.
- [x] 6.4 Run `openspec validate durable-admission-recovery`, `openspec validate --all`, and the complete `npm run ci` gate; record implementation evidence against every proposal acceptance criterion and archived `stamp-required-unique-op-admissions` task before marking this change complete.
- [x] 6.5 Require settled-surface demotion to match a specific prior finding by stable key or guarded title similarity; verify a distinct high finding on the same surface remains blocking.
- [x] 6.6 Refuse automated OpenSpec archive while any explicit task remains unchecked; verify archive is never invoked and the failure names the remaining task count.
