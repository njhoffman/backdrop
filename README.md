# backdrop

Wallpaper and screensaver manager for X11. Collects images and videos from free sources (Pexels, with
more API-based sources planned) and your own folders, lets you rate them while they play, and displays
them through mpv with one IPC socket per monitor.

> **Status:** mid-rewrite from `pexels-cli`. The new config and database layer is in place; commands are
> being ported onto it and are not available yet. See [TODO.md](TODO.md) for the roadmap and
> [docs/specs/main.md](docs/specs/main.md) for the design.

## Planned features

- Search and download from sources with a public API, picking the smallest file that still fills your monitor
- Never upscale: media smaller than the target monitor is not shown
- Rate the item on screen (keep 1-3 or skip); skipped files go to a trash that empties itself
- Per-video playback speed, remembered for future plays
- Automatic import of local wallpapers as approved items (`local-1.jpg`, `local-2.mp4`, ...)
- Screensaver after a period of inactivity, from rated videos or stream links such as YouTube

## Requirements

- Node.js 22.13 or later (uses the built-in `node:sqlite`)
- X11 with `xwinwrap` and `mpv`; `ffprobe` for media dimensions; `yt-dlp` for stream links
- A Pexels API key for Pexels search

## Install

```bash
git clone git@github.com:njhoffman/backdrop.git
cd backdrop
npm install
npm link
backdrop --help   # creates ~/.config/backdrop/config.yaml on first run
```

## Configuration

`~/.config/backdrop/config.yaml`; see [config.example.yaml](config.example.yaml) and
[docs/specs/config.md](docs/specs/config.md). Data lives under `~/.local/share/backdrop`, unreviewed
downloads under `~/.cache/backdrop/inbox`, and mpv sockets under `$XDG_RUNTIME_DIR/backdrop`.

## Development

```bash
npm test
```

## License

MIT
