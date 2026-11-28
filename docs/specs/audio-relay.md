# Audio relay

Two machines that each run backdrop, such as charon (the laptop) and minerva (the desktop), share whichever one's
music is playing. The machine that plays is the **server**; the quiet one is its **client**. The client:

- relays the server's music into a null sink of its own and shows it in its visualizer;
- shows in polybar that it is a client, with the server's volume;
- sends its audio keys (play/pause, next, previous, volume, mute) to the server.

The relay is off by default. Each machine names the other as its peer, typically under `hosts` in a shared config:

```yaml
audio_relay:
  enabled: true
hosts:
  charon:
    audio_relay: { peer: minerva }
  minerva:
    audio_relay: { peer: charon }
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Run the relay with the daemon |
| `peer` | `null` | The other machine, an SSH destination with passwordless (key) login |
| `players` | `[spotify, mpd, musicman]` | Players whose streams count as music |
| `grace` | `10` | Seconds of silence before a machine stops counting as playing |
| `watch_command` | `backdrop audio watch` | What the peer runs to report what it plays, in a login shell there |

A saved change to the section restarts the relay. The daemon does not need a restart.

## Roles

Only streams of the players in `players` count. A player is matched by its stream's `application.name`,
`application.process.binary`, `node.name` or `application.id`, case-insensitively. Notifications, video calls and
the relay's own stream never count. A stream counts while it is uncorked on a sink other than the relay's.

| Here | Peer | Role here |
|---|---|---|
| plays | quiet | server |
| quiet | plays | client |
| plays | plays | local: each machine shows its own music |
| quiet | quiet | local |
| any | unreachable | local |

Music starting counts at once. Music stopping counts only after `grace` seconds, so a gap between tracks does not
hand the music back and forth. Each machine decides its own role from the same two snapshots, so the two agree once
both snapshots have arrived.

## Parts

- `src/audio/streams.js` reads a snapshot with `pactl -f json`: `{ active, player, sink, volume, muted }`. The sink
  is the one the player plays on, or else the default output.
- `src/audio/MusicWatcher.js` follows `pactl subscribe` and reports each change of snapshot, applying the grace
  before reporting silence.
- `backdrop audio watch` runs a MusicWatcher and prints one JSON line per change, `{ v: 1, host, ...snapshot }`,
  until its stdin closes.
- `src/audio/PeerLink.js` runs that command on the peer over SSH (`bash -lc`, so PATH has node there). It keeps
  stdin open, so the watch on the peer ends with the session. When the session ends, it reports the peer unreachable
  and connects again after 5 s, a delay that doubles up to 60 s.
- `src/audio/RelayPipe.js` runs on the client: `ssh server parec -d <sink>.monitor | pacat -d backdrop_relay`, at
  s16le, 48 kHz, stereo, with a 20 ms latency on both ends. Without `--latency-msec`, parec hands over 2-second
  fragments. The null sink `backdrop_relay` has no speakers, so nothing plays twice. A pipe that ends starts again
  after 2 s, doubling up to 30 s.
- `src/display/daemon/AudioRelay.js` decides the role and starts or stops the pipe. It gives the visualizer
  `backdrop_relay.monitor` in place of `source: auto` (`VisualizerManager.setRelaySource`) and writes `audio.json`.

## Visualizer

As a client, GLava instances restart on `backdrop_relay.monitor`. A source the section names explicitly is kept.
sleeve and projectM read no source setting, so they do not restart. sleeve follows the song through Spotify itself
anyway. `only_while_playing` and `wallpaper_dim` keep working: the relay sink plays exactly while the server does,
because the pipe stops once the server falls quiet.

## audio.json

The daemon writes `audio.json` to the runtime dir (`$XDG_RUNTIME_DIR/backdrop/audio.json`) on every change of role
or of the server's volume, and removes it when it stops:

```json
{ "pid": 4242, "host": "minerva", "peer": "charon", "enabled": true, "role": "client", "server": "charon",
  "reachable": true, "player": "spotify", "sink": "bluez_output.AC_BF_71_3A_B8_92.1", "volume": 54, "muted": false,
  "since": 1795850000000, "local": { "active": false }, "remote": { "active": true } }
```

`server` is the host whose speakers play (null while local). `player`, `sink`, `volume` and `muted` describe the
server. `backdrop audio status` prints the file as a line (`client of charon: spotify 54%`), or as JSON with `--json`.
With `--follow` it prints again on each change, which suits a polybar `tail` module. With no daemon running, or a
file whose daemon is gone, the role is local.

## Desktop integration

These live outside this repository and read `audio.json`:

- polybar (`~/.config/polybar`): the `audio-role` module beside the volume module shows the role and the other
  machine, and on a client the server's volume.
- i3 (`~/.config/i3/bin/i3_volume.sh`, `i3_music.sh`): on a client, each key runs the same script on the server over
  SSH, with that machine's `DISPLAY` and session bus.

## Limits

- Bluetooth speakers play about 200 ms behind the monitor that both visualizers read, so the bars lead the sound on
  both machines, as they do on one.
- A paused Spotify can leave its stream uncorked for a while, so a machine can count as playing for some seconds
  after a pause.
- The roles cover two machines; a third peer is not supported.
