# Factory: clear dumb escalations

## Goal
Stop parking mechanical recoveries as needs-human: (1) pipeline-internal marker-only dirt before OpenSpec archive, (2) code-behind-spec residual treated as auto-fixable.

## Tasks
- [ ] Export porcelain strip helper from salvage; use in maybeArchiveOpenspec (marker-only = clean; optional unlink markers)
- [ ] isAutoFixableFinding: spec-divergence + code-behind-spec → true
- [ ] Tests for both
- [ ] OpenSpec delta for pre-merge-fix-round + harness-uncommitted-salvage / archive dirty
- [ ] build.mjs + npm test
