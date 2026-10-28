<div align="center">

<img src="assets/wisp.png" width="96" alt="Wisp logo" />

# Wisp

**Write Discord bots in Wisp.**

A small scripting language and CLI for slash commands, events, and interactive bot features.

[![Node.js 24.17+](https://img.shields.io/badge/Node.js-24.17%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![VS Code extension](https://img.shields.io/badge/VS_Code-Wisp_extension-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](editors/vscode-wisp/README.md)
[![Made by Silverfox0338](https://img.shields.io/badge/made%20by-Silverfox0338-FF7A45?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Silverfox0338)

### [Get started](#get-started) · [Wiki](https://github.com/Silverfox0338/Wisp/wiki) · [Changelog](CHANGELOG.md)

</div>

```wisp
command "daily":
    description "Collect your daily coins"
    cooldown: 24 hours per user
    execute:
        user.data.coins += 50
        reply "You have {user.data.coins} coins"
```

Wisp reads like plain steps. It runs on Node.js 24.17 or newer, connects to Discord with `discord.js`, and saves bot data in SQLite unless you choose PostgreSQL, MySQL, or Redis.

## Get started

```powershell
npm install -g @silverfox0338/wisp
wisp init my-bot
Set-Location my-bot
Copy-Item .env.example .env
```

Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Put the application ID, bot token, and a test server ID in `.env`, and keep that file private. Invite the bot with the `bot` and `applications.commands` scopes. Then:

```powershell
wisp doctor          # checks your setup
wisp check           # finds mistakes without connecting
wisp test            # runs tests offline with fake Discord
wisp commands sync   # registers your slash commands
wisp run             # starts the bot
```

Use `wisp dev` while editing to reload scripts as you save. The [Getting started](https://github.com/Silverfox0338/Wisp/wiki/Getting-Started) guide walks through each step.

## What you can build

| Feature | Guide |
| --- | --- |
| Slash commands, subcommands, suggestions, cooldowns, and right-click commands | [Language syntax](https://github.com/Silverfox0338/Wisp/wiki/Language-Syntax) |
| Embeds, Components V2, paged lists, and role menus | [Replies and layouts](https://github.com/Silverfox0338/Wisp/wiki/Replies-and-Layouts) |
| Buttons, selects, and modals | [Interactive components](https://github.com/Silverfox0338/Wisp/wiki/Interactive-Components) |
| Saved member and server data, leaderboards, and timers that survive restarts | [Modules, storage, and tasks](https://github.com/Silverfox0338/Wisp/wiki/Modules-Storage-and-Tasks) |
| PostgreSQL, MySQL, Redis, and web APIs with keys kept out of scripts | [Databases and APIs](https://github.com/Silverfox0338/Wisp/wiki/Databases-and-APIs) |
| Ticket transcripts that look like Discord, and text files | [Files and transcripts](https://github.com/Silverfox0338/Wisp/wiki/Files-and-Transcripts) |
| Bots past 2,500 servers, with automatic sharding | [Sharding](https://github.com/Silverfox0338/Wisp/wiki/Sharding) |
| Every Discord REST route, Gateway events, and permissions | [Discord API](https://github.com/Silverfox0338/Wisp/wiki/Discord-API) |
| Offline tests with fake Discord, traces, and a formatter | [Projects and CLI](https://github.com/Silverfox0338/Wisp/wiki/Projects-and-CLI) |

Every function is listed in the [API reference](https://github.com/Silverfox0338/Wisp/wiki/API-Reference).

## A little more Wisp

Commands go in `commands/`, one per file, and events and button handlers go in `events/`:

```wisp
command "shop":
    description "Open the shop"
    execute:
        reply:
            text: "You have {user.data.coins ?? 0} coins"
            row:
                button "buy_sword":
                    label: "Buy a sword (100)"
                    style: primary
```

```wisp
on button "buy_sword":
    if (user.data.coins ?? 0) < 100:
        reply "Not enough coins" ephemeral: true
        return
    user.data.coins -= 100
    reply "{user.mention} bought a sword!"
```

## Editor and AI help

The [VS Code extension](editors/vscode-wisp/README.md) adds:
- highlighting;
- errors and warnings as you type;
- completion;
- "did you mean" fixes;
- formatting and snippets.

Every new project includes an [AGENTS.md](AGENTS.md) guide, so AI coding agents write Wisp instead of Python or JavaScript.

## Versions

Wisp 0.1 keeps a promise: every 0.1.x release works with the `wisp.json` that `wisp init` makes on 0.1.0, so updating doesn't break your bot. Older projects keep working too. The [changelog](CHANGELOG.md) lists what each release added.

## Build from source

```powershell
npm ci
npm run lint
npm test
npm link
```

`npm test` builds the TypeScript source and runs the offline test suite. `npm link` makes the local `wisp` command available on your machine.

## License

Wisp was created by **Silverfox0338** and is licensed under [GPL-3.0-only](LICENSE). See [NOTICE.md](NOTICE.md) for attribution and third-party icon notices.
