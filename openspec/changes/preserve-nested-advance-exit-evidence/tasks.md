## 1. Diagnostic transport

- [x] 1.1 Capture nested child exit code/signal after spawn and verify a nonzero-exit regression receives structured process evidence
- [x] 1.2 Preserve a valid recoverable failed-response diagnostic through the supervisor and verify the recovery executor receives the exact diagnostic

## 2. Recovery selection

- [x] 2.1 Filter structured nested-child process exits to workflow-engine restart and verify unrelated repair recipes are excluded
- [x] 2.2 Verify recovery selection uses structured fields and does not depend on exit-like prose

## 3. Integration verification

- [x] 3.1 Regenerate host skills after core edits and verify `CI=1 npm run ci` passes
