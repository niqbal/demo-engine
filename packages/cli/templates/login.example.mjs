// Login script for authenticated flows. Reference it from a flow:
//   auth: { login: demos/login.example.mjs }
// Receives the Playwright page and context before the flow starts.
export default async function login(page, context, { baseUrl }) {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("Email").fill(process.env.DEMO_USER ?? "demo@example.com");
  await page.getByLabel("Password").fill(process.env.DEMO_PASSWORD ?? "demo-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard");
  // Optionally persist for storageState reuse:
  // await context.storageState({ path: ".auth/user.json" });
}
