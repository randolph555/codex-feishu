# Repository Guidelines

## Project Structure & Module Organization

- `bin/codex-feishu.js` is the executable entrypoint.
- `src/cli.js` dispatches CLI commands.
- `src/commands/` contains user-facing command handlers such as `daemon`, `init`, `doctor`, `qrcode`, `down`, and `uninstall`.
- `src/lib/` contains reusable runtime pieces: Feishu transport, daemon control, app-server integration, state handling, and config helpers.
- `docs/` stores architecture and setup documentation; `docs/assets/` contains screenshots.
- Runtime data is written outside the repo under `~/.codex-feishu/` and `~/.codex/`.

## Build, Test, and Development Commands

- `npm install` — install local dependencies.
- `node bin/codex-feishu.js help` — list supported CLI commands.
- `node bin/codex-feishu.js daemon` — start the bridge in the foreground.
- `node bin/codex-feishu.js doctor` — verify local Codex, config, and daemon readiness.
- `node bin/codex-feishu.js down` — stop the local daemon.
- `node bin/codex-feishu.js uninstall` — stop the daemon and remove managed bridge config.
- `node --check src/commands/daemon.js` — quick syntax validation for edited files.

## Coding Style & Naming Conventions

- Use ES modules and Node 20+ compatible JavaScript.
- Follow the existing style: 2-space indentation, semicolons, double quotes, and small focused helpers.
- Use `snake_case` for some library filenames already established in the repo (for example `app_server_client.js`), and keep new filenames consistent with nearby files.
- Prefer descriptive identifiers over abbreviations; avoid one-letter names.
- Reuse shared helpers in `src/lib/` instead of duplicating protocol or config logic.

## Testing Guidelines

- There is no formal automated test suite yet.
- Validate changes with targeted syntax checks (`node --check ...`) and focused runtime checks such as `doctor`, daemon startup, and local RPC health.
- For bridge changes, prefer manual end-to-end verification with one terminal session and one Feishu chat before broader testing.

## Commit & Pull Request Guidelines

- Follow the existing Conventional Commit style seen in history, e.g. `fix(windows): ...`, `perf(feishu): ...`, `chore: ...`.
- Keep commits scoped to one concern.
- Pull requests should include: a short problem statement, the behavioral change, validation performed, and screenshots/log snippets for Feishu UX changes when relevant.

## Architecture Notes

- Keep Codex as the source of truth; avoid patching Codex core.
- Prefer Codex `app-server` capabilities over bridge-local orchestration whenever possible.
- Treat Feishu as a transport/UI layer, not a second session manager.
