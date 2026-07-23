// Durable paused/waiting states & audited authority amendments (#510,
// capability `durable-pause-and-authority`). Ports goal-loop#2's non-terminal
// human surfaces onto the integrated durable-orchestration ledger: a
// deliberate, non-failure hold distinct from `blocked` (#509), a precise
// human-input request a resume must satisfy, audited fail-closed resume that
// still composes with the pipeline- and native-goal-mandate evidence checks,
// scoped audited authority amendments, and audited cross-engine handoff.
//
// See openspec/changes/durable-pause-and-authority/design.md for the
// decisions this module implements. Every mutating operation goes through
// loop/store.ts's injected LoopStoreDeps seam — no real filesystem, process,
// or network access.

import {
  LoopError,
  isLoopHumanInputRequestKind,
  isLoopAuthorityGate,
  type LoopAuthorityAmendment,
  type LoopAuthorityGate,
  type LoopEngineName,
  type LoopHandoff,
  type LoopHumanInputRequest,
  type LoopHumanInputRequestKind,
  type LoopLedger,
  type LoopNativeGoalCheck,
  type LoopPipelinePreflightEvidence,
} from "./types.ts";
import { appendDecision, appendEvent, readLedger, releaseLock, requireToken, writeLedger, type LoopStoreDeps } from "./store.ts";

// ---------------------------------------------------------------------------
// Pre-#510 durable-state migration: a ledger persisted before this capability
// existed carries no `authority_amendments` field and no item carries
// `hold_request`. Every entry point below runs the ledger through this pure
// upgrader before use, mirroring `upgradeLedgerForRecovery` (loop/recovery.ts).
// ---------------------------------------------------------------------------

export function upgradeLedgerForPauseAuthority(ledger: LoopLedger): LoopLedger {
  if (ledger.authority_amendments) return ledger;
  return { ...ledger, authority_amendments: [] };
}

// ---------------------------------------------------------------------------
// Entering a hold — admitted only from in_progress.
// ---------------------------------------------------------------------------

export interface EnterHoldInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  note?: string;
}

async function enterHold(
  deps: LoopStoreDeps,
  input: EnterHoldInput,
  to: "paused" | "waiting",
  request?: LoopHumanInputRequest,
): Promise<LoopLedger> {
  const lock = await requireToken(deps, input.runId, input.token);
  if (lock.engine !== input.engine) {
    throw new LoopError(
      "validation",
      `hold transition names engine "${input.engine}", which does not match the current lock holder engine "${lock.engine}"`,
    );
  }
  const ledger = upgradeLedgerForPauseAuthority(await readLedger(deps, input.runId));
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }
  const item = ledger.items[input.itemId];
  if (!item) {
    throw new LoopError("validation", `item "${input.itemId}" not found in run "${input.runId}"`);
  }
  if (item.state !== "in_progress") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" cannot transition from "${item.state}" to "${to}" — only an in_progress item may enter a hold`,
    );
  }

  const time = deps.now().toISOString();
  const fromState = item.state;
  item.state = to;
  item.hold_request = request;
  item.history.push({ time, from: fromState, to, engine: input.engine, note: input.note });

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, to === "paused" ? "loop_item_paused" : "loop_item_waiting", {
    item_id: input.itemId,
    ...(request ? { request_id: request.request_id, kind: request.kind } : {}),
  });
  return ledger;
}

/** Transitions an in_progress item to `paused` — a bare operator hold with no outstanding
 *  request. Charges no recovery budget, counts no block, carries no `DurableBlockerClass`. */
export async function pauseItem(deps: LoopStoreDeps, input: EnterHoldInput): Promise<LoopLedger> {
  return enterHold(deps, input, "paused");
}

export interface WaitRequestInput {
  kind: unknown;
  prompt: unknown;
  permitted_responses?: unknown;
}

export interface EnterWaitingInput extends EnterHoldInput {
  request: WaitRequestInput;
}

/** Validates and builds the durable {@link LoopHumanInputRequest} a `waiting` transition
 *  requires. Pure and validated before any ledger read, so a malformed request never touches
 *  durable state. Refuses (LoopError "validation") a missing request, an unknown kind, or a
 *  present-but-empty `permitted_responses`. */
function buildHumanInputRequest(
  deps: LoopStoreDeps,
  itemId: string,
  engine: LoopEngineName,
  req: WaitRequestInput,
): LoopHumanInputRequest {
  if (!req || typeof req !== "object") {
    throw new LoopError("validation", `a waiting transition requires a human-input request`);
  }
  if (!isLoopHumanInputRequestKind(req.kind)) {
    throw new LoopError(
      "validation",
      `human-input request kind "${String(req.kind)}" is not one of "decision", "answer", "authority-grant"`,
    );
  }
  if (typeof req.prompt !== "string" || req.prompt.trim() === "") {
    throw new LoopError("validation", `a waiting transition's human-input request requires a non-empty prompt`);
  }
  let permitted: string[] | undefined;
  if (req.permitted_responses !== undefined) {
    if (
      !Array.isArray(req.permitted_responses) ||
      req.permitted_responses.length === 0 ||
      req.permitted_responses.some((r: unknown) => typeof r !== "string")
    ) {
      throw new LoopError(
        "validation",
        `a human-input request's permitted_responses, when present, must be a non-empty array of strings`,
      );
    }
    permitted = req.permitted_responses as string[];
  }
  const kind: LoopHumanInputRequestKind = req.kind;
  return {
    request_id: `req-${deps.uuid()}`,
    item_id: itemId,
    kind,
    prompt: req.prompt,
    permitted_responses: permitted,
    requested_by_engine: engine,
    requested_at: deps.now().toISOString(),
  };
}

/** Transitions an in_progress item to `waiting`, requiring a well-formed
 *  {@link LoopHumanInputRequest}. Refuses (LoopError "validation") a missing request, an unknown
 *  kind, or an empty permitted-response set — leaving the ledger unchanged. */
export async function waitItem(deps: LoopStoreDeps, input: EnterWaitingInput): Promise<LoopLedger> {
  const request = buildHumanInputRequest(deps, input.itemId, input.engine, input.request);
  return enterHold(deps, input, "waiting", request);
}

// ---------------------------------------------------------------------------
// Leaving a hold to abandoned.
// ---------------------------------------------------------------------------

export interface AbandonHoldInput {
  runId: string;
  token: string;
  itemId: string;
  engine: LoopEngineName;
  note?: string;
}

/** Transitions a `paused` or `waiting` item to `abandoned`. Refuses (LoopError "validation") any
 *  other current state, naming both states. */
export async function abandonHold(deps: LoopStoreDeps, input: AbandonHoldInput): Promise<LoopLedger> {
  const lock = await requireToken(deps, input.runId, input.token);
  if (lock.engine !== input.engine) {
    throw new LoopError(
      "validation",
      `abandonHold names engine "${input.engine}", which does not match the current lock holder engine "${lock.engine}"`,
    );
  }
  const ledger = upgradeLedgerForPauseAuthority(await readLedger(deps, input.runId));
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }
  const item = ledger.items[input.itemId];
  if (!item) {
    throw new LoopError("validation", `item "${input.itemId}" not found in run "${input.runId}"`);
  }
  if (item.state !== "paused" && item.state !== "waiting") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" cannot transition from "${item.state}" to "abandoned" via abandonHold — only a paused or waiting item may be abandoned this way`,
    );
  }

  const time = deps.now().toISOString();
  const fromState = item.state;
  item.state = "abandoned";
  item.hold_request = undefined;
  item.history.push({ time, from: fromState, to: "abandoned", engine: input.engine, note: input.note });

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_item_abandoned", { item_id: input.itemId, from: fromState });
  return ledger;
}

// ---------------------------------------------------------------------------
// Audited, fail-closed resume.
// ---------------------------------------------------------------------------

const NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS = 300;

function validatePipelinePreflightEvidence(evidence: LoopPipelinePreflightEvidence | null | undefined): void {
  if (!evidence || evidence.passed !== true) {
    throw new LoopError(
      "pipeline_mandate",
      `resume into in_progress requires evidence that the Pipeline preflight passed`,
    );
  }
}

function validateNativeGoalEvidence(
  evidence: LoopNativeGoalCheck | null | undefined,
  expectedEngine: LoopEngineName,
  expectedRunId: string,
  now: Date,
): void {
  const corrective = `re-run the native bootstrap for "${expectedEngine}" and retry with fresh evidence`;
  if (!evidence) {
    throw new LoopError("native_goal_mandate", `resume requires fresh native-goal evidence — ${corrective}`);
  }
  if (evidence.engine !== expectedEngine) {
    throw new LoopError(
      "native_goal_mandate",
      `native-goal evidence names engine "${evidence.engine}", expected "${expectedEngine}" — ${corrective}`,
    );
  }
  if (evidence.run_id !== expectedRunId) {
    throw new LoopError(
      "native_goal_mandate",
      `native-goal evidence names run "${evidence.run_id}", expected "${expectedRunId}" — ${corrective}`,
    );
  }
  if (evidence.status !== "active") {
    throw new LoopError(
      "native_goal_mandate",
      `native-goal evidence reports status "${evidence.status}", expected "active" — ${corrective}`,
    );
  }
  const checkedAt = new Date(evidence.checked_at).getTime();
  if (!Number.isFinite(checkedAt) || Math.abs(now.getTime() - checkedAt) > NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS * 1000) {
    throw new LoopError(
      "native_goal_mandate",
      `native-goal evidence checked_at is outside the ${NATIVE_GOAL_FRESHNESS_WINDOW_SECONDS}s freshness window — ${corrective}`,
    );
  }
}

export interface ResumeResponseInput {
  /** The outstanding request id the response answers. Required (and checked) when the item is
   *  `waiting`; ignored for a bare `paused` hold, which carries no request. */
  request_id?: string;
  value: string;
}

export interface ResumeHoldInput {
  runId: string;
  token: string;
  itemId: string;
  /** The resuming engine — validated against the supplied native-goal evidence. */
  engine: LoopEngineName;
  /** A human actor reference, recorded on the audited resume decision. */
  actor: string;
  response: ResumeResponseInput;
  pipeline_preflight: LoopPipelinePreflightEvidence | null | undefined;
  native_goal: LoopNativeGoalCheck | null | undefined;
  note?: string;
}

/** Resumes a `paused`/`waiting` item to `in_progress` through an audited, fail-closed resume.
 *  Refuses (LoopError "validation"), leaving durable state unchanged, when there is no active
 *  hold, when a `waiting` item's response names a different request, or when the response falls
 *  outside a defined closed permitted set. Still enforces the pipeline-mandate and
 *  native-goal-mandate evidence requirements for entering `in_progress` — a satisfying response
 *  with absent/stale mandate evidence is refused under those mandate classes, leaving the item in
 *  its hold. On success, appends an attributed decision to the run's decision log and clears the
 *  outstanding request. */
export async function resumeHold(deps: LoopStoreDeps, input: ResumeHoldInput): Promise<LoopLedger> {
  const lock = await requireToken(deps, input.runId, input.token);
  if (lock.engine !== input.engine) {
    throw new LoopError(
      "validation",
      `resumeHold names engine "${input.engine}", which does not match the current lock holder engine "${lock.engine}"`,
    );
  }
  const ledger = upgradeLedgerForPauseAuthority(await readLedger(deps, input.runId));
  if (ledger.stop) {
    throw new LoopError("stop", `loop run "${input.runId}" is already stopped: ${ledger.stop.reason}`);
  }
  const item = ledger.items[input.itemId];
  if (!item) {
    throw new LoopError("validation", `item "${input.itemId}" not found in run "${input.runId}"`);
  }
  if (item.state !== "paused" && item.state !== "waiting") {
    throw new LoopError(
      "validation",
      `item "${input.itemId}" has no active hold to resume — its state is "${item.state}", not "paused" or "waiting"`,
    );
  }

  if (item.state === "waiting") {
    const outstanding = item.hold_request;
    if (!outstanding) {
      throw new LoopError("validation", `item "${input.itemId}" is waiting but carries no outstanding human-input request`);
    }
    if (input.response.request_id !== outstanding.request_id) {
      throw new LoopError(
        "validation",
        `resume response names request "${input.response.request_id}", but item "${input.itemId}"'s outstanding request is "${outstanding.request_id}"`,
      );
    }
    if (outstanding.permitted_responses && !outstanding.permitted_responses.includes(input.response.value)) {
      throw new LoopError(
        "validation",
        `resume response "${input.response.value}" is not among the outstanding request's permitted responses: ${outstanding.permitted_responses.join(", ")}`,
      );
    }
  }

  validatePipelinePreflightEvidence(input.pipeline_preflight);
  validateNativeGoalEvidence(input.native_goal, input.engine, input.runId, deps.now());

  const time = deps.now().toISOString();
  const fromState = item.state;
  item.state = "in_progress";
  item.hold_request = undefined;
  item.history.push({ time, from: fromState, to: "in_progress", engine: input.engine, note: input.note });
  ledger.last_native_goal_check = input.native_goal as LoopNativeGoalCheck;

  await writeLedger(deps, ledger, input.token);
  await appendEvent(deps, input.runId, input.token, "loop_item_resumed", { item_id: input.itemId, from: fromState });
  await appendDecision(deps, input.runId, input.token, "loop_hold_resumed", {
    item_id: input.itemId,
    from_state: fromState,
    resuming_engine: input.engine,
    actor: input.actor,
    response: input.response,
    time,
  });
  return ledger;
}

// ---------------------------------------------------------------------------
// Scoped, audited authority amendments.
// ---------------------------------------------------------------------------

export interface RecordAmendmentInput {
  runId: string;
  token: string;
  gate: unknown;
  scope_item_id?: string;
  actor: string;
  reason: string;
}

export interface RecordAmendmentResult {
  ledger: LoopLedger;
  amendment: LoopAuthorityAmendment;
}

/** Records an audited authority amendment naming exactly one gate, scoped to exactly one item.
 *  Refuses (LoopError "validation") an amendment with no gate, an unknown gate, more than one
 *  gate, or no `scope_item_id` (a broad/un-scoped grant) — no amendment is recorded and durable
 *  state is unchanged. */
export async function recordAuthorityAmendment(deps: LoopStoreDeps, input: RecordAmendmentInput): Promise<RecordAmendmentResult> {
  if (Array.isArray(input.gate)) {
    throw new LoopError("validation", `an authority amendment must name exactly one gate, not a list`);
  }
  if (!input.gate) {
    throw new LoopError("validation", `an authority amendment must name a gate`);
  }
  if (!isLoopAuthorityGate(input.gate)) {
    throw new LoopError("validation", `an authority amendment names unknown gate "${String(input.gate)}"`);
  }
  if (!input.scope_item_id || input.scope_item_id.trim() === "") {
    throw new LoopError("validation", `an authority amendment must name a scope_item_id — a broad, un-scoped grant is refused`);
  }

  const ledger = upgradeLedgerForPauseAuthority(await readLedger(deps, input.runId));
  const amendment: LoopAuthorityAmendment = {
    gate: input.gate,
    scope_item_id: input.scope_item_id,
    actor: input.actor,
    reason: input.reason,
    time: deps.now().toISOString(),
  };

  // Decision logged before the amendment is durably active in the ledger: if appendDecision
  // fails, the ledger write below never runs, so an amendment can never become active without
  // its audited decision (finding 639c2bbb).
  await appendDecision(deps, input.runId, input.token, "loop_authority_amendment", { ...amendment });
  ledger.authority_amendments.push(amendment);
  await writeLedger(deps, ledger, input.token);
  return { ledger, amendment };
}

/** Checks whether `gate` is authorized for `itemId` — by a compile-time grant on the contract or
 *  a matching audited amendment — and that directly verified evidence was supplied. Refuses
 *  (LoopError "authority") when neither a grant nor a matching amendment covers the exact
 *  `(gate, scope)`; refuses (LoopError "validation") when authorized but evidence is absent or
 *  empty, so an amendment never bypasses the evidence mandate. Pure — performs no I/O. */
export function authorizeGatedTransition(
  authorityGrants: readonly LoopAuthorityGate[],
  ledgerInput: LoopLedger,
  gate: LoopAuthorityGate,
  itemId: string,
  evidence: string | null | undefined,
): void {
  const ledger = upgradeLedgerForPauseAuthority(ledgerInput);
  const granted =
    authorityGrants.includes(gate) ||
    ledger.authority_amendments.some((a) => a.gate === gate && a.scope_item_id === itemId);
  if (!granted) {
    throw new LoopError(
      "authority",
      `gate "${gate}" is not granted for item "${itemId}" — broad objectives do not grant gates; the run must stop and report`,
    );
  }
  if (!evidence || evidence.trim() === "") {
    throw new LoopError("validation", `transition through gate "${gate}" requires directly verified facts, not an agent's claim`);
  }
}

// ---------------------------------------------------------------------------
// Audited cross-engine handoff.
// ---------------------------------------------------------------------------

export interface HandoffInput {
  runId: string;
  token: string;
  fromEngine: LoopEngineName;
  toEngine: LoopEngineName;
  reason: string;
}

/** Hands a `paused`/`waiting` run from the current engine to the other via an audited decision,
 *  then releases the current lock via compare-and-delete without transferring its token — the
 *  receiving engine must acquire a fresh lock and re-attest native-goal mode before it can
 *  resume (enforced by {@link resumeHold}'s native-goal-mandate check). Refuses (LoopError
 *  "conflict") while any item is `in_progress`, leaving the lock and durable state unchanged. */
export async function handoffRun(deps: LoopStoreDeps, input: HandoffInput): Promise<void> {
  const ledger = upgradeLedgerForPauseAuthority(await readLedger(deps, input.runId));
  if (Object.values(ledger.items).some((item) => item.state === "in_progress")) {
    throw new LoopError("conflict", `loop run "${input.runId}": handoff refused while an item is in_progress`);
  }
  const lock = await requireToken(deps, input.runId, input.token);
  if (lock.engine !== input.fromEngine) {
    throw new LoopError(
      "validation",
      `handoff from_engine "${input.fromEngine}" does not match the current lock holder engine "${lock.engine}"`,
    );
  }

  const time = deps.now().toISOString();
  const handoff: LoopHandoff = { from_engine: input.fromEngine, to_engine: input.toEngine, reason: input.reason, time };
  await appendDecision(deps, input.runId, input.token, "loop_handoff", handoff);
  await releaseLock(deps, input.runId, input.token);
}
