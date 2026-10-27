import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, exists, readJson, slugify, writeJson } from "./util.js";
import type { RunResult } from "./runner.js";

/**
 * On-disk layout (all under `out`, default `.demo-engine/`):
 *
 *   runs/<slug>/<runId>/run.json + steps/*.png
 *   runs/<slug>/blessed            -> runId of the baseline run
 *   cache/audio/<hash>.wav|.json   -> narration cache
 *   renders/<slug>/manifest.json, <slug>.mp4
 *   reports/<slug>/diff.json, heal.json
 */
export class Store {
  constructor(public readonly out: string) {}

  slugFor(flowName: string): string {
    return slugify(flowName);
  }

  runsDir(slug: string): string {
    return path.join(this.out, "runs", slug);
  }

  runDir(slug: string, runId: string): string {
    return path.join(this.runsDir(slug), runId);
  }

  rendersDir(slug: string): string {
    return path.join(this.out, "renders", slug);
  }

  reportsDir(slug: string): string {
    return path.join(this.out, "reports", slug);
  }

  audioCacheDir(): string {
    return path.join(this.out, "cache", "audio");
  }

  async listRuns(slug: string): Promise<string[]> {
    const dir = this.runsDir(slug);
    if (!(await exists(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && (await exists(path.join(dir, e.name, "run.json")))) ids.push(e.name);
    }
    return ids.sort();
  }

  async latestRunId(slug: string): Promise<string | undefined> {
    const ids = await this.listRuns(slug);
    return ids[ids.length - 1];
  }

  async blessedRunId(slug: string): Promise<string | undefined> {
    const p = path.join(this.runsDir(slug), "blessed");
    if (!(await exists(p))) return undefined;
    const id = (await fs.readFile(p, "utf8")).trim();
    return (await exists(path.join(this.runDir(slug, id), "run.json"))) ? id : undefined;
  }

  async bless(slug: string, runId: string): Promise<void> {
    await ensureDir(this.runsDir(slug));
    await fs.writeFile(path.join(this.runsDir(slug), "blessed"), runId + "\n", "utf8");
  }

  async loadRun(slug: string, runId: string): Promise<RunResult> {
    const dir = path.resolve(this.runDir(slug, runId));
    const run = await readJson<RunResult>(path.join(dir, "run.json"));
    run.runDir = dir; // survive moves and cwd changes
    return run;
  }

  async saveRun(run: RunResult): Promise<void> {
    await writeJson(path.join(run.runDir, "run.json"), run);
  }

  /** Delete all but the newest `keep` runs (never deletes the blessed run). */
  async prune(slug: string, keep = 5): Promise<string[]> {
    const ids = await this.listRuns(slug);
    const blessed = await this.blessedRunId(slug);
    const doomed = ids.slice(0, Math.max(0, ids.length - keep)).filter((id) => id !== blessed);
    for (const id of doomed) await fs.rm(this.runDir(slug, id), { recursive: true, force: true });
    return doomed;
  }
}
