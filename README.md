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

## What you can build

- Slash commands with typed options, permissions, embeds, and replies.
- Event handlers for members, messages, buttons, selects, and modals.
- Discord REST calls through short helpers or named routes.
- Local or external database storage, reusable Wisp modules, and scheduled tasks.
- Calls to external HTTP APIs, with keys kept out of scripts.
- Offline tests with mock Discord responses and execution traces.

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
