## Why

The installed skill (`~/.claude/skills/pipeline`) keeps running whatever engine
version it was installed at, with no signal that the source repo has shipped newer
releases. On 2026-07-06 the installed engine was v1.13.0 while `main` had already
merged #379 (fix for #371: pre-merge auto-fix re-review anchoring to the stale
pre-fix diff) — and that stale engine reproduced exactly the fixed bug on this repo.
A 20-issue castrecall run on 2026-07-06/07 burned at least four review rounds
re-hitting that already-fixed stale-verdict bug because nobody noticed the install
lagged the shipped fix.

The existing `install:version-coherence` check only catches an install whose *running
code* and *on-disk `core/package.json`* disagree; it says nothing about whether that
(coherent) install is behind the latest **released** engine. Operators have no doctor
warning and no documented one-step update command, so a stale install silently
degrades every run until someone notices.

## What Changes

- Add an `install:version-freshness` preflight check to `pipeline doctor` that
  compares the installed engine version against the latest `accidental-hedge-fund/agent-pipeline`
  GitHub **release tag** and reports up-to-date vs. behind.
- Introduce a non-blocking `warn` status to the doctor check model (the JSON envelope
  already reserves `status: "warnings"` for exactly this) so "behind" surfaces loudly
  without failing the preflight or aborting a `--doctor` / `runOnStart` run — a stale
  install still works, it just isn't current.
- Degrade gracefully offline: an unreachable release lookup reports `skip`
  ("skipped (offline)") and never fails or warns.
- Document a one-step, idempotent update command that reuses the existing installer
  `update` verb to refresh the installed skill in place, and name it in the check's
  remediation. The check only reports — updating stays an explicit operator action.
- Surface the same freshness check at run start under `--doctor` / `doctor.runOnStart`.

## Acceptance Criteria

- [ ] `pipeline doctor` output includes an `install:version-freshness` check.
- [ ] When the installed engine version is **older** than the latest release tag, the
      check reports `warn`, names both the installed and latest versions, and gives a
      one-line remediation containing the documented update command.
- [ ] When the installed engine version is **equal to or newer than** the latest
      release tag (including an unreleased dev build ahead of the tag), the check
      reports `pass`.
- [ ] When the release lookup is unreachable (offline / `gh` failure / empty or
      unparseable output), the check reports `skip` ("skipped (offline)") and never
      fails or warns the preflight.
- [ ] A `warn` status never sets exit code 1 and never aborts a `--doctor` /
      `doctor.runOnStart` run; the run proceeds to planning.
- [ ] `pipeline doctor --json` emits top-level `status: "warnings"` (and the freshness
      check record carries per-check `status: "warn"`) when the only non-pass result is
      the freshness warn.
- [ ] Running the documented update command
      (`npx github:accidental-hedge-fund/agent-pipeline update`) refreshes the installed
      skill in place; a second run is a net no-op (idempotent).
- [ ] The freshness check never mutates the install — it only reports.
- [ ] `--doctor` / `doctor.runOnStart` surface the freshness check at run start; a
      stale install prints the warning but the run still proceeds.
- [ ] Unit tests cover behind→warn, up-to-date→pass, ahead-of-release→pass, and
      offline→skip through injected deps with no real network, git, or subprocess calls.

## Capabilities

### New Capabilities
- `installed-engine-freshness`: the version-freshness doctor check (compare installed
  engine version to the latest release tag, offline-skip, report-only) plus the
  documented idempotent in-place update command.

### Modified Capabilities
- `doctor-preflight`: introduce a non-blocking `warn` check status and un-reserve the
  `warnings` value of the doctor JSON envelope `status` field.

## Impact

- `core/scripts/stages/doctor.ts` — new check, `warn` status in the check model,
  summary + JSON formatters, and the `ok` / exit-code / run-start gating so `warn`
  never blocks.
- The doctor `--json` envelope schema (adds per-check `status`; un-reserves top-level
  `warnings`) — additive; existing consumers reading `name`/`ok`/`reason`/`fix` are
  unaffected.
- README and host skill docs — document the update command and the freshness check.
- Generated `plugin/` mirror after the core + docs changes.
- No change to the freeform (non-OpenSpec) path and no new auto-update surface.
