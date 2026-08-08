## Why

Factory state is split across per-issue JSON status, loop audit/status, controller process
records, run artifacts, provider state, engine pinning, and (with #890) service/controller
records. Operators and external supervisors cannot obtain one authoritative, safe snapshot, and
the raw loop/status projection cannot be exposed remotely because it includes lock/supervisor
bearer tokens and unbounded internal evidence. Cycle-bound heartbeats also make long blocking
dispatches look stale even when the process is live, while expected waits (provider cooldown,
CI, backoff, capacity, human) look like wedges.

## What Changes

- **`pipeline factory status`** — a pure, versioned, allowlisted factory-level status command
  with human-readable output and `--json` that writes exactly one unfenced JSON object
  (including structured error/degraded envelopes).
- **Allowlisted remote-safe read model** — assemble the snapshot from an explicit field
  allowlist over #890 controller/service evidence (when present) plus existing durable
  loop/run/pin/provider sources. Never emit raw lock/supervisor records, bearer tokens,
  credentials, secret references, process environments, prompts/tool output, local auth
  material, or unsanitized issue/comment/reason text.
- **Independent controller health** — controller-owned heartbeat and operation evidence that
  advances on a bounded independent cadence during long item dispatches, waits, and recovery
  backoff (without requiring model/worker progress messages). Health represents process
  liveness, durable workflow progress, and expected waiting as independent dimensions.
- **Stuck/dead classification rules** — `suspected_stuck` only when the controller is live and
  an explicitly started operation is past deadline with no durable progress; `dead` only with
  stale heartbeat plus same-host process/service absence proof; cross-host or insufficient
  evidence is `unknown`. Expected waiting before a recorded deadline is healthy, not stuck.
- **Honest unknowns** — missing telemetry and cost remain unknown; no remaining-quota
  percentage or zero-cost inference. Legacy runs and missing optional sources stay readable
  with explicit unknown/legacy attribution.
- **Docs/registry/mirror** — register the command, keep generated CLI/config/host docs and
  `plugin/` current; `npm run ci` green.

**Non-goals:** dashboard, notifications, mutating status commands; exposing the raw loop-store
status object over HTTP/MCP; replacing run artifacts, per-issue status, audit, logs, or
scoreboard (#301); claiming cross-host process death from host-local evidence; campaign-specific
progress ownership (#654).

## Capabilities

### New Capabilities

- `factory-aggregate-status`: Versioned allowlisted factory status read model and
  `pipeline factory status` CLI (human + `--json`); pure observation over controller and
  durable evidence; structured degraded/error envelopes; canary-guarded sanitization.
- `controller-independent-health`: Controller-owned independent heartbeat cadence and
  operation/deadline evidence; independent process-liveness, durable-progress, and
  expected-waiting dimensions; `suspected_stuck` / `dead` / `unknown` / healthy-waiting
  classification; failed heartbeat persistence visibility.

### Modified Capabilities

- `command-registry`: Register `factory status` (or equivalent keyword routing) as a
  non-mutating command with a strict `allowedFlags` allowlist including `--json`.
- `durable-loop-supervisor`: When the active controller is the loop supervisor (pre-#890 or as
  the delegated item driver), independent heartbeat/operation evidence applies so long
  dispatches do not falsely appear dead; compose with, do not remove, cycle-bound evidence.
- `durable-loop-store`: Status/audit consumers may project allowlisted lock/liveness summaries
  without exposing lock tokens; optional operation/heartbeat fields remain readable when present
  and unknown when absent (legacy-safe).
- `generated-cli-reference` (when docs generator present): Document `pipeline factory status`
  and flags.

## Impact

- **Depends on #890** for full macro-controller/service identity in the snapshot; when the
  macro-controller is disabled or absent, status remains readable over loop-supervisor + durable
  store + pin/provider sources with explicit unknown/legacy attribution for missing controller
  fields.
- **CLI surface:** new read-only factory status command; no mutation of GitHub, git, ledger,
  events, service control, or run artifacts.
- **Security:** remote-safe allowlist + canary tests are first-class; raw secrets and
  instruction-like free text must never appear in JSON, prose, or error paths.
- **Health model:** separates process liveness from workflow progress and expected wait so
  external supervisors can act without false wedges.
- **Tests:** unit tests with injected clocks, process probes, stores, and status readers; no
  real network/git/subprocess.
- **Does not:** introduce dashboards, HTTP/MCP exposure of raw store status, auto-merge, or
  cross-host death claims.

## Acceptance criteria

Observable, falsifiable outcomes that make #891 done:

- [ ] `pipeline factory status --json` writes exactly one unfenced versioned JSON object,
      including structured error/degraded states (`JSON.parse(stdout)` succeeds).
- [ ] Status performs no GitHub, git, service, control, ledger, event, or run-artifact mutation
      (exercised via injected seams recording zero write/mutate calls).
- [ ] The snapshot includes controller/service identity, mode/revision, active contract/run,
      engine/treatment/authority fingerprints, active/queued/held counts, per-item coarse state
      and stage, linked advance run/PR/candidate, current operation/deadline, last durable
      progress, expected wait/deadline, provider cooldown, next action, lock/liveness projection,
      event/write-health, and actual/estimated/unknown cost coverage (or explicit unknown for
      each optional field when source is absent).
- [ ] Remote output is assembled from an explicit allowlist; raw lock/supervisor records, bearer
      tokens, credentials, secret references, process environments, prompts/tool output, local
      auth material, and unsanitized issue/comment/reason text never appear.
- [ ] Tests inject canary secrets and prompt-like issue/reason text into every source object and
      prove no canary or raw instruction appears in JSON, prose, or error output.
- [ ] A controller-owned heartbeat advances on a bounded independent cadence during long item
      dispatches, waits, and recovery backoff without requiring model/worker progress messages.
- [ ] Heartbeat refresh stops after lock loss/terminal exit; failed heartbeat persistence is
      visible rather than reported healthy.
- [ ] Health represents process liveness, durable workflow progress, and expected waiting
      independently (three separable dimensions in the read model).
- [ ] `suspected_stuck` requires fresh controller liveness plus an explicitly started operation
      past its deadline with no durable progress.
- [ ] `dead` requires stale heartbeat plus same-host process/service absence proof; cross-host or
      insufficient evidence is `unknown`.
- [ ] CI/provider/backoff/dependency/capacity/human waiting before a recorded deadline is healthy
      waiting, not stuck.
- [ ] Missing telemetry and cost remain unknown; no remaining-quota percentage or zero-cost
      inference is emitted.
- [ ] Legacy runs and missing optional sources remain readable with explicit unknown/legacy
      attribution.
- [ ] Unit tests use injected clocks, process probes, stores, status readers, and no real
      network/git/subprocess calls.
- [ ] Generated CLI/config/host docs and `plugin/` mirror remain current; `npm run ci` passes.
