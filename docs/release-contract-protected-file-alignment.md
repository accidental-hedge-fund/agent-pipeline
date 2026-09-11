# Protected-file alignment with the live release contract

Issue #1564 / package 5 requires a committed report of protected
`CLAUDE.md`, rules, settings, and commands versus the live contract:

- **direct-release:** independent `pipeline release VERSION` completes the
  SemVer contract for an exact candidate. It does not deploy, promote, or
  install.
- **ship-final-delegation:** SemVer `pipeline ship --milestone` trains, then
  delegates once to that release. It does not deploy, promote, or install.
- Historical optional-FRG, `release finish` as a tag or publish owner, and
  ship-promotion are not the live procedure.

This change does not edit those protected files.

## Scan (this worktree)

| Path | Present | Alignment |
|---|---|---|
| `CLAUDE.md` | yes | Agrees. It names operator-authorized `pipeline merge`, `pipeline merge-queue --apply`, `pipeline train --merge`, and `pipeline ship --milestone`. It does not present optional-FRG, `release finish` as tag/publish owner, or ship-promotion as the live command contract. |
| `AGENTS.md` | yes | Agrees. Same operator-authorized merge/ship boundary. No live optional-FRG, finish-as-release-owner, or ship-promotion procedure. |
| `.claude/rules/` | no | Absent. No disagreement to report. |
| `settings.json` | no | Absent in this repository. No disagreement to report. |
| `.claude/commands/` | yes | OpenSpec `opsx/*` helpers only. No pipeline `release` / `ship` command files. No disagreement with the live contract. |

## Required alignment

None. The protected files already agree with direct-release and
ship-final-delegation, or they do not describe a release procedure.
