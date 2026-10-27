import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Rect, RunResult, StepResult } from "./runner.js";
import { ensureDir } from "./util.js";

export type StepClass = "unchanged" | "cosmetic" | "changed" | "broken" | "added" | "removed";

export interface StepDiff {
  index: number;
  id: string;
  say: string;
  class: StepClass;
  reasons: string[];
  visualRatio?: number;
  diffImage?: string;
  ariaAdded?: number;
  ariaRemoved?: number;
  locator?: { status: string; usedFallback: boolean; description?: string };
  error?: string;
  cascade?: boolean;
}

export interface DiffReport {
  flowName: string;
  slug: string;
  baseline: { runId: string; flowHash: string };
  candidate: { runId: string; flowHash: string };
  summary: Record<StepClass, number>;
  steps: StepDiff[];
  /** True when any step needs new frames. */
  needsRender: boolean;
  /** True when any step is broken (fails CI by default). */
  broken: boolean;
  changedFiles?: string[];
}

export interface DiffOptions {
  /** Directory for diff PNGs. */
  reportDir: string;
  /** Per-pixel colour threshold (0..1). */
  threshold?: number;
  cosmeticMax?: number; // ratio below which a visual change is cosmetic
  noiseFloor?: number; // ratio below which we call it unchanged
}

function normalizeAria(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

function lineDelta(a: string[], b: string[]): { added: number; removed: number } {
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ma = count(a);
  const mb = count(b);
  let added = 0;
  let removed = 0;
  for (const [k, v] of mb) added += Math.max(0, v - (ma.get(k) ?? 0));
  for (const [k, v] of ma) removed += Math.max(0, v - (mb.get(k) ?? 0));
  return { added, removed };
}

async function readPng(p: string): Promise<PNG | undefined> {
  try {
    return PNG.sync.read(await fs.readFile(p));
  } catch {
    return undefined;
  }
}

function applyMasks(a: PNG, b: PNG, masks: Rect[], scale: number): void {
  for (const r of masks) {
    const x0 = Math.max(0, Math.floor(r.x * scale));
    const y0 = Math.max(0, Math.floor(r.y * scale));
    const x1 = Math.min(a.width, Math.ceil((r.x + r.width) * scale));
    const y1 = Math.min(a.height, Math.ceil((r.y + r.height) * scale));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * a.width + x) * 4;
        b.data[i] = a.data[i];
        b.data[i + 1] = a.data[i + 1];
        b.data[i + 2] = a.data[i + 2];
        b.data[i + 3] = a.data[i + 3];
      }
    }
  }
}

export async function compareRuns(baseline: RunResult, candidate: RunResult, opts: DiffOptions): Promise<DiffReport> {
  const threshold = opts.threshold ?? 0.1;
  const cosmeticMax = opts.cosmeticMax ?? 0.02;
  const noiseFloor = opts.noiseFloor ?? 0.0008;
  await ensureDir(opts.reportDir);
  const steps: StepDiff[] = [];
  const n = Math.max(baseline.steps.length, candidate.steps.length);
  for (let i = 0; i < n; i++) {
    const a = baseline.steps[i];
    const b = candidate.steps[i];
    if (!b) {
      steps.push({ index: i, id: a.id, say: a.say, class: "removed", reasons: ["step removed from flow"] });
      continue;
    }
    if (!a) {
      steps.push({ index: i, id: b.id, say: b.say, class: "added", reasons: ["new step"] });
      continue;
    }
    const d = await compareStep(a, b, baseline, candidate, { threshold, cosmeticMax, noiseFloor, reportDir: opts.reportDir });
    steps.push(d);
  }
  const summary: Record<StepClass, number> = { unchanged: 0, cosmetic: 0, changed: 0, broken: 0, added: 0, removed: 0 };
  for (const s of steps) summary[s.class]++;
  return {
    flowName: candidate.flowName,
    slug: candidate.slug,
    baseline: { runId: baseline.runId, flowHash: baseline.flowHash },
    candidate: { runId: candidate.runId, flowHash: candidate.flowHash },
    summary,
    steps,
    needsRender: steps.some((s) => s.class !== "unchanged"),
    broken: summary.broken > 0,
    changedFiles: candidate.changedFiles
  };
}

async function compareStep(
  a: StepResult,
  b: StepResult,
  baseRun: RunResult,
  candRun: RunResult,
  o: { threshold: number; cosmeticMax: number; noiseFloor: number; reportDir: string }
): Promise<StepDiff> {
  const d: StepDiff = { index: b.index, id: b.id, say: b.say, class: "unchanged", reasons: [] };
  if (b.resolution) {
    d.locator = {
      status: b.resolution.status,
      usedFallback: b.resolution.usedIndex > 0,
      description: b.resolution.description
    };
    if (b.resolution.usedIndex > 0) d.reasons.push(`primary locator failed; fallback #${b.resolution.usedIndex} matched`);
    if (b.resolution.status === "ambiguous") d.reasons.push(`locator matched ${b.resolution.count} elements`);
  }
  if (b.error) {
    d.class = "broken";
    d.error = b.error;
    d.cascade = b.cascade;
    d.reasons.push(b.cascade ? `failed after an earlier step failed: ${b.error}` : b.error);
    return d;
  }
  if (a.say !== b.say) d.reasons.push("narration text changed");

  // Content: accessibility tree lines.
  const ariaA = normalizeAria(await fs.readFile(path.join(baseRun.runDir, a.aria), "utf8").catch(() => ""));
  const ariaB = normalizeAria(await fs.readFile(path.join(candRun.runDir, b.aria), "utf8").catch(() => ""));
  const delta = lineDelta(ariaA, ariaB);
  d.ariaAdded = delta.added;
  d.ariaRemoved = delta.removed;

  // Visual: masked pixel diff of the "after" frames.
  const pa = await readPng(path.join(baseRun.runDir, a.after));
  const pb = await readPng(path.join(candRun.runDir, b.after));
  if (pa && pb) {
    if (pa.width !== pb.width || pa.height !== pb.height) {
      d.visualRatio = 1;
      d.reasons.push(`frame size changed ${pa.width}x${pa.height} -> ${pb.width}x${pb.height}`);
    } else {
      applyMasks(pa, pb, [...a.masks, ...b.masks], candRun.scale);
      const out = new PNG({ width: pa.width, height: pa.height });
      const mismatched = pixelmatch(pa.data, pb.data, out.data, pa.width, pa.height, {
        threshold: o.threshold,
        includeAA: false,
        alpha: 0.6,
        diffColor: [255, 64, 64],
        aaColor: [255, 200, 0]
      });
      d.visualRatio = mismatched / (pa.width * pa.height);
      if (d.visualRatio > o.noiseFloor) {
        const name = `${String(b.index + 1).padStart(2, "0")}-diff.png`;
        await fs.writeFile(path.join(o.reportDir, name), PNG.sync.write(out));
        d.diffImage = name;
      }
    }
  } else {
    d.reasons.push("missing screenshot in one of the runs");
    d.visualRatio = 1;
  }

  const ratio = d.visualRatio ?? 0;
  const contentChanged = delta.added + delta.removed > 0;
  if (contentChanged) d.reasons.push(`content changed (+${delta.added}/-${delta.removed} accessibility lines)`);
  if (ratio >= o.cosmeticMax) d.reasons.push(`${(ratio * 100).toFixed(1)}% of pixels changed`);
  else if (ratio > o.noiseFloor) d.reasons.push(`${(ratio * 100).toFixed(2)}% of pixels changed (cosmetic)`);

  if (contentChanged || ratio >= o.cosmeticMax || a.say !== b.say) d.class = "changed";
  else if (ratio > o.noiseFloor || (b.resolution && b.resolution.usedIndex > 0)) d.class = "cosmetic";
  else d.class = "unchanged";
  return d;
}

export function diffToMarkdown(r: DiffReport): string {
  const icon: Record<StepClass, string> = {
    unchanged: "✅",
    cosmetic: "🎨",
    changed: "✏️",
    broken: "❌",
    added: "➕",
    removed: "➖"
  };
  const lines: string[] = [];
  lines.push(`### ${r.flowName}`);
  lines.push("");
  lines.push(
    `${r.broken ? "❌ **broken**" : r.needsRender ? "✏️ changed" : "✅ unchanged"} · ` +
      Object.entries(r.summary)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")
  );
  lines.push("");
  lines.push("| # | step | status | notes |");
  lines.push("|---|------|--------|-------|");
  for (const s of r.steps) {
    lines.push(`| ${s.index + 1} | ${escapeCell(s.say)} | ${icon[s.class]} ${s.class} | ${escapeCell(s.reasons.join("; "))} |`);
  }
  if (r.changedFiles?.length) {
    lines.push("");
    lines.push(`<details><summary>${r.changedFiles.length} changed files touching this flow</summary>`);
    lines.push("");
    for (const f of r.changedFiles.slice(0, 50)) lines.push(`- \`${f}\``);
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
