## 1. Shared Admission Contract

- [ ] 1.1 Add the pre-I/O admission binding/result types and make `persistPublicEntrypointAdmission` reject an unavailable or non-approved control-host root, atomically publish and fsync final `run.json` plus `events.jsonl`, fsync the containing run directory plus parent `runs` directory, and read-back verify the exact run id, entrypoint/kind, and root `logical_operation_id`; verify injected admission-store tests fail every directory-create, temp-write, file-flush, rename, directory-flush, read-back, malformed-content, and identity-mismatch step without acknowledging the stamp.
- [ ] 1.2 Add `reportPublicEntrypointAdmissionFailure` over the injected `ReportOperationObservation` seam; require the pre-bound logical id, physical run id, domain, repository, entrypoint, and typed failure, and verify it emits owned non-human mechanical evidence with known-absent side-effect certainty without minting a replacement identity.
- [ ] 1.3 Add the shared required-entrypoint admission inventory and verify a set-correspondence test fails for a missing, duplicate, or unknown `REQUIRED_PUBLIC_ENTRYPOINTS` producer.

## 2. Protected Entrypoint Integration

- [ ] 2.1 Route direct `single`, `merge`, and `merge-queue --apply` through the acknowledged shared admission contract before their protected boundary; pass the admitted identity into single's child loop and all direct merge supervision/observation contexts, and verify network-free artifact tests prove single/loop identity equality, candidate-worktree-only and unavailable-control-root failure, owned failure reporting with the same pre-bound ids, ordering, and zero downstream drive/merge/repair calls after admission failure.
- [ ] 2.2 Pre-bind train's root logical id and attempted physical run id before outer-store initialization, require a published non-empty matching outer session before merge mode can proceed, and add the injected nested-merge admission/reporting seams; verify artifact tests preserve distinct outer `train` and nested `merge` records with equal `logical_operation_id`, while degraded outer-store and nested-stamp failures emit owned mechanical evidence through their specified routes and invoke neither nested admission with a replacement root nor merge submission.

## 3. Evidence and Release Gate

- [ ] 3.1 Verify unique-operation collection observes qualifying direct and train-nested artifacts while drive-only and raw train-event inputs leave `single`, `merge`, and `merge-queue` missing; run the focused collector tests.
- [ ] 3.2 Verify an admission stamp proves presence only—not completion, success, or authority—and that `uniqueOperationSloFailure` remains a release-prepare hard failure when stamped coverage is absent; run the focused FRG and release-eligibility tests.

## 4. Generated Surfaces and Full Verification

- [ ] 4.1 Run `node scripts/build.mjs` after every `core/` edit and verify generated host skills are fresh with `node scripts/build.mjs --check`.
- [ ] 4.2 Run `openspec validate stamp-required-unique-op-admissions`, update every checkbox with completed evidence, and verify the complete repository gate passes with `npm run ci`.
