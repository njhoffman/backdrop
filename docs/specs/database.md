# Database

SQLite via the built-in `node:sqlite` module (synchronous). The schema version is stored in
`PRAGMA user_version` (currently 1); opening a database with a newer version fails rather than guessing.
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
| `sha256` | content hash, unique; prevents duplicate imports |
| `status` | `new`, `kept` or `skipped`; follows the latest rating |
| `status_changed_at` | drives trash expiry |
| `speed` | mpv playback speed (0.01-100), one per item, default 1.0 |
| `tags`, `variants` | JSON arrays; `variants` holds download options `{url, width, height, ...}` |
| `author`, `page_url` | attribution |
| `added_at`, `updated_at` | timestamps (UTC) |

## ratings

Full history; the current rating is the row with the highest `id` for the item.

| Column | Notes |
| --- | --- |
| `media_id` | cascades on media delete |
| `rating` | 0 = skip, 1-3 = keep |
| `orientation` | `landscape` or `portrait`, from the monitor resolution (portrait when height > width) |
| `resolution` | monitor resolution at rating time, e.g. `1920x1080` |

Adding a rating sets the item's status in the same transaction. Undo deletes the most recent rating
across all items and restores the status from the previous rating, or `new` if none is left.

## searches, search_results

`searches` records each query with its source and parameters as JSON. `search_results` links a search to
the media it returned with its rank; recording the same pair again updates the rank.

## sequences

Named counters (`nextSequence(name)`) that only count up. Local imports use the `local` sequence so
`local-<n>` names are never reused after deletion.
