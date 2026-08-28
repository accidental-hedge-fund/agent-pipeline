## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Reverse the existing null-actor contract in `core/test/idempotent-audit.test.ts`: given `trustedActor: null` and an in-window `## Pipeline:` comment that already carries `<!-- pipeline-audit: … state=fix-1 -->`, assert the reconciler posts **zero** comments and the warning names an unresolved-actor skip (not “posting repair”). Verify this test **fails** against current code (today it posts). No live network, git, or subprocess.
- [x] 1.2 Add an injected case: `trustedActor: null`, empty comments, current state `fix-1` → still posts **zero** comments (skip, do not fail-open to repair). Verify it **fails** against current code. Same I/O seam as 1.1.
- [x] 1.3 Add an injected case: current actor `codex-bot`, matching `state=fix-1` sentinel authored by `claude-bot`, `cfg.trusted_override_actors: ["claude-bot"]`, `trusted_audit_actors` absent → **must post** repair. Verify the test **fails** if implementation treats override actors as audit trust.
- [x] 1.4 Add an injected case: current actor `codex-bot`, matching sentinel authored by `claude-bot`, `cfg.trusted_audit_actors: ["claude-bot"]` → **must not post**. Verify it **fails** against current exact-match-only code.
- [x] 1.5 Keep (or add) the forged-author case: current actor `pipeline-bot`, matching `## Pipeline:` sentinel authored by `attacker` not on `trusted_audit_actors` → **must post**. Verify it still fails if anti-forgery is dropped. Keep the quoted-sentinel-in-human-comment case posting repair.

## 2. Reconciler class behavior

- [x] 2.1 Change `reconcileAuditComment` so a null actor returns without `postComment`, emits a distinct warning that names actor-unresolved skip, and does not use the “missing … posting repair” wording. Verify tasks 1.1 and 1.2 pass. Do not throw; do not park; do not fail the dispatch.
- [x] 2.2 Trust a matching in-window sentinel when `c.author === trustedActor` **or** `c.author` is in `cfg.trusted_audit_actors` (treat absent/empty as no extra identities). Ignore `cfg.trusted_override_actors`. Keep the `## Pipeline:` prefix, `<!-- pipeline-audit:`, and `state=<current>` substring checks. Verify tasks 1.3–1.5 and the existing “sentinel already present” / last-20-window tests.
- [x] 2.3 Keep `comments.slice(-20)`. Do not paginate full history. Do not persist sentinel presence in the run store. Do not edit an earlier repair comment. Verify the existing “only scans the last 20 comments” test still expects a post when the trusted sentinel is outside the window.
- [x] 2.4 When the actor is resolved and no trusted matching sentinel is in the window, keep posting the existing repair body and the existing “posting repair” warning. Verify the true-gap case (resolved actor, empty comments) still posts exactly one repair.

## 3. Config grant and init scaffold

- [x] 3.1 Add optional `trusted_audit_actors: string[]` to the Zod schema, `PipelineConfig`, and resolve/merge path. Describe-text SHALL say listed identities are trusted only to suppress audit-repair comments, not override or merge authority. Absent default: only the current actor is trusted. Verify `resolveConfig` accepts a file with `trusted_audit_actors: ["claude-bot"]` and rejects non-arrays.
- [x] 3.2 Document the key in `buildConfigTemplate` as a commented opt-in with a SECURITY note, absence semantic, and an example list. Do not describe it as override authority. Add it to the config-template exhaustive key lists and the security-notes class list. Verify those tests pass and uncommenting the example is schema-valid.
- [x] 3.3 Regenerated `docs/config.md` MUST include `trusted_audit_actors` after the generator runs (implementation runs the existing docs generate/check). Verify `trusted_override_actors` still documents override sentinels and the new key does not.

## 4. Gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [x] 4.2 Run `openspec validate audit-sentinel-repair-actor-trust` and `npm run ci` from the repo root. Verify both are green. Do not widen the comment window. Do not reuse `trusted_override_actors`. Do not merge inside advance/loop.
