## 1. Shared Admission Contract

- [ ] 1.1 Make `persistPublicEntrypointAdmission` durably persist and read-back verify the requested entrypoint, matching run kind/start event, and root `logical_operation_id`; verify injected run-store tests cover success, write failure, malformed read-back, and identity mismatch.
- [ ] 1.2 Add the shared required-entrypoint admission inventory and verify a set-correspondence test fails for a missing, duplicate, or unknown `REQUIRED_PUBLIC_ENTRYPOINTS` producer.

## 2. Protected Entrypoint Integration

- [ ] 2.1 Route direct `single`, `merge`, and `merge-queue` through the acknowledged shared admission contract before their protected boundary; verify network-free command tests prove ordering and refuse downstream work after admission failure.
- [ ] 2.2 Add the injected train nested-merge admission seam, persist a distinct `merge` artifact with the outer train `logical_operation_id` before each merge submission, and verify train tests preserve the separate outer `train` record and refuse merge after stamp failure.

## 3. Evidence and Release Gate

- [ ] 3.1 Verify unique-operation collection observes qualifying direct and train-nested artifacts while drive-only and raw train-event inputs leave `single`, `merge`, and `merge-queue` missing; run the focused collector tests.
- [ ] 3.2 Verify an admission stamp proves presence only—not completion, success, or authority—and that `uniqueOperationSloFailure` remains a release-prepare hard failure when stamped coverage is absent; run the focused FRG and release-eligibility tests.

## 4. Generated Surfaces and Full Verification

- [ ] 4.1 Run `node scripts/build.mjs` after every `core/` edit and verify generated host skills are fresh with `node scripts/build.mjs --check`.
- [ ] 4.2 Run `openspec validate stamp-required-unique-op-admissions`, update every checkbox with completed evidence, and verify the complete repository gate passes with `npm run ci`.
