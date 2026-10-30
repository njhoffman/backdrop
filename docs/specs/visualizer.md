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

xwinwrap and GLava are both unmanaged and stack themselves low when they map. A GLava window that maps after
the wallpaper's lands directly above it (measured on 2026-10-30: xwinwrap at position 65 of the root's
children, GLava at 66). Backdrop relies on that order instead of restacking windows:

- instances start after their monitor's wallpaper, at daemon start and after monitor changes;
- when the daemon restarts a crashed or unresponsive wallpaper, it restarts that monitor's instance too
  (`VisualizerManager.restart`), so the instance maps last again.

Restacking with `xdotool windowlower` was rejected because xdotool 3.20160805 (still shipped by some
distributions) has no such command. Raising GLava instead would put it above every window.

Wallpaper changes (next, playlist advances, mode switches, speed and dim) reuse the running mpv, so they never
restart the visualizer.

## Lifecycle

`VisualizerManager` owns one process per monitor (detached, killed as a process group like xwinwrap). An
instance that exits is restarted after a second, at most five times a minute, then given up on until the next
reload; its last 20 lines of output go to the log, since GLava exits with code 1 and no message on a shader
error. A bad visualizer section leaves the visualizer off and the wallpaper running.

`backdrop start/stop --wallpaper/--visualizer` switch either part on a running daemon: the CLI writes
`control.json` (`{ pid, wallpaper, visualizer }`) and sends SIGUSR1, and waits for `state.json`'s `control`
counter to move. Turning the wallpaper on restarts every visualizer instance, by the stacking rule above. With
neither part on, the daemon stops. The switches last until the daemon exits.

`backdrop visualizer reload` checks the section, sends the daemon SIGHUP and waits for the reload to show in
`state.json` (`visualizer.generation`). The daemon re-reads only the visualizer section and restarts only the
visualizer. Daemons before 2.20.0 have no SIGHUP handler and would exit, so the CLI refuses to signal a daemon
whose state has no `version`.
