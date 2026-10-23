/**
 * Show-data changes (bridge 0.46.0): pushed event lines in Gma3Bridge, the gma3_changes tool (cursor, long poll,
 * bridge restart, older bridge) and the "changes" events of the HTTP events stream.
 *
 * `FakeLog` models the bridge's change ring: increasing seq numbers per bridge start (instance), changes.since after
 * a cursor, changes.watch per connection and pushed {"event":"changes"} lines.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Gma3Bridge, type BridgeEvent } from "../src/bridge.ts";
import { recordTools, startHttpApi, type HttpApi } from "../src/http.ts";
import { NEEDS_BRIDGE, registerChangesTools } from "../src/tools/changes.ts";
import { FakeBridge } from "./helpers/fake-bridge.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeLog {
  instance = "start-1";
  seq = 0;
  ring: Array<Record<string, unknown>> = [];
  dropped = 0;
  constructor(private readonly fake: FakeBridge) {}
  install(): this {
    this.fake.on("changes.since", (args) => {
      const cursor = Number(args.cursor ?? 0);
      const limit = Number(args.limit ?? 200);
      const list = this.ring.filter((e) => (e.seq as number) > cursor).slice(0, limit);
      const first = this.ring[0]?.seq as number | undefined;
      const missed = first !== undefined && cursor > 0 && first > cursor + 1 && cursor < this.seq;
      return { instance: this.instance, cursor: list.length ? list[list.length - 1].seq : this.seq, latest: this.seq, changes: list, missed, hooks: 12 };
    });
    this.fake.on("changes.watch", () => ({ instance: this.instance, watching: true, cursor: this.seq, hooks: 12 }));
    this.fake.on("changes.unwatch", () => ({ watching: false }));
    return this;
  }
  add(name: string, what = "children", key = "pool:Groups", kind = "pool"): Record<string, unknown> {
    this.seq++;
    const e = { seq: this.seq, kind, key, name, no: this.seq, what, change: what === "children" ? 10 : 11, count: 1, t: this.seq };
    this.ring.push(e);
    return e;
  }
  push(list: Array<Record<string, unknown>>): number {
    return this.fake.push({ event: "changes", instance: this.instance, cursor: this.seq, changes: list, missed: false });
  }
  restart(instance: string): void {
    this.instance = instance;
    this.seq = 0;
    this.ring = [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Gma3Bridge: pushed lines and connections

test("bridge: id-less lines with an event go to the listeners; replies and other lines are unaffected", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 1000, connectTimeoutMs: 1000 });
  try {
    fake.on("ping", () => ({ ok: 1 }));
    const seen: BridgeEvent[] = [];
    const connects: number[] = [];
    const offConnect = bridge.onConnect((n) => connects.push(n));
    const off = bridge.onEvent((ev) => seen.push(ev));
    bridge.onEvent(() => {
      throw new Error("a failing listener does not break the others");
    });
    await bridge.request("ping");
    assert.equal(bridge.connectionCount, 1);
    assert.deepEqual(connects, [1]);
    fake.push({ event: "changes", cursor: 3, changes: [] });
    fake.push({ noEvent: true });
    await sleep(50);
    assert.deepEqual(seen, [{ event: "changes", cursor: 3, changes: [] }]);
    assert.deepEqual(await bridge.request("ping"), { ok: 1 });
    off();
    fake.push({ event: "changes", cursor: 4, changes: [] });
    await sleep(50);
    assert.equal(seen.length, 1, "unsubscribed");
    fake.dropClients();
    await sleep(50);
    await bridge.request("ping");
    assert.equal(bridge.connectionCount, 2);
    assert.deepEqual(connects, [1, 2]);
    offConnect();
  } finally {
    bridge.close();
    await fake.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// gma3_changes

let h: Harness;
let log: FakeLog;
before(async () => {
  h = await startHarness(registerChangesTools, { requestTimeoutMs: 1000 });
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  log = new FakeLog(h.fake).install();
});

test("gma3_changes: the changes after the cursor, the cursor and instance to pass next time", async () => {
  log.add("Group A");
  log.add("Group B");
  log.add("Seq 1", "object", "sequence:1", "sequence");
  const all = await h.callJson("gma3_changes", {});
  assert.equal(all.isError, false, all.text);
  assert.equal(all.result.count, 3);
  assert.equal(all.result.cursor, 3);
  assert.equal(all.result.instance, "start-1");
  assert.equal(all.result.restarted, false);
  assert.match(all.result.next, /cursor 3 and instance "start-1"/);
  const after2 = await h.callJson("gma3_changes", { cursor: 2, instance: "start-1", limit: 5 });
  assert.deepEqual(after2.result.changes.map((c: { name: string }) => c.name), ["Seq 1"]);
  assert.equal(after2.result.changes[0].what, "object");
  assert.deepEqual(h.fake.requests.at(-1)!.args, { cursor: 2, limit: 5 });
  const none = await h.callJson("gma3_changes", { cursor: 3 });
  assert.equal(none.result.count, 0);
  assert.equal(none.result.cursor, 3);
  assert.equal(none.result.waited_ms, undefined, "no wait asked");
  assert.match(h.tools.get("gma3_changes")!.description!, /playback state.*gma3_executors \/ gma3_sequences/);
});

test("gma3_changes: wait_ms is resolved by a pushed event before the next poll", async () => {
  setTimeout(() => {
    const e = log.add("Group C");
    log.push([e]);
  }, 60);
  const t0 = Date.now();
  const r = await h.callJson("gma3_changes", { cursor: 0, wait_ms: 5000 });
  const took = Date.now() - t0;
  assert.equal(r.result.count, 1);
  assert.equal(r.result.changes[0].name, "Group C");
  assert.equal(r.result.cursor, 1);
  assert.ok(took < 240, `woken by the push, not the ${250} ms poll (${took} ms)`);
  assert.equal(h.fake.requests.filter((q) => q.op === "changes.since").length, 2);
  assert.ok(!h.fake.requests.some((q) => q.op === "changes.watch"), "the tool never takes the connection's watch");
});

test("gma3_changes: wait_ms without a push polls changes.since, and times out with nothing", async () => {
  setTimeout(() => log.add("Macro 1", "children", "pool:Macros"), 100);
  const polled = await h.callJson("gma3_changes", { cursor: 0, wait_ms: 3000 });
  assert.equal(polled.result.count, 1);
  assert.equal(polled.result.changes[0].name, "Macro 1");
  const t0 = Date.now();
  const idle = await h.callJson("gma3_changes", { cursor: 1, wait_ms: 400 });
  assert.equal(idle.result.count, 0);
  assert.equal(idle.result.cursor, 1);
  assert.ok(Date.now() - t0 >= 390 && idle.result.waited_ms >= 390, `waited the full time (${idle.result.waited_ms})`);
});

test("gma3_changes: another instance means the bridge restarted; the cursor is reset and read from the start", async () => {
  log.restart("start-2");
  log.add("Group New");
  const r = await h.callJson("gma3_changes", { cursor: 40, instance: "start-1" });
  assert.equal(r.result.restarted, true);
  assert.equal(r.result.instance, "start-2");
  assert.deepEqual(r.result.changes.map((c: { name: string }) => c.name), ["Group New"]);
  assert.equal(r.result.cursor, 1);
  assert.match(r.result.notes.join(" "), /bridge restarted \(instance start-1 -> start-2\).*re-read/);
  assert.deepEqual(h.fake.requests.filter((q) => q.op === "changes.since").map((q) => q.args.cursor), [40, 0]);
  // Without the instance: a cursor beyond the bridge's latest gives it away.
  const ahead = await h.callJson("gma3_changes", { cursor: 40 });
  assert.equal(ahead.result.restarted, true);
  assert.match(ahead.result.notes.join(" "), /ahead of the bridge's latest 1/);
  assert.equal(ahead.result.count, 1);
});

test("gma3_changes: missed entries are flagged with a note", async () => {
  for (let i = 0; i < 5; i++) log.add(`G${i}`);
  log.ring.splice(0, 3); // the ring dropped seq 1-3
  const r = await h.callJson("gma3_changes", { cursor: 1, instance: "start-1" });
  assert.equal(r.result.missed, true);
  assert.match(r.result.notes.join(" "), /dropped from the bridge's ring/);
});

test("gma3_changes: an older bridge without changes.since is a clear error", async () => {
  h.fake.reset();
  const r = await h.callJson("gma3_changes", { wait_ms: 1000 });
  assert.equal(r.isError, true);
  assert.equal(r.text, NEEDS_BRIDGE);
  assert.match(r.text, /needs bridge 0\.46\.0/);
});

test("gma3_changes: arguments are checked", async () => {
  assert.equal((await h.callJson("gma3_changes", { wait_ms: 30001 })).isError, true);
  assert.equal((await h.callJson("gma3_changes", { cursor: -1 })).isError, true);
  assert.equal((await h.callJson("gma3_changes", { limit: 0 })).isError, true);
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP events stream: "changes" events

const TOKEN = "test-token-0123456789";

async function openStream(api: HttpApi) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${api.address.port}/api/events?token=${TOKEN}`, { signal: ac.signal });
  const reader = res.body!.getReader();
  let buf = "";
  const decoder = new TextDecoder();
  /** The next event of that name (others are skipped). */
  const next = async (name: string, timeoutMs = 3000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const i = buf.indexOf("\n\n");
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = block.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (ev === name && data) return JSON.parse(data.slice(6));
        continue;
      }
      if (Date.now() > deadline) throw new Error(`no ${name} event within ${timeoutMs} ms`);
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buf += decoder.decode(value, { stream: true });
    }
  };
  return { next, close: () => ac.abort() };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

test("http: the events stream forwards pushed show-data changes and watches again after a reconnect or a new instance", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 1000, connectTimeoutMs: 1000 });
  const flog = new FakeLog(fake).install();
  fake.on("ping", () => ({ bridgeVersion: "0.46.0", instance: flog.instance, showfile: "Show A", user: "Admin" }));
  const server = new McpServer({ name: "t", version: "0" });
  const tools = recordTools(server);
  server.registerTool("gma3_executors", { description: "executors", inputSchema: { only_assigned: z.boolean().optional() } }, async () => ({ content: [{ type: "text", text: JSON.stringify({ executors: [] }) }] }));
  const api = await startHttpApi({ tools, bridge, token: TOKEN, port: 0, eventsMs: 250 });
  const watches = () => fake.requests.filter((r) => r.op === "changes.watch").length;
  const stream = await openStream(api);
  try {
    const state = await stream.next("state");
    assert.equal(state.bridge.instance, "start-1");
    await until(() => watches() === 1);
    const e = flog.add("Group A");
    flog.push([e]);
    const ch = await stream.next("changes");
    assert.deepEqual(ch, { event: "changes", instance: "start-1", cursor: 1, changes: [e], missed: false });

    // The connection drops: the next poll reconnects and the stream watches again.
    fake.dropClients();
    await until(() => watches() === 2);
    flog.push([flog.add("Group B")]);
    assert.equal((await stream.next("changes")).changes[0].name, "Group B");

    // The bridge names another instance on the same connection: watched again.
    flog.restart("start-2");
    await until(() => watches() === 3);
    flog.push([flog.add("Seq 1", "children", "sequence:1", "sequence")]);
    const after = await stream.next("changes");
    assert.equal(after.instance, "start-2");
    assert.equal(after.changes[0].key, "sequence:1");
    assert.equal(watches(), 3, "no needless re-watch");
  } finally {
    stream.close();
    await until(() => fake.requests.some((r) => r.op === "changes.unwatch")).catch(() => {});
    await api.close();
    bridge.close();
    await fake.close();
  }
  assert.ok(fake.requests.some((r) => r.op === "changes.unwatch"), "the last listener leaving ends the watch");
});

test("http: an older bridge without changes.watch keeps the state events and is not asked again", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 1000, connectTimeoutMs: 1000 });
  let instance = "old-1";
  fake.on("ping", () => ({ bridgeVersion: "0.45.0", instance, showfile: "Show A" }));
  const server = new McpServer({ name: "t", version: "0" });
  const tools = recordTools(server);
  const api = await startHttpApi({ tools, bridge, token: TOKEN, port: 0, eventsMs: 250 });
  const stream = await openStream(api);
  try {
    assert.equal((await stream.next("state")).bridge.show, "Show A");
    await sleep(700);
    const watches = () => fake.requests.filter((r) => r.op === "changes.watch").length;
    assert.equal(watches(), 1, "asked once; unknown op is remembered for this instance");
    // The plugin was updated and the bridge restarted: another instance is asked again.
    fake.on("changes.watch", () => ({ instance: "new-1", watching: true, cursor: 0, hooks: 1 }));
    instance = "new-1";
    await until(() => watches() === 2);
    fake.push({ event: "changes", instance: "new-1", cursor: 1, changes: [{ seq: 1, key: "pool:Macros", kind: "pool", what: "children" }], missed: false });
    assert.equal((await stream.next("changes")).changes[0].key, "pool:Macros");
  } finally {
    stream.close();
    await api.close();
    bridge.close();
    await fake.close();
  }
});
