/**
 * One console undo group per tool call (src/undo.ts): the MutationLock hooks open `undo.open {name: <tool>}` around the
 * outermost mutation span and `undo.close` after it, against a FakeBridge.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeError, Gma3Bridge } from "../src/bridge.ts";
import { HeldLock, MutationLock } from "../src/mutations.ts";
import { recordTools, type RecordedTool } from "../src/http.ts";
import { UndoGroups, currentTool, inToolScope, undoGroupsEnabled, type UndoGroupOptions } from "../src/undo.ts";
import { FakeBridge, SILENT } from "./helpers/fake-bridge.ts";

let fake: FakeBridge;
let bridge: Gma3Bridge;
let logs: string[] = [];

before(async () => {
  fake = new FakeBridge();
  const port = await fake.listen();
  bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 1000, connectTimeoutMs: 1000 });
});
after(async () => {
  bridge.close();
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  logs = [];
  fake.on("undo.open", (a) => ({ open: true, name: a.name }));
  fake.on("undo.close", () => ({ closed: true, commands: 1 }));
  fake.on("cmd", (a) => ({ command: a.command, feedback: "OK" }));
});

const ops = () => fake.requests.map((r) => (r.op === "cmd" ? `cmd:${r.args.command}` : r.op === "undo.open" ? `open:${r.args.name}` : r.op));
const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** A server whose tools mutate through `lock`, recorded like src/index.ts does. */
function setup(opts: UndoGroupOptions = {}) {
  const groups = new UndoGroups(bridge, { env: {}, log: (m) => logs.push(m), openTimeoutMs: 300, closeTimeoutMs: 300, ...opts });
  const lock = new MutationLock(groups);
  const server = new McpServer({ name: "t", version: "0" });
  const tools = recordTools(server);
  const cmd = (c: string) => bridge.request("cmd", { command: c });
  server.registerTool("gma3_store_cue", { description: "x" }, async () => {
    await lock.run(async () => {
      await cmd("Store Cue 1");
      await cmd("Label Cue 1 \"A\"");
    });
    return ok("done");
  });
  server.registerTool("gma3_batch", { description: "x" }, async () => {
    await lock.run(async () => {
      const held = new HeldLock();
      await held.run(() => cmd("one"));
      await held.run(() => cmd("two"));
    });
    return ok("done");
  });
  server.registerTool("gma3_load_show", { description: "x" }, async () => {
    await lock.run(() => cmd("LoadShow \"B\""));
    return ok("done");
  });
  server.registerTool("gma3_fail", { description: "x" }, async () => {
    await lock.run(async () => {
      await cmd("Store Cue 2");
      throw new Error("boom");
    });
    return ok("unreached");
  });
  server.registerTool("gma3_name", { description: "x" }, async () => ok(String(currentTool())));
  const call = (name: string) => (tools.get(name) as RecordedTool).handler({});
  return { groups, lock, tools, call };
}

test("undo: one group per outermost span, named after the tool, closed after its commands", async () => {
  const { call } = setup();
  await call("gma3_store_cue");
  assert.deepEqual(ops(), ["open:gma3_store_cue", "cmd:Store Cue 1", 'cmd:Label Cue 1 "A"', "undo.close"]);
});

test("undo: the tool scope carries the tool name into the handler; outside it there is none", async () => {
  const { call } = setup();
  const r = await call("gma3_name");
  assert.equal(r.content[0].text, "gma3_name");
  assert.equal(currentTool(), undefined);
  assert.equal(inToolScope("x", () => currentTool()), "x");
});

test("undo: a batch with a HeldLock opens no nested group", async () => {
  const { call } = setup();
  await call("gma3_batch");
  assert.deepEqual(ops(), ["open:gma3_batch", "cmd:one", "cmd:two", "undo.close"]);
});

test("undo: concurrent tool calls each get their own group, in lock order", async () => {
  const { call } = setup();
  await Promise.all([call("gma3_store_cue"), call("gma3_batch")]);
  assert.deepEqual(ops(), ["open:gma3_store_cue", "cmd:Store Cue 1", 'cmd:Label Cue 1 "A"', "undo.close", "open:gma3_batch", "cmd:one", "cmd:two", "undo.close"]);
});

test("undo: a span outside any tool is named mcp", async () => {
  const { lock } = setup();
  await lock.run(() => bridge.request("cmd", { command: "x" }));
  assert.deepEqual(ops(), ["open:mcp", "cmd:x", "undo.close"]);
});

test("undo: a failed mutation still closes its group and fails as before", async () => {
  const { call } = setup();
  await assert.rejects(call("gma3_fail"), /boom/);
  assert.deepEqual(ops(), ["open:gma3_fail", "cmd:Store Cue 2", "undo.close"]);
});

test("undo: show switches are not grouped; the exclusion list is configurable", async () => {
  const { call } = setup();
  await call("gma3_load_show");
  assert.deepEqual(ops(), ['cmd:LoadShow "B"']);
  fake.requests.length = 0;
  const custom = setup({ exclude: ["gma3_store_cue"] });
  await custom.call("gma3_store_cue");
  await custom.call("gma3_load_show");
  assert.deepEqual(ops(), ["cmd:Store Cue 1", 'cmd:Label Cue 1 "A"', "open:gma3_load_show", 'cmd:LoadShow "B"', "undo.close"]);
  fake.requests.length = 0;
  const fromEnv = setup({ env: { GMA3_UNDO_EXCLUDE: " gma3_batch , " } });
  await fromEnv.call("gma3_batch");
  await fromEnv.call("gma3_load_show");
  assert.deepEqual(ops(), ["cmd:one", "cmd:two", 'cmd:LoadShow "B"']);
});

test("undo: an older bridge (unknown op) switches grouping off for good", async () => {
  fake.on("undo.open", () => {
    throw new Error("unknown op 'undo.open'");
  });
  const { call, groups } = setup();
  await call("gma3_store_cue");
  await call("gma3_store_cue");
  assert.equal(groups.unsupported, true);
  assert.deepEqual(ops(), ["open:gma3_store_cue", "cmd:Store Cue 1", 'cmd:Label Cue 1 "A"', "cmd:Store Cue 1", 'cmd:Label Cue 1 "A"']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /needs bridge 0\.46\.0/);
});

test("undo: a lost undo.open reply does not fail the tool; the group is closed in case it opened", async () => {
  fake.on("undo.open", () => SILENT);
  const { call, groups } = setup();
  const r = await call("gma3_store_cue");
  assert.equal(r.content[0].text, "done");
  assert.deepEqual(ops(), ["open:gma3_store_cue", "cmd:Store Cue 1", 'cmd:Label Cue 1 "A"', "undo.close"]);
  assert.equal(groups.unsupported, false, "a timeout is not an older bridge");
});

test("undo: other open/close errors and an unreachable bridge never fail the tool", async () => {
  fake.on("undo.open", () => {
    throw new Error("CreateUndo failed: nil");
  });
  const { call } = setup();
  assert.equal((await call("gma3_store_cue")).content[0].text, "done");
  assert.deepEqual(ops(), ["open:gma3_store_cue", "cmd:Store Cue 1", 'cmd:Label Cue 1 "A"'], "a refused open is not closed");

  fake.on("undo.open", (a) => ({ open: true, name: a.name }));
  fake.on("undo.close", () => {
    throw new Error("close failed");
  });
  fake.requests.length = 0;
  assert.equal((await call("gma3_store_cue")).content[0].text, "done");
  assert.equal(ops().at(-1), "undo.close");

  // A bridge that is not running: the hook's error is swallowed, the mutation itself decides.
  const dead = new Gma3Bridge({ host: "127.0.0.1", port: 1, requestTimeoutMs: 300, connectTimeoutMs: 300 });
  const lock = new MutationLock(new UndoGroups(dead, { env: {}, log: () => {} }));
  assert.equal(await lock.run(async () => 7), 7);
  dead.close();
});

test("undo: GMA3_UNDO_GROUPS=0 disables grouping", async () => {
  for (const v of ["0", "false", "off", " no "]) assert.equal(undoGroupsEnabled(v), false, v);
  for (const v of [undefined, "1", "yes", ""]) assert.equal(undoGroupsEnabled(v), true, String(v));
  const { call, groups } = setup({ env: { GMA3_UNDO_GROUPS: "0" } });
  assert.equal(groups.active, false);
  await call("gma3_store_cue");
  assert.deepEqual(ops(), ["cmd:Store Cue 1", 'cmd:Label Cue 1 "A"']);
});

test("MutationLock hooks: called once per outermost span, a hook error never fails the mutation", async () => {
  const seen: string[] = [];
  const lock = new MutationLock({
    async enter() {
      seen.push("enter");
      throw new BridgeError("enter failed");
    },
    async exit() {
      seen.push("exit");
      throw new Error("exit failed");
    },
  });
  assert.equal(await lock.run(async () => (seen.push("fn"), 1)), 1);
  await assert.rejects(lock.run(async () => Promise.reject(new Error("mutation failed"))), /mutation failed/);
  assert.deepEqual(seen, ["enter", "fn", "exit", "enter", "exit"]);
  assert.equal(lock.busy, false);
  // The next holder's enter runs only after the previous exit.
  const order: string[] = [];
  const ordered = new MutationLock({ enter: async () => void order.push("enter"), exit: async () => void order.push("exit") });
  await Promise.all([ordered.run(async () => void order.push("a")), ordered.run(async () => void order.push("b"))]);
  assert.deepEqual(order, ["enter", "a", "exit", "enter", "b", "exit"]);
});
