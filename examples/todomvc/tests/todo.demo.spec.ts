// Turn an existing Playwright test into a narrated demo with the `demo` fixture.
// Run normally:        npx playwright test
// Record a demo too:   DEMO_ENGINE=1 npx playwright test
// Then:                npx demo-engine render .demo-engine/runs/<slug>/<run-id>
import { test, expect } from "@demo-engine/playwright";

test.use({ demoEngine: { out: ".demo-engine", description: "Recorded straight from the e2e suite." } });

test("Quick add from the e2e suite", async ({ page, demo }) => {
  await page.goto("https://demo.playwright.dev/todomvc/");
  const input = page.getByPlaceholder("What needs to be done?");

  await demo.step("Type a task and press Enter.", { target: input }, async () => {
    await input.fill("Ship demo-engine");
    await input.press("Enter");
  });
  await expect(page.getByText("Ship demo-engine")).toBeVisible();

  const check = page.getByRole("checkbox", { name: "Toggle Todo" }).first();
  await demo.step("Tick it off when it's done.", { target: check, zoom: 1.5 }, async () => {
    await check.check();
  });
  await expect(page.getByText("0 items left")).toBeVisible();
});
