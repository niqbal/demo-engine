import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { resolveLocator, toLocator, type Resolution } from "./locators.js";
import { stepAction, type ActionKind, type Flow, type LocatorSpec, type PersonalizeRule, type StepSpec } from "./schema.js";
import { ensureDir, sha256, silentLogger, timestampId, type Logger } from "./util.js";
import { Store } from "./store.js";
import type { Audience } from "./audience.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StepResult {
  index: number;
  id: string;
  say: string;
  action: { kind: ActionKind; target?: LocatorSpec; detail?: string };
  resolution?: Omit<Resolution, "locator">;
  /** Target element rect in CSS pixels, before the action. */
  targetRect?: Rect;
  zoomRect?: Rect;
  zoomScale?: number;
  before: string; // relative path to png
  after: string;
  /** Frame captured with the pointer hovering the target (buttons show hover state). */
  hover?: string;
  /** Intermediate frames captured while typing, in order. */
  typing?: string[];
  aria: string; // relative path to aria snapshot text
  masks: Rect[];
  expect?: { ok: boolean; message?: string };
  error?: string;
  cascade?: boolean;
  /** True when this frame differs per audience (references audience data, follows a personalized state change, or an overlay applies). */
  personalized?: boolean;
  url: string;
  durationMs: number;
}

export interface RunResult {
  version: 1;
  flowName: string;
  slug: string;
  flowFile?: string;
  flowHash: string;
  runId: string;
  runDir: string;
  baseUrl?: string;
  startUrl: string;
  startedAt: string;
  finishedAt: string;
  viewport: { width: number; height: number };
  scale: number;
  status: "passed" | "failed";
  steps: StepResult[];
  /** Files changed in the product repo for this run, when known (git integration). */
  changedFiles?: string[];
  /** The audience this run was captured for; absent for the default audience. */
  audience?: Audience;
  /** For an audience run: the default-audience run it belongs to. */
  parentRunId?: string;
  /** Set when the audience run reused the default run's frames (nothing in the app depends on the audience). */
  sharedCapture?: boolean;
}

export interface RunOptions {
  baseUrl?: string;
  out?: string;
  runId?: string;
  headless?: boolean;
  timeoutMs?: number;
  logger?: Logger;
  flowFile?: string;
  /** Overrides flow steps (used by heal to try a patched flow without touching disk). */
  stepsOverride?: StepSpec[];
  changedFiles?: string[];
  /** Working directory used to resolve auth scripts and storage state. */
  cwd?: string;
  /** Called after each step completes (for progress output). */
  onStep?: (s: StepResult) => void;
  /** Audience this run is captured for. Exposed to `setup:` as AUDIENCE_ID / AUDIENCE_JSON. */
  audience?: Audience;
  /** DOM rewrites applied before every screenshot (already rendered for the audience). */
  personalize?: PersonalizeRule[];
  /** Step indices that are personalized for this audience (marks frames in run.json). */
  personalizedSteps?: number[];
  /** Absolute directory to write into instead of `runs/<slug>/<runId>` (audience runs). */
  runDir?: string;
  parentRunId?: string;
}

const DISABLE_MOTION_CSS = `
*, *::before, *::after {
  animation-duration: 0.001s !important;
  animation-delay: 0s !important;
  transition-duration: 0.001s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

export function resolveUrl(url: string, baseUrl?: string): string {
  const substituted = url.replace(/\$\{BASE_URL\}/g, baseUrl ?? "");
  if (/^https?:\/\//i.test(substituted)) return substituted;
  if (!baseUrl) throw new Error(`Flow url "${url}" is relative but no --base-url was given`);
  return new URL(substituted, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").toString();
}

export function flowHash(flow: Flow): string {
  return sha256(JSON.stringify(flow)).slice(0, 16);
}

async function settle(page: Page, log: Logger): Promise<void> {
  try {
    await page.waitForLoadState("load", { timeout: 10_000 });
  } catch {
    log.debug("load state timeout");
  }
  try {
    await page.waitForLoadState("networkidle", { timeout: 2_500 });
  } catch {
    /* busy pages never go idle; that is fine */
  }
  try {
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
  } catch {
    /* ignore */
  }
  await page.waitForTimeout(300);
}

async function rectsFor(page: Page, selectors: string[]): Promise<Rect[]> {
  const rects: Rect[] = [];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const n = Math.min(await loc.count(), 50);
      for (let i = 0; i < n; i++) {
        const b = await loc.nth(i).boundingBox();
        if (b) rects.push(b);
      }
    } catch {
      /* bad selector: ignore for masks */
    }
  }
  return rects;
}

async function runShell(cmd: string, env: NodeJS.ProcessEnv, cwd: string, log: Logger): Promise<void> {
  log.info(`setup: ${cmd}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: "inherit", env: { ...process.env, ...env }, cwd });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`setup exited with ${code}`))));
    child.on("error", reject);
  });
}

/**
 * Layer 2 personalization: rewrite matching DOM nodes in place. Idempotent, so it is safe to run
 * before every screenshot; SPA re-renders that replace the nodes are repainted on the next call.
 */
export async function applyPersonalize(page: Page, rules: PersonalizeRule[] | undefined): Promise<number> {
  if (!rules?.length) return 0;
  try {
    return await page.evaluate((rs: PersonalizeRule[]) => {
      let n = 0;
      for (const r of rs) {
        let nodes: Element[];
        try {
          nodes = r.all === false ? [document.querySelector(r.css)].filter(Boolean) as Element[] : Array.from(document.querySelectorAll(r.css));
        } catch {
          continue;
        }
        for (const el of nodes) {
          if (r.text !== undefined && el.textContent !== r.text) el.textContent = r.text;
          if (r.html !== undefined && el.innerHTML !== r.html) el.innerHTML = r.html;
          if (r.src !== undefined && el.getAttribute("src") !== r.src) {
            el.setAttribute("src", r.src);
            if (el instanceof HTMLImageElement) el.removeAttribute("srcset");
          }
          if (r.style !== undefined) (el as HTMLElement).style.cssText += ";" + r.style;
          if (r.attr) for (const [k, v] of Object.entries(r.attr)) if (el.getAttribute(k) !== v) el.setAttribute(k, v);
          n++;
        }
      }
      return n;
    }, rules);
  } catch {
    return 0;
  }
}

async function applyAuth(flow: Flow, context: BrowserContext, page: Page, opts: RunOptions, log: Logger): Promise<void> {
  if (!flow.auth?.login) return;
  const file = path.resolve(opts.cwd ?? process.cwd(), flow.auth.login);
  log.info(`login script: ${file}`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; login?: unknown };
  const fn = (mod.default ?? mod.login) as ((page: Page, context: BrowserContext, env: { baseUrl?: string }) => Promise<void>) | undefined;
  if (typeof fn !== "function") throw new Error(`${file} must export a default async function(page, context, { baseUrl })`);
  await fn(page, context, { baseUrl: opts.baseUrl });
}

export async function runFlow(flow: Flow, opts: RunOptions = {}): Promise<RunResult> {
  const log = opts.logger ?? silentLogger;
  const store = new Store(opts.out ?? ".demo-engine");
  const slug = store.slugFor(flow.name);
  const runId = opts.runId ?? timestampId();
  const runDir = path.resolve(opts.runDir ?? store.runDir(slug, runId));
  const stepsDir = path.join(runDir, "steps");
  await ensureDir(stepsDir);
  const steps = opts.stepsOverride ?? flow.steps;
  const scale = 2;
  const startUrl = resolveUrl(flow.url, opts.baseUrl);
  const cwd = opts.cwd ?? process.cwd();
  const personalized = new Set(opts.personalizedSteps ?? []);
  const rules = opts.personalize ?? flow.personalize;

  if (flow.setup) {
    await runShell(
      flow.setup,
      {
        BASE_URL: opts.baseUrl ?? "",
        AUDIENCE_ID: opts.audience?.id ?? "default",
        AUDIENCE_JSON: JSON.stringify(opts.audience ?? {})
      },
      cwd,
      log
    );
  }

  const result: RunResult = {
    version: 1,
    flowName: flow.name,
    slug,
    flowFile: opts.flowFile,
    flowHash: flowHash({ ...flow, steps }),
    runId,
    runDir,
    baseUrl: opts.baseUrl,
    startUrl,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    viewport: flow.viewport,
    scale,
    status: "passed",
    steps: [],
    changedFiles: opts.changedFiles,
    audience: opts.audience,
    parentRunId: opts.parentRunId
  };

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: opts.headless ?? true });
    const storageState = flow.auth?.storageState ? path.resolve(cwd, flow.auth.storageState) : undefined;
    const context = await browser.newContext({
      viewport: flow.viewport,
      deviceScaleFactor: scale,
      reducedMotion: "reduce",
      storageState,
      locale: "en-US",
      timezoneId: "UTC"
    });
    context.setDefaultTimeout(opts.timeoutMs ?? 10_000);
    await context.addInitScript((css: string) => {
      const add = () => {
        const s = document.createElement("style");
        s.setAttribute("data-demo-engine", "motion");
        s.textContent = css;
        document.head?.appendChild(s);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add);
    }, DISABLE_MOTION_CSS);

    const page = await context.newPage();
    const shot = async (rel: string) => {
      await applyPersonalize(page, rules);
      await page.screenshot({ path: path.join(runDir, rel), fullPage: false });
    };
    await applyAuth(flow, context, page, opts, log);
    log.info(`open ${startUrl}${opts.audience ? `  (audience: ${opts.audience.id})` : ""}`);
    await page.goto(startUrl);
    await settle(page, log);
    if (rules?.length) log.info(`personalize: ${await applyPersonalize(page, rules)} node(s) rewritten by ${rules.length} rule(s)`);

    let failedBefore = false;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const t0 = Date.now();
      const n = String(i + 1).padStart(2, "0");
      const act = stepAction(step);
      const sr: StepResult = {
        index: i,
        id: step.id ?? `step-${n}`,
        say: step.say,
        action: { kind: act.kind, target: act.target },
        before: `steps/${n}-before.png`,
        after: `steps/${n}-after.png`,
        aria: `steps/${n}-aria.txt`,
        masks: [],
        personalized: personalized.has(i) || undefined,
        url: page.url(),
        durationMs: 0
      };
      try {
        if (act.kind === "goto" && step.goto) {
          await page.goto(resolveUrl(step.goto, opts.baseUrl));
          await settle(page, log);
        }
        let target: Locator | undefined;
        if (act.target !== undefined) {
          const res = await resolveLocator(page, act.target, opts.timeoutMs ?? 10_000);
          const { locator, ...rest } = res;
          sr.resolution = rest;
          if (res.status === "missing") throw new Error(`target not found: ${res.description}`);
          target = locator;
          await target!.scrollIntoViewIfNeeded().catch(() => undefined);
          await page.waitForTimeout(150);
          const box = await target!.boundingBox();
          if (box) sr.targetRect = box;
        }
        await shot(sr.before);
        if (target && (act.kind === "click" || act.kind === "dblclick" || act.kind === "check" || act.kind === "select")) {
          try {
            await target.hover({ timeout: 2000 });
            await page.waitForTimeout(120);
            sr.hover = `steps/${n}-hover.png`;
            await shot(sr.hover);
          } catch {
            sr.hover = undefined;
          }
        }

        if (target && (act.kind === "fill" || act.kind === "type")) {
          sr.typing = await typeWithFrames(page, target, step, act.kind, shot, n);
        } else {
          await performAction(page, step, act.kind, target);
        }
        await settle(page, log);

        if (step.wait !== undefined) {
          if (typeof step.wait === "number") await page.waitForTimeout(step.wait);
          else await toLocator(page, step.wait).first().waitFor({ state: "visible" });
        }
        if (step.expect) sr.expect = await checkExpect(page, step);
        if (step.zoom) {
          const zoomTarget = step.zoom.on ?? act.target;
          if (zoomTarget !== undefined) {
            const zr = await resolveLocator(page, zoomTarget, 2000);
            const b = zr.locator ? await zr.locator.boundingBox() : null;
            if (b) sr.zoomRect = b;
          } else if (sr.targetRect) {
            sr.zoomRect = sr.targetRect;
          }
          sr.zoomScale = step.zoom.scale;
        }
        if (step.pause) await page.waitForTimeout(step.pause);
        sr.masks = await rectsFor(page, [...(flow.mask ?? []), ...(step.mask ?? [])]);
        await shot(sr.after);
        try {
          const aria = await page.locator("body").ariaSnapshot();
          await fs.writeFile(path.join(runDir, sr.aria), aria, "utf8");
        } catch (e) {
          await fs.writeFile(path.join(runDir, sr.aria), "", "utf8");
          log.debug(`aria snapshot failed: ${(e as Error).message}`);
        }
        if (sr.expect && !sr.expect.ok) throw new Error(`expectation failed: ${sr.expect.message}`);
      } catch (e) {
        sr.error = (e as Error).message.split("\n")[0];
        sr.cascade = failedBefore;
        failedBefore = true;
        result.status = "failed";
        log.warn(`step ${n} failed: ${sr.error}`);
        // Capture whatever is on screen so heal and diff have context.
        for (const rel of [sr.before, sr.after]) {
          const p = path.join(runDir, rel);
          if (!(await fileExists(p))) await page.screenshot({ path: p }).catch(() => undefined);
        }
        if (!(await fileExists(path.join(runDir, sr.aria)))) {
          const aria = await page.locator("body").ariaSnapshot().catch(() => "");
          await fs.writeFile(path.join(runDir, sr.aria), aria, "utf8");
        }
      }
      sr.url = page.url();
      sr.durationMs = Date.now() - t0;
      result.steps.push(sr);
      opts.onStep?.(sr);
      log.info(`step ${n} ${sr.error ? "FAIL" : "ok"}  ${step.say.slice(0, 70)}`);
    }
    await context.close();
  } finally {
    await browser?.close().catch(() => undefined);
  }
  result.finishedAt = new Date().toISOString();
  await store.saveRun(result);
  return result;
}

/** Type character by character, capturing a frame every few characters for a real typing animation. */
async function typeWithFrames(page: Page, target: Locator, step: StepSpec, kind: "fill" | "type", shot: (rel: string) => Promise<void>, n: string): Promise<string[]> {
  const value = kind === "fill" ? step.fill!.value : step.type!.value;
  const press = step.press;
  const frames: string[] = [];
  await target.click();
  if (kind === "fill") await target.fill("");
  const every = Math.max(1, Math.ceil(value.length / 12));
  for (let i = 0; i < value.length; i++) {
    await page.keyboard.type(value[i]);
    if ((i + 1) % every === 0 || i === value.length - 1) {
      const rel = `steps/${n}-typing-${String(frames.length + 1).padStart(2, "0")}.png`;
      await shot(rel);
      frames.push(rel);
    }
  }
  if (press) await page.keyboard.press(press);
  return frames;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function performAction(page: Page, step: StepSpec, kind: ActionKind, target?: Locator): Promise<void> {
  switch (kind) {
    case "click":
      await target!.click();
      return;
    case "dblclick":
      await target!.dblclick();
      return;
    case "hover":
      await target!.hover();
      return;
    case "fill":
      if (target) await target.fill(step.fill!.value);
      else await page.keyboard.type(step.fill!.value);
      if (step.press) await page.keyboard.press(step.press);
      return;
    case "type":
      if (target) await target.pressSequentially(step.type!.value, { delay: step.type!.delay ?? 40 });
      else await page.keyboard.type(step.type!.value, { delay: step.type!.delay ?? 40 });
      if (step.press) await page.keyboard.press(step.press);
      return;
    case "select": {
      const opt = step.select!.option;
      try {
        await target!.selectOption({ label: opt });
      } catch {
        await target!.selectOption(opt);
      }
      return;
    }
    case "check":
      await target!.check();
      return;
    case "press":
      await page.keyboard.press(step.press!);
      return;
    case "scroll":
      await target!.scrollIntoViewIfNeeded();
      return;
    case "goto":
    case "wait":
    case "none":
      return;
  }
}

async function checkExpect(page: Page, step: StepSpec): Promise<{ ok: boolean; message?: string }> {
  const ex = step.expect!;
  try {
    if (ex.text) {
      await page.getByText(ex.text).first().waitFor({ state: "visible", timeout: 5000 });
    }
    if (ex.visible !== undefined) {
      await toLocator(page, ex.visible).first().waitFor({ state: "visible", timeout: 5000 });
    }
    if (ex.hidden !== undefined) {
      await toLocator(page, ex.hidden).first().waitFor({ state: "hidden", timeout: 5000 });
    }
    if (ex.url) {
      const u = page.url();
      if (!u.includes(ex.url)) return { ok: false, message: `url "${u}" does not include "${ex.url}"` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message.split("\n")[0] };
  }
}
