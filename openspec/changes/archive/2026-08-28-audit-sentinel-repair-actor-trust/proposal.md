## Why

The audit reconciler posts a `## Pipeline: Audit Repair` comment at nearly every stage because it treats a missing *trusted* sentinel as a gap. On one complete run (issue #279) that produced 13 audit-related comments out of 19 total, including consecutive repair headings. The issue is hard for a human to read, and the signal (plan, review verdicts, final summary) is buried under bookkeeping.

The reported 19-comment total is inside the current 20-comment recency window, so widening or replacing that window is not the sole explanation and MUST NOT be the first change. Today's code posts a repair when `getGhActor()` returns null (fail toward extra comments) and trusts only an exact match on the current actor. That class — unresolved actor and host-actor mismatch — matches a flood at every stage in a single session.

## What Changes

- The reconciler SHALL NOT post an audit-repair comment when the GitHub actor cannot be resolved. It SHALL emit visible run evidence and retry on a later invocation.
- The reconciler SHALL trust an in-window audit sentinel only when it is authored by the current pipeline actor or by an identity on a dedicated `trusted_audit_actors` allowlist.
- That allowlist SHALL NOT reuse `trusted_override_actors`. Override authority and audit-sentinel trust are different grants.
- An arbitrary commenter SHALL NOT suppress audit repair by forging a `## Pipeline:` body and sentinel.
- Regression tests SHALL fail on the actor-mismatch / unresolved-actor flood class, not only on a sentinel falling out of a 20-comment window.
- This change SHALL NOT expand the comment search window, move sentinel state into the run store, or collapse consecutive repairs by editing an earlier comment. Those remain follow-ups if a later measured flood still occurs after actor trust is fixed.

**BREAKING:** none for stage labels, merge authority, or override disposition. Operators who listed a pipeline host only in `trusted_override_actors` will not get audit-sentinel trust from that list; they MUST add the host to `trusted_audit_actors` if a second pipeline GitHub identity should count.

## Capabilities

### New Capabilities

<!-- None. This tightens the existing idempotent-stage-audit reconciler. -->

### Modified Capabilities

- `idempotent-stage-audit`: Repair posting is gated on a resolved GitHub actor. Sentinel trust is the current actor plus a dedicated audit-actor allowlist, not `trusted_override_actors`. Unresolved actor skips repair with visible evidence. Forged sentinels still do not suppress repair. The 20-comment recency window is unchanged in this change.
- `init-command`: The scaffolded `.github/pipeline.yml` documents `trusted_audit_actors` as a commented opt-in with a SECURITY note that names audit-sentinel trust only, and does not present it as override authority.

## Acceptance criteria

- [ ] Given a matching in-window `<!-- pipeline-audit: … state=<current> -->` on a `## Pipeline:` comment authored by the current actor, the reconciler posts no repair.
- [ ] Given the same matching sentinel authored by an identity in `trusted_audit_actors` (and not the current actor), the reconciler posts no repair.
- [ ] Given the same matching sentinel authored by an identity that is only in `trusted_override_actors` (not current actor, not `trusted_audit_actors`), the reconciler still posts a repair.
- [ ] Given a matching sentinel body authored by an arbitrary untrusted commenter, the reconciler still posts a repair.
- [ ] When the GitHub actor cannot be resolved (`getGhActor()` is null), the reconciler posts no repair even if no trusted sentinel is visible, emits a distinct warning that names the skip (not “posting repair”), and continues the dispatch.
- [ ] A later invocation that can resolve the actor still repairs a true missing sentinel (label present, no trusted matching sentinel in the window).
- [ ] A unit test fails against current code for the unresolved-actor flood (null actor + existing pipeline-bot sentinel in-window still posts). A second unit test fails if `trusted_override_actors` is treated as audit-actor trust. Tests inject I/O; no live network, git, or subprocess.
- [ ] The 20-comment recency window is not widened or replaced as part of this change. Init scaffold documents `trusted_audit_actors` as commented opt-in with a SECURITY note. After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Impact

- **Shared reconciler:** `reconcileAuditComment` in `core/scripts/gh.ts` and its call site in `core/scripts/pipeline-run.ts`. Today null actor posts a repair; only `c.author === trustedActor` counts as trust.
- **Config:** new optional `trusted_audit_actors: string[]` on the Zod schema / `PipelineConfig` / init template / generated `docs/config.md`. Default absent/empty: only the current actor is trusted. Distinct describe-text and SECURITY note from `trusted_override_actors`.
- **Tests:** `core/test/idempotent-audit.test.ts` (reverse the null-actor post-repair case; add allowlist vs override-allowlist vs forger cases). Config template exhaustive / security-notes lists include the new key.
- **Does not:** widen the 20-comment scan; store sentinels in the run store; amend or collapse consecutive repair comments; change `transition()` / `setBlocked()` sentinel embedding; grant merge or override authority; reuse `trusted_override_actors`.
- **Class vs site:** the site is issue #279 (13 of 19 comments audit-related). The class is: audit repair must not fire when the actor is unresolved or when another allowlisted pipeline host already wrote the sentinel. The next host whose `gh api user` fails, or whose comments are posted under a second bot login, uses the same reconciler and does not need a new mole issue.
