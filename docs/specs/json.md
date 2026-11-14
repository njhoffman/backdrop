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
| `bounce` | boolean or null | the item's own `backdrop bounce` setting; null follows `display.video_loop` (always null for images) |
| `bounce_state` | string | `off`, `ready` (the reversed half plays) or `reversing` (its copy is still being made); given where the config is known (the CLI's `--json`, the web interface) |
| `status` | `"new"`, `"kept"` or `"skipped"` | |
| `stats` | `{ library: { kinds: [{ kind, total, new, kept, skipped, pending, duration }], total }, ratings: { byRating: [skipped, 1, 2, 3], rated, orientations, changes, last }, resolutions: [{ bucket, count }], sources, queries, recent: { days, added, ratings, searches, searches_all_time, duplicates }, storage: { dirs: [{ name, path, files, bytes }], bytes, trashDays }, monitors, playback: { groups, expensive, software }, quota }`, where `monitors` is null while the daemon is stopped, else `[{ name, width, height, eligible: { video, image } }]`, and `quota` the last Pexels rate limit seen (`{ source, remaining, limit, reset }`) or null |
| `doctor` | `{ ok, failed, warned, checks: [{ group, name, status, detail, hint }] }`, where `group` is tools, display, screensaver, config, daemon, library or visualizer, `status` is ok, warn or fail, and `hint` (on some) names the fix |
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
| `mode` | `{ mode, monitor, item }`; `monitor` and `item` are null when the daemon is not running; `held` is added with the mode shown while the system load holds your choice back |
| `restack` | `{ monitors: [{ name, overlays }] }`, with `overlays` as in `status` |
| `list-images`, `list-videos` | an array of items, `[]` when nothing matches |
| `status` | `{ mode, chosen_mode, daemon: { running, pid, wallpaper, wallpaper_hidden, visualizer, compositor, load }, screensaver, smoothing, web, config_warnings, monitors: [{ name, width, height, eligible, cpu_percent, decoder, gpu_memory_bytes, visualizer, visualizers, overlays, playing }] }`, where `playing` is an item or null, `overlays` lists `{ window, name, position, geometry, colors }` bottom to top (see Overlays in `visualizer.md`), `cpu_percent`/`decoder` are the daemon's recent samples, `gpu_memory_bytes` the GPU memory the monitor's mpv held at the last health check (30 s; null until sampled or without a DRM driver that reports it), `visualizers` lists `{ instance, engine, module, pid, running, geometry }` per instance in stacking order (plus `colors`, `{ fg, fg2 }` as `#rrggbbaa`, with `palette.source: wallpaper`), and `visualizer` is the first of them or null; `config_warnings` lists the config file's unknown keys as messages; `mode` is the mode in force and `chosen_mode` the one `backdrop mode` set, which differ while the load holds images; `load` is `{ level, value, window, limit, resume_below }` with level `normal`, `image` or `off`, or null with the `load` section off; `wallpaper_hidden` is true while the active preset has `wallpaper: false`, so mpv is stopped whatever `wallpaper` says; `screensaver` is the daemon's screensaver state (`{ active, ... }`) or null while it is stopped; `smoothing` is `{ enabled, gpu, device, fallback, encoding, waiting, gate }` (`gpu` the device `display.smooth_gpu` asks for, `device` the one RIFE uses, -1 the CPU; `fallback` is `{ reason, at }` once the daemon moved a GPU job to the CPU, else null; `encoding` the item being smoothed; `waiting` the videos queued; `gate` is `{ open, low_since, load: { one, five }, cpus, idle_load, idle_minutes, stop_load }`, the load averages per CPU) or null while the daemon is stopped; `web` is the running `backdrop web` as `{ pid, port }` (never its token) or null |

Examples:

```bash
backdrop current --json | jq -r '.item.file // "nothing"'
backdrop list-videos --rated --json | jq -r '.[] | select(.playback.decoder == "software") | .path'
backdrop status --json | jq '.monitors[] | {name, cpu_percent}'
```
