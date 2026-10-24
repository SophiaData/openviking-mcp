# openviking-mcp

Minimal read-only MCP server that exposes [OpenViking](https://github.com/volcengine/OpenViking) knowledge retrieval to any MCP-capable agent (DSH, Claude Code, Codex, Cursor, …).

## Why this exists

OpenViking ships an official DSH plugin that adds automatic session capture and context injection. This project deliberately does *none* of that:

- **Read-only.** There is no tool that can add, edit or delete OpenViking content. An agent cannot promote conversation into "knowledge" on its own.
- **No capture.** Nothing is written back to the server by this process.
- **No bundled memory lifetime.** Session capture, context injection and skill syncing stay opt-in and outside this server.
- **stdio only.** Works with every MCP client; no HTTP listener to secure.

Use the official plugin if you want automatic memory. Use this if you want an agent that can *look things up* and nothing more.

## Tools

| Tool | Purpose |
|---|---|
| `ov_search` | Semantic search. Returns URI, score, level and summary for each hit. |
| `ov_read` | Read one document's full text (L2) by `viking://` URI. |
| `ov_overview` | Browse a directory with its generated abstracts (L0/L1). |

All three are annotated read-only and idempotent.

## Install

```bash
npm install -g @sophiadata/openviking-mcp
```

Not published to npm yet — install from the repository for now:

```bash
git clone https://github.com/SophiaData/openviking-mcp.git
node openviking-mcp/src/server.mjs
```

Or run from a checkout without installing:

```bash
node /path/to/openviking-mcp/src/server.mjs
```

## Configure

Environment only — nothing is read from or written to a config file:

| Variable | Default | Meaning |
|---|---|---|
| `OPENVIKING_URL` | `http://127.0.0.1:1933` | OpenViking server base URL |
| `OPENVIKING_API_KEY` | *(empty)* | Sent as `X-API-Key` when set; leave empty for loopback `dev` auth |
| `OPENVIKING_TIMEOUT_MS` | `30000` | Per-request timeout |

## Client registration

### DSH

Add to the profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: openviking-knowledge
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "openviking"
        transport: "stdio"
        command: "node"
        args: [ "E:/dev-day/openviking-mcp/src/server.mjs" ]
        env:
          OPENVIKING_URL: "http://127.0.0.1:1933"
        failOnStartupError: false
```

### Claude Code

```bash
claude mcp add openviking --scope user -- node /path/to/openviking-mcp/src/server.mjs
```

### Codex

```toml
# ~/.codex/config.toml
[mcp_servers.openviking]
command = "node"
args = ["/path/to/openviking-mcp/src/server.mjs"]
env = { OPENVIKING_URL = "http://127.0.0.1:1933" }
```

## Verify

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ov_search","arguments":{"query":"partition filter"}}}' \
  | node src/server.mjs
```

You should see three tool definitions and a search result block. If the server is down, the tool returns an explicit error instead of an empty list.

## Limitations

- Read-only by design; write tools are intentionally absent.
- Requires a running OpenViking server with imported resources. An empty store returns "No results".
- `ov_read` returns at most 20,000 characters; use OpenViking's own pagination for longer documents.
- Tested against OpenViking 0.5.2.

## License

MIT
