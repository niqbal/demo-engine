import { spawnSync } from "node:child_process";
import picomatch from "picomatch";
import type { Flow } from "./schema.js";

function git(args: string[], cwd: string): string | undefined {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return r.stdout.trim();
}

export function headSha(cwd = process.cwd()): string | undefined {
  return git(["rev-parse", "--short", "HEAD"], cwd) || undefined;
}

export function isGitRepo(cwd = process.cwd()): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

/** Files changed between `since` and HEAD (plus uncommitted changes). */
export function changedFiles(since: string, cwd = process.cwd()): string[] {
  const committed = git(["diff", "--name-only", `${since}...HEAD`], cwd) ?? git(["diff", "--name-only", since], cwd) ?? "";
  const working = git(["status", "--porcelain"], cwd) ?? "";
  const set = new Set<string>();
  for (const l of committed.split("\n")) if (l.trim()) set.add(l.trim());
  for (const l of working.split("\n")) {
    const f = l.slice(3).trim();
    if (f) set.add(f.includes(" -> ") ? f.split(" -> ")[1] : f);
  }
  return [...set].sort();
}

export interface Affected {
  flow: Flow;
  file: string;
  /** Changed files matching this flow's `touches` globs. */
  matches: string[];
  /** Flows without `touches` are always considered affected. */
  always: boolean;
}

export function affectedFlows(flows: { flow: Flow; file: string }[], changed: string[]): Affected[] {
  return flows.map(({ flow, file }) => {
    if (!flow.touches?.length) return { flow, file, matches: [], always: true };
    const isMatch = picomatch(flow.touches, { dot: true });
    return { flow, file, matches: changed.filter((f) => isMatch(f)), always: false };
  });
}
