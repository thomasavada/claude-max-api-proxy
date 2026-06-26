# Claude Code CLI Provider

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This provider wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like Clawdbot, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Provider** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This provider bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (Clawdbot, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Code CLI Provider (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku
- **Session management** — Maintains conversation context
- **Auto-start service** — Optional LaunchAgent for macOS
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — Uses spawn() to prevent shell injection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/anthropics/claude-code-cli-provider.git
cd claude-code-cli-provider

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default.

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Tuning for long-running tasks

Long agentic tasks can stream for many minutes with silent "thinking" gaps. The
proxy keeps these connections healthy by (1) sending periodic SSE heartbeats so
idle sockets aren't dropped, (2) disabling Node's default HTTP timeouts, and (3)
using an **idle** timeout that only kills a subprocess after a stretch of *no
output* — an actively streaming task is never killed. These are tunable via env:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_IDLE_TIMEOUT_MS` | `300000` (5 min) | Kill the CLI only after this long with **no output**. Resets on every chunk, so active tasks run indefinitely. |
| `CLAUDE_MAX_TIMEOUT_MS` | `0` (off) | Optional absolute wall-clock cap on a single request. `0` disables it. |
| `CLAUDE_KILL_GRACE_MS` | `5000` | Grace period after `SIGTERM` before escalating to `SIGKILL` (prevents zombie CLIs). |
| `CLAUDE_SSE_HEARTBEAT_MS` | `15000` | Interval between SSE keep-alive comments during streaming. |
| `CLAUDE_CLI_BIN` | `claude` | Path/name of the Claude CLI binary to spawn. |

> The model list is fetched from the CLI **asynchronously** and served from a
> cache, so refreshing it never blocks in-flight requests.

## Available Models

| Model ID | Maps To |
|----------|---------|
| `claude-opus-4` | Claude Opus 4.5 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4` | Claude Haiku 4 |

## Configuration with Popular Tools

### Clawdbot

Clawdbot has **built-in support** for Claude CLI OAuth! Check your config:

```bash
clawdbot models status
```

If you see `anthropic:claude-cli=OAuth`, you're already using your Max subscription.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-opus-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-opus-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start on macOS

Create a LaunchAgent to start the provider automatically on login. See `docs/macos-setup.md` for detailed instructions.

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON output types
│   └── openai.ts          # OpenAI API types
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess management
├── session/
│   └── manager.ts         # Session ID mapping
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this provider
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation

## Cost Savings Example

| Usage | API Cost | With This Provider |
|-------|----------|-------------------|
| 1M input tokens/month | ~$15 | $0 (included in Max) |
| 500K output tokens/month | ~$37.50 | $0 (included in Max) |
| **Monthly Total** | **~$52.50** | **$0 extra** |

If you're already paying for Claude Max, this provider lets you use that subscription for API-style access at no additional cost.

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Built for use with [Clawdbot](https://clawd.bot)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
