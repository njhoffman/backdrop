# Web interface

Status: **agreed design** (2026-11-07); steps 1 to 4 of "Order of work" are built (2.53.2, 2.54.0, 2.55.0, 2.56.0). D1 A, a `backdrop web` process; D2 A, `node:http`; D3 A,
vanilla JS with no build; D4, server-sent events; D5 A, a token with Host and Origin checks; D6, services first;
and the first version's scope under "Decisions on scope". The roadmap items are in `TODO.md`, "10. Web interface".

A local HTML interface for what the CLI and the rofi menu do now: what each monitor plays, the library, the
visualizer's presets and the config. It is a second front end on the same parts the CLI uses, not a second way of
controlling the daemon: everything it changes goes through `DisplayControl`, control requests, the database and
`ConfigManager.setInFile`, so the CLI, the menu and the page always agree.

## Goals

- Do from a browser what `next`/`prev`/`mode`, `keep`/`skip`/`undo`, `speed`/`dim`/`bounce`, the durations,
  `start`/`stop --wallpaper` and `visualizer` do, for any monitor, without the pointer deciding which one.
- Browse the library with thumbnails and the list commands' filters, rate and adjust items that are not playing,
  and queue one to play next.
- Edit visualizer looks live and save them as presets, with room for the settings the rofi menu has none for.
- Edit the config with the same checks as the CLI, applied by the daemon's config watch.
- Show what `status`, `stats` and `doctor` print.

## Not goals

- Reaching it from another machine. It listens on loopback only; remote use is an SSH tunnel's job.
- Several users, accounts or roles.
- Searching and downloading from Pexels (`search`, `download`). They can come later; the first version works on
  the library as it is.
- Replacing the rofi menu, which stays the quick way from a key binding.

## Architecture

### D1. Which process serves it

**Decided: A.**

| Option | For | Against |
|---|---|---|
| **A. `backdrop web`, a process of its own** (recommended) | Same position as the CLI: reads `state.json`, connects to the mpv sockets, writes control requests. A crash or a bug in it cannot take the wallpaper down. Runs only when wanted. | A second long-lived process with its own database handle (fine: WAL and `busy_timeout = 5000` are already set for the CLI running beside the daemon). |
| B. Inside the daemon, behind `web.enabled` | One process; direct access to the daemon's state, no control requests needed. | Ties the HTTP surface to the process that owns the wallpaper; a slow request handler blocks mpv events and health checks on the same event loop; every web change needs a daemon restart. |

With A, `backdrop web` runs while the daemon is stopped too: the library, presets and config pages work, and the
monitor controls show the daemon as stopped with a start button, as `status` does.

### D2. HTTP server

**Decided: A.**

| Option | For | Against |
|---|---|---|
| **A. `node:http` with a small router of its own** (recommended) | No dependency; the API is a few dozen routes; matches the project's habit of small injected parts. | Body parsing, routing and errors written by hand (about 150 lines). |
| B. fastify | Schema validation, good errors, plugins for static files and SSE. | A dependency tree for a localhost tool with one user. |
| C. express | Familiar. | Old patterns, middleware ordering surprises, slower than both. |

### D3. Front end

**Decided: A.**

| Option | For | Against |
|---|---|---|
| **A. Plain HTML pages with vanilla JS modules, no build step** (recommended) | The project has no bundler; files are served as they are; nothing to install for the UI. Native `<dialog>`, `fetch`, `EventSource` and CSS grid cover what the pages need. | More code per interaction than a framework; components by convention. |
| B. Server-rendered HTML plus htmx (vendored, one file) | Less JS; the server sends HTML fragments. | Two kinds of response per route (HTML and JSON for `--json` parity); live updates still need some JS. |
| C. A small SPA (Preact or Svelte) with a build | Components, state management. | A build step and its toolchain in a repo that has none; `npm link` users would need built assets. |

Either way the page reads the JSON formats in `docs/specs/json.md` (`mediaJson`, `playingJson`), so the API and
`--json` stay one format.

### D4. Live updates

**Decided: server-sent events.**

The page shows what plays and changes when anything else changes it (a timer advance, `backdrop next`, the menu).

- **Server-sent events** (recommended): `GET /api/events` keeps one stream per page. The web process watches
  `state.json` (`fs.watch` on the runtime dir, as the daemon watches the config) and observes `path`, `speed` and
  `contrast` on each monitor's mpv socket, sending `{ type: 'playing', monitor, item }` and `{ type: 'state', ... }`.
  The browser reconnects by itself.
- Polling every few seconds: simplest, but it lags and keeps the mpv sockets busy.
- WebSockets: two-way, which nothing here needs; the page's changes go through ordinary requests.

### D5. Who may use it

**Decided: A.**

Any local program and any web page in the browser can reach a localhost port, so loopback alone is not enough: a
site could post to `http://127.0.0.1:<port>/api/...` from the browser (CSRF), or reach it through DNS rebinding.

| Option | For | Against |
|---|---|---|
| **A. A random token per run, plus Host and Origin checks** (recommended) | `backdrop web` prints `http://127.0.0.1:<port>/?token=...`; the page swaps it for an `HttpOnly`, `SameSite=Strict` cookie and drops it from the URL. Every request needs the cookie, and changing requests also need an `X-Backdrop-Token` header (CSRF). Requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>`, or whose `Origin` is another site, are refused (rebinding). | The URL has to be opened from the terminal (or `backdrop web --open`); a token that leaks gives full control until the process stops. |
| B. A Unix socket only, with a small proxy | File permissions decide access. | Browsers cannot open a Unix socket; needs a proxy, which brings back the same question. |
| C. No authentication | Nothing to do. | Any web page you visit could skip, rate or delete your media. |

The token is kept in `$XDG_RUNTIME_DIR/backdrop/web.json` (mode 0600) with the port, so `backdrop web --open` and
`backdrop status` can find a running server.

### D6. Moving command logic into services

**Decided: services first, as a change of its own.** Done in 2.53.2: `src/services/RatingService.js` and
`DisplayService.js`, with the menu on them.

The commands print as they work: `RatingCommand.keep` rates, moves the file, syncs the playlists and prints the
item. The web server needs the same steps returning data. Before any route is written, the logic moves into
`src/services/` (rating: rate, skip, undo, advance; display: the playing item, mode, durations, parts on and off),
and the commands become thin layers that call a service and print its result. The menu calls the services too, so
it no longer prints to a stdout nobody reads.

- Recommended: do it as the first change, on its own, with the existing tests unchanged, so the refactor is checked
  before anything new depends on it.
- Alternative: have the server call the commands with output captured (`setJsonOutput`). Quicker, but the web
  server would parse its own JSON output, and errors would arrive as printed text.

## API

JSON in and out; errors are `{ error }` with a 4xx or 5xx status (a service's error is a 400 with its message).
`:monitor` is an output name such as `DP-3`. Routes marked *built* exist (`src/web/server.js`); the rest are still a
sketch for the later steps. Every built changing route sends a snapshot to the pages afterwards.

| Route | Does |
|---|---|
| `GET /api/state` *built* | `{ status, durations, settings, version }`: `status --json` (`DisplayService.status`), the durations in force (`{ image, video }`, each `{ seconds, set }`, set when next or the menu gave it), `settings.video_loop` for items that follow it |
| `GET /api/events` *built* | Server-sent events (D4): an `event: state` with the same snapshot on connect and on each change |
| `POST /api/monitors/:monitor/next` `prev` *built* | `playingJson` of what the monitor plays now; next takes `{ query, tag, keywords }` (lists of strings) and `random`, kept for later nexts as `next --tag` keeps them |
| `POST /api/monitors/:monitor/keep` *built* | `{ rating: 1-3, next? }` on the playing item: `{ item, warnings, playing? }` |
| `POST /api/monitors/:monitor/skip` *built* | Skips the playing item: `{ item, warnings, playing }` |
| `POST /api/monitors/:monitor/speed` `dim` `bounce` *built* | `{ value }` as the commands take it (`0.8`, `+10`, `on`, `reset`) |
| `POST /api/undo` *built* | Undoes the last rating: `{ action: none \| undone, item, warnings }` |
| `POST /api/mode` *built* | `{ mode: video \| image \| toggle, monitor? }`: `{ mode, held }` |
| `POST /api/daemon` *built* | `{ running: true \| false }`: starts or stops the daemon |
| `POST /api/parts` *built* | `{ wallpaper?, visualizer? }`, each true or false, as `start`/`stop --wallpaper`/`--visualizer`; a part turned on starts a stopped daemon |
| `POST /api/durations` *built* | `{ image?, video? }` as times (`90`, `5m`), or `{ clear: true }`, which also drops next's filters (as `next --clear`) |
| `GET /api/media` *built* | A page of downloaded items (`LibraryService.list`): `kind` (all, video, image), `status` (shown: new and kept, new, kept, skipped, all), `min_rating`, `query` and `tag` (each repeated), `keywords` (space-separated), `sort` (newest, oldest, largest), `page`, `per_page` (48, at most 100); answers `{ total, page, pages, per_page, items }` with `mediaJson` items |
| `GET /api/media/facets` *built* | The 60 most common tags with their counts and the saved searches' queries, for the filters |
| `GET /api/media/:id` *built* | `mediaJson`; 404 for an unknown id |
| `POST /api/media/:id/rating` *built* | `{ rating: 0-3 }` (0 skips) on any item, playing or not: `{ item, warnings }` |
| `PATCH /api/media/:id` *built* | `{ speed?, dim?, bounce? }` as the commands take them; applied at once on a monitor playing the item, stored either way: `{ item }` |
| `POST /api/media/:id/play` *built* | `{ monitor }`: plays the item there now when that monitor's playlist has it (its mode and size decide), as `next` with it as the only match |
| `GET /thumbs/:id.jpg` *built* | The cached thumbnail, made on demand (`thumbnailFor`, one at a time, at the lowest priority) |
| `GET /api/visualizer` *built* | `VisualizerService.describe`: `{ running, enabled, error, wallpaper, preset, presets: [{ name, source }], changed, instances: [{ name, look, changed, sent }], choices }`, the config's preset while the daemon is stopped |
| `POST /api/visualizer/enabled` *built* | `{ on }`: turns the visualizer on or off |
| `POST /api/visualizer/live` *built* | `{ instance, changes }`: one instance's change as visualizer settings (`{ opacity: 0.6 }`, `{ placement: { anchor: 'top' } }`), checked against the section, kept until the daemon restarts (a `visualizer_set` control request); `DELETE` drops every change |
| `POST /api/visualizer/preset` *built* | `{ name }`, null for none |
| `POST /api/visualizer/presets/:name` *built* | Saves the look with its changes as `visualizer.presets.<name>` (`setInFile`, which keeps comments) and switches to it; an existing name is a 409 unless `{ replace: true }` |
| `GET /api/config` / `PATCH /api/config` | The config with each key's default and whether a change applies live (`LIVE_SETTINGS`); a patch is checked with `validateConfig` before `setInFile` writes it |
| `GET /api/stats`, `GET /api/doctor` | What `stats` prints (it has no `--json` yet; the service from D6 gives it one) and `doctor --json` |

## Pages

1. **Now playing**: a card per monitor with the thumbnail, title, rating, speed, dim and bounce, and next, prev,
   keep 1-3, skip and undo; above them the mode, the durations and the wallpaper and visualizer switches.
2. **Library**: a thumbnail grid with filters, paged (thumbnails of items never played are made as they scroll
   into view); a drawer with the item's details, rating, adjustments and "play next on ...".
3. **Visualizer**: per instance, the look's settings as form controls applied live; presets to load, save and
   delete.
4. **Config**: a form per section, each field with its default and a "needs a restart" mark.
5. **Status**: load level, screensaver, playback cost by kind and decoder, the bounce cache, and `doctor`'s
   checks.

## Testing

- Services: the existing command tests keep passing through the refactor (D6), plus service tests that check the
  returned data.
- Routes: request handlers driven over a real `http.Server` on port 0 with the fakes in `test/helpers/fakes.js`
  (`FakeMpvClient`, `makeConfig`), offline like the rest of the suite. The token, Host and Origin checks get their
  own tests.
- Front end: one optional browser test (Playwright or Chromium headless) that loads Now playing against a fake
  backend, skipped when no browser is installed, like the rofi and Xvfb integration tests.

## Order of work

1. Services (D6), with no behavior change.
2. `backdrop web`: the server, D5's checks, `/api/state`, `/api/events` and the Now playing page.
3. Library page and the media routes, with thumbnails on demand.
4. Visualizer page.
5. Config page.
6. Status page, `backdrop web --open`, and a systemd user unit (`SystemdCommand`).

## Decisions on scope

- **Port:** `web.port`, 7737 by default, so a bookmark keeps working; when it is taken, `backdrop web` takes a free
  port and says so (the token changes every run anyway). `web.json` records the port in use.
- **Autostart:** not in the first version. `backdrop web` is started by hand or by its own systemd user unit; a
  `web.autostart` for `backdrop start` can follow once both have run side by side for a while.
- **Video previews:** thumbnails only in the first version. Serving the files with HTTP range requests is a later
  step for the library drawer.
- **Deleting items:** `remove` stays out of the first version. Skipping (rating 0) is there, and undo reverses it;
  a permanent delete waits for a confirmation flow of its own.
- **New config keys:** a `web` section with `port`, given defaults in `getUserDefaults()` like every key.
