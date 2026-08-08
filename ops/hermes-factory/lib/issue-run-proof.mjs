import { isAbsolute, join, resolve } from "node:path";

export const ISSUE_RUN_PROOF_LIMITS = Object.freeze({
  maxJsonlBytes: 8 * 1024 * 1024,
  maxEvents: 50_000,
  maxLineBytes: 256 * 1024,
});

const REQUIRED_GROK_MODEL = "grok-4.5";
const GIT_OID_RE = /^[0-9a-f]{40,64}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IMPLEMENTER_STAGE_RE = /^(?:planning|implement(?:ing|ation)?|fix(?:[-_:].*)?)$/i;
const REVIEW_STAGE_RE = /^review(?:[-_:].*)?$/i;
const MODEL_WORK_STAGE_RE = /^(?:planning|plan-review|implement(?:ing|ation)?|review(?:[-_:].*)?|fix(?:[-_:].*)?|shipcheck(?:[-_:].*)?|pre-merge(?:[-_:].*)?)$/i;

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function requirePositiveIssue(value, name = "expected issue") {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireTimestamp(value, name) {
  if (typeof value !== "string" || !RFC3339_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid UTC timestamp`);
  }
}

function parseJsonl(text, name) {
  if (typeof text !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(text, "utf8") > ISSUE_RUN_PROOF_LIMITS.maxJsonlBytes) {
    throw new Error(`${name} exceeds the byte limit`);
  }

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error(`${name} is empty`);
  if (lines.length > ISSUE_RUN_PROOF_LIMITS.maxEvents) {
    throw new Error(`${name} exceeds the event limit`);
  }

  return lines.map((line, index) => {
    if (line.trim() === "") throw new Error(`${name} line ${index + 1} is blank`);
    if (Buffer.byteLength(line, "utf8") > ISSUE_RUN_PROOF_LIMITS.maxLineBytes) {
      throw new Error(`${name} line ${index + 1} exceeds the byte limit`);
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${name} line ${index + 1} is not valid JSON`);
    }
    return requireRecord(value, `${name} line ${index + 1}`);
  });
}

function requireActualRunId(value, expectedIssue, name = "Pipeline run id") {
  if (typeof value !== "string" || value.length > 128) {
    throw new Error(`${name} is invalid`);
  }
  const prefix = `${expectedIssue}-`;
  if (!value.startsWith(prefix)) throw new Error(`${name} does not match issue #${expectedIssue}`);
  const stamp = value.slice(prefix.length);
  const match = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!match) throw new Error(`${name} is not an actual Pipeline advance run id`);
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) {
    throw new Error(`${name} contains an invalid timestamp`);
  }
  return value;
}

function requireOuterEventShape(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.seq !== index) {
      throw new Error(`outer loop event ${index + 1} has a non-contiguous sequence`);
    }
    requireTimestamp(event.time, `outer loop event ${index + 1} time`);
    if (typeof event.kind !== "string" || event.kind.length === 0 || event.kind.length > 128) {
      throw new Error(`outer loop event ${index + 1} kind is invalid`);
    }
    if (!("data" in event)) throw new Error(`outer loop event ${index + 1} has no data`);
  }
}

function requireAdvanceEventShape(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!Number.isSafeInteger(event.schema_version) || event.schema_version <= 0) {
      throw new Error(`advance event ${index + 1} schema_version is invalid`);
    }
    if (typeof event.type !== "string" || event.type.length === 0 || event.type.length > 128) {
      throw new Error(`advance event ${index + 1} type is invalid`);
    }
    requireTimestamp(event.at, `advance event ${index + 1} time`);
  }
}

function identityValues(event) {
  return [
    event.harness,
    event.adapter,
    event.model,
    event.requested_model,
    event.resolved_model,
    event.treatment_fingerprint?.adapterId,
  ].filter((value) => typeof value === "string");
}

function isNamedIdentity(value, name) {
  const normalized = value.toLowerCase();
  return normalized === name || normalized.startsWith(`${name}-`) || normalized.includes(`/${name}-`);
}

function isGrokAccounting(event) {
  return identityValues(event).some((value) => isNamedIdentity(value, "grok"));
}

function isClaudeAccounting(event) {
  return identityValues(event).some(
    (value) => isNamedIdentity(value, "claude") || value.toLowerCase().includes("anthropic"),
  );
}

function hasExactAdapterIdentity(event, expected) {
  return [event.harness, event.adapter, event.treatment_fingerprint?.adapterId]
    .some((value) => typeof value === "string" && value.toLowerCase() === expected);
}

function accountingRole(event) {
  if (IMPLEMENTER_STAGE_RE.test(event.stage)) return "implementer";
  if (REVIEW_STAGE_RE.test(event.stage)) return "reviewer";
  if (event.stage !== "plan-review") return null;
  if (event.model_slot === "planning") return "implementer";
  if (event.model_slot === "review") return "reviewer";
  throw new Error("plan-review stage_accounting has no exact planning or review model slot");
}

/**
 * Parse the one-item loop trail and return the only real advance run linkage.
 */
export function parseIssueAdvanceLinkage(outerEventsJsonl, { repoDir, expectedIssue }) {
  const issue = requirePositiveIssue(expectedIssue);
  if (typeof repoDir !== "string" || repoDir.length === 0 || !isAbsolute(repoDir) || repoDir.includes("\0")) {
    throw new Error("repoDir must be an absolute path");
  }

  const events = parseJsonl(outerEventsJsonl, "outer loop events");
  requireOuterEventShape(events);

  const linked = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "loop_item_advance_linked");
  if (linked.length !== 1) {
    throw new Error(`outer loop events contain ${linked.length} advance linkage records; expected exactly one`);
  }

  const link = requireRecord(linked[0].event.data, "loop_item_advance_linked data");
  if (link.item_id !== String(issue)) {
    throw new Error(`advance linkage item does not match issue #${issue}`);
  }
  const runId = requireActualRunId(link.pipeline_run_id, issue);
  const eventsPath = join(resolve(repoDir), ".agent-pipeline", "runs", runId, "events.jsonl");
  if (link.events !== eventsPath) {
    throw new Error("advance linkage events path is not the exact run-confined path");
  }

  const finished = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "loop_item_advance_finished");
  if (finished.length !== 1) {
    throw new Error(`outer loop events contain ${finished.length} advance finish records; expected exactly one`);
  }
  const finish = requireRecord(finished[0].event.data, "loop_item_advance_finished data");
  if (
    finish.item_id !== String(issue) ||
    finish.pipeline_run_id !== runId ||
    finish.events !== eventsPath
  ) {
    throw new Error("advance finish record does not match the exact linkage");
  }
  if (finish.outcome !== "ready_to_deploy") {
    throw new Error("advance finish record is not ready_to_deploy");
  }
  if (finished[0].index <= linked[0].index) {
    throw new Error("advance finish record precedes its linkage");
  }

  return Object.freeze({ pipeline_run_id: runId, events_path: eventsPath });
}

/**
 * Validate the linked advance trail against its issue, run, model, and reviewed head.
 */
export function validateIssueAdvanceEvidence(
  advanceEventsJsonl,
  { expectedIssue, expectedRunId, expectedPrHead },
) {
  const issue = requirePositiveIssue(expectedIssue);
  const runId = requireActualRunId(expectedRunId, issue, "expected Pipeline run id");
  if (typeof expectedPrHead !== "string" || !GIT_OID_RE.test(expectedPrHead)) {
    throw new Error("expected PR head must be a lowercase Git object id");
  }

  const events = parseJsonl(advanceEventsJsonl, "advance events");
  requireAdvanceEventShape(events);

  const starts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "run_start");
  if (starts.length !== 1) {
    throw new Error(`advance events contain ${starts.length} run_start records; expected exactly one`);
  }
  const start = starts[0];
  if (start.event.run_id !== runId || start.event.issue !== issue) {
    throw new Error("run_start does not match the expected issue and run id");
  }

  const completions = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "run_complete");
  if (completions.length !== 1) {
    throw new Error(`advance events contain ${completions.length} run_complete records; expected exactly one`);
  }
  const completion = completions[0];
  if (completion.event.final_state !== "ready-to-deploy") {
    throw new Error("run_complete is not ready-to-deploy");
  }
  if (!Number.isSafeInteger(completion.event.elapsed_ms) || completion.event.elapsed_ms < 0) {
    throw new Error("run_complete elapsed_ms is invalid");
  }
  if (completion.index <= start.index) throw new Error("run_complete precedes run_start");

  const accounting = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "stage_accounting");
  const successfulImplementerStages = new Set();
  for (const { event, index } of accounting) {
    if (
      event.run_id !== runId ||
      event.issue !== issue ||
      typeof event.stage !== "string" ||
      typeof event.harness !== "string" ||
      typeof event.outcome !== "string" ||
      !Number.isSafeInteger(event.command_count) ||
      event.command_count < 0 ||
      !Number.isSafeInteger(event.subprocess_count) ||
      event.subprocess_count < 0
    ) {
      throw new Error("stage_accounting is not bound to the expected issue run");
    }
    if (index <= start.index || index >= completion.index) {
      throw new Error("stage_accounting is outside the active run interval");
    }
    if (MODEL_WORK_STAGE_RE.test(event.stage) && isClaudeAccounting(event)) {
      throw new Error(`Claude invocation is forbidden for stage ${event.stage}`);
    }
    const role = accountingRole(event);
    if (role === "implementer") {
      if (!hasExactAdapterIdentity(event, "grok")) {
        throw new Error(`implementer-owned stage ${event.stage} was not run by the Grok adapter`);
      }
      if (event.requested_model !== REQUIRED_GROK_MODEL || event.resolved_model !== REQUIRED_GROK_MODEL) {
        throw new Error("Grok stage_accounting does not prove requested and resolved grok-4.5");
      }
      if (
        event.outcome === "success" &&
        event.command_count > 0 &&
        event.subprocess_count > 0 &&
        ["planning", "implementing"].includes(event.stage)
      ) {
        successfulImplementerStages.add(event.stage);
      }
    }
    if (role === "reviewer" && !hasExactAdapterIdentity(event, "codex")) {
      throw new Error(`reviewer-owned stage ${event.stage} was not run by the Codex adapter`);
    }
  }

  const grokAccounting = accounting.filter(({ event }) => isGrokAccounting(event));
  if (grokAccounting.length === 0) {
    throw new Error("advance events contain no Grok stage_accounting invocation");
  }
  for (const { event } of grokAccounting) {
    if (event.requested_model !== REQUIRED_GROK_MODEL || event.resolved_model !== REQUIRED_GROK_MODEL) {
      throw new Error("Grok stage_accounting does not prove requested and resolved grok-4.5");
    }
  }
  const implementerAccounting = accounting.filter(({ event }) => accountingRole(event) === "implementer");
  if (implementerAccounting.length === 0) {
    throw new Error("advance events contain no implementer-owned stage accounting");
  }
  if (implementerAccounting.some(
    ({ event }) => event.outcome !== "success" || event.command_count <= 0 || event.subprocess_count <= 0,
  )) {
    throw new Error("an implementer-owned Grok stage did not complete successfully");
  }
  const successfulGrokInvocation = grokAccounting.some(
    ({ event }) =>
      event.outcome === "success" &&
      event.command_count > 0 &&
      event.subprocess_count > 0 &&
      (event.harness === "grok" || event.adapter === "grok" || event.treatment_fingerprint?.adapterId === "grok"),
  );
  if (!successfulGrokInvocation) {
    throw new Error("advance events contain no successful Grok model invocation");
  }
  for (const requiredStage of ["planning", "implementing"]) {
    if (!successfulImplementerStages.has(requiredStage)) {
      throw new Error(`advance events contain no successful grok-4.5 ${requiredStage} invocation`);
    }
  }

  const reviews = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "review_verdict");
  if (reviews.length === 0) throw new Error("advance events contain no review_verdict");
  for (const { event, index } of reviews) {
    if (index <= start.index || index >= completion.index) {
      throw new Error("review_verdict is outside the active run interval");
    }
    if (event.reviewer_harness !== "codex" || event.self_review !== false) {
      throw new Error("review_verdict does not prove independent Codex review");
    }
    if (typeof event.sha !== "string" || !GIT_OID_RE.test(event.sha)) {
      throw new Error("review_verdict has an invalid reviewed head");
    }
  }
  const terminalReview = reviews.at(-1).event;
  if (terminalReview.sha !== expectedPrHead || terminalReview.verdict !== "approve") {
    throw new Error("the terminal independent Codex review_verdict does not approve the expected PR head");
  }

  return Object.freeze({
    run_id: runId,
    issue,
    final_state: "ready-to-deploy",
    grok_invocations: grokAccounting.length,
    review_verdicts: reviews.length,
    reviewed_head: expectedPrHead,
  });
}
