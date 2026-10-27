# AGENTS.md

Read this before you write any Wisp code. It is for AI coding agents (Claude, Codex, Cursor, Copilot, and others) and for the people who build bots with them.

## What Wisp is

Wisp is a small scripting language for Discord bots. You write `.wisp` files, and the `wisp` CLI runs them as a bot. The CLI is built on Node.js and discord.js.

```wisp
command "ping":
    description "Check whether the bot is running"
    execute:
        reply "Pong!"
```

Wisp is meant to be easy to read and easy to write. Keep the code you write plain: short commands, clear names, and no clever tricks.

## What Wisp is not

Wisp looks a bit like Python, and that is where agents go wrong most. Every item below fails `wisp check` or `wisp test`:

| Don't write | Write this instead |
|---|---|
| Python, `discord.py`, or JavaScript code | Wisp code in `.wisp` files |
| `True`, `False`, `None` | `true`, `false`, `null` |
| `print("hi")` | `log.info("hi")`, or `reply "hi"` in a command |
| `"Coins: " + coins` | `"Coins: {coins}"` (text and numbers can't be added) |
| `f"Hi {name}"` | `"Hi {name}"` (every string can use `{...}`) |
| `else if` | `elif` |
| `if x:` when `x` might be null or a number | `if x != null:` (a condition must be `true` or `false`) |
| `n++` | `n += 1` |
| `a if cond else b` | an `if` / `else` block |
| `items.length()` | `items.length` or `len(items)` |
| `on "ready":` | `on ready:` (event names aren't quoted) |
| `if x = 1:` | `if x == 1:` |
| Tabs | 4 spaces |
| `import requests`, `require(...)`, npm packages | Built-in APIs, `http`, and local `.wisp` modules only |
| `class`, `async`, `await`, `lambda` | Plain `function`s (Wisp waits for Discord, storage, and HTTP calls by itself) |
| Tokens or API keys in a script | `${NAME}` in `wisp.json`, with the value in `.env` |

Wisp is also not BotGhost or another block builder, and it is not a hosting service. The bot runs wherever you run `wisp run`.

## How a project is laid out

`wisp init my-bot` creates:

```
my-bot/
  AGENTS.md          this guide
  wisp.json          project settings: intents, storage, command scope
  .env               DISCORD_APPLICATION_ID, DISCORD_TOKEN, DISCORD_GUILD_ID (keep private)
  main.wisp          startup code, e.g. "on ready:"
  commands/          one command per file
  events/            one event per file
  tests/             *.test.wisp files for "wisp test"
  data/              the SQLite database (don't edit by hand)
```

A file in `commands/` must hold exactly one `command`. Helper `function`s, `let`, and `import` lines can sit above it. Put shared helpers in a module, and mark what other files can use with `export function` or `export let`. Use it with `import "../utils/shop.wisp"`, then call `shop.price(...)`.

## The loop to follow

Run these from the project folder after each change:

```powershell
wisp check          # finds syntax and name errors without connecting
wisp fmt            # tidies spacing; it never changes what the code means
wisp test           # runs tests/*.test.wisp offline with fake Discord
wisp dev            # runs the bot and reloads it when files change
```

New or renamed commands only show up in Discord after `wisp commands sync`. Run `wisp commands diff` first to see what will change. `wisp doctor` explains setup problems such as a bad token or a missing intent.

Fix what `wisp check` reports before you move on. Error messages name the file, line, and often the fix ("did you mean member_join?").

## The basics

```wisp
command "daily":
    description "Collect your daily coins"
    cooldown: 24 hours per user
    execute:
        user.data.coins += 50
        reply "You have {user.data.coins} coins"
```

```wisp
command "give":
    description "Give coins to someone"
    option target:
        type: user
        required: true
    option amount:
        type: integer
        required: true
    execute:
        if options.amount <= 0:
            reply "Pick a positive amount" ephemeral: true
            return
        options.target.data.coins += options.amount
        reply "Sent {options.amount} coins to {options.target.mention}"
```

Things to know:

- **Blocks** end with `:`, and the lines inside are indented 4 more spaces.
- **Variables**: use `let name = value` the first time. After that, `name = value`, `+=`, `-=`, `*=`, `/=`.
- **Control flow**: `if` / `elif` / `else`, `for item in list`, `while`, `break`, `continue`, and `match value:` with `when "a", "b":` branches.
- **Checks**: `and`, `or`, `not`, `in`, `not in`. `value ?? fallback` swaps in `fallback` when `value` is null.
- **Errors**: `try:` with `catch error:`, and `raise "message"`.
- **Saved data**: `user.data.field` saves per member, `guild.data.field` per server, and `guild.top("coins", 10)` gives a leaderboard. A missing field reads as `null`, so write `user.data.coins ?? 0` when you need a number. Data fields are one level deep: change a saved map by saving the whole map again.
- **Replies**: `reply "text"`, `reply "text" ephemeral: true` for a private reply, and `reply:` blocks with `embed:`, `row:`, `button`, `select`, `roles:`, and `pages:`.
- **Events**: `on ready:`, `on member_join:`, `on message_create:`, and `on button "id":` for button clicks.
- **Timers**: `after "name" 10 seconds:` and `every "name" 60 seconds:`.

## When you're unsure

Don't guess at a built-in that might not exist. Look it up, in this order:

1. [The README](https://github.com/Silverfox0338/Wisp#readme) for an overview with examples
2. [The wiki](https://github.com/Silverfox0338/Wisp/wiki) for setup, the language, Discord APIs, and buttons, selects, and modals
3. [The changelog](https://github.com/Silverfox0338/Wisp/blob/main/CHANGELOG.md) for what each version added
4. `wisp help` for the CLI commands

The [VS Code extension](https://github.com/Silverfox0338/Wisp/blob/main/editors/vscode-wisp/README.md) shows errors as you type and has snippets for common blocks.

If the docs don't show a way to do something, say so to the person you're helping. Don't invent syntax. Wisp can call any Discord REST route with `discord.request(...)` and any allowed web API with `http`.

## Working on Wisp itself

This repository is also the source of the language, written in TypeScript under [src/](src/). If you are changing the language rather than writing a bot, run `npm run lint` and `npm test` before you finish. Keep new syntax easy to read and easy to write, like the rest of Wisp.
