## Context

Post-implement PR handling lives in `resumeFromImplementing` (`core/scripts/stages/planning.ts`). Flow today:

1. Format/test (and docs freshness) gates → push managed branch.
2. **Exact-head** lookup via `getPrForBranch(cfg, branch)` — reuses the PR for this head only.
3. Else `createPr` (with race re-check on exact head).
4. Emit `pr_created` / `pr_updated`, transition `implementing → design-gate`.

There is **no** sweep of other open PRs for the same issue. `getPrForIssue` dual-strategy resolution returns a single “authoritative” open PR and is used by status/review/pre-merge stages; the implement path deliberately does **not** reuse that for create-or-find (stale `pipeline/N-old-slug` must not be mistaken for the new managed head). That exact-head discipline is correct and stays.

Evidence: #601 kept open PR #656 on `eval/expanded-corpus-20260728` while pipeline PR #726 on `pipeline/601-…` shipped.

Living `pr-resolution` forbids body/title keyword matching for issue↔PR identity (false positives). The issue AC text also mentions “title/body issue ref”; **closing a PR on body mention alone is unsafe**. Design uses the same dual strategies as `pr-resolution` for candidate membership.

Constraints: pipeline never merges; no force-push/history rewrite on the superseded branch; unit tests inject I/O (no real network/git).

## Goals / Non-Goals

**Goals:**

- After managed PR create **or** exact-head reuse, close (default) or comment-flag other open same-repo issue-linked PRs whose head ≠ managed branch.
- Candidate identity = dual strategy only: `pipeline/<N>-*` same-repo head **or** target-repo `closingIssuesReferences` containing N.
- Safety: skip different base, forks/cross-repo spoofs, non-linked PRs, and the managed PR itself.
- Config opt-out of close via `supersede_mode: comment-only`.
- Injectable-dep tests that fail without the supersede step.

**Non-Goals:**

- Changing `getPrForBranch` / exact-head reuse or `getPrForIssue` dual-strategy semantics for “which PR is live.”
- Body/title-only linkage for close candidates.
- Deleting remote/local superseded branches or force-pushing them.
- Auto-merge of the managed PR.
- Retroactively sweeping historical open PRs when advance is not creating/reusing a managed PR this run (no background janitor).

## Decisions

### D1 — Hook point: after create-or-reuse, before stage transition

**Choice:** Run supersession once the live managed PR number is known — after successful create or exact-head reuse (including create-race reuse) — and **before** the `implementing → design-gate` transition (and after `pr_created`/`pr_updated` event emit is fine either immediately before/after; prefer **after** event emit so the live PR is already logged). Failures in supersede SHALL NOT undo PR create; they SHALL log and continue (or surface a non-blocking warning). Prefer **continue-on-partial-failure** for individual close/comment errors so one flaky close does not block the issue’s progress to review.

**Why:** Operators care that the new head is the integration PR; stranding advance on a secondary close would recreate human toil in a worse form.

**Alternatives:** Only on `prIsNew` — rejects the AC that reuse must also clean up siblings. Separate CLI command — does not fix the automatic operator gap.

### D2 — Candidate set = dual strategy ∩ open ∩ head ≠ managed ∩ same base

**Choice:** Enumerate open PRs for the repo (reuse/paginated candidate infrastructure already used by `getPrForIssue` where practical) and include a PR when **all** of:

1. Same repository (not `isCrossRepository` / fork).
2. Issue-linked under dual strategy for N: head starts with `pipeline/<N>-` **or** `closingIssuesReferences` contains issue N in the target repo (case-insensitive owner/repo).
3. `headRefName !== managedBranch`.
4. `baseRefName === cfg.base_branch` (integration base). Different-base PRs (backports, release lines) are left alone.
5. PR number ≠ managed PR number (belt-and-suspenders if head ever aliases).

**Explicitly exclude** body/title `#N` / `Closes #N` without closing references — aligns with living `pr-resolution` and prevents false closes.

**Why vs issue AC “title/body”:** False-positive close of an unrelated PR that merely mentions `#N` is worse than leaving a rare body-only linked PR open. Operators can still close those manually; the #601 shape is closing-ref or alternate-head pipeline-prefixed.

**Alternatives:** Union body-text heuristics — higher close risk. Only `pipeline/<N>-*` heads — would miss #656-style non-pipeline heads that still close the issue via GitHub closing refs.

### D3 — Default close with structured comment; optional comment-only

**Choice:**

- Default `supersede_mode: close`: post comment then `gh pr close` (order: comment first so the close reason is visible if comment succeeds; if comment fails, still attempt close with a best-effort log).
- `comment-only`: post the same structured comment, leave open. Comment body MUST include: superseded PR number, superseding managed PR number, issue N, marker/reason token `pipeline-superseded`, and short human-readable explanation.

No needs-human issue block in default mode (closing is the remediation). comment-only does **not** set `pipeline:blocked` unless we later learn operators want that — first cut is PR comment only so parallel human work on the old PR remains possible without blocking advance.

**Alternatives:** Always comment-only — leaves CONFLICTING PRs (the reported pain). Always hard-close without config — acceptable default but some orgs may want audit-only; config covers them.

### D4 — Pure helper + injectable deps

**Choice:** Extract something like `supersedeStaleIssuePrs(cfg, issueNumber, managed: { prNumber, branch }, deps)` with deps for list-open-candidates / post-comment / close / mode. Unit tests inject a fixture of two open PRs and assert close/comment calls; a regression proves that removing the call from `resumeFromImplementing` fails the test (or the helper test is wired through the resume path with spies).

Reuse existing `closePr` / `postPrComment` wrappers; do not invent a second close path.

### D5 — Config surface

**Choice:** Optional top-level (or nested under a small object if schema style prefers) `supersede_mode: "close" | "comment-only"` defaulting to `"close"` when omitted. Document in schema descriptions. Invalid values fail config validation like other enums.

### D6 — Listing API shape

**Choice:** Prefer extending or sharing the open-PR enumeration already used for dual-strategy resolution so we do not reintroduce a hard `-L 100` silent truncate (#623). Supersession is best-effort complete over open candidates under the same pagination/safety-bound rules; if the open list hits the safety bound, **fail visibly in logs** for that sweep (do not silently assume “no stale PRs”) but still do not block the issue advance (D1).

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| False close of a still-wanted parallel PR for the same issue | Dual strategy + same-base filter; comment-only mode; never body-text-only. |
| Closing a PR an operator is actively landing | Default close is intentional product choice for “one live PR”; comment names superseder; operators can reopen. |
| Close fails (permissions / already closed) | Per-PR try/catch; continue; log. |
| Race: third party opens another PR after list | Best-effort single pass; next advance re-sweeps. |
| Concurrent hosts each close the other's managed PR | Elect GitHub-authoritative winner (highest open same-base `pipeline/<N>-*` PR number); revalidate before act; loser does not close and stops without setBlocked. |
| Divergence from issue AC body-text wording | Documented in proposal/design; safer and consistent with `pr-resolution`. |
| Performance: full open-PR enumeration | Same cost class as `getPrForIssue`; rare at implement PR open time. |

## Migration Plan

1. Land helper + hook + config + tests in normal pipeline PR for #729.
2. Default `close` is a behavior change for multi-PR issues — desired correctness; no feature flag beyond `comment-only`.
3. Rollback: revert change; stale multi-PRs return to manual close.

## Open Questions

- None blocking. Body-text linkage rejected by design (D2). Whether comment-only should also set `pipeline:blocked` deferred; first ship is PR-surface only.
