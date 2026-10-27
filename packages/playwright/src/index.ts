import { promises as fs } from "node:fs";
import path from "node:path";
import { test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  ensureDir,
  flowHash,
  sha256,
  slugify,
  stringifyFlow,
  timestampId,
  writeJson,
  type Flow,
  type Rect,
  type RunResult,
  type StepResult,
  type StepSpec
} from "@demo-engine/core";

export interface DemoEngineOptions {
  /** Output directory, same layout as the CLI (default `.demo-engine`). */
  out?: string;
  /** Flow name (default: the test title). */
  name?: string;
  /** Description shown on the title card. */
  description?: string;
  /** CSS selectors to mask in diffs (timestamps, avatars). */
  mask?: string[];
  /** Disabled unless DEMO_ENGINE=1 or `record: true`. */
  record?: boolean;
}

export interface StepOptions {
  /** Element the cursor should move to and click/zoom on. */
  target?: Locator;
  zoom?: number;
  mask?: string[];
}

export class DemoRecorder {
  private steps: StepResult[] = [];
  private specs: StepSpec[] = [];
  private runDir = "";
  private startedAt = new Date().toISOString();
  private startUrl = "";
  readonly enabled: boolean;

  constructor(private page: Page, private info: TestInfo, private opts: DemoEngineOptions) {
    this.enabled = opts.record ?? process.env.DEMO_ENGINE === "1";
  }

  get name(): string {
    return this.opts.name ?? this.info.title;
  }

  /**
   * Record one narrated step. The callback performs ordinary Playwright
   * actions; the recorder captures the frame before and after.
   */
  async step(say: string, fnOrOpts: StepOptions | (() => Promise<void>), maybeFn?: () => Promise<void>): Promise<void> {
    const opts = typeof fnOrOpts === "function" ? {} : fnOrOpts;
    const fn = typeof fnOrOpts === "function" ? fnOrOpts : maybeFn;
    if (!this.enabled) {
      await fn?.();
      return;
    }
    if (!this.runDir) await this.begin();
    const i = this.steps.length;
    const n = String(i + 1).padStart(2, "0");
    const t0 = Date.now();
    const sr: StepResult = {
      index: i,
      id: `step-${n}`,
      say,
      action: { kind: opts.target ? "click" : "none" },
      before: `steps/${n}-before.png`,
      after: `steps/${n}-after.png`,
      aria: `steps/${n}-aria.txt`,
      masks: [],
      url: this.page.url(),
      durationMs: 0
    };
    if (opts.target) {
      await opts.target.scrollIntoViewIfNeeded().catch(() => undefined);
      const box = await opts.target.boundingBox().catch(() => null);
      if (box) sr.targetRect = box;
      if (opts.zoom && box) {
        sr.zoomRect = box;
        sr.zoomScale = opts.zoom;
      }
    }
    await this.page.screenshot({ path: path.join(this.runDir, sr.before) });
    try {
      await fn?.();
    } catch (e) {
      sr.error = (e as Error).message.split("\n")[0];
      throw e;
    } finally {
      await settle(this.page);
      sr.masks = await rectsFor(this.page, [...(this.opts.mask ?? []), ...(opts.mask ?? [])]);
      await this.page.screenshot({ path: path.join(this.runDir, sr.after) }).catch(() => undefined);
      const aria = await this.page.locator("body").ariaSnapshot().catch(() => "");
      await fs.writeFile(path.join(this.runDir, sr.aria), aria, "utf8");
      sr.url = this.page.url();
      sr.durationMs = Date.now() - t0;
      this.steps.push(sr);
      this.specs.push({ say, ...(opts.zoom ? { zoom: { scale: opts.zoom } } : {}) });
    }
  }

  private async begin(): Promise<void> {
    const out = path.resolve(this.opts.out ?? ".demo-engine");
    const slug = slugify(this.name);
    this.runDir = path.join(out, "runs", slug, timestampId());
    await ensureDir(path.join(this.runDir, "steps"));
    this.startUrl = this.page.url();
  }

  /** Called automatically by the fixture after the test. */
  async finish(): Promise<string | undefined> {
    if (!this.enabled || !this.runDir) return undefined;
    const vp = this.page.viewportSize() ?? { width: 1280, height: 720 };
    const flow: Flow = {
      name: this.name,
      description: this.opts.description,
      url: this.startUrl || "about:blank",
      viewport: vp,
      steps: this.specs.length ? this.specs : [{ say: this.name }]
    };
    const run: RunResult = {
      version: 1,
      flowName: flow.name,
      slug: slugify(flow.name),
      flowHash: flowHash(flow),
      runId: path.basename(this.runDir),
      runDir: this.runDir,
      startUrl: flow.url,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      viewport: vp,
      scale: await deviceScale(this.page),
      status: this.steps.some((s) => s.error) ? "failed" : "passed",
      steps: this.steps
    };
    await fs.writeFile(path.join(this.runDir, "flow.yaml"), stringifyFlow(flow), "utf8");
    await writeJson(path.join(this.runDir, "run.json"), run);
    this.info.annotations.push({ type: "demo-engine", description: this.runDir });
    return this.runDir;
  }
}

async function deviceScale(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => window.devicePixelRatio);
  } catch {
    return 1;
  }
}

async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 2000 });
  } catch {
    /* ignore */
  }
  await page.waitForTimeout(250);
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
      /* ignore */
    }
  }
  return rects;
}

export const test = base.extend<{ demoEngine: DemoEngineOptions; demo: DemoRecorder }>({
  demoEngine: [{}, { option: true }],
  demo: async ({ page, demoEngine }, use, testInfo) => {
    const recorder = new DemoRecorder(page, testInfo, demoEngine);
    await use(recorder);
    await recorder.finish();
  }
});

export { expect } from "@playwright/test";
export const _internal = { sha256 };
