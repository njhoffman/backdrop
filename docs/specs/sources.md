# Media sources

`src/sources/Source.js` defines the source contract; `SourceRegistry` resolves adapters by name.
Commands use this contract and the common `media` schema. Adding an adapter requires implementing the
methods below and registering an instance in `SourceRegistry`. Only public APIs qualify.

- `name`: stable source name, used by `--source` and the database.
- `search({kind, query, page, perPage, orientation, minSize, color})`: returns
  `{items, nextPage, rateLimit}`. `items` contains normalized media; `nextPage` is a larger integer or
  `null`. API-specific pagination stays in the adapter.
- `metadata(kind, sourceId)`: returns one normalized media object.
- `downloadVariants(media)`: returns downloadable variants, refreshing metadata when necessary.
- `rateLimit`: last observed `{limit, remaining, reset}`; unknown header values are `null`. `reset` is a
  UNIX timestamp in seconds. `SourceError` carries an HTTP `status` and optional `retryAfter`.

Normalized media has `kind`, `source`, `source_id`, `width`, `height`, `duration`, `author`, `page_url`,
`tags`, and `variants`. Each variant has `{url, width, height, mime}`. Credentials are validated only
when an adapter makes an authenticated request; offline commands and downloads using recorded public
URLs do not require a source key.

## Pexels

The first adapter uses the [official Pexels API](https://www.pexels.com/api/documentation/):
`/v1/search`, `/v1/photos/:id`, `/v1/videos/search` and `/v1/videos/videos/:id`.
Credentials come from `sources.pexels.api_key` (with the existing `PEXELS_API` fallback).
Photo and video identities are stored as `image:<id>` and `video:<id>` because their ID namespaces can
overlap. Source metadata is refreshed without changing a local file path, status or playback speed.

Video variants use the dimensions of each `video_files` entry. Image variants use `src.original`
and the dimensions encoded in each resized URL, including `dpr` and cropping. Search output links to
Pexels, and list/download output includes the photographer or videographer and the item's page URL.
API access remains subject to Pexels' guidelines.

The adapter records `X-Ratelimit-Limit`, `X-Ratelimit-Remaining` and `X-Ratelimit-Reset` from successful
responses. An exhausted observed quota prevents further requests until reset. HTTP 429 stops a search,
keeping completed pages. Other failures produce a nonzero exit status. `stats` reports the last saved
quota from a search, without spending another API request.

## Search and download

`search-images` and `search-videos` paginate until exhausted or rate limited, saving results and their
original ranks in `search_results`. `--per-page` accepts 1-80; `--portrait` also checks dimensions locally.
Only results with a variant meeting the library minimum and target dimensions are saved.

Both search and download detect configured active monitors with xrandr, using the maximum width and
height so one variant can fit all selected outputs. `--resolution WIDTHxHEIGHT` overrides detection for
headless use. Without known dimensions, commands fail with a useful message unless upscaling is enabled.
`display.allow_upscale` relaxes monitor requirements while preserving the library's minimum quality.

`download --total N --type images|videos|both [--source NAME]` selects pending `new` items and chooses the
smallest variant by pixel area that meets these requirements. Downloads stream into unique temporary
files, are probed by ffprobe and hashed, and enter the inbox only after validation. Actual dimensions,
kind, duration and SHA-256 are stored. Failed transfers, undersized files, duplicates and database-write
failures do not mark the media downloaded or leave partial files. The command continues after individual
failures and exits nonzero if any item failed. Successful items are appended to running playlists.

Search and download are separate commands; scripts run without confirmation prompts. Searches without a
query prompt only on a terminal. Lists are plain text by default, with `--interactive` for browsing and
rating and `--playlist <file>` for an M3U export.
