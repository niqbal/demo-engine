# X / Twitter thread

1/ Your product demo video is wrong. Not today maybe, but by the next release.

I built demo-engine: demos as code. Write the walkthrough once, and CI re-runs, diffs, heals and re-renders it every release.

Open source → github.com/niqbal/demo-engine

2/ A flow is a YAML file: Playwright locators + one sentence of narration per step. Reviewable in a PR like any other test.

3/ `demo-engine build` → run in headless Chromium → masked pixel + a11y-tree diff vs last blessed run → heal broken locators and verify → cached per-line TTS → Remotion render → markdown report on the PR.

4/ Broken demo = failed build. Your demos are now smoke tests.

5/ Three optional hooks into your codebase: `touches:` globs (only affected flows re-run), `data-demo` anchors (locators that survive copy changes), and a Playwright fixture so existing e2e tests record demos as a by-product.

6/ No keys required to try it. Apache-2.0. Would love feedback from docs, PMM and devrel folks who re-record videos every quarter.
