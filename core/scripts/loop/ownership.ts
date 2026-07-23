// Durable-run ownership + conflict declarations (#529, capability
// `durable-run-ownership-conflicts`). Supplies the missing planning model for epic #528's
// three-part disjointness proof (dependency / declared ownership / shared surface): a
// machine-readable per-item ownership + conflict declaration, deterministic normalization of
// declared surfaces into a typed set, and a pure, deterministic pairwise evaluator returning
// `disjoint`/`conflict` with a structured reason. Conservative on unknown ownership by
// construction (empty/absent declaration ⇒ conflict), never a scheduler and never a merge/review
// gate — that is #530/#531.
//
// See openspec/changes/durable-run-ownership-conflicts/design.md for the decisions this module
// implements. Every function here is pure (no gh, git, or fs); the one durable-evidence writer
// (`recordOwnershipEvidence`) is a thin wrapper over the existing events log (`appendEvent`,
// loop/store.ts) — no new store is invented.

import {
  LoopError,
  isOwnershipSharedSurfaceKind,
  type LoopEvent,
  type NormalizedOwnershipSurface,
  type OwnershipConflictVerdict,
  type OwnershipDeclaration,
  type OwnershipEvaluationEvidence,
  type OwnershipEvidenceItem,
  type OwnershipEvidencePair,
  type OwnershipException,
  type OwnershipSharedSurfaceKind,
} from "./types.ts";
import { appendEvent, type LoopStoreDeps } from "./store.ts";

// ---------------------------------------------------------------------------
// Schema validation — fail closed, per repo convention (recovery.ts compileRecoveryPolicy).
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Characters permitted in a glob pattern — a narrow allowlist so an unrecognized or ambiguous
 *  construct is rejected rather than silently mis-normalized. */
const VALID_PATTERN_CHARS_RE = /^[A-Za-z0-9_./*?-]+$/;

/** True when `pattern` is not a well-formed glob this module can normalize/compare: empty,
 *  outside the character allowlist, containing three-or-more consecutive `*`, or embedding `**`
 *  inside a path segment (this module's overlap algorithm treats `**` only as a standalone
 *  segment token, never a fragment of one). */
function isMalformedGlob(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return true;
  if (!VALID_PATTERN_CHARS_RE.test(trimmed)) return true;
  if (trimmed.includes("***")) return true;
  for (const segment of trimmed.split("/")) {
    if (segment.length === 0) continue;
    if (segment.includes("**") && segment !== "**") return true;
    // A `..` parent-directory segment lets two spellings alias the same filesystem surface while
    // comparing as lexically distinct, defeating overlap detection (finding #529 review 2).
    if (segment === "..") return true;
  }
  return false;
}

/** Validates a per-item ownership + conflict declaration. An absent/`null` declaration is valid
 *  (unknown ownership). Refuses (LoopError "validation") an unknown surface kind, a malformed
 *  glob, or an exception missing its required `justification`/`review_ref`. */
export function validateOwnershipDeclaration(decl: unknown): asserts decl is OwnershipDeclaration | undefined {
  if (decl === undefined || decl === null) return;
  if (!isPlainObject(decl)) {
    throw new LoopError("validation", "ownership declaration must be an object");
  }

  if (decl.exclusive !== undefined) {
    if (!Array.isArray(decl.exclusive) || decl.exclusive.some((p) => typeof p !== "string")) {
      throw new LoopError("validation", "ownership.exclusive must be an array of glob strings");
    }
    for (const pattern of decl.exclusive as string[]) {
      if (isMalformedGlob(pattern)) {
        throw new LoopError("validation", `ownership.exclusive names a malformed glob: "${pattern}"`);
      }
    }
  }

  if (decl.shared !== undefined) {
    if (!isPlainObject(decl.shared)) {
      throw new LoopError("validation", "ownership.shared must be an object keyed by shared-surface class");
    }
    for (const [kind, patterns] of Object.entries(decl.shared)) {
      if (!isOwnershipSharedSurfaceKind(kind)) {
        throw new LoopError("validation", `ownership.shared names an unknown surface kind: "${kind}"`);
      }
      if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
        throw new LoopError("validation", `ownership.shared["${kind}"] must be an array of glob strings`);
      }
      for (const pattern of patterns as string[]) {
        if (isMalformedGlob(pattern)) {
          throw new LoopError("validation", `ownership.shared["${kind}"] names a malformed glob: "${pattern}"`);
        }
      }
    }
  }

  if (decl.conflicts_with !== undefined) {
    if (!Array.isArray(decl.conflicts_with) || decl.conflicts_with.some((id) => typeof id !== "string")) {
      throw new LoopError("validation", "ownership.conflicts_with must be an array of item ids");
    }
  }

  if (decl.exceptions !== undefined) {
    if (!Array.isArray(decl.exceptions)) {
      throw new LoopError("validation", "ownership.exceptions must be an array");
    }
    for (const exception of decl.exceptions as unknown[]) {
      if (!isPlainObject(exception)) {
        throw new LoopError("validation", "ownership exception must be an object");
      }
      const surface = exception.surface;
      if (
        !isPlainObject(surface) ||
        !isOwnershipSharedSurfaceKind(surface.kind) ||
        typeof surface.pattern !== "string" ||
        isMalformedGlob(surface.pattern)
      ) {
        throw new LoopError("validation", "ownership exception.surface must name a valid shared-surface kind and pattern");
      }
      if (typeof exception.justification !== "string" || exception.justification.trim().length === 0) {
        throw new LoopError("validation", "ownership exception is missing its required justification");
      }
      if (typeof exception.review_ref !== "string" || exception.review_ref.trim().length === 0) {
        throw new LoopError("validation", "ownership exception is missing its required review_ref");
      }
      if (typeof exception.counterpart_item_id !== "string" || exception.counterpart_item_id.trim().length === 0) {
        throw new LoopError("validation", "ownership exception is missing its required counterpart_item_id");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Normalization — deterministic, pure, byte-identical on re-normalization.
// ---------------------------------------------------------------------------

/** Canonicalizes a glob pattern so equivalent spellings normalize identically: trims, converts
 *  backslashes, strips a leading `./`, collapses repeated `/`, and drops a trailing `/`. */
function canonicalizePattern(pattern: string): string {
  let p = pattern.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Total order over normalized surfaces (class, then kind, then pattern) — the documented sort
 *  that makes re-normalization byte-identical. */
function compareSurfaces(a: NormalizedOwnershipSurface, b: NormalizedOwnershipSurface): number {
  if (a.class !== b.class) return a.class < b.class ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1;
  return 0;
}

/** Normalizes a validated ownership declaration into a deterministic, sorted, de-duped typed
 *  surface set. An absent/empty declaration normalizes to the empty set — the unknown-ownership
 *  signal {@link evaluateConflict} treats as unsafe for parallel execution. Pure; introduces no
 *  I/O. */
export function normalizeOwnership(decl: OwnershipDeclaration | undefined | null): NormalizedOwnershipSurface[] {
  if (!decl) return [];
  const entries = new Map<string, NormalizedOwnershipSurface>();

  for (const pattern of decl.exclusive ?? []) {
    const canon = canonicalizePattern(pattern);
    entries.set(`exclusive source ${canon}`, { kind: "source", pattern: canon, class: "exclusive" });
  }

  for (const [kind, patterns] of Object.entries(decl.shared ?? {})) {
    for (const pattern of patterns ?? []) {
      const canon = canonicalizePattern(pattern);
      entries.set(`shared ${kind} ${canon}`, {
        kind: kind as OwnershipSharedSurfaceKind,
        pattern: canon,
        class: "shared",
      });
    }
  }

  return [...entries.values()].sort(compareSurfaces);
}

// ---------------------------------------------------------------------------
// Deterministic glob overlap — segment-wise, conservative on undecidable cases.
// ---------------------------------------------------------------------------

function splitSegments(pattern: string): string[] {
  return canonicalizePattern(pattern)
    .split("/")
    .filter((s) => s.length > 0);
}

function segmentRegex(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

/** Whether two single path segments (no `**`) can both match some common literal segment.
 *  Exact-literal segments overlap iff identical; a wildcarded segment is tested against a plain
 *  one via regex; two independently wildcarded segments are treated as overlapping — the
 *  documented conservative default for an undecidable case (design.md "Glob-overlap
 *  correctness"). */
function segmentsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aWild = a.includes("*") || a.includes("?");
  const bWild = b.includes("*") || b.includes("?");
  if (!aWild && !bWild) return false;
  if (aWild && !bWild) return segmentRegex(a).test(b);
  if (!aWild && bWild) return segmentRegex(b).test(a);
  return true;
}

/** Deterministic, pure glob-overlap check with no I/O: true iff some path could match both
 *  patterns. `**` matches zero or more whole path segments; a plain segment (optionally
 *  containing `*`/`?`) matches exactly one segment. Segment-wise dynamic-programming
 *  intersection, memoized per call — exact-path and glob cases are pinned by tests rather than
 *  assumed (golden rule #5). */
export function globOverlap(patternA: string, patternB: string): boolean {
  const a = splitSegments(patternA);
  const b = splitSegments(patternB);
  const memo = new Map<string, boolean>();

  function rec(i: number, j: number): boolean {
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    // Every recursive call strictly increases i+j, so (i, j) is never re-entered before this
    // call resolves — no memo pre-guard against reentrancy is needed.
    let result: boolean;
    if (i === a.length && j === b.length) {
      result = true;
    } else if (i === a.length) {
      result = b.slice(j).every((s) => s === "**");
    } else if (j === b.length) {
      result = a.slice(i).every((s) => s === "**");
    } else {
      const segA = a[i];
      const segB = b[j];
      if (segA === "**" && segB === "**") {
        result = rec(i + 1, j) || rec(i, j + 1) || rec(i + 1, j + 1);
      } else if (segA === "**") {
        result = rec(i + 1, j) || rec(i, j + 1);
      } else if (segB === "**") {
        result = rec(i, j + 1) || rec(i + 1, j);
      } else {
        result = segmentsOverlap(segA, segB) && rec(i + 1, j + 1);
      }
    }
    memo.set(key, result);
    return result;
  }

  return rec(0, 0);
}

// ---------------------------------------------------------------------------
// Pairwise evaluation — fixed precedence, single-cause reason (design.md "Evaluation order").
// ---------------------------------------------------------------------------

export interface OwnershipEvalInput {
  id: string;
  decl?: OwnershipDeclaration | null;
  normalized: NormalizedOwnershipSurface[];
}

/** True iff a valid reviewed exception names `surface` **for this specific pair** — an exception
 *  declared by `a` must name `b.id` as its counterpart (and vice versa), so an exception reviewed
 *  for A↔B never suppresses the same surface for A↔C (finding #529 review 1). */
function hasValidException(
  a: { id: string; decl: OwnershipDeclaration | null | undefined },
  b: { id: string; decl: OwnershipDeclaration | null | undefined },
  surface: NormalizedOwnershipSurface,
): boolean {
  const exceptions: OwnershipException[] = [
    ...(a.decl?.exceptions ?? []).map((e) => ({ e, counterpart: b.id })),
    ...(b.decl?.exceptions ?? []).map((e) => ({ e, counterpart: a.id })),
  ].filter(({ e, counterpart }) => e.counterpart_item_id === counterpart).map(({ e }) => e);
  return exceptions.some(
    (e) =>
      e.surface.kind === surface.kind &&
      canonicalizePattern(e.surface.pattern) === surface.pattern &&
      e.justification.trim().length > 0 &&
      e.review_ref.trim().length > 0,
  );
}

/** Evaluates one ordered pair of items' validated declarations and returns exactly one verdict —
 *  `disjoint` or `conflict` — with a structured, single-cause reason. Fixed precedence: (1) an
 *  explicit `conflicts_with` edge — always conflict, never suppressible; (2) unknown ownership
 *  (either item declares no surface) — conflict; (3) co-owned shared surface — conflict unless a
 *  valid reviewed exception names it; (4) overlapping exclusive globs — conflict. `disjoint` only
 *  when none of these fire. Pure, deterministic, no I/O — the same pair always yields the same
 *  verdict and reason. */
export function evaluateConflict(a: OwnershipEvalInput, b: OwnershipEvalInput): OwnershipConflictVerdict {
  if ((a.decl?.conflicts_with ?? []).includes(b.id) || (b.decl?.conflicts_with ?? []).includes(a.id)) {
    return { verdict: "conflict", reason: { kind: "explicit_edge" } };
  }

  if (a.normalized.length === 0) {
    return {
      verdict: "conflict",
      reason: { kind: "unknown_ownership", detail: `item "${a.id}" declares no ownership surfaces` },
    };
  }
  if (b.normalized.length === 0) {
    return {
      verdict: "conflict",
      reason: { kind: "unknown_ownership", detail: `item "${b.id}" declares no ownership surfaces` },
    };
  }

  for (const sa of a.normalized) {
    if (sa.class !== "shared") continue;
    for (const sb of b.normalized) {
      if (sb.class !== "shared" || sb.kind !== sa.kind || sb.pattern !== sa.pattern) continue;
      if (!hasValidException({ id: a.id, decl: a.decl }, { id: b.id, decl: b.decl }, sa)) {
        return { verdict: "conflict", reason: { kind: "overlapping_surface", surface: sa } };
      }
    }
  }

  for (const sa of a.normalized) {
    if (sa.class !== "exclusive") continue;
    for (const sb of b.normalized) {
      if (sb.class !== "exclusive") continue;
      if (globOverlap(sa.pattern, sb.pattern)) {
        return { verdict: "conflict", reason: { kind: "overlapping_surface", surface: sa } };
      }
    }
  }

  // A path claimed `exclusive` by one item and `shared` by the other still names the same
  // filesystem surface — comparing only within-class misses this and produces an unsafe
  // `disjoint` verdict (finding #529 review 2).
  for (const sa of a.normalized) {
    for (const sb of b.normalized) {
      if (sa.class === sb.class) continue;
      if (globOverlap(sa.pattern, sb.pattern)) {
        return { verdict: "conflict", reason: { kind: "overlapping_surface", surface: sa } };
      }
    }
  }

  return { verdict: "disjoint", reason: null };
}

// ---------------------------------------------------------------------------
// Durable planning evidence — a record only; schedules nothing (design.md Goals).
// ---------------------------------------------------------------------------

/** Builds the durable planning-evidence record for one evaluation pass over `items`: every
 *  item's normalized surface set, and every pair's verdict + structured reason. Pure — the
 *  caller persists the result via {@link recordOwnershipEvidence}. */
export function evaluateOwnershipEvidence(
  items: ReadonlyArray<{ id: string; ownership?: OwnershipDeclaration | null }>,
): OwnershipEvaluationEvidence {
  const evalInputs: OwnershipEvalInput[] = items.map((item) => {
    validateOwnershipDeclaration(item.ownership);
    return {
      id: item.id,
      decl: item.ownership,
      normalized: normalizeOwnership(item.ownership),
    };
  });

  const evidenceItems: OwnershipEvidenceItem[] = evalInputs.map((i) => ({ item_id: i.id, surfaces: i.normalized }));

  const pairs: OwnershipEvidencePair[] = [];
  for (let i = 0; i < evalInputs.length; i++) {
    for (let j = i + 1; j < evalInputs.length; j++) {
      const verdict = evaluateConflict(evalInputs[i], evalInputs[j]);
      pairs.push({
        a_item_id: evalInputs[i].id,
        b_item_id: evalInputs[j].id,
        verdict: verdict.verdict,
        reason: verdict.reason,
      });
    }
  }

  return { items: evidenceItems, pairs };
}

/** Persists an ownership-evaluation pass as durable planning evidence via the existing events
 *  log (`appendEvent`, loop/store.ts) — no new store is invented. A record only: it never
 *  schedules, starts, or serializes any item; scheduling is the consuming planner's
 *  responsibility (#530). Requires the current lock holder's `token`, per `appendEvent`. */
export async function recordOwnershipEvidence(
  deps: LoopStoreDeps,
  runId: string,
  token: string,
  evidence: OwnershipEvaluationEvidence,
): Promise<LoopEvent> {
  return appendEvent(deps, runId, token, "loop_ownership_evaluated", evidence);
}
