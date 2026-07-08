## 1. Root-cause fix in defaultDeliver

- [x] 1.1 Change the stdin `error` handler in `defaultDeliver` (`core/scripts/event-sink.ts`) so an `EPIPE` does not settle the delivery promise: mark the pipe dead (stop writing) and let the `close` handler settle from the exit code.
- [x] 1.2 Keep non-EPIPE stdin errors rejecting the promise immediately, unchanged.
- [x] 1.3 Confirm the timeout, unspawnable-command, and synchronous-write-throw (#384) paths still settle-and-clean-up exactly as before.

## 2. Deterministic regression test

- [x] 2.1 Add a test that forces the EPIPE-before-close ordering (injected seam, or a forwarder that closes/ignores stdin then exits non-zero after a delay) and asserts the rejection is the close-shaped `exited N` message — not `write EPIPE`.
- [x] 2.2 Add/confirm a companion case for the zero-exit-with-EPIPE ordering resolving.
- [x] 2.3 Prove the new test bites: it fails on the pre-fix `defaultDeliver` and passes after the fix.
- [x] 2.4 Confirm the existing close-shaped assertions ("exited 1", secret redaction, stderr cap) are now race-free.

## 3. Verify and mirror

- [x] 3.1 Run the event-sink suite repeatedly under parallel load (≥5 consecutive runs) and confirm no `ERR_ASSERTION` from event-sink tests.
- [x] 3.2 Regenerate the plugin mirror (`node scripts/build.mjs`).
- [x] 3.3 Run `openspec validate event-sink-early-exit-determinism` and the full `npm run ci` gate.
