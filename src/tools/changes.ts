/**
 * gma3_changes: what changed in the show data since a cursor (bridge 0.46.0, ops changes.since / changes.watch).
 *
 * The bridge hooks every data pool pool, every preset pool and every sequence (HookObjectChange) the first time a
 * client asks, and keeps the last 256 entries in a ring with increasing seq numbers. Console facts (onPC 2.5.1, live):
 * change 10 "children" is a store or delete in a pool, a Store Cue in a sequence or a stored preset; 11 "object" is a
 * Label and other property edits of the hooked object. Playback, the programmer and the selection fire nothing.
 *
 * The cursor belongs to one bridge start (`instance`): after a restart the seq numbers start again at 1, so a cursor
 * from the old instance is meaningless. Pass the instance back and the tool reads from the start of the new one.
 *
 * Long poll (wait_ms): when nothing is new, the tool waits for a pushed {"event":"changes"} line (someone on this
 * connection watches, e.g. the HTTP events stream) or polls changes.since every POLL_MS until the time is up. It never
 * calls changes.watch itself: the watch belongs to the connection and the HTTP events stream may hold it.
 */
import { z } from "zod";
import { BridgeError, type BridgeEvent, type Gma3Bridge } from "../bridge.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";

export const NEEDS_BRIDGE = "gma3_changes needs bridge 0.46.0 (op changes.since); the console runs an older bridge plugin: update it";
export const POLL_MS = 250;
export const MAX_WAIT_MS = 30000;

export interface ChangeEntry {
  seq: number;
  kind: "pool" | "presetPool" | "sequence" | string;
  key: string;
  name?: string;
  no?: number;
  what: "children" | "object" | string;
  change: number;
  count: number;
  t: number;
}

export interface ChangesSince {
  instance: string | null;
  cursor: number;
  latest: number;
  changes: ChangeEntry[];
  missed: boolean;
  hooks: number | null;
}

const isUnknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/i.test(err.message);

/** One changes.since read, normalised; an older bridge's "unknown op" becomes NEEDS_BRIDGE. */
export async function readChanges(bridge: Gma3Bridge, cursor: number, limit: number | undefined, timeoutMs: number): Promise<ChangesSince> {
  let r: Record<string, unknown>;
  try {
    r = ((await bridge.request("changes.since", limit === undefined ? { cursor } : { cursor, limit }, timeoutMs)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    if (isUnknownOp(err)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    instance: r.instance === undefined || r.instance === null ? null : String(r.instance),
    cursor: num(r.cursor, cursor),
    latest: num(r.latest, 0),
    changes: Array.isArray(r.changes) ? (r.changes as ChangeEntry[]) : [],
    missed: r.missed === true,
    hooks: typeof r.hooks === "number" ? r.hooks : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChangesArgs {
  cursor?: number;
  wait_ms?: number;
  limit?: number;
  instance?: string;
}

export async function changes(ctx: ToolContext, args: ChangesArgs) {
  const bridge = ctx.bridge;
  const t = ctx.requestTimeoutMs;
  const wait = Math.max(0, Math.min(MAX_WAIT_MS, args.wait_ms ?? 0));
  const notes: string[] = [];
  let cursor = args.cursor ?? 0;
  const started = Date.now();

  let r = await readChanges(bridge, cursor, args.limit, t);
  // The cursor belongs to one bridge start: read from the start of the new one after a restart.
  let restarted = (args.instance !== undefined && r.instance !== null && args.instance !== r.instance) || cursor > r.latest;
  if (restarted) {
    notes.push(
      args.instance !== undefined && r.instance !== args.instance
        ? `the bridge restarted (instance ${args.instance} -> ${r.instance}): the cursor was reset, so these are the changes since the new start; re-read anything you cached`
        : `cursor ${cursor} is ahead of the bridge's latest ${r.latest}: the bridge restarted and the cursor was reset, so these are the changes since the new start; re-read anything you cached`,
    );
    cursor = 0;
    r = await readChanges(bridge, cursor, args.limit, t);
  }

  let waited = false;
  if (r.changes.length === 0 && wait > 0) {
    waited = true;
    const deadline = started + wait;
    let wake: (() => void) | null = null;
    const off = bridge.onEvent((ev: BridgeEvent) => {
      if (ev.event === "changes" && wake) wake();
    });
    let unreachable = false;
    try {
      while (Date.now() < deadline) {
        const left = deadline - Date.now();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, Math.min(POLL_MS, left));
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
        try {
          const next = await readChanges(bridge, cursor, args.limit, t);
          unreachable = false;
          if (r.instance !== null && next.instance !== null && next.instance !== r.instance) {
            notes.push(`the bridge restarted while waiting (instance ${r.instance} -> ${next.instance}): the cursor was reset, so these are the changes since the new start; re-read anything you cached`);
            cursor = 0;
            restarted = true;
            r = await readChanges(bridge, 0, args.limit, t);
            if (r.changes.length) break;
            continue;
          }
          r = next;
          if (r.changes.length) break;
        } catch (err) {
          if (err instanceof Error && err.message === NEEDS_BRIDGE) throw err;
          unreachable = true;
          await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
        }
      }
    } finally {
      off();
    }
    if (unreachable) notes.push("the bridge could not be read at the end of the wait; the result is from the last successful read");
  }
  if (r.missed) notes.push("some changes after your cursor were dropped from the bridge's ring (256 entries) before this read: re-read the pools and sequences you care about");
  if (r.hooks === 0) notes.push("the bridge has no change hooks installed (it could not hook the show), so no change will be reported");

  return {
    instance: r.instance,
    cursor: r.cursor,
    latest: r.latest,
    count: r.changes.length,
    changes: r.changes,
    missed: r.missed,
    restarted,
    hooks: r.hooks,
    ...(waited ? { waited_ms: Date.now() - started } : {}),
    ...(notes.length ? { notes } : {}),
    next: `pass cursor ${r.cursor} and instance ${JSON.stringify(r.instance)} next time`,
  };
}

export const registerChangesTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_changes",
    {
      title: "Show-data changes since a cursor",
      description:
        "Read-only: what changed in the show data since a cursor: stores and deletes in any data pool pool (groups, macros, sequences, ...), presets stored, cues stored in a sequence (what: \"children\"), labels and other property edits of those pools and sequences (what: \"object\"). " +
        "Each change names its kind (pool, presetPool, sequence), key, name/no and how often it repeated. Pass the returned cursor and instance next time; with wait_ms it waits (long poll, up to 30 s) until something changes. " +
        "When the bridge restarted the instance differs and the cursor is reset (the tool then reads from the new start); missed: true means entries were dropped before you read them, so re-read what you care about. " +
        "NOT covered: playback state (running cues, faders, executors), the programmer and the selection fire no change: use gma3_executors / gma3_sequences for those. Needs bridge 0.46.0.",
      inputSchema: {
        cursor: z.number().int().min(0).optional().describe("The cursor a previous call returned (default 0: everything the bridge still holds)"),
        instance: z.string().optional().describe("The instance a previous call returned; a different one means the bridge restarted and the cursor is reset"),
        wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("Wait up to this long for a change when nothing is new (0-30000, default 0)"),
        limit: z.number().int().min(1).max(256).optional().describe("At most this many changes (1-256, default 200)"),
      },
    },
    async (args) => {
      try {
        return json(await changes(ctx, args as ChangesArgs));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );
};
