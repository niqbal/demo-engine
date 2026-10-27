import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proposeLocatorHeuristic } from "../src/heal.js";
import type { RunResult } from "../src/runner.js";

describe("heuristic healer", () => {
  it("finds a renamed button by role and word overlap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "de-heal-"));
    await fs.mkdir(path.join(dir, "steps"));
    await fs.writeFile(path.join(dir, "steps/01-aria.txt"), [
      '- heading "Team"',
      '- textbox "Email address"',
      '- button "Send invitation"',
      '- button "Cancel"',
      '- link "Billing"'
    ].join("\n"));
    const run = {
      runDir: dir,
      steps: [{ index: 0, aria: "steps/01-aria.txt", error: "target not found", resolution: { status: "missing" } }]
    } as unknown as RunResult;
    const p = await proposeLocatorHeuristic({ say: "Send the invite.", click: { role: "button", name: "Send invite" } }, run, 0);
    expect(p.locator).toMatchObject({ role: "button", name: "Send invitation" });
    expect(p.confidence).toBeGreaterThan(0.3);

    const f = await proposeLocatorHeuristic({ say: "Type the email.", fill: { target: { label: "Email" }, value: "x" } }, run, 0);
    expect(f.locator).toMatchObject({ role: "textbox", name: "Email address" });

    const none = await proposeLocatorHeuristic({ say: "Open settings.", click: { role: "link", name: "Settings" } }, run, 0);
    expect(none.confidence).toBeLessThan(0.5);
  });
});
