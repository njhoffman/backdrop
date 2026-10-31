# TODO

Roadmap for turning pexels-cli into **backdrop**: a source-agnostic wallpaper and screensaver
manager that displays everything through mpv IPC sockets. Section 1 covers bugs found while
surveying the current code; the remaining sections are the planned redesign, roughly in
dependency order.

Reviewed: 2026-10-30

## 1. Existing bugs and tech debt

- [x] **CLI crashes on startup: ImportCommand.js is empty.** (p1) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); rewritten in project 5. `src/commands/ImportCommand.js` is 0 bytes, but `src/index.js` imports `{ ImportCommand }` from it.
      ES module linking fails, so every command dies, not just `import`. The 1.1.0 changelog describes
      an implemented import command, so the file was likely lost; rewrite it (see project 5) or recover it.
- [x] **addVideo/addImage insert into renamed tables.** (p1) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); tables replaced by the new schema in project 2. `src/database/DatabaseManager.js:139,166` still use `INSERT INTO videos` / `INSERT INTO images`.
      The tables were renamed to `pexel_videos` / `pexel_images` in 1.1.1, so every new search result fails to save.
      `addVideo` also lists a removed `ratings` column (13 columns, 12 values). Fix the SQL and add tests that insert.
- [x] **undo leaves the rating in the database.** (p2) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); rating commands reworked in project 3; the new undo must delete the rating row. `src/commands/RatingCommand.js:119-122` moves the file back but only comments that the rating should be removed.
      Stats and `--rated` lists stay wrong after undo. Add `DatabaseManager.removeRating()` and call it.
- [x] **Filename-to-id parsing breaks on dotted names.** (p2) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); the current file comes from mpv in project 3, so filename parsing goes away. `src/commands/HookCommand.js:89` uses `basename.split('.')[0]`.
      A file like `ocean.waves.4k.mp4` resolves to `ocean`. Use `path.parse(name).name`.
- [x] **Hard-coded CLI version.** (p3) [bug] `src/index.js` passes `.version('1.0.0')` while `package.json` is 1.1.1. Now read from `package.json`.
- [x] **Startup requires every hook and the API key for all commands.** (p2) [refactor] `validateConfig()` in `src/index.js` exited if any hook or `api_key` was missing, even for `list` or `stats`.
      Removed with the hooks; ported commands must check the credentials they need (e.g. the Pexels source checks its own key).
- [x] **No tests for commands.** (p2) [test] Search, download, rating, import, removal, lists and stats have command tests;
      CLI subprocess tests cover registration, offline operation and failing exit codes. Real mpv tests cover rating and playback transitions.
- [x] **Changelog lives in docs/specs.** (p3) [docs] `docs/specs/changelog.md` duplicates the new root `CHANGELOG.md` and embeds prompts. Removed; the root `CHANGELOG.md` already summarizes 1.0.0 to 1.1.1.
- [x] **No version tags.** (p3) [chore] Releases 1.0.0 to 1.1.1 exist only in docs; every release from v2.0.0 on has an annotated `vX.Y.Z` tag.
- [x] **Stale .claude/preferences.json.** (p3) [chore] Untracked generated file still names `pexels-cli` and describes jest/eslint/prettier setups the repo does not use.
      Agents may read it as project guidance that contradicts `AGENTS.md`. Deleted and added to `.gitignore` in case the tool regenerates it.
- [x] **GETTING_STARTED.md describes one machine.** (p3) [docs] It records a 2026-10-23 check of this machine's tools and test count, which goes stale and means nothing on another checkout.
      Replaced with a prerequisites list and a `command -v` check; limitations updated for purge, missing files and health checks.
- [ ] **No self-check command.** (p3) [feature] A `backdrop doctor` could report missing tools, X11 availability, config errors,
      a stale `state.json`, and library rows whose files are missing (the daemon only drops those from playlists).
- [ ] **Config is validated lazily.** (p3) [refactor] Values are checked where they are used (`trash_days` at purge, `output.*` at startup), so a typo like
      `image_duration: 5m` only fails inside mpv. Validate the whole config in `ConfigManager.normalize()` with messages naming the key, and test each section.
- [x] **Unknown config keys are ignored silently.** (p2) [bug] A `visualization:` section (meant as `visualizer:`) was
      accepted without a word on 2026-10-30, so the visualizer stayed off with nothing in the log or `status`. The
      visualizer section rejects unknown keys since 2.24.0/2.25.0; top-level sections and the other sections still do
      not. Warn on unknown keys in `ConfigManager.loadConfig()`, naming the closest known key (as `closestQueries` does
      for queries), from the CLI and in the daemon log. Part of the lazy-validation item above.
      Done in 2.26.0: `unknownKeys()` checks the file against the defaults (visualizer excepted); warnings on stderr,
      in `status` and `status --json`, the daemon log, and a notification for each one a save adds.
- [x] **axios has known vulnerabilities.** (p1) [chore] `npm audit` (2026-10-30) reports high-severity advisories for
      axios 1.0.0-1.19.0 (DoS, SSRF through NO_PROXY, prototype pollution) and, through it, critical `form-data`
      4.0.0-4.0.5 and moderate `follow-redirects` <=1.15.11; the Pexels adapter uses it for every API call and download.
      1.21.0 is in range (`npm update axios`), then run the source tests and one live `search-images`.
      A recheck on 2026-10-31 found 15 advisories in all: runtime `yaml` 2.8.0 (deep nesting stack overflow, 2.9.1
      fixes it) and `tmp` through `inquirer` 8.2.6 (8.2.7 fixes it) are also in range; dev-only `serialize-javascript`
      needs mocha 12 (see the dependencies item). The `package.json` floors (`axios ^1.6.2`, `yaml ^2.3.4`) still
      admit vulnerable versions; raise them with the fix.
      Fixed in 2.25.1: `npm audit fix` and raised floors; only the mocha chain (dev) remains. A live `search-images`
      ran clean on axios 1.21.0.
- [x] **An empty config section crashes every command.** (p2) [bug] A section with all its keys commented out,
      e.g. `library:` alone, parses as null; `deepMerge` replaces the defaults with it and `normalize()` fails on
      `config.library.import_dirs` ("Failed to load config: Cannot read properties of null"), so even `stats` exits.
      Treat a null section as empty in `deepMerge`/`loadConfig` and test each section; part of the lazy-validation item.
      Fixed in 2.26.2: a null over a mapping default keeps its defaults, over a list default is an empty list.
- [ ] **mpv integration test flaked once under load.** (p3) [test] `test/display/mpv.integration.test.js` failed once
      during a full `npm test` on 2026-10-30 and passed three runs alone. Its fixed waits likely race a busy machine;
      replace them with polling on mpv properties.
- [ ] **Dependencies are several majors behind.** (p3) [chore] `npm outdated` (2026-10-30): commander 11 (15 current),
      inquirer 8 (14, ESM-only with a new prompt API, used by the interactive lists), mocha 10 (12), chai 4 (6, ESM-only),
      sinon 17 (22). None is urgent; upgrade commander and the test stack together in one change, inquirer separately
      since its API changed.
      2.26.1 moved commander to 15 and the test stack to mocha 12, chai 6 and sinon 22 with no test changes; left:
      inquirer 14 (`ListCommand`, `SearchCommand`), and mocha 12's own moderate `minimatch` advisory (upstream).
- [ ] **Daemon.js has grown to about 860 lines.** (p3) [refactor] It holds playback supervision, hotplug, health checks,
      CPU sampling, imports, purge, control requests, durations, the config watcher and the visualizer glue. Move the
      control-request handling and durations (`applyControl`, `applyDurations`, `setWallpaper`) and the config watcher
      (`watchConfig`, `applyConfigChange`) into their own modules with the daemon passed in, as `VisualizerManager`
      already is, so each can be tested without starting a daemon.
- [ ] **No CI.** (p3) [chore] Nothing runs `npm test` on push. Add a GitHub Actions workflow on Node 22.13 and current Node, installing mpv and ffmpeg so the
      integration tests run instead of being skipped.
- [x] **Tests could act on the running daemon.** (p1) [test] `makeConfig()` left `paths.runtime` at the real
      `$XDG_RUNTIME_DIR/backdrop`, so tests read the live `state.json` (the mpv integration test only passed through it)
      and could write beside it. Fixed: `makeConfig()` points it at a missing directory; tests that need state set their own.
- [x] **Tests default to the real data and cache paths.** (p2) [test] `makeConfig()` still leaves `paths.data`,
      `paths.thumbnails`, `paths.logfile` and the media folders at their XDG defaults; a test that forgets to override
      one writes into the user's library. Point every `paths.*` at a per-run temp directory in `makeConfig()`.
      Fixed in 2.26.3: `test/helpers/setup.js` points every XDG variable at one temp directory for the run and
      removes it afterwards; `test/helpers/isolation.test.js` checks every default path lands inside it.
- [x] **Stray pexels.log.** (p3) [chore] A 0-byte `pexels.log` from pexels-cli sits in the repo root (ignored by `*.log`). Deleted.

## 2. Rename to backdrop

- [x] **Rename project and repo to backdrop.** (p1) [chore] Package, bin, CLI name, README, CLAUDE.md and specs renamed; GitHub repo renamed to `njhoffman/backdrop` and origin updated.
      `SETUP_GUIDE.md` removed; the old spec is kept as `docs/specs/legacy-pexels-cli.md`. Breaking change, so this ships as 2.0.0.
- [x] **Move the local checkout.** (p2) [chore] Moved to `~/ghq/github.com/njhoffman/backdrop`; `~/git/backdrop` symlink replaces `~/git/pexels-cli`.
- [x] **Decouple config and paths from Pexels.** (p1) [refactor] Move `~/.config/pexels.yaml` to `~/.config/backdrop/config.yaml` and `~/.local/share/pexels`, `~/.cache/pexels` to `backdrop`.
      Put source credentials under a `sources:` map (`sources.pexels.api_key`, `sources.unsplash.access_key`), keep `PEXELS_API` as a fallback.
      Done: XDG paths (`paths` not written to the file), `sources`/`library`/`display`/`screensaver` sections; see `docs/specs/config.md`.
- [x] **Source-neutral database schema.** (p1) [refactor] `media`, `ratings`, `searches`, `search_results`, `sequences` on built-in `node:sqlite`; see `docs/specs/database.md`.
      No data migration: backdrop starts with an empty database (decided 2026-10-21).
- [x] **Port old commands onto the new layer.** (p1) [refactor] Search/Download, List, Stats and Rating use the new schema
      and are registered alongside Import and Display. HookCommand is removed; `go-next` uses mpv IPC.
      Lists default to text with optional interactive rating/M3U export; stats work offline. See `docs/specs/sources.md`.
- [x] **Trash purge.** (p2) [feature] `backdrop purge [--dry-run]` and the daemon (at start and every 24h) delete trash files older than `library.trash_days` (0 disables).
      Rows and ratings stay with a null path so searches do not resurrect the item; only files inside `trash/` are touched.
- [x] **Unknown commands exit 0 silently.** (p3) [bug] Fixed once display commands were registered. With no subcommands registered, `backdrop bogus` prints nothing and exits 0.
      Commander rejects unknown subcommands once any are registered; add a test for this when the first command is ported.

## 3. Display engine on mpv sockets

- [x] **mpv IPC display backend.** (p1) [feature] Replace the external `get-name` / `play-prev` / `play-next` hooks with a backend that owns mpv and talks JSON IPC over `--input-ipc-server`.
      Reference the existing scripts: `~/bin/wallvideo` (xwinwrap + `mpv -wid WID --loop --no-audio --input-ipc-server`), `~/bin/scratch.sh` (`wallvideo` with `--speed`), `~/bin/bg.sh` (per-geometry xwinwrap and cleanup).
      Current file and next/prev become `get_property path` and `loadfile`/`playlist-next`.
- [x] **One socket per monitor.** (p2) [feature] Spawn one xwinwrap+mpv per output with its geometry (as `bg.sh` does with `-g`) and a socket like `$XDG_RUNTIME_DIR/backdrop/<output>.sock`.
      X11 only via xwinwrap; Wayland is out of scope (decided 2026-10-21).
- [x] **Static images and GIFs through mpv.** (p2) [feature] Show images with `--image-display-duration=inf` (or a slideshow interval) and GIFs with `--loop-file=inf`, so all media uses one code path (the `wall` / `wall.gif` cases).
- [x] **Per-video playback speed, persisted.** (p1) [feature] Commands to slow down / speed up the current video (`set_property speed`), saved per media item in the DB and applied on the next play.
- [x] **Daemon lifecycle.** (p2) [feature] `backdrop start|stop|status`, a PID/state file, and recovery when mpv or xwinwrap dies (bg.sh currently uses `kill -9`).
- [x] **Rate the current item via the socket.** (p1) [refactor] `keep` / `skip` / `go-next` use `DisplayControl.current()`
      with monitor targeting. Skip removes all playlist references before moving to trash. Persistent undo deletes the latest rating and
      restores its exact previous path; schema v4 upgrades existing databases. Failed database writes roll file moves back.
- [x] **Playlists go stale while the daemon runs.** (p2) [feature] Import/download append eligible items immediately,
      rating moves refresh affected playlists, and skip/remove delete every matching entry. Appends avoid duplicate paths.
      External file changes remain covered by the separate missing-files/watch-mode tasks.
- [x] **Missing files can make mpv spin.** (p2) [bug] If every playlist entry fails to load (files moved or deleted outside backdrop), `--loop-playlist=inf` keeps retrying.
      Checked with mpv 0.40: an all-missing playlist goes idle on its own, but mixed playlists retried missing entries on every pass.
      The daemon now drops entries reported by `end-file` with `reason: error`; the database is not changed.
- [x] **Hung mpv is not detected.** (p3) [feature] Supervision only reacts to process exit; an mpv that stops answering IPC stays up. The daemon now checks `get_property pid` every 30s and kills an mpv that misses two in a row; the normal restart budget applies.
- [x] **Per-item dim command.** (p2) [feature] `backdrop dim <value>` (absolute, `+N`/`-N` steps, `reset`, `--monitor`) works like `speed`:
      sets mpv `brightness` on the playing item over IPC and stores it per media item (schema v5 column, default 0), so it is reapplied on the next play.
      Apply it in `Daemon.onFileLoaded` for images and videos alike, always setting the value (0 when unset) because mpv keeps the property across files.
      Decide whether to accept a 0-100 dim amount mapped to negative brightness, or raw brightness -100 to 100; consider lowering `saturation` with it.
      `backdrop current`/`status` should show non-zero dim. Cheaper than xwinwrap `-o` opacity, which needs a compositor blending every frame.
      Done: `backdrop dim` takes a 0-100 amount (brightness = -dim), steps clamp to the range; schema v5 `media.dim`; saturation left alone.
- [x] **Undo can get stuck.** (p3) [bug] `undo` only ever targets the globally latest rating. If that rating cannot be undone (its skip was purged, or
      `download --upgrade` renamed the file so `rated_path` no longer matches), every later `undo` fails the same way. Update `rated_path` when an upgrade renames a file,
      and let undo report and step past an unrestorable rating (or add `undo --discard`).
      Done: ratings have a `final` flag (v9) that undo skips; purge sets it, `download --upgrade` renames recorded paths, and `undo --discard` drops a stuck rating.
- [x] **A missing configured monitor blocks startup.** (p2) [bug] `selectMonitors()` throws when a name in `display.monitors` is not active, so
      `Daemon.start()` fails if that monitor is unplugged at boot, and `targetResolution()` makes search/download fail too. Hotplug already tolerates it at runtime.
      Start with the configured monitors that are present (warn about the rest) and size downloads for those, failing only when none are active.
      Done: the daemon starts on the configured monitors that are active, or on none, and hotplug adds the rest; downloads size for the active ones and warn.
- [x] **state.json is written in place.** (p3) [bug] `Daemon.writeState()` uses `fs.writeJson` directly and `readState()` treats a parse error as "not running",
      so a CLI command racing a rewrite (now on every hotplug change) can report the daemon as stopped. Write to a temp file in the runtime dir and rename it.
      Done: written to a temporary file and renamed; skipped during shutdown so a late sample cannot recreate it.
- [ ] **Hotplug only tested with fakes.** (p3) [test] Reconciliation is covered against a fake `xrandr`; confirm on real hardware (attach, remove, change resolution,
      lid close) and note any xrandr output the parser misses, e.g. monitors without a physical size.
- [x] **No record of player CPU use.** (p2) [perf] Nothing measures what the mpv instances cost over time. Have the daemon sample each
      screen's mpv CPU (from `/proc/<pid>/stat`, every minute or so) and keep a rolling average per monitor and per item, alongside
      `hwdec-current`, resolution and fps; show it in `status` and `stats`. That shows which items are expensive and whether 4K media
      is worth keeping (2026-10-28 spot check on Iris Xe: 4K24 H.264 ~26% CPU with VA-API vs ~400% in software; 1080p30 ~17%).
      Done: sampled on each 30s health check into `playback_stats` (v8); shown in `status`, `current` and a `stats` section.
- [x] **Software-decode fallback goes unnoticed.** (p2) [perf] `--hwdec=auto-safe` silently falls back to software for unsupported
      codecs or profiles, which costs about four cores at 4K. `Daemon.onFileLoaded` could read `hwdec-current` and log a warning
      (and mark the item) when it is empty for media larger than 1920x1080.
      Done: the decoder is read on each sample and stored per item; software decoding above 1080p is logged once per item and run.
- [x] **Monitor hotplug.** (p2) [feature] `Daemon.start()` reads `xrandr` once; a monitor attached later gets no wallpaper and moved outputs keep stale geometry until `backdrop stop && backdrop start`.
      Poll `xrandr --listactivemonitors` (or listen for RandR events) and start, stop or respawn per-monitor mpv instances on changes, then rewrite `state.json`.
      Done: the daemon polls xrandr every 5s; empty or failed reads keep the layout, and crash restarts cannot race a layout change.
- [x] **Status hides why a monitor is blank.** (p3) [feature] When no library item is at least as large as a monitor, it idles and only the log says "No media to show".
      `backdrop status` should report per monitor how many items are eligible and suggest `display.allow_upscale` or a fresh download.
      Done: `status` shows eligible counts per monitor and a reason and fix for blank ones.
- [x] **Quiet config creation in tests.** (p3) [test] `ConfigManager.createDefaultConfig()` prints to stdout during `npm test`; inject an output stream or silence it in tests.
      Done: ConfigManager sets `created`; the CLI prints the notice on stderr.
- [ ] **Speed changes do not recompute the video limit.** (p3) [bug] `display.video_duration` is turned into
      `loop-file`/`end` when a video loads (`playbackLimits` in `src/display/Playlist.js`); `backdrop speed` on a playing
      video changes how long those loops take until the next load. Reapply the limits in `DisplayControl.speed()`.

- [x] **Processes outlive a crashed daemon.** (p2) [bug] xwinwrap/mpv and GLava run in their own process groups (killed
      as groups by `stop`), and `pactl subscribe` is a plain child. When the daemon dies without running `stop()` (kill -9,
      out of memory, an uncaught error) they keep running, and the next `backdrop start` adds a second wallpaper and
      visualizer per monitor on top. Under systemd the service's cgroup is killed on failure, so this hits `backdrop
      start` and i3 `exec`. Record every child's pid in `state.json` (visualizer pids are there already, xwinwrap's are
      not); when `start()` finds a state file whose daemon is dead, kill those process groups first, and remove stale
      sockets.
      Fixed in 2.26.4: the daemon's spawn records every child in `children.json` (`src/display/children.js`) as it
      starts and exits, since the visualizer's own restarts never rewrite `state.json`; `start` and `stop` end the
      recorded process groups of a dead daemon when their `/proc` start times still match, and an uncaught error
      in the daemon runs `stop()` before exiting. Checked under Xvfb with kill -9: `start` and `stop` both end the
      old xwinwrap+mpv group, waiting on the whole group since mpv outlives xwinwrap.
- [ ] **Control requests can be lost when two run at once.** (p3) [bug] `control.json` is a single slot: two commands
      at the same moment (e.g. `next --video-duration` and `stop --wallpaper` from keybindings) overwrite each other's
      request, and both see the daemon's `control` counter move and report success. Write one file per request
      (`control-<pid>-<n>.json`) that the daemon handles in name order, or take an exclusive lock (`open` with `wx`)
      around write-signal-wait.

## 4. Media sources
      Since 2.24.0 `Daemon.applyLimits(screen, media, { elapsed })` recomputes limits mid-play for duration changes;
      observing mpv's `speed` property in `startScreen` and calling it on a change would close this.
- [x] **Source plugin interface.** (p1) [refactor] `Source`/`SourceRegistry` provide search, metadata, normalized download
      variants and quota information; Pexels is the first adapter. Source-specific credentials are checked only on API requests.
      See `docs/specs/sources.md` for the contract and current Pexels endpoints.
- [ ] **Unsplash source.** (p2) [feature] Official API, images only; requires an access key and attribution/download-tracking per their guidelines.
- [ ] **Other free sources.** (p3) [feature] Only sites with a public API qualify; scraping is out (decided 2026-10-21).
      That excludes MoeWalls and wallsflow.com (checked 2026-10-21: `/api/` redirects to the homepage, no developer docs).
      Candidates: Wallhaven (API with resolution filters), Pixabay (API, has video). Pick after the interface exists.
- [ ] **Pexels adapter not run against the live API.** (p2) [test] Search, metadata, variants, download and `--upgrade` are only tested against mocked responses.
      Run a manual smoke test with a real key, record any differences in `docs/specs/sources.md`, and consider an opt-in live test gated on `PEXELS_API`.
- [x] **Duplicate downloads are retried forever.** (p2) [bug] When a downloaded file's sha256 matches an existing item, `downloadItem()` throws
      `Duplicate content of #N` and leaves the pending row as `new`, so every `backdrop download` fetches it again, and its search queries never reach the kept copy.
      Record the duplicate (e.g. `media.duplicate_of`), move its `search_results` to the original, and exclude it from pending lists.
      Done: schema v6 `media.duplicate_of` (no foreign key); searches that return a known duplicate credit the original.
- [ ] **A search has no page cap.** (p3) [feature] `SearchCommand` follows `nextPage` until results run out or the
      rate limit hits, so a broad query with a small `--per-page` spends one request per page (161 for "ocean" at
      3 per page on 2026-10-31, of Pexels' 200 an hour). Add `--max-pages` (and a `sources.<name>.max_pages`
      default), or warn when `--per-page` is small and the query broad.
- [ ] **Downloads have no size limit or stall timeout.** (p3) [bug] `downloadFile()` streams whatever the server sends; axios `timeout` is not verified to cover
      a body that stalls mid-transfer, and nothing caps the size. Abort when no data arrives for 30s and when bytes exceed Content-Length (or a configured maximum).

## 5. Local library import

- [x] **Auto-import local files as pre-approved.** (p1) [feature] Scan configured directories (and `backdrop import <dir>`), add files directly to the kept library with rating 2/3 and no review step.
      Done: `backdrop import`, rescanned on every daemon start; copies (originals untouched), dedupes by SHA-256, skips unchanged files by size/mtime, rejects < 1024x768.
- [x] **Consistent names for imports.** (p2) [feature] Rename imported files to a sequential `local-<n>.<ext>` (no category detection, decided 2026-10-21).
      Keep the original filename and path in the DB; never reuse a number after deletion.
- [ ] **Watch mode for import directories.** (p3) [feature] Pick up new files while the daemon runs (fs.watch / inotify) instead of only on start or `backdrop import`.
- [x] **No command to remove an item from the library.** (p2) [feature] `backdrop remove <id>` or `backdrop remove --current [--monitor <name>]`
      deletes the file and media row after removing all playlist references. `imported_files` keeps the source record so unchanged originals are not re-imported.
- [ ] **Animated WebP imports as a still image.** (p3) [bug] ffprobe cannot decode animated WebP, so `probe.js` classifies it as `image`; detect the ANIM chunk and treat it as `gif`.
- [x] **Import progress for large first runs.** (p3) [feature] The first scan hashes and copies everything; the daemon logs only a summary at the end. Log periodic progress, and show a running count in `backdrop import`.
      Done: the daemon logs the file total and progress every 30s; `backdrop import` shows a progress bar.
- [x] **Edit rating during playback.** (p2) [feature] `keep N` changes the effective current rating for imported items;
      prior ratings remain as undo history, and repeated ratings do not duplicate playlist entries or restart media already in the library.
- [ ] **Concurrent imports can collide.** (p3) [bug] `backdrop import` and the daemon's startup import can scan the same folders at once; both may copy a file
      before either commits, so the second likely fails on the unique `sha256` and is recorded as `failed`. Take a lock file in the data dir for the duration of an import,
      and have the second importer wait or skip.
- [ ] **Tag-based playlists and search.** (p2) [feature] `media_tags` (schema v7) is filled from file names, page slugs
      and descriptions, and lists filter with `--tag`. Since v2.17.0 `pending`, `download` and `next` also take `--tag`
      and `--query` (`src/library/match.js`), but `next` only jumps once. Next: show tag counts in `stats`, add a `tags`
      command listing them, and let the daemon or screensaver play a playlist built from tags (e.g. `backdrop mode video --tag ocean`).
- [ ] **No shell completion for `--query` values.** (p3) [feature] `--query` must match a saved search exactly, so completing
      it from `searches` (a helper like the monitors one in `src/commands/CompletionCommand.js`, reading the database or a
      `backdrop queries` listing) would save typing and typos; `--tag` could complete from `media_tags` the same way.
- [x] **Frame rate unknown until a video plays.** (p3) [feature] Videos added before v7 get `fps` from mpv the first time
      they play. A `backdrop rescan` (ffprobe over existing files) would fill it at once and could also re-check sizes.
      Done: `backdrop rescan` fills missing frame rates; `--all` re-checks kind, size and duration of every file.
- [ ] **ffprobe takes about 0.4s per file.** (p3) [perf] It decodes part of each file to fill in stream details, so `rescan` of
      204 videos took 74s at two cores (2026-10-28), and large imports pay the same. Probe several files at once in `rescan`
      and `Importer` (a small worker pool), or lower `-probesize`/`-analyzeduration` if the fields stay correct.

## 6. Resolution-aware quality filter

- [x] **Never upscale.** (p1) [feature] Search/download and playback filter against configured xrandr monitors;
      `--resolution WIDTHxHEIGHT` supports headless source commands. `display.allow_upscale` is the explicit override.
- [x] **Pick the best download variant.** (p2) [perf] Download the smallest variant by pixel area that meets all target
      monitor dimensions and the library minimum.
- [x] **Store measured dimensions.** (p2) [feature] Download/import probe real dimensions, kind and duration with ffprobe;
      a later source search preserves measurements for files already downloaded.

- [x] **Upgrade downloads for larger monitors.** (p3) [feature] Downloads are sized for the largest monitor at download time and never refetched, so a later, larger monitor skips them.
      Add e.g. `backdrop download --upgrade`: for kept remote items below the current target, pick a larger stored variant, replace the file atomically and keep ratings, speed and history. Local imports cannot be upgraded.
      Done: `download --upgrade` sets the old file aside until the database commits, and refreshes playlists afterwards.

## 7. Screensaver

- [ ] **Idle-triggered screensaver.** (p2) [feature] After N minutes of inactivity (xprintidle or an xss-lock / xidlehook integration), play a configured set of media fullscreen through mpv; stop on activity.
- [ ] **Screensaver playlists.** (p2) [feature] Sources: rated live wallpapers, separate video files, and YouTube links (mpv + yt-dlp). Configurable per playlist, shuffle, and per-item speed.
- [ ] **Coexist with locker and DPMS.** (p3) [feature] Decide interaction with the screen locker and monitor sleep, and inhibit during fullscreen apps or media playback.

## 8. CLI experience and packaging

- [x] **Consistent output styling.** (p2) [feature] Commands print plain `console.log` lines with ad hoc chalk in a few places (`index.js`, `DisplayCommand`, `ImportCommand`).
      Add one small output module (headings, key/value rows, success/warn/error colors, dim secondary text) and use it in every command.
      Respect `NO_COLOR` and non-TTY stdout so lists, `--playlist` and scripts get plain text; consider `--json` for `current`, `status` and lists.
      Done: `src/utils/output.js` on Node's own color detection (chalk removed), with `output.symbols` (auto/nerd/unicode/ascii).
      `--json` moved to the rofi item.
- [x] **Gradient progress bars for long tasks.** (p3) [feature] Import hashing/copying, downloads (bytes per file and items overall) and purge need live progress.
      `src/utils/ProgressBar.js` is unused legacy code and the `progress` dependency is unused; replace both with one TTY-only bar that draws a truecolor gradient
      (falling back to 256/16 colors), writes to stderr, and stays silent when not a TTY. Covers "Import progress for large first runs" in project 5.
      Done for import and download (with per-file bytes); colors from `output.progress_gradient`. Purge is fast enough without one.
- [x] **Show the version on every run.** (p3) [feature] Print `backdrop vX.Y.Z` as a dim first line on stderr for interactive runs only, so piped output and
      M3U exports stay clean; `--version` already exists. Skip it for `daemon` logs, where the version should go in the startup log entry instead.
- [x] **Show the new item after navigation, with a one-line view and random order.** (p2) [feature] `next`, `prev`, `skip`, `go-next`, `keep --next`
      and `mode` print what the target monitor now plays (`DisplayControl.switchTo` reads mpv's current playlist entry). `--line` prints one aligned
      line (tab-separated when piped, for fzf); `--random` / `display.order: random` move a random entry next. Bare `backdrop` runs `status`.
- [x] **Playlist repeated one order every pass.** (p2) [bug] `--loop-playlist=inf` replayed the startup shuffle forever. The daemon now reshuffles
      on wrap (`reshuffleOnWrap` in `src/display/Playlist.js`).
- [x] **Wrap detection uses positions from the previous load.** (p3) [bug] `reshuffleOnWrap` compares `playlist-pos` with the position at the
      previous file load. Removals, appends and random moves between loads shift positions, so a wrap can occasionally be missed or an extra
      reshuffle run. Both are harmless; tracking the playing entry's id (`playlist_entry_id` on `start-file`) would make it exact.
      Done: the daemon compares mpv entry ids, so removals, appends and random moves no longer affect it.
- [x] **Detailed, aligned stats.** (p2) [feature] `stats` shows sectioned tables with bars on a terminal:
      library per kind, rating distribution, resolutions, sources, top searches, recent activity, storage, per-monitor
      eligibility and quota (`DatabaseManager.getDetailedStats`, `formatTable` and `stackedBar` in `src/utils/output.js`).
- [x] **Stats walks the library directories on every run.** (p3) [perf] `directoryUsage` stats every file under media, inbox
      and trash; fine for thousands of files, slow on network mounts. Store file sizes at download/import and sum them in SQL.
      Won't fix (2026-10-28): 0.09s for 169 files (776 MB); stored sizes would need upkeep everywhere, drift from disk and miss files the database does not know about.
- [x] **No header row for `--line`.** (p3) [feature] Tables want column names; add `--header` (or print one on a terminal only) and document
      `fzf --header-lines=1`.
      Done: `--header` on `current`, `list-images` and `list-videos` (implies `--line`), aligned on a terminal and tab-separated when piped.
- [ ] **A closed pipe crashes with a stack trace.** (p3) [bug] `backdrop stats | head -2` dies with an unhandled
      `EPIPE` from `console.log` in `write()` (`src/utils/output.js`) once `head` exits, printing a Node stack trace.
      Handle `error` on `process.stdout` (exit quietly on `EPIPE`) in `src/index.js`, with a CLI subprocess test.
- [ ] **Release binary.** (p3) [chore] Build a single executable with Node's SEA (bundle `src/` and dependencies with esbuild first; `node:sqlite` is built in),
      attach it to a GitHub release per `vX.Y.Z` tag, and document that mpv, xwinwrap, xrandr, xdotool and ffprobe are still external.
      Check that `package.json` version lookup and any runtime file reads work from inside the bundle.
- [x] **Rofi control menu.** (p2) [feature] `backdrop menu` (or a shipped script) opens rofi with the current item (name, rating, monitor) and actions:
      keep 1-3, skip, undo, next/prev, go-next, speed presets, mode toggle and monitor choice, then runs the matching command and shows errors via rofi or notify-send.
      Needs `--json` output for `current`, `status` and the lists (deferred here from the styling item); add an i3 keybinding example to `GETTING_STARTED.md`.
      Done: `backdrop menu` built into the CLI (no script, so `--json` was not needed); closes after an action, `--stay`
      keeps it open; errors go to critical notifications; `menu.rofi_args` for theming; i3 example in GETTING_STARTED.md.
- [x] **No `--json` output.** (p3) [feature] Scripts parse `--line` today. `current`, `status` and the lists could print JSON
      (the media row, rating, tags, playback cost, monitor) for status bars and custom menus; split from the rofi menu item.
      Done: `--json` on `status`, `current`, the lists and the navigation commands; curated item format in `docs/specs/json.md`; other output moves to stderr.
- [ ] **Menu previews miss after a random next.** (p3) [perf] The daemon makes the preview of each item as it loads and of
      the next playlist entry (`prefetchThumbnails` in `src/display/Daemon.js`), but next is random by default and picks an
      arbitrary entry, so the redrawn menu still waits about 0.4s for ffmpeg. Fix: backfill thumbnails for every eligible
      item in the background (nice'd, a few per minute), or queue the random pick first and make its thumbnail before advancing.
- [ ] **Menu workspace stays on the first monitor after Tab.** (p3) [feature] `menu.workspace` empties the monitor the menu
      opened on; picking another with Tab leaves that one covered. `MenuCommand.open` could leave and re-enter the workspace
      (`src/utils/workspace.js`) on the new output when the target changes.
- [x] **Menu rendering is only checked by hand.** (p2) [test] Unit tests check the rofi arguments, not what rofi does with
      them: a status with quotes or line breaks inside a `-theme-str` string failed rofi's theme parser, and a horizontal
      info box that expanded hid the second row of buttons, with every test passing. Both were found by rendering into
      Xephyr and taking a screenshot. An integration test on a nested or virtual X server (Xvfb or Xephyr, skipped when
      missing, like the mpv one) should open the panel, check rofi reports no theme error, and send keys with `xdotool`
      to check the custom exit codes (10 + N).
      Done in 2.27.1: `test/commands/menu.integration.test.js` runs both views and the real main, step and monitor menus
      on Xvfb, requires an empty rofi stderr (a bad -theme-str prints "Failed to parse" and exits 65; a markup error is
      a Pango warning) and checks exit codes from xdotool keys. Reintroducing the raw line break in `rasiMarkup` fails
      it. Layout (the hidden second row) is not asserted; each menu's screenshot is kept when a test fails.
- [x] **Unused dependencies.** (p3) [chore] `pexels` and `progress` are no longer imported anywhere (the Pexels adapter uses axios); remove them, and `ProgressBar.js` with the progress-bar item. Done, along with chalk.
- [x] **Shell completions.** (p3) [feature] Generate zsh and bash completions for commands and options, completing `--monitor` from the running daemon's
      `state.json` and `mode` from video/image.
      Partly done: `backdrop completion zsh` (generated from the Commander definitions, `src/commands/CompletionCommand.js`). Bash remains.
      Done: `backdrop completion bash`, generated from the same definitions as zsh, without needing the bash-completion package.
- [x] **systemd user unit.** (p3) [feature] Ship a `backdrop.service` user unit (`backdrop daemon`, restart on failure, `graphical-session.target`) as an alternative
      to i3 `exec`, and document enabling it.
      Done: `backdrop systemd` prints a unit with the generating shell's PATH (node through `/usr/bin/env`), restart on failure and a start limit; i3 activation documented in GETTING_STARTED.md.
- [ ] **The menu cannot open while the wallpaper is off.** (p3) [bug] `MenuCommand.describe` asks mpv for the playing item,
      which fails with "The wallpaper is off" since 2.21.0, and the menu closes. It should open with the item area showing
      "wallpaper off", a button for `start --wallpaper`, and the visualizer controls still usable.
- [ ] **Docs claim and omit a few things.** (p3) [docs] README's feature list includes the screensaver, which is not
      built (its intro and GETTING_STARTED say so). The prerequisites in README and GETTING_STARTED do not list what the
      visualizer needs: `glava`, a compositor (picom), and `pactl` for `only_while_playing`. `docs/specs/main.md` has no
      pointer to `docs/specs/visualizer.md`.
- [ ] **Notifications stack under deadd-notification-center.** (p3) [bug] `notify-send --replace-id` and the dunst stack tag
      replace the previous notification per monitor on dunst, but deadd returned a new id on 2026-10-28, so rapid `next`
      presses pile up. Check deadd's replace support, or close the previous id (gdbus `CloseNotification`) before sending.

## 9. Music visualizer

Backdrop places GLava above its wallpaper and below every window, on each monitor, and drives its options. GLava stays
the renderer, behind an adapter; the reasoning is in `docs/specs/visualizer.md`.

- [x] **Decide the visualizer engine.** (p2) [docs] GLava, behind an adapter: the only candidate with transparency, a
      desktop-layer window and click-through on X11 by itself. Frozen upstream (last commit 2021-06, no maintained
      fork as of 2026-10-30); the mpv lavfi fallback is recorded. Done in `docs/specs/visualizer.md` (2.20.0).
- [x] **Run GLava from the daemon.** (p2) [feature] `visualizer` config section; `VisualizerManager` runs one instance
      per monitor after its wallpaper, restarts it (five times a minute, then gives up until reload), follows hotplug
      and stops with the daemon. Done in 2.20.0.
- [x] **Keep GLava stacked above the wallpaper.** (p1) [bug] 2.20.0 relied on start order after misreading the stack
      (`xwininfo -children` lists top to bottom), which left GLava under the wallpaper. Done in 2.22.0: each instance is
      restacked directly above its wallpaper over an X connection (`src/display/x11.js`) after every start of either.
- [x] **Placement per monitor.** (p2) [feature] `placement` (anchor, width, height, margin) or `rect`, in pixels or
      percent, resolved per monitor and passed as `setgeometry`; per-monitor overrides under `monitors`. Done in 2.20.0.
- [x] **Visualizer options from backdrop.** (p2) [feature] Module choice, typed bars options, raw `defines` and
      `requests`, written into a generated config root (`XDG_CONFIG_HOME` pointed at the runtime dir). Done in 2.20.0.
- [x] **Typed options for the other modules.** (p3) [feature] graph, radial, circle and wave have typed options
      (`MODULE_OPTIONS` in `src/visualizer/settings.js`), written only when set; unknown options are rejected. Done in 2.24.0.
- [x] **Stacking is only checked by hand.** (p3) [test] Unit tests use a fake X connection; placement was verified live
      on picom and i3 on 2026-10-30. An integration test on Xephyr or Xvfb (skipped without them, glava or a GL
      context) should start the daemon with the visualizer and check the order of the root's children, also after
      killing mpv and after `stop/start --wallpaper`.
      Done in 2.29.1: `test/display/stacking.integration.test.js` runs a real daemon (xwinwrap, mpv) on Xvfb with a
      stand-in visualizer window (`test/fixtures/standin-visualizer.mjs`) that lowers itself after mapping as GLava
      does, since GLava opens no window under Xvfb; GLava's own stacking is not covered. Disabling the restack in
      `place()` fails the start case; the mpv-restart and wallpaper on/off cases pass either way (a new xwinwrap
      lowers itself below the visualizer), so they guard the restart paths and the visualizer surviving
      `stop --wallpaper`, not the restack itself.
- [ ] **Apply more config sections live.** (p2) [feature] The config watcher (2.23.0) applies only the `visualizer`
      section. Extend `Daemon.applyConfigChange` to the display keys the daemon reads per item (`order`, `image_duration`,
      `video_duration`, `notify`, `allow_upscale`) by taking them into the running config, and `display.monitors` by
      running `reconcileMonitors`. Keys a running mpv cannot take (`mpv_args`, `xwinwrap_args`) and `paths` should log
      and notify "restart the daemon to apply" instead. Validate each section first, as the visualizer one is.
- [x] **Live value channel into GLava (--pipe).** (p2) [feature] Foundation for every color item below. Start each instance
      with `--pipe=fg:vec4 --pipe=bg:vec4` (and more bindings as needed) and keep its stdin open in `VisualizerManager`;
      writing `fg = #rrggbbaa\n` changes the color without a restart. The typed color options already emit `@fg:`/`@bg:`
      defaults (`gradientColor` in `src/visualizer/settings.js`); gradients need two bindings (`fg`, `fg2`) since a pipe
      value is one vec4. Expose `setColors(name, { fg, fg2, bg })` on the manager, and resend the current values after
      a restart. Check GLava 1.6.3 reads stdin with `setopacity "native"` and keeps reading after the first value.
      Checked 2026-10-31 (GLava 1.6.3-93, picom, a FIFO sine wave, `--pipe=fg:vec4`): `fg = #rrggbbaa` lines change
      the bars live and keep working seconds later. With `--pipe` GLava draws nothing until the first value
      arrives (the `@fg:` default is ignored; the same instance without `--pipe` draws at once), so the manager must
      write the colors right after each spawn. GLava does not open a window under Xvfb (it loops on X requests before
      reading its config), so this was checked on the real display with an on-top test window.
      Done in 2.27.0, bound only with `palette.source: wallpaper`. GLava also takes one line per read and drops
      the rest of what arrived together, so lines go out 100 ms apart, and reads a `@name:` default up to
      whitespace, so the gradient is written `mix(@fg:A , @fg2:B , ...)`.
- [x] **Colors from the wallpaper.** (p2) [feature] On each load, take the dominant colors of the item (from the menu
      thumbnail the daemon already makes, e.g. `ffmpeg -vf palettegen=max_colors=8` or a k-means over a downscaled
      frame) and send the visualizer a palette over the pipe: `visualizer.colors: wallpaper | fixed`, with a rule for
      which color to use (dominant, most saturated, complementary). Sample only the strip under the visualizer's
      placement and enforce a minimum contrast against it, so the bars never vanish into the image they cover
      (the problem behind the faint-bars issue of 2.21.0). Cache the palette per media id in the database.
      Done in 2.27.0 as `visualizer.palette` (`source`, `pick`, `min_contrast`), sampling the media file rather than
      the menu thumbnail (a middle crop that misses the bottom strip). Not cached: one ~0.2-0.5 s decode per load at
      the lowest CPU priority. Saturation is capped by chroma when lightening, and a near-black or near-white way out
      loses to the other, both found on library items.
      Checked live on 2026-10-31: the restarted daemon took colors from video #1017 1.7 s after start (3.22:1 and
      3.01:1 against a mid-grey strip) and recolored on `backdrop next`.
- [ ] **Animated color transitions.** (p3) [feature] With the pipe channel, fade from the old palette to the new one over
      `visualizer.transition` seconds (stepped writes at about 30 Hz) on a wallpaper change, instead of jumping.
      The same loop gives slow effects: hue drift ("rainbow"), time-of-day palettes (warm evening, cool night), or a
      short brightness pulse on a track change.
- [ ] **Colors from the album art.** (p3) [feature] Take the palette from the now-playing cover instead of the wallpaper
      (`visualizer.colors: album`): read `mpris:artUrl` through `playerctl metadata` on track change (Spotify, mpd
      via mpDris2, browsers), extract the dominant colors as for wallpapers, send them over the pipe. Fall back to
      the wallpaper palette when no art is available.
- [x] **Several visualizers at once.** (p2) [feature] Allow a list of instances, each with its own module, placement,
      monitors, opacity and options: `visualizer.instances: [{ name: base, module: bars, placement: {anchor: bottom} },
      { name: ring, module: radial, placement: {anchor: center, width: 600, height: 600} }]`, the current single-section
      form staying as shorthand for one instance. `VisualizerManager` keys entries by monitor and instance name; each
      gets its own config root (module settings differ per instance) and window title, and is placed above the
      wallpaper in list order. `status` and `--json` list them per monitor.
      Done in 2.25.0: `visualizer.instances`, section keys as defaults, stacked in list order.
- [x] **Presets.** (p2) [feature] Named visualizer looks under `visualizer.presets` (module, options, colors, placement,
      opacity), applied with `backdrop visualizer preset <name>` (live, like the other control requests, until a
      daemon restart), `visualizer.preset: <name>` as the default, and `backdrop visualizer preset --next` to cycle.
      Ship a few built-in ones (subtle bottom bars, centered radial, full-screen wave) users can copy. Later: a preset
      per mode (video/image), per tag or query, or remembered per media item like speed and dim.
      Done in 2.25.0: `visualizer.presets`, built-ins in `src/visualizer/presets.js`, `backdrop visualizer preset`. Per mode, tag or item still open.
- [x] **Visualizer rofi menu.** (p2) [feature] A second menu (`backdrop menu visualizer`, or a key from the main menu)
      in the same panel style: on/off, preset picker, module picker, opacity and amplify steps, anchor picker, color
      source (fixed, wallpaper, album) and a few color swatches. Changes apply live through control requests and
      last until the daemon restarts; a "save" button writes the current look into the config as a preset.
      Needs the control channel to grow past signals (see "CLI and menu controls").
      Done in 2.28.0: `backdrop menu visualizer` and `z`; changes as `visualizer_set` control requests (control.json
      already carried JSON, so no new channel was needed), kept per instance until restart, `reset`, and `save` into
      `visualizer.presets` by a line splice that keeps the config's comments. Color source "album" left out (no such
      source yet). Every change restarts the instance (GLava reads its settings at start), about a second.
- [x] **Show the visualizer only while audio plays.** (p3) [feature] Stop or hide instances when the audio source is
      idle (PulseAudio/PipeWire sink not RUNNING, via `pactl subscribe`) and bring them back when sound starts, with
      a short grace period. Saves GPU on a silent desktop and removes the flat line of an idle module.
      Done in 2.25.0: `only_while_playing` and `silence_grace` (`src/visualizer/audio.js`).
- [ ] **Dim the wallpaper while music plays.** (p3) [feature] Optionally lower the wallpaper's brightness by
      `visualizer.wallpaper_dim` while the visualizer has audio, and restore the item's own dim when it stops, so
      the bars stand out without changing their colors. Reuses the per-item dim path in the daemon.
- [ ] **Visualizer as the screensaver.** (p3) [feature] Let a screensaver playlist be a visualizer preset: a full-screen
      instance (e.g. radial or wave, `placement: {anchor: fill}`) over a dimmed or black wallpaper when idle, ties in
      with project 7.
- [ ] **CLI and menu controls.** (p3) [feature] `backdrop visualizer reload` (SIGHUP), `start/stop --wallpaper/--visualizer`
      and `backdrop visualizer preset` (control requests) exist, and presets cover switching modules. The visualizer menu
      (2.28.0) has on/off and preset buttons; a menu button for the wallpaper part is left. More requests would outgrow the signal-per-action
      scheme and its single `control.json` (see "Control requests can be lost"); a control socket in the runtime dir
      is the next step.
- [x] **`backdrop visualizer check`.** (p3) [feature] A mistake in raw `defines`, or a GLava version whose shaders differ,
      only shows as GLava exiting with code 1 and no message, then being given up on after five restarts. Start each
      instance of the section and of every preset at 1x1 for two seconds, as was done by hand on 2026-10-30, and report
      which ones exit, before they reach the screen. Run it from `visualizer reload` with `--check`.
      Done in 2.29.0 (`src/visualizer/check.js`): all at once, each target against only its own preset, with GLava's
      output (which does name a bad define: "Shader compilation failed ... syntax error"). Checked live on the real
      display: a broken preset fails alone with exit 1, and `reload --check` refuses.
- [x] **Warn when no compositor runs.** (p3) [feature] The visualizer needs one for its transparency; without it the area
      around the bars is solid black over the wallpaper. Check for an owner of the `_NET_WM_CM_S<screen>` selection
      (GetSelectionOwner over the existing X connection) when the visualizer starts, log a warning, and show it in
      `status`.
      Done in 2.29.0: checked on every placement (picom often starts after the daemon), logged on change, `compositor`
      in the visualizer summary, a `status` line and `daemon.compositor` in `status --json`.
- [ ] **A second engine for when GLava breaks.** (p3) [feature] GLava has had no commits since 2021; a Mesa or distro
      change could stop it for good. The adapter seam allows another engine: mpv's lavfi visualizers (`showcqt`,
      `showfreqs`, `avectorscope`) reading the PulseAudio monitor, in an `xwinwrap -argb` window with a colorkey for
      transparency, reusing the daemon's mpv machinery. Few styles, but nothing to lose if GLava goes.
- [x] **Retire the old GLava setup.** (p3) [chore] The i3 `exec glava` is gone, the `glava.*` aliases were removed in
      `~/.shell` 0.23.1 and `~/.config/glava` was deleted (2026-10-30; still in the dotbare history).
