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

Current version: **0.0.4**. Project settings live in `wisp.json`. The TypeScript runtime uses `discord.js` for Discord operations and Node's built-in SQLite module for local persistence.

## Mascots

| Icon | Role |
| --- | --- |
| <img src="assets/wisp.svg" width="40" alt="Blue Wisp" /> | Wisp logo, commands, and other `.wisp` files |
| <img src="assets/wisp-event.svg" width="40" alt="Red Wisp" /> | Events and listeners in `events/` |
| <img src="assets/wisp-module.svg" width="40" alt="Green Wisp" /> | Reusable code in `modules/`, `helpers/`, or `utils/` |

The optional Wisp Icons theme in the VS Code extension uses these colors for `.wisp` files in those folders.

## Install and build

Requires Node.js 24.17 or newer. In PowerShell:

```powershell
npm ci
npm run build
npm run lint
npm test
npm link
wisp --help
```

`npm test` compiles with strict TypeScript and runs offline tests. `npm link` exposes the `wisp` command locally. The package is not published on npm; use this repository for installation. `wisp version` reports the installed runtime version.

## VS Code highlighting

The [Wisp language extension](editors/vscode-wisp/README.md) recognizes `.wisp` files and colors the current language syntax. Build and package it from source, then reload VS Code:

```powershell
Set-Location .\editors\vscode-wisp
npm ci
npm test
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension .\wisp-language-0.0.6.vsix
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
wisp commands list
wisp commands diff
wisp commands sync
wisp run
```

`wisp run` loads handlers and connects to Discord. It does not register commands; sync is deliberate. Use `wisp dev` for script reload after successful validation. To remove commands previously managed by this project, run `wisp commands sync --prune --yes`. Remote commands outside the local ownership ledger are preserved. A remote command with a colliding name causes sync to stop.

Slow interactions are acknowledged automatically. A reply keeps the visibility requested by its `ephemeral` value, even if the automatic acknowledgment used a different visibility. Gateway events run with up to 32 handlers at once; another 256 events wait in order. Further events are dropped with a warning when that queue is full. Queued events are discarded during shutdown.

## Discord API access

Wisp 0.0.4 accepts all 21 Gateway intents supported by its Discord API version. Add only the intents your bot needs to `discord.intents` in `wisp.json`. `guild_members`, `guild_presences`, and `message_content` are privileged and may require enabling or approval in the Discord Developer Portal.

Use `discord.request(method, path, body = null, query = null, reason = null, files = null)` for bot REST endpoints. The path starts after `/api/v10`, and Wisp uses the existing Discord client for rate limits. `files` is an optional list of paths inside the project for multipart uploads. For example:

```wisp
command "hello":
    description "Send a message to this channel"
    execute:
        let message = discord.request("POST", "/channels/{interaction.channelId}/messages", {content: "Hello!"})
        reply "Sent message {message.id}"
```

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
