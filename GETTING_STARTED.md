# Getting started with Backdrop

Backdrop is ready to use for wallpapers on X11. It supports local images, videos and GIFs,
one mpv wallpaper per monitor, ratings, and Pexels search and download.

As checked on 2026-10-23, this machine has an X11 session and Node.js, mpv, ffprobe, ffmpeg,
xwinwrap, xrandr and xdotool installed. Project dependencies and a Backdrop config already exist.
The latest test suite passed 241 tests, including real mpv integration tests. Displaying it on
your desktop is still the final practical check.

## 1. Make the command available

From the current checkout:

```bash
cd ~/ghq/github.com/njhoffman/backdrop
npm link
backdrop --help
```

You can also run any command as `node src/index.js …` from the checkout without linking.
On a fresh checkout, run `npm install` first. Node.js 22.13 or later is required.

## 2. Configure your wallpaper folders

Edit `~/.config/backdrop/config.yaml`. Merge these settings into the existing file, using folders
you actually have:

```yaml
library:
  import_dirs:
    - ~/Pictures/wallpapers
    - ~/Videos/live-wallpapers

display:
  monitors: auto
  image_duration: 300
  allow_upscale: false
```

Imports copy your files, preserve the originals, and approve the library copies with a 2/3 rating.
By default, only media large enough for each monitor plays. Media below the library minimum of
1024x768, in either orientation, is not imported.

`monitors: auto` manages all active monitors. To select particular outputs, use a list such as
`monitors: [DP-1, HDMI-1]`.

## 3. Import and start

```bash
backdrop import
backdrop mode video       # videos and GIFs
backdrop start
backdrop status
```

You can also import a specific folder:

```bash
backdrop import ~/Pictures/wallpapers
```

Use `backdrop mode image` for an image slideshow. Videos and GIFs loop until you advance them;
images change at the configured `image_duration` interval, which defaults to 300 seconds.

## Everyday commands

| Command | What it does |
| --- | --- |
| `backdrop next` / `backdrop prev` | Change the wallpaper |
| `backdrop mode` | Toggle images and videos |
| `backdrop current` | Show the playing file, ID and rating |
| `backdrop speed 0.8` | Slow the current video; remembered for future playback |
| `backdrop speed +0.1` / `backdrop speed -0.1` | Adjust playback speed |
| `backdrop speed reset` | Restore normal speed |
| `backdrop keep 3` | Change the current item's rating; accepts 1–3 |
| `backdrop skip` | Move the item to trash and advance monitors playing it |
| `backdrop undo` | Restore the last rating and file move, across CLI invocations |
| `backdrop go-next` | Advance after checking the current item has a rating |
| `backdrop remove --current` | Permanently delete the current library copy and database record |
| `backdrop remove 42` | Permanently remove an item by its database ID |
| `backdrop list-videos --rated landscape` | List kept videos rated on a landscape monitor |
| `backdrop list-images --interactive` | Browse and rate downloaded images |
| `backdrop list-videos --playlist ~/walls.m3u` | Export a playlist |
| `backdrop stats` | Show library totals and last observed API quota; works offline |
| `backdrop stop` | Stop wallpaper playback |

Playback commands target the monitor under your pointer. Add `--monitor DP-1` to choose one
explicitly; `backdrop status` shows monitor names. `keep`, `skip`, `go-next` and `remove --current`
also accept `--monitor`.

Removal preserves original imported files and their scan records, so unchanged originals are not
imported again. Permanent removal cannot be reversed with `undo`.

## Search and download from Pexels

Set `sources.pexels.api_key` in the config:

```yaml
sources:
  pexels:
    api_key: "your-pexels-api-key"
```

Alternatively, export `PEXELS_API` in the shell running the search command.

```bash
backdrop search-videos 'ocean waves'
backdrop download --total 10 --type videos
```

For images:

```bash
backdrop search-images 'mountain landscape'
backdrop download --total 10 --type images
backdrop mode image
```

Downloads enter playback for review; `keep` moves them from the inbox into the permanent library.
Search and download select the smallest variant that fits all configured monitors. Downloads are
probed and hashed before admission. For use without X, pass `--resolution 1920x1080` to search and
download commands.

Local wallpapers need no API key. The Pexels adapter has mocked tests but has not been verified
against the live API. See [the source documentation](docs/specs/sources.md) for details and the
[Pexels API documentation](https://www.pexels.com/api/documentation/) for its usage guidelines.

## Start automatically with i3

Add this to your i3 config:

```i3
exec --no-startup-id backdrop start
```

Optional keybindings:

```i3
bindsym $mod+w exec --no-startup-id backdrop mode
bindsym $mod+bracketright exec --no-startup-id backdrop next
bindsym $mod+bracketleft exec --no-startup-id backdrop prev
bindsym $mod+minus exec --no-startup-id backdrop speed -0.1
bindsym $mod+equal exec --no-startup-id backdrop speed +0.1
```

## Current limitations and troubleshooting

- X11 is supported; Wayland is out of scope.
- Screensaver and automatic trash purging are not implemented. `trash_days` does not yet trigger cleanup.
- Import folders rescan on startup or `backdrop import`; live watching is not implemented.
- Moving a newly kept file from the inbox refreshes affected playlists and restarts that file.
  Re-rating a file already in the library keeps it playing.
- Avoid manually moving or deleting managed library files while Backdrop runs. Missing-file recovery
  and health checks for an unresponsive mpv remain on the roadmap.

If startup fails, run `backdrop daemon` in a terminal to see errors. If Backdrop is already running,
stop it first with `backdrop stop`.

By default, logs are at `~/.local/share/backdrop/backdrop.log`, library files at
`~/.local/share/backdrop/media`, trash at `~/.local/share/backdrop/trash`, and unreviewed downloads
at `~/.cache/backdrop/inbox`. XDG environment variables and explicit path configuration can change
these locations.

See [README.md](README.md), [the config reference](docs/specs/config.md), and [TODO.md](TODO.md)
for more details.
