# Configuration

File: `$XDG_CONFIG_HOME/backdrop/config.yaml` (default `~/.config/backdrop/config.yaml`). Created with the
settings below on first run. Values in the file are deep merged over the defaults: objects merge key by
key, arrays and scalars replace the default. A key that no setting uses is reported with the closest known
key, e.g. `Unknown config key "visualization"; closest: "visualizer"`: on stderr by every command, under
`Config` in `status` (`config_warnings` in `status --json`), in the daemon log at start, and as a desktop
notification when a save adds one while the daemon runs. The file still loads.

Values are checked when the file loads (`src/config/schema.js`): a value that does not check out stops every
command with each problem listed by key, e.g. `display.notify must be commands, all or off, not "loud"`.
Durations (`display.image_duration`, `display.video_duration`) take the times the CLI's `--image-duration` does
(`90`, `90s`, `5m`, `1h`) and become seconds.

The daemon applies a saved file without a restart (`Daemon.applyConfigChange`): it loads and checks the whole
file again, keeps every running setting on a mistake (with a notification), restarts the visualizer when its
section changed (only `opacity`, `palette.pick` or `palette.min_contrast` apply to the running instances without
one), and applies the rest by kind: `display.order`, `notify`, `library.trash_days` and
`default_import_rating` are read where used; `image_duration` and `video_duration` also change what plays now;
`allow_upscale` and `library.min_width`/`min_height` reload each monitor's playlist; `display.monitors`
reconciles the monitors; `library.import_dirs` and `watch_imports` import the folders and watch them again. `display.mpv_args`, `xwinwrap_args` and
`paths` need a restart, which a notification names. The `load` section applies at once. `sources`, `menu` and `output` are read by the CLI on each
run. The visualizer section is the exception: a problem there is a
warning, and the daemon runs the wallpaper without the visualizer. The `visualizer` section checks
its own keys and rejects unknown ones.

```yaml
sources:
  pexels:
    api_key: ""            # falls back to $PEXELS_API; never written back to the file
    per_page: 80           # 15-80
    image_min_size: large  # large (24MP), medium (12MP), small (4MP)

library:
  import_dirs: []          # folders scanned by import; files there are already approved
  watch_imports: true      # the daemon imports files as they appear in import_dirs (inotify: changes
                           #   made on this machine; a network share's other writers wait for the next start)
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
  order: random            # how next with filters picks a match: random (any still ahead this pass) or shuffle
                           #   (the next in playlist order); --random / --no-random override it per command.
                           #   Without filters next always plays the next entry of the shuffled playlist
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
  engine: glava            # glava or sleeve (docs/specs/sleeve.md); also per instance
  projectm: {}             # for engine: projectm: fps, preset_duration, preset_path, args, command
  sleeve: {}               # for engine: sleeve: now, now_position, lyrics_align, lyrics_area, now_area, background (a color, cover, or auto: a veil from the wallpaper), map_below, no_sandbox, command
  monitors: all            # all, [names], or {name: true | false | {placement, rect}}
  module: bars             # bars, graph, radial, circle, wave
  audio: pulseaudio        # pulseaudio or fifo
  source: auto             # GLava setsource: a sink or device, or the fifo path
  opacity: 0.8             # window opacity (_NET_WM_WINDOW_OPACITY), 0 to 1
  only_while_playing: false # stop the instances while the audio source is silent (audio: pulseaudio only)
  silence_grace: 10        # seconds of silence before they stop
  reference_height: 1440   # monitor height GLava's pixel sizes are meant for; they follow the window's height. null: exact pixels
  wallpaper_dim: 0         # dim the wallpaper at least this far (0-100) while the visualizer has sound; 0 is off
  preset: null             # active preset at start; `backdrop visualizer preset` switches until the daemon restarts
  wallpaper: true          # false: stop mpv while this look is active, for a preset that hides it
  presets: {}              # name: settings laid over the section (objects merge, lists replace); built-in: subtle,
                           #   ring, wave, party, lyrics, lyrics-only, lyrics-side, lyrics-veil, lyrics-blend, lyrics-stage, lyrics-now
                           #   (src/visualizer/presets.js); cannot set enabled, preset or presets
  instances: null          # [{name, engine, sleeve, module, monitors, placement, rect, opacity, <module>, defines, requests}];
                           #   the section's own instance settings are their defaults; list order = stacking order;
                           #   without it the section is one instance named main
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

load:                      # see "System load" in docs/specs/main.md
  enabled: false
  window: 1                # the load average to read: 1, 5 or 15 minutes
  image_above: 12          # videos become images over this; null skips the step
  off_above: 24            # wallpaper and visualizer stop over this; must be above image_above; null skips it
  resume_ratio: 0.75       # recover under threshold x this
  sustain: 60              # time over a threshold before acting
  resume_after: 300        # time under it before each step back

screensaver:
  idle: false              # start by itself after idle_minutes without input (needs xprintidle); `backdrop screensaver` needs none of this
  idle_minutes: 10
  max_load: null           # with idle, only under this load average (load.window); null for no limit
  preset: screensaver      # visualizer preset while on; screensaver-projectm adds projectM, null keeps the running one
  workspace: backdrop      # the empty i3 workspace to show; other outputs get backdrop-<output>
  on_enter: ['polybar-msg cmd hide']  # shell commands run on entering and leaving
  on_leave: ['polybar-msg cmd show']
  sources: [rated_videos]  # planned: what screensaver playlists draw from; nothing reads this yet
  streams: []              # planned: URLs played through mpv/yt-dlp; nothing reads this yet

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

backdrop writes the config file in two places only: the first run creates it from the user defaults, and
`ConfigManager.setInFile()` (the menu's saved visualizer presets) changes one key in place through `spliceYaml`,
keeping every comment and the file's layout. `set()` changes the loaded config in memory only. Environment
credentials and derived paths never end up on disk. (A `save()` that rewrote the whole file with
`YAML.stringify` was removed in 2.33.0: nothing called it, and it would have dropped every comment.)
