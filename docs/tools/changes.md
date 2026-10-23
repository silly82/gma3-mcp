# Show-data changes: `gma3_changes`

Read-only, needs bridge 0.46.0 (ops `changes.since`, `changes.watch`). Source: `src/tools/changes.ts`.

The bridge hooks every data pool pool, every preset pool and every sequence (`HookObjectChange`) the first time a client
asks, and keeps the last 256 changes in a ring with increasing `seq` numbers. `gma3_changes` reads that ring after a
cursor, so an agent or a client can tell what to re-read instead of reading everything again.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `cursor` | The `cursor` a previous call returned (default 0: everything the bridge still holds) |
| `instance` | The `instance` a previous call returned; a different one means the bridge restarted |
| `wait_ms` | 0-30000 (default 0). When nothing is new, wait up to this long for a change (long poll) |
| `limit` | 1-256 changes per call (bridge default 200) |

## Result

`{ instance, cursor, latest, count, changes, missed, restarted, hooks, waited_ms?, notes?, next }`.
Each change: `{ seq, kind, key, name, no, what, change, count, t }`:

- `kind`: `pool` (key `pool:<name>`), `presetPool` (`presets:<no>`) or `sequence` (`sequence:<no>`).
- `what`: `children` (change 10: a store or delete in a pool, a stored preset, a Store Cue in a sequence) or `object`
  (change 11: a label or another property of the hooked object). `count`: a burst on one object (a batch of stores)
  is one entry.

Pass `cursor` and `instance` back next time.

## What it reports and what not

- Seen live on onPC 2.5.1: stores, deletes and labels in pools, stored presets, Store Cue.
- Not covered: playback (Go, faders, running cues), the programmer and the selection fire no change. Use
  `gma3_executors` / `gma3_sequences` for playback state (or the HTTP `state` events).
- The sequence hooks follow the Sequences pool (resynced after a store or delete there).

## Restart, missed entries, older bridges

- A bridge restart starts `seq` at 1 again with a new `instance`. When the `instance` passed differs, or the cursor is
  ahead of the bridge's `latest`, the tool reads from 0 again, sets `restarted: true` and says so in `notes`: re-read
  anything cached.
- `missed: true`: changes after the cursor were dropped from the ring before this read; re-read the pools you care
  about.
- An older bridge (`unknown op`): the error "gma3_changes needs bridge 0.46.0".

## Long poll

With `wait_ms` and nothing new, the tool re-reads `changes.since` every 250 ms, and at once when a pushed
`{"event":"changes"}` line arrives on the connection (when the HTTP events stream watches, see
[http-api.md](../http-api.md#show-data-changes)). It never calls `changes.watch` itself: the watch belongs to the
connection and the events stream may hold it. A restart during the wait is detected by the instance.

## Tests

`test/changes.test.ts` (FakeBridge with `push()`): cursor and limit, a push ending the wait before the next poll,
polling and the timeout, a new instance and a cursor ahead of `latest`, `missed`, the older-bridge error, and the
HTTP `changes` events with re-watch after a reconnect and a new instance.
