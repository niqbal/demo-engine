import { describe, expect, it } from "vitest";
import { affectedFlows } from "../src/git.js";
import { buildManifest } from "../src/manifest.js";
import type { Flow } from "../src/schema.js";

const flow = (name: string, touches?: string[]): Flow => ({ name, url: "/", viewport: { width: 10, height: 10 }, touches, steps: [{ say: "x" }] });

describe("touches", () => {
  it("matches changed files against globs", () => {
    const res = affectedFlows(
      [
        { flow: flow("a", ["src/billing/**"]), file: "a.yaml" },
        { flow: flow("b", ["src/team/*.tsx"]), file: "b.yaml" },
        { flow: flow("c"), file: "c.yaml" }
      ],
      ["src/billing/Invoice.tsx", "README.md"]
    );
    expect(res[0].matches).toEqual(["src/billing/Invoice.tsx"]);
    expect(res[1].matches).toEqual([]);
    expect(res[2].always).toBe(true);
  });
});

describe("manifest", () => {
  it("sizes scenes from narration and adds a title", () => {
    const run = {
      runDir: "/r", viewport: { width: 1440, height: 900 }, scale: 2,
      steps: [{ index: 0, say: "x", before: "b.png", after: "a.png", action: { kind: "click" } }]
    } as never;
    const narration = { version: 1, llm: "none", tts: "silent", steps: [{ index: 0, say: "x", text: "x", audio: "/a.wav", durationMs: 4000, cached: true }] } as never;
    const m = buildManifest(flow("Demo"), run, narration, { fps: 30 });
    expect(m.scenes[0].kind).toBe("title");
    expect(m.scenes[1].durationMs).toBe(4700);
    expect(m.totalFrames).toBe(m.scenes.reduce((a, s) => a + s.frames, 0));
  });
});
