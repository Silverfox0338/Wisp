# Changelog

## 0.0.10

- Bots now connect with Discord's recommended number of shards, so they keep working past 2,500 servers. Existing projects need no changes. Set `discord.shards` in `wisp.json` to a number to choose the count yourself.
- Added `discord.processes` to split the shards over several processes when you run `wisp run`. It needs PostgreSQL, MySQL, or Redis storage. Timers and `on ready:` run once, in process 0, and a process that crashes is restarted. `wisp dev` always runs one process.
- Added the `shard_ready`, `shard_disconnect`, `shard_reconnecting`, and `shard_resume` events, with `event.shard`, and `event.code` for a disconnect.
- Added `bot.shards()`, which lists every shard's `id`, `status`, `ping`, and server count, and `guild.shard`, the shard a server is on.
- `discord.gateway` now picks the shard by itself when you leave out the shard ID. A presence update goes to every shard, and member, voice, soundboard, and channel requests go to the shard of their server. Before, they always went to shard 0.
- `wisp doctor` shows Discord's recommended shard count and the sessions left today, and warns when the settings would put too many servers on one shard.
- Commands and events can now live in subfolders, such as `commands/economy/daily.wisp`. Before, files in subfolders were ignored without a warning. Folders whose names start with a dot are skipped.
- Added `discord.transcript(channelId)`, which turns a channel's messages into an HTML page or, with `"format": "text"`, plain text. It returns `{name, text, format, messages}`.
- `discord.send` and the other file uploads accept `{"name": "notes.txt", "text": "..."}` maps, so a transcript or any text can be posted without saving a file.
- Added `files.write`, `files.append`, `files.read`, `files.exists`, `files.delete`, and `files.list` for text files in the project's `files/` folder (`files.directory` in `wisp.json`). Paths can't leave that folder, files are limited to 8 MiB, and scripts can't write `.wisp` files. `wisp test` gives each test file its own temporary folder, and `mock.calls()` shows uploaded files. New projects ignore `files/` in git.
- Test scripts gain `mock.shards([...])`. `bot.shards()` starts as one ready shard.
- New projects use runtime `>=0.0.10 <0.0.11`. Older projects keep working.

## VS Code extension 0.1.1

- Supports Wisp 0.0.10: the `shards`, `processes`, and `files` settings in `wisp.json`, completion for `bot`, `files`, `discord.transcript`, `guild.shard`, and the shard events, and "Status command", "Shard event", and "Ticket transcript" snippets.

## VS Code extension 0.1.0

- The extension now has its own version number. 0.1.0 supports Wisp 0.0.9.
- Fixed `Undefined name` errors in the editor when a function calls another function defined lower in the file. A call made before a function is defined, outside any function, is still reported, because it fails when the bot runs.
- Fixed a packaging mistake that left the language server out of the 0.0.9 extension.

## 0.0.9

- Added `break` and `continue` in `for` and `while` loops. `break` outside a loop is a `wisp check` error.
- Added `match value:` with `when a, b:` branches and an optional `else:`.
- Added the `%` remainder operator and the `in` / `not in` checks for list items, map keys, and text.
- Added `+=`, `-=`, `*=`, and `/=`, plus assignment to map fields and list items (`player.hp = 10`, `scores[name] += 1`). A missing map field starts at 0. Built-in values give a clear error instead of changing.
- Added `user.data` and `guild.data` for saved per-member and per-server fields, with no storage keys. `user.data.coins += 5` is atomic. Any member value, including `user` options, has `.data`.
- Added `guild.top(field, count)` leaderboards for SQLite, PostgreSQL, MySQL, and Redis. Redis keeps a sorted index, and `wisp storage migrate` rebuilds it.
- Added `reply pages:` for lists split into pages with ◀ ▶ buttons. Only the member who ran the command can turn the pages, and lists are cleaned up with their message.
- Added `roles:` menus in `reply:` so members can pick their own roles, with `pick: one` or `pick: many`.
- Added `wisp fmt` and `wisp fmt --check`. Files that would parse differently after formatting are left unchanged.
- The VS Code extension gains Format Document, "did you mean" quick fixes, go-to-definition into imported modules, and highlighting and snippets for the new syntax.
- Fixed the editor reporting `Duplicate declaration` when a variable or function had the same name as a command, or when a slash command and a context menu command shared a name. Two commands of the same type with the same name are now reported as `Duplicate command`.
- Clearer errors: `on "ready":` explains that event names are not quoted, misspelled events suggest the right name, `if x = 1:` says to use `==`, and component errors such as an expired list are shown to the member instead of an incident code.
- New projects include an `AGENTS.md` guide that tells AI coding agents what Wisp is, how to work in a project, and the Python and JavaScript habits that don't apply. The guide also ships in the npm package.
- New projects use runtime `>=0.0.9 <0.0.10`. 0.0.8 projects keep working.

## 0.0.8

- Added command cooldowns (`cooldown: 24 hours per user`, `per guild`, or `per channel`). They work on commands, subcommands, and context menus; a blocked user gets a private "Slow down!" reply, and cooldowns are kept in storage on every backend.
- `after` and `every` timers now survive restarts. Pending tasks are saved to storage and re-armed on boot, and runs missed while offline are skipped. Task names can include `{values}`, and `with {...}` passes data to the body as `task.data`. Two different timers with the same name are now a `wisp check` error. `scheduler.max_tasks` in `wisp.json` raises the 32-task limit to as many as 1,000. `wisp storage migrate` copies saved tasks.
- Test scripts gain `mock.advance`, `mock.as`, `mock.tasks`, and `mock.runTask`.
- Added subcommands and subcommand groups (`subcommand "set":`, `group "roles":`), live option suggestions through `suggest:` blocks (Discord autocomplete), and right-click `user command` and `message command` context menus with `target`. `wisp commands diff/sync` now handle nested and context menu commands, and they match commands by type and name. Test scripts gain subcommand paths in `mock.run`, plus `mock.suggest`, `mock.runUser`, and `mock.runMessage`. The editor gains completion, scopes, highlighting, and snippets for the new syntax.
- Added named PostgreSQL, MySQL, and Redis connections with `db` helpers and optional external storage for all Wisp data.
- Added explicit SQLite to external storage migration and offline database mocks.
- Made persistent component and roster operations work with asynchronous storage adapters.
- Added `http` and named `apis` for external API requests. Requests are limited to an allowlist, private networks are blocked, keys come from the environment, redirects, sizes, and timeouts are bounded, and responses can be cached. Includes offline `mock.httpRespond`, `mock.httpFail`, and `mock.httpCalls`.
- Added a `defer: public|ephemeral` command setting. Automatic deferral of slow commands is now public by default, so public replies no longer flash a placeholder, and calling `interaction.defer()` after an automatic defer no longer fails.
- Added trailing `*` wildcards to Discord and HTTP test mocks.
- Added `db` and `apis` completion in the editor, database and HTTP schema documentation, SQL and Redis and HTTP snippets, and named API status in `wisp doctor`.
- Buttons and selects without `state`, `owner`, or `expires` now carry their handler in the custom ID and store no database row. Stateful component rows are linked to their message and deleted when the message, channel, thread, or guild is deleted; rows on ephemeral messages expire after 24 hours. Components still never expire by default. Message deletion cleanup needs the `guild_messages` intent.
- Fixed storage writes that were not awaited; a rejected write could crash the bot instead of reaching `try`/`catch`.
- Fixed the Discord client error, shard error, and unhandled rejection paths that could stop the process. Host errors in logs now include their cause, and login failures explain disallowed intents or rejected tokens.
- The bot now ignores its own `message_create` and `message_update` events, preventing reply loops.
- Redis connections now reconnect with backoff and report lost and restored connections in the log.
- Imported modules now share the importing handler's step, loop, and time budget and its cancellation signal.
- Fixed maps containing a `call` key being treated as functions, a call-depth counter leak after repeated recursion errors, and unbounded memory use in `string.format`.
- Fixed `wisp storage migrate` when `--from` or `--to` is missing, and repaired icon references in the Wisp + ASFI Seti icon theme.

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
