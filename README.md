<div align="center">

<img src="assets/wisp.svg" width="96" alt="Wisp logo" />

# Wisp

**Discord bots, written in Wisp.**

Write slash commands and event handlers in `.wisp` files, then run them with the Wisp CLI.

[![Node.js 24.17+](https://img.shields.io/badge/Node.js-24.17%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![VS Code extension](https://img.shields.io/badge/VS_Code-Wisp_extension-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](editors/vscode-wisp/README.md)
[![Made by Silverfox0338](https://img.shields.io/badge/made%20by-Silverfox0338-FF7A45?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Silverfox0338)

### [Get started](#install-and-build)

</div>

---

## What Wisp does

- Define commands, options, buttons, menus, modals, and event handlers in readable scripts.
- Store bot data locally with SQLite and reload scripts while developing.
- Get syntax highlighting, diagnostics, and completion from the VS Code extension.

Current version: **0.0.5**. Project settings live in `wisp.json`. The TypeScript runtime uses `discord.js` for Discord operations and Node's built-in SQLite module for local persistence.

## Mascots

| Icon | Role |
| --- | --- |
| <img src="assets/wisp.svg" width="40" alt="Blue Wisp" /> | Wisp logo, commands, and other `.wisp` files |
| <img src="assets/wisp-event.svg" width="40" alt="Red Wisp" /> | Events and listeners in `events/` |
| <img src="assets/wisp-module.svg" width="40" alt="Green Wisp" /> | Reusable code in `modules/`, `helpers/`, or `utils/` |

The optional Wisp Icons theme in the VS Code extension uses these colors for `.wisp` files in those folders.

## Install and build

Requires Node.js 24.17 or newer. Install the published CLI with:

```powershell
npm install -g @silverfox0338/wisp
wisp --help
```

To build from the repository in PowerShell:

```powershell
npm ci
npm run build
npm run lint
npm test
npm link
wisp --help
```

`npm test` compiles with strict TypeScript and runs offline tests. `npm link` exposes the `wisp` command locally. `wisp version` reports the installed runtime version.

## VS Code highlighting

The [Wisp language extension](editors/vscode-wisp/README.md) recognizes `.wisp` files and colors the current language syntax. Build and package it from source, then reload VS Code:

```powershell
Set-Location .\editors\vscode-wisp
npm ci
npm test
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension .\wisp-language-0.0.7.vsix
```

The extension follows your current VS Code color theme and does not change it. It includes an optional Wisp Violet theme, a language server, manifest validation, snippets, and file icon themes. **Wisp + ASFI Seti** keeps the other file icons alongside the Wisp mascots.

## Create a bot

```powershell
wisp init my-bot
Set-Location my-bot
Copy-Item .env.example .env
```

Create a Discord application in the [Developer Portal](https://discord.com/developers/applications), add a bot, copy its token and application ID, invite it to a test guild with the `bot` and `applications.commands` scopes, and put those values plus the guild ID in `.env`. Keep `.env` private. The generated manifest uses environment references and a guild command scope.

```powershell
wisp doctor
wisp check
wisp test
wisp commands list
wisp commands diff
wisp commands sync
wisp run
```

`wisp run` loads handlers and connects to Discord. It does not register commands; sync is deliberate. Use `wisp dev` for script reload after successful validation. To remove commands previously managed by this project, run `wisp commands sync --prune --yes`. Remote commands outside the local ownership ledger are preserved. A remote command with a colliding name causes sync to stop.

`wisp test` runs `tests/*.test.wisp` offline with a fake Discord REST client and a temporary SQLite database. Use `mock.respond(method, path, result)` to queue a Discord response, `mock.fail(method, path, status, code)` for an error, `mock.run(commandName, options)` to execute a real command, `mock.runEvent(eventName, data)` to execute matching event handlers, and `assert.equal`, `assert.ok`, or `assert.called` to check the result. Existing `tests/*.test.js` files also run. For example:

```wisp
mock.respond("POST", "/channels/42/messages", {"id": "99"})
let sent = discord.send("42", "Hello")
assert.equal(sent.id, "99")
assert.called("POST", "/channels/42/messages")
let replies = mock.run("ping")
assert.equal(replies[0].content, "Pong!")
```

`wisp dev` writes an HTML and JSON execution tree for each command to `.wisp/traces/`. Reports show nested function and API calls, durations, return previews, and failure locations. `wisp test --trace` writes the same reports for offline tests. Keep traces private if script results contain sensitive data.

`wisp doctor` checks intent use, privileged intent setup, line endings, common secret-sharing folder names, and handlers that took over two seconds in recent traces. `wisp commands sync` reports how many local commands were found and registered, including the completed count if a sync stops early.

Slow interactions are acknowledged automatically. A reply keeps the visibility requested by its `ephemeral` value, even if the automatic acknowledgment used a different visibility. Gateway events run with up to 32 handlers at once; another 256 events wait in order. Further events are dropped with a warning when that queue is full. Queued events are discarded during shutdown.

## Discord API access

Wisp 0.0.5 accepts all 21 Gateway intents supported by its Discord API version. Add only the intents your bot needs to `discord.intents` in `wisp.json`. `guild_members`, `guild_presences`, and `message_content` are privileged and may require enabling or approval in the Discord Developer Portal.

Use `discord.request(method, path, body = null, query = null, reason = null, files = null)` for bot REST endpoints. The path starts after `/api/v10`, and Wisp uses the existing Discord client for rate limits. `files` is an optional list of paths inside the project for multipart uploads. For example:

```wisp
command "hello":
    description "Send a message to this channel"
    execute:
        let message = discord.request("POST", "/channels/{interaction.channelId}/messages", {"content": "Hello!"})
        reply "Sent message {message.id}"
```

For common guild operations, use `discord.channels` and `discord.roles`. IDs are strings; options are maps of Discord API fields. The optional final argument on create, edit, and delete is an audit log reason. `discord.permissions.of(...)` combines snake_case permission names into the decimal string Discord expects:

```wisp
command "setup":
    description "Create a support role and channel"
    execute:
        let read = discord.permissions.of("view_channel", "read_message_history")
        let role = discord.role(interaction.guildId, "Support", {"permissions": read})
        let channel = discord.channel(interaction.guildId, "support", {"type": 0})
        discord.channels.setPermissions(channel.id, role.id, {"allow": read, "deny": "0", "type": 0})
        discord.send(channel.id, "Support is ready")
        reply "Created {role.name} and {channel.name}"
```

For common actions, use `discord.channel(guildId, name, settings)`, `discord.role(guildId, name, settings)`, `discord.thread(channelId, name, settings)`, `discord.send(channelId, text, settings)`, `discord.react(channelId, messageId, emoji)`, `discord.addRole(guildId, userId, roleId)`, `discord.kick(guildId, userId, reason)`, and `discord.ban(guildId, userId, reason, settings)`. Optional settings and reasons follow the required IDs, name, or text. Matching `unreact`, `removeRole`, and `unban` calls undo those actions. The longer `discord.channels`, `discord.roles`, `discord.members`, `discord.messages`, `discord.reactions`, `discord.threads`, and `discord.bans` groups remain available for less common operations. All calls share Discord's REST rate limiter; see [the Discord guide](docs/discord.md).

More short calls: `discord.editMessage(channelId, messageId, text)`, `discord.deleteMessage(channelId, messageId)`, `discord.dm(userId, text)`, `discord.invite(channelId, settings)`, `discord.nick(guildId, userId, name)`, and `discord.timeout(guildId, userId, seconds)`. Use `discord.untimeout(guildId, userId)` to clear a timeout. Optional settings or audit reasons come after the required arguments.

The checked-in route catalog also backs `discord.poll(channelId, question, answers, settings)`, `discord.endPoll(channelId, messageId)`, `discord.voters(channelId, messageId, answerId)`, and `discord.audit(guildId, query)`. `discord.guild(id)` and `discord.user(id)` fetch records. `discord.pins(channelId)`, `discord.pin(channelId, messageId)`, and `discord.unpin(channelId, messageId)` use the current pin routes. The `discord.events` and `discord.automod` groups expose scheduled event and Auto Moderation operations with Discord's documented field maps. For example:

```wisp
command "lunch":
    description "Ask about lunch"
    execute:
        let poll = discord.poll(interaction.channelId, "Lunch?", ["Pizza", "Tacos"], {"duration": 48})
        reply "Poll posted: {poll.id}"
```

Every HTTP route in the local Discord reference snapshot dated October 24, 2026 has a named helper in a group such as `discord.emojis`, `discord.stickers`, `discord.webhooks`, `discord.soundboard`, `discord.guilds`, or `discord.users`. The source ZIP stays local and ignored by Git; the generated [HTTP helper index](DISCORD_HTTP_API.md) lists the 213 names and routes. The short calls above remain the easiest way to handle common bot tasks. OAuth2-only routes, voice media, SDK APIs, RPC, and webhook event receivers need credentials or protocols beyond the bot REST client.

Buttons and select menus now persist by default while their Discord message exists. Add `expires: 300` in a button or select block to expire its Wisp state after five minutes; `expires: 0` explicitly means no expiry. State is stored in SQLite, and clicks continue to reach the matching `on button` or select handler after a bot restart when the database and handler are still present. Existing controls keep their original expiration. See [interactive components](docs/components.md).

Discord REST failures explain common permission, hierarchy, argument, and rate-limit problems. They expose `error.status` (HTTP number) and `error.code` (Discord API number) inside `catch`; `error.wispCode` contains Wisp's diagnostic code, such as `DISCORD005`.

`discord.permissions.has(member, "manage_roles")`, `above(actor, role)`, and `canManageRole(actor, role)` check current permission and hierarchy snapshots. These checks are advisory because Discord may change permissions before the operation. `ui.button`, `ui.select`, `ui.modal`, and `ui.embed` build interaction payloads; `ui.rows([...])` registers persistent IDs and returns action rows for `discord.send` settings. `ui.showModal(ui.modal(...))` shows a modal inside an interaction handler. Component state remains in SQLite across restarts.

Use `on gateway "DISPATCH_NAME"` to receive a raw Gateway dispatch. The handler reads `event.type`, `event.data`, and `event.sequence`:

```wisp
on gateway "MESSAGE_REACTION_ADD":
    log.info(event.data.message_id)
```

`discord.gateway(opcode, data, shardId = 0)` sends one of Discord's bot initiated Gateway opcodes: 3 (presence), 4 (voice state), 8 (member request), 31 (soundboard request), or 43 (channel info request). The bot must be connected to that shard. discord.js retains control of identify, resume, and heartbeats.

The REST bridge supports JSON request and response bodies up to 1 MiB and at most 10 upload files of up to 25 MiB each. Voice media transport, OAuth bearer-token routes, and first-class interaction types outside Wisp's slash command and component handlers still need dedicated support. Raw interaction dispatches and callbacks can be handled through the general bridges. Discord limits each endpoint by bot permissions, installation context, intents, and API availability.

## Architecture

`src/compiler` holds lexer, parser, and AST types. `src/runtime` interprets the AST against explicit host functions and a standard library. `src/project` loads the manifest, discovers scripts, and manages reload generations. `src/discord` handles registration, responses, gateway events, and ranking. `src/storage` handles SQLite migrations and key/value storage. `src/cli` exposes the commands. `src/tests` has offline tests. Example bots are kept locally and are excluded from this repository.

The interpreter never evaluates generated JavaScript or exposes raw `discord.js` objects. It is an allowlisted runtime, not a hardened sandbox for untrusted downloaded code.

The full language and operations notes are kept locally in `docs/`.

See [the changelog](CHANGELOG.md) for release notes.

## License and attribution

Wisp was originally developed by **Silverfox0338**. Wisp's original source is licensed under [GPL-3.0-only](LICENSE); the [attribution notice](NOTICE.md) identifies the original developer. Distributed modifications must keep the GPL and original copyright notices. Third-party icon assets in the VS Code extension retain their own MIT notices.
