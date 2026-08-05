// Product-vs-scratch classification for gate trust checks (#873).
//
// Format and test gates require a worktree that is "clean enough" to trust:
// product-relevant uncommitted paths still hard-block, but engine-known
// non-product agent scratch (planning notes, ephemeral prompt drop files)
// must not alone refuse the gate or burn recovery budget as test-gate-
// exhausted. Lockfiles are intentionally NOT classified as scratch — they
// remain handled by lockfile fold (#722 / #358).

/**
 * Engine-known non-product scratch patterns (always active; config may only
 * **extend** this set, never replace it).
 *
 * - `tasks/**` — planning notes left dirty by scoped authoring salvage
 *   (`allowDirtyPattern: /^tasks\//`, #321); includes `tasks/todo.md`.
 * - `.pipeline-prompt-*` at worktree root — ephemeral harness prompt files
 *   (e.g. grok adapter writes `.pipeline-prompt-<uuid>.txt`).
 */
export const ENGINE_NON_PRODUCT_SCRATCH_GLOBS: readonly string[] = [
  "tasks/**",
  ".pipeline-prompt-*",
];

export interface DirtClassification {
  /** Paths that still fail gate trust (must be committed). */
  product: string[];
  /** Paths matching engine-known or config-extended non-product scratch. */
  scratch: string[];
}

/**
 * Parse `git status --porcelain` into worktree-relative paths (status columns
 * stripped; rename destinations preferred). Pure — no I/O.
 */
export function parsePorcelainPaths(statusOutput: string): string[] {
  const paths: string[] = [];
  for (const line of statusOutput.split("\n")) {
    if (line.length < 3) continue;
    const rest = line.slice(3); // two-char status + space
    const arrow = rest.indexOf(" -> ");
    const raw = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    // Porcelain may quote paths with spaces: "path with space"
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    if (unquoted) paths.push(unquoted);
  }
  return paths;
}

/**
 * Classify porcelain paths into product dirt vs non-product scratch.
 * `extraGlobs` is **unioned** with the engine-known set (never replaces it).
 */
export function classifyWorktreeDirt(
  paths: readonly string[],
  extraGlobs: readonly string[] = [],
): DirtClassification {
  const product: string[] = [];
  const scratch: string[] = [];
  for (const p of paths) {
    if (isNonProductScratchPath(p, extraGlobs)) scratch.push(p);
    else product.push(p);
  }
  return { product, scratch };
}

/** Product paths only — empty means clean enough for gate trust. */
export function productDirtyPaths(
  paths: readonly string[],
  extraGlobs: readonly string[] = [],
): string[] {
  return classifyWorktreeDirt(paths, extraGlobs).product;
}

/**
 * True when `filePath` matches engine-known scratch or any config extension
 * glob. Lockfiles and product trees never match the engine set.
 */
export function isNonProductScratchPath(
  filePath: string,
  extraGlobs: readonly string[] = [],
): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) return false;
  for (const pattern of ENGINE_NON_PRODUCT_SCRATCH_GLOBS) {
    if (matchScratchGlob(normalized, pattern)) return true;
  }
  for (const pattern of extraGlobs) {
    if (typeof pattern !== "string" || !pattern.trim()) continue;
    if (matchScratchGlob(normalized, pattern.trim())) return true;
  }
  return false;
}

/** Normalize a repo-relative path for matching (forward slashes, no leading ./). */
function normalizeRepoPath(filePath: string): string {
  let p = filePath.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  // Drop trailing slash except for root-ish empty
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Minimal path glob matcher for gate-trust scratch patterns.
 * Supports `*`, `**`, trailing `/` (prefix), and exact paths. No brace expansion.
 */
export function matchScratchGlob(filePath: string, pattern: string): boolean {
  const path = normalizeRepoPath(filePath);
  let pat = pattern.replace(/\\/g, "/").trim();
  while (pat.startsWith("./")) pat = pat.slice(2);

  // Trailing slash → directory prefix
  if (pat.endsWith("/") && !pat.endsWith("**/")) {
    const prefix = pat.slice(0, -1);
    return path === prefix || path.startsWith(prefix + "/");
  }

  // Fast paths for the engine-known patterns
  if (pat === "tasks/**") {
    return path === "tasks" || path.startsWith("tasks/");
  }
  if (pat === ".pipeline-prompt-*") {
    // Worktree-root only: no directory separators
    if (path.includes("/")) return false;
    return matchSimpleStar(path, ".pipeline-prompt-*");
  }

  // General: convert glob to regex
  // ** matches across segments; * matches within one segment
  let i = 0;
  let re = "^";
  while (i < pat.length) {
    if (pat[i] === "*" && pat[i + 1] === "*") {
      // ** or **/
      if (pat[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
      continue;
    }
    if (pat[i] === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (pat[i] === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    const ch = pat[i];
    if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
    i += 1;
  }
  re += "$";
  return new RegExp(re).test(path);
}

function matchSimpleStar(value: string, pattern: string): boolean {
  // pattern has a single * (no /)
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") {
      if (i === 0) continue; // leading *
      if (i === parts.length - 1) return true; // trailing *
      continue;
    }
    if (i === 0) {
      if (!value.startsWith(part)) return false;
      idx = part.length;
      continue;
    }
    if (i === parts.length - 1) {
      return value.endsWith(part) && value.length - part.length >= idx;
    }
    const found = value.indexOf(part, idx);
    if (found < 0) return false;
    idx = found + part.length;
  }
  return true;
}

/**
 * Build a porcelain-style disclosure listing for product paths only, so
 * block reasons name trust failures rather than ignored scratch.
 */
export function formatProductDirtDisclosure(
  productPaths: readonly string[],
  cap = 8000,
): string {
  if (productPaths.length === 0) return "";
  const body = productPaths.map((p) => ` M ${p}`).join("\n");
  if (body.length <= cap) return `\n\nUncommitted paths:\n${body}`;
  return `\n\nUncommitted paths:\n${body.slice(0, cap)}\n\n[…output truncated]`;
}
