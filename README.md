# occult-api-mcp

Use the [Occult API](https://occultapi.com) from Claude, Cursor, or any other
MCP-compatible assistant. Ask for a panchanga, a kundli, a dasha or any of ~420
other Vedic astrology calculations in plain language.

```
you:  What's the panchanga for Jaipur tomorrow at sunrise?
      → tithi Chaturthi (Krishna paksha), yoga Vriddhi, karana Balava
```

## Setup

You need an API key. Create one at
[occultapi.com/keys](https://occultapi.com/keys) — it is shown once, so copy it.

### Claude Code

```bash
claude mcp add occult-api -e OCCULT_API_KEY=yt_live_... -- npx -y occult-api-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` — on Windows
`%APPDATA%\Claude\`, on macOS
`~/Library/Application Support/Claude/` — then restart the app:

```json
{
  "mcpServers": {
    "occult-api": {
      "command": "npx",
      "args": ["-y", "occult-api-mcp"],
      "env": { "OCCULT_API_KEY": "yt_live_..." }
    }
  }
}
```

### Cursor

Same block, in `~/.cursor/mcp.json`.

## Tools

| Tool | Credits | What it does |
|---|---|---|
| `check_account` | 0 | Is the key valid, and how many credits are left |
| `search_endpoints` | 0 | Find a calculation by name or feature — `manglik`, `tithi`, `ashtakoota` |
| `describe_endpoint` | 0 | Exact request fields, every key, and a working example |
| `call_endpoint` | 1 | Run any endpoint |
| `get_panchanga` | 1 | Shortcut for the most-asked calculation |

Only `call_endpoint` and `get_panchanga` spend anything. **Failed requests cost
nothing** — a rejected body or a fault on our side is never charged.

There is deliberately no tool per endpoint. Every tool's schema sits in the
model's context on every message, and ninety of them would crowd out the
conversation before you had asked anything. Search and describe cover the whole
API for the price of three.

## Billing and credits

Each successful call spends one credit from your account, exactly as a direct
HTTP call would — asking for ten keys in one call still costs one, so batch
them. The balance is reported after every call, and you get a warning below 50.

Buy credits at [occultapi.com/billing](https://occultapi.com/billing).

## About your key

The key stays on your machine. It is read from the environment, sent to
the API as a header, and never shown to the assistant — the model sees
results, never the credential.

It is a server-side credential: anyone who has it can spend your credits. Do not
paste it into a shared config, a repository, or a chat message. Revoke and
rotate at [occultapi.com/keys](https://occultapi.com/keys) if you think it has
leaked.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OCCULT_API_KEY` | — | Your API key. Without it, search and describe still work; nothing runs. |
| `OCCULT_API_URL` | `https://yogataraapi.prahlad.app` | Override the API host. |

## Troubleshooting

**"Your Occult API key is invalid, revoked, or expired"** — the key was revoked
or has passed its expiry. Create a new one and update the `env` block, then
restart the app; MCP servers read their environment once at startup.

**"You are out of Occult API credits"** — top up at
[occultapi.com/billing](https://occultapi.com/billing).

**The server doesn't appear at all** — check the JSON is valid and restart the
app completely. Errors are written to the client's MCP log, not to the chat.

## Licence

MIT
