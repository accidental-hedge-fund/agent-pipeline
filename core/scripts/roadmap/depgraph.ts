// Phase 3: Dependency graph construction with source verification and topo sort.
// All external I/O is injectable via DepgraphDeps for unit testing.

import type { InventoryItem, DepGraph, DepEdge, CycleReport, OpenQuestion, IssueNumber } from "./types.ts";

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

/**
 * Build the full dependency graph from inventory items.
 * - Finds textual dependency candidates
 * - Source-verifies each candidate via harness
 * - Promotes confirmed edges to must_precede or should_precede
 * - Unverified candidates go to open_questions
 */
export async function buildDepgraph(
  items: InventoryItem[],
  deps: DepgraphDeps,
): Promise<DepGraph> {
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
  };

  if (items.length === 0) return graph;

  const itemByNumber = new Map(items.map((i) => [i.issue.number, i]));

  // Find candidate dependency pairs from issue text, shared files, and cross-file imports.
  // Candidate pair [prerequisite, depender]: prerequisite must come before depender.
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

  const allCandidates = [...textualCandidates, ...fileCandidates, ...crossFileCandidates];

  // Source-verify each candidate. Edge convention: {from: prerequisite, to: depender}
  // so "from must precede to" = prerequisite comes before depender in the roadmap.
  for (const [prereqNum, dependerNum] of allCandidates) {
    const itemPrereq = itemByNumber.get(prereqNum);
    const itemDepender = itemByNumber.get(dependerNum);

    if (!itemPrereq || !itemDepender) continue;

    deps.log(`[roadmap] depgraph: verifying prerequisite #${prereqNum} → depender #${dependerNum}...`);
    const prompt = await buildDepVerifyPrompt(itemPrereq, itemDepender, deps);
    const result = await deps.runHarness(prompt);

    if (!result.success) {
      graph.open_questions.push({
        description: `Could not verify dependency #${prereqNum} → #${dependerNum} (harness failed)`,
        related_issues: [prereqNum, dependerNum],
        rationale: "harness failure during dep verification",
      });
      continue;
    }

    const verified = parseDepVerifyResult(result.output);
    if (!verified) {
      graph.open_questions.push({
        description: `Could not parse dep-verify result for #${prereqNum} → #${dependerNum}`,
        related_issues: [prereqNum, dependerNum],
        rationale: "parse failure",
      });
      continue;
    }

    if (!verified.edge_confirmed) {
      graph.open_questions.push({
        description: `Dependency #${prereqNum} → #${dependerNum} not source-verified`,
        related_issues: [prereqNum, dependerNum],
        rationale: verified.rationale || "edge not source-verified",
      });
      continue;
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
  }

  // Detect cycles in must_precede edges
  const { cycleReports } = topoSort(
    items.map((i) => i.issue.number),
    graph.must_precede,
  );
  graph.cycle_reports = cycleReports;

  if (cycleReports.length > 0) {
    deps.log(`[roadmap] depgraph: WARNING — ${cycleReports.length} cycle(s) detected`);
  }

  deps.log(`[roadmap] depgraph: ${graph.must_precede.length} must_precede, ${graph.should_precede.length} should_precede edges`);
  return graph;
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
