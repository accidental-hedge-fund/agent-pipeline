## Context

See `proposal.md` for why. Current law and code:

- Living `idempotent-stage-audit` requires a dispatch-time reconciler that scans the last 20 issue comments for `<!-- pipeline-audit: … state=<current> -->` and posts `## Pipeline: Audit Repair` when the marker is absent.
- `reconcileAuditComment` in `core/scripts/gh.ts` additionally requires `trustedActor != null`, `c.author === trustedActor`, and a `## Pipeline:` prefix. When `getGhActor()` returns null it posts a repair (fail toward extra comments). Unit tests encode that null-actor post.
- `runAdvance` resolves the actor once per loop iteration and passes it in. `getIssueDetail` maps comment authors from `author.login`.
- Issue #279 had 19 comments total (inside the 20-window) and 13 audit-related comments. Consecutive repairs at `eval-gate` then `ready-to-deploy` in one session match “every stage looks like a gap,” not “the sentinel aged out of the window.”

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is #279’s 13-of-19 comment flood. The class is: audit repair is a false positive when the GitHub actor cannot be resolved, or when the sentinel was written by another pipeline host identity that is not the current actor. A window-only mole (search full history / store the sentinel in the run store) does not stop that class.
2. **Shared surfaces.** Trust and skip live in `reconcileAuditComment` (one helper, both stage and blocked repairs). Config grant is a new `trusted_audit_actors` key, not `trusted_override_actors`. Call site in `pipeline-run.ts` only needs to pass the allowlist.
3. **Next identical fault.** The next host whose `gh api user` fails, or whose comments are posted as a second bot login, hits the same skip/allowlist. Tests fail if null actor still posts, or if override-only identities suppress repair.

## Goals / Non-Goals

**Goals:**

- Reverse null-actor behavior: skip repair, warn with a distinct skip reason, continue dispatch.
- Trust sentinels from the current actor plus `trusted_audit_actors` only.
- Keep anti-forgery: untrusted authors and quoted sentinels do not suppress repair.
- Keep the 20-comment recency window unchanged in this change.
- Document the new key in the init scaffold with a SECURITY note that names audit-sentinel trust only.

**Non-Goals:**

- Widening the comment scan, paginating full issue history, or storing sentinel presence in the run store.
- Collapsing or amending consecutive repair comments.
- Changing `transition()` / `setBlocked()` sentinel embedding or retry.
- Broadening `getGhActor()` (installation tokens, `GITHUB_ACTOR`, app bot login). Skip-and-retry is the specified unresolved-actor path.
- Reusing `trusted_override_actors` for this grant.
- Merge, override disposition, or stage-graph changes.

## Decisions

### 1. Unresolved actor skips repair; it does not post and does not fail the dispatch (primary)

**Choice:** When the authenticated GitHub actor is null, `reconcileAuditComment` returns without posting. It emits a warning that names `actor unresolved` (or equivalent) and does **not** use the existing “missing … posting repair” wording. The advance loop continues.

**Why:** The #279 flood class is “repair at every stage in one session.” `getGhActor()` failing once per iteration (`gh api user` on an app token, timeout, or missing user scope) produces that pattern even when sentinels sit inside the 20-window. Posting without a resolved actor also cannot distinguish a trusted host from a forger, so the old fail-toward-repair path is the wrong closed-form. A later invocation that can resolve the actor still repairs a true gap.

**Alternatives considered:**

- Keep posting when actor is null (current #259 test) → rejected. That is the flood.
- Fail the dispatch / park the issue when actor is null → rejected. Actor lookup is not a product-authority hold; the stage can still run.
- Infer trust from body shape alone when actor is null → rejected. Anti-forgery requires an author.

### 2. Dedicated `trusted_audit_actors` allowlist; do not reuse `trusted_override_actors`

**Choice:** Add optional config `trusted_audit_actors: string[]` (GitHub logins). Trust set = `{ currentActor } ∪ trusted_audit_actors`. Absent/empty = current actor only. `trusted_override_actors` is ignored by the reconciler.

**Why:** Override actors may dispose blocking review findings. Audit-sentinel trust only suppresses a bookkeeping comment. Mixing those grants would let an override identity (or anyone an operator listed for overrides) silence audit repair, and would let a second pipeline host that is *not* an override actor keep flooding. The issue decision forbids reuse.

**Alternatives considered:**

- Reuse `trusted_override_actors` → rejected by issue decision and by grant separation.
- Implicitly trust `GITHUB_ACTOR` or any `## Pipeline:` author with a valid attestation → rejected. Attestation helps but is still forgeable if verification is skipped; an explicit list is auditable.
- Hardcode claude/codex bot logins → rejected. Hosts and tokens differ per repo.

### 3. Keep the 20-comment window; do not change storage scope

**Choice:** Continue `comments.slice(-20)`. Do not search full history. Do not persist sentinel presence in the run store. Do not amend an earlier repair comment.

**Why:** 19 comments already fit the window, so the reported incident is not explained by recency. Changing storage now would mask the actor bug and skip the required regression. If a later measured flood still occurs after actor trust is fixed, a follow-up may widen the scan or persist state.

**Alternatives considered:**

- Full comment history / run-store sentinel → deferred. Not this change.
- Collapse consecutive repairs into one edited comment → deferred. GitHub comment edits are a different write path and hide the original timestamp.

### 4. Keep body-shape checks; missing author is untrusted

**Choice:** A trusted hit still requires `## Pipeline:` prefix, `<!-- pipeline-audit:`, and `state=<current> -->`, plus author in the trust set. `author` falling back to `"unknown"` is not trusted unless that literal login is in the allowlist (operators MUST NOT list `unknown`).

**Why:** Body-prefix alone is the #259 forgery case. Author-only without the sentinel would treat any pipeline-host comment as an audit marker.

### 5. Pass the allowlist into the existing deps seam; do not add a second reconciler

**Choice:** Extend `reconcileAuditComment` (and tests in `idempotent-audit.test.ts`) to take the allowlist from `cfg.trusted_audit_actors`. Stage and blocked call sites already share this helper. No new stage, no second recoverer.

**Why:** Class-over-site: both floods (null actor, other-host author) are the same helper. A path-local skip in `pipeline-run.ts` only would miss other callers.

## Risks / Trade-offs

- **True partial writes stay unaudited until the actor resolves** → Mitigation: distinct skip warning; next invocation with a resolved actor still posts. Partial writes are the original #259 gap; comment floods are the #1276 gap. Skip is the specified trade.
- **Resolved actor login ≠ comment-author login** (user PAT vs app/`github-actions[bot]`) still floods until the posting identity is listed → Mitigation: document that `trusted_audit_actors` must include every GitHub login that posts pipeline comments besides `gh api user`. Tests cover allowlist hit vs override-only miss.
- **Operators confuse the two allowlists** → Mitigation: SECURITY note on the new key; scaffold text forbids override wording; regression fails if override-only identities suppress repair.
- **20-window remains a residual edge** after this fix, on issues with >20 later comments → Mitigation: explicit non-goal; follow-up only after actor-trust regressions are green and a new measured flood exists.

## Migration Plan

- Additive config key. Existing configs stay valid. Default preserves current-actor-only trust and changes only the null-actor path.
- Reverse the null-actor unit test in the same change as the helper edit so CI cannot keep the old post-repair contract.
- After `core/` edits, regenerate `plugin/` in the same commit. Docs generator picks up the new key from the Zod describe-text.
- Rollback: revert the change. Worst case returns to extra repair comments, not a merge-authority change.

## Open Questions

None. Actor-unresolved skip, dedicated allowlist, anti-forgery, and “do not change the window first” are issue decisions.
