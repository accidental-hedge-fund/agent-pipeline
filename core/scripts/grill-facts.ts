// Bounded declared-dependency closure for grill-then-ready (#1072).
// Uses parseDeclaredDependencyIds — no second parser.

import { parseDeclaredDependencyIds } from "./declared-dependency-grammar.ts";
import { extractSpecCore, type TypedUnresolvedFact } from "./grill-decisions.ts";
import { sha256Prefixed } from "./grill-hash.ts";
import type { DependencyClosureRecord } from "./grill-fingerprint.ts";

export const GRILL_DEP_MAX_DEPTH = 8;
export const GRILL_DEP_MAX_ISSUES = 32;

export type FetchedIssue =
  | { ok: true; title: string; body: string }
  | { ok: false; code: "missing" | "inaccessible" };

export interface WalkDependenciesDeps {
  fetchIssue(id: number): Promise<FetchedIssue>;
}

export interface DependencyWalk {
  record: DependencyClosureRecord;
  facts: TypedUnresolvedFact[];
  /** First-seen order, never truncated silently. */
  visited: number[];
}

export async function walkDeclaredDependencyClosure(
  rootIssue: number,
  rootTitle: string,
  rootBody: string,
  deps: WalkDependenciesDeps,
): Promise<DependencyWalk> {
  const facts: TypedUnresolvedFact[] = [];
  const visited: number[] = [];
  const perId: DependencyClosureRecord["per_id"] = [];
  const seen = new Set<number>();
  const stackPath: number[] = [];
  const edges: Array<{ from: number; to: number }> = [];
  let exhausted = false;

  async function visit(id: number, title: string, body: string, depth: number): Promise<void> {
    if (seen.has(id)) {
      if (stackPath.includes(id)) {
        facts.push({
          code: "dependency.cycle",
          issue_ids: [...stackPath, id],
          edges: edges.filter((e) => stackPath.includes(e.from) || stackPath.includes(e.to)),
          message: `dependency cycle involving #${id}`,
        });
      }
      return;
    }
    if (visited.length >= GRILL_DEP_MAX_ISSUES) {
      exhausted = true;
      facts.push({
        code: "dependency.closure_exhausted",
        issue_ids: [id],
        edges: [...edges],
        message: `dependency closure exceeded ${GRILL_DEP_MAX_ISSUES} issues at #${id}`,
      });
      return;
    }
    seen.add(id);
    visited.push(id);
    if (id !== rootIssue) {
      perId.push({
        id,
        title_sha256: sha256Prefixed(title),
        body_sha256: sha256Prefixed(body),
      });
    }
    const parseText =
      id === rootIssue ? `${title}\n${extractSpecCore(body)}` : `${title}\n${body}`;
    if (depth >= GRILL_DEP_MAX_DEPTH) {
      const childIds = parseDeclaredDependencyIds(parseText, String(id));
      if (childIds.length > 0) {
        exhausted = true;
        facts.push({
          code: "dependency.closure_exhausted",
          issue_ids: childIds.map((c) => Number(c)),
          edges: [...edges],
          message: `dependency closure exceeded depth ${GRILL_DEP_MAX_DEPTH} at #${id}`,
        });
      }
      return;
    }
    const rawIds = parseDeclaredDependencyIds(parseText, String(id));
    stackPath.push(id);
    for (const raw of rawIds) {
      if (!/^[1-9][0-9]*$/.test(raw)) {
        facts.push({
          code: "dependency.malformed",
          issue_ids: [id],
          edges: [...edges],
          message: `malformed dependency declaration ${raw} on #${id}`,
        });
        continue;
      }
      const child = Number(raw);
      edges.push({ from: id, to: child });
      if (seen.has(child) && stackPath.includes(child)) {
        facts.push({
          code: "dependency.cycle",
          issue_ids: [...stackPath, child],
          edges: edges.filter((e) => stackPath.includes(e.from) || e.to === child),
          message: `dependency cycle ${[...stackPath, child].map((n) => `#${n}`).join(" → ")}`,
        });
        continue;
      }
      if (child === rootIssue && id !== rootIssue) {
        // fetching root again is a cycle if we already visited it
      }
      const fetched = await deps.fetchIssue(child);
      if (!fetched.ok) {
        facts.push({
          code: fetched.code === "missing" ? "dependency.missing" : "dependency.inaccessible",
          issue_ids: [child],
          edges: [...edges],
          message: `dependency #${child} is ${fetched.code}`,
        });
        continue;
      }
      await visit(child, fetched.title, fetched.body, depth + 1);
      if (exhausted) return;
    }
    stackPath.pop();
  }

  await visit(rootIssue, rootTitle, rootBody, 0);
  return {
    record: {
      ids: visited.filter((id) => id !== rootIssue),
      per_id: perId,
      fact_codes: facts.map((f) => f.code),
    },
    facts,
    visited,
  };
}
