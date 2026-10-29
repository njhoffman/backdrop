# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.13.0] - 2026-10-28

### Added
- `backdrop completion bash` prints a bash completion script with the same commands, options and values as
  the zsh one, including monitor names from the running daemon; it does not need the bash-completion package.
- `--header` on `current`, `list-images` and `list-videos` prints column names above the `--line` output
  (and implies `--line`), for `fzf --header-lines=1`.
- `undo --discard` drops the latest rating from undo history without touching the item, for a rating whose
  file can no longer be restored; the error for such a rating suggests it.

### Fixed
- Undo no longer gets stuck on an item whose file was purged from trash: purged items' ratings are skipped
  (existing ones are marked on upgrade), so undo reaches the rating before them.
- `download --upgrade` that changes a file's extension no longer breaks undo of that item's ratings.
- The daemon reshuffles the playlist exactly when playback wraps, even after skips, imports or random picks
  moved entries since the previous item started.

### Changed
- The database schema is v9 (ratings undo should skip); it upgrades automatically.

## [2.12.0] - 2026-10-28

### Added
- `backdrop rescan` probes library videos and GIFs that have no frame rate yet; `--all` re-checks the kind,
  size, duration and frame rate of every downloaded file, reports what changed, and lists files missing from
  disk without removing them.
- The daemon measures how much CPU each monitor's mpv uses (every 30 seconds) and which decoder it uses.
  `status` shows each monitor's recent average and decoder, `current` the playing item's average, and `stats`
  a "Playback cost" section by kind, size and hardware or software decoding, with the most expensive items.
- A warning in the log when mpv decodes a video above 1080p in software.

### Fixed
- The daemon no longer refuses to start when a monitor named in `display.monitors` is unplugged: it starts
  on the connected ones, or waits with none, and adds the rest when they appear. Search and download size
  for the connected monitors and warn about the missing ones.
- A command run while the daemon rewrote its state file could report the daemon as not running.

### Changed
- The database schema is v8 (playback cost per item); it upgrades automatically.

## [2.11.0] - 2026-10-28

### Added
- Desktop notifications through `notify-send` when a command changes what plays (`next`, `prev`, `skip`,
  `go-next`, `keep --next`, `mode`): id, kind and resolution, then duration and frame rate for videos, the
  rating, the monitor and tags. `display.notify: all` has the daemon notify on every change, including
  automatic advances; `off` disables them.
- `display.video_duration` (default 600 seconds) moves on to the next video after about that long. Short
  videos loop as many whole times as fit, so they never stop mid-clip; longer ones stop at the limit. `0`
  keeps looping each video forever, as before.
- Tags: words from a local file's name, the source page and its description are stored for every item
  (existing items are tagged on upgrade), shown under each item, matched by `--keywords`, and filtered with
  `list-images --tag` / `list-videos --tag` (every given tag must match).
- Video frame rates, probed on import and download, shown next to the duration and as a new `--line` column
  after the running time. Videos already in the library get theirs the first time they play.
- `--no-random` on `next`, `skip`, `go-next` and `keep --next` plays the next item of the shuffled playlist.

### Changed
- `display.order` defaults to `random`, so navigation commands pick a random item; set it to `shuffle` to
  keep the previous behavior. Automatic advances still follow the shuffled playlist.
- `keep` prints the rated item with its new rating (one line before the new item with `--next`), and `undo`
  prints the restored item with the rating it has again.
- `--line` output has a frame rate column after the running time; scripts that pick tab-separated fields by
  position (e.g. `fzf --with-nth`) need the later fields shifted by one.
- The database schema is v7 (frame rate column and a tag table); it upgrades automatically.

## [2.10.0] - 2026-10-28

### Changed
- `backdrop stats` is split into aligned sections: the library per kind (new, kept, skipped, pending, playing
  time, with a kept/new/skipped bar), the current rating distribution and orientation, resolutions by short
  side, sources with average rating, top searches, the last 7 days of activity, storage used by media, inbox
  and trash, items eligible on each monitor when the daemon runs, and the API quota. Bars appear only on a
  terminal; piped output stays plain and aligned. Library "new" no longer counts pending items that were never
  downloaded.

## [2.9.0] - 2026-10-28

### Added
- `next`, `prev`, `skip`, `go-next` and `mode` print the item the target monitor now plays, with its rating,
  speed, dim and monitor.
- `keep --next` rates the current item and then plays the next one.
- `--random` on `next`, `skip`, `go-next` and `keep --next` plays a random item; `prev` still returns to the
  item before it. `display.order: random` makes that the default.
- `--line` on `current`, `next`, `prev`, `skip`, `go-next`, `keep`, `mode`, `list-images` and `list-videos`
  prints one line per item: aligned and styled on a terminal, tab-separated when piped for fzf or tables.
- `backdrop` with no arguments shows the status.

### Fixed
- The playlist no longer repeats the same order on every pass: the daemon reshuffles it when playback wraps
  to the first entry.

## [2.8.0] - 2026-10-27

### Added
- `backdrop completion zsh` prints a zsh completion script built from the CLI's own commands and options.
  It completes `--monitor` from the running daemon (or `xrandr`), `--resolution` from active monitors,
  sources, modes, types, statuses, ratings, import directories and M3U playlist files.

## [2.7.0] - 2026-10-27

### Added
- `backdrop pending` lists media saved by searches and not yet downloaded, with kind, resolution, running
  time, the variant it would download, and the queries that found it, plus a count per query. It works
  offline; without X, pass `--resolution`.
- Downloads, lists, `current`, `status` and `stats` show resolution, video running time (`0:18`),
  orientation, file size, star ratings and the search queries behind each item.
- `BACKDROP_SYMBOLS=nerd|unicode|ascii|auto` overrides `output.symbols`, and every symbol set now has
  media icons (Nerd Font glyphs with `nerd`).

### Changed
- On a terminal, paths under your home directory are shown with `~`; piped output keeps full paths.
- Output of `list-*`, `current` and `status` puts each item on a heading line with its path, queries and
  credit indented below. `current` still prints the bare path first.
- The database upgrades to schema v6 in place.

### Fixed
- A download whose content matches an item you already have is no longer retried on every `backdrop download`.
  It is recorded as a duplicate, and the queries that found it are added to the original.

## [2.6.0] - 2026-10-27

### Added
- `backdrop dim <0-100|+N|-N|reset>` darkens the playing image or video and remembers it for that item,
  like `speed`. The database upgrades to schema v5 in place.
- The daemon follows monitors being attached, removed or reconfigured, within about 5 seconds and without
  a restart.
- `backdrop download --upgrade` replaces downloads that are smaller than your current monitors with a
  larger variant, keeping ratings, speed and dim. A failed upgrade leaves the original file in place.
- `backdrop status` shows how many items each monitor can play and explains a blank monitor.

### Changed
- The first-run "Created default config file" notice goes to stderr, so it no longer mixes with command output.

## [2.5.0] - 2026-10-27

### Added
- Progress bars for `backdrop import` and `backdrop download`, with a color gradient, rate, time remaining
  and the current file (bytes received for downloads). They draw on stderr only in a terminal. Colors come
  from `output.progress_gradient`.
- Interactive runs print a dim `backdrop vX.Y.Z` line first; the daemon logs its version at startup.
- The daemon's startup import logs the file count and progress every 30 seconds.
- `output.symbols` chooses status symbols: `auto` (Unicode on a UTF-8 terminal, else ASCII), `nerd`,
  `unicode` or `ascii`.

### Changed
- Consistent colors and status symbols across all commands. Piped output, M3U exports and scripts get
  the same plain text as before; `NO_COLOR` and `FORCE_COLOR` are honored.

### Removed
- Unused `chalk`, `pexels` and `progress` dependencies and the legacy progress bar.

## [2.4.2] - 2026-10-27

### Changed
- Roadmap (`TODO.md`) adds monitor hotplug, upgrading downloads for larger monitors, clearer status for
  blank monitors, and a CLI experience section: output styling, progress bars, version display, a release
  binary and a rofi control menu.

## [2.4.1] - 2026-10-27

### Changed
- `GETTING_STARTED.md` lists prerequisites with a quick check instead of one machine's setup, and
  describes trash purging, missing-file handling and mpv restarts as they now work.

### Removed
- `docs/specs/changelog.md`; `CHANGELOG.md` is the only changelog.

## [2.4.0] - 2026-10-27

### Added
- `backdrop purge [--dry-run]` deletes trash files skipped more than `library.trash_days` ago; the daemon
  also purges at start and every 24 hours. `trash_days: 0` disables purging. Purged items keep their
  history, so later searches do not offer them again; undoing a purged skip explains why it cannot be restored.
- The daemon checks every mpv over IPC every 30 seconds and restarts one that stops responding.

### Fixed
- Files that fail to load (moved or deleted outside backdrop) are dropped from the running playlist instead
  of being retried on every pass.

## [2.3.0] - 2026-10-27

### Added
- Restored `keep`, `skip`, `undo` and `go-next` through mpv sockets with monitor targeting. Ratings include
  reversible file movements; undo works across CLI invocations. Skips remove all monitor playlist references.
- Source adapter contract for search, metadata, resolution variants and quotas, with Pexels first.
  Restored `search-images`, `search-videos` and `download`, choosing the smallest fitting variant and storing
  measured dimensions and content hashes. Downloads update running playlists and clean up failed files.
- Restored `list-images`, `list-videos` and offline `stats`; lists support current-rating and keyword filters,
  interactive rating and M3U export. API credentials are required only for authenticated source requests.
- `backdrop remove <id>` and `backdrop remove --current [--monitor <name>]` permanently delete an item
  and its library file, removing every occurrence from running monitor playlists first. Original import
  files and their scan records are preserved, so unchanged originals are not imported again.

### Changed
- Database schema v4 adds rating path history and upgrades existing databases in place.
- Playlist appends avoid duplicates when re-rating or restoring an item.
- Agent guidance moved to `AGENTS.md`, which `CLAUDE.md` imports, and now states the release workflow.

### Removed
- Legacy shell-hook implementation; display control uses mpv IPC exclusively.

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
