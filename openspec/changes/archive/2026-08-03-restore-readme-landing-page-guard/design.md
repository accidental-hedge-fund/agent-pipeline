## Context

#597 / PR #790 established `docs-landing-split`: a lean root `README.md` (219 lines) plus generated `docs/cli.md` / `docs/config.md` and hand-authored `docs/concepts.md`. The living OpenSpec requirement already states the README SHALL stay under 400 lines and link those companions, but enforcement is prose-only.

The existing docs freshness surface (`scripts/generate-docs.mjs --check`, `npm run docs:check`, `scripts/ci-docs.mjs`, and the engine `docs-freshness-gate`) validates **generator-owned** artifacts only. A restack/conflict resolution during #675 / PR #793 (`d85f5dae`) reintroduced ~1,845 lines of the old monolith into README without failing any gate. Current `origin/main` README is ~2,067 lines.

Constraints from the issue and golden rules:

- Provider-neutral; docs/tooling/control-only.
- Do **not** change stage machine, merge authority, or review-policy thresholds.
- Prefer extending the existing docs check path over inventing a parallel CI system.
- Surgical-fix / merge-queue repair already claim minimal scope — the gap is executable verification when that claim fails.

## Goals / Non-Goals

**Goals:**

1. Restore a correct lean README that satisfies `docs-landing-split` while keeping intentional post-#790 edits.
2. Make the landing-page contract fail CI and the pre-PR docs path the same way stale `CHANGELOG.md` already does.
3. Prove the #793 shape fails with a biting regression fixture.
4. Ensure restack / conflict repair / pre-merge surgical repair cannot treat a landing-page-breaking docs delta as a successful gate pass.

**Non-Goals:**

- Publishing a docs site (#598).
- Rewriting documentation architecture beyond the #597 layout.
- Changing review severity/confidence policy, merge surfaces, or auto-merge posture.
- Auto-healing a violated README by truncating content (human/implementer restores the lean page; the gate only fails closed).
- Guarding every markdown file in the repo for size — only the landing-page contract on root `README.md` (and the companion-link / inventory rules tied to it).

## Decisions

### D1 — Enforce the README contract inside the existing docs check surface

**Choice:** Extend `scripts/generate-docs.mjs --check` (and thus `docs:check` / `ci:docs` / docs-freshness activation) to run a pure README landing-page contract check in addition to generator artifact diffs.

**Why:** One operator-facing command already gates "docs are acceptable for this head." Putting README rules here means local `npm run ci`, implement pre-PR docs-freshness, and Actions all fail closed without a new npm script or stage.

**Alternatives considered:**

- Separate `scripts/check-readme.mjs` only wired into package `ci` — works but forks the "docs gate" mental model and can be skipped by docs-freshness if not also wired there.
- Engine-only check in TypeScript stages without CI — would not stop non-pipeline PRs or local contributors.

### D2 — Contract checks are deterministic and pure

**Choice:** Implement a small pure function (Node module under `scripts/` or `core/scripts/` imported by the generator entry) that, given README text (and optionally repo-relative path existence for companions), returns pass/fail with stable diagnostic codes:

| Check | Fail condition |
| --- | --- |
| Line budget | `lineCount >= 400` |
| Companion links | Missing relative link to `docs/cli.md`, `docs/config.md`, or `docs/concepts.md` |
| No full inventory | Heuristic: README body reintroduces a full hand-maintained CLI inventory shape (e.g. large multi-command table/list that duplicates the generated reference role), not a short pointer |

Diagnostics SHALL list failing check ids and, for line budget, the measured line count — same class of parseable failure as `stale generated docs:` so operators and extractors can see *why*.

**Why:** Unit-testable without git/network; fixture can embed the #793 append shape.

**Alternatives considered:**

- Exact byte match to a golden README — too brittle for legitimate post-split edits.
- LLM review of README on every PR — violates deterministic control preference and rigor-over-latency product stance for this class of invariant.

### D3 — Restore README by surgical deletion of the monolith, keep post-split legit content

**Choice:** Reconstruct README from the #790 lean landing page as the structural base, then re-apply intentional post-#790 deltas that belong on the landing page (stage-count language from #626, install packaging notes from #635, any other non-monolith commits), rather than hand-editing 2k lines of garbage in place.

**Why:** The #793 failure mode was "append old monolith inside Uninstall." Surgical removal of that append (or rewrite from known-good base + cherry-picked legit hunks) minimizes reintroducing drift.

**Alternatives considered:**

- `git checkout 831e46d3 -- README.md` alone — drops legitimate post-#790 landing-page edits.
- Keep current file and delete from a guessed line number — error-prone if structure shifted again.

### D4 — Repair / restack fail-closed reuses the docs check, not new review policy

**Choice:** After merge-queue surgical repair / restack that moves the candidate head, and after pre-merge / surgical-fix commits that can land documentation, the control path that already (or should) run docs freshness / `docs:check` SHALL treat a README-contract failure as a hard block: non-eligible re-gate, no ready-to-deploy success advertisement, no silent merge-queue merge retry success. Optionally surface the breach as a repair-hold / needs-human-class residual only if existing offramps already classify "gate red"; do **not** invent a new review severity or change `block_threshold`.

**Why:** Issue forbids altering review/merge policy semantics. The bug is missing mechanical enforcement, not soft reviewer judgment.

**Alternatives considered:**

- Require a full re-review round on any docs file touch during repair — broader than needed and risks review-loop cost without a deterministic fail.
- Auto-revert README on repair — too magic; prefer fail closed with clear diagnostics.

### D5 — Regression fixture is content-shaped, not git-history-shaped

**Choice:** Store (or synthesize in-test) a README string that looks like: lean header/sections + a large appended monolithic block (order-of-magnitude 1k+ extra lines and/or full command inventory markers). Assert `checkReadmeLandingContract` (name TBD) fails. Assert `generate-docs --check` integration (or the docs check surface unit seam) fails when that content is the worktree README. Prove bite by removing the guard in a negative test pattern consistent with existing docs-check tests.

**Why:** #793's SHA-specific history is evidence, not a runtime dependency. Content shape is stable.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Line budget false-positive as legitimate content grows toward 400 | Budget is already the archived #597 contract; keep landing page lean and push depth to `docs/`. Raise budget only via a future OpenSpec change. |
| Inventory heuristic false-positive on a short command example | Keep the guard aimed at *full inventory* scale (size + structure), not single install examples; document the heuristic in tests. |
| Consumer repos without this README layout | Gate checks apply when this repo's docs generator is present and README is the agent-pipeline front door; do not invent consumer-specific monolith detection. If check is always-on for any repo using this generator, ensure failure messages name the contract so forks can adopt the layout or opt out only if product later defines that (out of scope). Default: this repository's `generate-docs.mjs` owns the check. |
| Repair path does not currently re-run docs check after restack | Spec requires fail-closed on contract breach; implementation wires the existing docs-freshness / check call into post-repair verification or relies on pre-PR docs gate before ready-to-deploy — document which path in tasks and prove with a unit seam. |
| Restoring README conflicts with other open doc PRs | Single focused change; regenerate nothing SKILL-related unless needed; keep diff README + gate + tests + OpenSpec. |

## Migration Plan

1. Land OpenSpec change (this planning step).
2. Implement contract checker + wire into `generate-docs --check`.
3. Restore README; prove `docs:check` green on the restored file and red on the #793 fixture.
4. Wire repair/restack fail-closed observation of the check (minimal control seam).
5. `npm run ci` green; archive OpenSpec at pre-merge as usual.

Rollback: revert the change commit(s). No data migration. Temporary local workaround if needed: none — a red docs check is the desired state for a monolithic README.

## Open Questions

- Exact inventory heuristic threshold (line count alone may be sufficient for the #793 class; companion links + line budget may be enough for v1 of the guard). Prefer **line budget + required links** as must-have; inventory shape as should-have if it can be made low-noise.
- Whether post-repair merge-queue path already invokes docs-freshness or only pre-PR implement path — implementation SHALL inventory call sites and close the gap without expanding merge policy.
