import { resolve as resolvePath } from "node:path";

export interface RebaseCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RebaseRuntime {
  runGit: (
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<RebaseCommandResult>;
  readTextFile: (path: string) => Promise<string | null>;
}

export interface RebaseTodoEntry {
  command: string;
  commit: string;
  subject: string;
  raw: string;
}

export interface RebaseState {
  inProgress: boolean;
  gitDir?: string;
  mode?: "merge" | "apply";
  currentCommit?: string;
  currentSubject?: string;
  onto?: string;
  branch?: string;
  unmergedFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  todo: RebaseTodoEntry[];
  done: RebaseTodoEntry[];
  currentPatch?: string;
  conflictPatch: string;
}

const REBASE_TODO_COMMANDS = new Set([
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "exec",
  "break",
  "drop",
  "label",
  "reset",
  "merge",
]);

function firstLine(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\r?\n/, 1)[0];
}

function parseTodo(content: string | null): RebaseTodoEntry[] {
  if (!content) return [];

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((raw) => {
      const [command = "", commit = "", ...subjectParts] = raw.split(/\s+/);
      return {
        command,
        commit,
        subject: subjectParts.join(" "),
        raw,
      };
    })
    .filter((entry) => REBASE_TODO_COMMANDS.has(entry.command));
}

function parsePorcelain(status: string): Pick<RebaseState, "stagedFiles" | "unstagedFiles" | "untrackedFiles"> {
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const path = line.slice(3);

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFiles.push(path);
      continue;
    }

    if (indexStatus !== " " && indexStatus !== "?") stagedFiles.push(path);
    if (worktreeStatus !== " " && worktreeStatus !== "?") unstagedFiles.push(path);
  }

  return { stagedFiles, unstagedFiles, untrackedFiles };
}

async function readGitFile(runtime: RebaseRuntime, gitDir: string, name: string): Promise<string | undefined> {
  return (await runtime.readTextFile(resolvePath(gitDir, name)))?.trim() || undefined;
}

async function getGitDir(runtime: RebaseRuntime, cwd?: string): Promise<string | null> {
  const result = await runtime.runGit(["rev-parse", "--git-dir"], { cwd });
  if (result.exitCode !== 0) return null;

  const gitDir = result.stdout.trim();
  if (!gitDir) return null;
  return resolvePath(cwd ?? process.cwd(), gitDir);
}

async function getGitTopLevel(runtime: RebaseRuntime, cwd?: string): Promise<string | undefined> {
  const result = await runtime.runGit(["rev-parse", "--show-toplevel"], { cwd });
  if (result.exitCode !== 0) return undefined;

  return result.stdout.trim() || undefined;
}

async function tryGit(runtime: RebaseRuntime, args: string[], cwd?: string): Promise<string> {
  const result = await runtime.runGit(args, { cwd });
  return result.exitCode === 0 ? result.stdout : "";
}

export async function getRebaseState(runtime: RebaseRuntime, cwd?: string): Promise<RebaseState> {
  const gitDir = await getGitDir(runtime, cwd);
  if (!gitDir) {
    return emptyRebaseState(false);
  }

  const mergeHeadName = resolvePath(gitDir, "rebase-merge", "head-name");
  const applyHeadName = resolvePath(gitDir, "rebase-apply", "head-name");
  const [mergeHead, applyHead] = await Promise.all([
    runtime.readTextFile(mergeHeadName),
    runtime.readTextFile(applyHeadName),
  ]);

  const mode = mergeHead !== null ? "merge" : applyHead !== null ? "apply" : undefined;
  if (!mode) {
    return emptyRebaseState(false, gitDir);
  }

  const rebaseDir = resolvePath(gitDir, mode === "merge" ? "rebase-merge" : "rebase-apply");
  const gitCwd = await getGitTopLevel(runtime, cwd) ?? cwd;
  const [status, unmerged, currentPatch, todoContent, doneContent] = await Promise.all([
    tryGit(runtime, ["status", "--porcelain"], gitCwd),
    tryGit(runtime, ["diff", "--name-only", "--diff-filter=U"], gitCwd),
    tryGit(runtime, ["rebase", "--show-current-patch"], gitCwd),
    runtime.readTextFile(resolvePath(rebaseDir, "git-rebase-todo")),
    runtime.readTextFile(resolvePath(rebaseDir, "done")),
  ]);
  const unmergedFiles = unmerged.split(/\r?\n/).filter(Boolean);
  const conflictPatch = unmergedFiles.length > 0
    ? await tryGit(runtime, ["diff", "HEAD", "--", ...unmergedFiles], gitCwd)
    : "";

  const currentCommit =
    (await readGitFile(runtime, gitDir, "REBASE_HEAD")) ??
    (await readGitFile(runtime, rebaseDir, "stopped-sha")) ??
    firstLine(currentPatch)?.replace(/^From\s+([0-9a-f]+).*/, "$1");

  return {
    inProgress: true,
    gitDir,
    mode,
    currentCommit,
    currentSubject: firstLine(await tryGit(runtime, ["log", "-1", "--pretty=%s", "REBASE_HEAD"], gitCwd)),
    onto: await readGitFile(runtime, rebaseDir, "onto"),
    branch: (await readGitFile(runtime, rebaseDir, "head-name"))?.replace(/^refs\/heads\//, ""),
    unmergedFiles,
    ...parsePorcelain(status),
    todo: parseTodo(todoContent),
    done: parseTodo(doneContent),
    currentPatch: currentPatch || undefined,
    conflictPatch,
  };
}

function emptyRebaseState(inProgress: boolean, gitDir?: string): RebaseState {
  return {
    inProgress,
    gitDir,
    unmergedFiles: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    todo: [],
    done: [],
    conflictPatch: "",
  };
}

export function formatRebaseFeedbackPrompt(feedback: string, state: RebaseState): string {
  const current = state.currentCommit
    ? `${state.currentCommit}${state.currentSubject ? ` (${state.currentSubject})` : ""}`
    : "unknown commit";
  const files = state.unmergedFiles.length > 0
    ? state.unmergedFiles.map((file) => `- ${file}`).join("\n")
    : "- No unmerged files detected";

  return `The user reviewed the current interactive rebase conflict state in Plannotator.

Current rebase commit: ${current}
Branch: ${state.branch ?? "unknown"}
Remaining todo entries: ${state.todo.length}

Unmerged files:
${files}

User feedback:
${feedback}

Please help resolve the rebase conflicts according to this feedback. Do not run \`git rebase --continue\` until the user explicitly approves continuing.`;
}
