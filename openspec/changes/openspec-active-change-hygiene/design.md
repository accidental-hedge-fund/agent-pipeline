## Context

`scripts/ci-openspec.mjs` is the whole OpenSpec CI surface today: if `openspec/` exists, run
`openspec validate --all` (preinstalled binary, else a pinned `npx` fallback) and propagate the
exit code. It is deliberately a no-op on repos without `openspec/`, and its root is overridable
via `CI_OPENSPEC_ROOT` for test isolation. It runs inside `npm run ci`, which the GitHub
workflow invokes verbatim on both `push: [main]` and `pull_request`.

Validation says nothing about *which* changes are active — it only checks that whatever is
active is well-formed. That is exactly the hole this change closes.

## Goals / Non-Goals

**Goals**
- Zero unallowlisted active changes on the default branch, enforced in CI with a message that
  names the offenders and the fix.
- Cleanup that preserves audit material and shipped requirements.

**Non-Goals**
- Rebuilding or touching the pre-merge archive flow (working since #338).
- Changing OpenSpec's active/archive lifecycle model, or adding a new CLI sub-command.
- Any `core/` engine change (and therefore any `plugin/` mirror churn).

## Decisions

### D1 — Guard lives in `scripts/ci-openspec.mjs`, not in `core/`

The rule is a property of *this repository's default branch*, checked by *this repository's CI
gate*. `core/` is the shippable engine that runs in arbitrary target repos; encoding
"main must have zero active changes" there would impose a policy on every consumer and force a
`plugin/` mirror regeneration for a repo-local CI rule. Keeping it in `scripts/` also reuses the
existing `CI_OPENSPEC_ROOT` seam and the existing `scripts/ci-openspec.test.mjs` suite.

*Alternative rejected:* a new `pipeline` sub-command (`pipeline openspec-hygiene`). More surface,
more mirror churn, no benefit — nothing outside CI needs to call it.

### D2 — Default-branch detection: explicit CI env first, git fallback, fail-open on unknown

Order of resolution:

1. `OPENSPEC_HYGIENE_MODE` = `default-branch` | `pr` | `off` — explicit override, wins outright.
   This is the seam the unit tests drive.
2. GitHub Actions env: guard is **on** when `GITHUB_EVENT_NAME === "push"` and `GITHUB_REF`
   equals `refs/heads/<default>`; **off** when `GITHUB_EVENT_NAME === "pull_request"`.
3. Local fallback: `git rev-parse --abbrev-ref HEAD` equals the default branch → on.
4. Anything else (detached HEAD, no git, unrecognised env) → **off**.

Fail-open on the unknown case is deliberate. A false positive here blocks every PR in the repo
for a condition (an active change) that is *correct* on a feature branch; a false negative only
delays detection to the next push to `main`, which happens on every merge. The signal is
therefore cheap to re-acquire and expensive to over-fire.

The default branch name is read from `git symbolic-ref refs/remotes/origin/HEAD` when available
and falls back to `main`, so a fork or rename does not silently disable the guard's git path.

### D3 — Allowlist is a plain checked-in text file

`openspec/active-allowlist.txt`: one change id per line, blank lines and `#` comments ignored.
Missing or empty ⇒ strict zero.

Chosen over `openspec/config.yaml` (that file belongs to the OpenSpec CLI's own schema; adding
repo-private keys invites breakage on CLI upgrades) and over an env var (not durable, not
reviewable). A text file makes every exemption a reviewed diff with a comment line explaining
why — which is the actual point of the escape hatch.

An allowlist entry naming a change id that does not exist is itself an error: a stale exemption
silently re-opens the hole it was granted for.

### D4 — Per-change archive disposition is adjudicated, not batch-applied

`openspec archive <id> --yes` merges the change's spec deltas into `openspec/specs/`.
For a change whose requirements *already* live there (most of the 12), re-merging risks
duplicated or conflicting requirement blocks in the living spec. So:

| Evidence | Action |
| --- | --- |
| Delta requirements already present in `openspec/specs/<capability>` | `openspec archive <id> --skip-specs` |
| Shipped in a merged PR but requirements absent from living specs | `openspec archive <id> --yes` |
| No merged implementation; superseded or abandoned | archive + `SUPERSEDED.md` + follow-up issue |

Each archived change's disposition is recorded in the implementation PR body so the audit trail
is one click from the merge commit, and `openspec validate --all` is run after **each** archive
step rather than once at the end, so a bad spec merge is attributed to the change that caused it.

### D5 — Guard runs after validation, in the same script

`validate --all` first (a malformed change should report as malformed, not as "unexpected"), then
the hygiene check. Both failures are reported; the script exits non-zero if either fails.

## Risks / Trade-offs

- **Risk: guard misfires on a legitimate long-lived change.** Mitigated by the allowlist (D3) and
  by fail-open detection (D2).
- **Risk: `--yes` archiving corrupts a living spec.** Mitigated by per-change adjudication and a
  `validate --all` after each step (D4); every step is a reviewable diff.
- **Trade-off: fail-open detection means a misconfigured CI env silently disables the guard.**
  Accepted — see D2. The guard's own tests pin the three modes explicitly.

## Migration / Rollout

Single PR, no runtime or config migration, no consumer impact. After merge, the first push-to-main
CI run exercises the guard in its real mode with a clean `changes/` directory — that green run is
the end-to-end proof.
