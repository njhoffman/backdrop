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
- [x] **No tests for commands.** (p2) [test] Search, download, rating, import, removal, lists and stats have command tests;
      CLI subprocess tests cover registration, offline operation and failing exit codes. Real mpv tests cover rating and playback transitions.
- [ ] **Changelog lives in docs/specs.** (p3) [docs] `docs/specs/changelog.md` duplicates the new root `CHANGELOG.md` and embeds prompts. Drop it or reduce it to a pointer.
- [x] **No version tags.** (p3) [chore] Releases 1.0.0 to 1.1.1 exist only in docs; every release from v2.0.0 on has an annotated `vX.Y.Z` tag.
- [ ] **Stale .claude/preferences.json.** (p3) [chore] Untracked generated file still names `pexels-cli` and describes jest/eslint/prettier setups the repo does not use.
      Agents may read it as project guidance that contradicts `AGENTS.md`. Delete it or add `.claude/preferences.json` to `.gitignore`.
- [ ] **GETTING_STARTED.md describes one machine.** (p3) [docs] It records a 2026-10-23 check of this machine's tools and test count, which goes stale and means nothing on another checkout.
      Replace that with a prerequisites list (Node 22.13+, mpv, ffmpeg/ffprobe, xwinwrap, xrandr, xdotool) and a `backdrop` self-check command or script.

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
- [ ] **Quiet config creation in tests.** (p3) [test] `ConfigManager.createDefaultConfig()` prints to stdout during `npm test`; inject an output stream or silence it in tests.

## 4. Media sources

- [x] **Source plugin interface.** (p1) [refactor] `Source`/`SourceRegistry` provide search, metadata, normalized download
      variants and quota information; Pexels is the first adapter. Source-specific credentials are checked only on API requests.
      See `docs/specs/sources.md` for the contract and current Pexels endpoints.
- [ ] **Unsplash source.** (p2) [feature] Official API, images only; requires an access key and attribution/download-tracking per their guidelines.
- [ ] **Other free sources.** (p3) [feature] Only sites with a public API qualify; scraping is out (decided 2026-10-21).
      That excludes MoeWalls and wallsflow.com (checked 2026-10-21: `/api/` redirects to the homepage, no developer docs).
      Candidates: Wallhaven (API with resolution filters), Pixabay (API, has video). Pick after the interface exists.

## 5. Local library import

- [x] **Auto-import local files as pre-approved.** (p1) [feature] Scan configured directories (and `backdrop import <dir>`), add files directly to the kept library with rating 2/3 and no review step.
      Done: `backdrop import`, rescanned on every daemon start; copies (originals untouched), dedupes by SHA-256, skips unchanged files by size/mtime, rejects < 1024x768.
- [x] **Consistent names for imports.** (p2) [feature] Rename imported files to a sequential `local-<n>.<ext>` (no category detection, decided 2026-10-21).
      Keep the original filename and path in the DB; never reuse a number after deletion.
- [ ] **Watch mode for import directories.** (p3) [feature] Pick up new files while the daemon runs (fs.watch / inotify) instead of only on start or `backdrop import`.
- [x] **No command to remove an item from the library.** (p2) [feature] `backdrop remove <id>` or `backdrop remove --current [--monitor <name>]`
      deletes the file and media row after removing all playlist references. `imported_files` keeps the source record so unchanged originals are not re-imported.
- [ ] **Animated WebP imports as a still image.** (p3) [bug] ffprobe cannot decode animated WebP, so `probe.js` classifies it as `image`; detect the ANIM chunk and treat it as `gif`.
- [ ] **Import progress for large first runs.** (p3) [feature] The first scan hashes and copies everything; the daemon logs only a summary at the end. Log periodic progress, and show a running count in `backdrop import`.
- [x] **Edit rating during playback.** (p2) [feature] `keep N` changes the effective current rating for imported items;
      prior ratings remain as undo history, and repeated ratings do not duplicate playlist entries or restart media already in the library.

## 6. Resolution-aware quality filter

- [x] **Never upscale.** (p1) [feature] Search/download and playback filter against configured xrandr monitors;
      `--resolution WIDTHxHEIGHT` supports headless source commands. `display.allow_upscale` is the explicit override.
- [x] **Pick the best download variant.** (p2) [perf] Download the smallest variant by pixel area that meets all target
      monitor dimensions and the library minimum.
- [x] **Store measured dimensions.** (p2) [feature] Download/import probe real dimensions, kind and duration with ffprobe;
      a later source search preserves measurements for files already downloaded.

## 7. Screensaver

- [ ] **Idle-triggered screensaver.** (p2) [feature] After N minutes of inactivity (xprintidle or an xss-lock / xidlehook integration), play a configured set of media fullscreen through mpv; stop on activity.
- [ ] **Screensaver playlists.** (p2) [feature] Sources: rated live wallpapers, separate video files, and YouTube links (mpv + yt-dlp). Configurable per playlist, shuffle, and per-item speed.
- [ ] **Coexist with locker and DPMS.** (p3) [feature] Decide interaction with the screen locker and monitor sleep, and inhibit during fullscreen apps or media playback.
