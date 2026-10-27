# Show HN draft

**Title (80 chars max):**
Show HN: demo-engine – product demo videos as code, re-rendered on every release

**Text:**

Every SaaS I've worked at (Box, DoorDash, Sendoso) had a help-center graveyard: walkthrough videos showing a UI from three redesigns ago. Loom/Guidde make the first recording easy; nobody re-records forty videos every sprint.

demo-engine treats a demo like an e2e test. You write a flow.yaml: user-facing Playwright locators plus one sentence of narration per step. `demo-engine build` runs it in headless Chromium, captures a 2× frame per step, diffs against the last blessed run (locator resolution + masked pixel diff + accessibility-tree text diff), repairs broken locators (LLM if you have a key, an offline matcher if not) and re-runs to verify, narrates with cached per-line TTS so the voice doesn't drift, and renders an MP4 with Remotion (synthesized cursor, click ripple, zoom, captions). Unchanged flows keep their video. A markdown report lands on the PR and broken flows fail CI.

Three optional integration levels: `touches:` globs so a PR only re-runs affected flows, `data-demo` anchors for locators that survive copy changes, and a `@demo-engine/playwright` fixture so an existing test records a demo as a by-product.

No API keys needed to try it (macOS voice + heuristic healer). Apache-2.0.

Repo: https://github.com/niqbal/demo-engine
Example render (TodoMVC, zero config): in the README.

Things I'm unsure about and would love input on: the right cadence (every PR vs release tags), whether teams want interactive HTML output from the same manifest, and how you handle SSO in staging for anything like this.
