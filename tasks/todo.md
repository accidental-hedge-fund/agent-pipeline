# Harden Buzz-driven self-hosting factory

- [x] Make `pipeline train --json` emit one final typed object and add an end-to-end regression test.
- [x] Make release prepare return typed PR/version/base/head identity and validate it at finish.
- [x] Add a narrow Pipeline-owned ship coordinator that composes train, candidate-bound FRG validation, release, publication wait, and engine promotion.
- [x] Validate an immutable, expiring, event-bound Ed25519 ship authorization before each merge/release/install phase.
- [x] Use exact-run material events and bounded systemd crash supervision; remove shell lifecycle duplication.
- [x] Fix engine promotion's nested installer lock behavior.
- [x] Update OpenSpec, docs, generated mirrors, and changelog.
- [x] Run focused tests, `node scripts/build.mjs`, and `npm run ci`.
- [ ] Extend the existing post-v1.33 fixed-pack producer to emit candidate-bound FRG provenance; until then a fresh ship intentionally stops at FRG validation.
- [ ] Make release prepare reconcile a crash after pushing `release/vX.Y.Z` but before creating its PR; the coordinator currently reports the stranded branch instead of guessing or deleting it.

## Review

- `pipeline ship` is the only lifecycle coordinator. Buzz/Hermes admits one signed,
  exact command; systemd owns process lifetime; Pipeline owns frozen milestone scope,
  repo/base serialization, reconciliation, release identity, publication, and promotion.
- Authorization is verified with a root-owned Ed25519 public key and rechecked before
  every mutating phase. A SHA-256 fingerprint remains an integrity/indexing value, not
  proof of authorship.
- Train and release machine output each contain one parseable JSON document. Release
  finish inside the coordinator is bound to the prepared PR/version/base/head and FRG
  candidate; fork PRs, force-pushed heads, moved base tips, and provenance-free FRG
  evidence fail closed.
- Progress follows one exact events file through the shared material filter, starts at
  the current cursor, targets the admitted Buzz channel/thread, and exits on the typed
  terminal event.
- Verification: focused supervisor/coordinator suite passed 150/150; `openspec validate
  --all` passed 266/266; docs generation/check and plugin mirror check passed; full
  `npm run ci` passed including core, install, launcher, OpenSpec, docs, and script gates.
- Remaining boundary: the existing post-v1.33 `factory-gate` producer does not yet emit
  candidate-bound pack provenance. The coordinator reports the existing fixed-pack next
  action and refuses to release; it does not fabricate or infer that evidence.
- A narrow release-prepare crash window remains between remote branch push and PR
  creation. Recovery is visible and fail-closed, but not yet automatically convergent.
