# TODO

Roadmap for turning pexels-cli into **backdrop**: a source-agnostic wallpaper and screensaver
manager that displays everything through mpv IPC sockets. Section 1 covers bugs found while
surveying the current code; the remaining sections are the planned redesign, roughly in
dependency order.

Reviewed: 2026-10-28

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
- [ ] **No CI.** (p3) [chore] Nothing runs `npm test` on push. Add a GitHub Actions workflow on Node 22.13 and current Node, installing mpv and ffmpeg so the
      integration tests run instead of being skipped.
- [ ] **Stray pexels.log.** (p3) [chore] A 0-byte `pexels.log` from pexels-cli sits in the repo root (ignored by `*.log`). Delete it.

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
- [ ] **Undo can get stuck.** (p3) [bug] `undo` only ever targets the globally latest rating. If that rating cannot be undone (its skip was purged, or
      `download --upgrade` renamed the file so `rated_path` no longer matches), every later `undo` fails the same way. Update `rated_path` when an upgrade renames a file,
      and let undo report and step past an unrestorable rating (or add `undo --discard`).
- [ ] **A missing configured monitor blocks startup.** (p2) [bug] `selectMonitors()` throws when a name in `display.monitors` is not active, so
      `Daemon.start()` fails if that monitor is unplugged at boot, and `targetResolution()` makes search/download fail too. Hotplug already tolerates it at runtime.
      Start with the configured monitors that are present (warn about the rest) and size downloads for those, failing only when none are active.
- [ ] **state.json is written in place.** (p3) [bug] `Daemon.writeState()` uses `fs.writeJson` directly and `readState()` treats a parse error as "not running",
      so a CLI command racing a rewrite (now on every hotplug change) can report the daemon as stopped. Write to a temp file in the runtime dir and rename it.
- [ ] **Hotplug only tested with fakes.** (p3) [test] Reconciliation is covered against a fake `xrandr`; confirm on real hardware (attach, remove, change resolution,
      lid close) and note any xrandr output the parser misses, e.g. monitors without a physical size.
- [ ] **No record of player CPU use.** (p2) [perf] Nothing measures what the mpv instances cost over time. Have the daemon sample each
      screen's mpv CPU (from `/proc/<pid>/stat`, every minute or so) and keep a rolling average per monitor and per item, alongside
      `hwdec-current`, resolution and fps; show it in `status` and `stats`. That shows which items are expensive and whether 4K media
      is worth keeping (2026-10-28 spot check on Iris Xe: 4K24 H.264 ~26% CPU with VA-API vs ~400% in software; 1080p30 ~17%).
- [ ] **Software-decode fallback goes unnoticed.** (p2) [perf] `--hwdec=auto-safe` silently falls back to software for unsupported
      codecs or profiles, which costs about four cores at 4K. `Daemon.onFileLoaded` could read `hwdec-current` and log a warning
      (and mark the item) when it is empty for media larger than 1920x1080.
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

## 4. Media sources

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
      and descriptions, and lists filter with `--tag`. Next: show tag counts in `stats`, add a `tags` command listing them,
      and let the daemon or screensaver play a playlist built from tags (e.g. `backdrop mode video --tag ocean`).
- [ ] **Frame rate unknown until a video plays.** (p3) [feature] Videos added before v7 get `fps` from mpv the first time
      they play. A `backdrop rescan` (ffprobe over existing files) would fill it at once and could also re-check sizes.

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
- [ ] **Wrap detection uses positions from the previous load.** (p3) [bug] `reshuffleOnWrap` compares `playlist-pos` with the position at the
      previous file load. Removals, appends and random moves between loads shift positions, so a wrap can occasionally be missed or an extra
      reshuffle run. Both are harmless; tracking the playing entry's id (`playlist_entry_id` on `start-file`) would make it exact.
- [x] **Detailed, aligned stats.** (p2) [feature] `stats` shows sectioned tables with bars on a terminal:
      library per kind, rating distribution, resolutions, sources, top searches, recent activity, storage, per-monitor
      eligibility and quota (`DatabaseManager.getDetailedStats`, `formatTable` and `stackedBar` in `src/utils/output.js`).
- [ ] **Stats walks the library directories on every run.** (p3) [perf] `directoryUsage` stats every file under media, inbox
      and trash; fine for thousands of files, slow on network mounts. Store file sizes at download/import and sum them in SQL.
- [ ] **No header row for `--line`.** (p3) [feature] Tables want column names; add `--header` (or print one on a terminal only) and document
      `fzf --header-lines=1`.
- [ ] **Release binary.** (p3) [chore] Build a single executable with Node's SEA (bundle `src/` and dependencies with esbuild first; `node:sqlite` is built in),
      attach it to a GitHub release per `vX.Y.Z` tag, and document that mpv, xwinwrap, xrandr, xdotool and ffprobe are still external.
      Check that `package.json` version lookup and any runtime file reads work from inside the bundle.
- [ ] **Rofi control menu.** (p2) [feature] `backdrop menu` (or a shipped script) opens rofi with the current item (name, rating, monitor) and actions:
      keep 1-3, skip, undo, next/prev, go-next, speed presets, mode toggle and monitor choice, then runs the matching command and shows errors via rofi or notify-send.
      Needs `--json` output for `current`, `status` and the lists (deferred here from the styling item); add an i3 keybinding example to `GETTING_STARTED.md`.
- [x] **Unused dependencies.** (p3) [chore] `pexels` and `progress` are no longer imported anywhere (the Pexels adapter uses axios); remove them, and `ProgressBar.js` with the progress-bar item. Done, along with chalk.
- [ ] **Shell completions.** (p3) [feature] Generate zsh and bash completions for commands and options, completing `--monitor` from the running daemon's
      `state.json` and `mode` from video/image.
      Partly done: `backdrop completion zsh` (generated from the Commander definitions, `src/commands/CompletionCommand.js`). Bash remains.
- [ ] **systemd user unit.** (p3) [feature] Ship a `backdrop.service` user unit (`backdrop daemon`, restart on failure, `graphical-session.target`) as an alternative
      to i3 `exec`, and document enabling it.
- [ ] **Notifications stack under deadd-notification-center.** (p3) [bug] `notify-send --replace-id` and the dunst stack tag
      replace the previous notification per monitor on dunst, but deadd returned a new id on 2026-10-28, so rapid `next`
      presses pile up. Check deadd's replace support, or close the previous id (gdbus `CloseNotification`) before sending.
