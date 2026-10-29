import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createLLM,
  createLogger,
  createTTS,
  defaultAudience,
  exists,
  loadAudiences,
  parseConfig,
  parseFlow,
  personalizeFlow,
  readJson,
  Store,
  type Audience,
  type Config,
  type Flow,
  type LLM,
  type Logger,
  type RunResult,
  type TTS
} from "@demo-engine/core";

export interface GlobalOpts {
  config?: string;
  out?: string;
  baseUrl?: string;
  verbose?: boolean;
}

export interface Ctx {
  cwd: string;
  config: Config;
  configFile?: string;
  out: string;
  baseUrl?: string;
  store: Store;
  log: Logger;
  llm: () => Promise<LLM | null>;
  tts: () => TTS;
  fallbackTTS: () => TTS;
  glossary: () => Promise<string | undefined>;
}

export async function loadContext(opts: GlobalOpts): Promise<Ctx> {
  const cwd = process.cwd();
  let configFile = opts.config ? path.resolve(cwd, opts.config) : path.join(cwd, "demo-engine.config.yaml");
  let config: Config;
  if (await exists(configFile)) {
    config = parseConfig(await fs.readFile(configFile, "utf8"), configFile);
  } else {
    if (opts.config) throw new Error(`config not found: ${configFile}`);
    configFile = "";
    config = parseConfig("{}");
  }
  const out = path.resolve(cwd, opts.out ?? config.out);
  const baseUrl = opts.baseUrl ?? process.env.DEMO_BASE_URL ?? config.baseUrl;
  const log = createLogger(!!opts.verbose);
  let llmPromise: Promise<LLM | null> | undefined;
  return {
    cwd,
    config,
    configFile: configFile || undefined,
    out,
    baseUrl,
    store: new Store(out),
    log,
    llm: () => (llmPromise ??= createLLM(config.llm)),
    tts: () => createTTS(config.tts),
    fallbackTTS: () => createTTS(process.platform === "darwin" ? "say" : "silent"),
    glossary: async () => {
      const g = config.glossary ? path.resolve(cwd, config.glossary) : path.join(cwd, config.demos, "glossary.md");
      return (await exists(g)) ? fs.readFile(g, "utf8") : undefined;
    }
  };
}

export interface Target {
  /** Flow file on disk (undefined for recorded runs). */
  file?: string;
  /** The flow rendered for the default audience (`defaults:` applied). What run, diff and heal use. */
  flow: Flow;
  /** The flow exactly as written, with `{{audience.*}}` intact. What gets written back after heals. */
  template: Flow;
  /** A pre-recorded run directory (from @demo-engine/playwright). */
  recordedRun?: RunResult;
}

function toTarget(template: Flow, extra: Omit<Target, "flow" | "template">): Target {
  return { ...extra, template, flow: personalizeFlow(template, defaultAudience(template)).flow };
}

export interface AudienceOpts {
  audience?: string;
  audiences?: string[] | true;
}

/** Directory bare audience names resolve against. */
export function audiencesDir(ctx: Ctx): string {
  return path.resolve(ctx.cwd, ctx.config.audiences ?? path.join(ctx.config.demos, "audiences"));
}

/**
 * `--audience acme` / `--audiences acme globex` / `--audiences prospects.csv` / `--audiences` (all).
 * Bare names resolve against the audiences dir, with .yaml/.yml/.json tried in that order.
 */
export async function resolveAudiences(ctx: Ctx, o: AudienceOpts): Promise<Audience[]> {
  const dir = audiencesDir(ctx);
  const inputs: string[] = [];
  if (o.audience) inputs.push(o.audience);
  if (o.audiences === true) {
    if (!(await exists(dir))) throw new Error(`--audiences given without names and ${rel(ctx, dir)} does not exist`);
    inputs.push(dir);
  } else if (o.audiences) inputs.push(...o.audiences);
  const resolved: string[] = [];
  for (const a of inputs) {
    const direct = path.resolve(ctx.cwd, a);
    if (await exists(direct)) {
      resolved.push(direct);
      continue;
    }
    const candidates = [a, `${a}.yaml`, `${a}.yml`, `${a}.json`, `${a}.csv`].map((n) => path.join(dir, n));
    let found: string | undefined;
    for (const c of candidates) if (await exists(c)) { found = c; break; }
    if (!found) throw new Error(`audience not found: ${a} (looked in ${rel(ctx, dir)})`);
    resolved.push(found);
  }
  return loadAudiences(resolved);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...(await walk(p)));
    } else if (/\.flow\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

/** Resolve CLI args (files, dirs, run dirs) into flows. No args = config.demos dir. */
export async function resolveTargets(ctx: Ctx, args: string[]): Promise<Target[]> {
  const inputs = args.length ? args : [ctx.config.demos];
  const targets: Target[] = [];
  for (const a of inputs) {
    const p = path.resolve(ctx.cwd, a);
    if (!(await exists(p))) throw new Error(`not found: ${a}`);
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      if (await exists(path.join(p, "run.json"))) {
        const run = await readJson<RunResult>(path.join(p, "run.json"));
        const flowFile = path.join(p, "flow.yaml");
        if (!(await exists(flowFile))) throw new Error(`${a}: run.json without flow.yaml`);
        targets.push(toTarget(parseFlow(await fs.readFile(flowFile, "utf8"), flowFile), { recordedRun: { ...run, runDir: p } }));
        continue;
      }
      for (const f of await walk(p)) targets.push(toTarget(parseFlow(await fs.readFile(f, "utf8"), f), { file: f }));
    } else {
      targets.push(toTarget(parseFlow(await fs.readFile(p, "utf8"), p), { file: p }));
    }
  }
  if (!targets.length) throw new Error(`no *.flow.yaml files found in ${inputs.join(", ")}`);
  return targets;
}

export function rel(ctx: Ctx, p: string): string {
  return path.relative(ctx.cwd, p) || ".";
}
