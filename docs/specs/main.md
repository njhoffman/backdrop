# backdrop Specification

backdrop is a wallpaper and screensaver manager for X11. It collects images and videos from free
sources that have a public API (Pexels first) and from local folders, lets the user rate them, and
displays them as wallpaper and screensaver through mpv controlled over IPC sockets.

Detailed specs: [config.md](config.md), [database.md](database.md), [sources.md](sources.md). The pre-rename command behavior is
in [legacy-pexels-cli.md](legacy-pexels-cli.md) as reference for porting. Open work is tracked in `TODO.md`.

## Decisions

| Area | Decision |
| --- | --- |
| Display server | X11 only, via xwinwrap + mpv; Wayland is out of scope |
| Display control | mpv JSON IPC, one socket per monitor in the runtime dir; no external hooks |
| Sources | Only sites with a public API; no scraping (excludes MoeWalls, wallsflow.com) |
| Database | `node:sqlite` (built in, Node >= 22.13); new schema, no migration from pexels-cli data |
| Item state | Status (`new`/`kept`/`skipped`) lives in the database, files stay in one folder per kind |
| Skipped files | Moved to a trash folder and purged after `library.trash_days` (default 30) |
| Local imports | Copied (originals untouched), pre-approved: status `kept`, rating `library.default_import_rating` (default 2), named `local-<n>.<ext>` with numbers never reused; rescanned on every daemon start |
| Minimum quality | Nothing below `library.min_width` x `library.min_height` (1024x768, either orientation) enters the library; media below the current monitor is kept but never shown |
| Resolution | Never upscale: only media at least as large as the target monitor is selected, unless `display.allow_upscale` |
| Playback speed | One speed per video, independent of monitor orientation, applied on every play |
| Screensaver streams | YouTube and other links live in `screensaver.streams` in config, not in the media library |

## Layout

| Purpose | Default location |
| --- | --- |
| Config | `$XDG_CONFIG_HOME/backdrop/config.yaml` |
| Database | `$XDG_DATA_HOME/backdrop/backdrop.db` |
| Log | `$XDG_DATA_HOME/backdrop/backdrop.log` |
| Library files | `$XDG_DATA_HOME/backdrop/media/` |
| Trash | `$XDG_DATA_HOME/backdrop/trash/` |
| Unreviewed downloads | `$XDG_CACHE_HOME/backdrop/inbox/` |
| mpv sockets, PID file | `$XDG_RUNTIME_DIR/backdrop/` (mode 0700) |

## Display

`backdrop daemon` (foreground) or `backdrop start` (background) launches one
`xwinwrap -g <geometry> -- mpv -wid WID --no-config --input-ipc-server=<runtime>/<output>.sock ...` per active
monitor (`xrandr --listactivemonitors`, filtered by `display.monitors`) and writes `state.json` (pid, monitors,
sockets) to the runtime dir. mpv runs with `--no-config` because a personal mpv.conf (ontop, fullscreen, its own
IPC socket) would break a wallpaper.

- **Modes:** `video` (videos and GIFs, each looping until `next`) or `image` (slideshow every
  `display.image_duration` seconds). Only one mode plays at a time, on all monitors. `backdrop mode` toggles,
  `backdrop mode video|image` sets it; the mode is stored in the database and survives restarts.
- **Playlist:** shuffled eligible media (status `new` or `kept`, downloaded, at least the monitor's size), written
  as `<output>.m3u` and loaded with `loadlist`. The item last shown in the mode on that monitor goes first, so
  startup and toggling back resume it. mpv loops the playlist, and the daemon reshuffles it each time playback
  wraps from the last entry to the first (keeping the playing entry first), so no two passes repeat an order.
- **Order:** `display.order` is `shuffle` (default; play the shuffled playlist in order) or `random` (`next`,
  `skip`, `go-next` and `keep --next` pick a random entry). `--random` picks randomly for one command. A random
  pick is moved to just after the playing entry before advancing, so `prev` still returns to it.
- **Per file:** the daemon observes mpv's `path`; on each change it records the item as last shown, sets mpv's
  `brightness` to minus the item's stored dim (always, since mpv keeps it across files) and, for videos, sets
  `speed` to the stored value.
- **Commands:** `next`, `prev`, `current`, `speed <0.8|+0.1|-0.1|reset>`, `dim <0-100|+10|-10|reset>` connect to
  the socket of the monitor under the pointer (`xdotool getmouselocation`), or `--monitor <name>`. `speed` and
  `dim` apply immediately and are saved per item. Every command that switches what plays (`next`, `prev`, `skip`,
  `go-next`, `keep --next`, `mode`) prints the new item on the target monitor, read from the entry mpv marks
  current, so it shows before the file finishes loading. `--line` prints it as one aligned line instead.
- **Hotplug:** the daemon polls `xrandr --listactivemonitors` every 5 seconds and starts, stops or respawns
  per-monitor instances when outputs appear, disappear or change geometry. An empty or failed read keeps the
  current layout; a configured monitor that is unplugged is picked up again when it returns.
- **Rating:** `keep [1-3]` and `skip` use the same monitor targeting. Keep moves inbox files into `media/`
  and changes the current rating; skip removes every playlist reference before moving the file to trash,
  advancing monitors playing it. `undo` works across CLI invocations, deletes the latest rating and restores
  its exact previous path. Moving a kept file refreshes affected playlists and restarts that file from its
  beginning. Re-rating a file already in `media/` does not restart it. `go-next` checks the item is rated and
  advances the target monitor.
- **Removal:** `remove <id>` or `remove --current [--monitor <name>]` removes every occurrence of the item
  from all running playlists before deleting its file and database row. Removing a playing entry advances
  mpv; an empty playlist becomes idle. Import records and original source files remain, so unchanged
  originals are not imported again. Removal by ID also works without a running daemon.
- **Supervision:** an mpv that exits is relaunched after 1s, at most 5 times a minute per monitor. `stop` sends
  `quit`, then SIGTERM to each xwinwrap process group, SIGKILL after 2s, and removes sockets, playlists and state.

## Architecture

- `src/index.js` - `BackdropApp`: loads config, creates directories, opens the logger and database, registers commands.
- `src/config/ConfigManager.js` - YAML config with XDG defaults, deep merge, path expansion, env credentials.
- `src/database/DatabaseManager.js` - synchronous `node:sqlite` access; owns status transitions and rating history.
- `src/display/` - `MpvClient` (JSON IPC), `Monitors` (xrandr/xdotool), `Playlist` (modes, eligibility, loading),
  `Daemon` (process supervision), `DisplayControl` (CLI side of the socket commands).
- `src/sources/` - normalized `Source` contract and registry, with Pexels as the first adapter.
- `src/commands/` - all commands are ported to the new layer and registered; the old shell-hook command is removed.

## Item lifecycle

1. A source search records a `searches` row and upserts each result into `media` (status `new`, no `path`)
   with its download `variants`.
2. Download picks the smallest variant that meets the largest monitor and stores the file in the inbox,
   setting `path`, `sha256` and probed dimensions.
3. Rating: `keep N` (1-3) sets status `kept` and moves the file into `media/`; `skip` (rating 0) sets
   `skipped` and moves it to trash. `undo` deletes the latest rating, restores the previous status, and
   moves the file back.
4. Trash purge (`backdrop purge [--dry-run]`, and in the daemon at start and every 24 hours) deletes trash
   files whose skipped status is older than `trash_days`; `0` disables it. The media row and ratings stay
   with `path` set to null, so searches do not offer the item again and its skip can no longer be undone.
   Only files inside `trash/` are deleted.
5. Local import (`backdrop import [dirs...]`, and on every daemon start for `library.import_dirs`):
   - Walks the directories recursively, skipping hidden paths, non-media extensions and backdrop's own
     `media/` and `trash/`.
   - Skips files whose size and mtime match the last attempt (`imported_files`), so rescans only stat files.
   - Hashes the rest (SHA-256); known content is recorded as a duplicate.
   - Probes with ffprobe for kind (image, gif, video), dimensions (rotation-corrected) and duration; files
     without a picture are unsupported, files below the minimum are too_small.
   - Copies the file to `media/local-<n>.<ext>` and adds the media row plus a `default_import_rating`
     rating in one transaction.
   - Every outcome is recorded per source path, so deleting an item from the library does not bring it
     back on the next scan. The daemon runs the scan in the background after playback starts and
     appends new items to running playlists with `append-play`.
