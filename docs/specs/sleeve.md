# sleeve as a visualizer engine

What sleeve (`~/git/sleeve`, synced lyrics) promises so backdrop can run it as a visualizer, the way it runs GLava.
Agreed 2026-11-04; requires sleeve 0.33.0 or later (`sleeve --version`). Changing what is below is a breaking change for
the other side: add freely, but change or remove only with a version note in both CHANGELOGs. What backdrop still has
to build is in `TODO.md`, section 9.

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
sleeve ctl display --instance DP-3-lyrics --hide      # or --show; nothing is drawn while hidden
sleeve ctl display --instance DP-3-lyrics --reset     # back to its start options and style.css
```

Without `--instance` it applies to every sleeve page; an instance's change wins over that for the instance, and `--reset`
without `--instance` forgets them all. It takes effect on the next frame, with no restart. Exit status: 0 done, 1 refused
(a value it does not know, named on stderr), 2 sleeved not running.

The same goes over sleeved's socket as `{"type":"display","instance":"DP-3-lyrics","preset":"full"}`
(`docs/protocol.md` in sleeve). Changes last until sleeved restarts, which forgets them: backdrop should send what it
wants again when it starts, and treat the start options as what survives.

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
