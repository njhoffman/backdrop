# Music visualizer

Backdrop runs a music visualizer above the wallpaper on each monitor it names, below every window, with clicks
passing through. Decided 2026-10-30.

## Engine

GLava is the engine, behind an adapter (`src/visualizer/index.js`), because it is the only candidate that does
all of this on X11 by itself:

- per-pixel transparency over a moving wallpaper (`setopacity "native"`, which needs a compositor);
- an unmanaged window that stacks itself low (`setxwintype "!-"`), so it sits between the wallpaper and windows;
- click-through (`setclickthrough true`) and an exact geometry (`setgeometry`).

`setopacity "xroot"` is ruled out: it copies the root window's pixmap, and backdrop never sets one, so the
visualizer would hide the wallpaper instead of showing it.

Alternatives considered: Cavalier and cava (more styles, but a GTK app and a terminal program: no desktop layer
or click-through without wrapping), XAVA (a cava fork whose desktop-layer mode is documented for Wayland), and
mpv's own lavfi visualizers in an `xwinwrap -argb` window (reuses the daemon's machinery, few styles, alpha only
through a colorkey). The last is the fallback if GLava stops working.

GLava is frozen: its last release is 1.6.3 (2019) and its last commit 2021-06. The forks found on 2026-10-30
(glava-ridged, a few personal GitHub forks) are single-maintainer or abandoned. Hence the adapter: the rest of
backdrop knows only `prepare()` and `command(monitor, geometry)`.

## Configuration

GLava reads `$XDG_CONFIG_HOME/glava`. Each instance runs with `XDG_CONFIG_HOME` set to `<runtime>/visualizer`,
which `prepare()` fills with links to every file of the installed shaders (`visualizer.glava.shader_dir`, as
`glava -C` does), except the module's settings file (`bars.glsl`), which is a copy with backdrop's `#define`
values. `~/.config/glava` is neither read nor changed. `PULSE_COOKIE` points back at the user's own cookie,
since PulseAudio keeps it under `XDG_CONFIG_HOME`.

Per-instance settings are requests on the command line (`-r`): geometry, a title of
`backdrop-visualizer-<monitor>`, the audio source, and the transparency and stacking requests above. User
`requests` follow backdrop's, so they win.

Typed options exist only for the bars module; `defines` covers the rest, applied over the typed values.
`settings.js` checks the section and names the key of any bad value.

## Stacking

xwinwrap and GLava are both unmanaged and lower themselves to the bottom of the stack when they map, so the
one mapped last ends up lowest. GLava, started after the wallpaper, lands under it: with picom drawing the
wallpaper at 95% opacity, the bars showed only as a faint ghost (2.20.0 and 2.21.0, which relied on start
order after misreading `xwininfo -children`: it lists the root's children top to bottom).

Since 2.22.0 backdrop places each instance itself (`VisualizerManager.place`), over its own X connection
(`src/display/x11.js`, the `x11` npm package):

- find the instance's window by its title (`xdotool search --name`);
- set `_NET_WM_WINDOW_OPACITY` from `visualizer.opacity`;
- find the wallpaper's top-level window: mpv's `window-id`, up through `QueryTree` to the child of the root
  (xwinwrap's window);
- `ConfigureWindow` with that window as sibling and stack mode Above: the instance sits directly above its
  wallpaper and below everything else; then check again after 500ms, since GLava lowers itself once its
  window maps, which can come after the window is found.

Placement runs after every instance start and after every wallpaper start. Without a running wallpaper the
instance stays at the bottom, over the bare root window. Rejected: `xdotool windowlower` (missing from
xdotool 3.20160805), raising GLava (it would cover every window), python-xlib (a Python dependency).

Wallpaper changes (next, playlist advances, mode switches, speed and dim) reuse the running mpv, so they never
touch the visualizer.

sleeve's lyrics are a second engine, chosen per instance with `engine: sleeve` (the section's `engine` is the default): what it promises is in
[sleeve.md](sleeve.md). Such an instance starts `sleeve shell --managed`, takes its options from `visualizer.sleeve` (`now`, `now_position`,
`lyrics_align`, `lyrics_area`, `now_area`, `background`, `map_below`, `no_sandbox`, `command`; only those set are passed, and `--map-below` is on by itself for a window filling its monitor), and ignores GLava's settings. A change to the look (all but the last three) goes over `sleeve ctl
display` with no restart, unless an option set at its start was removed, which only a restart can clear. On each start it resets what sleeved remembers of the
page, and for silence it hides and shows rather than stopping. Status 2 means no use retrying, so the instance is given up on at once. With `palette.source:
wallpaper` it gets one `{ background, main }` JSON line per change, as an overlay's colors in `state.json`. With the wallpaper off, a monitor with a sleeve instance is
stacked from the bottom, since sleeve does not lower itself as GLava does. The built-in presets with lyrics are `lyrics` (above bars), `lyrics-only`, `lyrics-side` (left third, bars beside them), `lyrics-veil` (the wallpaper under a see-through layer tinted from it, a ring beside the lyrics with bars below it), `lyrics-blend` (the cover blended over the wallpaper), and `lyrics-stage` and `lyrics-now` (an opaque cover as the whole background). The last two set `wallpaper: false`, which any preset or the section can: mpv stops while that look is active and starts again when it ends or when an instance cannot run, and turning the wallpaper on or off by hand still counts for when it does. At the load section's `image` level a sleeve `cover` background gives way to a dark color, back when the load falls; in silence (`only_while_playing`) it stays, since on an opaque window it is the wallpaper. `background: auto` works out a see-through veil from what the window covers, on each load and when the dim changes (`veilBackground` in `palette.js`, sent with `sleeve ctl display`): the color is the picture's hue at very low lightness, each pixel's hue counted by how colorful it is, and navy when the result leans too little toward any hue; the strength aims at a mean luma of 0.3 as shown, from 45% to 75%. Until a sample is known it is `#0a0f1a99`, and a video takes it from the frame sampled at load. The areas and background let it be the wallpaper layer, alone or between mpv and GLava; see [sleeve.md](sleeve.md), which has examples.

### Overlays

Other programs can have backdrop stack their windows too (since 2.41.0); sleeve's lyrics overlay is the first.
The contract:

- The program marks its window with a `_BACKDROP_OVERLAY` property of type STRING: `below` (directly above the
  wallpaper, under the visualizer instances) or `above` (over the instances; also any other value). The mark may
  sit on the top-level window or on its direct child, where a window manager's frame holds it; the top-level is
  what gets stacked.
- It runs `backdrop restack` when the window maps, when it changes the mark, and when backdrop's daemon pid
  (in `state.json`) changes. The request looks at every monitor; a monitor that had overlays at its last look,
  or that has instances, is looked at again on every later placement too, so a wallpaper restart keeps them
  in order. A daemon with neither never opens an X connection for them.
- An overlay belongs to the monitor holding its center. Bottom to top: the wallpaper, `below` overlays, the
  instances in the section's order, `above` overlays; overlays keep their own order within each group.
- backdrop sets no opacity on overlays; the program owns its window's look.
- `state.json` and `status --json` list each monitor's overlays as `{ window, name, position, geometry,
  colors }`. `colors` is `{ background, main }`: the average the wallpaper shows under the window after the
  current dim, and the wallpaper's main colors there with their shares, as `#rrggbb`; null until the item is
  sampled. The state is written again when an item loads, when the brightness changes and when the overlays
  change, so the program can watch the file and pick readable colors.

Without backdrop running, the program stacks its own window. A plain, focusable window is the window
manager's and backdrop never touches it.

## Instances and presets

The section describes a list of instances (`instances`), each a full visualizer (module, placement, opacity,
module options); keys at the top of the section are defaults the instances inherit, merged as objects. A
section without `instances` is one instance named `main`, so single-visualizer configs need no list. Each
instance gets its own GLava config root (`<runtime>/visualizer/<name>`) and window title
(`backdrop-visualizer-<monitor>-<name>`). Placement stacks a monitor's instances in list order: the first
directly above the wallpaper, each next one above the one before.

A preset is a mapping laid over the section, objects merged and lists replaced, so it can change anything
except `enabled`, `preset` and `presets`, including the instance list. Built-in presets live in
`src/visualizer/presets.js`; the section's `presets` override them by name. `visualizer.preset` picks the one
used at start; `backdrop visualizer preset <name>` switches the running daemon through a `{ preset }` control
request until it restarts, and the switch survives config reloads. Every preset is checked when the section is,
so a mistake in one shows before it is used.

Colors set in the config are piped to GLava like the wallpaper's, so changing a swatch needs no restart; a module with no colors set keeps its shader's own, and a raw `#define` for them stays in the shader.

To build a preset live, add one to `visualizer.presets`, pick it (`backdrop visualizer preset scratch`, or `p` in the menu), and edit it: each save applies at once, a mistake
keeps the running look and raises a notification naming the key. Opacity and sleeve's look change in place, and anything else restarts the instances that use it. A save that changes the look in use drops the menu's
changes, so the file wins; other saves leave them, including a preset saved from the menu under a new name. A preset can name any instances, and its place in the list is its stacking order.

## Audio-only display

With `only_while_playing`, `AudioWatcher` (`src/visualizer/audio.js`) runs `pactl subscribe` and, on sink,
source or server events, reads the state of the output the visualizer listens to (`pactl get-default-sink` for
`auto`, else the named sink or source). RUNNING starts the instances at once; anything else stops them after
`silence_grace` seconds, so pauses between tracks do not. A silenced visualizer still counts as on, so the
daemon does not stop for it when the wallpaper is off. When the state cannot be read, sound is assumed. Only
`audio: pulseaudio` can be watched.

`wallpaper_dim` (0-100, default 0: off) dims the wallpaper while the visualizer is on and the same watcher reports
sound, so the bars stand out without changing their colors. It is a floor: each monitor shows the stronger of its
item's own dim and `wallpaper_dim` (`Daemon.shownDim`), and goes back to the item's dim, read again from the
database, `silence_grace` seconds after the sound stops or when the visualizer turns off. The manager reports the
change (`musicDim`, also in `state.json`'s visualizer summary) and the daemon sets each mpv's brightness;
`backdrop dim` stores the item's dim and shows the stronger of the two the same way. A dim is set as mpv's `contrast`, which scales every channel like a black veil over the picture (`--contrast=-25` shows `64,128,200` as `48,96,150`; `--brightness=-25` would show `0,64,136`), checked with mpv 0.40 on software GL. It needs no
`only_while_playing`: the watcher runs for either, and only `only_while_playing` stops the instances. The daemon
observes mpv's `brightness`, so colors from the wallpaper are checked for contrast against what shows after any
change to it.

## Colors from the wallpaper

With `palette.source: wallpaper`, a visualizer takes its foreground colors from the wallpaper under it and
changes them on every load, without a restart:

```yaml
visualizer:
  palette:
    source: wallpaper   # or config: the module's colors as set (the default)
    pick: vivid         # vivid (most colorful main color), dominant (largest) or complement (vivid, hue turned 180)
    min_contrast: 3     # contrast ratio (1-21) against the strip under the visualizer
```

`palette` is an instance setting, so instances and presets can set their own. On each load the daemon decodes
one small sample of what the monitor shows (`sampleMedia` in `src/visualizer/palette.js`: the region mpv's
`--panscan=1.0` leaves visible, 96 pixels wide, at the lowest CPU priority; videos a second in). For each
instance it takes the strip under the window, finds its main colors by k-means, picks by the rule and makes
each pick lighter or darker, keeping its hue, until it has `min_contrast` against the strip's average as shown
(after the item's dim), so the bars never vanish into the image they cover. A dark way out that ends near black
loses to a lighter one. A gradient (`bars.colors` with two colors, and graph and radial) takes the first two
picks; one color takes the first. The configured colors' alpha is kept.

The colors reach GLava over stdin: each instance runs with `--pipe=fg:vec4` (and `fg2` for a gradient), the
module's color `#define` reads `@fg:` (`mix(@fg:A , @fg2:B , ...)`; GLava reads a default up to whitespace, hence
the spaces), and `VisualizerManager` writes `fg = #rrggbbaa` lines. Two GLava behaviors shape this, checked with
GLava 1.6.3: a piped value that never arrives stays unset, so the manager writes the colors as soon as an instance
starts (the wallpaper's when sampled, else the configured ones), and it takes one line per read, dropping the rest
of what arrived together, so lines go out 100 ms apart. Lines written before GLava begins reading pile up all the same, leaving a gradient's far color
unset and the bars fading to nothing, so the manager writes the colors again once the window is up. A raw `defines` entry for the piped
color is rejected. `status` shows each instance's current colors.

## Menu

`backdrop menu visualizer`, or `z` in the main menu, changes one instance live (`MenuCommand.visualizerMenu`):
on/off and preset through the existing control requests, and module, opacity, amplify, position (anchor) and
colors (palette source and pick, or a fixed swatch for the module's color option) as `{ visualizer_set: {
instance, changes } }`. The manager keeps these changes by instance (`live`, in `state.json`'s visualizer
summary) and lays them over the section after the active preset (`applyLive` in `settings.js`) until the daemon
restarts; the menu checks each change against the section first, and the manager refuses one that does not
check out, leaving the visualizer as it was. GLava reads its settings when it starts, so a change restarts the
instance (about a second blank), except opacity, which is set on the running window, and the wallpaper color pick
(`palette.pick`, `min_contrast`), which picks again and sends the colors over the pipe (`startSettings` in
`VisualizerManager.js` holds what needs a restart). `reset` sends `visualizer_reset`. `save` asks for a name and writes
the active preset with the changes (`lookAsPreset`) to `visualizer.presets.<name>` by splicing only that entry's
lines into the file (`spliceYaml` in `ConfigManager.js`), so the file's comments and layout stay; it then sends
`{ reload_config, visualizer_reset, preset }` so the daemon switches to the saved preset in one reload. An
existing name, the built-in ones included, is replaced only after a confirmation.

## Opacity

`visualizer.opacity` (0 to 1, default 0.8) is the whole window's opacity, which compositors such as picom
apply. The alpha of the bar colors (`'#33aacc80'`) blends the bars themselves on top of that.

## Checks

`backdrop visualizer check` (`src/visualizer/check.js`) starts every instance of the section and of each preset,
built-in ones included, as a 1x1 window at the top left for two seconds, all at once, each target checked
against a section holding only its own preset so one bad preset fails alone. Instances still running then are
stopped; ones that exited are reported with their exit code and last output lines (a bad define shows as GLava's
shader compilation error). It exits 1 on any failure; `visualizer reload --check` runs it first and does not
reload on a failure. With `audio: fifo` and no writer, GLava waits to open the fifo, which counts as running.

Without a compositor the transparency around the bars shows black. `VisualizerManager.place()` asks whether
anything owns the `_NET_WM_CM_S<screen>` selection on every placement (a compositor often starts after the
daemon under i3), logs when that changes, and keeps the answer as `compositor` in `state.json`'s visualizer
summary; `status` shows a line when it is false, `status --json` has `daemon.compositor`, and the check reports it.

## Lifecycle

`VisualizerManager` owns one process per monitor (detached, killed as a process group like xwinwrap). An
instance that exits is restarted after a second, at most five times a minute, then given up on until the next
reload; its last 20 lines of output go to the log, since GLava exits with code 1 and no message on a shader
error. A bad visualizer section leaves the visualizer off and the wallpaper running.

`backdrop start/stop --wallpaper/--visualizer` switch either part on a running daemon: the CLI writes
a request file `control-<id>.json` (`{ pid, wallpaper, visualizer }`, ids sorting by time) and sends SIGUSR1, and
waits for its id in `state.json`'s `handled` list; the daemon applies every pending request in name order on each
signal, so requests sent at once are all applied. CLIs and daemons before 2.38.2 use a single `control.json` and
the `control` counter instead, which both sides still understand. Turning the wallpaper on restarts every visualizer instance, by the stacking rule above. With
neither part on, the daemon stops. The switches last until the daemon exits.

The daemon watches the config file's directory (editors often save by renaming a new file over the old
one) and, 300ms after the last change to the file, re-reads the visualizer section. If it differs from the
running one, the visualizer restarts with it (or takes it live, as for a menu change, when only opacity or the
color pick changed); a file that no longer parses or a value that does not check
out keeps the running visualizer and its settings and sends a critical desktop notification. Other
sections are not applied live yet (see TODO.md).

`backdrop visualizer reload` checks the section, sends the daemon SIGHUP and waits for the reload to show in
`state.json` (`visualizer.generation`). The daemon re-reads only the visualizer section and restarts only the
visualizer. Daemons before 2.20.0 have no SIGHUP handler and would exit, so the CLI refuses to signal a daemon
whose state has no `version`.
