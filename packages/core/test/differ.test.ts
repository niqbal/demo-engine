import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/differ.js";
import type { RunResult, StepResult } from "../src/runner.js";

function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = paint(x, y);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}

async function makeRun(dir: string, opts: { pixel: (x: number, y: number) => [number, number, number]; aria: string; error?: string; masks?: StepResult["masks"] }): Promise<RunResult> {
  await fs.mkdir(path.join(dir, "steps"), { recursive: true });
  await fs.writeFile(path.join(dir, "steps/01-before.png"), png(100, 60, opts.pixel));
  await fs.writeFile(path.join(dir, "steps/01-after.png"), png(100, 60, opts.pixel));
  await fs.writeFile(path.join(dir, "steps/01-aria.txt"), opts.aria);
  const step: StepResult = {
    index: 0, id: "step-01", say: "Click go", action: { kind: "click", target: { role: "button", name: "Go" } },
    resolution: { status: "found", count: 1, usedIndex: 0, description: 'role button "Go"' },
    before: "steps/01-before.png", after: "steps/01-after.png", aria: "steps/01-aria.txt", masks: opts.masks ?? [], url: "/", durationMs: 1, error: opts.error
  };
  return {
    version: 1, flowName: "t", slug: "t", flowHash: "x", runId: path.basename(dir), runDir: dir, startUrl: "/", startedAt: "", finishedAt: "",
    viewport: { width: 100, height: 60 }, scale: 1, status: opts.error ? "failed" : "passed", steps: [step]
  };
}

describe("differ", () => {
  it("classifies unchanged, cosmetic, changed and broken", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "de-diff-"));
    const white: (x: number, y: number) => [number, number, number] = () => [255, 255, 255];
    const base = await makeRun(path.join(tmp, "a"), { pixel: white, aria: '- button "Go"\n- text "Hello"' });

    const same = await makeRun(path.join(tmp, "b"), { pixel: white, aria: '- button "Go"\n- text "Hello"' });
    expect((await compareRuns(base, same, { reportDir: path.join(tmp, "r1") })).steps[0].class).toBe("unchanged");

    // 0.5% of pixels differ, same content -> cosmetic
    const cosmetic = await makeRun(path.join(tmp, "c"), { pixel: (x, y) => (y === 0 && x < 30 ? [0, 0, 0] : [255, 255, 255]), aria: '- button "Go"\n- text "Hello"' });
    expect((await compareRuns(base, cosmetic, { reportDir: path.join(tmp, "r2") })).steps[0].class).toBe("cosmetic");

    // content changed -> changed
    const changed = await makeRun(path.join(tmp, "d"), { pixel: white, aria: '- button "Go"\n- text "Goodbye"' });
    const rep = await compareRuns(base, changed, { reportDir: path.join(tmp, "r3") });
    expect(rep.steps[0].class).toBe("changed");
    expect(rep.needsRender).toBe(true);

    // big visual change under a mask -> unchanged
    const masked = await makeRun(path.join(tmp, "e"), { pixel: (x) => (x < 50 ? [0, 0, 0] : [255, 255, 255]), aria: '- button "Go"\n- text "Hello"', masks: [{ x: 0, y: 0, width: 50, height: 60 }] });
    expect((await compareRuns(base, masked, { reportDir: path.join(tmp, "r4") })).steps[0].class).toBe("unchanged");

    const broken = await makeRun(path.join(tmp, "f"), { pixel: white, aria: "", error: "target not found" });
    const rb = await compareRuns(base, broken, { reportDir: path.join(tmp, "r5") });
    expect(rb.steps[0].class).toBe("broken");
    expect(rb.broken).toBe(true);
  });
});
