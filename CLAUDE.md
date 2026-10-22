# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

backdrop (formerly pexels-cli): an X11 wallpaper and screensaver manager that collects media from
API-based sources and local folders and displays it through mpv IPC sockets. It is mid-rewrite: the
config and database layer is new, and the commands in `src/commands/` are pre-rename code that is not
registered until ported. Design decisions are in `docs/specs/main.md`; the roadmap is `TODO.md`.

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
  runtime dir; `DisplayControl` is the CLI side, connecting to the mpv socket of the monitor under the pointer;
  `Playlist` owns modes (video/image) and eligibility; `MpvClient` is the JSON IPC client. External tools
  (`xrandr`, `xdotool`, spawn, kill, mpv connect) are injected so tests use fakes (`test/helpers/fakes.js`).
- **Commands** (`src/commands/`) - one class per command, constructed with `(config, database, logger)`.
  `DisplayCommand` is registered; the other files use the old schema and config and are not registered yet;
  `docs/specs/legacy-pexels-cli.md` describes their behavior.

## Conventions

- File status lives in the database; files sit in `media/`, `trash/` or the inbox, never in per-status folders.
- Only sources with a public API; no scraping.
- Never select media smaller than the target monitor unless `display.allow_upscale` is set.
- One playback speed per video, regardless of orientation.
