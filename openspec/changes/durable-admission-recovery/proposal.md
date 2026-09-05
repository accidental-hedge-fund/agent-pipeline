## Why

The archived `stamp-required-unique-op-admissions` contract is normative but its implementation tasks remain incomplete, so required operations can be acknowledged without crash-durable proof in an approved root. The same evidence gap allowed a salvaged planning-only commit and an older merged planning PR to masquerade as completed implementation, leaving recovery able to skip the implementation harness or terminate work that is still unfinished.

## What Changes

- Implement every unchecked task and acceptance criterion in the archived `stamp-required-unique-op-admissions` change through the existing generic run store, Logical Operation identity, operation-observation adapters, collector, and Factory Reliability Gate.
- Make the required-operation inventory enumerate and behaviorally exercise public, nested, resume/recovery, and applicable host-adapter admission paths. Missing producers, bypasses, or unstamped paths fail the repository hard gate.
- Require every covered admission to bind one immutable Logical Operation and persist a verifiable operation-and-approved-root stamp before protected work starts. Candidate-engine work also remains behind the shared resolve-and-prepare gate.
- Separate planning-artifact identity from implementation-candidate identity. Planning commits and planning/specification PRs are provenance, not implementing-stage completion evidence.
- Make reconciliation prove the exact implementation candidate and stage postcondition before projecting implementation, merge, or Logical Operation completion. A reopened actionable issue is resumed even when an older planning PR is merged.
- Keep incomplete work durably owned by RecoverySupervisor and invalidate candidate-bound implementation, review, test, decision, and authority evidence on every candidate epoch change.
- Bound Decisions authority evidence with content-addressed references so repeated requests do not duplicate the issue context, dependency closure, or specification corpus.
- Publish generated grill Markdown through a non-argv body channel and preserve typed, actionable diagnostics for transport and operating-system spawn failures, including null process status.
- Preserve the existing authority boundary: admission stamps do not authorize or prove merge, release, deployment, rollback, destructive work, or success; `advance`, `loop`, and `single` still never merge.

## Acceptance Criteria

- [ ] Every task and acceptance criterion from archived change `2026-09-05-stamp-required-unique-op-admissions` has implementation and hermetic test evidence without weakening durability, approved-root enforcement, identity, inventory, recovery ownership, collection, or the release hard gate.
- [ ] Every covered public admission creates or resumes exactly one immutable Logical Operation identity, and retries, restarts, reattachment, and nested work preserve that identity while physical attempts remain distinct.
- [ ] A covered operation does not begin protected work until its stamp is atomically published, durability-flushed, read back, and verified against the bound operation, physical attempt, entrypoint, and approved execution root.
- [ ] Missing, malformed, conflicting, or unapproved-root stamps fail closed and emit typed mechanical evidence under the same pre-bound identity; no protected downstream adapter runs.
- [ ] Direct `single`, `merge`, and `merge-queue --apply`, plus each train-nested merge, satisfy the archived admission ordering and identity contract; numeric drive remains distinct from `single`.
- [ ] Candidate-engine commands spawn only from the exact canonical root returned by shared resolve-and-prepare after candidate identity, readiness, and pre/post-bootstrap cleanliness are proved.
- [ ] An executable inventory covers required public entrypoints, nested operations, recovery/resume paths, and applicable host adapters, and the repository validation gate fails for a missing, duplicate, unknown, or bypassing admission site.
- [ ] Unique-operation collection accepts only qualifying artifacts from approved roots, never synthesizes absent coverage, never treats admission as completion, and leaves `uniqueOperationSloFailure` as a release-prepare hard failure.
- [ ] A salvaged planning-only commit cannot satisfy the implementing-stage deliverable, enter post-implementation publication, transition to design/review, or avoid implementation-harness execution.
- [ ] A merged planning/specification PR cannot prove implementation, merge completion, or Logical Operation completion for an issue whose current stage still requires implementation.
- [ ] Reconciliation of an open issue at any actionable stage, including `pipeline:ready`, resumes or schedules the missing implementation work despite an older merged planning PR.
- [ ] Planning-artifact and implementation-candidate identities remain distinct and are checked at implementation, recovery, reconciliation, review, and completion boundaries.
- [ ] When exact implementation completion is not proved, RecoverySupervisor records an owned active, cooling, waiting, reconstruction, or typed-request outcome; it does not produce an ownerless terminal or false-human projection.
- [ ] Candidate movement starts a new Candidate epoch and invalidates all candidate-bound implementation, test, review, decision, and authority evidence until each fact is re-proved for that epoch.
- [ ] Decisions authority requests retain bounded, content-addressed evidence and binding metadata without repeating the full context, dependency, or specification corpus, and rendered issue bodies stay within GitHub's body-size limit.
- [ ] Grill issue-body publication successfully delivers a generated Markdown body above the prior argv failure threshold through stdin, a body file, or an equivalent non-argv channel.
- [ ] Grill publication failures retain typed actionable diagnostics, and an operating-system spawn failure with null status is not reported as success, an unclassified lifecycle outcome, or a misleading numeric exit.
- [ ] Network-free regressions prove planning-only salvage invokes implementation, a reopened actionable issue with an older merged planning PR is not reconciled complete, and oversized grill Markdown is delivered without an argv body.
- [ ] Generated host artifacts and any generator-owned documentation are refreshed after core changes, and `openspec validate --all`, generated-artifact checks, and the complete `npm run ci` gate pass.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `operation-reliability`: make the archived durable admission contract fully fail closed at an approved root and extend mechanical inventory coverage across every applicable admission path.
- `candidate-engine-readiness`: require all candidate-engine consumers represented by the operation inventory to reuse the shared exact-root resolve-and-prepare gate.
- `implementing-resume`: replace commits-ahead and planning-deliverable shortcuts with authoritative implementation-candidate postcondition proof.
- `unpublished-stage-commit-publish`: prevent planning-only salvage/checkpoint commits from entering the post-implementation publication path.
- `operation-invariant-reconciliation`: distinguish planning PR integration from exact implementation completion and honor a reopened issue's current actionable stage.
- `issue-stage-adapters`: bind stage completion and candidate evidence to explicit artifact roles and Candidate epochs while retaining RecoverySupervisor ownership.
- `grill-with-docs-admission`: bound authority evidence and publish evidence-bearing issue bodies through a typed non-argv transport.

## Impact

- **Class vs site:** the class defect is conflation of admission, planning provenance, and authoritative implementation completion. Issue #1452 is regression evidence only; no issue-number-specific branch is added.
- **Reuse first:** extend `persistPublicEntrypointAdmission`, generic run-store serializers, `REQUIRED_PUBLIC_ENTRYPOINTS`, existing operation-observation and RecoverySupervisor adapters, `resolveAndPrepareCandidateEngine`, implementation deliverable/epoch checks, linked-PR reconciliation, and grill's existing issue-body update seam. Do not add a second store, scheduler, recovery controller, candidate bootstrapper, or host engine.
- **Affected surfaces:** `core/scripts/run-store.ts`, `operation-reliability.ts`, `operation-observation.ts`, public dispatch and train/merge adapters, candidate-engine readiness consumers, `stages/planning.ts`, `unpublished-stage-commit.ts`, `loop/reconcile.ts`, issue-stage adapters and ledgers, grill Decisions/rendering/publication, and injected-seam tests.
- **Compatibility correction:** the older allowance for a required admission to continue when the approved control root is unknown is superseded by the later archived fail-closed contract and this issue's explicit approved-root acceptance criteria.
- **Packaging:** hosts remain short argv wrappers. Only generator-owned host or documentation artifacts change after core sources change.
- **Authority:** no merge, release, deploy, rollback, destructive-operation, security, or override authority is granted or changed.
