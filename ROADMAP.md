# Roadmap

This file is human-readable forward-looking documentation for open work. **GitHub milestones** are the authoritative store for which issues are planned for each SemVer release (`pipeline roadmap --apply` writes them; `pipeline release` reads them). Theme labels remain as secondary scope labels. Release history is in [CHANGELOG.md](CHANGELOG.md). Last updated 2026-08-11.

## Roadmap rules

- Every open issue belongs to exactly one full SemVer release milestone.
- A theme label groups related work. It does not replace a release milestone.
- A patch contains compatible fixes, documentation, or internal hardening. A minor contains compatible new capability. A major requires an approved breaking public-contract change.
- There is no current major release. No approved open issue requires a breaking change.
- If #842 selects a breaking default or removal, move that issue to a separately approved major release before implementation.
- Milestone order follows declared dependencies. Within a milestone, prerequisite issues must integrate before dependent issues start.
- Historical shipped milestones stay closed and unchanged. The milestones below contain only open work.
- Obsolete fixture issues #749 and #750 are closed and are not part of the forward plan.

## Release plan

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.33.0** ✅ shipped | minor | Scoped Hermes factory and startup corrections | #898, #905, #874, #870 | Shipped 2026-08-10 (tag `v1.33.0`). See CHANGELOG.md. |
| **v1.34.0** ✅ shipped | minor | Durable factory core and native release preparation | #890, #891, #908, #909 | Shipped 2026-08-10 (tag `v1.34.0`). See CHANGELOG.md. |
| **v1.35.0** ✅ shipped | minor | Release, roadmap correctness, and supervisor hardening | #910, #978, #980, #983 | Shipped 2026-08-11 (tag `v1.35.0`). See CHANGELOG.md. |
| **v1.36.0** ✅ shipped | minor | Roadmap reconciliation | #985 | Shipped 2026-08-11 (tag `v1.36.0`). See CHANGELOG.md. |
| **v1.37.0** ✅ shipped | minor | Human authority and evidence | #575, #576, #691–#695, #702, #599, #647, #703 | Shipped 2026-08-12 (tag `v1.37.0`). See CHANGELOG.md. |
| **v1.38.0** ✅ shipped | minor | Factory operations | #892–#896 | Shipped 2026-08-13 (tag `v1.38.0`). See CHANGELOG.md. |
| **v1.39.0** ✅ shipped | minor | Hermes and Buzz integration | #907, #897 | Shipped 2026-08-15 (tag `v1.39.0`). See CHANGELOG.md. |
| **v1.40.0** | minor | Qualified issue integration | #662, #899, #900, #906 | Add evidence-qualified authority, a privilege broker, exact-head merge service, and durable merge actions. |
| **v1.41.0** | minor | Autonomous release and engine promotion | #902, #903 | Add release finalization and exact-tag self-update with rollback. |
| **v1.42.0** | minor | Work breakdown | #766 | Add epic decomposition into dependency-linked issues and a delivery roadmap. |
| **v1.43.0** | minor | Forge portability | #648–#650 | Add the ForgeAdapter contract, extraction, and first opt-in GitLab adapter. |
| **v1.44.0** | minor | Evaluation campaigns | #600, #602–#604, #653–#655, #657, #661, #739, #740 | Add reproducible campaign selection, evidence, orchestration, recommendations, and quality fixtures. |
| **v1.45.0** | minor | Cross-backend quality | #737, #738, #781, #785 | Add provider-neutral invariants, capability negotiation, shadow rollout, and rollback policy. |
| **v1.46.0** | minor | Execution backends and isolation | #587, #589–#591, #618, #842 | Add compatible local, remote-VM, and Kubernetes execution paths with explicit isolation controls. |
| **v1.47.0** | minor | Customer-hosted adoption | #598, #651 | Publish versioned docs and add the demand-gated Gitea/Forgejo adapter after the execution and GitLab boundaries are proved. |
| **v1.48.0** | minor | Repository context | #806–#813 | Add commit-local repository maps, queries, exploration, and evaluated retrieval. |
| **v1.49.0** | minor | Warrant context | #798–#805 | Add sanitized cross-run experience, bounded retrieval, consumption, and rollout evidence. |
| **v1.49.1** | patch | Pre-merge and GitHub efficiency | #816–#823 | Reduce redundant reads and rate-limit exposure without removing a gate or review. |
| **v1.49.2** | patch | Run, evidence, and harness efficiency | #824–#832 | Improve bounded local I/O and reuse without changing behavior. |
| **v1.49.3** | patch | Batch, CI, cache, and event efficiency | #833–#840 | Parallelize independent work and add call-budget checks without reducing rigor. |
| **v1.38.1** ✅ shipped | patch | v1.38.1 | #1020, #1021, #1023, #1025, #1028, #1029, #1030 | Shipped 2026-08-13 (tag `v1.38.1`). See CHANGELOG.md. |
| **v1.39.1** ✅ shipped | patch | v1.39.1 | #1047, #1054, #1062, #1063, #1065, #1068, #1073, #1074, #1081 | Shipped 2026-08-15 (tag `v1.39.1`). See CHANGELOG.md. |
| **v1.39.2** ✅ shipped | patch | v1.39.2 | #1036, #1037, #1038, #1039, #1040, #1041, #1092, #1095, #1098, #1099, #1103 | Shipped 2026-08-17 (tag `v1.39.2`). See CHANGELOG.md. |
| **v1.39.4** ✅ shipped | patch | v1.39.4 | #1096, #1110, #1111, #1127 | Shipped 2026-08-18 (tag `v1.39.4`). See CHANGELOG.md. |
| **v1.39.5** ✅ shipped | patch | v1.39.5 | #1132, #1133, #1147, #1148, #1149, #1150, #1151 | Shipped 2026-08-20 (tag `v1.39.5`). See CHANGELOG.md. |
| **v1.39.6** ✅ shipped | patch | v1.39.6 | #1162, #1163, #1164, #1165, #1166, #1167 | Shipped 2026-08-20 (tag `v1.39.6`). See CHANGELOG.md. |
| *(none)* | — | Unscheduled / no release | — | _Structural insertion anchor for `intake` and `sweep` — do not remove._ |

## Per-issue plan

| # | Impact | Config | Theme | → Release | Depends on |
|---|--------|--------|-------|-----------|------------|
| #898 | minor | machine-local, default off | Hermes/Buzz factory | ✅ v1.33.0 | — |
| #905 | patch | none | dependency discovery | ✅ v1.33.0 | — |
| #874 | patch | none | gate recovery | ✅ v1.33.0 | #905 |
| #870 | patch | none | review routing | ✅ v1.33.0 | #905, #874 |
| #890 | minor | none | durable factory core | v1.34.0 | — |
| #891 | minor | none | factory health | v1.34.0 | #890 |
| #908 | minor | default off | FRG and release preparation | v1.34.0 | #890, #891 |
| #909 | patch | none | roadmap correctness | ✅ v1.34.0 | — |
| #901 | — | — | integrated completion (closed-unmerged) | — | superseded; never shipped |
| #765 | — | — | post-loop integration (closed-unmerged) | — | superseded; never shipped |
| #910 | minor | opt-in | roadmap reconciliation | ✅ v1.35.0 | #909 |
| #978 | fix | none | release docs | ✅ v1.35.0 | — |
| #980 | minor | opt-in | git-push auth | ✅ v1.35.0 | — |
| #983 | fix | none | ship supervisor | ✅ v1.35.0 | — |
| #575 | minor | opt-in | human authority | v1.37.0 | — |
| #576 | minor | none | production outcomes | v1.37.0 | — |
| #691 | minor | none | trusted verification | v1.37.0 | — |
| #692 | minor | none | evidence identity | v1.37.0 | #691 |
| #693 | minor | opt-in | override authority | v1.37.0 | #575, #692 |
| #694 | minor | opt-in | reviewer independence | v1.37.0 | #692 |
| #695 | minor | opt-in | policy rollout | v1.37.0 | #692, #693, #694 |
| #702 | minor | none | rework telemetry | v1.37.0 | #576 |
| #599 | minor | none | intent lineage | v1.37.0 | #575, #576, #692 |
| #647 | minor | opt-in | human handoffs | v1.37.0 | #575 |
| #703 | minor | none | planning research | v1.37.0 | #599, #702 |
| #892 | minor | none | factory watch | v1.38.0 | #890, #891 |
| #893 | minor | none | factory observer | v1.38.0 | #891, #892 |
| #894 | minor | opt-in | factory controls | v1.38.0 | #647, #890, #891 |
| #895 | minor | opt-in | provider cooldowns | v1.38.0 | #890, #891 |
| #896 | minor | opt-in | intake admission | v1.38.0 | #890, #894 |
| #907 | minor | opt-in | host-neutral integration | v1.39.0 | #891, #892, #894 |
| #897 | minor | machine-local, default off | Hermes/Buzz productization | v1.39.0 | #891, #892, #894, #907 |
| #662 | minor | default off | merge qualification | v1.40.0 | #306, #501, #599, #646 |
| #899 | minor | default off | authority broker | v1.40.0 | #890, #894 |
| #900 | minor | default off | exact-head merge | v1.40.0 | #662, #899 |
| #906 | minor | default off | durable merge action | v1.40.0 | #662, #890, #899, #900, #901 |
| #902 | minor | default off | release finalization | v1.41.0 | #899, #900, #908 |
| #903 | minor | default off | engine promotion | v1.41.0 | #894, #899, #902 |
| #766 | minor | opt-in | work breakdown | v1.42.0 | — |
| #648 | minor | none | ForgeAdapter design | v1.43.0 | — |
| #649 | patch | none | ForgeAdapter extraction | v1.43.0 | #648 |
| #650 | minor | opt-in | GitLab adapter | v1.43.0 | #649 |
| #600 | minor | none | evaluation tracker | v1.44.0 | — |
| #602 | minor | opt-in | treatment discovery | v1.44.0 | #601 |
| #603 | minor | opt-in | campaign templates | v1.44.0 | #601 |
| #604 | minor | opt-in | recommendations | v1.44.0 | #603 |
| #653 | minor | none | usage provenance | v1.44.0 | #601 |
| #654 | minor | opt-in | campaign controller | v1.44.0 | #601, #602, #603, #637 |
| #655 | minor | opt-in | evaluation command | v1.44.0 | #604, #654 |
| #657 | patch | none | paired planning parity | v1.44.0 | #601, #637 |
| #661 | minor | opt-in | judge qualification | v1.44.0 | #433, #536, #603 |
| #739 | minor | opt-in | treatment axes | v1.44.0 | #603 |
| #740 | minor | none | hidden quality fixtures | v1.44.0 | #603 |
| #737 | minor | opt-in | prompt invariants | v1.45.0 | #739, #740 |
| #738 | minor | opt-in | capability negotiation | v1.45.0 | #739, #740 |
| #781 | minor | opt-in | promotion policy | v1.45.0 | #737, #738 |
| #785 | minor | opt-in | shadow and canary rollout | v1.45.0 | #781 |
| #587 | minor | opt-in | executor wire contract | v1.46.0 | — |
| #589 | minor | opt-in | local execution adapter | v1.46.0 | #587 |
| #618 | minor | opt-in | worker isolation | v1.46.0 | #589 |
| #590 | minor | opt-in | remote-VM worker | v1.46.0 | #589, #618 |
| #591 | minor | opt-in | Kubernetes workers | v1.46.0 | #590 |
| #842 | minor | decision-gated | Codex isolation posture | v1.46.0 | #618 |
| #598 | patch | none | documentation site | v1.47.0 | #587, #589, #590, #591 |
| #651 | minor | opt-in, demand-gated | Gitea/Forgejo adapter | v1.47.0 | #649, #650 |
| #806 | minor | none | repository-context design | v1.48.0 | — |
| #807 | minor | opt-in | repository snapshots | v1.48.0 | #806 |
| #808 | minor | opt-in | repository maps | v1.48.0 | #807 |
| #809 | minor | opt-in | symbol and dependency queries | v1.48.0 | #807 |
| #810 | minor | opt-in | scout and hydrate | v1.48.0 | #808, #809 |
| #811 | minor | opt-in | repository explorer | v1.48.0 | #810 |
| #812 | minor | opt-in | semantic locator experiment | v1.48.0 | #806, #807 |
| #813 | minor | opt-in | repository-context evaluation | v1.48.0 | #807, #808, #809, #810, #811, #812 |
| #798 | minor | none | Warrant design | v1.49.0 | #576, #587, #590 |
| #799 | minor | opt-in | immutable run cards | v1.49.0 | #576, #798 |
| #800 | minor | opt-in | experience ingest | v1.49.0 | #799 |
| #801 | minor | opt-in | Context API | v1.49.0 | #800 |
| #802 | minor | opt-in | stage consumption | v1.49.0 | #801 |
| #803 | minor | opt-in | retrieval telemetry | v1.49.0 | #802 |
| #804 | minor | opt-in | locator experiment | v1.49.0 | #798, #801 |
| #805 | minor | opt-in | combined context evaluation | v1.49.0 | #803, #804, #813 |
| #816 | patch | none | pre-merge efficiency | v1.49.1 | — |
| #817 | patch | none | diff-fetch efficiency | v1.49.1 | — |
| #818 | patch | none | PR-read reuse | v1.49.1 | — |
| #819 | patch | none | actor memoization | v1.49.1 | — |
| #820 | patch | none | PR batch fetch | v1.49.1 | #819 |
| #821 | patch | none | issue-read efficiency | v1.49.1 | #819 |
| #822 | patch | none | loop reconcile concurrency | v1.49.1 | — |
| #823 | patch | none | incremental loop events | v1.49.1 | #822 |
| #824 | patch | none | run-store scan scope | v1.49.2 | — |
| #825 | patch | none | evidence redaction efficiency | v1.49.2 | — |
| #826 | patch | none | status-read concurrency | v1.49.2 | — |
| #827 | patch | none | CLI state reuse | v1.49.2 | — |
| #828 | patch | none | harness tail capture | v1.49.2 | — |
| #829 | patch | none | design-gate worktree lookup | v1.49.2 | — |
| #830 | patch | none | review retry reuse | v1.49.2 | — |
| #831 | patch | none | worktree tip reuse | v1.49.2 | — |
| #832 | patch | none | cleanup classification | v1.49.2 | — |
| #833 | patch | none | planning and loop fan-out | v1.49.3 | — |
| #834 | patch | none | FRG and merge-queue batching | v1.49.3 | — |
| #835 | patch | none | roadmap issue-fetch reuse | v1.49.3 | #910 |
| #836 | patch | none | CI concurrency | v1.49.3 | — |
| #837 | patch | none | install reuse | v1.49.3 | — |
| #838 | patch | none | GitHub read cache | v1.49.3 | #819, #820, #821 |
| #839 | patch | none | call-budget regression gate | v1.49.3 | #838 |
| #840 | patch | opt-in | asynchronous event sink | v1.49.3 | #823 |
| _(anchor)_ | — | — | structural insertion anchor for `intake` and `sweep` (do not remove) | *(none)* | — |

## Theme labels

Theme labels remain on issues to support search and ownership. They do not replace milestones.

| Theme label | Issues | Scope |
|---|---|---|
| `theme:loop-correctness` | #765 | Dependency-safe loop and integration behavior. |
| `theme:factory-operations` | #892–#896, #909, #910, #985 | Factory control, observation, and roadmap operations. |
| `theme:hermes-buzz` | #897, #907 | Hermes and Buzz integration. |
| `theme:autonomous-delivery` | #662, #899, #900, #902, #903, #906, #908 | Qualified merge, release, and engine promotion. |
| `theme:human-evidence` | #575, #576, #599, #647, #691–#695, #702, #703 | Human authority, evidence, intent, and outcomes. |
| `theme:work-breakdown` | #766 | Epic decomposition and delivery planning. |
| `theme:forge-portability` | #648–#651 | Forge abstraction and adapters. |
| `theme:evaluation` | #600, #602–#604, #653–#655, #657, #661, #739, #740 | Evaluation campaigns and evidence. |
| `theme:cross-backend-quality` | #737, #738, #781, #785 | Provider-neutral quality and rollout. |
| `theme:execution-backends` | #587, #589–#591, #618 | Execution protocols and workers. |
| `theme:repository-context` | #806–#813 | Commit-local repository context. |
| `theme:warrant-context` | #798–#805 | Cross-run Warrant context. |
| `theme:performance` | #816–#840 | Rigor-preserving efficiency. |
| `theme:adoption` | #598 | Documentation and adoption. |
| `theme:isolation` | #842 | Process and privilege isolation. |

## Factory delivery rule

The normal Pipeline state machine still stops at `pipeline:ready-to-deploy`. The disabled scoped Hermes wrapper is the only planned autonomous-delivery exception. It must have an authenticated immutable grant for the exact repository, base, version, issue order, actions, model, and expiry.

Dependency-bearing issues run as one-item waves until integrated completion is available and proved. For each issue, Hermes runs `pipeline single <issue>`, waits for ready-to-deploy, invokes `pipeline merge <pr>` under the grant, records the pull request's merge-result commit, fetches the base, and proves containment before it starts the next issue. Grok planning, implementation, and fixes use only `grok-4.6`; Codex reviews.

After the issue train, the factory must run a fresh representative FRG for the exact version. Evidence must be real, current, release-eligible, and attested. No invented observation, stale pack, or soak override is allowed. `pipeline release <version> --no-edit` remains prepare-only. A separate exact-head finalizer merges the release pull request, verifies the annotated tag and published GitHub Release, promotes the production pin, installs the exact tag, runs `pipeline doctor --json --harness-smoke`, and proves that the next run uses the new version.

Hermes reports material events and bounded heartbeats in the private `pipeline-factory` Buzz stream. Buzz failure never changes Pipeline truth. A stop, expiry, drift, failed check, blocked state, FRG failure, ambiguous mutation, publication mismatch, install failure, or unproved rollback stops the factory before the next mutation. Rollback installs the last verified production pin and runs doctor; it does not rewrite merged work, tags, or releases.

The detailed trust boundary and runbook are in [docs/grok-supervised-factory-plan.md](docs/grok-supervised-factory-plan.md).
