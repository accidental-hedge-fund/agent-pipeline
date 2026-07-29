## Context

Single-issue detach already solves harness discoverability: `pipeline <N> --detach` (and
the `run` alias) pre-allocates a run-store id, writes `run-store.json` with absolute
`events` / `terminal_log` paths, prints the wrapper dir on stdout, and exits while the
child continues. A harness arms Monitor / `pipeline logs <id> --events --follow` from that
pointer without waiting for the advance to finish.

The durable loop path is different in process shape but the same in operator need:

1. `runLoopCommand` preflights, then `await`s `defaultRunLoopEngine` → `driveSupervisor`
   until a terminal condition.
2. Only then does it `console.log` a terminal JSON blob with `run_id`.
3. Durable events already stream into
   `<state-home>/runs/<run_id>/events.jsonl` for the whole wall-clock of the run — but the
   CLI never advertises that path (or the run id) until the end.
4. Host packaging (`plugin/pipeline/commands/pipeline:loop.md`) still says the command
   “completes in seconds” and “No Monitor needed,” which was true only when the facade
   printed a short-lived delegation payload for an external skill — not for the in-repo
   multi-item supervisor.

The loop process **stays in the foreground** for the whole run (this change does not
detach the loop). The missing piece is an **early identity advertisement** so a streaming
harness can parse `run_id` + `events` path within seconds of successful create/lock and
follow progress while the same process continues dispatching items.

Related cluster (out of scope here): #666 loop logs follow, #667 dispatch→advance run_id
linkage, #668 skill orchestration rewrite. Suggested order already lists this handoff
first.

## Goals / Non-Goals

**Goals:**

- Emit a machine-readable early handoff as soon as a durable run is ready to drive
  (directory exists, exclusive lock held) and before the first item dispatch can block.
- Make the handoff parseable without scraping prose; distinguish it from the terminal
  summary.
- Flush so a piped/streaming consumer sees the handoff while the supervisor is still
  running.
- Cover resume as well as fresh start; keep preflight/failure paths free of successful
  handoff and free of new durable writes.
- Correct host packaging guidance that currently denies the need for progress follow.
- Keep changes surgical and testable through existing dependency seams.

**Non-Goals:**

- Detaching the loop process or inventing a second run-id namespace.
- Rewriting durable store document layout / schema ids (no new required store file for
  v1 of this change).
- Bridging loop events to per-item advance `events.jsonl` or linking child advance run ids
  (#667).
- A new `pipeline logs` follow mode for loop runs (#666) — handoff only advertises the
  existing events path so a later follow command (or a simple file tail) can use it.
- Auto-merge, review demotion, or any change to per-item pipeline stage ownership.

## Decisions

### Decision 1 — Stdout JSON handoff with a kind discriminator (not a new durable store file)

**Choice:** Emit one JSON object on **stdout** as soon as the run is ready, carrying at
minimum:

| field | meaning |
|-------|---------|
| `schema_version` | `"1"` (string, matches loop CLI terminal payload convention) |
| `kind` | `"loop_run_handoff"` — discriminator |
| `run_id` | durable loop run id |
| `run_dir` | absolute path to `<state-home>/runs/<run_id>` |
| `events` | absolute path to that run's `events.jsonl` |
| `engine` | acting engine (`claude` \| `codex`) |
| `resumed` | whether this process attached via resume semantics |
| `selector` | optional normalized selector summary when known; `null` on bare `--resume` |

**Why not a pointer file in the run directory (like detach's `run-store.json`)?** The
durable loop store already owns a fixed layout (contract, ledger, lock, events, decisions,
plus supervisor/action-evidence artifacts). Adding a required new file is a store-schema
concern the issue explicitly put out of scope. The loop process remains alive, so a
streaming harness can read stdout as it appears — the same channel that already carries
the terminal JSON. A future optional pointer file can land under a separate change if
operators need discoverability after the launching process is gone without detaching.

**Why not only stderr human lines?** Operators benefit from a human line, but acceptance
requires machine-parseable handoff without prose scraping. Stderr may carry a brief
human pointer (`pipeline loop: run ready …`); it is not the contract.

**Alternatives considered:**

- **Write handoff into the terminal summary only** — does not solve the timing problem.
- **Detach the loop** — larger product change; cluster order is handoff first, then logs
  follow and skill rewrite.
- **Reuse detach `run-store.json` shape under `.agent-pipeline/runs/`** — wrong state home
  and wrong run-id namespace; confuses single-issue advance artifacts with loop runs.

### Decision 2 — Emit after exclusive lock, before first dispatch

**Choice:** Fire the handoff only when:

1. Preflight succeeded,
2. The target run directory exists (fresh init completed, or resume target exists),
3. This process holds the run's exclusive lock token,

and **before** `dispatchItem` is invoked for any item in this process.

**Why after lock, not merely after init?** Advertising a run that another process still
holds (or that failed lock acquisition) would send the harness to a run it cannot treat as
“this process’s drive.” Lock success is the same gate the supervisor already uses before
mutating.

**Why before first dispatch?** First-item advance is the multi-minute block. The handoff
must be available “within seconds” of successful create/lock for Monitor arming.

**Failure paths that MUST NOT emit a successful handoff:**

- Preflight failure (args, store schema, native-goal)
- Selector resolution failure, config error
- Init conflict / supersession refuse
- Lock held by another process / unrecoverable lock
- `--audit` (read-only; prints audit report only)

### Decision 3 — Seam: engine notifies the CLI; CLI owns serialization and flush

**Choice:** Keep emission in `runLoopCommand` (or a tiny pure formatter it calls), and give
the engine/supervisor path a narrow injectable hook — e.g. `onRunReady(handoffContext)` on
the engine deps or supervisor attach path — invoked once after lock acquisition. Unit tests
assert ordering by recording hook calls relative to a fake `dispatchItem` that blocks or
records timestamps.

**Why not have the engine print itself?** CLI owns all other stdout JSON contracts for
`pipeline loop` (terminal summary, audit). Keeping one owner avoids double-print and keeps
`--audit` / error paths consistent.

**Why not fully split `attach` and `drive` public commands?** A callback/hook is a smaller
diff and preserves the single `pipeline loop` entry. An internal split of
`defaultRunLoopEngine` into “resolve + lock” then “drive” is fine if that is the cleanest
implementation; it need not become a new user-facing subcommand.

### Decision 4 — Discriminator vs terminal summary; terminal stays

**Choice:** Handoff carries `kind: "loop_run_handoff"`. The existing terminal summary is
unchanged in required keys (`schema_version`, `run_id`, `cycles`, `stop`, …). The terminal
payload SHALL NOT use `kind: "loop_run_handoff"`. A consumer rule:

1. A JSON line with `kind === "loop_run_handoff"` is the early handoff.
2. The process’s final successful drive JSON (exit path after supervisor returns) is the
   terminal summary — recognized by existing fields (`cycles`, `all_done`, …) and by
   process exit.

Adding `kind` to the terminal summary is optional and **not required** for this change
(avoids unnecessary churn for existing parsers). If added later, use a different value
(e.g. `loop_run_result`).

### Decision 5 — Flush contract for piped harnesses

**Choice:** After writing the handoff line, the CLI SHALL ensure the line is flushed to
stdout (not left only in a user-space buffer). Implementation guidance: prefer a single
`write` of the line including trailing newline and handle backpressure (`drain`) when
`write` returns false; avoid relying on TTY line-buffering. Tests can inject a write/flush
seam rather than asserting on real pipe behavior when unit-testing pure formatting.

### Decision 6 — Host packaging correction is in-scope

**Choice:** Update the generated command surface text (source under `hosts/` / command
templates that become `plugin/pipeline/commands/pipeline:loop.md`) so multi-item durable
runs are not described as “completes in seconds / No Monitor needed.” Point at the early
handoff’s `run_id` + `events` path for progress follow. Full skill orchestration rewrite
(#668) remains out of scope; this is a minimal truthfulness fix so operators are not
actively misled.

### Decision 7 — Paths are absolute and resolved via existing store helpers

**Choice:** `run_dir` and `events` MUST be absolute filesystem paths produced from the
same resolution as the store (`runDir` / events path under `resolveStateHome`). No
relative paths, no guessing from cwd. This matches detach’s absolute-path contract and
lets a Monitor start without knowing XDG/state-home rules.

## Risks / Trade-offs

- **[Risk] Stdout becomes multi-line JSON over a long run** → Mitigation: stable
  `kind` discriminator; terminal keys unchanged; document that harnesses must not treat
  “first JSON line ever” as terminal if it carries `loop_run_handoff`.
- **[Risk] Buffered stdout delays handoff under some hosts** → Mitigation: explicit flush
  requirement + injectable write seam in tests; human stderr line as secondary signal.
- **[Risk] Emitting before lock confuses concurrent resume** → Mitigation: Decision 2 —
  handoff only after exclusive lock.
- **[Risk] Scope creep into store schema or detach-the-loop** → Mitigation: Non-Goals and
  out-of-scope list; no new durable file in v1.
- **[Risk] Host docs drift again after skill rewrite (#668)** → Mitigation: requirement
  that packaging not claim “seconds / no Monitor” for multi-item drive; #668 can deepen
  orchestration without reintroducing the false claim.

## Migration Plan

- Additive CLI behavior: one extra JSON line early on success paths. Existing consumers
  that only read the **last** stdout JSON object on process exit keep working.
- Consumers that naively parse the **first** stdout JSON object as the terminal summary
  must ignore `kind: "loop_run_handoff"` or wait for exit — document in packaging.
- No durable data migration; no store version bump.
- Rollback: revert the emission + packaging text; durable runs remain valid.

## Open Questions

- None blocking implementation. Optional later: whether a `pipeline loop --detach` or a
  pointer file is warranted once #666/#668 land; not required for #665 acceptance.
)
