# Database

SQLite via the built-in `node:sqlite` module (synchronous). The schema version is stored in
`PRAGMA user_version` (currently 7); opening a database with a newer version fails rather than guessing.
Foreign keys are enforced, and file databases use WAL so the daemon and CLI can share them.

## media

One row per item, from any source.

| Column | Notes |
| --- | --- |
| `id` | integer primary key, never reused |
| `kind` | `image`, `video` or `gif` |
| `source`, `source_id` | e.g. `pexels` / `12345`, `local` / `7`; unique together |
| `path` | library file; `NULL` until downloaded; unique |
| `original_name` | filename before import or download |
| `width`, `height`, `duration` | probed dimensions; used for the never-upscale filter |
| `fps` | average frame rate from ffprobe, or from mpv the first time an older item plays; `NULL` for images and until known. Added in v7 |
| `sha256` | content hash, unique; prevents duplicate imports |
| `status` | `new`, `kept` or `skipped`; follows the latest rating |
| `status_changed_at` | drives trash expiry |
| `speed` | mpv playback speed (0.01-100), one per item, default 1.0 |
| `dim` | 0 (none) to 100 (black), applied as mpv `brightness` = -dim; added in v5, default 0 |
| `duplicate_of` | set when a download's content matched this media id; the item is never downloaded again. Added in v6; no foreign key, so it stays hidden if the original is removed |
| `tags`, `variants` | JSON arrays; `tags` holds the source's own descriptions (e.g. Pexels alt text), `variants` download options `{url, width, height, ...}` |
| `author`, `page_url` | attribution |
| `added_at`, `updated_at` | timestamps (UTC) |

## media_tags

Words derived from each item, rebuilt whenever its `source`, `original_name`, `page_url` or `tags` change
(`src/library/tags.js`). Added in v7; the migration backfills every existing item.

| Column | Notes |
| --- | --- |
| `media_id`, `tag` | primary key; cascades on media delete |
| `origin` | `filename` (local imports), `page` (source page URL slug) or `description` (the `tags` column) |

Words are lowercased and split on punctuation and camelCase; words shorter than three letters, words with
digits (ids, resolutions, codecs) and stop words such as `pexels`, `uhd`, `video` or `the` are dropped.

## ratings

Full history; the current rating is the row with the highest `id` for the item.

| Column | Notes |
| --- | --- |
| `media_id` | cascades on media delete |
| `rating` | 0 = skip, 1-3 = keep |
| `orientation` | `landscape` or `portrait`, from the monitor resolution (portrait when height > width) |
| `resolution` | monitor resolution at rating time, e.g. `1920x1080` |
| `previous_path`, `rated_path` | file location before and after the rating; nullable for imports and pre-v4 history |

Adding a rating sets the item's status in the same transaction. Undo deletes the most recent rating
across all items and restores the status from the previous rating, or `new` if none is left.
The command restores `previous_path`; history without recorded paths uses the directory for the previous
status (inbox, media or trash). File moves are reversed if the database transaction fails. Re-rating an
import changes its effective latest rating while retaining history for undo.

## searches, search_results

`searches` records each query with its source and parameters as JSON. `search_results` links a search to
the media it returned with its rank; recording the same pair again updates the rank. When an item turns out
to duplicate another, its results move to the original (keeping the better rank), and later searches that
return it credit the original, so the original lists every query that found either copy.

## imported_files

One row per source file the importer has looked at: `source_path` (primary key), `size`, `mtime_ms`,
`sha256`, `media_id` (set null if the media is deleted), `status` (`imported`, `duplicate`, `too_small`,
`unsupported`, `failed`), `detail`, `checked_at`. A file is re-examined only when its size or mtime changes.

## settings

JSON values by key: `mode` (`video` or `image`) and `last_media:<mode>:<monitor>` (media id).

## Transactions

`transaction(fn)` nests: inner calls use savepoints, so a caught inner failure rolls back only its own work.

## sequences

Named counters (`nextSequence(name)`) that only count up. Local imports use the `local` sequence so
`local-<n>` names are never reused after deletion.
