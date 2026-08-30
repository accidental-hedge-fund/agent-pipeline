// Typed provider-authentication signal (#1265).
//
// Classification MUST use structured fields, not free-form stderr prose.
// Served-model / `resolved_model` telemetry is out of scope for this change.

import { isJsonRecord, parseJsonLine } from "./harness-adapters/types.ts";

/** Closed JSON `error.code` values accepted as a compatibility auth signal. */
export const PROVIDER_AUTH_ERROR_CODE_ALLOWLIST = [
  "refresh_token_invalidated",
] as const;

export type ProviderAuthErrorCode = (typeof PROVIDER_AUTH_ERROR_CODE_ALLOWLIST)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(PROVIDER_AUTH_ERROR_CODE_ALLOWLIST);

/** Closed session values on a structured provider status object. */
export const PROVIDER_AUTH_SESSION_ALLOWLIST = [
  "unauthenticated",
  "invalidated",
] as const;

export type ProviderAuthSession = (typeof PROVIDER_AUTH_SESSION_ALLOWLIST)[number];

const SESSION_SET: ReadonlySet<string> = new Set(PROVIDER_AUTH_SESSION_ALLOWLIST);

/**
 * Structured provider authentication status recovered from a CLI envelope or
 * attached by an adapter. Missing status is not invented as authenticated.
 */
export interface ProviderAuthStatus {
  session?: ProviderAuthSession;
  error_code?: string;
  /** Numeric HTTP status on the same structured object (401 only is classified). */
  http_status?: number;
}

export interface ProviderAuthSignals {
  preflight_reason_code?: string | null;
  provider_auth_status?: ProviderAuthStatus | null;
  stdout?: string;
  stderr?: string;
}

function isAllowlistedErrorCode(value: unknown): value is ProviderAuthErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

function isAllowlistedSession(value: unknown): value is ProviderAuthSession {
  return typeof value === "string" && SESSION_SET.has(value);
}

function closedErrorCode(obj: Record<string, unknown>): string | undefined {
  if (isAllowlistedErrorCode(obj.code)) return obj.code;
  const error = obj.error;
  if (isJsonRecord(error) && isAllowlistedErrorCode(error.code)) return error.code;
  return undefined;
}

function closedSession(obj: Record<string, unknown>): ProviderAuthSession | undefined {
  if (isAllowlistedSession(obj.session)) return obj.session;
  if (obj.authenticated === false) return "unauthenticated";
  return undefined;
}

function structuredHttp401(obj: Record<string, unknown>): number | undefined {
  const httpStatus =
    typeof obj.http_status === "number"
      ? obj.http_status
      : typeof obj.status === "number"
        ? obj.status
        : undefined;
  if (httpStatus !== 401) return undefined;
  // 401 counts only on a provider-status-shaped object, never a bare number
  // or an unrelated JSON document.
  const hasErrorObject = isJsonRecord(obj.error);
  const hasSession = typeof obj.session === "string" || obj.authenticated === false;
  const hasAllowlistedCode = closedErrorCode(obj) != null;
  if (hasErrorObject || hasSession || hasAllowlistedCode) return 401;
  return undefined;
}

/** True when a structured status object is an environment-auth failure. */
export function isEnvironmentAuthStatus(
  status: ProviderAuthStatus | null | undefined,
): boolean {
  if (!status) return false;
  if (status.session && SESSION_SET.has(status.session)) return true;
  if (status.error_code && ERROR_CODE_SET.has(status.error_code)) return true;
  if (status.http_status === 401) return true;
  return false;
}

function statusFromJsonRecord(obj: Record<string, unknown>): ProviderAuthStatus | null {
  const errorCode = closedErrorCode(obj);
  const session = closedSession(obj);
  const httpStatus = structuredHttp401(obj);
  if (!errorCode && !session && httpStatus !== 401) return null;
  const status: ProviderAuthStatus = {};
  if (session) status.session = session;
  if (errorCode) status.error_code = errorCode;
  if (httpStatus === 401) status.http_status = 401;
  return isEnvironmentAuthStatus(status) ? status : null;
}

/**
 * Brace-aware scan for JSON objects embedded in mixed CLI logs. Ignores
 * leftover English sentences; only closed JSON objects are considered.
 */
function extractEmbeddedJsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const parsed = tryParseObjectAt(text, i);
    if (!parsed) continue;
    out.push(parsed.obj);
    i = parsed.end - 1;
  }
  return out;
}

function tryParseObjectAt(
  text: string,
  start: number,
): { obj: Record<string, unknown>; end: number } | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (isJsonRecord(parsed)) return { obj: parsed, end: i + 1 };
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

function collectJsonRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (obj: Record<string, unknown>) => {
    let key: string;
    try {
      key = JSON.stringify(obj);
    } catch {
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    records.push(obj);
  };
  for (const line of text.split("\n")) {
    const obj = parseJsonLine(line);
    if (obj) push(obj);
  }
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isJsonRecord(parsed)) push(parsed);
    } catch {
      // mixed log — fall through to embedded scan
    }
  }
  for (const obj of extractEmbeddedJsonObjects(text)) push(obj);
  return records;
}

/**
 * Prefer an already-structured status object. Otherwise scan CLI stdout/stderr
 * for allowlisted closed JSON fields only. Arbitrary prose is never a hit.
 */
export function extractProviderAuthStatus(
  stdout?: string | null,
  stderr?: string | null,
  structured?: ProviderAuthStatus | null,
): ProviderAuthStatus | null {
  if (isEnvironmentAuthStatus(structured)) return structured ?? null;
  const blob = `${stdout ?? ""}\n${stderr ?? ""}`;
  if (!blob.trim()) return null;
  for (const obj of collectJsonRecords(blob)) {
    const status = statusFromJsonRecord(obj);
    if (status) return status;
  }
  return null;
}

/** True when harness signals are typed environment-auth (not prose). */
export function isProviderEnvironmentAuth(signals: ProviderAuthSignals): boolean {
  if (signals.preflight_reason_code === "environment-auth") return true;
  return isEnvironmentAuthStatus(
    extractProviderAuthStatus(signals.stdout, signals.stderr, signals.provider_auth_status),
  );
}
