# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-10-21

### Added
- `backdrop import [dirs...]` copies local wallpapers into the library as `local-1.jpg`, `local-2.mp4`, ...,
  already approved with a 2/3 rating (`library.default_import_rating`). With no folders it uses
  `library.import_dirs`, which the daemon also scans in the background on every start, adding new items to
  the running playlists without interrupting playback.
- Imports skip duplicates by content, files below 1024x768 (`library.min_width` / `min_height`, either
  orientation), hidden folders and non-media files. Unchanged files are not re-read on later scans, and items
  you delete from the library are not imported again.
- Rotated phone videos get their real width and height.

## [2.1.0] - 2026-10-21

### Added
- Display daemon: `backdrop daemon` (foreground) and `backdrop start|stop|status` run one mpv wallpaper per
  monitor via xwinwrap, controlled over mpv IPC sockets, and restart mpv if it exits.
- `backdrop mode` toggles between video and image wallpapers (or `mode video|image`); the mode and the item
  last shown in each mode are remembered, so startup and toggling resume where you left off.
- `backdrop next`, `prev` and `current` act on the monitor under the mouse pointer, or `--monitor <name>`.
- `backdrop speed <0.8|+0.1|-0.1|reset>` changes the playing video's speed and remembers it for future plays.
- Only media at least as large as the monitor is shown, unless `display.allow_upscale` is set.
- `display.xwinwrap_args` and `display.mpv_args` config options. mpv runs without your mpv.conf.

### Changed
- Errors from commands print as one-line messages; full details go to the log file.
- Unknown commands now fail with an error instead of exiting silently.

## [2.0.0] - 2026-10-21

### Added
- `TODO.md` roadmap for the backdrop redesign and known bugs.
- Config sections for sources, local library, display and screensaver settings; see `config.example.yaml`.
- Paths, config values and import folders accept `~`, `$VAR` and `${VAR}`.

### Changed
- Renamed to **backdrop**: package, `backdrop` command and GitHub repo (`njhoffman/backdrop`).
- Config moved to `~/.config/backdrop/config.yaml` and data to XDG locations under `backdrop/`
  (database, log, `media/`, `trash/`, cache `inbox/`, runtime dir for mpv sockets).
- The Pexels API key is now `sources.pexels.api_key` (`PEXELS_API` still works and is never saved to the file).
- New database schema for media from any source, with rating history, playback speed and trash expiry.
  Existing pexels-cli databases are not migrated.
- Requires Node.js 22.13 or later; the `sqlite3` dependency is gone in favor of the built-in `node:sqlite`.

### Removed
- All pexels-cli commands (search, download, list, stats, keep/skip/undo, go-next, import) and the
  `hooks` config, until they are ported to the new layer.
- `SETUP_GUIDE.md` and the unused vectorcode config.

## [1.1.1]

### Changed
- Database tables `videos` and `images` renamed to `pexel_videos` and `pexel_images`.

## [1.1.0]

### Added
- `import` command to copy local media into `videos_local` / `images_local`, with dimensions read via ffprobe or ImageMagick.
- `--rated=landscape|portrait|any` filter for `list-images` and `list-videos`.
- `--portrait` filter for `search-images` and `search-videos`.
- Ratings record the monitor orientation they were made on.

### Changed
- Ratings are stored only in the `ratings` table, no longer duplicated on media rows.

### Fixed
- ES module parse warning (package declared as `"type": "module"`).

## [1.0.0]

### Added
- Search Pexels images and videos with paginated results and rate-limit tracking.
- Download with progress bars into new/kept/skip directories.
- `keep` (1-3 stars), `skip`, and `undo` ratings; `go-next` hook for wallpaper managers.
- `list-images` / `list-videos` with M3U playlist output, `stats`, YAML config, and logging.
