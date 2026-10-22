# backdrop

Wallpaper and screensaver manager for X11. Collects images and videos from free sources (Pexels, with
more API-based sources planned) and your own folders, lets you rate them while they play, and displays
them through mpv with one IPC socket per monitor.

> **Status:** mid-rewrite from `pexels-cli`. The display daemon works; import, sources, rating and the
> screensaver are being ported. See [TODO.md](TODO.md) for the roadmap and
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
- X11 with `xwinwrap`, `mpv`, `xrandr` and `xdotool`; `ffprobe` for media dimensions; `yt-dlp` for stream links
- A Pexels API key for Pexels search

## Install

```bash
git clone git@github.com:njhoffman/backdrop.git
cd backdrop
npm install
npm link
backdrop --help   # creates ~/.config/backdrop/config.yaml on first run
```

## Usage

```bash
backdrop start              # one mpv wallpaper per monitor, in the background
backdrop status             # mode and what each monitor is playing
backdrop mode               # toggle between video and image wallpapers
backdrop next | prev        # on the monitor under the pointer (or --monitor DP-1)
backdrop speed 0.8          # also +0.1, -0.1, reset; remembered for that video
backdrop current
backdrop stop
```

i3 example:

```
exec --no-startup-id backdrop daemon
bindsym $mod+w exec --no-startup-id backdrop mode
bindsym $mod+bracketright exec --no-startup-id backdrop next
bindsym $mod+bracketleft exec --no-startup-id backdrop prev
bindsym $mod+minus exec --no-startup-id backdrop speed -0.1
bindsym $mod+equal exec --no-startup-id backdrop speed +0.1
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
