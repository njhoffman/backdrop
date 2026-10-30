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

## Opacity

`visualizer.opacity` (0 to 1, default 0.8) is the whole window's opacity, which compositors such as picom
apply. The alpha of the bar colors (`'#33aacc80'`) blends the bars themselves on top of that.

## Lifecycle

`VisualizerManager` owns one process per monitor (detached, killed as a process group like xwinwrap). An
instance that exits is restarted after a second, at most five times a minute, then given up on until the next
reload; its last 20 lines of output go to the log, since GLava exits with code 1 and no message on a shader
error. A bad visualizer section leaves the visualizer off and the wallpaper running.

`backdrop start/stop --wallpaper/--visualizer` switch either part on a running daemon: the CLI writes
`control.json` (`{ pid, wallpaper, visualizer }`) and sends SIGUSR1, and waits for `state.json`'s `control`
counter to move. Turning the wallpaper on restarts every visualizer instance, by the stacking rule above. With
neither part on, the daemon stops. The switches last until the daemon exits.

The daemon watches the config file's directory (editors often save by renaming a new file over the old
one) and, 300ms after the last change to the file, re-reads the visualizer section. If it differs from the
running one, the visualizer restarts with it; a file that no longer parses or a value that does not check
out keeps the running visualizer and its settings and sends a critical desktop notification. Other
sections are not applied live yet (see TODO.md).

`backdrop visualizer reload` checks the section, sends the daemon SIGHUP and waits for the reload to show in
`state.json` (`visualizer.generation`). The daemon re-reads only the visualizer section and restarts only the
visualizer. Daemons before 2.20.0 have no SIGHUP handler and would exit, so the CLI refuses to signal a daemon
whose state has no `version`.
