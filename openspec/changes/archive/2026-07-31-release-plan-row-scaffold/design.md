## Context

`pipeline release` pre-validates ROADMAP anchors **before** any version bump by calling `scaffoldRoadmap` in memory (`release.ts`). Site 2 of that scaffold is `patchReleasePlanRow`, which requires an **unshipped** `| **v{version}** |` row. If the row is absent, it throws:

```text
ROADMAP anchor not found: release-plan-row (expected "| **vX.Y.Z**" row in the release plan table)
```

Intake and sweep already insert plan rows via `insertReleasePlanRow` (before the `| *(none)* |` sentinel). Release currently only **mutates** an existing unshipped row to `✅ shipped`; it does not insert. When a milestone completes without an intake/sweep-maintained plan row (common for opportunistic release cuts), operators must hand-author a docs PR first (#727 for v1.29.0).

FRG scenario `release-plan-row` (#723) already expects the release-cut path to have the plan row **present or scaffolded** — this change closes that honesty gap for the live release command.

## Goals / Non-Goals

**Goals:**

- Make missing unshipped plan rows a **self-healing** step inside release, before other ROADMAP mutations and before package version writes.
- Preserve shipped-row safety and clean-tree / rollback contracts.
- Surface doctor-grade remediation only when auto-insert is impossible.
- Document the row shape once, aligned with insert/`patchReleasePlanRow`.
- Prove behavior with bite-first regression tests.

**Non-Goals:**

- Inventing a version without `X.Y.Z` / `major|minor|patch`.
- Auto-merging the release PR or auto-tagging outside existing release automation.
- Full historical ROADMAP rewrite.
- A new top-level capability; this extends `release-sub-command`.
- Making `pipeline doctor` version-aware in this change (optional follow-up can share the ensure helper).

## Decisions

### D1 — Prefer auto-scaffold (option A) over fail-only preflight (option B)

**Choice:** When no unshipped `| **v{version}** |` row exists, insert a scaffolded row, then run the existing ship-mark mutations.

**Why:** Option B still forces a human docs PR for every completed milestone that lacked intake/sweep hygiene — the exact pain that blocked v1.29.0. Option A matches FRG wording (“present or scaffolded”) and reuses intake’s insert shape. Human review remains: live path still opens `$EDITOR` (unless `--no-edit`) on the full ROADMAP diff, including the new row.

**Alternative considered:** Fail with copy-paste remediation only — rejected as primary path; retained as the **fallback** when insert anchors are missing.

### D2 — Ensure-before-mutate as an explicit step, not buried inside `patchReleasePlanRow`

**Choice:** Add a pure helper (name illustrative) `ensureReleasePlanRow(text, planRowCtx) → text` that:

1. If an unshipped `| **v{version}** |` row exists → return text unchanged.
2. If only a shipped `| **v{version}** ✅ shipped |` row exists → return text unchanged (idempotent; never un-ship or duplicate).
3. If no row for version → insert via the same shape as `insertReleasePlanRow` (before `| *(none)* |`).
4. If insert anchor missing → throw a structured remediation error (not the opaque `release-plan-row` message alone).

Call `ensureReleasePlanRow` at the start of `scaffoldRoadmap` (and thus on pre-validate, dry-run, and live paths) **before** `patchIntroLine` / `patchReleasePlanRow` / etc.

**Why:** Keeps ship-mark logic simple; insert vs patch stay separate (intake already separates them). Pre-validate continues to catch other missing anchors after ensure runs.

**Alternative considered:** Teach `patchReleasePlanRow` to insert — rejected to avoid mixing “mark shipped” with “create planned work,” and to keep tests for ship-mark vs ensure independent.

### D3 — Theme and issues sourcing for the scaffolded row

**Theme priority:**

1. Optional CLI `--theme "<text>"` when provided.
2. Else GitHub milestone title matching the resolved version (e.g. title contains `v1.29.0` / `1.29.0`), when discovery is available on the live path.
3. Else documented placeholder (existing `<theme>` convention is acceptable).

**Issues column:** Prefer a compact list from (a) milestone open+closed issues when milestone discovery is available, and/or (b) issue numbers already resolved from shipped PRs / git log on the path that has them. Dry-run / early pre-validate may use a placeholder issue list or git-log-only set if GitHub is skipped — must not invent issue numbers.

**Bump column:** Derive from existing `versionBumpType(version)` (`major` / `minor` / `patch`).

**Why column:** Short scaffold note such as “Scaffolded by `pipeline release` for vX.Y.Z cut.” (human may edit in `$EDITOR`).

**Alternative considered:** Require `--theme` always when scaffolding — too strict for the happy path where milestone title exists.

### D4 — When ensure runs relative to version bump and clean-tree

**Choice:** Keep pre-validate **before** package writes. Ensure runs inside that in-memory scaffold. No disk write of ROADMAP until the existing live write path after CI (unchanged ordering for durable mutations). Dry-run continues to show the ROADMAP diff including the inserted row without writing.

**Why:** Preserves “missing other anchors abort before version bump” and clean-tree / rollback contracts. Insert is still visible in dry-run and editor.

### D5 — Documentation single-source

**Choice:** Document the row shape in release usage/help and host SKILL as the same five-column table row produced by `insertReleasePlanRow` / consumed by `patchReleasePlanRow`. Implementation may export a constant string or shared comment + test that help text contains the canonical example rather than inventing a third parser.

**Why:** AC requires single conceptual source with `patchReleasePlanRow`; drift between help and code is the recurring failure mode.

### D6 — Failure shape when insert is impossible

**Choice:** Structured error that includes at least:

- path: `ROADMAP.md`
- anchor name (e.g. `release-plan-none-row` or `release-plan-table`)
- copy-pasteable example row for `v{version}`
- instruction: insert before the `| *(none)* |` sentinel (or restore the release-plan table)

Exit non-zero before version bump.

**Why:** Matches doctor-grade remediation intent from option B without making fail-closed the default when insert is possible.

## Risks / Trade-offs

- **[Risk] Scaffolded theme/issues are wrong** → Mitigation: editor review by default; dry-run shows diff; `--theme` override; why-column marks row as scaffolded.
- **[Risk] Duplicate rows if match logic is wrong** → Mitigation: exact `| **v{version}**` prefix match consistent with `patchReleasePlanRow`; shipped detection via `✅ shipped`; unit tests for both.
- **[Risk] Behavioral change for operators who used abort as a checklist** → Mitigation: still fail closed when table/sentinel broken; document new behavior in help/SKILL; FRG already expected scaffold.
- **[Risk] Milestone API failure mid-release** → Mitigation: theme/issues fall back to placeholders / git-log set; do not block ensure solely on milestone fetch if insert is otherwise possible (prefer progress + editor).
- **[Trade-off] No version-aware doctor check in this change** → Acceptable; ensure + dry-run cover the release path. Follow-up can add `pipeline release --check` sharing `ensureReleasePlanRow` in report-only mode if operators want it outside full release.

## Migration Plan

1. Land pure ensure helper + unit tests (bite-first missing-row test fails on current code, then passes).
2. Wire ensure into `scaffoldRoadmap`; confirm dry-run and pre-validate paths.
3. Wire optional `--theme` and milestone/git-log sourcing on the orchestration path.
4. Update help/SKILL docs; regenerate `plugin/` if hosts change.
5. No data migration; existing ROADMAPs with correct rows behave as today.

Rollback: revert the change; release returns to hard-abort on missing plan row.

## Open Questions

- None blocking. Optional later: expose report-only ensure via `pipeline release --check <version>` without package bump (share helper; not required for #730 acceptance if dry-run already shows the insert).
