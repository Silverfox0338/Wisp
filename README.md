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

Wisp runs on Node.js 24.17 or newer. It uses `discord.js` to connect to Discord and stores bot data in SQLite by default. PostgreSQL, MySQL, and Redis are available as named external connections. The [VS Code extension](editors/vscode-wisp/README.md) provides highlighting, diagnostics, and completion for `.wisp` files.

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

Put each command in its own file under `commands/` and each event under `events/`. Subfolders are fine, such as `commands/economy/daily.wisp`. Wisp skips folders whose names start with a dot. Shared helpers go in modules anywhere in the project, such as `utils/shop.wisp`, and other files load them with `import`.

## What you can build

- Slash commands with typed options, permissions, embeds, and replies.
- Event handlers for members, messages, buttons, selects, and modals.
- Discord REST calls through short helpers or named routes.
- Local or external database storage, reusable Wisp modules, and scheduled tasks.
- Calls to external HTTP APIs, with keys kept out of scripts.
- Offline tests with mock Discord responses and execution traces.
- Per-member and per-server saved data, leaderboards, paged lists, and role menus.

## Language basics

Wisp reads like plain steps. Loops support `break` and `continue`. `match` picks a branch by value, and `in` checks lists, map keys, and text:

```wisp
let counts = {}
for word in options.text.split(" "):
    if word == "":
        continue
    counts[word] += 1

match options.color:
    when "red", "pink":
        reply "Warm pick!"
    when "blue":
        reply "Cool pick!"
    else:
        reply "Nice pick"
```

`+=`, `-=`, `*=`, and `/=` update a value in place, and `%` gives the remainder (`-1 % 3` is `2`). You can change map fields and list items directly, as in `player.hp = 10` or `items[0] = "sword"`. A missing map field starts at 0 when you add to it. Built-in values such as `user` and `guild` cannot be changed.

## Saved data and leaderboards

`user.data` saves fields for one member in one server. `guild.data` saves fields for the whole server. No storage keys are needed:

```wisp
command "daily":
    description "Collect your daily coins"
    cooldown: 24 hours per user
    execute:
        user.data.coins += 50
        reply "You have {user.data.coins} coins"
```

A missing field reads as `null`, so use `user.data.coins ?? 0` when you need a number. `+=` counts from 0 and is safe when many members use the command at once. Setting a field to `null` deletes it. Any member value has `.data`, including a `user` option such as `options.target.data.warnings`.

Data fields are one level deep. To change a map you saved, read it, change it, and save it again. `guild.top("coins", 10)` returns the members with the highest saved number as `{rank, id, mention, value}`. It works with SQLite, PostgreSQL, MySQL, and Redis storage.

## External databases

Add named connections to `wisp.json` and keep credentials in `.env` or environment variables:

```json
{
  "databases": {
    "main": {"engine": "postgres", "url": "${DATABASE_URL}"},
    "cache": {"engine": "redis", "url": "${REDIS_URL}"}
  },
  "storage": {"connection": "main"}
}
```

This replaces the project's `storage` object; omit the change to `storage` to keep local SQLite while using named connections. MySQL uses `"engine": "mysql"` and a `mysql://` URL. Each connection name is available under `db`:

```wisp
let result = db.main.sql("SELECT name FROM members WHERE id = ?", [user.id])
let names = result.rows
db.cache.set("member_count", 42, 300)
let count = db.cache.get("member_count")
```

`sql` runs one statement and returns `{rows, affected}`. Use `?` parameters on PostgreSQL and MySQL; write `??` for a literal PostgreSQL `?` operator. Redis supports `get`, `set`, `has`, `delete`, and `increment`; values are JSON-compatible and the optional `set` TTL is in seconds. Wisp awaits database calls automatically.

To move all existing Wisp data from SQLite, stop the bot and run `wisp storage migrate --from ./data/bot.db --to main --yes` from the project directory. The target must be empty; the source is retained. Then change `storage` to `{"connection":"main"}`. `wisp test` stays offline and provides `mock.dbRespond(connection, operation, result)` and `mock.dbCalls()` for database calls.

## External APIs

Scripts can call web APIs with `http` and `apis`. List the hosts scripts may reach under `http.allow`. Declare services that need keys under `http.apis`, so the key stays in `.env` and never appears in script values:

```json
{
  "http": {
    "allow": ["api.github.com", "*.example.org"],
    "apis": {
      "weather": {
        "base_url": "https://api.openweathermap.org/data/2.5",
        "query": {"appid": "${WEATHER_KEY}", "units": "metric"},
        "cache_seconds": 60
      }
    }
  }
}
```

```wisp
command "weather":
    description "Current weather"
    option city:
        type: string
        required: true
    execute:
        let r = apis.weather.get("/weather", {"query": {"q": options.city}})
        if r.ok:
            reply "{options.city}: {r.json.main.temp}°C"
        else:
            reply "Weather is unavailable right now ({r.status})"
```

`http.get`, `post`, `put`, `patch`, `delete`, and `request(method, url, options)` take an options map with `headers`, `query`, `json` or `body`, and `timeout_ms`. Named APIs take a path relative to `base_url`, and their configured headers and query values always win over the script's. A response is `{status, ok, headers, text, truncated, json}`. Responses outside 2xx are returned rather than raised. Blocked hosts, network failures, timeouts, and oversized responses raise `HTTP002` through `HTTP004`, which `try`/`catch` can handle.

**Safety and limits:**

- Requests use HTTPS unless a host is listed as `http://host`.
- Requests to private, loopback, and cloud metadata addresses are refused, including through DNS or redirects.
- Redirects are limited to 3. Named APIs never redirect to another origin.
- Response bodies are limited to 1 MiB and request bodies to 64 KiB.
- The default timeout is 8 seconds, and every request also stops when its command, event, or task times out.
- Headers whose names look secret (`auth`, `key`, `token`, `secret`, `password`, `cookie`) must use `${ENV}` references.

Slow commands are deferred automatically after 1.8 seconds. Add `defer: ephemeral` to a command when its eventual reply is private.

`wisp test` never touches the network. Use `mock.httpRespond("GET", "https://api.openweathermap.org/data/2.5/weather", {"json": {...}})` to queue a response; a trailing `*` matches any path suffix. `mock.httpFail(method, url)` simulates a network failure, and `mock.httpCalls()` records requests with secret headers redacted. Unmocked requests fail the test.

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

## Paged lists and role menus

`reply pages:` turns a list into an embed with ◀ ▶ buttons. Each item becomes one line:

```wisp
command "leaderboard":
    description "Show the richest members"
    execute:
        reply pages:
            items: guild.top("coins", 50)
            per_page: 10
            title: "Leaderboard"
            each row:
                "{row.rank}. {row.mention}: {row.value} coins"
```

Inside `each`, `index` counts the items from 1. Optional fields are `color`, `ephemeral`, and `empty` (the text shown when the list is empty). Only the member who ran the command can turn the pages. All the lines are worked out when the reply is sent and saved with the message, up to 16 KiB.

`roles:` adds a menu where members pick their own roles:

```wisp
reply:
    text: "Pick the pings you want"
    roles:
        "Announcements": "111111111111111111"
        "Events": "222222222222222222"
    pick: many
```

Roles a member picks are added. The menu's other roles are removed from them. Use `pick: one` to allow a single role. The bot needs **Manage Roles**, and its highest role must be above the menu roles. No handler or database row is needed.

## Sharding

Discord splits a big bot's servers into shards, each with its own connection, and refuses a shard with more than 2,500 servers. Wisp connects with Discord's recommended number of shards, so a bot keeps working as it grows. Small bots get one shard, and nothing changes for them.

Scripts can see the shards. In `commands/status.wisp`:

```wisp
command "status":
    description "Show each shard"
    execute:
        let lines = []
        for shard in bot.shards():
            lines.append("Shard {shard.id}: {shard.status}, {shard.ping} ms, {shard.guilds} servers")
        let text = lines.join("\n")
        reply "{text}\nThis server is on shard {guild.shard}"
```

And in `events/shards.wisp`:

```wisp
on shard_disconnect:
    log.warn("Shard {event.shard} dropped with code {event.code}")
```

The shard events are `shard_ready`, `shard_disconnect`, `shard_reconnecting`, and `shard_resume`. `discord.gateway` picks the right shard when you leave out the shard ID: a presence update goes to every shard, and a member request goes to its server's shard.

A very large bot can split its shards over several processes:

```json
"discord": {
  "shards": "auto",
  "processes": 4
}
```

`shards` is `"auto"` or a number. `wisp run` then starts the processes one after another and restarts any that crash. Several processes need PostgreSQL, MySQL, or Redis storage, because SQLite allows one process. Timers and `on ready:` still run once, in process 0, and `on shard_ready:` runs for each shard. `wisp dev` always runs one process. `wisp doctor` shows Discord's recommended shard count.

## Files and transcripts

`discord.transcript` turns a channel's messages into an HTML page, or plain text with `"format": "text"`. Post it as an attachment and nothing is saved on the bot's computer:

```wisp
command "close":
    description "Close this ticket and post its transcript"
    option log:
        type: channel
        required: true
    execute:
        let t = discord.transcript(interaction.channelId)
        discord.send(options.log.id, "Transcript of {t.messages} messages", {}, [t])
        reply "Ticket closed"
```

Any `{"name": "notes.txt", "text": "..."}` map can be sent the same way. To keep a copy, save it with `files.write`:

```wisp
let path = files.write("transcripts/{t.name}", t.text)
files.append("closed.txt", "{t.name}\n")
```

`files.write`, `files.append`, `files.read`, `files.exists`, `files.delete`, and `files.list` only work inside the `files/` folder. Set `files.directory` in `wisp.json` to use another folder. Paths can't leave that folder, files are limited to 8 MiB, and scripts can't write `.wisp` files. `files.write` returns a path that `discord.send` accepts. `wisp test` uses a temporary folder, so tests never touch your real files.

## Formatting and editor help

`wisp fmt` tidies every `.wisp` file in the current folder. It fixes spacing around operators and commas, removes trailing spaces, and keeps blank lines tidy. `markdown:` blocks are left exactly as written. `wisp fmt --check` changes nothing; it lists files that need formatting and exits with code 1 if any do, which is useful in CI. If formatting would change what a file means, Wisp leaves that file alone. The VS Code extension uses the same formatter for **Format Document**. It also offers "did you mean" quick fixes for misspelled names and can jump to functions in imported modules.

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
