## 1. Plan resolution from milestones

- [ ] 1.1 Extend release deps so milestone fetch returns membership plus open/total non-PR issue counts (injectable for unit tests; no live network in tests).
- [ ] 1.2 Resolve planned issue numbers solely from matching milestone membership on live and dry-run paths that need plan data.
- [ ] 1.3 Live prepare: fail closed with remediation when no matching milestone exists for the resolved version.
- [ ] 1.4 Theme resolution: CLI `--theme` → milestone title extraction → placeholder; stop preferring ROADMAP plan-row theme as authority.

## 2. Demote ROADMAP plan gates

- [ ] 2.1 Remove or demote the hard abort when ROADMAP planned rows exist but none are stampable (`countPerIssueRows` / "none could be stamped").
- [ ] 2.2 Make missing `release-plan-row`, `release-plan-none-row`, and `shipped-section` non-blocking when milestone plan resolution succeeded; warn and skip those doc mutations.
- [ ] 2.3 Keep optional ROADMAP documentation writes best-effort when anchors exist; issues column for any written plan row uses milestone membership (not stale ROADMAP lists as authority).
- [ ] 2.4 Correct ROADMAP header / provenance so it does not claim release-plan source-of-truth (milestones are authoritative).

## 3. Dry-run / status surface

- [ ] 3.1 On `--dry-run`, perform read-only milestone lookup (soft-fail) and print present/absent/unavailable plus open-issue count.
- [ ] 3.2 Ensure dry-run still writes no files, creates no commits, opens no PR, and performs no mutating GitHub calls.
- [ ] 3.3 Update release help / command-docs text for milestone plan authority and dry-run milestone report.

## 4. Tests

- [ ] 4.1 Test: milestone present with membership matching shipped closing issues → prepare succeeds (no stamp abort).
- [ ] 4.2 Test: milestone absent on live path → non-zero exit with remediation (no release PR).
- [ ] 4.3 Test: v1.35.0-class drift (stale ROADMAP planned rows, milestone matches shipped) → does not abort for ROADMAP stamp mismatch (bite proof against pre-change behavior).
- [ ] 4.4 Test: missing ROADMAP plan anchors with valid milestone → release prepare does not abort solely for those anchors.
- [ ] 4.5 Test: dry-run prints milestone present + open count; dry-run prints absent without abort; dry-run fetch failure → unavailable without inventing membership.

## 5. Docs, mirror, CI

- [ ] 5.1 Update any host SKILL / operator docs that still describe ROADMAP as release-plan authority.
- [ ] 5.2 Regenerate `plugin/` via `node scripts/build.mjs` when core/hosts change; include mirror in the same commit as source edits.
- [ ] 5.3 Refresh generated CLI/config docs when the generator is present and affected.
- [ ] 5.4 Run `npm run ci` from repo root and fix failures until green.
