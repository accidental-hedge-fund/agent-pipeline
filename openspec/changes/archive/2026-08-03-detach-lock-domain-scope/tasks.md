## 1. Unified issue-run lock API (`core/scripts/lock.ts`)

- [x] 1.1 Consolidate path construction so the per-issue mutex identity is always
      `(domain, issueNumber)` and never issue-number-only; export a single shared helper
      used by advance and detach.
- [x] 1.2 Ensure acquire/release (and stale-PID recovery) for that identity live in one
      implementation; prefer preserving detach’s stronger `pid [starttime]` marker body on
      the shared path when consolidating.
- [x] 1.3 Keep legacy domain-wide (no issue) lock behavior for existing callers that omit
      `issueNumber`; do not change queue-batch or live-planning locks in this change.

## 2. Detach consumers (`core/scripts/detach.ts`)

- [x] 2.1 Thread domain into `issueRunsDir` / `lockFilePath` / wrapper acquire (and any
      spawnDetached deps) so paths and locks are domain-scoped.
- [x] 2.2 Acquire the **shared** issue-run lock API for `(domain, issue)` instead of a
      private issue-only lock; preserve wrapper-owns-lock + launcher handshake semantics.
- [x] 2.3 Derive domain consistently with advance (config domain / `--domain` / basename of
      resolved repo) before creating lock or wrapper run-dir artifacts.

## 3. Advance and probe wiring

- [x] 3.1 Confirm `pipeline-run.ts` (and other advance entry points) acquire the same shared
      identity so a live detach holder blocks foreground advance for that key.
- [x] 3.2 Update `live-advance.ts` (and callers) to resolve lock/marker paths with domain so
      coexistence probes match the unified key (no cross-domain false live).
- [x] 3.3 Audit other readers of `lockFilePath` / `issueRunsDir` / detach `.lock` and pass
      domain where required.

## 4. Docs and concurrency-scope disposition

- [x] 4.1 Update project operating guidance (`CLAUDE.md` / `AGENTS.md` concurrency notes) to
      state the unified issue-run lock is host-local and domain+issue keyed for advance and
      detach.
- [x] 4.2 Record the cross-host assessment row for the unified issue-run lock (single-host
      disposition; no distributed lock claim).

## 5. Tests

- [x] 5.1 Cross-domain non-collision: same issue number under two domains can both hold
      locks (prove the test fails against issue-only path construction).
- [x] 5.2 Dual-entry exclusion: detach holder blocks advance for the same `(domain, issue)`
      and advance holder blocks detach for that key.
- [x] 5.3 Different issues under one domain remain concurrent; same domain+issue second
      acquire is rejected/held.
- [x] 5.4 Live-advance probe: cross-domain lock/wrapper does not count as live for this
      domain’s item; same-domain live lock still does.
- [x] 5.5 All new tests inject I/O via seams — no real network, git, or subprocess.

## 6. Mirror, validate, gate

- [x] 6.1 After core edits: `node scripts/build.mjs` and commit regenerated `plugin/` with
      the implementation change.
- [x] 6.2 `openspec validate detach-lock-domain-scope` passes.
- [x] 6.3 `npm run ci` passes from repo root.
