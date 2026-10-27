import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  affectedFlows,
  buildManifest,
  changedFiles,
  compareRuns,
  diffToMarkdown,
  exists,
  headSha,
  healFlow,
  isGitRepo,
  kokoroPython,
  narrateRun,
  readJson,
  runFlow,
  stringifyFlow,
  writeJson,
  writeManifest,
  type DiffReport,
  type Heal,
  type Narration,
  type RunResult
} from "@demo-engine/core";
import { renderVideo } from "@demo-engine/render";
import { loadContext, rel, resolveTargets, type Ctx, type GlobalOpts, type Target } from "./context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(here, "..", "templates");

interface FlowReport {
  name: string;
  slug: string;
  file?: string;
  status: "passed" | "failed" | "skipped";
  skippedReason?: string;
  runId?: string;
  diff?: DiffReport;
  heals?: Heal[];
  healedFlowWritten?: boolean;
  video?: string;
  poster?: string;
  rendered: boolean;
  blessed?: string;
  changedFiles?: string[];
  durationMs: number;
}

interface BuildOpts extends GlobalOpts {
  since?: string;
  onlyAffected?: boolean;
  heal?: boolean;
  writeHeals?: boolean;
  bless?: boolean;
  render?: boolean;
  narrate?: boolean;
  verbatim?: boolean;
  force?: boolean;
  report?: string;
  failOnBroken?: boolean;
  headed?: boolean;
  fps?: string;
  minConfidence?: string;
  keepRuns?: string;
}

export function registerCommands(program: Command): void {
  const g = () => program.opts<GlobalOpts>();

  program
    .command("init")
    .description("scaffold demos/, a config file and a GitHub workflow in the current project")
    .option("--base-url <url>", "base URL for your app", "http://localhost:3000")
    .option("--force", "overwrite existing files")
    .action(async (o: { baseUrl: string; force?: boolean }) => {
      await init(process.cwd(), o.baseUrl, !!o.force);
    });

  program
    .command("run [targets...]")
    .description("run flows in a headless browser and capture frames (no diff, no render)")
    .option("--headed", "show the browser")
    .action(async (targets: string[], o: { headed?: boolean }) => {
      const ctx = await loadContext(g());
      for (const t of await resolveTargets(ctx, targets)) {
        const run = await doRun(ctx, t, { headed: o.headed });
        ctx.log.info(`${run.status}: ${rel(ctx, run.runDir)}`);
      }
    });

  program
    .command("diff [targets...]")
    .description("compare the latest run of each flow against its blessed baseline")
    .option("--run", "run the flow first")
    .action(async (targets: string[], o: { run?: boolean }) => {
      const ctx = await loadContext(g());
      let broken = false;
      for (const t of await resolveTargets(ctx, targets)) {
        const slug = ctx.store.slugFor(t.flow.name);
        const cand = o.run ? await doRun(ctx, t) : await latest(ctx, t);
        const base = await blessed(ctx, slug);
        if (!base) {
          console.log(`${t.flow.name}: no blessed baseline yet (run \`demo-engine bless\`)`);
          continue;
        }
        const report = await compareRuns(base, cand, { reportDir: ctx.store.reportsDir(slug) });
        await writeJson(path.join(ctx.store.reportsDir(slug), "diff.json"), report);
        console.log(diffToMarkdown(report) + "\n");
        broken ||= report.broken;
      }
      process.exitCode = broken ? 1 : 0;
    });

  program
    .command("heal [targets...]")
    .description("re-run broken flows and repair failed locators (LLM if a key is set, heuristic otherwise)")
    .option("--write", "write verified repairs back to the flow files")
    .option("--min-confidence <n>", "minimum confidence to try a repair", "0.5")
    .action(async (targets: string[], o: { write?: boolean; minConfidence: string }) => {
      const ctx = await loadContext(g());
      let unresolved = false;
      for (const t of await resolveTargets(ctx, targets)) {
        const r = await doHeal(ctx, t, await doRun(ctx, t), Number(o.minConfidence));
        if (!r) {
          console.log(`${t.flow.name}: nothing to heal`);
          continue;
        }
        printHeals(r.heals);
        if (o.write && t.file && r.heals.some((h) => h.verified)) {
          await fs.writeFile(t.file, stringifyFlow(r.flow), "utf8");
          console.log(`wrote ${rel(ctx, t.file)}`);
        }
        unresolved ||= r.unresolved.length > 0;
      }
      process.exitCode = unresolved ? 1 : 0;
    });

  program
    .command("narrate [targets...]")
    .description("generate voice-over for the latest run of each flow")
    .option("--verbatim", "skip LLM polishing; read step notes as written")
    .action(async (targets: string[], o: { verbatim?: boolean }) => {
      const ctx = await loadContext(g());
      for (const t of await resolveTargets(ctx, targets)) {
        const run = await latest(ctx, t);
        const n = await doNarrate(ctx, t, run, !!o.verbatim);
        for (const s of n.steps) console.log(`${String(s.index + 1).padStart(2)}  ${(s.durationMs / 1000).toFixed(1)}s  ${s.text}`);
      }
    });

  program
    .command("render [targets...]")
    .description("render the latest run of each flow to MP4")
    .option("--fps <n>", "frames per second")
    .option("--no-captions", "hide captions")
    .option("--rebundle", "rebuild the Remotion bundle")
    .action(async (targets: string[], o: { fps?: string; captions: boolean; rebundle?: boolean }) => {
      const ctx = await loadContext(g());
      for (const t of await resolveTargets(ctx, targets)) {
        const run = await latest(ctx, t);
        const narration = await loadNarration(run) ?? (await doNarrate(ctx, t, run, false));
        const r = await doRender(ctx, t, run, narration, { fps: o.fps ? Number(o.fps) : undefined, captions: o.captions, rebundle: o.rebundle });
        console.log(`wrote ${rel(ctx, r.outFile)}`);
      }
    });

  program
    .command("bless [targets...]")
    .description("mark the latest run of each flow as the baseline for future diffs")
    .option("--run-id <id>", "bless a specific run")
    .action(async (targets: string[], o: { runId?: string }) => {
      const ctx = await loadContext(g());
      for (const t of await resolveTargets(ctx, targets)) {
        const slug = ctx.store.slugFor(t.flow.name);
        const id = o.runId ?? (t.recordedRun ? t.recordedRun.runId : await ctx.store.latestRunId(slug));
        if (!id) throw new Error(`${t.flow.name}: no runs yet`);
        await ctx.store.bless(slug, id);
        console.log(`${t.flow.name}: blessed ${id}`);
      }
    });

  program
    .command("changed")
    .description("list flows affected by files changed since a git ref (uses each flow's `touches` globs)")
    .requiredOption("--since <ref>", "git ref to diff against (e.g. origin/main, v1.2.0)")
    .option("--json", "machine-readable output")
    .action(async (o: { since: string; json?: boolean }) => {
      const ctx = await loadContext(g());
      const targets = await resolveTargets(ctx, []);
      const changed = changedFiles(o.since, ctx.cwd);
      const affected = affectedFlows(targets.filter((t) => t.file).map((t) => ({ flow: t.flow, file: t.file! })), changed);
      if (o.json) {
        console.log(JSON.stringify({ since: o.since, changedFiles: changed, flows: affected.map((a) => ({ name: a.flow.name, file: rel(ctx, a.file), matches: a.matches, always: a.always })) }, null, 2));
        return;
      }
      console.log(`${changed.length} changed files since ${o.since}`);
      for (const a of affected) {
        const tag = a.always ? "always (no `touches`)" : a.matches.length ? `${a.matches.length} matching files` : "not affected";
        console.log(`  ${a.matches.length || a.always ? "•" : "·"} ${a.flow.name}  —  ${tag}`);
        for (const m of a.matches.slice(0, 5)) console.log(`      ${m}`);
      }
    });

  program
    .command("anchors")
    .description("report `anchor:` locators used by flows that no longer appear in the source tree")
    .option("--src <dir>", "source directory to scan", "src")
    .action(async (o: { src: string }) => {
      const ctx = await loadContext(g());
      const targets = await resolveTargets(ctx, []);
      const used = new Map<string, string[]>();
      for (const t of targets) {
        for (const a of collectAnchors(t.flow)) used.set(a, [...(used.get(a) ?? []), t.flow.name]);
      }
      if (!used.size) {
        console.log("no `anchor:` locators in flows. Add data-demo=\"...\" attributes to stable elements and reference them with `anchor:`.");
        return;
      }
      const srcDir = path.resolve(ctx.cwd, o.src);
      const text = await readTree(srcDir);
      let missing = 0;
      for (const [a, flows] of used) {
        const found = text.includes(`data-demo="${a}"`) || text.includes(`data-demo='${a}'`) || text.includes(`"data-demo": "${a}"`);
        console.log(`${found ? "✓" : "✗"} ${a}  (${flows.join(", ")})`);
        if (!found) missing++;
      }
      process.exitCode = missing ? 1 : 0;
    });

  program
    .command("doctor")
    .description("check browsers, providers and keys")
    .action(async () => {
      const ctx = await loadContext(g());
      const { chromium } = await import("playwright");
      try {
        const b = await chromium.launch();
        console.log(`✓ chromium ${b.version()}`);
        await b.close();
      } catch (e) {
        console.log(`✗ chromium: ${(e as Error).message.split("\n")[0]}  → run: npx playwright install chromium`);
      }
      const llm = await ctx.llm().catch((e: Error) => { console.log(`✗ llm: ${e.message}`); return null; });
      console.log(llm ? `✓ llm: ${llm.name}` : "· llm: none (set ANTHROPIC_API_KEY or OPENAI_API_KEY for narration polish and smarter heals)");
      console.log(`✓ tts: ${ctx.tts().name} (fallback ${ctx.fallbackTTS().name})${kokoroPython() ? "" : "  · tip: pip install kokoro soundfile for a free neural voice"}`);
      console.log(`· config: ${ctx.configFile ? rel(ctx, ctx.configFile) : "none"}  out: ${rel(ctx, ctx.out)}  baseUrl: ${ctx.baseUrl ?? "(unset)"}`);
      console.log(`· git: ${isGitRepo(ctx.cwd) ? `repo at ${headSha(ctx.cwd) ?? "(no commits yet)"}` : "not a repo (touches/changed disabled)"}`);
    });

  program
    .command("build [targets...]")
    .description("run → diff → heal → narrate → render → report. The one command CI runs.")
    .option("--since <ref>", "only re-run flows whose `touches` match files changed since this git ref")
    .option("--only-affected", "with --since: skip flows that are not affected (default: run them, but note it)")
    .option("--no-heal", "do not attempt to repair broken locators")
    .option("--write-heals", "write verified repairs back to flow files")
    .option("--bless", "bless the new run as baseline when it passes")
    .option("--no-render", "skip video rendering")
    .option("--no-narrate", "skip narration (silent video)")
    .option("--verbatim", "read step notes as written (no LLM polish)")
    .option("--force", "re-render even when nothing changed")
    .option("--report <dir>", "write report.md/report.json here (default: <out>)")
    .option("--no-fail-on-broken", "exit 0 even when flows are broken")
    .option("--headed", "show the browser")
    .option("--fps <n>", "frames per second")
    .option("--min-confidence <n>", "minimum heal confidence", "0.5")
    .option("--keep-runs <n>", "runs to keep per flow", "5")
    .action(async (targets: string[], o: BuildOpts) => {
      const ctx = await loadContext({ ...g(), ...o });
      const code = await build(ctx, await resolveTargets(ctx, targets), o);
      process.exitCode = code;
    });
}

/* ---------- pipeline pieces ---------- */

async function doRun(ctx: Ctx, t: Target, o: { headed?: boolean; changedFiles?: string[] } = {}): Promise<RunResult> {
  if (t.recordedRun) return t.recordedRun;
  ctx.log.info(`run: ${t.flow.name}`);
  return runFlow(t.flow, {
    baseUrl: ctx.baseUrl,
    out: ctx.out,
    headless: !o.headed,
    logger: ctx.log,
    flowFile: t.file ? rel(ctx, t.file) : undefined,
    cwd: ctx.cwd,
    changedFiles: o.changedFiles
  });
}

async function latest(ctx: Ctx, t: Target): Promise<RunResult> {
  if (t.recordedRun) return t.recordedRun;
  const slug = ctx.store.slugFor(t.flow.name);
  const id = await ctx.store.latestRunId(slug);
  if (!id) return doRun(ctx, t);
  return ctx.store.loadRun(slug, id);
}

async function blessed(ctx: Ctx, slug: string): Promise<RunResult | undefined> {
  const id = await ctx.store.blessedRunId(slug);
  return id ? ctx.store.loadRun(slug, id) : undefined;
}

async function doHeal(ctx: Ctx, t: Target, run: RunResult, minConfidence: number) {
  if (run.status === "passed" || t.recordedRun) return undefined;
  const slug = ctx.store.slugFor(t.flow.name);
  const llm = await ctx.llm().catch((e: Error) => {
    ctx.log.warn(`llm unavailable (${e.message}); using heuristic healer`);
    return null;
  });
  return healFlow(t.flow, run, {
    llm,
    baseline: await blessed(ctx, slug),
    baseUrl: ctx.baseUrl,
    out: ctx.out,
    logger: ctx.log,
    cwd: ctx.cwd,
    minConfidence
  });
}

async function doNarrate(ctx: Ctx, t: Target, run: RunResult, verbatim: boolean): Promise<Narration> {
  const llm = verbatim ? null : await ctx.llm().catch((e: Error) => {
    ctx.log.warn(`llm unavailable (${e.message}); narrating verbatim`);
    return null;
  });
  return narrateRun(t.flow, run, {
    store: ctx.store,
    tts: ctx.tts(),
    fallbackTTS: ctx.fallbackTTS(),
    llm,
    voice: t.flow.voice ?? ctx.config.voice,
    glossary: await ctx.glossary(),
    logger: ctx.log,
    verbatim
  });
}

async function loadNarration(run: RunResult): Promise<Narration | undefined> {
  const p = path.join(run.runDir, "narration.json");
  return (await exists(p)) ? readJson<Narration>(p) : undefined;
}

async function doRender(ctx: Ctx, t: Target, run: RunResult, narration: Narration, o: { fps?: number; captions?: boolean; rebundle?: boolean }) {
  const slug = ctx.store.slugFor(t.flow.name);
  const dir = ctx.store.rendersDir(slug);
  const manifest = buildManifest(t.flow, run, narration, {
    fps: o.fps ?? ctx.config.fps,
    captions: o.captions ?? ctx.config.captions,
    brand: ctx.config.brand
  });
  await writeManifest(manifest, path.join(dir, "manifest.json"));
  ctx.log.info(`render: ${t.flow.name} (${manifest.scenes.length} scenes, ${(manifest.totalDurationMs / 1000).toFixed(1)}s)`);
  return renderVideo(manifest, {
    outFile: path.join(dir, `${slug}.mp4`),
    poster: path.join(dir, `${slug}.png`),
    bundleDir: path.join(ctx.out, "cache", "remotion-bundle"),
    rebundle: o.rebundle,
    log: (m) => ctx.log.info(m),
    onProgress: (p) => ctx.log.debug(`render ${p}%`)
  });
}

/* ---------- build ---------- */

async function build(ctx: Ctx, targets: Target[], o: BuildOpts): Promise<number> {
  const reports: FlowReport[] = [];
  const started = Date.now();
  let changed: string[] | undefined;
  if (o.since) {
    if (!isGitRepo(ctx.cwd)) ctx.log.warn("--since given but this is not a git repo; running everything");
    else {
      changed = changedFiles(o.since, ctx.cwd);
      ctx.log.info(`${changed.length} files changed since ${o.since}`);
    }
  }
  const affected = changed
    ? new Map(affectedFlows(targets.filter((t) => t.file).map((t) => ({ flow: t.flow, file: t.file! })), changed).map((a) => [a.flow.name, a]))
    : undefined;

  for (const t of targets) {
    const t0 = Date.now();
    const slug = ctx.store.slugFor(t.flow.name);
    const fr: FlowReport = { name: t.flow.name, slug, file: t.file ? rel(ctx, t.file) : undefined, status: "passed", rendered: false, durationMs: 0 };
    reports.push(fr);
    const aff = affected?.get(t.flow.name);
    if (aff) fr.changedFiles = aff.matches;
    if (aff && !aff.always && aff.matches.length === 0 && o.onlyAffected) {
      fr.status = "skipped";
      fr.skippedReason = `no changed files match touches since ${o.since}`;
      ctx.log.info(`skip: ${t.flow.name} (${fr.skippedReason})`);
      fr.durationMs = Date.now() - t0;
      continue;
    }
    try {
      let flow = t.flow;
      let run = await doRun(ctx, t, { headed: o.headed, changedFiles: aff?.matches });
      fr.runId = run.runId;
      const base = await blessed(ctx, slug);

      if (run.status === "failed" && o.heal !== false) {
        const r = await doHeal(ctx, t, run, Number(o.minConfidence ?? 0.5));
        if (r) {
          fr.heals = r.heals;
          run = r.run;
          flow = r.flow;
          fr.runId = run.runId;
          if (o.writeHeals && t.file && r.heals.some((h) => h.verified)) {
            await fs.writeFile(t.file, stringifyFlow(flow), "utf8");
            fr.healedFlowWritten = true;
            ctx.log.info(`wrote healed flow ${rel(ctx, t.file)}`);
          }
        }
      }
      fr.status = run.status;

      if (base) {
        fr.diff = await compareRuns(base, run, { reportDir: ctx.store.reportsDir(slug) });
        await writeJson(path.join(ctx.store.reportsDir(slug), "diff.json"), fr.diff);
      }
      if (fr.heals) await writeJson(path.join(ctx.store.reportsDir(slug), "heal.json"), fr.heals);

      const videoPath = path.join(ctx.store.rendersDir(slug), `${slug}.mp4`);
      const unchanged = !!fr.diff && !fr.diff.needsRender && (await exists(videoPath));
      if (run.status === "passed" && o.render !== false) {
        if (unchanged && !o.force) {
          ctx.log.info(`render: ${t.flow.name} unchanged, keeping ${rel(ctx, videoPath)}`);
          fr.video = rel(ctx, videoPath);
          const poster = videoPath.replace(/\.mp4$/, ".png");
          if (await exists(poster)) fr.poster = rel(ctx, poster);
        } else {
          const narration = o.narrate === false ? silentNarration(run) : await doNarrate(ctx, { ...t, flow }, run, !!o.verbatim);
          const r = await doRender(ctx, { ...t, flow }, run, narration, { fps: o.fps ? Number(o.fps) : undefined });
          fr.video = rel(ctx, r.outFile);
          if (r.poster) fr.poster = rel(ctx, r.poster);
          fr.rendered = true;
        }
      }
      if (run.status === "passed" && !t.recordedRun && (o.bless || !base)) {
        await ctx.store.bless(slug, run.runId);
        fr.blessed = run.runId;
        ctx.log.info(`bless: ${t.flow.name} → ${run.runId}${base ? "" : " (first baseline)"}`);
      }
      if (!t.recordedRun) await ctx.store.prune(slug, Number(o.keepRuns ?? 5));
    } catch (e) {
      fr.status = "failed";
      fr.skippedReason = (e as Error).message;
      ctx.log.error(`${t.flow.name}: ${(e as Error).message}`);
    }
    fr.durationMs = Date.now() - t0;
  }

  const reportDir = path.resolve(ctx.cwd, o.report ?? ctx.out);
  const md = reportMarkdown(ctx, reports, Date.now() - started, o.since);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "report.md"), md, "utf8");
  await writeJson(path.join(reportDir, "report.json"), { generatedAt: new Date().toISOString(), since: o.since, flows: reports });
  console.log("\n" + md);
  const broken = reports.some((r) => r.status === "failed");
  return broken && o.failOnBroken !== false ? 1 : 0;
}

function silentNarration(run: RunResult): Narration {
  return { version: 1, llm: "none", tts: "none", steps: run.steps.map((s) => ({ index: s.index, say: s.say, text: s.say, audio: "", durationMs: 2600, cached: true })) };
}

function reportMarkdown(ctx: Ctx, reports: FlowReport[], elapsedMs: number, since?: string): string {
  const icon = (r: FlowReport) => (r.status === "failed" ? "❌" : r.status === "skipped" ? "⏭️" : r.diff?.needsRender ? "✏️" : "✅");
  const lines: string[] = [];
  const failed = reports.filter((r) => r.status === "failed").length;
  const changed = reports.filter((r) => r.diff?.needsRender && r.status !== "failed").length;
  lines.push(`## demo-engine report`);
  lines.push("");
  lines.push(
    `${failed ? `❌ ${failed} broken` : "✅ no broken flows"} · ${changed} changed · ${reports.filter((r) => r.rendered).length} rendered · ${reports.length} flows in ${(elapsedMs / 1000).toFixed(0)}s${since ? ` · since \`${since}\`` : ""}`
  );
  lines.push("");
  lines.push("| flow | status | video | notes |");
  lines.push("|------|--------|-------|-------|");
  for (const r of reports) {
    const notes: string[] = [];
    if (r.skippedReason) notes.push(r.skippedReason);
    if (r.diff) {
      const s = r.diff.summary;
      notes.push([s.broken && `${s.broken} broken`, s.changed && `${s.changed} changed`, s.cosmetic && `${s.cosmetic} cosmetic`, s.unchanged && `${s.unchanged} unchanged`].filter(Boolean).join(", "));
    } else if (r.status === "passed") notes.push(r.blessed ? "first baseline" : "no baseline");
    if (r.heals?.length) notes.push(`${r.heals.filter((h) => h.verified).length}/${r.heals.length} locators healed${r.healedFlowWritten ? " (written)" : ""}`);
    if (r.changedFiles?.length) notes.push(`${r.changedFiles.length} touching files changed`);
    lines.push(`| ${r.name} | ${icon(r)} ${r.status} | ${r.video ? `\`${r.video}\`` : "—"} | ${notes.join(" · ")} |`);
  }
  for (const r of reports) {
    if (r.diff && r.diff.needsRender) {
      lines.push("");
      lines.push(diffToMarkdown(r.diff));
    }
    if (r.heals?.length) {
      lines.push("");
      lines.push(`#### Heals — ${r.name}`);
      lines.push("");
      for (const h of r.heals) {
        lines.push(`- ${h.verified ? "✅" : "❌"} step ${h.stepIndex + 1} "${h.say}": \`${JSON.stringify(h.from)}\` → \`${JSON.stringify(stripFallbacks(h.to))}\` (${h.via ?? "?"}, ${(h.confidence * 100).toFixed(0)}%) ${h.reason}`);
      }
      if (!r.healedFlowWritten && r.heals.some((h) => h.verified)) lines.push(`\nRun \`demo-engine heal --write ${r.file ?? ""}\` to keep these repairs.`);
    }
  }
  return lines.join("\n") + "\n";
}

function stripFallbacks(o: unknown): unknown {
  if (o && typeof o === "object" && "fallbacks" in o) {
    const { fallbacks: _f, ...rest } = o as Record<string, unknown>;
    return rest;
  }
  return o;
}

function printHeals(heals: Heal[]): void {
  for (const h of heals) {
    console.log(`${h.verified ? "✓" : "✗"} step ${h.stepIndex + 1}: ${JSON.stringify(h.from)} → ${JSON.stringify(stripFallbacks(h.to))}  [${h.via}, ${(h.confidence * 100).toFixed(0)}%] ${h.reason}`);
  }
}

function collectAnchors(flow: { steps: unknown[] }): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (typeof o.anchor === "string") out.add(o.anchor);
    Object.values(o).forEach(visit);
  };
  visit(flow.steps);
  return [...out];
}

async function readTree(dir: string): Promise<string> {
  if (!(await exists(dir))) throw new Error(`source dir not found: ${dir}`);
  const parts: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await walk(p);
      } else if (/\.(tsx?|jsx?|vue|svelte|html|hbs|erb|php|astro|mdx?)$/.test(e.name)) parts.push(await fs.readFile(p, "utf8"));
    }
  };
  await walk(dir);
  return parts.join("\n");
}

/* ---------- init ---------- */

async function init(cwd: string, baseUrl: string, force: boolean): Promise<void> {
  const files: [string, string][] = [
    ["demo-engine.config.yaml", (await fs.readFile(path.join(TEMPLATES, "config.yaml"), "utf8")).replace("__BASE_URL__", baseUrl)],
    ["demos/example.flow.yaml", await fs.readFile(path.join(TEMPLATES, "example.flow.yaml"), "utf8")],
    ["demos/glossary.md", await fs.readFile(path.join(TEMPLATES, "glossary.md"), "utf8")],
    ["demos/login.example.mjs", await fs.readFile(path.join(TEMPLATES, "login.example.mjs"), "utf8")],
    [".github/workflows/demos.yml", await fs.readFile(path.join(TEMPLATES, "workflow.yml"), "utf8")]
  ];
  for (const [relPath, content] of files) {
    const p = path.join(cwd, relPath);
    if ((await exists(p)) && !force) {
      console.log(`skip  ${relPath} (exists)`);
      continue;
    }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    console.log(`write ${relPath}`);
  }
  const gi = path.join(cwd, ".gitignore");
  const line = ".demo-engine/";
  const cur = (await exists(gi)) ? await fs.readFile(gi, "utf8") : "";
  if (!cur.split("\n").includes(line)) {
    await fs.writeFile(gi, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + line + "\n", "utf8");
    console.log(`write .gitignore (+ ${line})`);
  }
  console.log(`\nNext:\n  npx playwright install chromium\n  npx demo-engine build demos\n`);
}
