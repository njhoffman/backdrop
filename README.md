# backdrop

Wallpaper and screensaver manager for X11. Collects images and videos from free sources (Pexels, with
more API-based sources planned) and your own folders, lets you rate them while they play, and displays
them through mpv with one IPC socket per monitor.

> **Status:** the display daemon, local import, Pexels search/download, rating, lists and stats work.
> More sources and the screensaver are planned. See [TODO.md](TODO.md) for the roadmap and
> [docs/specs/main.md](docs/specs/main.md) for the design.

## Features and roadmap

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
backdrop import             # copy library.import_dirs into the library (also runs on every daemon start)
backdrop import ~/walls     # or specific folders
backdrop keep 3             # rate the current item on the monitor under the pointer
backdrop skip               # move it to trash and advance all monitors playing it
backdrop undo               # undo the last rating and file move, across CLI invocations
backdrop go-next            # advance after checking the current item has a rating
backdrop search-videos 'ocean waves'  # also search-images; requires the source API key
backdrop download --total 10 --type videos
backdrop list-videos --rated landscape
backdrop list-images --interactive  # browse and rate downloaded images
backdrop list-videos --playlist ~/walls.m3u
backdrop stats              # local totals and last observed API quota; works offline
backdrop remove --current   # permanently delete the playing library item (original import is preserved)
backdrop remove 42          # or remove an item by its database id
backdrop purge --dry-run    # trash files older than library.trash_days (the daemon purges daily)
backdrop stop
```

`remove --current` accepts `--monitor <name>`. Removal drops the file from all running monitor playlists,
deletes its library copy and database record, and preserves its import record so an unchanged original
is not imported again. It works by ID when the daemon is stopped, too.

`keep`, `skip` and `go-next` accept `--monitor <name>`. Rating an imported item changes its current rating
and preserves undo history. Keep moves new downloads from the inbox into the library; this refreshes
affected playlists and restarts the moved file. Re-rating a file already in the library keeps it playing.

Search and download choose the smallest variant that fits all configured monitors, then probe and hash
downloads before adding them to playback. For use without X, pass `--resolution 1920x1080`. Lists are plain
text by default; `--rated [orientation]`, `--no-local`, `--keywords`, `--source` and `--number` filter them.
See [the source contract and Pexels behavior](docs/specs/sources.md) for adapter details.

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
