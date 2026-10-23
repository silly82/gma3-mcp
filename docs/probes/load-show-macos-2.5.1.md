# Load-show probe: loading a show (macOS, onPC 2.5.1)

Evidence for `gma3_load_show` ([docs/tools/show.md](../tools/show.md#gma3_load_show)) and the bridge op `show.load`
(0.45.0).

- **Date:** 2026-10-23
- **Platform:** macOS (Darwin 27.2), grandMA3 onPC 2.5.1.0, bridge 0.38.2 (the version stored in the shows used)
- **Method:**
  - raw `LoadShow "<name>"` and `NewShow "<name>"` sent through `gma3_command` (`Cmd` on the plugin thread);
  - the dialogs read from the screen and answered by hand;
  - the bridge restarted after each load by typing `Plugin "gma3_mcp_bridge"` at the console (keystrokes).
- **Show files:** copies of the operator's `saisonstart` show only; the original was not loaded or saved.

## Loading unloads the bridge

| Observation | Result |
| --- | --- |
| `LoadShow "<name>"` through `gma3_command` | the request timed out after 15 s; the bridge never answered again |
| Why | loading a show unloads the show's plugins, this bridge included: plugins are show data |
| The old TCP socket afterwards | stays open without answers (`ping`: "timeout after 4000ms") |
| Later connects | `ECONNREFUSED` until the plugin is started again |
| Plugin autostart on show load | none in onPC 2.5.1 (none found in the manual or the bridge docs) |

The answer to the request that queues the load is the last one the old bridge sends. Every check after the load
needs a fresh connection.

## Dialogs

| Command | Dialog | Answer and result |
| --- | --- | --- |
| `NewShow "<name>"` | "Create New Show" / "Do you want to create a new show named '<name>'?", New Show / Cancel | New Show creates the show |
| `LoadShow "<other>"`, current show has unsaved changes | "Warning" / "Show file '<current>' has changed.\nDo you want to save the old show file first?", Save / Do not save / Cancel | Save saved the old show, then loaded |
| `LoadShow "<other>"`, no unsaved changes | none | loads at once |

## Restarting the bridge

- Typing `Plugin "gma3_mcp_bridge"` at the console started the bridge in about 1 s in a show that contains the
  plugin.
- A macro stored in the show works as a one-tap start: Macro 100 with the line `Plugin "gma3_mcp_bridge"`, run with
  `Go+ Macro 100`.

## Open items

Not live-tested yet:
- the bridge op `show.load` (LoadShow queued with `CmdIndirect`) and `gma3_load_show` itself, including its
  unsaved-changes answers through `dialog.press`;
- the keystroke restart (`src/keystroke.ts`: System Events types `Plugin "gma3_mcp_bridge"` into `app_gma3`) through
  the tool; typing that line by hand after a load was used throughout this session;
- the OSC restart path (the mechanism of `gma3_start_bridge`, `Plugin "gma3_mcp_bridge"` over `/cmd`) right after a
  load. It depends on the loaded show's OSC input settings (Enable Input, Receive Command).

The tool's behaviour is covered by `test/load-show.test.ts` against the fake bridge only.
