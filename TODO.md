# TODO

Roadmap for turning pexels-cli into **backdrop**: a source-agnostic wallpaper and screensaver
manager that displays everything through mpv IPC sockets. Section 1 covers bugs found while
surveying the current code; the remaining sections are the planned redesign, roughly in
dependency order.

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
- [ ] **No tests for commands.** (p2) [test] Only `ConfigManager` and `DatabaseManager` have tests; the search, download, rating, hook and import commands have none.
      The insert bug above would have been caught by one. Add command tests with sinon stubs for API and fs.
- [ ] **Changelog lives in docs/specs.** (p3) [docs] `docs/specs/changelog.md` duplicates the new root `CHANGELOG.md` and embeds prompts. Drop it or reduce it to a pointer.
- [ ] **No version tags.** (p3) [chore] Releases 1.0.0 to 1.1.1 exist only in docs; there are no `vX.Y.Z` tags. Tag from here on.

## 2. Rename to backdrop

- [x] **Rename project and repo to backdrop.** (p1) [chore] Package, bin, CLI name, README, CLAUDE.md and specs renamed; GitHub repo renamed to `njhoffman/backdrop` and origin updated.
      `SETUP_GUIDE.md` removed; the old spec is kept as `docs/specs/legacy-pexels-cli.md`. Breaking change, so this ships as 2.0.0.
- [x] **Move the local checkout.** (p2) [chore] Moved to `~/ghq/github.com/njhoffman/backdrop`; `~/git/backdrop` symlink replaces `~/git/pexels-cli`.
- [x] **Decouple config and paths from Pexels.** (p1) [refactor] Move `~/.config/pexels.yaml` to `~/.config/backdrop/config.yaml` and `~/.local/share/pexels`, `~/.cache/pexels` to `backdrop`.
      Put source credentials under a `sources:` map (`sources.pexels.api_key`, `sources.unsplash.access_key`), keep `PEXELS_API` as a fallback.
      Done: XDG paths (`paths` not written to the file), `sources`/`library`/`display`/`screensaver` sections; see `docs/specs/config.md`.
- [x] **Source-neutral database schema.** (p1) [refactor] `media`, `ratings`, `searches`, `search_results`, `sequences` on built-in `node:sqlite`; see `docs/specs/database.md`.
      No data migration: backdrop starts with an empty database (decided 2026-10-21).
- [ ] **Port old commands onto the new layer.** (p1) [refactor] `src/commands/*.js` still use the old schema and `hooks` config and are not registered in `src/index.js`.
      Port each (or replace it via projects 3-5) and delete the old file: Search/Download (project 4), List, Stats, Rating/Hook (project 3), Import (project 5).
      `docs/specs/legacy-pexels-cli.md` describes their old behavior.
- [ ] **Trash purge.** (p2) [feature] Delete files and rows from `DatabaseManager.getExpiredTrash(library.trash_days)`; run on startup or from the daemon.
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
- [ ] **Rate the current item via the socket.** (p1) [refactor] Rework `keep` / `skip` / `undo` / `go-next` (`RatingCommand`, `HookCommand`) to read the current path from mpv instead of a shell hook.
      Use `DisplayControl.current()` for the target; on skip, `playlist-remove current` and move the file to trash; undo moves it back.
- [ ] **Playlists go stale while the daemon runs.** (p2) [feature] Media imported or downloaded after start only appears after `backdrop mode` or a restart.
      Rebuild the monitor's playlist when the library changes (e.g. after import/download, or when mpv wraps around via `playlist-pos` returning to 0).
- [ ] **Missing files can make mpv spin.** (p2) [bug] If every playlist entry fails to load (files moved or deleted outside backdrop), `--loop-playlist=inf` keeps retrying.
      Watch `end-file` events with `reason: error` in `Daemon`, drop those entries, and stop on an empty playlist.
- [ ] **Hung mpv is not detected.** (p3) [feature] Supervision only reacts to process exit; an mpv that stops answering IPC stays up. Add a periodic `get_property pid` health check.
- [ ] **Quiet config creation in tests.** (p3) [test] `ConfigManager.createDefaultConfig()` prints to stdout during `npm test`; inject an output stream or silence it in tests.

## 4. Media sources

- [ ] **Source plugin interface.** (p1) [refactor] Extract a `Source` contract (search, metadata, download URLs with resolutions, rate limits) from `SearchCommand` / `DownloadCommand`, with Pexels as the first implementation.
- [ ] **Unsplash source.** (p2) [feature] Official API, images only; requires an access key and attribution/download-tracking per their guidelines.
- [ ] **Other free sources.** (p3) [feature] Only sites with a public API qualify; scraping is out (decided 2026-10-21).
      That excludes MoeWalls and wallsflow.com (checked 2026-10-21: `/api/` redirects to the homepage, no developer docs).
      Candidates: Wallhaven (API with resolution filters), Pixabay (API, has video). Pick after the interface exists.

## 5. Local library import

- [ ] **Auto-import local files as pre-approved.** (p1) [feature] Scan configured directories (and `backdrop import <dir>`), add files directly to the kept library with rating 2/3 and no review step.
      Rewrite of the empty `src/commands/ImportCommand.js`. Dedupe by content hash so re-runs are idempotent.
- [ ] **Consistent names for imports.** (p2) [feature] Rename imported files to a sequential `local-<n>.<ext>` (no category detection, decided 2026-10-21).
      Keep the original filename and path in the DB; never reuse a number after deletion.
- [ ] **Watch mode for import directories.** (p3) [feature] Optionally pick up new files automatically instead of on manual runs.
- [ ] **Edit rating during playback.** (p2) [feature] Imported items start at 2/3; ensure `keep N` on the current item overwrites rather than appends a rating.

## 6. Resolution-aware quality filter

- [ ] **Never upscale.** (p1) [feature] Only select media whose width and height are >= the target monitor's resolution (after orientation); higher-res media is fine since it scales down.
      Apply at search/download time and at playback selection. Read monitor geometry via xrandr (or the compositor).
- [ ] **Pick the best download variant.** (p2) [perf] Pexels `video_files` / `src` have several sizes; download the smallest one that still meets the largest monitor, not always the largest.
- [ ] **Store measured dimensions.** (p2) [feature] Probe real width/height with ffprobe on download/import instead of trusting API metadata or filenames.

## 7. Screensaver

- [ ] **Idle-triggered screensaver.** (p2) [feature] After N minutes of inactivity (xprintidle or an xss-lock / xidlehook integration), play a configured set of media fullscreen through mpv; stop on activity.
- [ ] **Screensaver playlists.** (p2) [feature] Sources: rated live wallpapers, separate video files, and YouTube links (mpv + yt-dlp). Configurable per playlist, shuffle, and per-item speed.
- [ ] **Coexist with locker and DPMS.** (p3) [feature] Decide interaction with the screen locker and monitor sleep, and inhibit during fullscreen apps or media playback.
