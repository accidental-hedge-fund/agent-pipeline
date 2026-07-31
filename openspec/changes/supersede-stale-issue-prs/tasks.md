## 1. Config surface

- [x] 1.1 Add optional `supersede_mode: "close" | "comment-only"` to the config schema (PartialConfig / defaults), defaulting to `close` when omitted; invalid values fail validation.
- [x] 1.2 Wire the key through resolve/merge and schema/docs surfaces that list optional config keys (same pattern as other top-level enums).
- [x] 1.3 Add config unit tests: omit → `close`; `comment-only` accepted; invalid rejected.

## 2. Supersede helper (pure + injectable I/O)

- [x] 2.1 Implement a `supersedeStaleIssuePrs` (name flexible) helper that takes cfg, issue number, managed `{ prNumber, branch }`, and deps for listing open candidates, posting PR comments, and closing PRs.
- [x] 2.2 Candidate filter: open, same-repo (not fork), dual-strategy issue link for N, head ≠ managed branch, base === `cfg.base_branch`, number ≠ managed PR.
- [x] 2.3 Default mode: structured comment with superseding PR, issue N, and `pipeline-superseded`, then close; comment-only: comment only.
- [x] 2.4 Per-candidate failures log and continue; helper does not throw in a way that aborts the managed PR advance path.
- [x] 2.5 Prefer reusing/paginating open-PR enumeration consistent with `getPrForIssue` dual-strategy fields (no silent hard truncate); safety-bound exhaust logs visibly without blocking advance.

## 3. Hook into post-implement path

- [x] 3.1 Call the helper from `resumeFromImplementing` after managed PR create or exact-head reuse (including create-race reuse) and before stage transition away from implementing.
- [x] 3.2 Add deps seam on the resume path so tests can inject the supersede function or its gh deps without real network.
- [x] 3.3 Confirm exact-head create-or-reuse behavior is unchanged (still `getPrForBranch`, not dual-strategy as the managed PR selector).

## 4. Regression tests (must bite)

- [x] 4.1 Fixture: two open issue-linked PRs, different heads → after create path, close invoked for non-managed only; managed PR untouched.
- [x] 4.2 Fixture: exact-head reuse with a sibling open PR → supersede still runs (close sibling).
- [x] 4.3 Fixture: body-only mention / different base / fork prefix spoof → not candidates.
- [x] 4.4 Fixture: `comment-only` → comment without close.
- [x] 4.5 Prove the multi-PR close test fails if the supersede call is removed from the post-implement path (or equivalent bite proof).
- [x] 4.6 Keep existing planning/resume PR create-or-reuse tests green.

## 5. Mirror, validate, gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` with core.
- [x] 5.2 Run targeted unit tests, then `npm run ci` from repo root; fix failures.
- [x] 5.3 `openspec validate supersede-stale-issue-prs` (and `openspec validate --all` via ci) stays green.
