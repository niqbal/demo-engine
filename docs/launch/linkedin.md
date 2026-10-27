# LinkedIn launch post

Every product team has the same graveyard.

Help-center videos showing last year's UI.
A sales demo that opens a menu that moved in March.
An onboarding tour recorded before the redesign.

Recording is easy now. Keeping it correct is the problem nobody solved.

So I built demo-engine.

You write a product walkthrough as a file: Playwright locators + one sentence of narration per step. Then every release, in CI:

→ it re-runs the flow in a real browser
→ diffs every frame against the last good run
→ repairs locators the redesign broke, and verifies the repair
→ re-narrates only the sentences that changed
→ re-renders the video (cursor, zoom, captions, voice)
→ posts a report on the PR, and fails the build if a demo is broken

A demo that breaks is a regression you caught before a customer did.

Open source, Apache-2.0, no API keys needed to try it.

github.com/niqbal/demo-engine

If your docs or marketing team re-records videos every quarter, I'd like to hear what breaks for you.

#opensource #playwright #devtools #productmarketing #developerexperience
