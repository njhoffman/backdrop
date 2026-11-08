# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## Project

backdrop (formerly pexels-cli): an X11 wallpaper and screensaver manager that collects media from
API-based sources and local folders and displays it through mpv IPC sockets. It is mid-rewrite: the
config, database, display, local import and legacy commands have been ported. The first source adapter
is Pexels; more sources and screensaver playlists remain. Design decisions are in `docs/specs/main.md`;
the roadmap is `TODO.md`.

## Development Commands

```bash
npm test                 # Mocha, test/**/*.test.js (spec reporter, ~840 lines)
npm run test:brief       # same run with the dot reporter (~30 lines); agents use this
npx mocha test/display/Playlist.test.js  # one file while iterating
node src/index.js --help # run the CLI
npm link                 # install the `backdrop` binary globally
```

To run the CLI without touching your real config or data, point the XDG variables at a scratch
directory: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`. Keep `XDG_RUNTIME_DIR`
short: mpv socket paths must fit in 107 bytes. `test/helpers/setup.js` does this for the whole test run (removed
afterwards), and `makeConfig()` in `test/helpers/fakes.js` points `paths.runtime`
at a missing directory, so a test never reaches a running daemon; tests that need state set their own. `test/display/mpv.integration.test.js` runs a headless mpv
and is skipped when mpv or ffmpeg is missing. `test/commands/menu.integration.test.js` draws the menus with real rofi on its own Xvfb
(skipped without Xvfb, rofi, xdotool or ImageMagick's `import`); `test/display/hotplug.integration.test.js` changes the resolution of an Xephyr nested in Xvfb under a real daemon
(add and remove cannot be simulated there), and `test/display/stacking.integration.test.js` runs
a real daemon there with a stand-in visualizer window (Daemon's `createVisualizer` option), since GLava opens no
window under Xvfb. `test/web/pages.browser.test.js` loads every web page in headless Chrome through `playwright-core` (a devDependency
that downloads no browser) against stand-in services, failing on any script error, failed request or content security
policy violation; it is skipped without Chrome or Chromium installed. `test/sources/pexels.live.test.js` calls the real Pexels API only with `BACKDROP_LIVE_TESTS=1` and
`PEXELS_API` set (three requests); routine runs skip it.

Requires Node.js 22.13+ (built-in `node:sqlite`).

## Workflow

- Run the tests before every commit; routine tests stay offline and never touch the user's XDG data.
- Keep tool output small, it all lands in the context: run `npm run test:brief` (failures still print in
  full) or one file with `npx mocha <file>`, never the spec run; pipe long commands through `tail`/`grep`;
  read `TODO.md` (60 KB), `CHANGELOG.md` (30 KB) and large sources such as `test/display/Daemon.test.js` with
  Read offset/limit or `grep -n`, not `cat`; use `git diff --stat` before a full diff.
- A one-off mpv with `--idle` outlives its socket directory: start it through `startMpv` (`test/helpers/mpv.js`), or in shell end it with `trap 'kill $pid' EXIT`.
- Tests must not print: stub `console.log`/`console.error` with sinon (restored in `afterEach`) when a test
  drives a command that writes output.
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
  are not written to the file. `set()` changes values in memory only; `setInFile()` is the one way to write an
  existing config, splicing a single key so comments and layout survive.
  `loadConfig()` collects `warnings` for keys the defaults do not have (`unknownKeys`), so every new config key
  needs a default in `getUserDefaults()` or it is reported as unknown, and a check with its form info in
  `src/config/schema.js` (`field(check, { kind, help, ... })`, listed by `configFields()` for the web Config page).
  `removeInFile()` drops a key's lines (`removeYaml`), and a mapping it leaves empty.
- **DatabaseManager** (`src/database/DatabaseManager.js`) - synchronous `node:sqlite`. Tables: `media`,
  `media_tags` (derived by `src/library/tags.js`), `ratings`, `searches`, `search_results`, `sequences`. Schema version in `PRAGMA user_version`. Status
  (`new`/`kept`/`skipped`) is derived from the latest rating inside the same transaction.
- **Logger** (`src/utils/Logger.js`) - Winston, file plus errors to console.
- **Notifications** (`src/utils/notify.js`) - `notify-send` per monitor; tests swap the exec through
  `configureNotify` in `test/helpers/setup.js`, so nothing is sent.
- **Output** (`src/utils/output.js`) - all user-facing output goes through `out`, `fmt` and `ProgressBar`
  (`ignoreClosedPipes()` drops lines to a closed pipe instead of crashing on EPIPE);
  `printMedia` (`src/utils/mediaView.js`) prints a media item with icons, size, duration, path and queries.
  Print paths through `displayPath()` (`~` on a terminal, full path when piped).
  Styling, symbols, the version line and progress bars appear only on a terminal; piped output stays plain.
  Tests run with `configureOutput({ interactive: false })` from `test/helpers/setup.js`.
- **Display** (`src/display/`) - `Daemon` keeps its own concerns in `src/display/daemon/` (`ControlRequests`,
  `ConfigChanges`, `WallpaperColors`, `Health`, `ImportWatcher`): classes given the daemon, whose state stays on it, with the daemon's
  methods forwarding to them; runtime file paths are in `runtimeFiles.js`. It records every child it spawns in `children.json` (`src/display/children.js`,
  pid, process group and `/proc` start time) so `start` and `stop` can end what a crashed daemon left running;
  it runs one xwinwrap+mpv per monitor and writes `state.json` to the
  runtime dir; it restarts mpv on exit or on failed IPC health checks, follows monitor hotplug by polling
  xrandr, drops entries that fail to load, reapplies per-item speed and dim on each load (and counts the video limit again from mpv's `time-pos` when the speed changes mid-play), and purges expired
  trash daily (`src/library/purge.js`), reshuffles the playlist on wrap, limits video play time with per-file
  `loop-file`/`end`, records frame rates from mpv, samples mpv CPU and decoder on each health check (`src/display/cpu.js`,
  `playback_stats`), writes `state.json` atomically and, with `display.notify: all`, notifies on every load; `DisplayControl` is the CLI side, connecting to the mpv socket of the monitor under the pointer, and `switchTo` reports the entry a change made current;
  The daemon keeps active monitors (`monitors`) apart from their wallpaper processes (`screens`), so the wallpaper
  can be off (`start/stop --wallpaper`) while the visualizer runs; the CLI writes one `control-<id>.json` per request (`src/display/control.js`) and sends SIGUSR1, waiting for its id in `state.json` `handled`,
  and `state.json` monitors have a null `socket` while the wallpaper is off.
  `Playlist` owns modes (video/image) and eligibility, loading items with one `loadfile` each (no m3u) through
  `loadMedia` (`src/display/prescale.js`), which gives images far larger than the monitor a per-file `vf` scale so mpv's
  GPU memory stays bounded (mpv 0.40 has no IPC hooks); the health check also reads mpv's GPU memory (`src/display/gpu.js`); `MpvClient` is the JSON IPC client. `nextFilters.js` keeps
  the filters and order `next`/`menu` were given in `next-filters.json` in the runtime dir, tagged with the daemon's
  pid (the daemon removes it on start and stop), updated under `next-filters.lock` (`src/utils/fileLock.js`, which `importLock.js` also builds on); `next`, `keep --next`, `skip` and `go-next` fill in from it.
  It also holds `--image-duration`/`--video-duration`, which the daemon applies itself: the CLI sends a
  `{ durations: true }` control request (`src/display/control.js`) when they change. External tools
  (`xrandr`, `xdotool`, spawn, kill, mpv connect) are injected so tests use fakes (`test/helpers/fakes.js`).
  With the `load` section, `src/display/LoadGovernor.js` (only levels, from `os.loadavg()`) and `daemon/LoadShedding.js` drop to images and then
  stop the wallpaper and visualizer under load. The hold is apart from the user's choices: `getMode` returns the `mode_hold` setting over the
  chosen mode (`getChosenMode`), `displayMode` gives a monitor's mode, and `daemon.wallpaper` stays the user's (`showsWallpaper` adds the load).
- **Bounce** (`src/display/bounce.js`, `daemon/Bounce.js`, `src/library/reverse.js`) - `display.video_loop: bounce` or
  `media.bounce` (schema v10, `backdrop bounce`) plays a video and its reversed copy as one `edl://` entry; mpv
  reports that URL as the path, so compare mpv filenames with library paths through `entryPath`, and load items
  with `playUrl`. The daemon reverses an item on its first play and the next entry ahead, one at a time at the normal load level.
- **Smoothing** (`src/library/smooth.js`, `daemon/Smooth.js`) - `display.smooth` makes RIFE copies of slowed videos
  at `smooth_fps`, one at a time, playing them through an EDL URL tagged with the library path (`backdrop_path`,
  read by `entryPath`; `forwardPath` gives the file mpv plays, `playsBounce` whether a reversed half follows). Mpv
  blends frames for a slowed video meanwhile. A speed change sends an `item` control request so the copy follows.
- **Screensaver** (`src/display/daemon/Screensaver.js`) - the daemon's mode, asked for through a control request by `ScreensaverCommand`; see `docs/specs/main.md`.
- **Visualizer** (`src/visualizer/`) - an optional GLava music visualizer per monitor, above the wallpaper; see
  `docs/specs/visualizer.md`. `settings.js` checks the `visualizer` section and resolves placement; engines are
  adapters (`index.js`, `GlavaVisualizer`, `SleeveVisualizer`, `ProjectmVisualizer`, one per instance, `engine` per instance) with `prepare()` and `command(monitor, geometry)`, sleeve's also `display()` (`sleeve ctl display`) and `colorLines()`;
  the section holds `instances` (defaults from the section itself) and `presets` (`presets.js` ships built-in ones,
  laid over with `deepMerge`); `audio.js` follows `pactl subscribe` for `only_while_playing`; `VisualizerManager`
  owns the processes and places each window directly above its monitor's wallpaper with its opacity
  (`src/display/x11.js`, the `x11` package) after every visualizer or wallpaper start. SIGHUP (`backdrop visualizer reload`) re-reads only that section. A saved change to the config
  file (`Daemon.watchConfig`, `applyConfigChange`) loads and checks the whole file again (`readConfig`), keeping every
  running setting and notifying on a mistake; it restarts the visualizer when its section changed and applies other
  settings by kind (`LIVE_SETTINGS`: taken in, durations, playlist reload, monitors, imports), notifying for ones
  that need a restart.
  With `palette.source: wallpaper` (`palette.js`) the daemon samples each load and the manager pipes `fg`/`fg2` colors to
  GLava's stdin, one line per 100 ms (`colorsFor`, `recolor`).
- **Library** (`src/library/`) - `Importer` copies local media in as `local-<n>.<ext>`, tracking each source
  file in `imported_files` by size/mtime; it hashes and probes several files at once (`src/utils/pool.js`) but adds them
  in path order, and runs one import at a time across processes (`importLock.js`: the CLI waits, the daemon skips);
  with `library.watch_imports` the daemon's `ImportWatcher` imports again when a folder changes; `probe.js` wraps ffprobe (kind, rotation-corrected size, duration); `match.js` turns `--query`/`--tag`/`--keywords`
  into `findMedia` filters for `pending`, `download`, the lists and `next`.
- **Sources** (`src/sources/`) - `Source` defines normalized search/metadata/download variants and rate limits;
  `SourceRegistry` resolves adapters, with `PexelsSource` first. Credentials are checked on API requests only.
  Search/download share monitor-aware selection in `src/library/quality.js`; see `docs/specs/sources.md`.
- **Services** (`src/services/`) - `RatingService` (keep, skip, undo, go-next, rate), `DisplayService` (start, stop,
  parts, next, prev, mode, speed/dim/bounce, status, durations) and `LibraryService` (the web Library page: paged
  lists with the list filters, rating and adjusting any item, playing one on a monitor) and `VisualizerService`
  (looks, live changes, presets and saving them, shared by the rofi menu and the web page; with `reload` it reads the
  visualizer section again on each call, for the long-running web server) and `ConfigService` (the Config page:
  fields with values, defaults and when they apply, changes checked with the whole config, resets) and
  `StatsService` (what `stats` prints, as data; `stats --json`) do the work. `DoctorCommand.check()` returns the
  checks without printing, for the web Status page and return data, never printing: playlist failures
  after a committed rating come back as `warnings`, and a failure after one carries `error.done`. `RatingCommand`
  and `DisplayCommand` print their results (their `control` forwards to the service's); the menu calls the services
  directly and drops their results (`done`), since an action's result is its next state. The web interface will
  call them too (`docs/specs/web.md`).
- **Web** (`src/web/`, `share/web/`) - `backdrop web` (`WebCommand`, its own process; `docs/specs/web.md`): `WebServer`
  on `node:http` bound to 127.0.0.1 (a taken `web.port` falls back to a free one), routes calling the services,
  `auth.js` (a per-run token swapped for an HttpOnly cookie, the token header on changes, Host and Origin checked),
  `EventHub` (server-sent snapshots on `state.json` changes and mpv `path`/`speed`/`contrast` changes), and
  `web.json` (`{ pid, port, token }`, 0600) in the runtime dir. The page is plain HTML and ES modules with no build,
  under a strict content security policy (no inline script or style).
- **Commands** (`src/commands/`) - one class per command, constructed with `(config, database, logger)`.
  All are registered. `RatingCommand` uses `DisplayControl.current()` and records file movements for persistent
  undo (schema v4; v5 adds per-item `dim`; v6 adds `duplicate_of`; v7 adds `fps` and `media_tags`; v8 adds `playback_stats`; v9 adds `ratings.final`, which undo skips; v10 adds `media.bounce`); failed database writes restore the file. The obsolete shell-hook command has been removed.
  Lists support plain output, interactive rating and M3U export; stats work offline. Terminal prompts go through
  `ask()` (`src/utils/prompts.js`, `@inquirer/prompts`; Ctrl-C answers null), with `select`/`input` injected for tests. `MenuCommand` drives the
  rating and display commands from `rofi -dmenu`, and the visualizer (`menu visualizer` or `z`: live `visualizer_set`
  control requests, presets saved with `ConfigManager.setInFile`, which splices lines and keeps comments); it builds menus as data and draws them with `panelView`
  (theme `share/rofi/backdrop-panel.rasi`, thumbnails from `src/library/thumbnail.js` in `paths.thumbnails`,
  which the daemon also makes on each load) or `minimalView`; with i3 it shows an empty workspace while open
  (`src/utils/workspace.js`, `menu.workspace`); views bind entry keys to `-kb-custom-N` and resolve
  to an index, `{ key }` or null; tests inject a `view`. `--json` goes through `mediaJson`/`playingJson` (`src/utils/mediaView.js`,
  format in `docs/specs/json.md`) and `setJsonOutput`, which moves every other stdout line to stderr.
  `SystemdCommand` prints a user unit like `CompletionCommand` prints scripts (which complete `--query`/`--tag` from the
  database with `sqlite3`, or the hidden `complete-values` command without it). `DoctorCommand` only reads: tools, X,
  config (loaded tolerantly for it, `initialize({ tolerant })`), daemon state and `findOrphans`, and the library.

## Conventions

- File status lives in the database; files sit in `media/`, `trash/` or the inbox, never in per-status folders.
- Only sources with a public API; no scraping.
- Never select media smaller than the target monitor unless `display.allow_upscale` is set.
- One playback speed per video and one dim level per item, regardless of orientation.
