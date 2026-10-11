# TODO

## Distribution

- [ ] **Publish to npm**, so the package is listed in the [pi.dev gallery](https://pi.dev/packages) (it only lists npm packages tagged `pi-package`) and installs as `pi install npm:pi-thunder-context-management`.
  - The name is free. The account needs a two-factor code to publish: `npm publish --access public --otp=<code>`.
  - Then add the npm install line to the README, next to the GitHub one.
  - Optionally add `pi.image` or `pi.video` to `package.json` for a gallery preview. A GIF of `/context` would do.
- [ ] Automate releases: a tag push runs CI, creates the GitHub release, and publishes to npm with provenance. That needs an `NPM_TOKEN` secret, a granular token that is allowed to bypass two-factor.

## Verify live

- [ ] **The compaction backstop under real pressure.** The 10-task live runs never got past the floor, so the firm nudge, the `compact` tool and the digest have only run against a scripted model. Needs a session long enough for what pruning leaves to grow past the prefix plus 40K.
- [ ] **Real subagent trees.** A coordinator spawning `pi` subprocesses, with the package installed at user scope and `PI_CONTEXT_RULES` passed down. Check that subagent results count as boundaries (`boundaryTools`) under the subagent tool's real name.
- [ ] **A multi-day coordinator,** including restarts (`--continue`) and the 1-hour cache (`coldAfterMs: 3600000`).
- [ ] Other models and providers. So far: Sonnet 5.5 through OpenRouter only. Check that dropping earlier thinking is accepted wherever thinking is signed.

## Features

- [ ] **Keep-alive pings during long idle gaps:** a cheap cache read every ~4.5 minutes while a coordinator waits. The replay puts this at 11–21% saving on its own. It needs a provider call outside the agent loop, so it may end up as a separate runner helper rather than part of this extension.
- [ ] Settings in `.pi/settings.json` (or a `/context set` command) as well as `PI_CONTEXT_RULES`.
- [ ] More boundaries, such as "tests passed" or "PR opened". Subagents commit rarely: one boundary per ~55 calls in recorded sessions, so most of their prunes are cap prunes.
- [ ] Stub a subagent report once its work has merged. Reports were 37% of what survived pruning in recorded coordinator sessions.
- [ ] Optionally log `/context` stats to the session, for after-the-fact cost analysis.
