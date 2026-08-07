## 1. Schema and store foundations

- [x] 1.1 Define versioned execution-contract revision types (minimum identity, fingerprint, phase, completion policy, next action, prior-revision link, live-state replan reason) and canonical hash rules with golden fixtures
- [x] 1.2 Define factory-run layout under Pipeline state home (current pointer, revisions/, claims/, events/evidence) with atomic write patterns matching durable-loop-store discipline
- [x] 1.3 Implement CAS adopt/replan for current revision pointer; refuse overwrite of accepted bodies; fail closed on stale expected revision and live-identity mismatch
- [x] 1.4 Implement coarse-action claim records (claim-before-side-effect, terminal outcomes including ambiguous-reconcile) with at-most-once semantics under concurrent ticks
- [x] 1.5 Add host-local factory-run lock (domain-scoped key) with injectable seam; document single-host concurrency scope
- [x] 1.6 Unit tests for hash stability, immutability, CAS races, claim idempotency, and lock token checks (injected filesystem/lock only)

## 2. Identity model and validators

- [x] 2.1 Model distinct fields for service controller, outer host, implementer treatment, reviewer treatment, and privileged mutation actor
- [x] 2.2 Validators reject missing slots when factory mode enabled; reject silent remaps (including non-Claude controller recorded as Codex)
- [x] 2.3 Wire outer-host field to outer-host registry identity rules without collapsing into controller or stage treatments
- [x] 2.4 Golden tests for five-way identity separation and remapping refusals

## 3. Macro-controller tick and phase derivation

- [x] 3.1 Implement `FactoryMacroDeps` seams: GitHub, git base SHA, clock, config/fingerprint readers, contract store, lock, child loop start/status, optional advance start/status
- [x] 3.2 Implement coarse phase enum + deterministic next-action derivation from durable state + live observations (no conversation memory)
- [x] 3.3 Implement tick: load → observe → derive → claim → dispatch child whole-run → reconcile → evidence
- [x] 3.4 Ensure no public/internal API path performs per-stage label transitions for item work; drift-guard test as needed
- [x] 3.5 Crash-matrix unit tests: before claim, after claim, after child start, after ambiguous child result (injected faults)

## 4. Child linkage to durable loop / advance

- [x] 4.1 Link factory contracts to native durable loop run ids/hashes; start/resume via existing loop engine/supervisor entry points only
- [x] 4.2 Optional single-item advance whole-run linkage without introducing factory stage labels
- [x] 4.3 Legacy run identity mapping field (read/map only); tests prove no second write authority
- [x] 4.4 Concurrency non-widening tests: serial default preserved; explicit loop concurrency policy still owned by independent scheduler

## 5. Opt-in surface, status, and evidence

- [x] 5.1 Default-off enablement (config key and/or dedicated factory CLI); prove ordinary pipeline/single/loop/merge/release paths unchanged when disabled
- [x] 5.2 Read-only status/evidence exposure of current monotonic revision, phase, next action, and per-action controller+revision attribution
- [x] 5.3 Operator docs: default off, sole Pipeline authority, identity slots, CAS replan, single-host locks, no autonomous merge/release
- [x] 5.4 Merge/release phases emit operator next-actions only; isolation test that macro tick cannot call mergePr / merge-queue apply / unattended release finalize

## 6. Mirror, OpenSpec hygiene, and CI

- [x] 6.1 After any `core/` or host packaging edits, run `node scripts/build.mjs` and commit regenerated `plugin/`
- [x] 6.2 Keep OpenSpec change valid (`openspec validate factory-macro-controller` / `openspec validate --all` as applicable)
- [x] 6.3 Run `npm run ci` from repo root and fix failures until green
