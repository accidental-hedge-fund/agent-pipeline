// Sole GitHub Release create/edit helper invoked by release.yml (#1563).
// Node builtins only. Unknown remote state is not absence.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_RELEASE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface PublishGithubReleaseDeps {
  runCommand: (file: string, args: string[]) => CommandResult;
  readFile: (path: string) => string;
}

export type PublishGithubReleaseInput = {
  tag: string;
  candidate: string;
  repository: string;
  notesPath: string;
};

export type PublishGithubReleaseResult =
  | { ok: true; action: "create" | "edit" }
  | { ok: false; action: "none"; error: string };

export function isCanonicalReleaseTag(tag: string): boolean {
  return CANONICAL_RELEASE_TAG.test(tag);
}

export function requiredReleaseNotes(tag: string, candidate: string): string {
  return `${tag}\n\nVerified exact-candidate release at ${candidate}.`;
}

const OID_RE = /^[0-9a-fA-F]{40}$/;
const HTTP_STATUS_TOKEN = /(?:\bhttp(?:\s+status)?|\bstatus(?:\s+code)?)\s*:?\s*(\d{3})\b/gi;
const AUTH_PERMISSION_SIGNAL =
  /\b(http\s+401|http\s+403|status(?:\s+code)?:?\s*401|status(?:\s+code)?:?\s*403|bad credentials|resource not accessible|authentication|permission denied|must have push access|required scopes)\b/i;
const TRANSIENT_NETWORK_SIGNAL =
  /\b(rate[- ]limit|429|econnreset|enotfound|etimedout|socket hang up|network|connection reset|i\/o timeout|dial tcp|temporarily unavailable|gateway timeout|bad gateway|service unavailable|internal server error)\b/i;

function combinedOutput(result: CommandResult): string {
  return `${result.stderr}\n${result.stdout}`;
}

function collectHttpStatusCodes(text: string): number[] {
  const codes: number[] = [];
  HTTP_STATUS_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(HTTP_STATUS_TOKEN)) {
    const code = Number(match[1]);
    if (Number.isInteger(code) && code >= 100 && code <= 999) codes.push(code);
  }
  return codes;
}

function isGithubAuthOrPermissionError(text: string): boolean {
  return AUTH_PERMISSION_SIGNAL.test(text);
}

function isTransientNetworkOrServerError(text: string): boolean {
  if (TRANSIENT_NETWORK_SIGNAL.test(text)) return true;
  return collectHttpStatusCodes(text).some((code) => code === 429 || code >= 500);
}

function isAuthoritativeReleaseNotFound(text: string): boolean {
  if (isGithubAuthOrPermissionError(text) || isTransientNetworkOrServerError(text)) return false;
  const codes = collectHttpStatusCodes(text);
  return codes.length > 0 && codes.every((code) => code === 404);
}

function fail(error: string): PublishGithubReleaseResult {
  return { ok: false, action: "none", error };
}

function stripTerminalNewlines(text: string): string {
  return text.replace(/(?:\r\n|\n|\r)+$/u, "");
}

function normalizeCandidateOid(candidate: string): string | null {
  if (!OID_RE.test(candidate)) return null;
  return candidate.toLowerCase();
}

function parseExistingRelease(stdout: string, tag: string): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `GitHub Release ${tag} observation is unknown: malformed JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `GitHub Release ${tag} observation is unknown: wrong-shape JSON` };
  }
  const row = parsed as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, error: `GitHub Release ${tag} observation is unknown: missing or malformed id` };
  }
  if (row.tag_name !== tag) {
    return { ok: false, error: `GitHub Release ${tag} observation is unknown: missing or mismatched identity` };
  }
  if (typeof row.draft !== "boolean" || typeof row.prerelease !== "boolean") {
    return { ok: false, error: `GitHub Release ${tag} observation is unknown: missing draft or prerelease` };
  }
  return { ok: true };
}

export function publishGithubRelease(
  input: PublishGithubReleaseInput,
  deps: PublishGithubReleaseDeps,
): PublishGithubReleaseResult {
  const tag = input.tag;
  if (!isCanonicalReleaseTag(tag)) {
    return fail(`tag ${tag} is not vMAJOR.MINOR.PATCH`);
  }
  const candidate = normalizeCandidateOid(input.candidate);
  if (!candidate || !input.repository.trim()) {
    return fail(`GitHub Release ${tag} observation is unknown: missing candidate or repository`);
  }

  let notes: string;
  try {
    notes = deps.readFile(input.notesPath);
  } catch (err) {
    return fail(
      `${tag} annotation does not match required notes for candidate ${candidate}: ${(err as Error).message}`,
    );
  }
  const expected = requiredReleaseNotes(tag, candidate);
  if (stripTerminalNewlines(notes) !== stripTerminalNewlines(expected)) {
    return fail(`${tag} annotation does not match required notes for candidate ${candidate}`);
  }

  let lookup: CommandResult;
  try {
    lookup = deps.runCommand("gh", ["api", `repos/${input.repository}/releases/tags/${tag}`]);
  } catch (err) {
    return fail(`GitHub Release ${tag} observation is unknown: ${(err as Error).message}`);
  }

  const publicationFlags = ["--latest", "--prerelease=false"] as const;
  if (lookup.status === 0) {
    const parsed = parseExistingRelease(lookup.stdout, tag);
    if (!parsed.ok) return fail(parsed.error);
    let edit: CommandResult;
    try {
      edit = deps.runCommand("gh", [
        "release",
        "edit",
        tag,
        "--notes-file",
        input.notesPath,
        "--title",
        tag,
        "--draft=false",
        ...publicationFlags,
      ]);
    } catch (err) {
      return fail(`GitHub Release ${tag} edit failed: ${(err as Error).message}`);
    }
    if (edit.status !== 0) {
      return fail(`GitHub Release ${tag} edit failed: ${combinedOutput(edit).trim()}`);
    }
    return { ok: true, action: "edit" };
  }

  const signal = combinedOutput(lookup);
  if (!isAuthoritativeReleaseNotFound(signal)) {
    const kind = isGithubAuthOrPermissionError(signal) ? "unknown_auth" : "unknown";
    return fail(`GitHub Release ${tag} observation is unknown (${kind}): ${signal.trim()}`);
  }

  let create: CommandResult;
  try {
    create = deps.runCommand("gh", [
      "release",
      "create",
      tag,
      "--verify-tag",
      "--notes-file",
      input.notesPath,
      "--title",
      tag,
      ...publicationFlags,
    ]);
  } catch (err) {
    return fail(`GitHub Release ${tag} create failed: ${(err as Error).message}`);
  }
  if (create.status !== 0) {
    return fail(`GitHub Release ${tag} create failed: ${combinedOutput(create).trim()}`);
  }
  return { ok: true, action: "create" };
}

export function defaultPublishGithubReleaseDeps(): PublishGithubReleaseDeps {
  return {
    readFile: (path) => readFileSync(path, "utf8"),
    runCommand(file, args) {
      const spawned = spawnSync(file, args, { encoding: "utf8" });
      return {
        status: spawned.status ?? 1,
        stdout: spawned.stdout ?? "",
        stderr: spawned.stderr ?? spawned.error?.message ?? "",
      };
    },
  };
}

export function runPublishGithubReleaseCli(
  env: NodeJS.ProcessEnv = process.env,
  deps: PublishGithubReleaseDeps = defaultPublishGithubReleaseDeps(),
): number {
  const result = publishGithubRelease(
    {
      tag: env.TAG ?? "",
      candidate: env.C ?? "",
      repository: env.GITHUB_REPOSITORY ?? "",
      notesPath: env.RELEASE_NOTES_PATH ?? "/tmp/notes.md",
    },
    deps,
  );
  if (!result.ok) {
    console.error(`::error::${result.error}`);
    return 1;
  }
  return 0;
}

function isExecutedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

if (isExecutedAsCli()) {
  process.exit(runPublishGithubReleaseCli());
}
