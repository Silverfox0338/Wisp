# Changelog

## 0.0.7

- Added declarative `reply v2:` layouts with containers, explicit `markdown:` text blocks, sections, thumbnails, separators, and persistent button or select rows.
- Added declarative classic embeds and rows under `reply:` by default, with `reply v1:` as an optional explicit form. Markdown blocks preserve `#` headings while ordinary Wisp lines retain `#` comments.
- Added Discord Components V2 cards with `ui.embed2(...)`, plus text, section, thumbnail, gallery, file, separator, and container builders for computed layouts.
- Added `reply: v2:` for interaction responses and support for V2 payloads in `discord.send`, `discord.editMessage`, and `discord.messages.send/edit`.
- Validated V2 payloads, component counts, color and media values, and the separation between V2 layouts and traditional content or embeds.
- Updated project templates and runtime compatibility for 0.0.7.

## 0.0.6

- Added computed component lists and `ui.rows(...)` to `reply:`, with embeds and buttons in one response.
- Added prefix wildcard button handlers and `interaction.index` for numbered choices.
- Allowed multiline list and map literals, including trailing commas.
- Added `elif` and missing map field fallback with `??`.
- Allowed imported helper functions to reply to their caller's interaction.
- Allowed computed delays in `after` and `every` tasks.
- Replaced SVG repository and editor icons with PNG assets.

## 0.0.5

- Added visual HTML and JSON execution trees for commands in `wisp dev` and offline tests with `wisp test --trace`.
- Explained common Discord REST failures while preserving HTTP status and Discord codes.
- Improved editor completion for returned Discord objects, event fields, permissions, and UI helpers.
- Added advisory permission and role hierarchy checks.
- Added builders for persistent buttons, selects, modals, embeds, and action rows.
- Extended `.test.wisp` with mocked event execution.
- Added cancellation signals for active scheduled tasks and shutdown diagnostics.
- Expanded `wisp doctor` with privileged intent and slow trace warnings.
- Improved command sync progress, binary REST responses, and OAuth route labeling.

## 0.0.4

- Added a bot REST bridge with JSON and project-file uploads for Discord API routes, plus raw Gateway dispatch handlers.
- Added configuration for all 21 Gateway intents supported by the installed Discord API types.
- Added guarded outbound bot Gateway event support for opcodes 3, 4, 8, 31, and 43.
- Added short Discord helpers for channels, roles, messages, members, polls, and persistent components.
- Added named helpers for the 213 HTTP routes in a local Discord reference snapshot, with editor signatures and a route index.
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
