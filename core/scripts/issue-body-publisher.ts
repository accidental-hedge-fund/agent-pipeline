import { spawnSync } from "node:child_process";
import { ghChildEnv } from "./gh.ts";

export type IssueBodyPublicationFailureKind =
  | "validation_failure"
  | "spawn_failure"
  | "stdin_failure"
  | "github_rejection";

export type IssueBodyPublicationResult =
  | { acknowledged: true }
  | {
      acknowledged: false;
      kind: IssueBodyPublicationFailureKind;
      diagnostic: string;
      exitCode: number | null;
    };

export interface IssueBodyPublisherDeps {
  spawn: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
      stdio: "pipe";
      input: string;
    },
  ) => {
    status: number | null;
    stderr?: string | null;
    error?: NodeJS.ErrnoException;
  };
}

const defaultDeps: IssueBodyPublisherDeps = {
  spawn: (command, args, options) => spawnSync(command, args, options),
};

function boundedDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text.trim().slice(0, 1000) || "no diagnostic was returned";
}

/** Publish generated issue Markdown through stdin. The body is never argv. */
export function publishIssueBody(
  input: { repo: string; repoDir: string; issueNumber: number; body: string },
  deps: IssueBodyPublisherDeps = defaultDeps,
): IssueBodyPublicationResult {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0 || !input.repo.trim()) {
    return {
      acknowledged: false,
      kind: "validation_failure",
      diagnostic: "issue-body publication requires a repository and positive issue number",
      exitCode: null,
    };
  }
  const result = deps.spawn(
    "gh",
    ["issue", "edit", String(input.issueNumber), "-R", input.repo, "--body-file", "-"],
    {
      encoding: "utf8",
      stdio: "pipe",
      input: input.body,
      cwd: input.repoDir,
      env: ghChildEnv(),
    },
  );
  if (result.status === null) {
    const error = result.error;
    const kind = error?.code === "EPIPE" ? "stdin_failure" : "spawn_failure";
    return {
      acknowledged: false,
      kind,
      diagnostic: boundedDiagnostic(error ?? result.stderr ?? `${kind}: gh process returned no status`),
      exitCode: null,
    };
  }
  if (result.status !== 0) {
    return {
      acknowledged: false,
      kind: "github_rejection",
      diagnostic: boundedDiagnostic(result.stderr ?? "gh rejected issue-body publication"),
      exitCode: result.status,
    };
  }
  return { acknowledged: true };
}

export class IssueBodyPublicationError extends Error {
  readonly kind: IssueBodyPublicationFailureKind;
  readonly exitCode: number | null;

  constructor(result: Extract<IssueBodyPublicationResult, { acknowledged: false }>) {
    super(`issue-body publication ${result.kind}: ${result.diagnostic}`);
    this.name = "IssueBodyPublicationError";
    this.kind = result.kind;
    this.exitCode = result.exitCode;
  }
}

export function publishIssueBodyOrThrow(
  input: { repo: string; repoDir: string; issueNumber: number; body: string },
  deps?: IssueBodyPublisherDeps,
): void {
  const result = publishIssueBody(input, deps);
  if (!result.acknowledged) throw new IssueBodyPublicationError(result);
}
