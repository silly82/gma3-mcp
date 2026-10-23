# HTTP API

[README](../README.md) · [Tool reference](reference.md) · [Remote access](remote-access.md)

A local HTTP API next to MCP for clients that do not speak MCP: Home Assistant, Node-RED, shell scripts, a phone app.
It serves the same tool handlers as MCP, so every tool keeps its validation, its checks before acting, its read-back
and its refusals (`exclusive: true` is still required where the tool requires it). Source: `src/http.ts`; tests:
`test/http-api.test.ts`.

## Start

| Variable | Meaning |
| --- | --- |
| `GMA3_HTTP_PORT` | Starts the API on this port (e.g. `8780`). Unset: no API |
| `GMA3_HTTP_TOKEN` | Required secret, at least 16 characters. Every request sends `Authorization: Bearer <token>` |
| `GMA3_HTTP_HOST` | Bind address, default `127.0.0.1`. Anything else needs `GMA3_HTTP_ALLOW_NETWORK=1` |
| `GMA3_HTTP_ALLOW_NETWORK` | `1` allows a non-loopback bind. The token travels in plain HTTP: use it only on a trusted network, or put a TLS proxy (Tailscale Serve, Caddy) in front |
| `GMA3_HTTP_TOOLS` | Comma-separated tool names to serve. Default `*`: every tool except `gma3_lua`; `gma3_lua` is served only when it is named |
| `GMA3_HTTP_EVENTS_MS` | Poll interval of the events stream, 250-60000 ms (default 1000) |
| `GMA3_TRANSPORT` | `http` runs the API alone, without MCP on stdio: a standalone service |

With MCP on stdio, a bad HTTP setting is logged and MCP starts anyway; with `GMA3_TRANSPORT=http` it is fatal.

Standalone service on the onPC computer:

```sh
GMA3_TRANSPORT=http GMA3_HTTP_PORT=8780 GMA3_HTTP_TOKEN="$(openssl rand -hex 24)" node dist/index.js
```

Each process has its own mutation lock: an HTTP service and an MCP client running at the same time are not
serialised against each other (as with any two clients of the bridge).

## Endpoints

| Request | Answer |
| --- | --- |
| `GET /api/status` | `{ bridge: { connected, show, bridgeVersion, instance, user } }` (or `connected: false` and the error) |
| `GET /api/tools` | `{ count, tools: [{ name, title, description, parameters }] }`: the tools this API serves |
| `POST /api/tools/<name>` | The body is the tool's arguments as a JSON object (empty body: `{}`). 200 with `{ isError, result }`: `result` is the tool's JSON result (the same text MCP returns), `isError` the MCP error flag |
| `GET /api/events` | `text/event-stream`: an `event: state` with `data: { bridge, executors }` at once and on every change. `executors`: the assigned executors of the current page (`number`, `name`, `fader`, `active`, `cue`) |

Errors before a tool runs: 401 (token), 400 (body not a JSON object, or the tool's input validation), 403 (not served:
`GMA3_HTTP_TOOLS`), 404 (no such tool or path), 405 (not POST). A tool that refuses or fails answers 200 with
`isError: true` and its full result, as MCP does.

Browsers' `EventSource` cannot set headers: `/api/events?token=<token>` (and every other path) also accepts the token
as a query parameter. It then appears in logs and history: prefer the header where the client allows it.

## Examples

```sh
T=…; H="Authorization: Bearer $T"
curl -s -H "$H" localhost:8780/api/status
curl -s -H "$H" -d '{}' localhost:8780/api/tools/gma3_sequences
curl -s -H "$H" -d '{"command":"Go+ Sequence 5"}' localhost:8780/api/tools/gma3_command
curl -s -H "$H" -d '{"name":"saisonstart","unsaved":"refuse","exclusive":true}' localhost:8780/api/tools/gma3_load_show
curl -sN -H "$H" localhost:8780/api/events
```

Home Assistant (`configuration.yaml`; the token in `secrets.yaml`):

```yaml
rest_command:
  ma_go_sequence:
    url: "http://<host>:8780/api/tools/gma3_command"
    method: POST
    headers: { Authorization: !secret ma_bearer }
    content_type: application/json
    payload: '{"command":"Go+ Sequence {{ sequence }}"}'

rest:
  - resource: "http://<host>:8780/api/status"
    headers: { Authorization: !secret ma_bearer }
    scan_interval: 10
    sensor:
      - name: "grandMA3 show"
        value_template: "{{ value_json.bridge.show }}"
```

Node-RED: an `http request` node (POST, JSON body, the `Authorization` header in `msg.headers`) per tool, and an SSE
client node on `/api/events` for live state.

## Limits

- The events stream polls (one `ping` and one `gma3_executors` per interval, shared by all listeners, only while
  someone listens). Push from the bridge is a planned extension.
- The API does not add checks of its own beyond the token and the allowlist: what a tool allows over MCP, it allows
  over HTTP. Restrict `GMA3_HTTP_TOOLS` for an automation that only needs a few tools (e.g.
  `gma3_status,gma3_sequences,gma3_playback`).
