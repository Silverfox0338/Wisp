<div align="center">

<img src="assets/wisp.png" width="96" alt="Wisp logo" />

# Wisp

**Write Discord bots in Wisp.**

A scripting language and CLI for slash commands, events, and interactive bot features.

[![Node.js 24.17+](https://img.shields.io/badge/Node.js-24.17%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![VS Code extension](https://img.shields.io/badge/VS_Code-Wisp_extension-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](editors/vscode-wisp/README.md)
[![Made by Silverfox0338](https://img.shields.io/badge/made%20by-Silverfox0338-FF7A45?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Silverfox0338)

### [Get started](#get-started)

</div>

```wisp
command "ping":
    description "Check whether the bot is running"
    execute:
        reply "Pong!"
```

Wisp runs on Node.js 24.17 or newer. It uses `discord.js` to connect to Discord and SQLite to store bot data locally. The [VS Code extension](editors/vscode-wisp/README.md) provides highlighting, diagnostics, and completion for `.wisp` files.

## Get started

Install the CLI and create a project:

```powershell
npm install -g @silverfox0338/wisp
wisp init my-bot
Set-Location my-bot
Copy-Item .env.example .env
```

Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Put the application ID, bot token, and a test server ID in `.env`. Invite the bot with the `bot` and `applications.commands` scopes. Keep `.env` private.

```powershell
wisp doctor
wisp check
wisp test
wisp commands diff
wisp commands sync
wisp run
```

`wisp commands sync` registers your slash commands. `wisp run` connects the bot but does not change remote commands. Use `wisp dev` while editing to reload valid scripts. More detail is in the [wiki](https://github.com/Silverfox0338/Wisp/wiki).

## What you can build

- Slash commands with typed options, permissions, embeds, and replies.
- Event handlers for members, messages, buttons, selects, and modals.
- Discord REST calls through short helpers or named routes.
- Local data with SQLite, reusable Wisp modules, and scheduled tasks.
- Offline tests with mock Discord responses and execution traces.

## Discord embed 2.0

Discord calls its newer embed-like layouts **Components V2**. Wisp supports them directly in command replies:

```wisp
reply v2:
    container:
        accent: "#8B5CF6"
        markdown:
            ## Welcome
            Choose what to do next, {user.name}!
        separator
        section:
            text: "Status: Ready"
            thumbnail: user.avatar
        row:
            button "start":
                label: "Start"
                style: primary
```

`markdown:` explicitly starts an unquoted Markdown block. Inside it, `#` is a heading and `{...}` interpolates Wisp values. Elsewhere, `#` starts a Wisp comment. `text: "..."` accepts a quoted string or expression. Rows use Wisp's persistent button and select handlers.

Classic embeds use the same declarative style without a version label. `reply v1:` is an optional explicit spelling:

```wisp
reply:
    embed:
        title: "Welcome"
        color: "#8B5CF6"
        markdown:
            ## Hello, {user.name}!
            Your account is ready.
    row:
        button "start":
            label: "Start"
            style: primary
```

Classic replies support content, one embed, and action rows. Containers, sections, thumbnails beside text, galleries, and separators require `reply v2:`. For computed layouts or channel messages, use `ui.embed2(...)`, `ui.v2(...)`, and the lower level UI builders with `discord.send(channelId, payload)` or `discord.messages.send(channelId, payload)`. File displays use `attachment://filename` and the corresponding upload through `discord.messages.send(..., files)`.

V2 messages use components instead of the traditional `content` and `embeds` fields. The `IS_COMPONENTS_V2` flag stays on a message after creation, including when editing it. See [Discord's component reference](https://docs.discord.com/developers/components/reference) for layout details.

## Documentation

The [wiki](https://github.com/Silverfox0338/Wisp/wiki) covers setup, project configuration, the language, Discord APIs, and interactive components. The [VS Code extension guide](editors/vscode-wisp/README.md) covers editor setup, and the [changelog](CHANGELOG.md) records release changes.

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
