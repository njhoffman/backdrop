# sleeve as a visualizer engine

What sleeve (`~/git/sleeve`, synced lyrics) promises so backdrop can run it as a visualizer, the way it runs GLava.
Agreed 2026-11-04. Requires sleeve 0.33.0 or later (`sleeve --version`), and 0.36.0 for the wallpaper layer below (0.39.2 for a window exactly the monitor's size). Changing what is below is a breaking change for
the other side: add freely, but change or remove only with a version note in both CHANGELOGs.

This is separate from the overlay contract in `visualizer.md`, where sleeve starts its own window and backdrop only
stacks it. Use one or the other: an instance with this engine, or sleeve's own overlay (`sleeve-shell.service`), not both.

## Starting

```sh
sleeve shell --managed --geometry 2560x800+0+320 --title backdrop-visualizer-DP-3-lyrics --instance DP-3-lyrics \
  [--now lyrics|minimal|full] [--now-position PLACE] [--lyrics-align left|center|right]
```

| Option | Meaning |
| --- | --- |
| `--managed` | a program starts, places and stops this window; sleeve stacks nothing, marks nothing and never runs `backdrop restack` |
| `--geometry` | required; the X form `WxH+X+Y`, absolute |
| `--title` | the window's title, exactly and for good, to find it by (`xdotool search --name`) |
| `--instance` | the name `sleeve ctl display --instance` knows this window by; use the backdrop instance's name with its monitor, unique across monitors |
| `--now` | what shows besides the lyrics: `lyrics` (default here: nothing else), `minimal` (a line with artist and title), `full` (cover, title, artist, album, seek bar, times) |
| `--now-position` | where that panel stands: `top-left` (default), `top-center`, `top-right`, `center-left`, `center-right`, `bottom-left`, `bottom-center`, `bottom-right`; the lyrics keep clear of it |
| `--lyrics-align` | the lyrics' alignment; `left` by default |
| `--lyrics-area`, `--now-area` | since 0.34.0: where each goes inside the window; see The wallpaper layer |
| `--background` | since 0.35.0: what fills the window; see The wallpaper layer |
| `--map-below` | since 0.36.0: map the window at the bottom of the stack; see The wallpaper layer |
| `--no-sandbox` | passed to Electron; see Requirements |

Options left out fall back to the user's `~/.config/sleeve/style.css`, then the defaults above. An option given here
wins over that file, so leave out what the user should set there.

Exit status: 0 stopped by a signal; 2 a bad option, the shell not installed, or Electron's sandbox blocked, each with a
line on stderr saying what to do, and no use retrying; 1 anything else.

## The window

- Override-redirect, so i3 never manages it: no tiling, no frame, on every workspace. It stays wherever it is stacked and
  does not lower itself: place it once it is found (`ConfigureWindow`, as for GLava). It does not re-stack after mapping.
- Transparent around the text, so a compositor is needed; otherwise the transparency shows black. Clicks pass through.
- `_NET_WM_WINDOW_OPACITY` works on it as on GLava.
- It has no `_BACKDROP_OVERLAY` property, so `backdrop restack` and `state.json`'s `overlays` do not see it.

## Lifetime

- Measured 2026-11-04 on Iris Xe: the window exists about 2 s after the start, about twice GLava's time, and its page
  fills in within a moment of that. Allow for it in `windowAttempts`.
- SIGTERM stops it cleanly: 159 ms measured, status 0, no children left. `sleeve shell` is one process with Electron under
  it, so kill the process group as for GLava.
- Because a start is slow, do not stop it for silence: hide it (below). `only_while_playing` should use `--hide` and `--show`.
- Since 0.35.0 a hidden window keeps its background, which goes on moving and costing: on an opaque window that background is the
  wallpaper. A `transparent` window draws nothing while hidden, as before, and nearly stops costing anything. If an instance with a
  `cover` background should really go quiet in silence, change its background as well, or stop it.

## Colors

Unlike GLava, it takes the wallpaper's colors whole and picks its own text colors from them. Write to its stdin, whenever
they change, one JSON object a line, with the same shape as an overlay's `colors` in `state.json`:

```json
{"background":"#102030","main":[{"color":"#aabbcc","share":0.6}]}
```

A value sent before the page is ready is kept and passed on. A bad line is logged and skipped. No stdin at all is fine:
the text keeps its default colors and shadow. It does not read GLava's `fg = #rrggbbaa` lines.

## Changing a running instance

```sh
sleeve ctl display --instance DP-3-lyrics --preset full --position bottom-left --align center
sleeve ctl display --instance DP-3-lyrics --lyrics-area 33%x100%+0+0 --now-area 67%x100%+33%+0 --background '#10203099'
sleeve ctl display --instance DP-3-lyrics --hide      # or --show; hides the lyrics and the panel, the background stays
sleeve ctl display --instance DP-3-lyrics --reset     # back to its start options and style.css
```

Without `--instance` it applies to every sleeve page; an instance's change wins over that for the instance, and `--reset`
without `--instance` forgets them all. It takes effect on the next frame, with no restart. Exit status: 0 done, 1 refused
(a value it does not know, named on stderr), 2 sleeved not running.

The same goes over sleeved's socket as `{"type":"display","instance":"DP-3-lyrics","preset":"full"}`
(`docs/protocol.md` in sleeve). Changes last until sleeved restarts, which forgets them: backdrop should send what it
wants again when it starts, and treat the start options as what survives.

To notice sleeved restarting on its own, stay connected to its Unix socket (`$XDG_RUNTIME_DIR/sleeve/sleeved.sock`, one JSON message a
line, both ways). Every connection starts with a `hello` message, so a connection that closes and comes back with a new `hello` means a
sleeved that has forgotten its changes: send them again then. A client that sent changes itself also sees each `display` message.

## sleeved

The lyrics come from the daemon `sleeved`, a user service of its own, which backdrop neither starts nor stops. The window
works without it and picks up when it appears, showing nothing until then on the overlay. `sleeve ctl` exits 2 until it runs.

## Requirements

- sleeve's shell installed (`just shell-install` in its checkout), and `sleeve` on `PATH` (a link to
  `src/cli/index.ts`) or a configured path.
- On Ubuntu, AppArmor blocks Electron's sandbox until `just shell-sandbox` has run once (sudo). Without it the start exits
  2 with that advice, unless `--no-sandbox` is given.

## `backdrop visualizer check`

A 1x1 window for two seconds is fine, with `--managed --geometry 1x1+0+0`. Since a start takes about 2 s, the check sees a
running process rather than a page, which is what it asks of GLava too. A status of 2 is the useful failure.

## The wallpaper layer

Built in sleeve 0.34.0 to 0.36.0, agreed 2026-11-04. The user wants to choose between these, sometimes on the same day, so none replaces
the others:

1. **In its own window over the wallpaper.** A window about the size of the lyrics, over mpv's wallpaper.
2. **As the backdrop itself.** The window takes the whole monitor and the lyrics only part of it, say the left third. The rest is left for
   GLava and whatever else, which backdrop stacks above it.
3. **As a layer between the two.** mpv's wallpaper at the back, sleeve over the whole monitor with a see-through background, and GLava on
   top. The wallpaper shows through sleeve's background while the lyrics stay solid.

backdrop stacks any order the user lists, so sleeve never needs to know what is above or below it, and a new neighbour asks nothing more of it.

### Areas

`--geometry` stays where the window is; `--lyrics-area` and `--now-area` say where content goes inside it, on `sleeve shell` and `sleeve ctl
display`, and as `lyricsArea` and `nowArea` over the socket. An area is `WxH+X+Y` relative to the window, each part pixels or a percentage of
the window: `33%x100%+0+0` is the left third, `67%x100%+33%+0` the rest. The default is the whole window.

- Text wraps and sizes to its area, within the same 22 to 44 px as a window, so a left third looks like a window that size. Nothing but the
  background paints outside the areas.
- `--now-position` places the panel inside `--now-area`. When the panel stands inside the lyrics' area, the lyrics keep clear of it; otherwise
  they ignore it.
- An area partly outside the window is clipped to it. One with no size, or a form it cannot read, is a bad option: status 2 at the start and
  status 1 from `ctl`, naming the value.
- Any geometry works, including one spanning monitors; one window per monitor is backdrop's choice.

### Background

`--background` says what fills the window, on `sleeve shell` and `sleeve ctl display`, and as `background` over the socket:

| Value | Meaning |
| --- | --- |
| `transparent` | nothing: what is behind the window shows |
| `#rrggbb`, `#rrggbbaa` | a color, and its alpha |
| `cover` | the current track's cover over sleeve's own dark color: opaque |
| `cover@0.6` | the cover at that opacity, over what is behind the window |

- The alpha is the background's alone: text and the panel stay solid. `_NET_WM_WINDOW_OPACITY` fades the whole window, so it cannot do this.
- `cover` is the blurred treatment a window shows, not the plain picture, and follows the user's `--art-*` settings in their `style.css`,
  `--art-animation: sleeve-art-flow` and its `--flow-*` included. backdrop has no options for those; they are the user's.
- Without `--background`, the window is transparent under `--managed`, so nothing changes for an existing instance.
- backdrop's `background: auto` stays on backdrop's side: it works out a veil from the wallpaper (`veilBackground` in `palette.js`) and only ever sends
  `#rrggbbaa`, with `#0a0f1a99` until it knows the wallpaper. `auto@0.5` is that veil with its alpha times 0.5 (any factor up to 1), for a look with no text to read over it. sleeve gets a new one over `sleeve ctl display` for most new wallpapers, so changing it has to stay cheap.

### Size

A window is exactly the size asked for since sleeve 0.39.2. Before it, one the size of its monitor came out 1 px short each way, leaving a line of wallpaper at the right and bottom under a
see-through background. backdrop worked around that from 2.50.1 by resizing the window, and no longer does, so use 0.39.2 or later for the wallpaper layer.

### Stacking

backdrop still owns stacking; sleeve never restacks once running, and marks nothing. A window that can now cover a monitor and be opaque would
hide every other window until it is placed, so `--map-below` maps it at the bottom of the stack, once, as GLava does for itself. It needs
`--managed`. Checked by polling the root's stack about every 30 ms: with it, at the very bottom in every sample once mapped; without it, on top.

### Colors

The stdin line is unchanged, and sleeve works out the rest. With a transparent background it should describe what shows behind the window, so
sample the strip under `--lyrics-area`, not the whole window, or a left third gets colors from the entire monitor. An opaque background ignores
the line. A see-through one blends over it (unit tested, and readable over a real veiled wallpaper on 2026-11-05, one wallpaper so far). GLava above sleeve does not affect this.

### Cost

`just bench-gpu` in sleeve measures this in the real shell with a placeholder track, and keeps every run in its `benchmarks/gpu.jsonl`. Averages
on Iris Xe at 2560x1440 with the lyrics in the left third, one or two runs each so far, in percent of the render engine's time:

| Window | Electron's GPU process |
| --- | --- |
| Transparent | 1.0 |
| See-through color | 2.3 |
| Still cover | 2.6 |
| Cover with `sleeve-art-flow` | 8.1 |
| Cover with flow at full size and 60 fps | 14.8 |
| Cover with `sleeve-art-drift` | 15.9 |

The compositor's share could not be told from its noise: picom alone read 15 to 25 with no sleeve window, and 20 to 29 with a transparent one, while
opaque scenes ran at the bottom of the stack and leave it out altogether. Repainting only the areas has not been built, since nothing here calls for it.

A start took 1.5 to 2.8 s in those runs, and 3.7 to 4.1 s during a library run. A stop took 67 to 375 ms.

### Example

The lyrics as the backdrop and bars beside them, no mpv wallpaper:

```yaml
visualizer:
  enabled: true
  instances:
    - name: lyrics
      engine: sleeve
      opacity: 1
      placement: {anchor: fill}
      sleeve: {lyrics_area: 33%x100%+0+0, background: cover}
    - name: bars
      module: bars
      rect: {x: 33%, y: 0, width: 67%, height: 100%}
```

The wallpaper at the back, sleeve over it, GLava on top (list order is stacking order, first lowest):

```yaml
visualizer:
  enabled: true
  instances:
    - name: lyrics
      engine: sleeve
      opacity: 1
      placement: {anchor: fill}
      sleeve: {lyrics_area: 33%x100%+0+0, background: '#10203099'}   # or auto: a veil worked out from each wallpaper
    - name: bars
      module: bars
      placement: {anchor: bottom, width: 100%, height: 25%}
```
