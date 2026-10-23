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

Current version: **0.0.3**. Project settings live in `wisp.json`. The TypeScript runtime uses `discord.js` for Discord operations and Node's built-in SQLite module for local persistence.

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
code --install-extension .\wisp-language-0.0.3.vsix
```

The extension follows your current VS Code color theme and does not change it. It includes an optional Wisp Violet theme, a language server, manifest validation, snippets, and a file icon theme.

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

## Architecture

`src/compiler` holds lexer, parser, and AST types. `src/runtime` interprets the AST against explicit host functions and a standard library. `src/project` loads the manifest, discovers scripts, and manages reload generations. `src/discord` handles registration, responses, gateway events, and ranking. `src/storage` handles SQLite migrations and key/value storage. `src/cli` exposes the commands. `src/tests` has offline tests. Example bots are kept locally and are excluded from this repository.

The interpreter never evaluates generated JavaScript or exposes raw `discord.js` objects. It is an allowlisted runtime, not a hardened sandbox for untrusted downloaded code.

The full language and operations notes are kept locally in `docs/`.

See [the changelog](CHANGELOG.md) for release notes.
