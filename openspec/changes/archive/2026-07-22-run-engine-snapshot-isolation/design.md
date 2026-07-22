# Design — run-engine snapshot isolation (#450)

## Context

The failure is a read-time skew inside one process:

| Artifact class | When it is read | Effect of a mid-run overwrite |
| --- | --- | --- |
| `scripts/*.ts` (module graph) | once, at process start, by the ESM loader | none — the process keeps the old graph |
| `prompts/*.md` | at every `build*Prompt()` call (`fs.readFileSync`) | the new file is used by the old builder |
| `profiles/*`, `package.json` | at process start / on demand | mixed |

Only the middle row is actually skewed, which is why the observed crash was a template/builder
placeholder mismatch and not, say, a type error. Fixing the read timing of that row removes the
entire crash class.

## Decision 1 — Pin templates in memory, not by copying the skill tree

The issue's expected behavior offers two options: pin at run start, or copy the skill tree into the
run dir. We pin.

Copying the tree per run would: duplicate `scripts/` and require `node_modules` provisioning per
run (already an install-time cost we deliberately avoid re-paying), change the meaning of every
`import.meta.url`-relative path in the engine, and complicate `pipeline logs`/`path` discovery —
all to isolate one file class the copy would isolate only incidentally. An in-memory snapshot of the
templates is a few kilobytes, has no lifecycle, and is exactly as strong for the observed defect.

**Shape.** `prompts/index.ts` keeps `loadTemplate(name)` as the single read seam, but backs it with
a module-scope snapshot populated at module initialization by enumerating the `*.md` files next to
`index.ts`. `loadTemplate` becomes a map lookup; an unknown name throws the same shape of error it
throws today for a missing file. Because Node evaluates the module once per process, and the
orchestrator loads it before the first stage, the snapshot is taken at process start.

**Why eager enumeration rather than lazy memoization.** Lazy memoization would still read the
*first* use of each template at stage time — so a run whose first `fix-1` happens after an update
would read the new `fix.md`, i.e. the exact 2026-07-08 incident. Eager wins.

**Test seam.** The enumeration/read is injected (a `readTemplates` dep with a filesystem default,
plus an exported `__resetTemplateSnapshotForTests()`), so the swap regression test can populate a
snapshot, rewrite the on-disk file, and assert the built prompt is unchanged — with no real
`~/.claude` involvement.

## Decision 2 — Record engine identity, report drift, do not remediate

A run that has already loaded old code cannot adopt new code. The only honest responses are (a) keep
running against the pinned snapshot and (b) say so. Blocking the run would convert an update — a
routine, operator-initiated action — into a pipeline outage; killing it would destroy in-flight
worktree work, which this repo has repeatedly decided against (`fix-harness-crash-retry`,
`harness-uncommitted-salvage`).

So drift is **observability**, and its value is attribution: incident 2's silent prompt-mitigation
revert would have left an `engine_drift` event naming `1.15.1 → 1.15.2` at the exact stage boundary
where behavior changed.

**Fingerprint.** Version alone is insufficient — the 2026-07-21 incident included a *host-local*
prompt edit reverted by an update at an unchanged-looking boundary. The fingerprint is a hash over
the pinned template set (sorted `name:sha256(content)` pairs, hashed), so a content change with no
version bump is still detected. It is computed from the already-loaded snapshot at run start, and by
re-reading the directory at probe time.

**Probe placement and cost.** Once per stage boundary, not per prompt build: a stage is minutes of
wall clock, so ~20 small file reads are free, and the boundary is where drift becomes attributable
to a behavior change. The probe is wrapped so any throw degrades to "no drift observed".

**One event per transition, not per boundary.** A long run after an update would otherwise emit an
`engine_drift` event at every remaining stage. The orchestrator remembers the last observed identity
and emits only on change, so the events read as a timeline of updates.

## Decision 3 — The installer defers on live locks, and only on live locks

`PipelineLock` already writes `/tmp/pipeline-{domain}[-{issue}].lock` containing the owning PID, and
already implements the correct liveness semantics (`process.kill(pid, 0)`; `ESRCH` ⇒ stale, `EPERM`
⇒ conservatively treat as held, garbage contents ⇒ stale). The installer reuses those semantics
rather than inventing a second sentinel.

**Why the lock and not the run store.** Run directories are per-repo (`<repo>/.agent-pipeline/runs`)
and the installer has no repo list; `/tmp/pipeline-*.lock` is the one host-global, already-maintained
signal of "a run is live on this machine". A run store sentinel would be a new invariant to keep
true across crashes; the lock's PID liveness check is self-healing by construction.

**Failure direction.** Refuse (exit non-zero) rather than warn-and-proceed. A deferred update costs
the operator one retry; a raced update costs a run. `--force` keeps the escape hatch for the case
where a lock is held by a process the operator knows is wedged, and prints the same details.

**Scope.** The guard runs before *any* file is copied, so a refusal leaves the install byte-identical
— important because a half-copied core is strictly worse than either version. `install` onto a host
with no existing core cannot race a run against that core and is not guarded; `uninstall` is out of
scope for this change.

## Risks

- **The `--force` path still races.** Accepted and documented: it is explicit operator intent, and
  the drift event (Decision 2) makes the consequence attributable.
- **Snapshot staleness in a very long-lived process.** A run that legitimately wants new templates
  must be restarted. That is the intended semantic — "a run executes against one snapshot" — and it
  matches how the code half of the engine has always behaved.
- **`run.json` schema addition.** `schema_version` stays `1`: the change is a purely additive
  optional object, and existing readers (`pipeline status`, `logs`, Pipeline Desk) ignore unknown
  fields. Runs written before this change have no `engine` object; drift detection treats an absent
  pin as "nothing to compare" and stays silent rather than reporting spurious drift.
