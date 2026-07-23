# Tasks — delta review resolution context

## 1. Resolved-finding verification model (review-history)
- [ ] 1.1 Add a pure helper over `PriorRoundDigest` that returns the settled findings' verification
      entries (key, surface, title, settling round, disposition) — reusing `settledFindings` —
      ordered deterministically and deduplicated by finding key.
- [ ] 1.2 Add a helper returning the distinct file paths from those entries' surfaces, ascending and
      deduplicated, for the file-state read.
- [ ] 1.3 Unit-test both helpers, including the empty/`actor: null` no-op case.

## 2. HEAD file-state read seam (pre_merge)
- [ ] 2.1 Add a `readHeadFiles` seam to `ShaGateDeps` (default: read from the delta worktree path),
      returning `{ path, content, truncated, present }` per requested file under a per-file and
      total byte cap.
- [ ] 2.2 In the delta-review branch, when settled findings exist, resolve their surfaces' files
      via the seam from `deltaWorktreePath` and thread the result into `runDeltaReview`.
- [ ] 2.3 Skip the read entirely when there are no settled findings (byte-identical prompt).

## 3. Prompt rendering (prompts)
- [ ] 3.1 Add a resolved-finding verification placeholder to `review_adversarial.md` and render it
      in `buildDeltaReviewPrompt`: the settled-finding list, the presumed-resolved + require-HEAD-
      evidence instruction, the explicit rejection of narrow-delta-scope rationale, and the fenced
      per-file head content (with truncation and not-present notes).
- [ ] 3.2 Sanitize and fence the section and file content on the same terms as the digest
      (`priorRoundsDigestSection`); no nested-fence escape, marked as untrusted evidence.
- [ ] 3.3 Emit nothing when there are no settled findings.

## 4. Evidence-rule demotion (review-policy / pre_merge partition)
- [ ] 4.1 In the delta partition path, demote to advisory any finding whose surface matches a
      settled finding's surface and whose body cites no head-state evidence, with a reason distinct
      from unacknowledged-reversal.
- [ ] 4.2 Name the settled finding key and settling round in the posted comment and emit the run
      event; leave verified-regression findings on settled surfaces blocking.

## 5. Tests
- [ ] 5.1 Prompt-loader drift guards: verification section present with settled history, absent
      without; instruction text and narrow-delta rejection pinned; file content fenced.
- [ ] 5.2 #451 regression fixture: replay the three re-asserted keys on their surfaces; assert all
      three demoted to advisory, no override needed, prompt carries the section and head file
      content. Prove it fails against pre-change behavior.
- [ ] 5.3 Verified-regression-still-blocks case on a settled surface.

## 6. Mirror & gate
- [ ] 6.1 `node scripts/build.mjs` and commit the regenerated `plugin/`.
- [ ] 6.2 `openspec validate delta-review-resolution-context` clean.
- [ ] 6.3 `npm run ci` green from repo root.
