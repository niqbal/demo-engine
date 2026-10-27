<p align="center">
  <img src="https://raw.githubusercontent.com/niqbal/demo-engine/main/docs/assets/poster.png" alt="demo-engine render" width="720">
</p>

<h1 align="center">demo-engine</h1>

<p align="center"><strong>Demos as code.</strong> Record a product walkthrough once. Every release it re-runs, detects what changed, repairs itself, and re-renders the narrated video.<br>Your demo never goes stale.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/demo-engine"><img src="https://img.shields.io/npm/v/demo-engine?color=4F46E5" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a>
  <a href="https://github.com/niqbal/demo-engine/actions"><img src="https://github.com/niqbal/demo-engine/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
</p>

---

Every SaaS has a help-center graveyard: videos showing last year's UI. Loom, Guidde and Clueso make the first recording easy. Nobody re-records forty videos every sprint.

demo-engine treats a demo like a test:

```yaml
# demos/invite-teammate.flow.yaml
name: Invite a teammate
url: ${BASE_URL}/settings/team
touches: ["src/settings/team/**"]
steps:
  - say: Open Team settings from the sidebar.
    click: { role: link, name: Team }
  - say: Click Invite and enter your teammate's email.
    click: { role: button, name: Invite member }
  - say: Pick a role. Admins can manage billing.
    select: { target: { label: Role }, option: Admin }
    zoom: { scale: 1.6 }
  - say: Send the invite. They'll get an email within a minute.
    click: { role: button, name: Send invite }
    expect: { text: Invite sent }
```

```bash
npx demo-engine build demos --base-url https://staging.example.com
```

That one command:

1. **Runs** the flow in headless Chromium and captures a crisp 2× frame before and after every step.
2. **Diffs** against the last blessed run: locator resolution, masked pixel diff, accessibility-tree text diff. Each step is `unchanged`, `cosmetic`, `changed` or `broken`.
3. **Heals** broken locators (an LLM if you have a key, an offline heuristic matcher if not), re-runs to verify, and keeps the old locator as a fallback.
4. **Narrates** each step (LLM-polished script, cached per line, any TTS) so unchanged lines never regenerate and the voice never drifts.
5. **Renders** an MP4 with Remotion: synthesized cursor, click ripple, zoom, captions, voice-over. Unchanged flows keep their video.
6. **Reports** a markdown table your CI posts on the PR, and exits non-zero when a flow is broken. Your demos are now smoke tests.

## Quick start

```bash
npm i -D demo-engine
npx playwright install chromium
npx demo-engine init --base-url http://localhost:3000   # demos/, config, GitHub workflow
npx demo-engine build demos                              # run → diff → heal → narrate → render
open .demo-engine/renders/example-walkthrough/example-walkthrough.mp4
```

No API keys required. Without keys, healing uses the heuristic matcher and narration reads your `say` lines with a local voice: [Kokoro](https://github.com/hexgrad/kokoro) (neural, open weights, `pip install kokoro soundfile`) if it is installed, otherwise the macOS system voice, otherwise silence. Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for polished scripts and smarter heals, `ELEVENLABS_API_KEY` for a production voice.

Try the bundled example (public TodoMVC, no app to start):

```bash
git clone https://github.com/niqbal/demo-engine && cd demo-engine
npm ci --legacy-peer-deps && npm run build && npx playwright install chromium
cd examples/todomvc && node ../../packages/cli/dist/index.js build demos
```

## Three ways to plug into your codebase

None of them is required. Each one gives the engine more visibility into what changed.

| Level | What you add | What you get |
|---|---|---|
| **0 · Nothing** | Flow files anywhere, a URL | Run, diff, heal, render. Works against any site you can reach. |
| **1 · Demos in the repo** | `demos/*.flow.yaml` with `touches:` globs, the GitHub Action | `build --since origin/main` knows which flows a PR affects and lists the touching files in the report. Healed locators come back as a diff you review. |
| **2 · Anchors** | `data-demo="invite-button"` on a few stable elements, `anchor: invite-button` in flows | Locators that survive copy changes and redesigns. `demo-engine anchors --src src` fails CI when a flow references an anchor the source no longer has. |
| **3 · Existing tests** | `import { test } from "@demo-engine/playwright"` and wrap actions in `demo.step("…")` | Your e2e suite records demos as a by-product. `DEMO_ENGINE=1 npx playwright test`, then `demo-engine render <run-dir>`. |

```ts
// Level 3: an existing Playwright test, narrated.
import { test, expect } from "@demo-engine/playwright";

test("Invite a teammate", async ({ page, demo }) => {
  await page.goto("/settings/team");
  const invite = page.getByRole("button", { name: "Invite member" });
  await demo.step("Click Invite and enter an email.", { target: invite }, async () => {
    await invite.click();
    await page.getByLabel("Email").fill("sam@example.com");
  });
});
```

## CI

`demo-engine init` writes `.github/workflows/demos.yml`. The composite action installs the CLI and Chromium, runs `build`, uploads renders as an artifact, and posts (or updates) one PR comment:

```yaml
- uses: niqbal/demo-engine@v0
  with:
    base-url: ${{ vars.DEMO_BASE_URL }}
    since: ${{ github.event.pull_request.base.sha }}
    comment: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Report on a PR that renamed a button:

| flow | status | video | notes |
|------|--------|-------|-------|
| Invite a teammate | ✏️ passed | `.demo-engine/renders/invite-a-teammate/invite-a-teammate.mp4` | 1 changed, 3 unchanged · 1/1 locators healed · 2 touching files changed |

## Flow reference

| key | meaning |
|---|---|
| `name`, `description` | Title card. `name` also becomes the slug for output paths. |
| `url` | Start URL. `${BASE_URL}` is substituted; relative paths are joined to `--base-url`. |
| `auth.storageState` | Playwright storage state file (cookies, local storage). |
| `auth.login` | A `.mjs` file exporting `async (page, context, { baseUrl })` that signs in before the flow. |
| `touches` | Globs over your repo. Changed files matching them mark the flow as affected. |
| `setup` | Shell command run before the flow (seed a demo tenant). `BASE_URL` is in the env. |
| `mask` | CSS selectors ignored by the visual diff (clocks, avatars). |
| `viewport`, `voice` | Default 1440×900 at 2×. Voice is provider-specific. |

Each **step** has `say` plus at most one action: `goto`, `click`, `dblclick`, `hover`, `fill`, `type`, `select`, `check`, `press`, `scroll`, `wait`. Optional: `expect` (`text`, `visible`, `hidden`, `url`), `zoom`, `mask`, `pause`, `highlight`. `fill`/`type` accept a `press` to hit Enter afterwards.

**Locators** are user-facing first: `{ role, name }`, `{ label }`, `{ placeholder }`, `{ text }`, `{ testid }`, `{ anchor }` (`data-demo`), `{ css }` or a bare CSS string. Any locator can carry `fallbacks: [...]`. `nth` disambiguates.

## CLI

| command | what it does |
|---|---|
| `init` | Scaffold `demos/`, config and workflow. |
| `build [targets]` | The pipeline. `--since <ref>`, `--only-affected`, `--no-heal`, `--write-heals`, `--bless`, `--no-render`, `--no-narrate`, `--verbatim`, `--force`, `--report <dir>`. |
| `run` / `diff` / `heal` / `narrate` / `render` / `bless` | Each stage on its own. |
| `changed --since <ref>` | Which flows a change affects, by `touches`. |
| `anchors --src <dir>` | Anchors referenced by flows but missing from the source. |
| `doctor` | Browser, providers, keys. |

Targets are flow files, directories of `*.flow.yaml`, or run directories recorded by the Playwright fixture.

## How it keeps videos correct

- **Deterministic frames.** Fixed viewport, animations disabled, fonts awaited, UTC, 2× screenshots. Two runs of an unchanged app diff to zero.
- **Real interaction, not a slideshow.** Typing is captured character by character, hover states are captured before each click, and the cursor, click ripple and zoom are synthesized at render time so they are always smooth.
- **Selective regeneration.** Narration is cached per line by text+voice; frames per step. A copy change in step 3 re-synthesizes one sentence and re-renders one scene's worth of pixels.
- **Human-approved heals.** The engine proposes, verifies by re-running, and writes the repair only with `--write-heals`. In CI, pair that with a PR-creating step so a reviewer sees the diff.
- **Masks, not luck.** Volatile regions are declared, so the diff is quiet by design.

## Providers

| | options | pick with |
|---|---|---|
| LLM (script polish, heal) | Anthropic, OpenAI, none | `llm:` in config or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| TTS | ElevenLabs, OpenAI, Kokoro (local neural), macOS `say`, silent | `tts:` in config or the matching key. Kokoro: `pip install kokoro soundfile`, optional `KOKORO_VOICE` (default `af_heart`) |
| Render | Remotion (bundled Chrome Headless Shell) | nothing to configure |

Remotion is free for individuals and teams of up to three; larger companies need a [Remotion company license](https://www.remotion.dev/docs/license).

## Status

Early. The pipeline is complete and tested end to end on the bundled example; what it needs now is your app. Open an issue with a flow that misbehaves and a run directory, and it gets fixed.

Roadmap: hosted player with analytics, Chrome-extension recorder, interactive HTML output from the same manifest, Slack alerts.

## License

Apache-2.0. Commercial use welcome.
