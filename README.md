# Conare for Pi

Persistent, cross-session memory for the [Pi coding agent](https://pi.dev) — powered by [Conare](https://conare.ai).

Pi is deliberately minimal: four tools, a tiny system prompt, and **no built-in MCP** — you add capabilities as extensions. This is that extension. It gives Pi a memory that outlives any single session: past decisions, bug fixes, architecture, and your preferences, recalled automatically when you start work and on demand mid-task.

It's the same memory engine Conare already wires into Claude Code, Codex, Cursor, OpenCode, and Grok — so your history follows you across every agent, not just Pi.

## What you get

- **`recall`** — load relevant prior context for the task at hand.
- **`search`** — look up a specific past decision, bug, or conversation.
- **`save`** — persist a durable fact or preference for future sessions.
All three are registered as **native Pi tools** (no MCP proxy, no per-tool token tax) that the model calls when memory is relevant.

On top of the tools, each fresh session starts with your **Living Brief**: a precomputed current-state snapshot of your work (consolidated server-side every 24h), prefetched at session start and injected on your first message. It's a pure control-plane read — no LLM on the critical path — so startup stays instant and the first message waits at most 2s (usually 0).

## Install

The easiest path is the Conare CLI, which sets up the extension (and indexes your existing Pi chats into memory) in one step:

```bash
bunx conare@latest
```

Pick **Pi** when it asks which agents to connect.

### Manual install

This is a [Pi package](https://pi.dev/docs/latest/packages) — install it with Pi's own package manager:

1. Get an API key at [conare.ai](https://conare.ai).
2. Install the package:

   ```bash
   pi install npm:@conare/pi
   ```

   (`pi install git:github.com/FutureExcited/conare-pi` and `pi install ./conare-pi` work too; `pi update --all` keeps it fresh.)
3. Make sure your key is available. The extension finds it automatically from
   `~/.conare/config.json` (written by the Conare CLI), or from `CONARE_API_KEY`
   in your environment — no per-file config needed.
4. Restart Pi (or run `/reload`).

## How it works

The extension talks to Conare's memory engine over its MCP HTTP endpoint (`https://conare.ai/mcp`) using your API key — built-in `fetch`, JSON-RPC `tools/call`, handles both JSON and SSE responses.

The `recall`/`search`/`save` tools call the corresponding memory operations when the model invokes them. There is **no live-synthesis recall** on a lifecycle hook — that would put a multi-second LLM round-trip on the critical path. What IS injected automatically is the **precomputed Living Brief** (`GET /api/hook/brief`, the same SessionStart contract Conare's Claude Code and Codex hooks use): prefetched non-blocking at `session_start`, injected on the first message under a hard 2s budget, silently skipped on any failure. Tool descriptions self-update too — the server's per-tenant `tools/list` (live corpus stats) is cached to disk each session and used at the next startup.

It's one small file (its only runtime dependency is TypeBox, Pi's own schema library) — read it, fork it, audit it.

Failure handling follows Pi's contract: a genuine failure (network/HTTP/RPC error) throws, so Pi marks the tool call `isError` and the model can retry or proceed without memory. A missing key isn't an error — it returns a short "not configured, proceed without memory" note instead. Output is capped at 50KB (matching Pi's built-in tools) so a large recall never floods the context window.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CONARE_API_KEY` | — | Your Conare key (required). |
| `CONARE_URL` | `https://conare.ai` | Override for self-hosted / staging. |

## License

MIT © Conare
