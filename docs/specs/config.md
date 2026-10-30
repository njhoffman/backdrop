# Configuration

File: `$XDG_CONFIG_HOME/backdrop/config.yaml` (default `~/.config/backdrop/config.yaml`). Created with the
settings below on first run. Values in the file are deep merged over the defaults: objects merge key by
key, arrays and scalars replace the default.

```yaml
sources:
  pexels:
    api_key: ""            # falls back to $PEXELS_API; never written back to the file
    per_page: 80           # 15-80
    image_min_size: large  # large (24MP), medium (12MP), small (4MP)

library:
  import_dirs: []          # folders scanned by import; files there are already approved
  default_import_rating: 2 # rating (1-3) given to imported files
  min_width: 1024          # nothing smaller is imported; long side vs the larger value,
  min_height: 768          #   short side vs the smaller, so portrait media qualifies too
  trash_days: 30           # skipped files are purged from trash after this many days; 0 disables

display:
  monitors: auto           # auto (xrandr) or a list of output names
  image_duration: 300      # seconds per image in a slideshow
  video_duration: 600      # seconds of wall time per video before the next; 0 loops each video forever.
                           #   Shorter videos loop whole times that fit, longer ones stop at the limit
  allow_upscale: false     # true allows media smaller than the monitor
  order: random            # random (next/skip/keep --next pick at random) or shuffle (the shuffled order);
                           #   --random / --no-random override it per command; automatic advances always shuffle
  notify: commands         # notify-send on media changes: commands (navigation commands), all (every load
                           #   by the daemon, including automatic advances) or off
  xwinwrap_args: [-b, -s, -st, -sp, -nf, -ov, -fdt, -ni]  # -g <geometry> is added per monitor
  mpv_args: []             # extra mpv options; mpv runs with --no-config, so mpv.conf is not read

menu:
  style: panel             # panel (share/rofi/backdrop-panel.rasi: preview banner, details, button grid) or minimal
  rofi_args: []            # appended to `rofi -dmenu` for `backdrop menu`, e.g. [-theme-str, 'window { width: 900px; }']
  workspace: true          # i3: an empty workspace (true: "backdrop", or a name) while the menu is open; false to stay

visualizer:                # see docs/specs/visualizer.md; checked at daemon start and on `backdrop visualizer reload`
  enabled: false
  engine: glava            # the only adapter so far
  monitors: all            # all, [names], or {name: true | false | {placement, rect}}
  module: bars             # bars, graph, radial, circle, wave
  audio: pulseaudio        # pulseaudio or fifo
  source: auto             # GLava setsource: a sink or device, or the fifo path
  opacity: 0.8             # window opacity (_NET_WM_WINDOW_OPACITY), 0 to 1
  placement: {anchor: bottom, width: 100%, height: 25%, margin: 0}  # sizes in pixels or % of the monitor
  rect: null               # {x, y, width, height} relative to the monitor; overrides placement
  bars: {width: 20, gap: 1, outline: 0, amplify: 200, colors: ['#000000', '#33aacc'], gradient: 80, direction: inward, flip: false}
  graph: {}                # typed options of the other modules, written only when set (MODULE_OPTIONS in
  radial: {}               #   src/visualizer/settings.js); every module section is checked, unknown options
  circle: {}               #   rejected, but only the active module's is applied
  wave: {}
  defines: {}              # raw #defines written into the module's .glsl, applied over the typed options
  requests: []             # raw GLava requests (-r), applied after backdrop's
  glava: {shader_dir: /etc/xdg/glava, args: []}

screensaver:
  idle_minutes: 10
  sources: [rated_videos]  # what the screensaver draws from
  streams: []              # URLs played through mpv/yt-dlp, e.g. YouTube links

output:
  symbols: auto            # auto, nerd, unicode or ascii; auto is unicode on a UTF-8 terminal, else ascii
  progress_gradient: ['#00c8ff', '#a050ff']  # two or more #rrggbb stops for progress bars
```

Colors, symbols, media icons and `~` for the home directory appear only when output goes to a terminal;
piped output stays plain with full paths. `NO_COLOR` turns colors off and `FORCE_COLOR` turns them on for
pipes. Nerd Font glyphs cannot be detected, so `nerd` must be chosen explicitly, in the config or with the
`BACKDROP_SYMBOLS` environment variable, which overrides `output.symbols` (e.g. only in a Nerd Font terminal).

Other sources go under `sources.<name>` with their own credentials; unknown keys are preserved.

## Paths

`paths` is not written to a new file; each entry defaults to an XDG location and can be overridden
individually:

| Key | Default |
| --- | --- |
| `database` | `$XDG_DATA_HOME/backdrop/backdrop.db` |
| `logfile` | `$XDG_DATA_HOME/backdrop/backdrop.log` |
| `media` | `$XDG_DATA_HOME/backdrop/media` |
| `trash` | `$XDG_DATA_HOME/backdrop/trash` |
| `inbox` | `$XDG_CACHE_HOME/backdrop/inbox` |
| `runtime` | `$XDG_RUNTIME_DIR/backdrop`, or `$TMPDIR/backdrop-<uid>` without it |

Paths and `library.import_dirs` expand a leading `~`, `$VAR` and `${VAR}`; unknown variables are left as-is.

## Saving

`ConfigManager.save()` writes only what came from the file plus values changed with `set()`, so
environment credentials and derived paths never end up on disk.
