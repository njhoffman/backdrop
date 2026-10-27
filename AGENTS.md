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
short: mpv socket paths must fit in 107 bytes. `test/display/mpv.integration.test.js` runs a headless mpv
and is skipped when mpv or ffmpeg is missing.

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
- **DatabaseManager** (`src/database/DatabaseManager.js`) - synchronous `node:sqlite`. Tables: `media`,
  `ratings`, `searches`, `search_results`, `sequences`. Schema version in `PRAGMA user_version`. Status
  (`new`/`kept`/`skipped`) is derived from the latest rating inside the same transaction.
- **Logger** (`src/utils/Logger.js`) - Winston, file plus errors to console.
- **Display** (`src/display/`) - `Daemon` runs one xwinwrap+mpv per monitor and writes `state.json` to the
  runtime dir; it restarts mpv on exit or on failed IPC health checks, drops entries that fail to load, and
  purges expired trash daily (`src/library/purge.js`); `DisplayControl` is the CLI side, connecting to the mpv socket of the monitor under the pointer;
  `Playlist` owns modes (video/image) and eligibility; `MpvClient` is the JSON IPC client. External tools
  (`xrandr`, `xdotool`, spawn, kill, mpv connect) are injected so tests use fakes (`test/helpers/fakes.js`).
- **Library** (`src/library/`) - `Importer` copies local media in as `local-<n>.<ext>`, tracking each source
  file in `imported_files` by size/mtime; `probe.js` wraps ffprobe (kind, rotation-corrected size, duration).
- **Sources** (`src/sources/`) - `Source` defines normalized search/metadata/download variants and rate limits;
  `SourceRegistry` resolves adapters, with `PexelsSource` first. Credentials are checked on API requests only.
  Search/download share monitor-aware selection in `src/library/quality.js`; see `docs/specs/sources.md`.
- **Commands** (`src/commands/`) - one class per command, constructed with `(config, database, logger)`.
  All are registered. `RatingCommand` uses `DisplayControl.current()` and records file movements for persistent
  undo (schema v4); failed database writes restore the file. The obsolete shell-hook command has been removed.
  Lists support plain output, interactive rating and M3U export; stats work offline.

## Conventions

- File status lives in the database; files sit in `media/`, `trash/` or the inbox, never in per-status folders.
- Only sources with a public API; no scraping.
- Never select media smaller than the target monitor unless `display.allow_upscale` is set.
- One playback speed per video, regardless of orientation.
