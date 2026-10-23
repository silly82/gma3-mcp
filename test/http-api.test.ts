/**
 * The HTTP API (src/http.ts) against a FakeBridge: the recorded MCP tools served over HTTP with the same validation,
 * the token, the allowlist, loopback-only binding and the events stream.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Gma3Bridge } from "../src/bridge.ts";
import { MutationLock } from "../src/mutations.ts";
import { checkHttpOptions, recordTools, startHttpApi, type HttpApi } from "../src/http.ts";
import { registerShowTools } from "../src/tools/show.ts";
import type { ToolContext } from "../src/tools/context.ts";
import { FakeBridge } from "./helpers/fake-bridge.ts";

const TOKEN = "test-token-0123456789";
let fake: FakeBridge;
let bridge: Gma3Bridge;
let api: HttpApi;
let fader = 50;
let luaCalls = 0;
const base = () => `http://127.0.0.1:${api.address.port}`;
const get = (path: string, token: string | null = TOKEN) => fetch(base() + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (path: string, body: unknown, token = TOKEN) => fetch(base() + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

before(async () => {
  fake = new FakeBridge();
  const port = await fake.listen();
  bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 1000, connectTimeoutMs: 1000 });
  fake.on("ping", () => ({ bridgeVersion: "0.45.0", instance: "start-1", showfile: "Show A", user: "Admin" }));
  fake.on("show.files", () => ({ current: "Show A", path: "/shows", listed: true, files: [{ name: "Show A", file: "Show A.show", size: 10, time: 1792140000, localTime: "wall" }], modal: false, modalKnown: true }));
  const server = new McpServer({ name: "t", version: "0" });
  const tools = recordTools(server);
  const ctx: ToolContext = { bridge, mutations: new MutationLock(), requestTimeoutMs: 1000, luaToolAllowed: true };
  registerShowTools(server, ctx);
  server.registerTool("gma3_executors", { description: "executors", inputSchema: { only_assigned: z.boolean().optional() } }, async () => ({ content: [{ type: "text", text: JSON.stringify({ executors: [{ number: 201, name: "Dimmer", faderMaster: fader, assigned: { hasActivePlayback: true, currentCue: { no: 1, name: "Cue 1" } } }] }) }] }));
  server.registerTool("gma3_lua", { description: "lua", inputSchema: { code: z.string() } }, async () => {
    luaCalls++;
    return { content: [{ type: "text", text: "{}" }] };
  });
  api = await startHttpApi({ tools, bridge, token: TOKEN, port: 0, eventsMs: 250 });
});
after(async () => {
  await api.close();
  bridge.close();
  await fake.close();
});

test("http: every request needs the token", async () => {
  assert.equal((await get("/api/status", null)).status, 401);
  assert.equal((await get("/api/status", "wrong-token-0123456789")).status, 401);
  assert.equal((await get("/api/status")).status, 200);
  assert.equal((await get(`/api/status?token=${TOKEN}`, null)).status, 200, "?token= for EventSource clients");
});

test("http: status reports the bridge; tools lists the served tools without gma3_lua", async () => {
  const s = await (await get("/api/status")).json();
  assert.deepEqual(s.bridge, { connected: true, show: "Show A", bridgeVersion: "0.45.0", instance: "start-1", user: "Admin" });
  const t = await (await get("/api/tools")).json();
  const names = t.tools.map((x: { name: string }) => x.name);
  assert.ok(names.includes("gma3_show_files") && names.includes("gma3_load_show") && names.includes("gma3_executors"), names.join());
  assert.ok(!names.includes("gma3_lua"));
  assert.deepEqual(t.tools.find((x: { name: string }) => x.name === "gma3_save_show").parameters, ["name", "overwrite", "timeout_ms", "exclusive"]);
});

test("http: a tool call returns the tool's JSON result, with the MCP validation and checks", async () => {
  const r = await post("/api/tools/gma3_show_files", {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.isError, false);
  assert.equal(body.result.current, "Show A");
  // The tool's own checks still apply: exclusive is required.
  const refused = await (await post("/api/tools/gma3_save_show", {})).json();
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.result), /exclusive must be true/);
  // Schema validation as in MCP.
  const bad = await post("/api/tools/gma3_load_show", { name: 5 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /input validation failed/);
});

test("http: unknown tool, wrong method, bad body, gma3_lua refused", async () => {
  assert.equal((await post("/api/tools/gma3_nope", {})).status, 404);
  assert.equal((await get("/api/tools/gma3_show_files")).status, 405);
  assert.equal((await post("/api/tools/gma3_show_files", "{not json")).status, 400);
  assert.equal((await post("/api/tools/gma3_show_files", [1, 2])).status, 400);
  assert.equal((await post("/api/tools/gma3_lua", { code: "1" })).status, 403);
  assert.equal(luaCalls, 0);
  assert.equal((await get("/nowhere")).status, 404);
});

test("http: the events stream sends the state at once and again when it changes", async () => {
  const ac = new AbortController();
  const res = await fetch(`${base()}/api/events?token=${TOKEN}`, { signal: ac.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const events: any[] = [];
  let buf = "";
  const next = async () => {
    while (true) {
      const i = buf.indexOf("\n\n");
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buf += new TextDecoder().decode(value);
    }
  };
  events.push(await next());
  assert.equal(events[0].bridge.show, "Show A");
  assert.deepEqual(events[0].executors, [{ number: 201, name: "Dimmer", fader: 50, active: true, cue: { no: 1, name: "Cue 1" } }]);
  fader = 75;
  events.push(await next());
  assert.equal(events[1].executors[0].fader, 75);
  ac.abort();
});

test("http: options are checked before anything listens", () => {
  assert.throws(() => checkHttpOptions({ token: "short", port: 0 }), /at least 16/);
  assert.throws(() => checkHttpOptions({ token: TOKEN, port: 0, host: "0.0.0.0" }), /not loopback/);
  assert.doesNotThrow(() => checkHttpOptions({ token: TOKEN, port: 0, host: "0.0.0.0", allowNetwork: true }));
  assert.throws(() => checkHttpOptions({ token: TOKEN, port: 70000 }), /0-65535/);
  assert.throws(() => checkHttpOptions({ token: TOKEN, port: 0, eventsMs: 10 }), /250-60000/);
});
