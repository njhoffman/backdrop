# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## Project

backdrop (formerly pexels-cli): an X11 wallpaper and screensaver manager that collects media from
API-based sources and local folders and displays it through mpv IPC sockets. It is mid-rewrite: the
config, database, display, local import and legacy commands have been ported. The first source adapter
is Pexels; more sources and the screensaver remain. Design decisions are in `docs/specs/main.md`;
the roadmap is `TODO.md`.

## Development Commands

```bash
npm test                 # Mocha, test/**/*.test.js
node src/index.js --help # run the CLI
npm link                 # install the `backdrop` binary globally
```

To run the CLI without touching your real config or data, point the XDG variables at a scratch
directory: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`. Keep `XDG_RUNTIME_DIR`
short: mpv socket paths must fit in 107 bytes. `test/helpers/setup.js` does this for the whole test run (removed
afterwards), and `makeConfig()` in `test/helpers/fakes.js` points `paths.runtime`
at a missing directory, so a test never reaches a running daemon; tests that need state set their own. `test/display/mpv.integration.test.js` runs a headless mpv
and is skipped when mpv or ffmpeg is missing. `test/commands/menu.integration.test.js` draws the menus with real rofi on its own Xvfb
(skipped without Xvfb, rofi, xdotool or ImageMagick's `import`).

Requires Node.js 22.13+ (built-in `node:sqlite`).

## Workflow

- Run `npm test` before every commit; routine tests stay offline and never touch the user's XDG data.
- Semantic versioning in `package.json`, with an annotated `vX.Y.Z` tag per release. Bump once per
  finished change: patch for fixes, minor for features, major for breaking changes.
- Keep `CHANGELOG.md` (Keep a Changelog) current: entries go under `## [Unreleased]` and move into the
  new version's section on a bump. Write them for users of the CLI, not as a commit log.
- Keep `TODO.md` current: add bugs, risks and improvements you notice as
  `- [ ] **Title.** (pN) [category] summary` under the right project, and tick items off when done.

## Architecture

- **BackdropApp** (`src/index.js`) - loads config, creates directories, opens logger and database, registers
  commands. Commander's exits go through `exitOverride()` so the database always closes.
- **ConfigManager** (`src/config/ConfigManager.js`) - YAML at `$XDG_CONFIG_HOME/backdrop/config.yaml`.
  Sections: `sources`, `library`, `display`, `screensaver`, plus `paths` that default to XDG locations and
  are not written to the file. `save()` writes only user-set values (`userConfig`), never env credentials.
  `loadConfig()` collects `warnings` for keys the defaults do not have (`unknownKeys`), so every new config key
  needs a default in `getUserDefaults()` or it is reported as unknown.
- **DatabaseManager** (`src/database/DatabaseManager.js`) - synchronous `node:sqlite`. Tables: `media`,
  `media_tags` (derived by `src/library/tags.js`), `ratings`, `searches`, `search_results`, `sequences`. Schema version in `PRAGMA user_version`. Status
  (`new`/`kept`/`skipped`) is derived from the latest rating inside the same transaction.
- **Logger** (`src/utils/Logger.js`) - Winston, file plus errors to console.
- **Notifications** (`src/utils/notify.js`) - `notify-send` per monitor; tests swap the exec through
  `configureNotify` in `test/helpers/setup.js`, so nothing is sent.
- **Output** (`src/utils/output.js`) - all user-facing output goes through `out`, `fmt` and `ProgressBar`;
  `printMedia` (`src/utils/mediaView.js`) prints a media item with icons, size, duration, path and queries.
  Print paths through `displayPath()` (`~` on a terminal, full path when piped).
  Styling, symbols, the version line and progress bars appear only on a terminal; piped output stays plain.
  Tests run with `configureOutput({ interactive: false })` from `test/helpers/setup.js`.
- **Display** (`src/display/`) - `Daemon` records every child it spawns in `children.json` (`src/display/children.js`,
  pid, process group and `/proc` start time) so `start` and `stop` can end what a crashed daemon left running;
  it runs one xwinwrap+mpv per monitor and writes `state.json` to the
  runtime dir; it restarts mpv on exit or on failed IPC health checks, follows monitor hotplug by polling
  xrandr, drops entries that fail to load, reapplies per-item speed and dim on each load, and purges expired
  trash daily (`src/library/purge.js`), reshuffles the playlist on wrap, limits video play time with per-file
  `loop-file`/`end`, records frame rates from mpv, samples mpv CPU and decoder on each health check (`src/display/cpu.js`,
  `playback_stats`), writes `state.json` atomically and, with `display.notify: all`, notifies on every load; `DisplayControl` is the CLI side, connecting to the mpv socket of the monitor under the pointer, and `switchTo` reports the entry a change made current;
  The daemon keeps active monitors (`monitors`) apart from their wallpaper processes (`screens`), so the wallpaper
  can be off (`start/stop --wallpaper`) while the visualizer runs; the CLI writes `control.json` and sends SIGUSR1,
  and `state.json` monitors have a null `socket` while the wallpaper is off.
  `Playlist` owns modes (video/image) and eligibility; `MpvClient` is the JSON IPC client. `nextFilters.js` keeps
  the filters and order `next`/`menu` were given in `next-filters.json` in the runtime dir, tagged with the daemon's
  pid (the daemon removes it on start and stop); `next`, `keep --next`, `skip` and `go-next` fill in from it.
  It also holds `--image-duration`/`--video-duration`, which the daemon applies itself: the CLI sends a
  `{ durations: true }` control request (`src/display/control.js`) when they change. External tools
  (`xrandr`, `xdotool`, spawn, kill, mpv connect) are injected so tests use fakes (`test/helpers/fakes.js`).
- **Visualizer** (`src/visualizer/`) - an optional GLava music visualizer per monitor, above the wallpaper; see
  `docs/specs/visualizer.md`. `settings.js` checks the `visualizer` section and resolves placement; engines are
  adapters (`index.js`, `GlavaVisualizer`, one per instance) with `prepare()` and `command(monitor, geometry)`;
  the section holds `instances` (defaults from the section itself) and `presets` (`presets.js` ships built-in ones,
  laid over with `deepMerge`); `audio.js` follows `pactl subscribe` for `only_while_playing`; `VisualizerManager`
  owns the processes and places each window directly above its monitor's wallpaper with its opacity
  (`src/display/x11.js`, the `x11` package) after every visualizer or wallpaper start. SIGHUP (`backdrop visualizer reload`) re-reads only that section, as does a saved change to the config
  file (`Daemon.watchConfig`, which keeps the running visualizer and notifies on a mistake).
  With `palette.source: wallpaper` (`palette.js`) the daemon samples each load and the manager pipes `fg`/`fg2` colors to
  GLava's stdin, one line per 100 ms (`colorsFor`, `recolor`).
- **Library** (`src/library/`) - `Importer` copies local media in as `local-<n>.<ext>`, tracking each source
  file in `imported_files` by size/mtime; `probe.js` wraps ffprobe (kind, rotation-corrected size, duration); `match.js` turns `--query`/`--tag`/`--keywords`
  into `findMedia` filters for `pending`, `download`, the lists and `next`.
- **Sources** (`src/sources/`) - `Source` defines normalized search/metadata/download variants and rate limits;
  `SourceRegistry` resolves adapters, with `PexelsSource` first. Credentials are checked on API requests only.
  Search/download share monitor-aware selection in `src/library/quality.js`; see `docs/specs/sources.md`.
- **Commands** (`src/commands/`) - one class per command, constructed with `(config, database, logger)`.
  All are registered. `RatingCommand` uses `DisplayControl.current()` and records file movements for persistent
  undo (schema v4; v5 adds per-item `dim`; v6 adds `duplicate_of`; v7 adds `fps` and `media_tags`; v8 adds `playback_stats`; v9 adds `ratings.final`, which undo skips); failed database writes restore the file. The obsolete shell-hook command has been removed.
  Lists support plain output, interactive rating and M3U export; stats work offline. `MenuCommand` drives the
  rating and display commands from `rofi -dmenu`, and the visualizer (`menu visualizer` or `z`: live `visualizer_set`
  control requests, presets saved with `ConfigManager.setInFile`, which splices lines and keeps comments); it builds menus as data and draws them with `panelView`
  (theme `share/rofi/backdrop-panel.rasi`, thumbnails from `src/library/thumbnail.js` in `paths.thumbnails`,
  which the daemon also makes on each load) or `minimalView`; with i3 it shows an empty workspace while open
  (`src/utils/workspace.js`, `menu.workspace`); views bind entry keys to `-kb-custom-N` and resolve
  to an index, `{ key }` or null; tests inject a `view`. `--json` goes through `mediaJson`/`playingJson` (`src/utils/mediaView.js`,
  format in `docs/specs/json.md`) and `setJsonOutput`, which moves every other stdout line to stderr.
  `SystemdCommand` prints a user unit like `CompletionCommand` prints scripts.

## Conventions

- File status lives in the database; files sit in `media/`, `trash/` or the inbox, never in per-status folders.
- Only sources with a public API; no scraping.
- Never select media smaller than the target monitor unless `display.allow_upscale` is set.
- One playback speed per video and one dim level per item, regardless of orientation.
