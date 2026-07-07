// Phase 3: Dependency graph construction with source verification and topo sort.
// All external I/O is injectable via DepgraphDeps for unit testing.

import type { InventoryItem, DepGraph, DepEdge, CycleReport, OpenQuestion, IssueNumber, RoadmapConfig } from "./types.ts";
import { runPool } from "./pool.ts";

export interface DepVerifyResult {
  edge_confirmed: boolean;
  file_line: string;
  rationale: string;
  is_strong: boolean; // true → must_precede, false → should_precede
}

export interface DepgraphDeps {
  runHarness(prompt: string): Promise<{ success: boolean; output: string }>;
  readFile(path: string): Promise<string | null>;
  log(msg: string): void;
}

/**
 * Build a dep-verify prompt for a candidate pair. Reads file content from deps.
 * Convention: prerequisite must come before depender in the roadmap.
 * The prompt asks whether the DEPENDER cannot be completed without the PREREQUISITE.
 */
export async function buildDepVerifyPrompt(
  prerequisite: InventoryItem,
  depender: InventoryItem,
  deps: DepgraphDeps,
): Promise<string> {
  // Read shared files + each issue's own files to detect cross-file import relationships.
  const sharedFiles = prerequisite.touched_files.filter((f) => depender.touched_files.includes(f));
  const prereqOnly = prerequisite.touched_files.filter((f) => !sharedFiles.includes(f));
  const dependerOnly = depender.touched_files.filter((f) => !sharedFiles.includes(f));
  const filesToRead = [
    ...sharedFiles,
    ...prereqOnly.slice(0, 2),
    ...dependerOnly.slice(0, 2),
  ].slice(0, 5); // limit total to 5 files

  let fileContents = "";
  for (const f of filesToRead) {
    const content = await deps.readFile(f);
    if (content) {
      fileContents += `\n### ${f}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\`\n`;
    }
  }

  return (
    `You are analyzing whether issue #${depender.issue.number} depends on issue #${prerequisite.issue.number}` +
    ` (i.e., #${depender.issue.number} CANNOT be completed without #${prerequisite.issue.number}).\n\n` +
    `## Prerequisite candidate (#${prerequisite.issue.number}): ${prerequisite.issue.title}\n${prerequisite.issue.body.slice(0, 1000)}\n\n` +
    `## Depender candidate (#${depender.issue.number}): ${depender.issue.title}\n${depender.issue.body.slice(0, 1000)}\n\n` +
    (fileContents ? `## Source files\n${fileContents}\n\n` : "") +
    `Determine if #${depender.issue.number} (depender) depends on #${prerequisite.issue.number} (prerequisite) by examining the source files.\n` +
    `Look for: imports, type references, shared config keys, data migration ordering, API contracts.\n` +
    `Return a JSON object:\n` +
    `{"edge_confirmed": boolean, "file_line": "path/to/file.ts:42 or empty", "rationale": "explanation", "is_strong": boolean}\n\n` +
    `edge_confirmed: true only when you find a concrete source-code coupling (an import, shared config key, data migration order, etc.).\n` +
    `file_line: the specific file:line where the coupling is evident. Empty string if not confirmed.\n` +
    `is_strong: true when the dependency is a hard prerequisite (must_precede); false when it is advisory (should_precede).\n` +
    `Return raw JSON only, no prose.`
  );
}

/**
 * Parse the dep-verify harness output.
 */
export function parseDepVerifyResult(output: string): DepVerifyResult | null {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.edge_confirmed !== "boolean") return null;
    return {
      edge_confirmed: parsed.edge_confirmed === true,
      file_line: typeof parsed.file_line === "string" ? parsed.file_line : "",
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      is_strong: parsed.is_strong === true,
    };
  } catch {
    return null;
  }
}

/**
 * Check whether there are any textual dependency hints in issue bodies
 * (e.g., "depends on #42", "requires #10").
 * Returns pairs [prerequisite, depender] so the edge {from: prerequisite, to: depender}
 * means "prerequisite must precede depender".
 */
export function findTextualDepCandidates(items: InventoryItem[]): Array<[IssueNumber, IssueNumber]> {
  const issueNumbers = new Set(items.map((i) => i.issue.number));
  const candidates: Array<[IssueNumber, IssueNumber]> = [];
  const depRe = /(?:depends on|requires|blocked by|needs)\s+#(\d+)/gi;

  for (const item of items) {
    const text = `${item.issue.title}\n${item.issue.body}`;
    depRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = depRe.exec(text)) !== null) {
      const depNum = Number.parseInt(m[1], 10);
      if (issueNumbers.has(depNum) && depNum !== item.issue.number) {
        // item.issue depends on depNum → depNum (prerequisite) must precede item.issue (depender)
        candidates.push([depNum, item.issue.number]);
      }
    }
  }
  return candidates;
}

/**
 * Generate dependency candidates from shared touched-file relationships.
 * When two issues share touched files, BOTH directions are generated so the
 * harness source-verifies each independently.
 * Returns pairs [prerequisite-candidate, depender-candidate].
 */
export function findFileBasedDepCandidates(
  items: InventoryItem[],
  existingCandidates: Array<[IssueNumber, IssueNumber]>,
): Array<[IssueNumber, IssueNumber]> {
  const existing = new Set(existingCandidates.map(([a, b]) => `${a}:${b}`));
  const candidates: Array<[IssueNumber, IssueNumber]> = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const sharedFiles = a.touched_files.filter((f) => b.touched_files.includes(f));
      if (sharedFiles.length === 0) continue;

      // Generate both directions so the harness can verify which dependency is real.
      const fwdKey = `${a.issue.number}:${b.issue.number}`;
      const revKey = `${b.issue.number}:${a.issue.number}`;
      if (!existing.has(fwdKey)) {
        candidates.push([a.issue.number, b.issue.number]);
        existing.add(fwdKey);
      }
      if (!existing.has(revKey)) {
        candidates.push([b.issue.number, a.issue.number]);
        existing.add(revKey);
      }
    }
  }
  return candidates;
}

/**
 * Scan touched files for import references that point to another issue's files.
 * Generates candidate pairs for cross-file dependencies (e.g., issue A's file
 * imports a type from issue B's file — no shared file, but a real coupling).
 * Returns pairs [prerequisite-candidate, depender-candidate].
 */
export async function findCrossFileDepCandidates(
  items: InventoryItem[],
  existingCandidates: Array<[IssueNumber, IssueNumber]>,
  deps: DepgraphDeps,
): Promise<Array<[IssueNumber, IssueNumber]>> {
  const existing = new Set(existingCandidates.map(([a, b]) => `${a}:${b}`));
  const candidates: Array<[IssueNumber, IssueNumber]> = [];

  // Build map: file stem → issue numbers that touch it
  const stemToIssues = new Map<string, IssueNumber[]>();
  for (const item of items) {
    for (const f of item.touched_files) {
      // Use the filename stem (e.g., "types" from "core/types.ts") as the key
      const stem = f.replace(/\.[^./]+$/, "").replace(/.*\//, "");
      if (!stem) continue;
      if (!stemToIssues.has(stem)) stemToIssues.set(stem, []);
      stemToIssues.get(stem)!.push(item.issue.number);
    }
  }

  // Import regex: TS/JS/Python-style import statements
  const importRe = /(?:from\s+['"]|import\s+['"]|require\s*\(\s*['"])([^'"]+)['"]/g;

  for (const item of items) {
    for (const filePath of item.touched_files.slice(0, 5)) {
      const content = await deps.readFile(filePath);
      if (!content) continue;

      importRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const importPath = m[1];
        // Extract the stem of the imported module (last path segment, no extension)
        const importStem = importPath.replace(/\.[^./]+$/, "").replace(/.*\//, "");
        if (!importStem) continue;

        const otherNums = stemToIssues.get(importStem);
        if (!otherNums) continue;

        for (const otherNum of otherNums) {
          if (otherNum === item.issue.number) continue;
          // item.issue.number (depender) imports from otherNum's file (prerequisite)
          const fwdKey = `${otherNum}:${item.issue.number}`;
          const revKey = `${item.issue.number}:${otherNum}`;
          if (!existing.has(fwdKey)) {
            candidates.push([otherNum, item.issue.number]);
            existing.add(fwdKey);
          }
          // Also verify the reverse in case we got the direction wrong
          if (!existing.has(revKey)) {
            candidates.push([item.issue.number, otherNum]);
            existing.add(revKey);
          }
        }
      }
    }
  }
  return candidates;
}

/**
 * Topological sort returning tiers of issue numbers.
 * Returns { tiers: IssueNumber[][], cycleReports: CycleReport[] }.
 * Items in the same tier can run in parallel.
 * Cycles are reported and the affected issues are placed in their own tier.
 */
export function topoSort(
  issueNumbers: IssueNumber[],
  mustPrecede: DepEdge[],
): { tiers: IssueNumber[][]; cycleReports: CycleReport[] } {
  // Build adjacency: from → [to] where "A must_precede B" means A must come before B
  const inDegree = new Map<IssueNumber, number>();
  const outEdges = new Map<IssueNumber, IssueNumber[]>();

  for (const n of issueNumbers) {
    inDegree.set(n, 0);
    outEdges.set(n, []);
  }

  for (const edge of mustPrecede) {
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
    outEdges.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const tiers: IssueNumber[][] = [];
  const remaining = new Set(issueNumbers);
  const sorted = new Set<IssueNumber>();

  while (remaining.size > 0) {
    // Collect all nodes with in-degree 0 among remaining
    const tier: IssueNumber[] = [];
    for (const n of remaining) {
      if ((inDegree.get(n) ?? 0) === 0) {
        tier.push(n);
      }
    }

    if (tier.length === 0) {
      // Cycle detected — collect remaining nodes
      const cycleNodes = [...remaining];
      const cycleReports: CycleReport[] = [
        {
          issues: cycleNodes,
          description: `Cycle detected among issues: ${cycleNodes.map((n) => `#${n}`).join(", ")}. Cannot determine a definitive ordering.`,
        },
      ];
      // Place cycle nodes in their own tier (with a conflict marker)
      tiers.push(cycleNodes);
      return { tiers, cycleReports };
    }

    // Sort tier for determinism
    tier.sort((a, b) => a - b);
    tiers.push(tier);

    for (const n of tier) {
      remaining.delete(n);
      sorted.add(n);
      // Decrement in-degree for successors
      for (const succ of outEdges.get(n) ?? []) {
        inDegree.set(succ, (inDegree.get(succ) ?? 0) - 1);
      }
    }
  }

  return { tiers, cycleReports: [] };
}

export interface DepgraphStats {
  candidates_textual: number;
  candidates_shared_file: number;
  candidates_cross_file: number;
  verify_calls: number;
  verify_skipped: number;
}

/** Source type priority for deduplication: lower number = higher priority. */
const SOURCE_PRIORITY: Record<string, number> = { textual: 0, "shared-file": 1, "cross-file": 2 };

interface TaggedCandidate {
  pair: [IssueNumber, IssueNumber];
  source: "textual" | "shared-file" | "cross-file";
  sharedFileCount: number;
}

/**
 * Build a ranked, deduplicated list of dependency candidates from all sources.
 * Deduplication keeps the highest-priority source tag for each unique pair.
 * Ranking: textual → shared-file → cross-file; within group descending by sharedFileCount.
 */
export function rankCandidates(
  textual: Array<[IssueNumber, IssueNumber]>,
  sharedFile: Array<[IssueNumber, IssueNumber]>,
  crossFile: Array<[IssueNumber, IssueNumber]>,
  items: InventoryItem[],
): TaggedCandidate[] {
  const itemByNumber = new Map(items.map((i) => [i.issue.number, i]));

  function sharedFileCount(a: IssueNumber, b: IssueNumber): number {
    const filesA = itemByNumber.get(a)?.touched_files ?? [];
    const filesB = itemByNumber.get(b)?.touched_files ?? [];
    return filesA.filter((f) => filesB.includes(f)).length;
  }

  const seen = new Map<string, TaggedCandidate>();

  function add(pair: [IssueNumber, IssueNumber], source: "textual" | "shared-file" | "cross-file"): void {
    const key = `${pair[0]}:${pair[1]}`;
    const existing = seen.get(key);
    if (!existing || SOURCE_PRIORITY[source]! < SOURCE_PRIORITY[existing.source]!) {
      seen.set(key, { pair, source, sharedFileCount: sharedFileCount(pair[0], pair[1]) });
    }
  }

  for (const p of textual) add(p, "textual");
  for (const p of sharedFile) add(p, "shared-file");
  for (const p of crossFile) add(p, "cross-file");

  const all = [...seen.values()];
  all.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source]!;
    const pb = SOURCE_PRIORITY[b.source]!;
    if (pa !== pb) return pa - pb;
    return b.sharedFileCount - a.sharedFileCount;
  });
  return all;
}

/**
 * Build the full dependency graph from inventory items.
 * - Collects textual, shared-file, and cross-file candidates
 * - Deduplicates and ranks candidates (textual first)
 * - Caps verification at config.depgraph_verify_cap (default 20); excess → open_questions
 * - Runs verification with bounded concurrency (config.depgraph_concurrency ?? 4)
 * - Returns graph and stats for run_stats assembly
 */
export async function buildDepgraph(
  items: InventoryItem[],
  deps: DepgraphDeps,
  config: Pick<RoadmapConfig, "depgraph_concurrency" | "depgraph_verify_cap"> = {},
): Promise<{ graph: DepGraph; stats: DepgraphStats }> {
  deps.log("[roadmap] phase 3: depgraph — building dependency graph...");

  const graph: DepGraph = {
    must_precede: [],
    should_precede: [],
    parallel_safe: [],
    blocked_pending_decision: [],
    duplicate_merge: [],
    conflict_pairs: [],
    cycle_reports: [],
    open_questions: [],
    cross_repo: [],
  };

  if (items.length === 0) {
    return {
      graph,
      stats: { candidates_textual: 0, candidates_shared_file: 0, candidates_cross_file: 0, verify_calls: 0, verify_skipped: 0 },
    };
  }

  const itemByNumber = new Map(items.map((i) => [i.issue.number, i]));

  // Collect candidates from all three sources.
  const textualCandidates = findTextualDepCandidates(items);
  deps.log(`[roadmap] depgraph: found ${textualCandidates.length} textual dep candidates`);
  const fileCandidates = findFileBasedDepCandidates(items, textualCandidates);
  deps.log(`[roadmap] depgraph: found ${fileCandidates.length} shared-file dep candidates`);
  const crossFileCandidates = await findCrossFileDepCandidates(
    items,
    [...textualCandidates, ...fileCandidates],
    deps,
  );
  deps.log(`[roadmap] depgraph: found ${crossFileCandidates.length} cross-file dep candidates`);

  // Deduplicate and rank before verification.
  const ranked = rankCandidates(textualCandidates, fileCandidates, crossFileCandidates, items);
  deps.log(`[roadmap] depgraph: ${ranked.length} unique candidates after deduplication`);

  // Apply verification cap.
  const verifyCap = config.depgraph_verify_cap ?? 20;
  const toVerify = ranked.slice(0, verifyCap);
  const capped = ranked.slice(verifyCap);

  for (const { pair: [prereqNum, dependerNum] } of capped) {
    graph.open_questions.push({
      description: `Dependency candidate #${prereqNum} → #${dependerNum} not verified (ranked beyond cap)`,
      related_issues: [prereqNum, dependerNum],
      rationale: "candidate ranked beyond verify cap",
    });
  }

  if (capped.length > 0) {
    deps.log(`[roadmap] depgraph: ${capped.length} candidates skipped due to verify cap (${verifyCap})`);
  }

  // Source-verify the capped list with bounded concurrency.
  const concurrency = config.depgraph_concurrency ?? 4;

  const verifyTasks = toVerify.map(({ pair: [prereqNum, dependerNum] }) => async () => {
    const itemPrereq = itemByNumber.get(prereqNum);
    const itemDepender = itemByNumber.get(dependerNum);

    if (!itemPrereq || !itemDepender) return;

    deps.log(`[roadmap] depgraph: verifying prerequisite #${prereqNum} → depender #${dependerNum}...`);
    const prompt = await buildDepVerifyPrompt(itemPrereq, itemDepender, deps);
    const result = await deps.runHarness(prompt);

    if (!result.success) {
      graph.open_questions.push({
        description: `Could not verify dependency #${prereqNum} → #${dependerNum} (harness failed)`,
        related_issues: [prereqNum, dependerNum],
        rationale: "harness failure during dep verification",
      });
      return;
    }

    const verified = parseDepVerifyResult(result.output);
    if (!verified) {
      graph.open_questions.push({
        description: `Could not parse dep-verify result for #${prereqNum} → #${dependerNum}`,
        related_issues: [prereqNum, dependerNum],
        rationale: "parse failure",
      });
      return;
    }

    if (!verified.edge_confirmed) {
      graph.open_questions.push({
        description: `Dependency #${prereqNum} → #${dependerNum} not source-verified`,
        related_issues: [prereqNum, dependerNum],
        rationale: verified.rationale || "edge not source-verified",
      });
      return;
    }

    const edge: DepEdge = {
      from: prereqNum,
      to: dependerNum,
      file_line: verified.file_line,
      rationale: verified.rationale,
    };

    if (verified.is_strong) {
      graph.must_precede.push(edge);
      deps.log(`[roadmap] depgraph: promoted must_precede #${prereqNum} → #${dependerNum} (${verified.file_line})`);
    } else {
      graph.should_precede.push(edge);
      deps.log(`[roadmap] depgraph: promoted should_precede #${prereqNum} → #${dependerNum} (${verified.file_line})`);
    }
  });

  await runPool(verifyTasks, concurrency);

  // Detect cycles in must_precede edges.
  const { cycleReports } = topoSort(
    items.map((i) => i.issue.number),
    graph.must_precede,
  );
  graph.cycle_reports = cycleReports;

  if (cycleReports.length > 0) {
    deps.log(`[roadmap] depgraph: WARNING — ${cycleReports.length} cycle(s) detected`);
  }

  deps.log(`[roadmap] depgraph: ${graph.must_precede.length} must_precede, ${graph.should_precede.length} should_precede edges`);

  return {
    graph,
    stats: {
      candidates_textual: textualCandidates.length,
      candidates_shared_file: fileCandidates.length,
      candidates_cross_file: crossFileCandidates.length,
      verify_calls: toVerify.length,
      verify_skipped: capped.length,
    },
  };
}

/**
 * Add additional must_precede edges (e.g., from critique corrections) and re-run topo sort.
 */
export function addMustPrecedeEdges(graph: DepGraph, newEdges: DepEdge[], allIssues: IssueNumber[]): DepGraph {
  const combined = [...graph.must_precede, ...newEdges];
  const { cycleReports } = topoSort(allIssues, combined);
  return {
    ...graph,
    must_precede: combined,
    cycle_reports: cycleReports,
  };
}
