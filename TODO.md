# TODO

Roadmap for turning pexels-cli into **backdrop**: a source-agnostic wallpaper and screensaver
manager that displays everything through mpv IPC sockets. Section 1 covers bugs found while
surveying the current code; the remaining sections are the planned redesign, roughly in
dependency order.

Reviewed: 2026-11-07

## 3. Display engine on mpv sockets

- [x] **mpv IPC display backend.** (p1) [feature] Replace the external `get-name` / `play-prev` / `play-next` hooks with a backend that owns mpv and talks JSON IPC over `--input-ipc-server`.
      Reference the existing scripts: `~/bin/wallvideo` (xwinwrap + `mpv -wid WID --loop --no-audio --input-ipc-server`), `~/bin/scratch.sh` (`wallvideo` with `--speed`), `~/bin/bg.sh` (per-geometry xwinwrap and cleanup).
      Current file and next/prev become `get_property path` and `loadfile`/`playlist-next`.
- [x] **One socket per monitor.** (p2) [feature] Spawn one xwinwrap+mpv per output with its geometry (as `bg.sh` does with `-g`) and a socket like `$XDG_RUNTIME_DIR/backdrop/<output>.sock`.
      X11 only via xwinwrap; Wayland is out of scope (decided 2026-10-21).
- [x] **Static images and GIFs through mpv.** (p2) [feature] Show images with `--image-display-duration=inf` (or a slideshow interval) and GIFs with `--loop-file=inf`, so all media uses one code path (the `wall` / `wall.gif` cases).
- [x] **Per-video playback speed, persisted.** (p1) [feature] Commands to slow down / speed up the current video (`set_property speed`), saved per media item in the DB and applied on the next play.
- [x] **Daemon lifecycle.** (p2) [feature] `backdrop start|stop|status`, a PID/state file, and recovery when mpv or xwinwrap dies (bg.sh currently uses `kill -9`).
- [x] **Rate the current item via the socket.** (p1) [refactor] `keep` / `skip` / `go-next` use `DisplayControl.current()`
      with monitor targeting. Skip removes all playlist references before moving to trash. Persistent undo deletes the latest rating and
      restores its exact previous path; schema v4 upgrades existing databases. Failed database writes roll file moves back.
- [x] **Playlists go stale while the daemon runs.** (p2) [feature] Import/download append eligible items immediately,
      rating moves refresh affected playlists, and skip/remove delete every matching entry. Appends avoid duplicate paths.
      External file changes remain covered by the separate missing-files/watch-mode tasks.
- [x] **Missing files can make mpv spin.** (p2) [bug] If every playlist entry fails to load (files moved or deleted outside backdrop), `--loop-playlist=inf` keeps retrying.
      Checked with mpv 0.40: an all-missing playlist goes idle on its own, but mixed playlists retried missing entries on every pass.
      The daemon now drops entries reported by `end-file` with `reason: error`; the database is not changed.
- [x] **Hung mpv is not detected.** (p3) [feature] Supervision only reacts to process exit; an mpv that stops answering IPC stays up. The daemon now checks `get_property pid` every 30s and kills an mpv that misses two in a row; the normal restart budget applies.
- [x] **Per-item dim command.** (p2) [feature] `backdrop dim <value>` (absolute, `+N`/`-N` steps, `reset`, `--monitor`) works like `speed`:
      sets mpv `brightness` on the playing item over IPC and stores it per media item (schema v5 column, default 0), so it is reapplied on the next play.
      Apply it in `Daemon.onFileLoaded` for images and videos alike, always setting the value (0 when unset) because mpv keeps the property across files.
      Decide whether to accept a 0-100 dim amount mapped to negative brightness, or raw brightness -100 to 100; consider lowering `saturation` with it.
      `backdrop current`/`status` should show non-zero dim. Cheaper than xwinwrap `-o` opacity, which needs a compositor blending every frame.
      Done: `backdrop dim` takes a 0-100 amount (brightness = -dim), steps clamp to the range; schema v5 `media.dim`; saturation left alone.
- [x] **Undo can get stuck.** (p3) [bug] `undo` only ever targets the globally latest rating. If that rating cannot be undone (its skip was purged, or
      `download --upgrade` renamed the file so `rated_path` no longer matches), every later `undo` fails the same way. Update `rated_path` when an upgrade renames a file,
      and let undo report and step past an unrestorable rating (or add `undo --discard`).
      Done: ratings have a `final` flag (v9) that undo skips; purge sets it, `download --upgrade` renames recorded paths, and `undo --discard` drops a stuck rating.
- [x] **A missing configured monitor blocks startup.** (p2) [bug] `selectMonitors()` throws when a name in `display.monitors` is not active, so
      `Daemon.start()` fails if that monitor is unplugged at boot, and `targetResolution()` makes search/download fail too. Hotplug already tolerates it at runtime.
      Start with the configured monitors that are present (warn about the rest) and size downloads for those, failing only when none are active.
      Done: the daemon starts on the configured monitors that are active, or on none, and hotplug adds the rest; downloads size for the active ones and warn.
- [x] **state.json is written in place.** (p3) [bug] `Daemon.writeState()` uses `fs.writeJson` directly and `readState()` treats a parse error as "not running",
      so a CLI command racing a rewrite (now on every hotplug change) can report the daemon as stopped. Write to a temp file in the runtime dir and rename it.
      Done: written to a temporary file and renamed; skipped during shutdown so a late sample cannot recreate it.
- [x] **Hotplug only tested with fakes.** (p3) [test] Reconciliation is covered against a fake `xrandr`; confirm on real hardware (attach, remove, change resolution,
      lid close) and note any xrandr output the parser misses, e.g. monitors without a physical size.
      Done in 2.40.3: on real hardware (2026-11-01, i3, DP-3 plus the laptop's eDP-1 with its lid closed, turned on and off
      with xrandr) the daemon added eDP-1, restarted it at 1600x900 after a mode change and dropped it when it went off,
      with nothing in the log. `test/display/hotplug.integration.test.js` changes the resolution of an Xephyr nested in
      Xvfb under a real daemon and the real xrandr; Xvfb 21.1 and Xephyr cannot add monitors (`--setmonitor` is ignored,
      `--delmonitor` crashes Xephyr), so attach and remove stay covered by the fake. Not checked: opening and closing the
      lid itself, and a monitor reporting 0mm in `--listactivemonitors` (the parser skips the mm fields, so it should hold).
- [x] **No record of player CPU use.** (p2) [perf] Nothing measures what the mpv instances cost over time. Have the daemon sample each
      screen's mpv CPU (from `/proc/<pid>/stat`, every minute or so) and keep a rolling average per monitor and per item, alongside
      `hwdec-current`, resolution and fps; show it in `status` and `stats`. That shows which items are expensive and whether 4K media
      is worth keeping (2026-10-28 spot check on Iris Xe: 4K24 H.264 ~26% CPU with VA-API vs ~400% in software; 1080p30 ~17%).
      Done: sampled on each 30s health check into `playback_stats` (v8); shown in `status`, `current` and a `stats` section.
- [x] **Software-decode fallback goes unnoticed.** (p2) [perf] `--hwdec=auto-safe` silently falls back to software for unsupported
      codecs or profiles, which costs about four cores at 4K. `Daemon.onFileLoaded` could read `hwdec-current` and log a warning
      (and mark the item) when it is empty for media larger than 1920x1080.
      Done: the decoder is read on each sample and stored per item; software decoding above 1080p is logged once per item and run.
- [x] **Monitor hotplug.** (p2) [feature] `Daemon.start()` reads `xrandr` once; a monitor attached later gets no wallpaper and moved outputs keep stale geometry until `backdrop stop && backdrop start`.
      Poll `xrandr --listactivemonitors` (or listen for RandR events) and start, stop or respawn per-monitor mpv instances on changes, then rewrite `state.json`.
      Done: the daemon polls xrandr every 5s; empty or failed reads keep the layout, and crash restarts cannot race a layout change.
- [x] **Status hides why a monitor is blank.** (p3) [feature] When no library item is at least as large as a monitor, it idles and only the log says "No media to show".
      `backdrop status` should report per monitor how many items are eligible and suggest `display.allow_upscale` or a fresh download.
      Done: `status` shows eligible counts per monitor and a reason and fix for blank ones.
- [x] **Quiet config creation in tests.** (p3) [test] `ConfigManager.createDefaultConfig()` prints to stdout during `npm test`; inject an output stream or silence it in tests.
      Done: ConfigManager sets `created`; the CLI prints the notice on stderr.
- [x] **Speed changes do not recompute the video limit.** (p3) [bug] `display.video_duration` is turned into
      `loop-file`/`end` when a video loads (`playbackLimits` in `src/display/Playlist.js`); `backdrop speed` on a playing
      video changes how long those loops take until the next load. Reapply the limits in `DisplayControl.speed()`.
      Done in 2.40.2: the daemon observes mpv's `speed` and calls `applyLimits` with the elapsed time and mpv's `time-pos`,
      since what played so far went at the old speed; this also covers mpv's own speed keys. Checked live: 56 loops left
      at 1x became 24 at 0.5x.

- [x] **Processes outlive a crashed daemon.** (p2) [bug] xwinwrap/mpv and GLava run in their own process groups (killed
      as groups by `stop`), and `pactl subscribe` is a plain child. When the daemon dies without running `stop()` (kill -9,
      out of memory, an uncaught error) they keep running, and the next `backdrop start` adds a second wallpaper and
      visualizer per monitor on top. Under systemd the service's cgroup is killed on failure, so this hits `backdrop
      start` and i3 `exec`. Record every child's pid in `state.json` (visualizer pids are there already, xwinwrap's are
      not); when `start()` finds a state file whose daemon is dead, kill those process groups first, and remove stale
      sockets.
      Fixed in 2.26.4: the daemon's spawn records every child in `children.json` (`src/display/children.js`) as it
      starts and exits, since the visualizer's own restarts never rewrite `state.json`; `start` and `stop` end the
      recorded process groups of a dead daemon when their `/proc` start times still match, and an uncaught error
      in the daemon runs `stop()` before exiting. Checked under Xvfb with kill -9: `start` and `stop` both end the
      old xwinwrap+mpv group, waiting on the whole group since mpv outlives xwinwrap.
- [x] **An eligibility change restarts the item on screen.** (p3) [feature] Since 2.31.0 a saved change to
      `display.allow_upscale` or `library.min_width/min_height` reloads each monitor's playlist, which restarts what plays.
      Keep the current item playing when it is still eligible: rebuild the rest of the playlist around it (as
      `queueRandom` already moves entries) instead of `loadlist ... replace`.
      Done in 2.39.0: `syncPlaylist` (`src/display/Playlist.js`) removes entries no longer eligible, appends newly
      eligible ones shuffled (the next wrap reshuffles them in), and removes the playing entry last when it dropped out,
      so mpv moves on to the one after it; checked against a real mpv in `mpv.integration.test.js`.
- [x] **Control requests can be lost when two run at once.** (p3) [bug] `control.json` is a single slot: two commands
      at the same moment (e.g. `next --video-duration` and `stop --wallpaper` from keybindings) overwrite each other's
      request, and both see the daemon's `control` counter move and report success. Write one file per request
      (`control-<pid>-<n>.json`) that the daemon handles in name order, or take an exclusive lock (`open` with `wx`)
      around write-signal-wait. Since 2.28.0 the visualizer menu sends `visualizer_set` requests too (each awaited, so
      the menu alone is safe), and a keybinding firing during a menu change would lose one of them.
      A control socket in the runtime dir (one connection per request, answered when applied) would fix this and
      replace the signal-per-action scheme as requests grow (the menu's wallpaper button in 2.36.0, and dim changes).
      A second race: the daemon read `control.json` and then removed it, so a request written in between was deleted unread.
      Done in 2.38.2: `sendControl` writes `control-<id>.json` (renamed into place, ids sort by time), the daemon applies
      every pending file in name order on each SIGUSR1 and lists the latest 32 ids in `state.json` `handled`, and the CLI
      waits for its own id, withdrawing the file on timeout. Older CLIs and daemons fall back to `control.json` and the
      counter. A control socket is still the way to go once requests need answers with data.
- [x] **Concurrent `next` calls can drop a stored duration or filter.** (p3) [bug] `resolveNextFilters`
      (`src/display/nextFilters.js`) reads `next-filters.json`, merges and writes it back, so `next --video-duration 3m`
      and `next --image-duration 90` fired at once can each write over the other's key (the request files of 2.38.2
      make sure both durations requests arrive, but the daemon then reads whichever file won). Take a short lock around
      read-merge-write (`open` with `wx`, as `importLock.js` does), or send the given values in the control request and
      let the daemon own the file.
      Done in 2.40.1: the lock code moved to `src/utils/fileLock.js` (`ImportLock` builds on it), and `resolveNextFilters`
      reads, merges and writes under `next-filters.lock` (50 ms polls, 5 s timeout), telling the daemon after release.
- [x] **mpv's GPU memory grows across image slides.** (p1) [bug] Seen 2026-11-02 on Iris Xe (mpv 0.40.0, Mesa 25.2.8,
      `--vo=gpu`, software decode, 300 s slides): after 34 slides in 2h52m the DP-3 mpv held 9.0 GB of GPU buffers
      (`drm-total-system0` in `/proc/<pid>/fdinfo`) while showing a 1920x1200 JPEG; on Intel these live in system shmem,
      so mpv's RSS showed 60 MB while 13 of 15 GiB were in use and 5.9 GiB swapped. Skipping three slides over IPC: a
      4340x6597 image left it at 9.0 GB, a 3840x2160 one dropped it to 4.3 GB (system Shmem 9.4 to 4.9 GB), so buffers
      pile up and only some transitions (likely an output size change) free them; about 265 MB per slide. Not yet
      confirmed whether mpv's `gpu` vo or Mesa iris is at fault: sample fdinfo over several same-size slides.
      First try another output for images: `--vo=gpu-next`, or `--gpu-api=vulkan` (anv), and compare growth over a
      dozen slides; switch the spawn args if one holds flat.
      Diagnosed 2026-11-02: not a per-slide leak. Standalone mpv held flat (about 700 MB) over 12 same-size 4K slides
      and 40 mixed ones, and the daemon's mpv held flat for 90 s under GLava. Driving the daemon at 5 s slides, it
      jumped from 475 MB to 8.6 GB within one slide, on huge Pexels portrait originals from the inbox (7024x12480,
      7499x14998, 4536x8064), and stayed near 6.9 GB through the smaller slides that followed: mpv sizes its textures
      and render targets to the source image and keeps the high-water mark. The 7499x14998 image alone: 5.7 GB with
      the default vo (already Vulkan here), 2.7 GB with `--vo=gpu-next`, 1.2 GB with a CPU prescale to the monitor's
      cover size (`--vf=scale=w=1920:h=1080:force_original_aspect_ratio=increase`). Fix: prescale oversized images
      before they reach the GPU, only for those items (a global `vf` would force copy-back for hardware-decoded video).
      Done in 2.42.0: mpv 0.40 dropped `hook-add` from JSON IPC, so playlists load with one `loadfile` per item instead
      of an m3u `loadlist`, and images that would lose more than half their pixels get a per-file `vf` scale
      (`src/display/prescale.js`) bringing their shorter side to the monitor's longer one. Rotation-agnostic, since the
      decoded frame is not yet EXIF-rotated. `--vo=gpu-next` stays opt-in through `display.mpv_args`.
- [x] **Restart mpv when its GPU memory passes a limit.** (p2) [perf] A safety net whatever the leak's cause: on the
      30 s health check (next to the CPU sample in `playback_stats`), read the mpv pid's `drm-total-system0` from
      `/proc/<pid>/fdinfo` (the DRM fd with a nonzero total), keep it per monitor and item, show it in `status` and
      `stats`, and respawn the monitor's xwinwrap+mpv past a configurable cap (e.g. `display.max_gpu_memory: 2G`),
      resuming at the same playlist position, between items so the restart is only a brief flicker. Log each restart
      with the size reached.
      Done in part in 2.42.0, the rest dropped: the growth came from source size, which the prescale bounds, so there is
      no restart cap. The health check reads each mpv's GPU memory (`src/display/gpu.js`, summed per DRM client over
      every `drm-total-*` region) into `state.json`, `status` and `status --json` (`gpu_memory_bytes`); not per item
      in `stats`, which would need a schema change. Reopen the cap if `status` shows growth again.
- [x] **Show still images without mpv.** (p3) [refactor] Won't fix (2026-11-02): the prescale fixed the memory use. If neither another vo nor the restart cap is enough, set
      JPEG/PNG wallpapers with `xwallpaper` or `feh --bg-fill` per monitor geometry and keep mpv for video and GIFs.
      Costs the single display path from "Static images and GIFs through mpv": slideshow timing, `next`/`prev`,
      brightness, dim and the visualizer overlay would need a second backend, so only worth it if the leak stays.
- [x] **Lighter display under system load.** (p2) [feature] A `load` section: over `image_above` videos become images, over `off_above` the wallpaper and visualizer stop,
      with `sustain`, `resume_ratio` and `resume_after` against flapping (`src/display/LoadGovernor.js`, `src/display/daemon/LoadShedding.js`, `docs/specs/main.md`).

- [x] **The rofi integration tests are flaky under load.** (p3) [test] `test/commands/menu.integration.test.js` failed twice on 2026-11-05 at a load around 9, with no code changed: `rofi did not open a window` in a full run, and
      `draws the real main and step menus` alone with entries out of order (`[14, 1, 0, 1]`, expected `[14, 0, 1, 22, 1, 20]`). It passed 2 of 3 alone and passes on CI. Likely a fixed wait in `waitForRofi` and in reading what rofi drew.
      Done: `driven` waits with a longer deadline, presses again until that run closes, and waits for its window to go before the next. It still failed about 1 run in 10 at a load over 20 with `rofi did not open a window`; the error now carries rofi's own output for next time.
- [x] **The restart-limit test is flaky under load.** (p3) [test] `Daemon restarts gives up after repeated exits within a minute` waits a fixed 10 ms after each exit
      (`test/display/Daemon.test.js:484`), so a busy machine counts 6 launches instead of 7: seen once at a load around 16 on 2026-11-04, 8 of 8 passes alone. Wait for
      the next spawn instead of sleeping. Done: it waits for each launch.

- [x] **rofi cannot open the test's Xvfb display.** (p3) [test] In a full run on 2026-11-07 (load about 5) three tests in `test/commands/menu.integration.test.js` failed with `Failed to open display: :1` from rofi, before any window,
      though Xvfb had reported `:1` through `-displayfd`; the file passed 2 of 2 alone right after. Wait until a client can connect (`xdpyinfo`, or retry rofi's first start) before the tests begin.
      Done in two steps. First `startXvfb` waited until `xdotool getdisplaygeometry` connects, which did not stop it: the next failure was one rofi run in the middle of the file, with the runs before and after it fine on the same display, so a single connection fails under load rather than the server being missing. `driven()` now starts a view again (up to three times) when its rofi exits with `Failed to open display` before opening a window, dropping the failed run from the checks.
- [x] **A hung mpv now takes longer to restart.** (p3) [bug] Commands wait 15 s since 2.50.7, so two failed health checks 30 s apart take about 45 s from the first where they took about 35 s. Give the health check's own `pid` query a shorter timeout than loads get.
      Done: the health check asks mpv for its pid with its own 5 s timeout (`HEALTH_TIMEOUT_MS`), so a hung mpv is restarted about 35 s after the first failed check again; loads keep 15 s.
- [x] **No test holds the decoder order.** (p3) [test] Nothing asserts `--hwdec=vaapi,auto-safe` or the 15 s timeout from 2.50.7, so either could regress to the startup failure unnoticed. It is also unexplained why CUDA's probe became slow here, having been fine earlier the same day, and VAAPI first is untried on an NVIDIA machine.
      Done: `Daemon.test.js` holds `--hwdec=vaapi,auto-safe`, the 15 s command timeout on connect and the 5 s health check. Why CUDA's probe became slow stays open below.
- [x] **Bounce videos.** (p2) [feature] Play a video to its end, backwards to its start and forwards again: `display.video_loop: bounce`, or `backdrop bounce on|off|toggle|reset` per item (schema v10, also in the menu's speed panel).
      Done: the daemon reverses a video in chunks (VAAPI, else libx264, nice 19, normal load only) into `~/.cache/backdrop/bounce/<id>.mp4` on its first play and for the next entry, and plays the pair as one `edl://` entry (`src/display/bounce.js`, `daemon/Bounce.js`, `src/library/reverse.js`).
- [x] **Smooth slowed videos.** (p2) [feature] A video slowed to 0.5 shows half its frames a second and stutters. Measured on 2026-11-07 on the Iris Xe: ffmpeg `minterpolate` at 130x real time on one core, RIFE (`rife-ncnn-vulkan`) at about 90x on the GPU with no dropped wallpaper frames, mpv frame blending nearly free but with an unsteady display clock (55 of 60 fps estimated).
      Done (2.61.0): `display.smooth` makes RIFE copies at `smooth_fps` in the background (`src/library/smooth.js`, `daemon/Smooth.js`), with mpv's blending until each is ready; RIFE is installed in `~/.local/share/backdrop/rife`. Checked on a real 4.5 s clip: 18.5 minutes at 5x (before 29.97 fps was taken as reaching 60 at 4x), and a timestamp gap in it showed that extraction must keep the decoded frames as they are (`-fps_mode passthrough`), or ffmpeg repeats one and the copy stalls there.
- [ ] **Judge smoothed videos by eye.** (p2) [test] The copies' frame counts and joins are checked, but nobody has watched one at speed 0.5 on the desktop, nor compared it with the blending, which mpv times against a display clock it measures badly through xwinwrap. If RIFE's artifacts show on fast motion, try the `rife-v4` model or a lower `smooth_fps`.
- [x] **Resume stopped smoothing jobs.** (p2) [perf] Each daemon restart or load rise stopped the RIFE job in progress and the next run started over, so on 2026-11-08 a night of restarts left 0 of 39 copies made.
      Done (2.64.0): finished chunks stay in `<id>@<speed>.smooth.work` with a `job.json`; a matching job carries on from its first missing chunk, and the backlog takes those items first.
- [x] **Browser page test times out in full runs.** (p2) [test] On 2026-11-08 both tests in `test/web/pages.browser.test.js` hit the 60 s timeout late in a full run (load average around 8 with the daemon's RIFE job), yet passed in 11 s run alone.
      Done (2.64.1): not the load (15 runs under a load of 8 all passed, in 24-34 s), but D-Bus: `browser.newPage()`, which has no timeout, waits on Chrome's calls to the session bus, and a bus that accepts but does not answer reproduced both failures exactly. The test's Chrome gets a missing bus address (refused at once), and each step a 15 s deadline that names it.
- [ ] **Resume stopped reversals too.** (p3) [perf] `reverseVideo` still starts over when stopped; it is fast with VAAPI, but a long video under libx264 loses minutes. The same kept-chunks scheme would fit its chunked reverse.
- [ ] **RIFE is slow on integrated graphics.** (p3) [perf] About one 1080p frame a second on the Iris Xe, so a 20 s clip at 0.5 takes about 30 minutes and the 39 slowed videos about a day. Try `-j` thread counts (load:proc:save), RIFE's half-resolution flow for 4K-sourced copies (`-u` off, `-x`), or the smaller `rife-v4` model, timing each on the same clip.
      Tried `-j` on 2026-11-08 (6 frames of 2560x1440 to 16, factor 3, the daemon paused, three rounds): `1:2:2` (the default), `1:1:2`, `2:2:2`, `2:4:4` and `4:8:4` all took 23.6-25.6 s, the spread within a round. RIFE is bound by the GPU, so threads change nothing; left at the default. What remains is the work itself: the smaller model, or fewer pixels.
- [x] **The first smoothing job after a start ignored the monitors.** (p2) [bug] `smoothing.begin()` ran before the daemon registered its monitors, so `smoothSize` fell back to the video's own size: #1622 was being made at 2560x1440 for a 1920x1080 screen, and a 4K source would be made at 3840x2160, four times the pixels. One of the 14 finished copies is 2560x1440 for this reason.
      Done (2.64.2): smoothing starts after the monitors, and no job starts while none is known.
- [ ] **Judge the bounce seam by eye.** (p2) [test] mpv sets up the decoder again where the video meets its reversed copy. On the desktop (2026-11-07, 2732x1440 at 24 fps, VAAPI) no frame dropped at the seam or the loop,
      but nobody has watched for a visible hitch, nor tried 4K at 60 fps or software decoding. If it shows, encode the copy to match the original's codec settings, or try `--demuxer-cache-wait`/a larger `--demuxer-readahead-secs`.
- [x] **Reversed copies outlive their bounce.** (p3) [chore] `bounce off`, `video_loop: loop` and items dropped from the playlist keep their copy until the item is purged, and `video_loop: bounce` grows
      `~/.cache/backdrop/bounce` by about 1.7x each played video with no limit. Have purge drop copies of items that no longer bounce, add a size cap (oldest played first), and show the cache's size in `doctor` or `stats`.
      Done: `display.bounce_cache_gb` (10) with the least recently played deleted first, copies of items gone, skipped or no longer bouncing deleted, their entries swapped back to the file, and the size in `doctor` (`Bounce.prune`).
- [x] **A small bounce cache encodes every play.** (p3) [perf] With 779 eligible videos (32 GB) and the 10 GB default, most copies are deleted before a video comes round again, so nearly every
      play costs one encode (13 s for an 11 s 1440p clip with VAAPI, at nice 19). Log encodes per day, and if they matter raise the default or keep copies of kept, higher-rated videos first.
      Done: eviction keeps the higher-rated and then the oldest copies (newest deleted first), so a steady set survives each pass instead of none, and `doctor` shows the encodes today and yesterday. Watch those counts before raising the default.
- [x] **The item that starts an encode bounces only from its next play.** (p3) [feature] Its entry is playing, so it is not swapped (reloading would restart it). When the copy is ready before its last pass, it could
      be swapped at the loop with `loadfile <url> replace` plus `start=` the current position, which needs a check that it shows no jump (`daemon/Bounce.js`).
      Done: `Bounce.planSwitch` switches it about 100 ms before the end of its pass (insert-next, playlist-next, old entry removed), carrying its play time; seen working on #1603 on the desktop. It waits for the next play when the video duration leaves no room for a whole bounce.
- [x] **The stacking integration tests time out under load.** (p3) [test] `test/display/stacking.integration.test.js` failed in two full runs on 2026-11-07 (one test, then two: "Timed out waiting for the other window at the bottom" and "for overlays below and above the visualizer"), the second while the live daemon was reversing videos; alone it passed 6 of 6. Its `waitFor` deadlines suit an idle machine: lengthen them, or wait on the daemon's restack having run (its state) before reading the stacking order.
      Done (2.63.0): it failed three tests in a run while RIFE smoothed in the background; the waits now allow 20-30 s (they return as soon as the order holds) and each test 120 s. That was not all: a 20 s wait still failed, since the test ran health checks every 0.5 s, and with 2.57.0's 5 s wait a slow load under load failed two in a row and the daemon killed a healthy mpv, whose new wallpaper went to the bottom. The test runs without health checks now; on the desktop two failures are 30 s apart.
- [ ] **npm audit flags mocha's glob and minimatch.** (p3) [chore] Three moderate advisories (GHSA-g3hv-75wg-m249 and others) in `glob` 13 and `minimatch` 10 under `mocha` 12, dev dependencies only; `npm audit fix --force` would move mocha across a major version. Check for a mocha release that takes the fixed versions, or pin them with `overrides`, and run the suite.
- [ ] **Why CUDA's probe became slow.** (p3) [test] Split from the decoder order item: mpv's CUDA probe stalled its start past the IPC timeout on the NVIDIA desktop on 2026-11-05, having been fine earlier that day, so 2.50.7 put VAAPI first. Unexplained, and VAAPI first is untried on another NVIDIA machine; time `mpv --hwdec=cuda` starts there and check the driver's state (`nvidia-smi`) when it is slow.
- [ ] **Load thresholds ignore the CPU count.** (p3) [feature] `load.image_above` (12) and `load.off_above` (24) are absolute,
      but a load average only means something relative to the number of CPUs: 12 is heavily overloaded on 4 and comfortable
      on 32. Allow per-CPU values (say `per_cpu: true`, using `os.availableParallelism()`) or document how to scale the defaults
      (`src/display/LoadGovernor.js`, `config.example.yaml`, `docs/specs/config.md`). `screensaver.max_load` reads the same value.

## 4. Media sources
      Since 2.24.0 `Daemon.applyLimits(screen, media, { elapsed })` recomputes limits mid-play for duration changes;
      observing mpv's `speed` property in `startScreen` and calling it on a change would close this.
- [x] **Source plugin interface.** (p1) [refactor] `Source`/`SourceRegistry` provide search, metadata, normalized download
      variants and quota information; Pexels is the first adapter. Source-specific credentials are checked only on API requests.
      See `docs/specs/sources.md` for the contract and current Pexels endpoints.
- [ ] **Unsplash source.** (p2) [feature] Official API, images only; requires an access key and attribution/download-tracking per their guidelines.
- [ ] **Other free sources.** (p3) [feature] Only sites with a public API qualify; scraping is out (decided 2026-10-21).
      That excludes MoeWalls and wallsflow.com (checked 2026-10-21: `/api/` redirects to the homepage, no developer docs).
      Candidates: Wallhaven (API with resolution filters), Pixabay (API, has video). Pick after the interface exists.
- [x] **Pexels adapter not run against the live API.** (p2) [test] Search, metadata, variants, download and `--upgrade` are only tested against mocked responses.
      Run a manual smoke test with a real key, record any differences in `docs/specs/sources.md`, and consider an opt-in live test gated on `PEXELS_API`.
      Partly done 2026-10-31: a live `search-images` (axios 1.21.0) paged through 161 pages cleanly; metadata, download
      and `--upgrade` remain untried live.
      Done in 2.32.2: search, metadata, download and `--upgrade` run live for both kinds (scratch library, one page per
      kind). Found and fixed: Pexels' fixed-shape crops (`fit=crop`) were picked at small targets; now left out, also
      from stored rows (`usableVariants`). Opt-in `test/sources/pexels.live.test.js` (`BACKDROP_LIVE_TESTS=1`).
- [x] **Duplicate downloads are retried forever.** (p2) [bug] When a downloaded file's sha256 matches an existing item, `downloadItem()` throws
      `Duplicate content of #N` and leaves the pending row as `new`, so every `backdrop download` fetches it again, and its search queries never reach the kept copy.
      Record the duplicate (e.g. `media.duplicate_of`), move its `search_results` to the original, and exclude it from pending lists.
      Done: schema v6 `media.duplicate_of` (no foreign key); searches that return a known duplicate credit the original.
- [ ] **A search has no page cap.** (p3) [feature] `SearchCommand` follows `nextPage` until results run out or the
      rate limit hits, so a broad query with a small `--per-page` spends one request per page (161 for "ocean" at
      3 per page on 2026-10-31; the live quota headers report a limit of 25,000, so that was about 0.6% of it). Add `--max-pages` (and a `sources.<name>.max_pages`
      default), or warn when `--per-page` is small and the query broad.
- [ ] **Downloads have no size limit or stall timeout.** (p3) [bug] `downloadFile()` streams whatever the server sends; axios `timeout` is not verified to cover
      a body that stalls mid-transfer, and nothing caps the size. Abort when no data arrives for 30s and when bytes exceed Content-Length (or a configured maximum).

## 5. Local library import

- [x] **Auto-import local files as pre-approved.** (p1) [feature] Scan configured directories (and `backdrop import <dir>`), add files directly to the kept library with rating 2/3 and no review step.
      Done: `backdrop import`, rescanned on every daemon start; copies (originals untouched), dedupes by SHA-256, skips unchanged files by size/mtime, rejects < 1024x768.
- [x] **Consistent names for imports.** (p2) [feature] Rename imported files to a sequential `local-<n>.<ext>` (no category detection, decided 2026-10-21).
      Keep the original filename and path in the DB; never reuse a number after deletion.
- [x] **Watch mode for import directories.** (p3) [feature] Pick up new files while the daemon runs (fs.watch / inotify) instead of only on start or `backdrop import`.
      Done (v2.34.0): `library.watch_imports` (default on) watches the folders recursively; a change, once quiet for 2s, runs the usual
      import over every folder, leaving files changed in the last 2s for another pass. Changes a network share gets from other
      machines are not seen (inotify) and wait for the next start or `backdrop import`.
- [x] **No command to remove an item from the library.** (p2) [feature] `backdrop remove <id>` or `backdrop remove --current [--monitor <name>]`
      deletes the file and media row after removing all playlist references. `imported_files` keeps the source record so unchanged originals are not re-imported.
- [x] **Animated WebP imports as a still image.** (p3) [bug] ffprobe cannot decode animated WebP, so `probe.js` classifies it as `image`; detect the ANIM chunk and treat it as `gif`.
      Done (v2.34.1): the premise was wrong. FFmpeg 7.1 reports a 0x0 picture, so these were rejected as `unsupported` ("no picture
      stream"), and mpv 0.40 cannot play them either. Now the VP8X animation flag gives the reason, `doctor` lists the files with a
      conversion hint, and an FFmpeg that decodes them (probe succeeds) imports them as `gif`.
- [ ] **Unsupported imports are never retried.** (p3) [feature] `imported_files` keeps `unsupported` with the file's size and mtime,
      so an unchanged file is skipped even after an FFmpeg upgrade could read it (animated WebP with FFmpeg 8). `backdrop import --retry`
      (or `rescan`) could clear those records, or the record could note the ffprobe version it was checked with.
- [x] **Import progress for large first runs.** (p3) [feature] The first scan hashes and copies everything; the daemon logs only a summary at the end. Log periodic progress, and show a running count in `backdrop import`.
      Done: the daemon logs the file total and progress every 30s; `backdrop import` shows a progress bar.
- [x] **Edit rating during playback.** (p2) [feature] `keep N` changes the effective current rating for imported items;
      prior ratings remain as undo history, and repeated ratings do not duplicate playlist entries or restart media already in the library.
- [x] **Concurrent imports can collide.** (p3) [bug] `backdrop import` and the daemon's startup import can scan the same folders at once; both may copy a file
      before either commits, so the second likely fails on the unique `sha256` and is recorded as `failed`. Take a lock file in the data dir for the duration of an import,
      and have the second importer wait or skip.
      Done (v2.33.2): since v2.2.0 a lost race was already recorded as a duplicate and its copy removed; what remained was the
      doubled hashing and copying and a used `local-<n>` number. `import.lock` beside the media directory (pid and start time,
      so a crashed holder is taken over) now runs one import at a time: `backdrop import` waits, the daemon skips.
- [ ] **Tag-based playlists and search.** (p2) [feature] `media_tags` (schema v7) is filled from file names, page slugs
      and descriptions, and lists filter with `--tag`. Since v2.17.0 `pending`, `download` and `next` also take `--tag`
      and `--query` (`src/library/match.js`), but `next` only jumps once. Next: show tag counts in `stats`, add a `tags`
      command listing them, and let the daemon or screensaver play a playlist built from tags (e.g. `backdrop mode video --tag ocean`).
- [x] **No shell completion for `--query` values.** (p3) [feature] `--query` must match a saved search exactly, so completing
      it from `searches` (a helper like the monitors one in `src/commands/CompletionCommand.js`, reading the database or a
      `backdrop queries` listing) would save typing and typos; `--tag` could complete from `media_tags` the same way.
      Done (v2.35.0): both scripts read saved queries (newest first) and tags (most used first) from the database with the
      `sqlite3` CLI, whose path is written into the script, falling back to the hidden `backdrop complete-values` without it.
- [x] **Frame rate unknown until a video plays.** (p3) [feature] Videos added before v7 get `fps` from mpv the first time
      they play. A `backdrop rescan` (ffprobe over existing files) would fill it at once and could also re-check sizes.
      Done: `backdrop rescan` fills missing frame rates; `--all` re-checks kind, size and duration of every file.
- [x] **ffprobe takes about 0.4s per file.** (p3) [perf] It decodes part of each file to fill in stream details, so `rescan` of
      204 videos took 74s at two cores (2026-10-28), and large imports pay the same. Probe several files at once in `rescan`
      and `Importer` (a small worker pool), or lower `-probesize`/`-analyzeduration` if the fields stay correct.
      Done (v2.33.1): most of the time is ffprobe starting up (about 0.15s of 0.19s on 2026-10-31), and lower probe sizes saved
      about 5%, so `rescan` and imports now hash and probe four files at once (two in the daemon) and still add them in path order.
- [ ] **Pre-calculate average brightness.** (p3) [feature] Measure each item's average brightness once and store it, so later
      features can react to how light the wallpaper is: automatic dim/opacity defaults for bright items (`background: auto` already works this out per load from `sampleMedia`, for one frame), and terminal
      (Alacritty) opacity that follows the wallpaper. Measure at import/download and in `backdrop rescan` (a schema v10
      `media.brightness` column, 0-1 luma): images from one downscaled decode, videos averaged over a few frames (ffmpeg
      `signalstats` YAVG, or the `sampleMedia` decode in `src/visualizer/palette.js` at several timestamps), since one frame
      misrepresents videos that change a lot. Open questions: whole-frame average vs the region under a window (palette's
      `stripPixels` already does regions); and how to drive the terminal: rewriting `picom.conf` opacity rules means a
      picom reload per change, while `alacritty msg config window.opacity=N` or setting `_NET_WM_WINDOW_OPACITY` (which picom
      honors) changes it live without touching the file.

## 7. Screensaver

- [x] **Screensaver mode.** (p2) [feature] An empty i3 workspace per output with the bars hidden and its own preset, ended by Escape or `$mod+Delete` through an i3 binding mode.
      Done in 2.50.0: `src/display/daemon/Screensaver.js`, `backdrop screensaver`.
- [x] **Rate wallpapers from the screensaver.** (p2) [feature] The i3 mode keeps `$mod+m`, `$mod+w` and `$mod+Shift+w`, and only asking ends the mode, so a rating cannot.
- [ ] **Idle trigger: try it for real.** (p2) [feature] Built and off by default (`screensaver.idle`, `idle_minutes`, `max_load`), tested only with fakes. It should also not start over a fullscreen window
      or a video call, and it ends only with Escape like the key does; decide whether input should end an idle start.
- [ ] **Polybar once came back in the screensaver.** (p2) [bug] A capture on 2026-11-05, about 27 s into a real entry at load 20, showed polybar on screen and no ring or bars, with the veil up.
      A later entry logging the stacking and polybar's map state every 0.5 s for 22 s stayed correct throughout, as did a run without the workspace switch, so polybar's return is unexplained. The missing ring and bars are probably silence: the music was playing on a phone, so nothing reached the desktop's sink, and the ring's thin circle is easy to miss under the veil.
- [ ] **Screensaver on two monitors.** (p2) [test] Only tried on one output. `enterWorkspaces` names the others `backdrop-<output>` and restores each, tested on i3 under Xvfb with one output and with fakes for two; real multi-monitor focus and restore are unseen.
- [ ] **Show the screensaver in `status`.** (p3) [feature] `state.json` has `screensaver`, but `backdrop status`, `--json` (`docs/specs/json.md`) and the docs do not mention it, so the only way to ask is `backdrop screensaver status`.
- [ ] **`doctor` does not know the screensaver's needs.** (p3) [feature] Nothing checks for the i3 `screensaver` mode (without it Escape cannot end the mode; `i3-msg -t get_binding_modes` tells), `polybar-msg`, `xprintidle` with `screensaver.idle` on, or `projectMSDL` with a preset using it.
- [ ] **Empty ring when the music is elsewhere.** (p3) [feature] With sound on a phone, sleeve follows Spotify but nothing reaches the desktop's sink, so the bars are empty and the ring is a bare circle. Hide it in silence with the bars, or leave it. Decided so far: leave it, no fake motion.
- [ ] **Hide the pointer in the screensaver.** (p3) [feature] Nothing hides it yet; `on_enter` could run `unclutter`, or backdrop could do it itself.
- [ ] **Follow the load levels.** (p2) [feature] Partly there: the screensaver's preset uses the daemon's visualizers, so they stop at `off` and projectM stops at `image`, and `max_load` holds back an idle start. Missing: skipping
      `screensaver.streams` once playlists exist, and deciding whether the empty workspace should stay up at `off`, when nothing is left to show. A `screensaver.load` override can wait until there is a need.
- [ ] **A mode hold survives a crash until the next start.** (p3) [bug] After a daemon crash during a load hold, `mode_hold` stays in the database, so `status` reports
      images with no daemon running until the next start clears it (`LoadShedding.begin`). Harmless, since nothing plays; tagging the hold with the daemon's pid
      like `next-filters.json` would make it exact.
- [ ] **The menu's mode button ignores a hold.** (p3) [bug] `MenuCommand` labels the button from the mode in force, so during a load hold it offers "switch to videos"
      even when video is already the choice, and pressing it only reports the hold. Label it from `getChosenMode` and show the hold.
- [ ] **Screensaver playlists.** (p2) [feature] `screensaver.sources` and `streams` are in the config and example but nothing reads them yet, so setting them does nothing. Sources: rated live wallpapers, separate video files, and YouTube links (mpv + yt-dlp). Configurable per playlist, shuffle, and per-item speed.
- [ ] **Coexist with locker and DPMS.** (p3) [feature] Decide interaction with the screen locker and monitor sleep, and inhibit during fullscreen apps or media playback.
      Decide with the idle screensaver above: on 2026-11-04 there is no locker or idle tool running here and DPMS is off, so there is nothing to coexist with yet.

## 8. CLI experience and packaging

- [x] **Consistent output styling.** (p2) [feature] Commands print plain `console.log` lines with ad hoc chalk in a few places (`index.js`, `DisplayCommand`, `ImportCommand`).
      Add one small output module (headings, key/value rows, success/warn/error colors, dim secondary text) and use it in every command.
      Respect `NO_COLOR` and non-TTY stdout so lists, `--playlist` and scripts get plain text; consider `--json` for `current`, `status` and lists.
      Done: `src/utils/output.js` on Node's own color detection (chalk removed), with `output.symbols` (auto/nerd/unicode/ascii).
      `--json` moved to the rofi item.
- [x] **Gradient progress bars for long tasks.** (p3) [feature] Import hashing/copying, downloads (bytes per file and items overall) and purge need live progress.
      `src/utils/ProgressBar.js` is unused legacy code and the `progress` dependency is unused; replace both with one TTY-only bar that draws a truecolor gradient
      (falling back to 256/16 colors), writes to stderr, and stays silent when not a TTY. Covers "Import progress for large first runs" in project 5.
      Done for import and download (with per-file bytes); colors from `output.progress_gradient`. Purge is fast enough without one.
- [x] **Show the version on every run.** (p3) [feature] Print `backdrop vX.Y.Z` as a dim first line on stderr for interactive runs only, so piped output and
      M3U exports stay clean; `--version` already exists. Skip it for `daemon` logs, where the version should go in the startup log entry instead.
- [x] **Show the new item after navigation, with a one-line view and random order.** (p2) [feature] `next`, `prev`, `skip`, `go-next`, `keep --next`
      and `mode` print what the target monitor now plays (`DisplayControl.switchTo` reads mpv's current playlist entry). `--line` prints one aligned
      line (tab-separated when piped, for fzf); `--random` / `display.order: random` move a random entry next. Bare `backdrop` runs `status`.
- [x] **Playlist repeated one order every pass.** (p2) [bug] `--loop-playlist=inf` replayed the startup shuffle forever. The daemon now reshuffles
      on wrap (`reshuffleOnWrap` in `src/display/Playlist.js`).
- [x] **Wrap detection uses positions from the previous load.** (p3) [bug] `reshuffleOnWrap` compares `playlist-pos` with the position at the
      previous file load. Removals, appends and random moves between loads shift positions, so a wrap can occasionally be missed or an extra
      reshuffle run. Both are harmless; tracking the playing entry's id (`playlist_entry_id` on `start-file`) would make it exact.
      Done: the daemon compares mpv entry ids, so removals, appends and random moves no longer affect it.
- [x] **Detailed, aligned stats.** (p2) [feature] `stats` shows sectioned tables with bars on a terminal:
      library per kind, rating distribution, resolutions, sources, top searches, recent activity, storage, per-monitor
      eligibility and quota (`DatabaseManager.getDetailedStats`, `formatTable` and `stackedBar` in `src/utils/output.js`).
- [x] **Stats walks the library directories on every run.** (p3) [perf] `directoryUsage` stats every file under media, inbox
      and trash; fine for thousands of files, slow on network mounts. Store file sizes at download/import and sum them in SQL.
      Won't fix (2026-10-28): 0.09s for 169 files (776 MB); stored sizes would need upkeep everywhere, drift from disk and miss files the database does not know about.
- [x] **No header row for `--line`.** (p3) [feature] Tables want column names; add `--header` (or print one on a terminal only) and document
      `fzf --header-lines=1`.
      Done: `--header` on `current`, `list-images` and `list-videos` (implies `--line`), aligned on a terminal and tab-separated when piped.
- [x] **A closed pipe crashes with a stack trace.** (p3) [bug] `backdrop stats | head -2` dies with an unhandled
      `EPIPE` from `console.log` in `write()` (`src/utils/output.js`) once `head` exits, printing a Node stack trace.
      Handle `error` on `process.stdout` (exit quietly on `EPIPE`) in `src/index.js`, with a CLI subprocess test.
      Done in 2.33.0: `ignoreClosedPipes()` (`src/utils/output.js`, called from `src/index.js`) marks stdout or stderr
      closed on `EPIPE` and `write()` drops later lines, so the command finishes its work (no stop between a file
      move and its database write) and exits with its usual code; other stream errors still throw.
- [x] **Docs and comments still describing older behavior.** (p3) [docs] `docs/specs/visualizer.md` lines 94, 135 and 138 say brightness where a dim is now contrast. "GLava draws nothing until every piped value has arrived" stays in `check.js`, `settings.js` and `VisualizerManager.js`, though a lost `fg2` was seen drawing a fade (2.48.1).
      Done, along with the screensaver settings in `docs/specs/config.md`.
- [ ] **Small cleanups.** (p3) [chore] `hex` is defined in both `palette.js` and `daemon/WallpaperColors.js`. `fs-extra` (11.3.0 to 11.4.1) and `winston` (3.17.0 to 3.19.0) have minor updates; `npm audit` is clean. `Daemon.js` (943 lines) and `VisualizerManager.js` (796) keep growing: sleeve's display and veil handling could move out of the manager as `daemon/` did.
- [x] **CI jobs can hang on apt with no limit.** (p2) [chore] On 2026-11-05 the latest-Node job of the 2.50.7 run sat over 20 minutes in `Install integration test tools` while its 22.13 twin passed, and a GitHub job's default limit is 6 hours. Set `timeout-minutes` on the job and the install step, and pass apt `-o Acquire::Retries=3`.
      Done: 15 minutes for the job, 5 for the install, apt retries, no recommended packages, and a stalled install skips the integration tests rather than failing the run.
- [ ] **Release binary.** (p3) [chore] Build a single executable with Node's SEA (bundle `src/` and dependencies with esbuild first; `node:sqlite` is built in),
      attach it to a GitHub release per `vX.Y.Z` tag, and document that mpv, xwinwrap, xrandr, xdotool and ffprobe are still external.
      Check that `package.json` version lookup and any runtime file reads work from inside the bundle.
- [x] **Rofi control menu.** (p2) [feature] `backdrop menu` (or a shipped script) opens rofi with the current item (name, rating, monitor) and actions:
      keep 1-3, skip, undo, next/prev, go-next, speed presets, mode toggle and monitor choice, then runs the matching command and shows errors via rofi or notify-send.
      Needs `--json` output for `current`, `status` and the lists (deferred here from the styling item); add an i3 keybinding example to `GETTING_STARTED.md`.
      Done: `backdrop menu` built into the CLI (no script, so `--json` was not needed); closes after an action, `--stay`
      keeps it open; errors go to critical notifications; `menu.rofi_args` for theming; i3 example in GETTING_STARTED.md.
- [x] **No `--json` output.** (p3) [feature] Scripts parse `--line` today. `current`, `status` and the lists could print JSON
      (the media row, rating, tags, playback cost, monitor) for status bars and custom menus; split from the rofi menu item.
      Done: `--json` on `status`, `current`, the lists and the navigation commands; curated item format in `docs/specs/json.md`; other output moves to stderr.
- [x] **Menu previews miss after a random next.** (p3) [perf] The daemon makes the preview of each item as it loads and of
      the next playlist entry (`prefetchThumbnails` in `src/display/Daemon.js`), but next is random by default and picks an
      arbitrary entry, so the redrawn menu still waits about 0.4s for ffmpeg. Fix: backfill thumbnails for every eligible
      item in the background (nice'd, a few per minute), or queue the random pick first and make its thumbnail before advancing.
      The random pick was also redundant (the playlist is already shuffled) and could replay an item shown earlier in the pass.
      Done in 2.40.0: `next`, `skip` and the advance after a rating without filters just advance through the shuffled
      playlist, so the prefetched next-entry preview hits; `queueRandom` is gone, and a random filtered pick takes only
      matches still ahead. Previews for filtered picks and `prev` can still miss; background backfill would cover them.
- [x] **Menu workspace stays on the first monitor after Tab.** (p3) [feature] `menu.workspace` empties the monitor the menu
      opened on; picking another with Tab leaves that one covered. `MenuCommand.open` could leave and re-enter the workspace
      (`src/utils/workspace.js`) on the new output when the target changes.
      Done: `MenuCommand.open` leaves and enters again when the monitor changes.
- [x] **Menu rendering is only checked by hand.** (p2) [test] Unit tests check the rofi arguments, not what rofi does with
      them: a status with quotes or line breaks inside a `-theme-str` string failed rofi's theme parser, and a horizontal
      info box that expanded hid the second row of buttons, with every test passing. Both were found by rendering into
      Xephyr and taking a screenshot. An integration test on a nested or virtual X server (Xvfb or Xephyr, skipped when
      missing, like the mpv one) should open the panel, check rofi reports no theme error, and send keys with `xdotool`
      to check the custom exit codes (10 + N).
      Done in 2.27.1: `test/commands/menu.integration.test.js` runs both views and the real main, step and monitor menus
      on Xvfb, requires an empty rofi stderr (a bad -theme-str prints "Failed to parse" and exits 65; a markup error is
      a Pango warning) and checks exit codes from xdotool keys. Reintroducing the raw line break in `rasiMarkup` fails
      it. Layout (the hidden second row) is not asserted; each menu's screenshot is kept when a test fails.
- [x] **Unused dependencies.** (p3) [chore] `pexels` and `progress` are no longer imported anywhere (the Pexels adapter uses axios); remove them, and `ProgressBar.js` with the progress-bar item. Done, along with chalk.
- [x] **Shell completions.** (p3) [feature] Generate zsh and bash completions for commands and options, completing `--monitor` from the running daemon's
      `state.json` and `mode` from video/image.
      Partly done: `backdrop completion zsh` (generated from the Commander definitions, `src/commands/CompletionCommand.js`). Bash remains.
      Done: `backdrop completion bash`, generated from the same definitions as zsh, without needing the bash-completion package.
- [x] **systemd user unit.** (p3) [feature] Ship a `backdrop.service` user unit (`backdrop daemon`, restart on failure, `graphical-session.target`) as an alternative
      to i3 `exec`, and document enabling it.
      Done: `backdrop systemd` prints a unit with the generating shell's PATH (node through `/usr/bin/env`), restart on failure and a start limit; i3 activation documented in GETTING_STARTED.md.
- [x] **The menu cannot open while the wallpaper is off.** (p2) [bug] `MenuCommand.describe` asks mpv for the playing item,
      which fails with "The wallpaper is off" since 2.21.0, and the menu closes. It should open with the item area showing
      "wallpaper off", a button for `start --wallpaper`, and the visualizer controls still usable. Raised to p2: since
      2.28.0 `backdrop menu visualizer` calls `describe` for its preview too, so the visualizer menu is unusable in
      exactly the audio-only setup (`stop --wallpaper`) where it matters most. `visualizerMenu` should fall back to no
      preview when nothing plays.
      Done in 2.32.1: `describe` checks the monitor's socket in the daemon's state first and does not ask mpv when it is
      null; the main menu keeps its grid with the mpv buttons faded and binds `w` to `start --wallpaper` (no free slot
      for a button); the visualizer menu opens without a preview. Checked live with the wallpaper off.
- [x] **Docs claim and omit a few things.** (p3) [docs] README's feature list includes the screensaver, which is not
      built (its intro and GETTING_STARTED say so). The prerequisites in README and GETTING_STARTED do not list what the
      visualizer needs: `glava`, a compositor (picom), and `pactl` for `only_while_playing`. `docs/specs/main.md` has no
      pointer to `docs/specs/visualizer.md`. Rechecked 2026-10-31: README's prerequisites now list `glava` and a
      compositor; still open: the screensaver bullet in README's feature list, `pactl`, and the main.md pointer.
      `backdrop doctor` (2.32.0) lists every optional tool with the feature that needs it, so the docs could point there.
      Done in 2.35.1: the screensaver bullet marked planned, `pactl` listed, GETTING_STARTED and README point to
      `backdrop doctor`, and main.md links `visualizer.md` and `json.md`.
- [x] **Notifications stack under deadd-notification-center.** (p3) [bug] `notify-send --replace-id` and the dunst stack tag
      replace the previous notification per monitor on dunst, but deadd returned a new id on 2026-10-28, so rapid `next`
      presses pile up. Check deadd's replace support, or close the previous id (gdbus `CloseNotification`) before sending.

## 9. Music visualizer

Backdrop places GLava above its wallpaper and below every window, on each monitor, and drives its options. GLava stays
the renderer, behind an adapter; the reasoning is in `docs/specs/visualizer.md`.

- [x] **Decide the visualizer engine.** (p2) [docs] GLava, behind an adapter: the only candidate with transparency, a
      desktop-layer window and click-through on X11 by itself. Frozen upstream (last commit 2021-06, no maintained
      fork as of 2026-10-30); the mpv lavfi fallback is recorded. Done in `docs/specs/visualizer.md` (2.20.0).
- [x] **Run GLava from the daemon.** (p2) [feature] `visualizer` config section; `VisualizerManager` runs one instance
      per monitor after its wallpaper, restarts it (five times a minute, then gives up until reload), follows hotplug
      and stops with the daemon. Done in 2.20.0.
- [x] **Keep GLava stacked above the wallpaper.** (p1) [bug] 2.20.0 relied on start order after misreading the stack
      (`xwininfo -children` lists top to bottom), which left GLava under the wallpaper. Done in 2.22.0: each instance is
      restacked directly above its wallpaper over an X connection (`src/display/x11.js`) after every start of either.
- [x] **Placement per monitor.** (p2) [feature] `placement` (anchor, width, height, margin) or `rect`, in pixels or
      percent, resolved per monitor and passed as `setgeometry`; per-monitor overrides under `monitors`. Done in 2.20.0.
- [x] **Visualizer options from backdrop.** (p2) [feature] Module choice, typed bars options, raw `defines` and
      `requests`, written into a generated config root (`XDG_CONFIG_HOME` pointed at the runtime dir). Done in 2.20.0.
- [x] **Typed options for the other modules.** (p3) [feature] graph, radial, circle and wave have typed options
      (`MODULE_OPTIONS` in `src/visualizer/settings.js`), written only when set; unknown options are rejected. Done in 2.24.0.
- [x] **Stacking is only checked by hand.** (p3) [test] Unit tests use a fake X connection; placement was verified live
      on picom and i3 on 2026-10-30. An integration test on Xephyr or Xvfb (skipped without them, glava or a GL
      context) should start the daemon with the visualizer and check the order of the root's children, also after
      killing mpv and after `stop/start --wallpaper`.
      Done in 2.29.1: `test/display/stacking.integration.test.js` runs a real daemon (xwinwrap, mpv) on Xvfb with a
      stand-in visualizer window (`test/fixtures/standin-visualizer.mjs`) that lowers itself after mapping as GLava
      does, since GLava opens no window under Xvfb; GLava's own stacking is not covered. Disabling the restack in
      `place()` fails the start case; the mpv-restart and wallpaper on/off cases pass either way (a new xwinwrap
      lowers itself below the visualizer), so they guard the restart paths and the visualizer surviving
      `stop --wallpaper`, not the restack itself.
- [x] **Apply more config sections live.** (p2) [feature] The config watcher (2.23.0) applies only the `visualizer`
      section. Extend `Daemon.applyConfigChange` to the display keys the daemon reads per item (`order`, `image_duration`,
      `video_duration`, `notify`, `allow_upscale`) by taking them into the running config, and `display.monitors` by
      running `reconcileMonitors`. Keys a running mpv cannot take (`mpv_args`, `xwinwrap_args`) and `paths` should log
      and notify "restart the daemon to apply" instead. Validate each section first, as the visualizer one is.
      Done in 2.31.0: `applyConfigChange` loads and checks the whole file (`readConfig`), then applies by kind
      (`LIVE_SETTINGS` in `src/display/Daemon.js`), also `library.min_width/min_height`, `import_dirs`, `trash_days` and
      `default_import_rating`. Checked live: `image_duration: 4m` applied as 240 s, an `mpv_args` change notified.
      Reloading a playlist for an eligibility change restarts the item on screen.
- [x] **Live value channel into GLava (--pipe).** (p2) [feature] Foundation for every color item below. Start each instance
      with `--pipe=fg:vec4 --pipe=bg:vec4` (and more bindings as needed) and keep its stdin open in `VisualizerManager`;
      writing `fg = #rrggbbaa\n` changes the color without a restart. The typed color options already emit `@fg:`/`@bg:`
      defaults (`gradientColor` in `src/visualizer/settings.js`); gradients need two bindings (`fg`, `fg2`) since a pipe
      value is one vec4. Expose `setColors(name, { fg, fg2, bg })` on the manager, and resend the current values after
      a restart. Check GLava 1.6.3 reads stdin with `setopacity "native"` and keeps reading after the first value.
      Checked 2026-10-31 (GLava 1.6.3-93, picom, a FIFO sine wave, `--pipe=fg:vec4`): `fg = #rrggbbaa` lines change
      the bars live and keep working seconds later. With `--pipe` GLava draws nothing until the first value
      arrives (the `@fg:` default is ignored; the same instance without `--pipe` draws at once), so the manager must
      write the colors right after each spawn. GLava does not open a window under Xvfb (it loops on X requests before
      reading its config), so this was checked on the real display with an on-top test window.
      Done in 2.27.0, bound only with `palette.source: wallpaper`. GLava also takes one line per read and drops
      the rest of what arrived together, so lines go out 100 ms apart, and reads a `@name:` default up to
      whitespace, so the gradient is written `mix(@fg:A , @fg2:B , ...)`.
- [x] **Colors from the wallpaper.** (p2) [feature] On each load, take the dominant colors of the item (from the menu
      thumbnail the daemon already makes, e.g. `ffmpeg -vf palettegen=max_colors=8` or a k-means over a downscaled
      frame) and send the visualizer a palette over the pipe: `visualizer.colors: wallpaper | fixed`, with a rule for
      which color to use (dominant, most saturated, complementary). Sample only the strip under the visualizer's
      placement and enforce a minimum contrast against it, so the bars never vanish into the image they cover
      (the problem behind the faint-bars issue of 2.21.0). Cache the palette per media id in the database.
      Done in 2.27.0 as `visualizer.palette` (`source`, `pick`, `min_contrast`), sampling the media file rather than
      the menu thumbnail (a middle crop that misses the bottom strip). Not cached: one ~0.2-0.5 s decode per load at
      the lowest CPU priority. Saturation is capped by chroma when lightening, and a near-black or near-white way out
      loses to the other, both found on library items.
      Checked live on 2026-10-31: the restarted daemon took colors from video #1017 1.7 s after start (3.22:1 and
      3.01:1 against a mid-grey strip) and recolored on `backdrop next`.
- [ ] **Animated color transitions.** (p3) [feature] With the pipe channel, fade from the old palette to the new one over
      `visualizer.transition` seconds on a wallpaper change, instead of jumping. GLava takes one stdin line per read and
      drops the rest of what arrived together (found in 2.27.0), so the manager writes a line per 100 ms: a fade gets
      about 10 steps a second, 5 with a gradient (`fg` and `fg2`), not the 30 Hz first planned. Check whether a shorter
      gap holds up (GLava reads once per frame) before designing the steps.
      The same loop gives slow effects: hue drift ("rainbow"), time-of-day palettes (warm evening, cool night), or a
      short brightness pulse on a track change.
- [ ] **Colors from the album art.** (p3) [feature] Take the palette from the now-playing cover instead of the wallpaper
      (`visualizer.colors: album`): read `mpris:artUrl` through `playerctl metadata` on track change (Spotify, mpd
      via mpDris2, browsers), extract the dominant colors as for wallpapers, send them over the pipe. Fall back to
      the wallpaper palette when no art is available.
- [x] **Several visualizers at once.** (p2) [feature] Allow a list of instances, each with its own module, placement,
      monitors, opacity and options: `visualizer.instances: [{ name: base, module: bars, placement: {anchor: bottom} },
      { name: ring, module: radial, placement: {anchor: center, width: 600, height: 600} }]`, the current single-section
      form staying as shorthand for one instance. `VisualizerManager` keys entries by monitor and instance name; each
      gets its own config root (module settings differ per instance) and window title, and is placed above the
      wallpaper in list order. `status` and `--json` list them per monitor.
      Done in 2.25.0: `visualizer.instances`, section keys as defaults, stacked in list order.
- [x] **Presets.** (p2) [feature] Named visualizer looks under `visualizer.presets` (module, options, colors, placement,
      opacity), applied with `backdrop visualizer preset <name>` (live, like the other control requests, until a
      daemon restart), `visualizer.preset: <name>` as the default, and `backdrop visualizer preset --next` to cycle.
      Ship a few built-in ones (subtle bottom bars, centered radial, full-screen wave) users can copy. Later: a preset
      per mode (video/image), per tag or query, or remembered per media item like speed and dim.
      Done in 2.25.0: `visualizer.presets`, built-ins in `src/visualizer/presets.js`, `backdrop visualizer preset`. Per mode, tag or item still open.
- [x] **Visualizer rofi menu.** (p2) [feature] A second menu (`backdrop menu visualizer`, or a key from the main menu)
      in the same panel style: on/off, preset picker, module picker, opacity and amplify steps, anchor picker, color
      source (fixed, wallpaper, album) and a few color swatches. Changes apply live through control requests and
      last until the daemon restarts; a "save" button writes the current look into the config as a preset.
      Needs the control channel to grow past signals (see "CLI and menu controls").
      Done in 2.28.0: `backdrop menu visualizer` and `z`; changes as `visualizer_set` control requests (control.json
      already carried JSON, so no new channel was needed), kept per instance until restart, `reset`, and `save` into
      `visualizer.presets` by a line splice that keeps the config's comments. Color source "album" left out (no such
      source yet). Every change restarts the instance (GLava reads its settings at start), about a second.
- [x] **Show the visualizer only while audio plays.** (p3) [feature] Stop or hide instances when the audio source is
      idle (PulseAudio/PipeWire sink not RUNNING, via `pactl subscribe`) and bring them back when sound starts, with
      a short grace period. Saves GPU on a silent desktop and removes the flat line of an idle module.
      Done in 2.25.0: `only_while_playing` and `silence_grace` (`src/visualizer/audio.js`).
- [x] **Dim the wallpaper while music plays.** (p3) [feature] Optionally lower the wallpaper's brightness by
      `visualizer.wallpaper_dim` while the visualizer has audio, and restore the item's own dim when it stops, so
      the bars stand out without changing their colors. Reuses the per-item dim path in the daemon.
      Done in 2.38.0: a floor over the item's dim while the visualizer is on and has sound (the audio watcher now runs
      for either setting), restored from the database after; `backdrop dim` reads `musicDim` from the state. Instant:
      mpv's `brightness` has no fade.
- [x] **Visualizer as the screensaver.** (p3) [feature] Let a screensaver playlist be a visualizer preset: a full-screen
      instance (e.g. radial or wave, `placement: {anchor: fill}`) over a dimmed or black wallpaper when idle, ties in
      with project 7.
      Done differently: `screensaver.preset` picks any preset, with `screensaver` and `screensaver-projectm` built in.
- [x] **CLI and menu controls.** (p3) [feature] `backdrop visualizer reload` (SIGHUP), `start/stop --wallpaper/--visualizer`
      and `backdrop visualizer preset` (control requests) exist, and presets cover switching modules. The visualizer menu
      (2.28.0) has on/off and preset buttons; a menu button for the wallpaper part is left. More requests would outgrow the signal-per-action
      scheme and its single `control.json` (see "Control requests can be lost"); a control socket in the runtime dir
      is the next step.
      Done in 2.36.0: a wallpaper on/off button (`w`) in the visualizer menu, faded while the visualizer is off (both
      off stops the daemon). The control socket moved to "Control requests can be lost".
- [x] **`backdrop visualizer check`.** (p3) [feature] A mistake in raw `defines`, or a GLava version whose shaders differ,
      only shows as GLava exiting with code 1 and no message, then being given up on after five restarts. Start each
      instance of the section and of every preset at 1x1 for two seconds, as was done by hand on 2026-10-30, and report
      which ones exit, before they reach the screen. Run it from `visualizer reload` with `--check`.
      Done in 2.29.0 (`src/visualizer/check.js`): all at once, each target against only its own preset, with GLava's
      output (which does name a bad define: "Shader compilation failed ... syntax error"). Checked live on the real
      display: a broken preset fails alone with exit 1, and `reload --check` refuses.
- [x] **Warn when no compositor runs.** (p3) [feature] The visualizer needs one for its transparency; without it the area
      around the bars is solid black over the wallpaper. Check for an owner of the `_NET_WM_CM_S<screen>` selection
      (GetSelectionOwner over the existing X connection) when the visualizer starts, log a warning, and show it in
      `status`.
      Done in 2.29.0: checked on every placement (picom often starts after the daemon), logged on change, `compositor`
      in the visualizer summary, a `status` line and `daemon.compositor` in `status --json`.
- [x] **Every visualizer menu change restarts GLava.** (p3) [perf] Opacity, amplify, module and the rest go through
      `setLive` and `reload()`, so each step in the menu blanks the visualizer for about a second. Opacity is a window
      property (`X11.setOpacity`) and colors already change over the pipe; apply those two without a restart and keep the
      restart for settings GLava reads at start.
      Done in 2.37.0: opacity and the wallpaper pick (`palette.pick`, `min_contrast`) apply to running instances, from
      the menu and from a saved config file (`VisualizerManager.refresh`); everything else still restarts.
- [x] **Fixed visualizer colors restart GLava.** (p3) [perf] A swatch or a `colors` change compiles into a `#define`,
      so it restarts the instance. Piping colors for fixed palettes too (`--pipe` always on, values from the config)
      would make them live, at the cost of GLava drawing nothing until the first piped values arrive at every start.
- [x] **Wallpaper colors do not follow `backdrop dim`.** (p3) [bug] The contrast check uses the item's dim from when it
      loaded (`sampleMedia` stores it); `backdrop dim` on the playing item changes the brightness without a recolor, so
      the picks can lose contrast until the next load. Recolor when the daemon sees a dim change (DisplayControl sets it
      over mpv directly, so the daemon would need a control request or to observe mpv's `brightness`).
      Done in 2.38.0: the daemon observes mpv's `brightness`, recolors on a change, and checks contrast against it.
- [ ] **Fade the music dim.** (p3) [feature] `wallpaper_dim` switches mpv's `contrast` in one step when music starts or
      stops; stepping it over half a second or so would look smoother (mpv has no fade for it).
- [x] **The stacking test's later cases do not exercise the restack.** (p3) [test] In
      `test/display/stacking.integration.test.js` the mpv-restart and wallpaper off/on cases pass even with the restack
      disabled, because a new xwinwrap lowers itself below the visualizer. Have the stand-in lower itself again whenever a
      window maps (watch the root's SubstructureNotify), as GLava might, so those cases need `place()` too.
      Done: the stand-in lowers itself whenever any window maps.
- [x] **Stack other programs' overlay windows.** (p2) [feature] sleeve's lyrics overlay needs a place above or
      below the visualizer, and the wallpaper's colors behind it. Done in 2.41.0: `_BACKDROP_OVERLAY` marks
      (`below`/`above`), `backdrop restack`, overlays and their colors in `state.json` and `status`.
- [x] **The stacking overlay test is flaky under load.** (p3) [test] "stacks marked overlays below and above the
      visualizer on a restack request, and follows a change of mark" in `test/display/stacking.integration.test.js`
      failed once in a full `npm run test:brief` on 2026-11-02 (stacking order assertion) and passed on three runs alone;
      likely the restack is read before the X server applied it. Wait for the expected order with a deadline instead.
      Measured 2026-11-04 at a load around 10: it fails 3 runs of 12 alone on v2.43.0. Not a read too soon after all: `state.json` listed overlays as they happened to map, not bottom to top as
      documented, so the test was right. Fixed in `findOverlays`.
- [ ] **Tune the auto veil on real wallpapers.** (p2) [test] `veilBackground`'s limits (0.45 to 0.75, mean luma 0.3) were set from one wallpaper and a contact sheet at the old 0.3 floor, not seen since. Check lyrics contrast on bright and busy ones, and whether it should weigh the lyrics area over the whole window.
- [x] **The visualizer menu offers GLava's controls for projectM.** (p3) [bug] `MenuCommand` tests `look.engine === 'sleeve'` and otherwise shows module, amplify and colors, so a `projectm` instance gets controls that do nothing or fail. It needs its own branch, with `fps` and `preset_duration`.
      Done (2.60.0): `instanceLook` gives projectM its `fps` and `preset_duration`, and the menu and the Visualizer page show those instead of module, amplify and colors.
- [ ] **projectM has not run through backdrop on the real desktop.** (p2) [test] The window was tried alone under Xvfb. Unseen: placing and stacking in `screensaver-projectm`, what it costs on the GPU, and whether `PULSE_SOURCE=@DEFAULT_MONITOR@` hears the music rather than a microphone.
- [ ] **`reference_height` covers only bars, radial and circle.** (p3) [feature] `SCALED_DEFINES` leaves wave and graph in pixels, so they do not follow the monitor, and a shader default left unset (radial's gradient of 95) stays in pixels too.
- [ ] **Presets repeat the veil layout.** (p3) [refactor] `lyrics-veil` and `screensaver` are the same instances, written out twice with the ring's numbers, so tuning one leaves the other behind; `lyrics-stage` shares the rects. Build them from one constant.
- [ ] **A long-lived X connection for stacking.** (p3) [refactor] backdrop opens a connection per placement and learns
      of overlays only from `backdrop restack`. One connection watching the root's SubstructureNotify and
      PropertyNotify (`_BACKDROP_OVERLAY`) would find overlays and their mark changes by itself, replace the 500ms
      settle recheck with GLava's own map and restack events, and drop `xdotool search`. It needs reconnecting when
      X restarts and a filter for the event volume; worth it if more overlay programs appear or the settle
      recheck proves flaky.
      Deferred 2026-11-04: neither has happened (the overlay test's flake turned out to be the order in `state.json`, not the recheck). Kept deferred 2026-11-05: still neither, and GLava cannot run under Xvfb, so the risky parts could only be tested on the real desktop.
- [x] **The rofi panel test is flaky under load.** (p3) [test] `test/commands/menu.integration.test.js` "panel view
      parses the theme strings and returns a bound key" failed once in a full run on 2026-11-02 with "rofi did not
      open a window", then passed in a full rerun and 3 of 3 runs alone. Likely a fixed wait for rofi's window;
      wait on the window with a longer deadline instead.
      Done with the item above, which is the same wait.
- [x] **Overlay marks inside a window manager's frame are untested.** (p3) [test] `X11.overlays()` also looks at the
      direct children of top-level windows, for a managed window in a frame; the integration test only covers
      unmanaged windows. Add a case under a nested window manager, or a unit test with a fake tree.
      Done: a unit test with a fake tree, `test/display/x11.test.js`.
- [ ] **A second engine for when GLava breaks.** (p3) [feature] GLava has had no commits since 2021; a Mesa or distro
      change could stop it for good. The adapter seam allows another engine: mpv's lavfi visualizers (`showcqt`,
      `showfreqs`, `avectorscope`) reading the PulseAudio monitor, in an `xwinwrap -argb` window with a colorkey for
      transparency, reusing the daemon's mpv machinery. Few styles, but nothing to lose if GLava goes. `engine: projectm` (2.50.0) is a stopgap for the look but not for bars: it is opaque and far costlier.
- [x] **Retire the old GLava setup.** (p3) [chore] The i3 `exec glava` is gone, the `glava.*` aliases were removed in
      `~/.shell` 0.23.1 and `~/.config/glava` was deleted (2026-10-30; still in the dotbare history).

### sleeve as an engine

Contract: `docs/specs/sleeve.md`, agreed 2026-11-04 with sleeve 0.33.0, which already does its side (tried by hand on a real
desktop). Built in 2026-11-04 apart from the desktop check; tried against real sleeve under Xvfb.

- [x] **Sleeve as the wallpaper layer.** (p2) [feature] sleeve's side shipped in 0.36.0; the contract is "The wallpaper layer" in
      `docs/specs/sleeve.md`. Here: typed `visualizer.sleeve` `lyrics_area`, `now_area`, `background` and `map_below`, passed at start, the first
      three also over `sleeve ctl display` (`look` in `SleeveVisualizer.js`); `--map-below` for a whole-monitor instance; a check of `sleeve --version`,
      reporting an older sleeve rather than exiting 2 on an unknown option; and colors sampled under the lyrics area rather than the whole
      window. Stacking sleeve with no mpv wallpaper already works here (`place`), since it does not lower itself.
- [x] **Hiding keeps a background.** (p3) [bug] Since sleeve 0.35.0 `--hide` hides the lyrics and the panel only. `only_while_playing` with a `cover`
      instance therefore leaves it moving, and costing up to 8%: decide whether silence should also take away the background for those, or stop them.
      Decided 2026-11-04: it stays, since on an opaque window that background is the wallpaper. The user can still choose `transparent`.
- [x] **Choose the engine per instance.** (p2) [feature] `engine` is section-wide (`SHARED_KEYS` and `settings.js`), so bars
      and lyrics cannot run together. Make it an instance setting, inherited from the section as the others are; keep
      `engine` at the top meaning every instance. Checks that assume GLava (`glava`, `audio`, modules, `defines`) must only
      apply to GLava instances.
- [x] **`SleeveVisualizer` adapter.** (p2) [feature] `src/visualizer/`, offering `prepare()` (nothing to prepare) and
      `command(monitor, geometry)` with the contract's options, its window title as for GLava and `--instance` from the
      monitor and instance names. Typed settings under `visualizer.sleeve` (`now`, `now_position`, `lyrics_align`,
      `no_sandbox`, `command`), checked in `settings.js`.
- [x] **Colors to a sleeve instance.** (p2) [feature] `VisualizerManager` writes `fg = #rrggbbaa` lines; sleeve takes
      `{ background, main }` JSON lines instead (the shape overlays get in `state.json`). Send them whenever the strip under
      it is sampled, without GLava's one-line-per-100-ms pacing.
- [x] **Live changes without a restart.** (p2) [feature] Add the sleeve settings to what `applyLive` can take: run `sleeve ctl
      display` rather than restarting (a start takes about 2 s), and send them again when the daemon starts, since sleeved
      forgets them when it restarts. `startSettings` should treat only what `sleeve ctl` cannot change as needing a restart.
- [x] **Hide rather than stop for silence.** (p2) [feature] `only_while_playing` stops instances; for sleeve it should run
      `sleeve ctl display --hide` and `--show`.
- [x] **Menu, presets and doctor.** (p3) [feature] `backdrop menu visualizer` for preset, position and alignment; a built-in
      preset with lyrics above the bars; `visualizer check` for the new engine; `doctor` noting a missing `sleeve`, an
      uninstalled shell, the AppArmor block (status 2), and a `sleeve-shell.service` running at the same time, which would
      draw the lyrics twice.
- [x] **The load section cannot see GPU cost.** (p3) [perf] Load averages count no GPU time, and sleeve's own figures (`docs/specs/sleeve.md`, Cost) put a cover background at up to 16% of the
      render engine: the `image` level leaves it animating and the `off` level is the only one that lightens it. `gpu.js` already reads memory per mpv; a threshold on render-engine busy time, or
      dropping sleeve's cover to a still or see-through background at the `image` level, would cover it. Worth doing if a moving cover becomes the usual setup.
      Done 2026-11-04 by dropping to a dark color at `image`. A real threshold on render-engine time, from each client's `drm-engine-render` in fdinfo, waits until this proves too blunt.
- [x] **Bars wait for a slow lyrics window.** (p3) [perf] `place` finds a monitor's windows one at a time before stacking any, so GLava stays under the wallpaper until sleeve's window
      exists: about 2 s idle, but 12 s measured at a load of 15 under Xvfb. Stack what is found, then again as the rest appear.
- [x] **sleeved restarting forgets live changes.** (p3) [bug] `sleeve ctl display` changes last until sleeved restarts: a page then goes back to its start options, and a hidden one shows again.
      The contract asks backdrop to send them again when it starts, which it does, but it cannot tell when sleeved alone restarts. `sleeve line` survives restarts over the socket, so watching
      that socket is one way, and the contract now backs it ("Changing a running instance"): every connection starts with `hello`, so a new one means a sleeved that forgot. A daemon
      restart or `visualizer reload` puts it right meanwhile.
- [x] **Drop the resize of sleeve's window.** (p3) [cleanup] sleeve 0.39.2 sizes a monitor-sized window exactly (1920x1080 on the real desktop), so `resizes` in `SleeveVisualizer.js` and its `xdotool windowsize` in
      `VisualizerManager.js` are no longer needed there. `atLeast` compares only major and minor, so it cannot tell 0.39.1 from 0.39.2: drop the workaround outright, raising "Requires sleeve" in `docs/specs/sleeve.md`, or compare the patch too.
      Done: dropped outright, with 0.39.2 noted in `docs/specs/sleeve.md`.
- [ ] **Try it on the real desktop.** (p2) [test] Veil, lyrics, ring and bars have now been seen together on the laptop panel (2026-11-05): stacking order, polybar hidden, ring scale and the veil's color.
      Still unseen there: colors following the wallpaper over several wallpapers, a wallpaper restart under sleeve, `lyrics-stage` and `lyrics-now` (the opaque layouts, whose seam 0.39.2 should have removed), and all of it with audio on the desktop's sink, since the music was on a phone.

## 10. Web interface

A local HTML interface for what the CLI and the rofi menu do now: the library, what each monitor plays, visualizer
presets and the config. It talks to the running daemon the way the CLI does (`DisplayControl`, control requests,
`ConfigManager.setInFile`), so it adds a front end rather than a second control path.

- [x] **Design the web interface.** (p2) [docs] Write `docs/specs/web.md` before any code: a `backdrop web` command serving on 127.0.0.1 only, the server (`node:http` with no framework, or a small one such as fastify),
      the front end (plain HTML with a little vanilla JS or htmx, versus a bundled SPA, which the project has no build step for), live updates (server-sent events from `state.json` changes), and
      authentication (a random token in the URL or a cookie, since any local program can reach a localhost port). List which commands it covers in its first version.
      Done: `docs/specs/web.md`. Its own `backdrop web` process on `node:http`, vanilla JS with no build, server-sent events, a token with Host and Origin checks, port 7737 with a free-port fallback; no autostart, video previews or `remove` in the first version.
- [x] **Move command logic into services.** (p2) [refactor] The first step of the web interface (`docs/specs/web.md`, D6): rating (rate, skip, undo, advance) and display (playing item, mode, durations,
      parts on and off) move into `src/services/`, returning data; `RatingCommand`, `DisplayCommand` and `MenuCommand` call them and print. No behavior change: the existing tests pass unchanged.
      Done: `RatingService` and `DisplayService`; the commands print their results and the menu calls them directly. The existing tests passed unchanged, plus service tests of the returned data.
- [ ] **The menu drops playlist warnings.** (p3) [bug] A rating from the menu whose playlist update fails returns the warning (`RatingService` `warnings`), which the menu discards, as it discarded the printed one before. Show it with `notifyError`, as the menu does for errors (`MenuCommand.attempt`).
- [x] **Now playing and monitor controls.** (p2) [feature] Per monitor: the playing item with its thumbnail (`paths.thumbnails`), next/prev, mode, wallpaper and visualizer on/off, keep 1-3/skip/undo,
      speed, dim and bounce, and the image and video durations, through `DisplayControl` and `RatingCommand` as the menu does (`src/commands/MenuCommand.js`).
      Done: `backdrop web` (2.54.0), with live updates; seen working against the daemon on 2026-11-07. Not yet: next's filters from the page, which come with the library browser.
- [x] **The durations' Reset also drops next's filters.** (p3) [feature] `POST /api/durations { clear: true }` is `next --clear`, the only way `nextFilters.js` drops stored durations, so it clears `--query`/`--tag` too.
      Add a way to drop only the durations (`resolveNextFilters` with a `clearDurations` option), and use it from the page.
      Done (2.60.0): `resolveNextFilters` takes `clearDurations`, and the page's Reset sends `{ reset: true }`; `{ clear: true }` still does what `next --clear` does.
- [x] **`status` and `doctor` do not know about `backdrop web`.** (p3) [feature] `web.json` records the running server, as the spec intends for them; `status` could print its address (without the token unless asked) and `doctor` find a stale `web.json` whose process is gone.
      Done (2.59.0): `status` shows the address without the token, and `status --json` has `web`; `doctor` is left alone, since a stale `web.json` is ignored and replaced by the next `backdrop web` (`src/web/info.js`).
- [x] **Library browser.** (p2) [feature] A grid of thumbnails with the list commands' filters (kind, status, rating, `--query`/`--tag`/`--keywords` through `src/library/match.js`), each item's details as in `docs/specs/json.md`,
      rating and per-item speed/dim/bounce, and "play next" (`queueMatching`). Thumbnails for items never played need making on demand (`thumbnailFor`), which is slow for a large page: page it.
      Done (2.55.0): the Library page, 48 items a page, thumbnails made two at a time as they come into view, a dialog to rate, adjust and play an item on a monitor, and "play next matching" with the page's filters.
- [x] **The library sorts only by id and size.** (p3) [feature] `LibraryService.list` sorts newest, oldest or largest in JavaScript after `findMedia`; sorting by rating, playback cost or last played needs those in the query (`findMedia` has no ORDER BY options or OFFSET), which also stops loading every match for each page once the library grows past a few thousand items.
      Done (2.60.0): `findMedia` takes `order` (`MEDIA_ORDERS`: newest, oldest, largest, rating, played, cost) and `offset`, and `countMedia` counts, so a page reads only its rows; the page offers the new orders.
- [x] **Visualizer presets editor.** (p2) [feature] The built-in and config presets (`src/visualizer/presets.js`, `presetsOf`), each instance's look with live changes (`visualizer_set` control requests),
      reset, and save as a preset (`ConfigManager.setInFile`, which keeps comments), covering what the visualizer menu does plus the settings it has no room for.
      Done (2.56.0): the Visualizer page, on `VisualizerService`, which the menu now shares: on/off, preset, reset, save as preset (409 and a confirm for an existing name), and per instance module or sleeve's now/panel/lyrics, amplify, opacity, position and colors with color pickers and swatches.
- [x] **Presets cannot be deleted or renamed.** (p3) [feature] Neither the menu nor the Visualizer page can drop a saved preset; it takes an edit of the file. `ConfigManager.removeInFile` (2.58.0) can now remove the key: add a delete on the page and the menu (with a confirm, refusing the active preset or a built-in one).
      Done for deleting (2.60.0): `VisualizerService.deletePreset` (refusing built-in presets and the one in use), a Delete on the page and `x` in the menu's preset list. Renaming is still a save under the new name and a delete.
- [x] **The Visualizer page edits only the menu's settings.** (p3) [feature] Settings such as `placement.size`/`margin`, `palette.min_contrast`, the radial and circle shapes or sleeve's `veil` have no control yet; a generic field per instance key (from `INSTANCE_KEYS` and each module's options) would cover them without a hand-made control each.
      Done (2.60.0): each instance has an Advanced box taking any change as YAML, checked like the controls (`changeYaml`), with its settings now shown beside it.
- [x] **Config editor.** (p3) [feature] Forms for the display, library, load and screensaver sections, checked with `validateConfig` (`src/config/schema.js`) before `setInFile` writes them; the daemon's config watch applies them,
      and settings that need a restart (`LIVE_SETTINGS` in `daemon/ConfigChanges.js`) are marked as such.
      Done (2.58.0): the Config page on `ConfigService`, every setting but the visualizer's with its control from the checks' info, default, "set in the file" and when it applies; saved together, checked with the whole config; Reset removes the key (`removeInFile`); the API key is write-only.
- [x] **The Config page edits only the settings the checks know.** (p3) [feature] `screensaver.streams` (a list of mappings) shows read-only, and sources other than Pexels or keys the checks lack are not listed. A YAML field for such values, checked by parsing, would cover them.
      Done for lists of mappings (2.60.0): `screensaver.streams` is edited as YAML, parsed by the server. Sources other than Pexels are still not listed; none has an adapter yet.
- [x] **Stats and status pages.** (p3) [feature] What `status`, `stats` and `doctor` print: playback cost by kind and decoder, load level, screensaver, and the bounce cache once it reports its size.
      Done (2.59.0): the Status page, from `StatsService` (which also gives `stats --json`), `DoctorCommand.check()` on request, and the snapshot's daemon, load and screensaver state.
- [x] **Run it as a service.** (p3) [chore] A `systemd` user unit for `backdrop web` (`SystemdCommand`), or the daemon serving it itself behind a config switch; decide in the design.
      Done (2.59.0): `backdrop systemd --web` prints `backdrop-web.service`; `backdrop web --open` opens the running server's page.
- [x] **Tests for the web interface.** (p3) [test] Request handlers driven with the fakes the command tests use (`test/helpers/fakes.js`), so routine runs stay offline, and one optional browser test skipped
      when no headless browser is installed, like the rofi and Xvfb integration tests.
      Done: route tests (`test/web/server.test.js`) and `test/web/pages.browser.test.js`, every page in headless Chrome through `playwright-core` (2.60.0), skipped without a browser.

## Completed

### 1. Existing bugs and tech debt (completed 2026-11-05)

- [x] **CLI crashes on startup: ImportCommand.js is empty.** (p1) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); rewritten in project 5. `src/commands/ImportCommand.js` is 0 bytes, but `src/index.js` imports `{ ImportCommand }` from it.
      ES module linking fails, so every command dies, not just `import`. The 1.1.0 changelog describes
      an implemented import command, so the file was likely lost; rewrite it (see project 5) or recover it.
- [x] **addVideo/addImage insert into renamed tables.** (p1) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); tables replaced by the new schema in project 2. `src/database/DatabaseManager.js:139,166` still use `INSERT INTO videos` / `INSERT INTO images`.
      The tables were renamed to `pexel_videos` / `pexel_images` in 1.1.1, so every new search result fails to save.
      `addVideo` also lists a removed `ratings` column (13 columns, 12 values). Fix the SQL and add tests that insert.
- [x] **undo leaves the rating in the database.** (p2) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); rating commands reworked in project 3; the new undo must delete the rating row. `src/commands/RatingCommand.js:119-122` moves the file back but only comments that the rating should be removed.
      Stats and `--rated` lists stay wrong after undo. Add `DatabaseManager.removeRating()` and call it.
- [x] **Filename-to-id parsing breaks on dotted names.** (p2) [bug] Won't fix: superseded by the redesign (option 2, decided 2026-10-21); the current file comes from mpv in project 3, so filename parsing goes away. `src/commands/HookCommand.js:89` uses `basename.split('.')[0]`.
      A file like `ocean.waves.4k.mp4` resolves to `ocean`. Use `path.parse(name).name`.
- [x] **Hard-coded CLI version.** (p3) [bug] `src/index.js` passes `.version('1.0.0')` while `package.json` is 1.1.1. Now read from `package.json`.
- [x] **Startup requires every hook and the API key for all commands.** (p2) [refactor] `validateConfig()` in `src/index.js` exited if any hook or `api_key` was missing, even for `list` or `stats`.
      Removed with the hooks; ported commands must check the credentials they need (e.g. the Pexels source checks its own key).
- [x] **No tests for commands.** (p2) [test] Search, download, rating, import, removal, lists and stats have command tests;
      CLI subprocess tests cover registration, offline operation and failing exit codes. Real mpv tests cover rating and playback transitions.
- [x] **Changelog lives in docs/specs.** (p3) [docs] `docs/specs/changelog.md` duplicates the new root `CHANGELOG.md` and embeds prompts. Removed; the root `CHANGELOG.md` already summarizes 1.0.0 to 1.1.1.
- [x] **No version tags.** (p3) [chore] Releases 1.0.0 to 1.1.1 exist only in docs; every release from v2.0.0 on has an annotated `vX.Y.Z` tag.
- [x] **Stale .claude/preferences.json.** (p3) [chore] Untracked generated file still names `pexels-cli` and describes jest/eslint/prettier setups the repo does not use.
      Agents may read it as project guidance that contradicts `AGENTS.md`. Deleted and added to `.gitignore` in case the tool regenerates it.
- [x] **GETTING_STARTED.md describes one machine.** (p3) [docs] It records a 2026-10-23 check of this machine's tools and test count, which goes stale and means nothing on another checkout.
      Replaced with a prerequisites list and a `command -v` check; limitations updated for purge, missing files and health checks.
- [x] **No self-check command.** (p3) [feature] A `backdrop doctor` could report missing tools, X11 availability, config errors,
      a stale `state.json`, and library rows whose files are missing (the daemon only drops those from playlists).
      Done in 2.32.0: `backdrop doctor` (`src/commands/DoctorCommand.js`), read-only, `--json`, `--visualizer`; also a daemon
      behind the CLI's version and processes a crash left (`findOrphans`). On this machine it found the daemon a
      version behind after a bump.
- [x] **Config is validated lazily.** (p3) [refactor] Values are checked where they are used (`trash_days` at purge, `output.*` at startup), so a typo like
      `image_duration: 5m` only fails inside mpv. Validate the whole config in `ConfigManager.normalize()` with messages naming the key, and test each section.
      Done in 2.30.0: `src/config/schema.js` checks every key outside the visualizer section when the config loads and
      fails with every problem listed (tolerant for `backdrop doctor`); durations take 90/90s/5m/1h. The checks that
      were spread over Playlist, notify, purge, workspace and MenuCommand call it. A bad visualizer section stays a
      warning, as the daemon already ran without it.
- [x] **Unknown config keys are ignored silently.** (p2) [bug] A `visualization:` section (meant as `visualizer:`) was
      accepted without a word on 2026-10-30, so the visualizer stayed off with nothing in the log or `status`. The
      visualizer section rejects unknown keys since 2.24.0/2.25.0; top-level sections and the other sections still do
      not. Warn on unknown keys in `ConfigManager.loadConfig()`, naming the closest known key (as `closestQueries` does
      for queries), from the CLI and in the daemon log. Part of the lazy-validation item above.
      Done in 2.26.0: `unknownKeys()` checks the file against the defaults (visualizer excepted); warnings on stderr,
      in `status` and `status --json`, the daemon log, and a notification for each one a save adds.
- [x] **axios has known vulnerabilities.** (p1) [chore] `npm audit` (2026-10-30) reports high-severity advisories for
      axios 1.0.0-1.19.0 (DoS, SSRF through NO_PROXY, prototype pollution) and, through it, critical `form-data`
      4.0.0-4.0.5 and moderate `follow-redirects` <=1.15.11; the Pexels adapter uses it for every API call and download.
      1.21.0 is in range (`npm update axios`), then run the source tests and one live `search-images`.
      A recheck on 2026-10-31 found 15 advisories in all: runtime `yaml` 2.8.0 (deep nesting stack overflow, 2.9.1
      fixes it) and `tmp` through `inquirer` 8.2.6 (8.2.7 fixes it) are also in range; dev-only `serialize-javascript`
      needs mocha 12 (see the dependencies item). The `package.json` floors (`axios ^1.6.2`, `yaml ^2.3.4`) still
      admit vulnerable versions; raise them with the fix.
      Fixed in 2.25.1: `npm audit fix` and raised floors; only the mocha chain (dev) remains. A live `search-images`
      ran clean on axios 1.21.0.
- [x] **An empty config section crashes every command.** (p2) [bug] A section with all its keys commented out,
      e.g. `library:` alone, parses as null; `deepMerge` replaces the defaults with it and `normalize()` fails on
      `config.library.import_dirs` ("Failed to load config: Cannot read properties of null"), so even `stats` exits.
      Treat a null section as empty in `deepMerge`/`loadConfig` and test each section; part of the lazy-validation item.
      Fixed in 2.26.2: a null over a mapping default keeps its defaults, over a list default is an empty list.
- [x] **Subprocess and mpv tests fail under heavy load.** (p3) [test] `test/display/mpv.integration.test.js` failed once
      during a full `npm test` on 2026-10-30 and passed three runs alone. Its fixed waits likely race a busy machine;
      replace them with polling on mpv properties. On 2026-10-31, at a load average of 17, `test/commands/cli.test.js`
      ("runs offline commands ...") hit its 15 s timeout twice: each `node src/index.js` took about 1.8 s instead of
      0.3 s, and the test runs many. Give subprocess-heavy tests a timeout scaled to the number of runs, or run the
      commands in one process where they need no isolation.
      Done in 2.33.0: the mpv test already polled (no fixed waits were left); `waitFor` now allows 15 s (the
      video-duration check 10 s) under a 30 s suite timeout. `cli.test.js` starts each test at 5 s and every `run()`
      adds 5 s to it (Mocha reads the timeout when a synchronous test ends, so the budget scales with the runs).
- [x] **inquirer is six majors behind.** (p3) [chore] Left from the dependency upgrade (2026-10-31: `npm outdated` shows
      only inquirer 8.2.7 vs 14, and fs-extra and winston minor releases in range). Originally: commander 11 (15 current),
      inquirer 8 (14, ESM-only with a new prompt API, used by the interactive lists), mocha 10 (12), chai 4 (6, ESM-only),
      sinon 17 (22). None is urgent; upgrade commander and the test stack together in one change, inquirer separately
      since its API changed.
      2.26.1 moved commander to 15 and the test stack to mocha 12, chai 6 and sinon 22 with no test changes; left:
      inquirer 14 (`ListCommand`, `SearchCommand`), and mocha 12's own moderate `minimatch` advisory (upstream).
      inquirer 14 is ESM-only with a new prompt API (`@inquirer/prompts`); both commands take `prompt` as an injected
      option, so the change is contained there.
      Done in 2.33.0: `inquirer` replaced by `@inquirer/prompts` 8 (what inquirer 14 wraps); `src/utils/prompts.js`
      `ask()` turns Ctrl-C (`ExitPromptError`) into null, which `list --interactive` treats as Exit and `search-*`
      as a quiet stop. The commands take `select` / `input` instead of `prompt`.
- [x] **Daemon.js has grown to about 1040 lines.** (p2) [refactor] It holds playback supervision, hotplug, health checks,
      CPU sampling, imports, purge, control requests, durations, the config watcher and live settings (2.31.0), the
      wallpaper sampling for visualizer colors (2.27.0), crash cleanup and the visualizer glue; it grew by about 180
      lines on 2026-10-31 alone. Move the control-request handling and durations (`applyControl`, `applyDurations`,
      `setWallpaper`), the config watcher and live settings (`watchConfig`, `applyConfigChange`, `applySettings`,
      `LIVE_SETTINGS`) and the color sampling (`colorsFor`, `sampleScreen`) into their own modules with the daemon passed
      in, as `VisualizerManager` already is, so each can be tested without starting a daemon. Raised to p2: every
      new daemon feature lands here.
      Done in 2.32.3: `src/display/daemon/` holds `ControlRequests`, `ConfigChanges` (with `LIVE_SETTINGS`),
      `WallpaperColors` and `Health`, each given the daemon; its state stays on the daemon and its methods forward, so no
      test changed. `Daemon.js` is about 790 lines. The move dropped the `modeOfKind` import in `Health.js` (a decoder
      test caught it); checked live after.
- [x] **No CI.** (p3) [chore] Nothing runs `npm test` on push. Add a GitHub Actions workflow on Node 22.13 and current Node, installing mpv and ffmpeg so the
      integration tests run instead of being skipped. Since 2.27.1 and 2.29.1 the rofi and stacking tests also need Xvfb,
      rofi, xdotool, ImageMagick and xwinwrap (not packaged on Ubuntu; build it in the workflow or keep that test local).
      `.github/workflows/test.yml` is written, keeping the stacking test local; its first run (2.50.2) found the sqlite warning on Node 22.13 and a timing failure in an Importer test, and 2.50.3's branch run passed on both Node versions.
- [x] **ConfigManager.save() would wipe the config's comments.** (p3) [refactor] `save()` writes `YAML.stringify(userConfig)`,
      dropping every comment and the user's layout (the commented reference in a hand-kept config). Nothing calls it today
      (`setInFile` / `spliceYaml`, 2.28.0, is the safe path). Remove it, or make it write through `spliceYaml` per changed
      key, before something starts using it.
      Done in 2.33.0: removed with its two tests; `setInFile` is the only writer of an existing config.
- [x] **Tests could act on the running daemon.** (p1) [test] `makeConfig()` left `paths.runtime` at the real
      `$XDG_RUNTIME_DIR/backdrop`, so tests read the live `state.json` (the mpv integration test only passed through it)
      and could write beside it. Fixed: `makeConfig()` points it at a missing directory; tests that need state set their own.
- [x] **Tests default to the real data and cache paths.** (p2) [test] `makeConfig()` still leaves `paths.data`,
      `paths.thumbnails`, `paths.logfile` and the media folders at their XDG defaults; a test that forgets to override
      one writes into the user's library. Point every `paths.*` at a per-run temp directory in `makeConfig()`.
      Fixed in 2.26.3: `test/helpers/setup.js` points every XDG variable at one temp directory for the run and
      removes it afterwards; `test/helpers/isolation.test.js` checks every default path lands inside it.
- [x] **Stray pexels.log.** (p3) [chore] A 0-byte `pexels.log` from pexels-cli sits in the repo root (ignored by `*.log`). Deleted.
- [x] **A killed `visualizer check` leaves its visualizers running.** (p3) [bug] It starts them detached and stops them at the end, so killing it midway (a `timeout`, Ctrl-C) leaves GLava and
      sleeve in 1x1 windows, with their `bd-vcheck-*` directory. Happened on 2026-11-05 with 19 of them. Done: it stops them and removes the directory on SIGINT and SIGTERM. A SIGKILL or crash still leaves them.
- [x] **Ad-hoc mpv probes leave orphaned players.** (p3) [chore] Four headless `mpv --no-config --vo=null --idle=yes`
      processes (about 35 MB each) ran for 7+ hours, adopted by init, with sockets under `/run/user/1000/bdh.*` and a
      Claude scratchpad. They came from one-off `hook.mjs` probes in Claude session 7383774a (2026-11-03), which ran
      `D=$(mktemp -d .../bdh.XXXX); node hook.mjs $D ...; rm -rf $D`: that removed the socket directory but never stopped
      the mpv it had started. The daemon is not affected (it spawns players in their own process group and `killGroup`s
      them on stop). Fix: give probes and real-mpv tests a shared helper that starts mpv and kills it on exit
      (`trap 'kill $pid' EXIT` in shell, an `after()` / `process.on('exit')` kill in node). Clear the current ones with
      `pkill -f 'mpv --no-config --vo=null --idle=yes'`. Done: `startMpv` in `test/helpers/mpv.js`, the shell form in `AGENTS.md`, and the four running were ended on 2026-11-05.

### 2. Rename to backdrop (completed 2026-11-05)

- [x] **Rename project and repo to backdrop.** (p1) [chore] Package, bin, CLI name, README, CLAUDE.md and specs renamed; GitHub repo renamed to `njhoffman/backdrop` and origin updated.
      `SETUP_GUIDE.md` removed; the old spec is kept as `docs/specs/legacy-pexels-cli.md`. Breaking change, so this ships as 2.0.0.
- [x] **Move the local checkout.** (p2) [chore] Moved to `~/ghq/github.com/njhoffman/backdrop`; `~/git/backdrop` symlink replaces `~/git/pexels-cli`.
- [x] **Decouple config and paths from Pexels.** (p1) [refactor] Move `~/.config/pexels.yaml` to `~/.config/backdrop/config.yaml` and `~/.local/share/pexels`, `~/.cache/pexels` to `backdrop`.
      Put source credentials under a `sources:` map (`sources.pexels.api_key`, `sources.unsplash.access_key`), keep `PEXELS_API` as a fallback.
      Done: XDG paths (`paths` not written to the file), `sources`/`library`/`display`/`screensaver` sections; see `docs/specs/config.md`.
- [x] **Source-neutral database schema.** (p1) [refactor] `media`, `ratings`, `searches`, `search_results`, `sequences` on built-in `node:sqlite`; see `docs/specs/database.md`.
      No data migration: backdrop starts with an empty database (decided 2026-10-21).
- [x] **Port old commands onto the new layer.** (p1) [refactor] Search/Download, List, Stats and Rating use the new schema
      and are registered alongside Import and Display. HookCommand is removed; `go-next` uses mpv IPC.
      Lists default to text with optional interactive rating/M3U export; stats work offline. See `docs/specs/sources.md`.
- [x] **Trash purge.** (p2) [feature] `backdrop purge [--dry-run]` and the daemon (at start and every 24h) delete trash files older than `library.trash_days` (0 disables).
      Rows and ratings stay with a null path so searches do not resurrect the item; only files inside `trash/` are touched.
- [x] **Unknown commands exit 0 silently.** (p3) [bug] Fixed once display commands were registered. With no subcommands registered, `backdrop bogus` prints nothing and exits 0.
      Commander rejects unknown subcommands once any are registered; add a test for this when the first command is ported.

### 6. Resolution-aware quality filter (completed 2026-11-05)

- [x] **Never upscale.** (p1) [feature] Search/download and playback filter against configured xrandr monitors;
      `--resolution WIDTHxHEIGHT` supports headless source commands. `display.allow_upscale` is the explicit override.
- [x] **Pick the best download variant.** (p2) [perf] Download the smallest variant by pixel area that meets all target
      monitor dimensions and the library minimum.
- [x] **Store measured dimensions.** (p2) [feature] Download/import probe real dimensions, kind and duration with ffprobe;
      a later source search preserves measurements for files already downloaded.

- [x] **Upgrade downloads for larger monitors.** (p3) [feature] Downloads are sized for the largest monitor at download time and never refetched, so a later, larger monitor skips them.
      Add e.g. `backdrop download --upgrade`: for kept remote items below the current target, pick a larger stored variant, replace the file atomically and keep ratings, speed and history. Local imports cannot be upgraded.
      Done: `download --upgrade` sets the old file aside until the database commits, and refreshes playlists afterwards.
