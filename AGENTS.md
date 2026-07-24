# AGENTS.md

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the T3 Code in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## Apna Tasks (this fork)

Everything above is inherited from upstream `pingdotgg/t3code` and still applies. This repository is **Apna Tasks**, Kota's fork: a local-first, markdown-native productivity and agent workbench. App identity: display name "Apna Tasks", bundle id `com.apnatasks.desktop`, url scheme `apnatasks://`, home dir `~/.apnatasks`.

- Remotes: `origin` = south-kota/apna-tasks; `upstream` = pingdotgg/t3code (fetch-only, push disabled). Keep diffs small and additive so upstream stays mergeable — prefer new packages/files over editing upstream code.
- Plan, workstream briefs, and agent-task conventions live in `~/Documents/Life/Apna Tasks/` (start with `PLAN.md`). Workstream working notes go in `~/Documents/Life/Apna Tasks/notes/` as markdown.
- Data model: JBOM (`~/Documents/Life/JBOM/spec/`) — markdown + YAML frontmatter is canonical; databases are rebuildable projections.
- The editor package to embed is `@mark/editor` from `~/Documents/Life/Mark` — do not build a new markdown editor.
- Setup: `vp install`, then `bun run dev:desktop`. Baseline fork commit: `ebe8afb1d` (upstream main, 2026-07-18).

## Process & System Safety (mandatory for all agents)

Standing constraints from the 2026-07-18 process-kill incident (`~/Documents/Life/Apna Tasks/notes/incident-2026-07-18-process-kill.md`), where a `process.kill(-pid)` finalizer executed by tests with a mock pid of 1 ran `kill(-1, SIGTERM)` and terminated every process on Kota's Mac:

1. **Never launch GUI apps (Electron, the desktop app, browsers) as agent background tasks.** When Kota wants the desktop app, they run `bun run dev:desktop` in their own terminal; Ctrl+C there tears the tree down correctly.
2. **Never use `pkill`/`killall`/pattern-based kills.** Terminations target exact PIDs from a `ps` inventory Kota has seen in the conversation.
3. **Never signal negative, computed, or group PIDs without a guard.** Any `process.kill`-style call on a derived value requires `Number.isInteger(pid) && pid > 1` first — in scripts, in app code, and in tests (mock pids must be realistic, never `0`/`1`).
4. **Describe any process- or system-state-changing action to Kota before running it** (kills, restarts, moving state dirs, config changes).
