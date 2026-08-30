// Canonical JSON + SHA-256 helpers for grill-then-ready (#1072).
// Pure: no network, git, or subprocess.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SHA256_PREFIX = "sha256:";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** UTF-8 JSON with sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(o).sort()) {
    const v = o[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** SHA-256 of UTF-8 bytes as 64 lowercase hex (no prefix). */
export function sha256Hex(bytes: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof bytes === "string") hash.update(bytes, "utf8");
  else hash.update(bytes);
  return hash.digest("hex");
}

/** SHA-256 recorded as `sha256:` + 64 lowercase hex. */
export function sha256Prefixed(bytes: string | Buffer): string {
  return `${SHA256_PREFIX}${sha256Hex(bytes)}`;
}

export function isSha256Prefixed(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(SHA256_PREFIX)) return false;
  return SHA256_HEX_RE.test(value.slice(SHA256_PREFIX.length));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

export function hmacSha256Hex(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

export function hmacEqual(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
  } catch {
    return false;
  }
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
