/**
 * Local HTTP API next to MCP (docs/http-api.md): the same tools for clients that do not speak MCP (Home Assistant,
 * Node-RED, scripts, a phone app), with the same validation, checks and read-back, plus a Server-Sent Events stream
 * of the console's state.
 *
 *   GET  /api/status          the bridge (ping): connected, show, bridge version and instance
 *   GET  /api/tools           the tools this API serves: name, title, description
 *   POST /api/tools/<name>    call a tool; the JSON body is its arguments; the answer is { isError, result }
 *   GET  /api/events          text/event-stream: "state" events (bridge, show, assigned executors) when they change
 *
 * Every request needs  Authorization: Bearer <GMA3_HTTP_TOKEN>  (or ?token= for EventSource clients that cannot set
 * headers). The API binds to 127.0.0.1 unless GMA3_HTTP_ALLOW_NETWORK=1: a token over plain HTTP on a network can be
 * read by anyone on it. gma3_lua is never served unless GMA3_HTTP_TOOLS names it.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Gma3Bridge } from "./bridge.js";
import { inToolScope } from "./undo.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
export interface RecordedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

/**
 * Records every tool registered on `server` from now on (call before the registrations). Every handler, over MCP and
 * over HTTP, runs inside the tool scope (src/undo.ts) with its tool name, so its mutation span can be named after it.
 */
export function recordTools(server: McpServer): Map<string, RecordedTool> {
  const tools = new Map<string, RecordedTool>();
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, def: unknown, handler: unknown) => {
    const d = (def ?? {}) as { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
    const inner = handler as (...a: unknown[]) => unknown;
    const scoped = typeof inner === "function" ? (...a: unknown[]) => inToolScope(String(name), () => inner(...a)) : inner;
    tools.set(String(name), { name: String(name), title: d.title, description: d.description, inputSchema: d.inputSchema, handler: scoped as Handler });
    return original(name, def, scoped);
  };
  return tools;
}

export interface HttpApiOptions {
  tools: Map<string, RecordedTool>;
  bridge: Gma3Bridge;
  token: string;
  host?: string;
  port: number;
  /** Tool names to serve ("*" = all but gma3_lua); default "*". */
  allow?: string[];
  /** Explicit consent to bind beyond loopback. */
  allowNetwork?: boolean;
  /** How often the events stream polls the console (ms, 250-60000; default 1000). */
  eventsMs?: number;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;
const MAX_BODY = 1 << 20;

/** Throws a readable reason when the options are unsafe or incomplete; nothing is started then. */
export function checkHttpOptions(o: Pick<HttpApiOptions, "token" | "host" | "port" | "allowNetwork" | "eventsMs">): void {
  if (!o.token || o.token.length < 16) throw new Error("GMA3_HTTP_TOKEN must be set to a secret of at least 16 characters");
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("GMA3_HTTP_PORT must be 0-65535");
  const host = o.host ?? "127.0.0.1";
  if (!LOOPBACK.test(host) && !o.allowNetwork) throw new Error(`GMA3_HTTP_HOST ${host} is not loopback: set GMA3_HTTP_ALLOW_NETWORK=1 to serve the network (the token travels in plain HTTP)`);
  if (o.eventsMs !== undefined && (!Number.isFinite(o.eventsMs) || o.eventsMs < 250 || o.eventsMs > 60000)) throw new Error("GMA3_HTTP_EVENTS_MS must be 250-60000");
}

const served = (name: string, allow: string[]) => (allow.includes(name) ? true : allow.includes("*") && name !== "gma3_lua");

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A tool's MCP result as JSON: the text parsed when it is JSON, else the text. */
function resultOf(r: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = r.content.map((c) => c.text ?? "").join("\n");
  let result: unknown = text;
  try {
    result = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { isError: Boolean(r.isError), result };
}

async function bridgeState(bridge: Gma3Bridge) {
  try {
    const p = (await bridge.request("ping", {}, 3000)) as Record<string, unknown>;
    return { connected: true, show: p.showfile ?? null, bridgeVersion: p.bridgeVersion ?? null, instance: p.instance ?? null, user: p.user ?? null };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface HttpApi {
  server: http.Server;
  /** The address it listens on (port resolved when 0 was asked for). */
  address: { host: string; port: number };
  close(): Promise<void>;
}

export async function startHttpApi(o: HttpApiOptions): Promise<HttpApi> {
  checkHttpOptions(o);
  const host = o.host ?? "127.0.0.1";
  const allow = o.allow?.length ? o.allow : ["*"];
  const eventsMs = o.eventsMs ?? 1000;
  const streams = new Set<http.ServerResponse>();

  // One poller for all event streams, only while someone listens; an event only when the state changed.
  let last = "";
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  const executors = o.tools.get("gma3_executors");
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const bridge = await bridgeState(o.bridge);
      let exec: unknown = null;
      if (bridge.connected && executors && served("gma3_executors", allow)) {
        const r = resultOf(await executors.handler({ only_assigned: true }));
        if (!r.isError && r.result && typeof r.result === "object") {
          const list = (r.result as { executors?: Array<Record<string, any>> }).executors ?? [];
          exec = list.map((e) => ({ number: e.number, name: e.name, fader: e.faderMaster ?? null, active: e.assigned?.hasActivePlayback ?? null, cue: e.assigned?.currentCue ?? null }));
        }
      }
      const state = JSON.stringify({ bridge, executors: exec });
      if (state !== last) {
        last = state;
        for (const s of streams) s.write(`event: state\ndata: ${state}\n\n`);
      }
    } finally {
      polling = false;
    }
  };
  const startPolling = () => {
    if (!timer) timer = setInterval(() => void poll(), eventsMs);
  };
  const stopPolling = () => {
    if (timer && streams.size === 0) {
      clearInterval(timer);
      timer = null;
      last = "";
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const auth = req.headers.authorization;
    const given = auth?.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") ?? "";
    if (!sameSecret(given, o.token)) return send(res, 401, { error: "unauthorized: send Authorization: Bearer <GMA3_HTTP_TOKEN>" });
    try {
      if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, { bridge: await bridgeState(o.bridge) });
      if (req.method === "GET" && url.pathname === "/api/tools") {
        const list = [...o.tools.values()].filter((t) => served(t.name, allow)).map((t) => ({ name: t.name, title: t.title ?? null, description: t.description ?? null, parameters: Object.keys(t.inputSchema ?? {}) }));
        return send(res, 200, { count: list.length, tools: list });
      }
      const m = /^\/api\/tools\/([\w.-]+)$/.exec(url.pathname);
      if (m) {
        if (req.method !== "POST") return send(res, 405, { error: "use POST with the tool's arguments as a JSON object" });
        const tool = o.tools.get(m[1]);
        if (!tool) return send(res, 404, { error: `no tool ${m[1]}; GET /api/tools lists them` });
        if (!served(tool.name, allow)) return send(res, 403, { error: `${tool.name} is not served by this API (GMA3_HTTP_TOOLS)` });
        let args: unknown = {};
        const body = await readBody(req);
        if (body.trim()) {
          try {
            args = JSON.parse(body);
          } catch {
            return send(res, 400, { error: "the body is not JSON" });
          }
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) return send(res, 400, { error: "the body must be a JSON object of the tool's arguments" });
        // The same validation the MCP SDK applies before a handler runs.
        const parsed = tool.inputSchema ? z.object(tool.inputSchema).safeParse(args) : { success: true as const, data: args };
        if (!parsed.success) return send(res, 400, { error: `input validation failed: ${parsed.error.message}` });
        return send(res, 200, resultOf(await tool.handler(parsed.data as Record<string, unknown>)));
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`retry: ${Math.max(1000, eventsMs)}\n\n`);
        streams.add(res);
        last = ""; // a new listener gets the current state at once
        startPolling();
        void poll();
        req.on("close", () => {
          streams.delete(res);
          stopPolling();
        });
        return;
      }
      return send(res, 404, { error: "unknown path; see docs/http-api.md" });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, host, () => resolve());
  });
  const addr = server.address() as { port: number };
  return {
    server,
    address: { host, port: addr.port },
    close: async () => {
      for (const s of streams) s.end();
      streams.clear();
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
