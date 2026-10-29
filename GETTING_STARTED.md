# Getting started with Backdrop

Backdrop is ready to use for wallpapers on X11. It supports local images, videos and GIFs,
one mpv wallpaper per monitor, ratings, and Pexels search and download.

## Prerequisites

- An X11 session (Wayland is not supported)
- Node.js 22.13 or later
- `mpv`, `xwinwrap`, `xrandr` and `xdotool` for playback
- `ffprobe` (from ffmpeg) for import and download; `ffmpeg` itself is only needed by the test suite

To check them all at once:

```bash
node --version
for tool in mpv xwinwrap xrandr xdotool ffprobe ffmpeg; do
  command -v "$tool" >/dev/null || echo "missing: $tool"
done
```

## 1. Make the command available

From your checkout:

```bash
npm install
npm test          # optional; real mpv tests are skipped when mpv or ffmpeg is missing
npm link
backdrop --help
```

You can also run any command as `node src/index.js …` from the checkout without linking.

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
  order: shuffle
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
| `backdrop dim 30` / `backdrop dim +10` / `backdrop dim reset` | Darken the current image or video (0-100); remembered for that item |
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
| `backdrop purge --dry-run` | List trash older than `library.trash_days`; drop `--dry-run` to delete it |
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

If you later attach a larger monitor, `backdrop download --upgrade` refetches downloads that are now
too small at a size that fits, keeping their ratings, speed and dim. Local imports cannot be upgraded;
they keep playing on the monitors they fit. `backdrop status` shows how many items each monitor can show
and why one is blank.

Local wallpapers need no API key. The Pexels adapter has mocked tests but has not been verified
against the live API. See [the source documentation](docs/specs/sources.md) for details and the
[Pexels API documentation](https://www.pexels.com/api/documentation/) for its usage guidelines.

## Start automatically with i3

Add this to your i3 config:

```i3
exec --no-startup-id backdrop start
```

Or run the daemon as a systemd user service, which restarts it if it crashes and logs to the journal.
`backdrop systemd` prints a unit with your current PATH and the paths to node and backdrop written in:

```bash
backdrop systemd > ~/.config/systemd/user/backdrop.service
systemctl --user daemon-reload && systemctl --user enable backdrop
```

i3 does not start `graphical-session.target`, and the service needs your X display, so replace the
`exec` line above with:

```i3
exec --no-startup-id systemctl --user import-environment DISPLAY XAUTHORITY && systemctl --user start backdrop
```

`backdrop stop` still works and is not restarted; `journalctl --user -u backdrop` shows the daemon's output.

Optional keybindings:

```i3
bindsym $mod+w exec --no-startup-id backdrop mode
bindsym $mod+bracketright exec --no-startup-id backdrop next
bindsym $mod+bracketleft exec --no-startup-id backdrop prev
bindsym $mod+minus exec --no-startup-id backdrop speed -0.1
bindsym $mod+equal exec --no-startup-id backdrop speed +0.1
bindsym $mod+b exec --no-startup-id backdrop menu
bindsym $mod+Shift+b exec --no-startup-id backdrop menu --stay
```

`backdrop menu` opens rofi for the monitor under the pointer: keep 1-3 (each then plays the next item),
skip, undo, prev, next, random, go-next, speed and dim steps, the mode switch and the target monitor. The
default `panel` style shows a preview banner, the file name, resolution, duration and rating above a grid
of icon buttons, with the current rating highlighted; `menu.style: minimal` (or `--style minimal`) is a
plain list with icons. It closes after one action (`--stay` keeps it open until Escape); speed and dim
stay in their submenu for repeated steps. Errors appear as desktop notifications, since a keybinding has
no terminal. Pass rofi options with `menu.rofi_args`, e.g. a `-theme-str` to recolor the panel.

## Current limitations and troubleshooting

- X11 is supported; Wayland is out of scope.
- The screensaver is not implemented yet.
- Skipped files stay in trash for `library.trash_days` (default 30, `0` keeps them forever). The daemon
  purges older ones at start and daily; a purged skip cannot be undone.
- Import folders rescan on startup or `backdrop import`; live watching is not implemented.
- Moving a newly kept file from the inbox refreshes affected playlists and restarts that file.
  Re-rating a file already in the library keeps it playing.
- Avoid manually moving or deleting managed library files while Backdrop runs. Files that fail to load
  are dropped from the running playlist (and logged), but stay in the database until you `remove` them.
- An mpv that stops responding is restarted automatically; if it keeps failing, that monitor is given up
  on and the log says so.
- Monitors you attach, remove or reconfigure are picked up within about 5 seconds, without restarting.

If startup fails, run `backdrop daemon` in a terminal to see errors. If Backdrop is already running,
stop it first with `backdrop stop`.

By default, logs are at `~/.local/share/backdrop/backdrop.log`, library files at
`~/.local/share/backdrop/media`, trash at `~/.local/share/backdrop/trash`, and unreviewed downloads
at `~/.cache/backdrop/inbox`. XDG environment variables and explicit path configuration can change
these locations.

See [README.md](README.md), [the config reference](docs/specs/config.md), and [TODO.md](TODO.md)
for more details.
