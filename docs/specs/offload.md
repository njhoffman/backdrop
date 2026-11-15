# Offload: encodes on another machine

Agreed 2026-11-15. A laptop (charon) has its reversed (bounce) and smoothed copies made by an always-on desktop
(minerva) instead of itself. Media and ratings are not shared by this; rating sync is separate (TODO.md, project 11).

## Pieces

- `offload.hosts` lists SSH destinations, tried in order. Empty (the default) encodes here, as before.
- `backdrop worker` (hidden, `src/offload/worker.js`) runs on the host, one job per invocation.
- `RemoteEncoder` (`src/offload/RemoteEncoder.js`) is the daemon's side. `Daemon.checkOffload` asks the hosts on
  start and every 5 minutes (`backdrop worker --hello`); the first that answers with this protocol is used.
- `src/offload/protocol.js` holds what both agree on: `PROTOCOL` (bumped on any change of shape), the job check and
  the heartbeat.

## A job

1. rsync uploads the source to `<host's paths.worker>/in/<key><ext>` (`--partial`, so a cut upload resumes).
2. `ssh <host> -- bash -lc 'exec systemd-run --user --scope --quiet -p MemoryMax=<memory_max> -- <worker_command>'`.
   A login shell, since node is on PATH only there on minerva. The job goes on stdin as one JSON line:
   `{ protocol, job: { kind: reverse | smooth, key, ext, bytes, media: { kind, duration, fps, width, height, speed },
   size?, target? } }`. `key` is the copy's key (`copyKey`: a sha256, or `<sha256>@<speed>.reversed`), so copies
   keep their names everywhere.
3. The worker answers JSON lines: `waiting` (another job holds `worker.lock`), `started`, then `done { file }` or
   `failed { code, error }` (`protocol`, `invalid`, `input`, `unsupported`, `encode`, `rife-timeout`).
4. rsync fetches `<dir>/out/<file>` with `--remove-source-files` to `<target>.remote.tmp`, renamed into place. A
   smoothed copy's size record is written here.

The worker uses its own config for how: `display.smooth_rife`, `display.smooth_gpu` and its encoders
(`defaultEncoders`). The client says what: the kind, the size (for this machine's monitors) and the frame rate.

## Never left running

The worker stops its job when stdin closes or no line arrives for 90 s; the client writes `{ ping: true }` every
15 s and closes stdin after the last event. Stopping a job here kills the SSH session, which closes the worker's
stdin. ssh runs with `ServerAliveInterval`, and the job in a `MemoryMax` scope: on 2026-11-15 an endless ffmpeg
filled minerva's 15 GiB and swap and froze it, since the kernel's OOM killer acts long after swapping starts.
A stopped job keeps its source and chunks for the next attempt; leftovers older than a day are cleared.

## Gates

A job on a host does not load this machine, so with a host available the bounce and smoothing queues ignore this
machine's load level and idle gate, and a load rise does not stop a remote job (`pause`, `tick`). They still share
one slot. When a job finds the host gone (upload or ssh fails before the worker starts) the host is dropped until
the next check and the job goes back to the front of the queue, for this machine's gates to start here. A job the
host could not make (`failed`) is not retried here: smoothing locally would mean hours on a laptop.

## Not yet

- The worker fetching Pexels sources itself, which would save the upload when away from home.
- More than one job at a time, or several hosts at once.
