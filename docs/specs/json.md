# JSON output

`--json` prints one JSON document on stdout for scripts, status bars and custom menus. Every other line a
command prints (status messages, warnings, the playlist export notice) goes to stderr, so
`backdrop current --json | jq` always parses. `--json` cannot be combined with `--line` or `--header`, nor
with `--interactive` on the lists.

New fields may be added; existing fields keep their names and types. Internal columns (download variants,
content hashes, duplicate links) are not part of the format.

## Item

A library item, as printed by every command below.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | library id, used by `remove` |
| `kind` | `"video"`, `"gif"` or `"image"` | |
| `source` | string | `local`, `pexels`, ... |
| `path` | string or null | the library file; null before download or after a purge |
| `file` | string or null | the original file name for local imports, else the library file's name |
| `width`, `height` | number | pixels, rotation applied |
| `orientation` | `"landscape"`, `"portrait"`, `"square"` or null | from the size |
| `duration` | number or null | seconds; null for images |
| `fps` | number or null | null for images and videos not probed or played yet |
| `speed` | number | playback speed, 1 by default |
| `dim` | number | 0 (none) to 100 (black) |
| `status` | `"new"`, `"kept"` or `"skipped"` | |
| `rating` | object or null | `{ value, orientation, at }`: 0 (skip) to 3, the orientation of the monitor it was given on, UTC time |
| `tags` | string[] | derived from the file name, page and description |
| `queries` | string[] | searches that found the item |
| `playback` | object or null | `{ cpu_percent, seconds, decoder }`: mpv's average CPU (percent of one core) over the seconds sampled, and the last decoder (`vaapi` and the like, or `software`); fields are null until sampled |
| `author`, `page_url` | string or null | attribution |

## Commands

| Command | Document |
| --- | --- |
| `current` | `{ monitor: { name, width, height }, item }`; `item` is null when nothing from the library plays |
| `next`, `prev`, `skip`, `go-next`, `keep --next` | the same, for the item the monitor now plays |
| `keep` (without `--next`) | `{ item }`: the rated item with its new rating |
| `mode` | `{ mode, monitor, item }`; `monitor` and `item` are null when the daemon is not running |
| `list-images`, `list-videos` | an array of items, `[]` when nothing matches |
| `status` | `{ mode, daemon: { running, pid, wallpaper, visualizer }, monitors: [{ name, width, height, eligible, cpu_percent, decoder, visualizer, visualizers, playing }] }`, where `playing` is an item or null, `cpu_percent`/`decoder` are the daemon's recent samples, `visualizers` lists `{ instance, engine, module, pid, running, geometry }` per instance in stacking order, and `visualizer` is the first of them or null |

Examples:

```bash
backdrop current --json | jq -r '.item.file // "nothing"'
backdrop list-videos --rated --json | jq -r '.[] | select(.playback.decoder == "software") | .path'
backdrop status --json | jq '.monitors[] | {name, cpu_percent}'
```
