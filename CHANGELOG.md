# Changelog

## 0.0.4

- Added a bot REST bridge with JSON and project-file uploads for Discord API routes, plus raw Gateway dispatch handlers.
- Added configuration for all 21 Gateway intents supported by the installed Discord API types.
- Added guarded outbound bot Gateway event support for opcodes 3, 4, 8, 31, and 43.
- Added short Discord helpers for channels, roles, messages, members, polls, and persistent components.
- Added named helpers for the 213 HTTP routes in the bundled Discord reference, with editor signatures and a route index.
- Added structured Discord errors, SQLite failure details, and named permission flags.
- Updated editor completion, manifest schema, and new project templates for 0.0.4.


## 0.0.3

- Added namespaced local Wisp modules with explicit exports, circular-import detection, and root path protection.
- Added local package add/list/remove with version and SHA-256 integrity verification.
- Added declarative buttons, select menus, modals, persistent component state, owner and guild checks, and expiration.
- Added bounded delayed and recurring tasks, cancellation, and hot-reload cleanup.
- Added source-aware runtime call frames, per-command timeout metadata, verbose validation, and debug timing logs.
- Added a parser-backed language server, manifest schema, optional Violet theme, snippets, and icon theme to the VS Code extension.
- Built local poll and utility examples; kept the join-history bot and v0.0.2 manifest compatibility.


## 0.0.2

- Added `while`, user-defined functions, `return`, invocation-global assignment, `len`, expanded host APIs, and null fallback with `or`.
- Added role/channel options, named command permissions, richer embed validation, explicit defer and follow-up actions, and message events.
- Added SQLite `has` and atomic `increment`, ranking page/filter APIs, concurrent fetch coalescing, and complete-scan invalidation.
- Expanded `doctor`, added `version` and a lint command, improved runtime diagnostics, tests, and documentation.
- Updated the join-history example with pages, bot filtering, join timestamps, and historical limitations.

### Breaking migration

Projects created before `0.0.2` must set manifest `version` to `0.0.2` and `runtime` to `>=0.0.2 <0.0.3`. Command syntax and SQLite schema 1 remain compatible. `or` now accepts null fallback in addition to boolean OR; use `??` for a strictly null-only fallback.
