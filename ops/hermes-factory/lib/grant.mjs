import { createHash } from "node:crypto";

export const GRANT_SCHEMA_VERSION = 1;
export const REQUIRED_MODEL = "grok-4.5";
export const GRANT_ACTIONS = Object.freeze([
  "issue_advance",
  "issue_pr_merge",
  "frg",
  "release_prepare",
  "release_pr_merge",
  "release_verify",
  "pin_promote",
  "install",
  "rollback",
]);

const AUTH_KEYS = new Set([
  "adapter",
  "chat_id",
  "user_id",
  "message_id",
  "thread_id",
  "created_at",
]);
const GRANT_KEYS = new Set([
  "schema_version",
  "kind",
  "nonce",
  "repository",
  "base_branch",
  "release_version",
  "milestone",
  "ordered_issues",
  "actions",
  "model",
  "issue_limit",
  "issued_at",
  "expires_at",
]);
const CONTROL_KEYS = new Set([
  "schema_version",
  "kind",
  "grant_fingerprint",
  "issued_at",
  "reason",
]);

export class GrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GrantError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertObject(value, name) {
  if (!isPlainObject(value)) throw new GrantError("invalid-shape", `${name} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new GrantError("unknown-field", `${name} contains unknown field(s): ${unknown.sort().join(", ")}`);
  }
}

function assertString(value, name, pattern) {
  if (typeof value !== "string" || !value) {
    throw new GrantError("invalid-field", `${name} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new GrantError("invalid-field", `${name} has an invalid value`);
  }
  return value;
}

function parseCanonicalTime(value, name) {
  assertString(value, name);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new GrantError("invalid-time", `${name} must be Unix seconds or a canonical ISO-8601 UTC timestamp`);
  }
  return time;
}

function parseBuzzCreatedAt(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GrantError("invalid-time", "auth.created_at must be positive Unix seconds from the Buzz adapter");
  }
  return value * 1000;
}

function normalizeAuth(raw, config, nowMs, { expectedThreadId = null, requireRootThread = false } = {}) {
  const auth = assertObject(raw, "auth");
  assertExactKeys(auth, AUTH_KEYS, "auth");
  if (auth.adapter !== "hermes-native-buzz") {
    throw new GrantError("adapter-mismatch", "auth.adapter must be hermes-native-buzz");
  }
  // Hermes supplies these relay-observed fields to the model. The wrapper
  // validates them against machine config, but does not claim to re-verify a
  // Nostr signature. The same-user pilot trust boundary is explicit.
  const eventId = assertString(auth.message_id, "auth.message_id", /^[a-f0-9]{64}$/);
  const sender = assertString(auth.user_id, "auth.user_id", /^[a-f0-9]{64}$/);
  if (sender !== config.operator_pubkey) {
    throw new GrantError("signer-mismatch", "auth.user_id does not match the configured operator");
  }
  const channel = assertString(
    auth.chat_id,
    "auth.chat_id",
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
  if (channel !== config.buzz_channel) {
    throw new GrantError("channel-mismatch", "auth.chat_id does not match the configured private channel");
  }
  const threadId = assertString(auth.thread_id, "auth.thread_id", /^[a-f0-9]{64}$/);
  if (requireRootThread && threadId !== eventId) {
    throw new GrantError("thread-mismatch", "auth.thread_id must equal the root grant message_id");
  }
  if (expectedThreadId && threadId !== expectedThreadId) {
    throw new GrantError("thread-mismatch", "auth.thread_id does not match the active grant thread");
  }
  const createdAtMs = parseBuzzCreatedAt(auth.created_at);
  const skewMs = config.event_clock_skew_seconds * 1000;
  if (createdAtMs > nowMs + skewMs) {
    throw new GrantError("event-from-future", "auth.created_at is too far in the future");
  }
  return Object.freeze({
    adapter: auth.adapter,
    chat_id: channel,
    user_id: sender,
    message_id: eventId,
    thread_id: threadId,
    created_at: auth.created_at,
  });
}

function normalizeGrant(raw, config, auth, nowMs, { allowExpired = false } = {}) {
  const grant = assertObject(raw, "grant");
  assertExactKeys(grant, GRANT_KEYS, "grant");
  if (grant.schema_version !== GRANT_SCHEMA_VERSION) {
    throw new GrantError("schema-mismatch", `grant.schema_version must be ${GRANT_SCHEMA_VERSION}`);
  }
  if (grant.kind !== "release_grant") {
    throw new GrantError("kind-mismatch", "grant.kind must be release_grant");
  }
  const nonce = assertString(grant.nonce, "grant.nonce", /^[A-Za-z0-9._:-]{8,128}$/);
  const repository = assertString(
    grant.repository,
    "grant.repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  if (repository !== config.repository) {
    throw new GrantError("repository-mismatch", "grant.repository does not match machine config");
  }
  const baseBranch = assertString(grant.base_branch, "grant.base_branch", /^[A-Za-z0-9._\/-]+$/);
  if (baseBranch !== config.base_branch) {
    throw new GrantError("base-mismatch", "grant.base_branch does not match machine config");
  }
  const releaseVersion = assertString(
    grant.release_version,
    "grant.release_version",
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
  const milestone = assertString(grant.milestone, "grant.milestone", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (milestone !== `v${releaseVersion}`) {
    throw new GrantError("milestone-mismatch", "grant.milestone must match grant.release_version");
  }

  if (!Array.isArray(grant.ordered_issues) || grant.ordered_issues.length === 0) {
    throw new GrantError("invalid-issues", "grant.ordered_issues must be a non-empty array");
  }
  const issues = [];
  const seenIssues = new Set();
  for (const issue of grant.ordered_issues) {
    if (!Number.isSafeInteger(issue) || issue <= 0) {
      throw new GrantError("invalid-issues", "grant.ordered_issues must contain positive integers");
    }
    if (seenIssues.has(issue)) {
      throw new GrantError("invalid-issues", `grant.ordered_issues repeats issue ${issue}`);
    }
    seenIssues.add(issue);
    issues.push(issue);
  }
  if (!Number.isSafeInteger(grant.issue_limit) || grant.issue_limit < issues.length) {
    throw new GrantError("issue-limit", "grant.issue_limit must cover the ordered issue list");
  }
  if (grant.issue_limit > config.max_issues || issues.length > config.max_issues) {
    throw new GrantError("issue-limit", "the grant exceeds config.max_issues");
  }

  if (!Array.isArray(grant.actions) || grant.actions.length === 0) {
    throw new GrantError("invalid-actions", "grant.actions must be a non-empty array");
  }
  const actions = [];
  let lastIndex = -1;
  for (const action of grant.actions) {
    const index = GRANT_ACTIONS.indexOf(action);
    if (index < 0) throw new GrantError("invalid-actions", `grant.actions contains unsupported action ${String(action)}`);
    if (index <= lastIndex) {
      throw new GrantError("invalid-actions", "grant.actions must be unique and in canonical workflow order");
    }
    lastIndex = index;
    actions.push(action);
  }
  if (grant.model !== REQUIRED_MODEL) {
    throw new GrantError("model-mismatch", `grant.model must be ${REQUIRED_MODEL}`);
  }

  const issuedAtMs = parseCanonicalTime(grant.issued_at, "grant.issued_at");
  const expiresAtMs = parseCanonicalTime(grant.expires_at, "grant.expires_at");
  const eventCreatedAtMs = parseBuzzCreatedAt(auth.created_at);
  const skewMs = config.event_clock_skew_seconds * 1000;
  if (Math.abs(eventCreatedAtMs - issuedAtMs) > skewMs) {
    throw new GrantError("event-time-mismatch", "grant.issued_at does not match the authenticated event time");
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new GrantError("invalid-expiry", "grant.expires_at must be after grant.issued_at");
  }
  if (expiresAtMs - issuedAtMs > config.max_grant_seconds * 1000) {
    throw new GrantError("invalid-expiry", "the grant duration exceeds config.max_grant_seconds");
  }
  if (!allowExpired && nowMs > expiresAtMs) throw new GrantError("expired", "the grant has expired");

  return Object.freeze({
    schema_version: GRANT_SCHEMA_VERSION,
    kind: "release_grant",
    nonce,
    repository,
    base_branch: baseBranch,
    release_version: releaseVersion,
    milestone,
    ordered_issues: Object.freeze(issues),
    actions: Object.freeze(actions),
    model: REQUIRED_MODEL,
    issue_limit: grant.issue_limit,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
  });
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GrantError("invalid-canonical-value", "canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new GrantError("invalid-canonical-value", "canonical JSON accepts only plain objects");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function fingerprintEnvelope(auth, grant) {
  return createHash("sha256")
    .update(canonicalJson({ auth, grant }), "utf8")
    .digest("hex");
}

export function validateGrantEnvelope(raw, config, { now = () => new Date(), allowExpired = false } = {}) {
  const envelope = assertObject(raw, "envelope");
  assertExactKeys(envelope, new Set(["auth", "grant"]), "envelope");
  const nowMs = now().getTime();
  const auth = normalizeAuth(envelope.auth, config, nowMs, { requireRootThread: true });
  const grant = normalizeGrant(envelope.grant, config, auth, nowMs, { allowExpired });
  const fingerprint = fingerprintEnvelope(auth, grant);
  return Object.freeze({ auth, grant, fingerprint });
}

export function requireGrantAction(validated, action) {
  if (!GRANT_ACTIONS.includes(action)) {
    throw new GrantError("unsupported-action", `the factory does not support action ${action}`);
  }
  if (!validated.grant.actions.includes(action)) {
    throw new GrantError("action-not-granted", `the grant does not permit action ${action}`);
  }
}

export function requireFullReleaseGrant(validated) {
  const missing = GRANT_ACTIONS.filter((action) => !validated.grant.actions.includes(action));
  if (missing.length) {
    throw new GrantError("incomplete-grant", `the release grant is missing action(s): ${missing.join(", ")}`);
  }
}

export function validateControlEnvelope(raw, config, validatedGrant, { now = () => new Date() } = {}) {
  const envelope = assertObject(raw, "control envelope");
  assertExactKeys(envelope, new Set(["auth", "control"]), "control envelope");
  const nowMs = now().getTime();
  const auth = normalizeAuth(envelope.auth, config, nowMs, {
    expectedThreadId: validatedGrant.auth.thread_id,
  });
  const control = assertObject(envelope.control, "control");
  assertExactKeys(control, CONTROL_KEYS, "control");
  if (control.schema_version !== GRANT_SCHEMA_VERSION) {
    throw new GrantError("schema-mismatch", `control.schema_version must be ${GRANT_SCHEMA_VERSION}`);
  }
  if (control.kind !== "stop" && control.kind !== "revoke") {
    throw new GrantError("kind-mismatch", "control.kind must be stop or revoke");
  }
  if (control.grant_fingerprint !== validatedGrant.fingerprint) {
    throw new GrantError("grant-mismatch", "control.grant_fingerprint does not match the active grant");
  }
  const issuedAtMs = parseCanonicalTime(control.issued_at, "control.issued_at");
  const skewMs = config.event_clock_skew_seconds * 1000;
  if (Math.abs(parseBuzzCreatedAt(auth.created_at) - issuedAtMs) > skewMs || issuedAtMs > nowMs + skewMs) {
    throw new GrantError("event-time-mismatch", "control.issued_at does not match the authenticated event time");
  }
  const reason = assertString(control.reason, "control.reason");
  if (reason.length > 500) throw new GrantError("invalid-field", "control.reason is too long");
  return Object.freeze({
    auth,
    control: Object.freeze({
      schema_version: GRANT_SCHEMA_VERSION,
      kind: control.kind,
      grant_fingerprint: control.grant_fingerprint,
      issued_at: control.issued_at,
      reason,
    }),
  });
}
