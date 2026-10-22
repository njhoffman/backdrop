# backdrop Specification

backdrop is a wallpaper and screensaver manager for X11. It collects images and videos from free
sources that have a public API (Pexels first) and from local folders, lets the user rate them, and
displays them as wallpaper and screensaver through mpv controlled over IPC sockets.

Detailed specs: [config.md](config.md), [database.md](database.md). The pre-rename command behavior is
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
| Local imports | Pre-approved: status `kept`, rating `library.default_import_rating` (default 2), renamed `local-<n>.<ext>` with numbers never reused |
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

## Architecture

- `src/index.js` - `BackdropApp`: loads config, creates directories, opens the logger and database, registers commands.
- `src/config/ConfigManager.js` - YAML config with XDG defaults, deep merge, path expansion, env credentials.
- `src/database/DatabaseManager.js` - synchronous `node:sqlite` access; owns status transitions and rating history.
- `src/commands/` - one class per command, constructed with `(config, database, logger)`. The files there today
  are the pre-rename commands; none are registered until ported to the new layer.

## Item lifecycle

1. A source search records a `searches` row and upserts each result into `media` (status `new`, no `path`)
   with its download `variants`.
2. Download picks the smallest variant that meets the largest monitor and stores the file in the inbox,
   setting `path`, `sha256` and probed dimensions.
3. Rating: `keep N` (1-3) sets status `kept` and moves the file into `media/`; `skip` (rating 0) sets
   `skipped` and moves it to trash. `undo` deletes the latest rating, restores the previous status, and
   moves the file back.
4. Trash purge deletes files and rows whose skipped status is older than `trash_days`.
5. Local import hashes each file, skips known hashes, copies it to `media/` as `local-<n>.<ext>`, and adds a
   rating of `default_import_rating`.
