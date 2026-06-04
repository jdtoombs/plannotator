import { describe, expect, test } from "bun:test";
import { getRebaseState, type RebaseRuntime } from "./rebase-core";

function runtime(options: {
  git?: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>;
  files?: Record<string, string | null>;
}): RebaseRuntime {
  return {
    async runGit(args) {
      const key = args.join(" ");
      const result = options.git?.[key];
      if (!result) return { stdout: "", stderr: "", exitCode: 1 };
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    async readTextFile(path) {
      return options.files?.[path] ?? null;
    },
  };
}

describe("getRebaseState", () => {
  test("returns inactive state outside a git repository", async () => {
    const state = await getRebaseState(runtime({}));

    expect(state.inProgress).toBe(false);
    expect(state.unmergedFiles).toEqual([]);
  });

  test("parses merge rebase metadata, conflicts, and todo files", async () => {
    const state = await getRebaseState(runtime({
      git: {
        "rev-parse --git-dir": { stdout: ".git\n" },
        "rev-parse --show-toplevel": { stdout: "/repo\n" },
        "status --porcelain": { stdout: "UU src/app.ts\nM  package.json\n M README.md\n?? scratch.txt\n" },
        "diff --name-only --diff-filter=U": { stdout: "src/app.ts\n" },
        "diff HEAD -- src/app.ts": { stdout: "diff --git a/src/app.ts b/src/app.ts\n" },
        "rebase --show-current-patch": { stdout: "From abc123 Mon Sep 17 00:00:00 2001\nSubject: demo\n" },
        "log -1 --pretty=%s REBASE_HEAD": { stdout: "demo commit\n" },
      },
      files: {
        "/repo/.git/rebase-merge/head-name": "refs/heads/feature\n",
        "/repo/.git/rebase-merge/onto": "deadbeef\n",
        "/repo/.git/REBASE_HEAD": "abc123\n",
        "/repo/.git/rebase-merge/git-rebase-todo": "pick def456 next commit\n# comment\nfixup fedcba cleanup\n",
        "/repo/.git/rebase-merge/done": "pick abc123 demo commit\n",
      },
    }), "/repo");

    expect(state.inProgress).toBe(true);
    expect(state.mode).toBe("merge");
    expect(state.branch).toBe("feature");
    expect(state.currentCommit).toBe("abc123");
    expect(state.currentSubject).toBe("demo commit");
    expect(state.unmergedFiles).toEqual(["src/app.ts"]);
    expect(state.stagedFiles).toEqual(["src/app.ts", "package.json"]);
    expect(state.unstagedFiles).toEqual(["src/app.ts", "README.md"]);
    expect(state.untrackedFiles).toEqual(["scratch.txt"]);
    expect(state.todo.map((entry) => entry.raw)).toEqual([
      "pick def456 next commit",
      "fixup fedcba cleanup",
    ]);
    expect(state.done.map((entry) => entry.raw)).toEqual(["pick abc123 demo commit"]);
    expect(state.conflictPatch).toBe("diff --git a/src/app.ts b/src/app.ts\n");
  });
});
