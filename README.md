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
- Per-video playback speed and per-item dimming, remembered for future plays
- Monitors attached, removed or resized while running are picked up automatically
- Automatic import of local wallpapers as approved items (`local-1.jpg`, `local-2.mp4`, ...)
- Screensaver after a period of inactivity, from rated videos or stream links such as YouTube
- A music visualizer (GLava) above the wallpaper on each monitor, placed and styled from the config, with
  several at once, presets, and an option to run only while music plays

## Requirements

- Node.js 22.13 or later (uses the built-in `node:sqlite`)
- X11 with `xwinwrap`, `mpv`, `xrandr` and `xdotool`; `ffprobe` for media dimensions; `yt-dlp` for stream links
- A Pexels API key for Pexels search
- For the visualizer: `glava` and a compositor such as picom

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
backdrop                    # same as backdrop status
backdrop status             # mode, what each monitor is playing, and mpv's recent CPU use and decoder
backdrop mode               # toggle between video and image wallpapers
backdrop next | prev        # on the monitor under the pointer (or --monitor DP-1); shows the new item
backdrop next --no-random   # next in the shuffled order (random is the default; prev still returns)
backdrop next --tag ocean   # jump to a matching item; the filter sticks for later nexts (also --query, --keywords)
backdrop next --video-duration 2m  # play videos about 2 minutes (also --image-duration), until --clear
backdrop next --clear       # drop the filters, order and durations earlier nexts left in effect
backdrop speed 0.8          # also +0.1, -0.1, reset; remembered for that video
backdrop dim 30             # darken the current image or video (0-100, +10, -10, reset); remembered
backdrop current
backdrop current --line     # one aligned line; tab-separated when piped
backdrop current --json     # JSON for scripts (also status, the lists and navigation commands)
backdrop import             # copy library.import_dirs into the library (also runs on every daemon start)
backdrop import ~/walls     # or specific folders
backdrop keep 3             # rate the current item on the monitor under the pointer
backdrop keep 3 --next      # rate it, then play the next item
backdrop skip               # move it to trash and advance all monitors playing it
backdrop undo               # undo the last rating and file move, across CLI invocations
backdrop undo --discard     # drop a rating that can no longer be restored, so undo reaches the one before
backdrop go-next            # advance after checking the current item has a rating
backdrop search-videos 'ocean waves'  # also search-images; requires the source API key
backdrop pending             # media saved by searches, with its queries and the size it would download
backdrop download --total 10 --type videos
backdrop download --query 'ocean waves' --tag sunset  # only media one of your searches found, with every tag
backdrop download --upgrade # refetch downloads smaller than your monitors at a larger size
backdrop list-videos --rated landscape
backdrop list-videos --tag ocean waves  # items tagged with every word
backdrop list-images --interactive  # browse and rate downloaded images
backdrop list-videos --playlist ~/walls.m3u
backdrop list-images --line | fzf --delimiter '\t' --with-nth 1..9  # one line per item
backdrop list-videos --header | fzf --header-lines=1 --delimiter '\t'  # with column names
backdrop menu               # rofi panel for the item under the pointer, with keys: n 1 2 3 v / p s u m d, q quits
backdrop menu --tag ocean   # sets the filter like next does (also --query, --no-random)
backdrop menu visualizer    # the visualizer menu (also z in the menu): module, opacity, colors, presets, save
backdrop stats              # library, ratings, resolutions, sources, searches, storage and quota; works offline
backdrop remove --current   # permanently delete the playing library item (original import is preserved)
backdrop remove 42          # or remove an item by its database id
backdrop purge --dry-run    # trash files older than library.trash_days (the daemon purges daily)
backdrop rescan             # probe videos without a frame rate; --all re-checks every file's kind, size and length
backdrop stop --wallpaper   # turn one part off (or on with start): --wallpaper, --visualizer
backdrop stop
```

Shell completion for zsh and bash (commands, options, monitor names from the running daemon, and fixed values
such as modes and types):

```bash
backdrop completion zsh > "${fpath[1]}/_backdrop"  # then restart zsh; or in ~/.zshrc after compinit:
source <(backdrop completion zsh)
backdrop completion bash > ~/.local/share/bash-completion/completions/backdrop  # or in ~/.bashrc:
source <(backdrop completion bash)
```

To run the daemon as a systemd user service instead of from i3, see
[GETTING_STARTED.md](GETTING_STARTED.md#start-automatically-with-i3) and `backdrop systemd`.

`--json` on `status`, `current`, the lists and the commands that switch what plays prints one JSON document
on stdout, with every other message on stderr; the fields are in [docs/specs/json.md](docs/specs/json.md).

Regenerate it after upgrading so new commands and options are included.

`remove --current` accepts `--monitor <name>`. Removal drops the file from all running monitor playlists,
deletes its library copy and database record, and preserves its import record so an unchanged original
is not imported again. It works by ID when the daemon is stopped, too.

Commands that switch what plays (`next`, `prev`, `skip`, `go-next`, `keep --next`, `mode`) print the item the
target monitor now plays and send a desktop notification through `notify-send` (duration and frame rate for
videos, rating, monitor, tags); `display.notify: all` has the daemon notify on every change, including automatic
advances, and `off` disables it. `keep` and `undo` print the rated item with its new rating. Undo skips items whose file was purged from
trash; when the latest rating cannot be restored for another reason (a file moved or deleted by hand), the
error suggests `undo --discard`, which drops it from undo history and leaves the item as it is. `--line` (also on
`current`, `list-images` and `list-videos`) prints one line per item instead: id, kind, resolution, running time,
frame rate, orientation, rating, source, speed/dim and path. On a terminal the columns are styled and aligned;
piped, they are tab-separated and plain, keeping colors only with `FORCE_COLOR` (for `fzf --ansi`).

`next`, `skip`, `go-next` and `keep --next` pick a random item by default (`display.order: random`);
`--no-random`, or `display.order: shuffle`, plays the next item of the shuffled playlist instead. The playlist
itself is reshuffled on every pass, and automatic advances follow it. Images change every
`display.image_duration` seconds; videos loop for about `display.video_duration` (10 minutes): short ones loop
as many whole times as fit, longer ones stop at the limit, and 0 loops each video forever.

The daemon samples each mpv's CPU use every 30 seconds. `status` shows each monitor's recent average and
decoder (`vaapi` or another hardware API, or `software`), `current` the playing item's average, and `stats` a
"Playback cost" section by kind, size and decoder with the most expensive items. CPU is a percentage of one
core, as in `top`. Videos above 1080p that mpv decodes in software are logged as a warning, since they can
take several cores.

If a monitor named in `display.monitors` is not connected, the daemon starts on the others (or on none)
and picks it up when it appears; downloads are sized for the connected ones.

Media is tagged with words from its file name (local imports), its source page and description. Tags show
under each item and filter lists with `--tag`; `--keywords` matches them too.

`--query`, `--tag` and `--keywords` work the same on `pending`, `download` (and `--upgrade`), the lists and
`next`. `--query` takes one or more saved search queries, each quoted, and matches them exactly apart from
case; an item any of them found qualifies. `--tag` and `--keywords` require every word. A query no search
used is an error that names the closest saved queries. `next` with filters moves one matching entry of the
current playlist up to play next (in playlist order, or any with `--random`) and then plays the playlist as
usual; it says so when only the other mode has matches. The filters, and `--random`/`--no-random`, given to
`next` or `menu` stay in effect for every later `next` and for the advance after `keep --next`, `skip` and
`go-next`, until `next --clear` or the daemon restarts; new filters replace the old ones as a set.
`backdrop status` shows them. The daemon's own advance through the playlist ignores them.
`--image-duration` and `--video-duration` on `next` or `menu` override `display.image_duration` and
`display.video_duration` the same way, and the daemon applies them at once to what is playing.

`keep`, `skip` and `go-next` accept `--monitor <name>`. Rating an imported item changes its current rating
and preserves undo history. Keep moves new downloads from the inbox into the library; this refreshes
affected playlists and restarts the moved file. Re-rating a file already in the library keeps it playing.

Search and download choose the smallest variant that fits all configured monitors, then probe and hash
downloads before adding them to playback. A download identical to one you already have is recorded as a
duplicate, never fetched again, and its search queries are added to the original. After attaching a larger monitor, `download --upgrade` replaces
kept or new downloads that are now too small, keeping their ratings, speed and dim. For use without X, pass `--resolution 1920x1080`. Lists are plain
text by default; `--rated [orientation]`, `--no-local`, `--query`, `--keywords`, `--tag`, `--source` and `--number` filter them.
See [the source contract and Pexels behavior](docs/specs/sources.md) for adapter details.

i3 example:

```
exec --no-startup-id backdrop daemon
bindsym $mod+w exec --no-startup-id backdrop mode
bindsym $mod+bracketright exec --no-startup-id backdrop next
bindsym $mod+bracketleft exec --no-startup-id backdrop prev
bindsym $mod+minus exec --no-startup-id backdrop speed -0.1
bindsym $mod+equal exec --no-startup-id backdrop speed +0.1
bindsym $mod+b exec --no-startup-id backdrop menu  # rofi: rate, navigate, speed, dim, mode; Tab picks the monitor
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
