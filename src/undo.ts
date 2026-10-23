/**
 * One console undo group per MCP tool call (bridge 0.46.0, `undo.open` / `undo.close`).
 *
 * The bridge joins every Cmd/CmdIndirect it runs for the connection that opened a group to that group, so one Oops on
 * the console reverts everything a tool call changed. `UndoGroups` supplies the MutationLock hooks: the outermost
 * mutation span opens a group named after the running tool (the tool scope below), and closes it when the span ends.
 * Probed on onPC 2.5.1: an empty group adds no Oops step, and the bridge itself waits for queued CmdIndirect commands
 * before it closes a group.
 *
 * Best effort throughout: an older bridge ("unknown op") switches grouping off for this process, any other failure is
 * ignored, and nothing here ever fails the tool's mutation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { BridgeError, type Gma3Bridge } from "./bridge.js";
import type { MutationHooks } from "./mutations.js";

/** The name of the MCP tool whose handler is running (set by recordTools in src/http.ts). */
export const toolScope = new AsyncLocalStorage<string>();

/** Run `fn` as tool `name`: everything it awaits sees the name through `currentTool()`. */
export function inToolScope<T>(name: string, fn: () => T): T {
  return toolScope.run(name, fn);
}

/** The running tool's name, if any. */
export function currentTool(): string | undefined {
  return toolScope.getStore();
}

/** Tools that switch the show: a group around a LoadShow / SaveShow would span two show files. */
export const DEFAULT_UNDO_EXCLUDED = ["gma3_load_show", "gma3_save_show"] as const;

export interface UndoGroupOptions {
  /** False switches grouping off (default: on unless GMA3_UNDO_GROUPS is 0/false/no/off). */
  enabled?: boolean;
  /** Tools whose spans get no group (default DEFAULT_UNDO_EXCLUDED plus the comma list in GMA3_UNDO_EXCLUDE). */
  exclude?: Iterable<string>;
  /** Where the defaults above are read (default process.env). */
  env?: Record<string, string | undefined>;
  /** Group name outside any tool scope (default "mcp"). */
  fallbackName?: string;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Diagnostics (default: stderr); called at most once per distinct message in a row. */
  log?: (message: string) => void;
}

/** Is GMA3_UNDO_GROUPS set to a value that turns grouping off? */
export function undoGroupsEnabled(value: string | undefined): boolean {
  return !/^(0|false|no|off)$/i.test((value ?? "1").trim());
}

const isUnknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/i.test(err.message);

export class UndoGroups implements MutationHooks {
  private readonly enabled: boolean;
  private readonly exclude: Set<string>;
  private readonly fallbackName: string;
  private readonly openTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly log: (message: string) => void;
  private lastLog: string | undefined;
  /** The bridge answered "unknown op": it predates 0.46.0, stop asking. */
  unsupported = false;
  /** The group this process opened and has not closed yet. */
  private open: string | undefined;

  constructor(
    private readonly bridge: Pick<Gma3Bridge, "request">,
    opts: UndoGroupOptions = {},
  ) {
    const env = opts.env ?? process.env;
    this.enabled = opts.enabled ?? undoGroupsEnabled(env.GMA3_UNDO_GROUPS);
    const extra = (env.GMA3_UNDO_EXCLUDE ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    this.exclude = new Set(opts.exclude ?? [...DEFAULT_UNDO_EXCLUDED, ...extra]);
    this.fallbackName = opts.fallbackName ?? "mcp";
    this.openTimeoutMs = opts.openTimeoutMs ?? 3000;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 5000;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  /** True while grouping can still be attempted. */
  get active(): boolean {
    return this.enabled && !this.unsupported;
  }

  private note(message: string): void {
    if (message === this.lastLog) return;
    this.lastLog = message;
    this.log(`gma3-mcp undo groups: ${message}`);
  }

  async enter(): Promise<void> {
    this.open = undefined;
    if (!this.active) return;
    const tool = currentTool();
    if (tool && this.exclude.has(tool)) return;
    const name = tool ?? this.fallbackName;
    try {
      await this.bridge.request("undo.open", { name }, this.openTimeoutMs);
      this.open = name;
      this.lastLog = undefined;
    } catch (err) {
      if (isUnknownOp(err)) {
        this.unsupported = true;
        this.note("the bridge plugin has no undo.open (needs bridge 0.46.0); tool calls are not grouped");
      } else {
        // A reply lost after dispatch may still have opened the group: close it, which is harmless if it did not.
        if (err instanceof BridgeError && err.dispatched) this.open = name;
        this.note(`undo.open failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async exit(): Promise<void> {
    if (this.open === undefined) return;
    this.open = undefined;
    try {
      await this.bridge.request("undo.close", {}, this.closeTimeoutMs);
    } catch (err) {
      this.note(`undo.close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
