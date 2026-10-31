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
| `backdrop stop` | Stop wallpaper playback (and the visualizer) |
| `backdrop stop --wallpaper` / `start --wallpaper` | Turn only the wallpaper off or on; `--visualizer` does the same for the visualizer |

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

To fetch only what one search found, or only items with some tags, filter `pending` and `download`:

```bash
backdrop pending --query 'ocean waves'
backdrop download --query 'ocean waves' --tag sunset
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
bindsym $mod+Shift+b exec --no-startup-id backdrop menu --no-random --tag ocean
```

`backdrop menu` opens rofi for the monitor under the pointer with two rows of buttons, each with a key:

| Key | Button | Key | Button |
|-----|--------|-----|--------|
| `n` | next | `p` | prev |
| `1` `2` `3` | keep 1-3, then play the next item | `s` | skip |
| `v` | speed (velocity) steps | `u` | undo |
| `m` | switch video/image mode | `d` | dim steps |

The menu stays open after each action until you press `q`, or Escape on the main menu; Escape in the
speed or dim submenu goes back to the main menu. With more than one monitor, Tab picks the monitor the
buttons act on. Buttons that do not apply (speed on an image, rating with nothing playing) stay in place,
faded. The current rating, a changed speed and dim are highlighted. A single click runs a button. The speed
steps run from 0.4 to 1, and +0.1 stops at 1.

With i3, the menu switches the monitor to an empty workspace named `backdrop` while it is open, so the
wallpaper is in full view, and returns to the previous workspace when it closes. Set `menu.workspace` to
another name, or to `false` to stay on the current workspace. Picking another monitor with Tab leaves the
empty workspace on the first one.

The default `panel` style shows a preview banner, the file name, and under it the resolution, duration and
rating, with the menu's status right-aligned in the same box: whether next picks randomly and any filters. Those
are the ones `next` keeps using: set them with `backdrop next` or when opening the menu, with
`--random`/`--no-random` (default `display.order`) and `--query`, `--tag` and `--keywords`. They apply to next
and to the item after keep and skip (when nothing else matches, those advance as usual) until `next --clear`
or a daemon restart. `--image-duration` and `--video-duration` (e.g. `60`, `90s`, `5m`; `0` loops videos
forever) work the same way, over `display.image_duration` and `display.video_duration`; they apply at once to
what is playing and are listed with the filters.
`menu.style: minimal` (or `--style minimal`) is a plain list with icons and keys. Errors appear as desktop
notifications, since a keybinding has no terminal. Pass rofi options with `menu.rofi_args`, e.g. a
`-theme-str` to recolor the panel. The daemon makes the preview of each item as it starts playing, and of
the next one in the playlist, so the menu rarely waits for ffmpeg.

## Music visualizer

Backdrop can run [GLava](https://github.com/jarcode-foss/glava) above the wallpaper on each monitor, below
every window, with clicks passing through. It needs `glava` and a compositor (picom or similar), since the
visualizer is drawn with real transparency. Turn it on in the config, and remove any `exec glava` from
your i3 config so it does not run twice:

```yaml
visualizer:
  enabled: true
  module: bars                 # bars, graph, radial, circle or wave
  placement: {anchor: bottom, height: 25%}
  bars: {width: 20, gap: 1, amplify: 200, colors: ['#000000', '#33aacc']}
```

Several visualizers can run at once: list them under `instances`, each with a `name` and any instance
setting (module, placement, opacity, module options); the rest of the section is their default, and the
list order is the stacking order. Presets are named looks under `presets` that can change any of this,
including the instances. Four ship with backdrop (`subtle`, `ring`, `wave`, `party`); `backdrop visualizer
preset` lists them, `backdrop visualizer preset party` switches until the daemon restarts, `--next` cycles
and `--clear` goes back to `visualizer.preset`. With `only_while_playing: true` the visualizer stops after
`silence_grace` seconds without sound from the output it listens to, and starts again when sound returns.

`opacity` (0 to 1, default 0.8) sets how much of the wallpaper shows through the whole visualizer; an alpha
in the bar colors, e.g. `'#33aacc80'`, blends the bars on top of that.

Placement is relative to each monitor (`anchor` bottom, top, left, right, center or fill; sizes in pixels
or percent; `margin`), or a `rect`. `monitors` picks where it runs and can give a monitor its own placement.
Each module has its own section of typed options (`bars`, `graph`, `radial`, `circle`, `wave`; see
`config.example.yaml`), and an unknown option is reported rather than ignored. Anything else goes in
`defines` (GLava `#define`s of the module) and `requests`. Backdrop
gives GLava its own config folder in the runtime dir, so `~/.config/glava` is not used or changed.

`backdrop stop --wallpaper` turns the wallpaper off and leaves the visualizer running over a black screen,
which shows what the visualizer alone looks like; `backdrop start --wallpaper` brings the wallpaper back.
`backdrop start --visualizer` and `stop --visualizer` do the same for the visualizer, whatever
`visualizer.enabled` says, until the daemon restarts. With the daemon stopped, `start --visualizer` starts
only the visualizer. When neither part is left on, the daemon stops. While the wallpaper is off, commands that
need it (`next`, `keep`, `menu` and the like) say so; `mode` still records the mode.

The daemon watches the config file: saving a change to the `visualizer` section restarts the visualizer
with it, without touching the wallpaper. A save with a mistake (invalid YAML, or a bad visualizer value)
keeps the running visualizer and shows a desktop notification naming the problem. Changes to other
sections still need a daemon restart. `backdrop visualizer reload` forces a reload and reports any mistake
at the prompt. `backdrop status` shows where each instance runs. An instance that
keeps exiting (for example from a bad `defines` value) is retried five times a minute, then given up on until
the next reload; the log has its last output.

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
